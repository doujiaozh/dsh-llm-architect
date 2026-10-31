'use strict';
// tools/llm_cloud_provision/lib/render.js — 云端部署/训练脚本渲染器

const fs = require('fs');
const path = require('path');
const cli = require('../../../lib/cli.js');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function readTemplate(name) {
  const p = path.join(SCRIPTS_DIR, name);
  if (!fs.existsSync(p)) cli.die(`模板缺失: ${p}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

async function writeScript(outDir, name, content, executable) {
  const p = path.join(outDir, name);
  await cli.writeText(p, content);
  if (executable) { try { fs.chmodSync(p, 0o755); } catch { /* Windows 无影响 */ } }
  return p;
}

/** 远程连接参数：读 .env 与 CLI flags */
function remoteOpts(args) {
  const host = cli.pick(args.remoteHost, cli.envValue('REMOTE_HOST', ''));
  const user = cli.pick(args.remoteUser, cli.envValue('REMOTE_USER', 'root'));
  const port = cli.pick(args.remotePort, cli.envValue('REMOTE_PORT', '22'));
  const key = cli.pick(args.sshKeyPath, cli.envValue('SSH_KEY_PATH', ''));
  const workdir = cli.pick(args.remoteWorkdir, cli.envValue('REMOTE_WORKDIR', '/root/llm-training'));
  return { host, user, port, key, workdir };
}

/** AutoDL 部署包 */
async function renderAutoDel(args) {
  const outDir = path.resolve(cli.pick(args.out, path.join('out', 'cloud', 'autodel')));
  await cli.ensureDir(outDir);
  const workdir = cli.pick(args.remoteWorkdir, '/root/llm-training');

  const files = [];
  files.push(await writeScript(outDir, 'provision_autodel.sh', readTemplate('provision_autodel.sh'), true));
  await cli.copyFile(path.join(SCRIPTS_DIR, 'provision_autodel.py'), path.join(outDir, 'provision_autodel.py'));
  files.push(path.join(outDir, 'provision_autodel.py'));
  await cli.copyFile(path.join(SCRIPTS_DIR, 'cloud_requirements.txt'), path.join(outDir, 'cloud_requirements.txt'));
  files.push(path.join(outDir, 'cloud_requirements.txt'));

  const manifest = {
    platform: 'autodel', created_at: cli.isoNow(),
    steps: [
      `1) ssh <实例IP> 'bash /root/llm-training/provision_autodel.sh ${workdir}'`,
      `2) 或用 API: AUTODL_TOKEN=xxx python3 provision_autodel.py list|create|status`,
    ],
    files: files.map((f) => path.relative(process.cwd(), f)),
  };
  await cli.writeJson(path.join(outDir, 'deploy_manifest.json'), manifest);
  return { out_dir: outDir, files: manifest.files, manifest };
}

/** SageMaker 部署包 */
async function renderSageMaker(args) {
  const outDir = path.resolve(cli.pick(args.out, path.join('out', 'cloud', 'sagemaker')));
  await cli.ensureDir(outDir);
  const instanceType = cli.pick(args.instanceType, 'ml.g5.48xlarge');
  const instanceCount = String(cli.num(args.instanceCount, 1));

  const script = cli.template(readTemplate('sagemaker_train.py'), {});
  await writeScript(outDir, 'sagemaker_train.py', script);
  const runner = [
    '#!/bin/bash',
    '# SageMaker 提交脚本（本地控制面执行，需 awscli/boto3 与环境变量鉴权）',
    `INSTANCE_TYPE=${instanceType}`,
    `INSTANCE_COUNT=${instanceCount}`,
    `JOB_NAME=${cli.pick(args.jobName, 'dsh-llm-train')}`,
    'HPS=\'{"model_config":"configs/model_config.json","data_dir":"/opt/ml/input/data/train","output_dir":"/opt/ml/model"}\'',
    'python3 sagemaker_train.py \\',
    '  --instance-type "$INSTANCE_TYPE" --instance-count "$INSTANCE_COUNT" \\',
    '  --job-name "$JOB_NAME" --hyperparameters "$HPS" "$@"',
  ].join('\n');
  await writeScript(outDir, 'submit.sh', runner, true);

  const manifest = {
    platform: 'sagemaker', instance_type: instanceType, instance_count: instanceCount,
    created_at: cli.isoNow(),
    requires: ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'SAGEMAKER_ROLE_ARN', 'SAGEMAKER_ECR_IMAGE'],
    steps: ['1) aws ecr / 镜像准备', '2) bash submit.sh', '3) aws sagemaker describe-training-job 轮询'],
  };
  await cli.writeJson(path.join(outDir, 'deploy_manifest.json'), manifest);
  return { out_dir: outDir, files: ['sagemaker_train.py', 'submit.sh'], manifest };
}

/** K8s Job / MPIJob 清单 */
async function renderK8s(args) {
  const outDir = path.resolve(cli.pick(args.out, path.join('out', 'cloud', 'k8s')));
  await cli.ensureDir(outDir);
  const gpus = String(cli.num(args.gpus, 8));
  const nodes = String(cli.num(args.nodes, 1));
  const jobName = cli.pick(args.jobName, 'dsh-llm-train');
  const image = cli.pick(args.image, 'your-registry/dsh-llm-trainer:latest');
  const pvc = cli.pick(args.pvc, 'llm-data-pvc');

  const job = cli.template(readTemplate('k8s_job.yaml'), {
    JOB_NAME: jobName, IMAGE: image, NUM_GPUS: gpus, PVC_NAME: pvc,
  });
  await writeScript(outDir, 'job.yaml', job);

  const replicas = String(Math.max(1, nodes));
  const mpi = cli.template(readTemplate('k8s_mpijob.yaml'), {
    JOB_NAME: jobName, IMAGE: image, SLOTS_PER_WORKER: gpus,
    NP: String(Number(gpus) * Number(replicas)),
    WORKER_REPLICAS: replicas, PVC_NAME: pvc,
  });
  await writeScript(outDir, 'mpijob.yaml', mpi);

  const apply = [
    '#!/bin/bash',
    '# K8s 部署脚本（本地控制面执行，需 kubectl 与 kubeconfig）',
    `GPU_PER_NODE=${gpus}`,
    `NODES=${replicas}`,
    'if [ "$NODES" -gt 1 ]; then MANIFEST=mpijob.yaml; else MANIFEST=job.yaml; fi',
    'echo "[apply] $MANIFEST"',
    `kubectl apply -f "$MANIFEST" "$@"`,
    `echo "[watch] kubectl get pods -l app=dsh-llm-training -w`,
  ].join('\n');
  await writeScript(outDir, 'apply.sh', apply, true);

  const manifest = {
    platform: 'k8s', job_name: jobName, gpus_per_node: gpus, nodes: replicas, image, pvc,
    created_at: cli.isoNow(),
    steps: [
      `1) kubectl apply -f job.yaml（单机 ${gpus} 卡）`,
      `2) 多机改用 mpijob.yaml（${replicas} 节点）`,
      '3) kubectl logs -f job/dsh-llm-train',
    ],
  };
  await cli.writeJson(path.join(outDir, 'deploy_manifest.json'), manifest);
  return { out_dir: outDir, files: ['job.yaml', 'mpijob.yaml', 'apply.sh'], manifest };
}

/** 训练启动脚本（deepspeed / megatron） */
async function renderTrainScript(args) {
  const outDir = path.resolve(cli.pick(args.out, path.join('out', 'cloud', 'train')));
  await cli.ensureDir(outDir);
  const framework = cli.pick(args.framework, 'deepspeed');
  const gpus = String(cli.num(args.gpus, 8));
  const nodes = String(cli.num(args.nodes, 1));
  const zero = String(cli.pick(args.zero, '2'));
  const dataDir = cli.pick(args.dataDir, '/root/llm-training/data');
  const tokenizerDir = cli.pick(args.tokenizerDir, '/root/llm-training/tokenizer_output');
  const outputDir = cli.pick(args.outputDir, '/root/llm-training/ckpt');
  const modelConfig = cli.pick(args.modelConfig, 'configs/model_config_llama_1.3b.json');
  const extra = cli.pick(args.extra, '');

  // hostfile
  const hostList = (cli.pick(args.hosts, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const hostfileLines = hostList.length
    ? hostList.map((h) => `${h} slots=${gpus}`).join('\n')
    : `# 单机模式无需 hostfile；多机示例：\n# 10.0.0.1 slots=${gpus}\n# 10.0.0.2 slots=${gpus}`;
  const hostfile = cli.template(readTemplate('hostfile'), { HOSTFILE_LINES: hostfileLines });
  await writeScript(outDir, 'hostfile', hostfile);

  // DeepSpeed 配置：优先用项目内置，否则内建最小配置
  const dsPath = path.resolve(cli.pick(args.dsConfig, path.join('configs', `ds_config_zero${zero}.json`)));
  let dsConfigName;
  if (fs.existsSync(dsPath)) {
    dsConfigName = path.basename(dsPath);
    await cli.copyFile(dsPath, path.join(outDir, dsConfigName));
  } else {
    dsConfigName = `ds_config_zero${zero}.json`;
    await cli.writeJson(path.join(outDir, dsConfigName), {
      train_batch_size: 'auto', train_micro_batch_size_per_gpu: 'auto',
      gradient_accumulation_steps: 'auto', bf16: { enabled: 'auto' },
      zero_optimization: { stage: Number(zero) },
    });
  }

  if (framework === 'megatron') {
    const tp = String(cli.num(args.tp, gpus));
    const pp = String(cli.num(args.pp, 1));
    const script = cli.template(readTemplate('train_megatron.sh'), {
      NUM_GPUS: gpus, NNODES: nodes, HOSTFILE: './hostfile',
      TP: tp, PP: pp, DATA_DIR: dataDir, TOKENIZER_DIR: tokenizerDir,
      OUTPUT_DIR: outputDir, EXTRA_ARGS: extra || '',
    });
    await writeScript(outDir, 'train_megatron.sh', script, true);
    await cli.copyFile(path.join(SCRIPTS_DIR, 'cloud_requirements.txt'), path.join(outDir, 'cloud_requirements.txt'));
    const manifest = {
      framework: 'megatron', gpus, nodes, tp, pp, created_at: cli.isoNow(),
      launch: `bash train_megatron.sh  # ${nodes} 节点 × ${gpus} 卡, TP=${tp} PP=${pp}`,
    };
    await cli.writeJson(path.join(outDir, 'train_manifest.json'), manifest);
    return { out_dir: outDir, files: ['train_megatron.sh', 'hostfile', dsConfigName, 'cloud_requirements.txt'], manifest };
  }

  // deepspeed
  const script = cli.template(readTemplate('train_deepspeed.sh'), {
    NUM_GPUS: gpus, NNODES: nodes, HOSTFILE: './hostfile',
    TRAIN_PY: './train.py',
    DS_CONFIG: dsConfigName, OUTPUT_DIR: outputDir, DATA_DIR: dataDir,
    TOKENIZER_DIR: tokenizerDir, MODEL_CONFIG: modelConfig, EXTRA_ARGS: extra || '',
  });
  await writeScript(outDir, 'train_deepspeed.sh', script, true);
  await writeScript(outDir, 'train.py', readTemplate('train.py'));
  const modelConfigSrc = path.resolve(modelConfig);
  if (fs.existsSync(modelConfigSrc)) {
    await cli.ensureDir(path.join(outDir, 'configs'));
    await cli.copyFile(modelConfigSrc, path.join(outDir, 'configs', path.basename(modelConfigSrc)));
  }
  await cli.copyFile(path.join(SCRIPTS_DIR, 'cloud_requirements.txt'), path.join(outDir, 'cloud_requirements.txt'));

  const manifest = {
    framework: 'deepspeed', gpus, nodes, zero_stage: zero, created_at: cli.isoNow(),
    launch: `bash train_deepspeed.sh  # ${nodes} 节点 × ${gpus} 卡, ZeRO-${zero}`,
    files: ['train_deepspeed.sh', 'train.py', 'hostfile', dsConfigName, 'cloud_requirements.txt'],
  };
  await cli.writeJson(path.join(outDir, 'train_manifest.json'), manifest);
  return { out_dir: outDir, files: manifest.files, manifest };
}

module.exports = {
  remoteOpts, renderAutoDel, renderSageMaker, renderK8s, renderTrainScript, readTemplate, writeScript,
};
