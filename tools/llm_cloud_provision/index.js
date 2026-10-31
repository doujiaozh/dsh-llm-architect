#!/usr/bin/env node
'use strict';
// tools/llm_cloud_provision/index.js — 云端算力调度与训练下发（DSH 工具入口）
// 本地控制面：生成部署/训练脚本，通过 ssh/scp 把任务推送到远程 GPU 集群。
// 绝不在本地安装 CUDA/PyTorch；所有计算在远端执行。

const cli = require('../../lib/cli.js');
const fs = require('fs');
const path = require('path');
const render = require('./lib/render.js');

const HELP = `llm_cloud_provision · 云端算力调度与训练下发

用法:
  node tools/llm_cloud_provision/index.js <subcommand> [flags]
  node tools/llm_cloud_provision/index.js --json '{"subcommand":"push","args":{...}}'

子命令:
  autodel        生成 AutoDL 环境初始化包（含 OpenAPI 管理脚本）
  sagemaker      生成 AWS SageMaker 提交脚本
  k8s            生成 K8s Job / MPIJob 清单
  train-script   生成 DeepSpeed / Megatron 训练启动脚本（含 train.py、hostfile、ds_config）
  push           一键把训练任务推送到远程 GPU 节点（scp/rsync + 远程启动）
  status         查看远程节点状态（nvidia-smi / 磁盘 / checkpoint）
  cluster-setup  生成多机集群一次性环境准备脚本

示例:
  node tools/llm_cloud_provision/index.js train-script --framework deepspeed --gpus 8 --zero 3
  node tools/llm_cloud_provision/index.js push --local out/cloud/train --remote /root/llm-training/train --start "bash train_deepspeed.sh"
  node tools/llm_cloud_provision/index.js status
`;

const PUSH_HELP = `push · 把训练任务推送到远程 GPU 节点

flags:
  --local PATH        本地目录（或 tar 包）[默认 out/cloud/train]
  --remote PATH       远端目标路径 [默认取 .env REMOTE_WORKDIR 或 /root/llm-training]
  --start CMD         推送后在远端执行的命令（如 "bash train_deepspeed.sh"）
  --no-exec           只传文件不启动
  --tar               打包后流式传输（大量小文件时推荐）
  --remote-host/-H    覆盖 .env 的 REMOTE_HOST
  --remote-user/-U    [默认 root]
  --remote-port/-P    [默认 22]
  --ssh-key-path/-K   [默认 .env SSH_KEY_PATH]
  --dry-run           只打印命令不执行
`;

const TRAIN_HELP = `train-script · 生成训练启动脚本

flags:
  --framework deepspeed|megatron   [默认 deepspeed]
  --gpus N            每节点 GPU 数 [默认 8]
  --nodes N           节点数 [默认 1]
  --zero 1|2|3        DeepSpeed ZeRO stage（用内置 configs/ds_config_zeroN.json）[默认 2]
  --tp N --pp N       Megatron 张量/流水并行度
  --hosts A,B         多机节点 IP 列表（生成 hostfile）
  --data-dir PATH     [默认 /root/llm-training/data]
  --tokenizer-dir PATH [默认 /root/llm-training/tokenizer_output]
  --output-dir PATH   [默认 /root/llm-training/ckpt]
  --model-config PATH [默认 configs/model_config_llama_1.3b.json]
  --ds-config PATH    自定义 DeepSpeed 配置（默认按 --zero 选内置）
  --out DIR           [默认 out/cloud/train]
`;

const HELP_MAP = { push: PUSH_HELP, 'train-script': TRAIN_HELP };

async function dispatch(sub, args) {
  switch (sub) {
    case 'autodel': {
      const r = await render.renderAutoDel(args);
      cli.log(`AutoDL 部署包已生成 → ${r.out_dir}/`);
      for (const f of r.files) cli.log(`  - ${f}`);
      cli.log('  下一步: scp 到实例后执行 provision_autodel.sh');
      return r;
    }
    case 'sagemaker': {
      const r = await render.renderSageMaker(args);
      cli.log(`SageMaker 提交脚本已生成 → ${r.out_dir}/`);
      for (const f of r.files) cli.log(`  - ${f}`);
      cli.log('  下一步: 配好 AWS 环境变量后 bash submit.sh');
      return r;
    }
    case 'k8s': {
      const r = await render.renderK8s(args);
      cli.log(`K8s 清单已生成 → ${r.out_dir}/`);
      for (const f of r.files) cli.log(`  - ${f}`);
      cli.log(`  启动: kubectl apply -f ${path.basename(r.files[0])}`);
      return r;
    }
    case 'train-script': {
      const r = await render.renderTrainScript(args);
      cli.log(`训练脚本已生成 → ${r.out_dir}/`);
      for (const f of r.files) cli.log(`  - ${f}`);
      cli.log(`  启动: ${r.manifest.launch}`);
      return r;
    }
    case 'push': {
      const ro = render.remoteOpts(args);
      if (!ro.host) cli.die('缺少远程主机：设置 .env 的 REMOTE_HOST 或传 --remote-host');
      const local = path.resolve(cli.pick(args.local, path.join('out', 'cloud', 'train')));
      if (!fs.existsSync(local)) cli.die(`本地路径不存在: ${local}`);
      const remote = cli.pick(args.remote, path.posix.join(ro.workdir, path.basename(local)));
      const useTar = cli.bool(args.tar === undefined ? false : args.tar);
      const noExec = cli.bool(args.noExec === undefined ? false : args.noExec);
      const startCmd = cli.pick(args.start, '');
      const dryRun = cli.bool(args.dryRun === undefined ? false : args.dryRun);

      // ssh 基础参数（对象形式）：['ssh','-o',...,'-p',port,'user@host']
      const sshFull = cli.sshArgs({ host: ro.host, user: ro.user, port: ro.port, key: ro.key });
      const sshRun = sshFull.slice(0, -1); // 去掉末尾的 user@host，后面拼远程命令
      const target = sshFull[sshFull.length - 1];
      const results = {};

      if (useTar && process.platform !== 'win32') {
        // tar 流式：本地打包 → ssh 远端解包，避免大量小文件多次握手
        const tarCmd = `tar -C "${path.dirname(local)}" -czf - "${path.basename(local)}"`;
        const remoteCmd = `mkdir -p "${path.posix.dirname(remote)}" && tar -xzf - -C "${path.posix.dirname(remote)}"`;
        const full = `${tarCmd} | ssh ${sshRun.slice(1).map(cli.shQuote).join(' ')} ${cli.shQuote(remoteCmd)}`;
        if (dryRun) { cli.log(`[dry-run] ${full}`); }
        else {
          const r = await cli.run(['bash', '-c', full], { capture: true });
          results['tar 流式推送'] = r.code === 0 ? 'ok' : 'fail';
          if (r.code !== 0) { cli.warn('tar 推送失败，回退 scp'); }
          else { cli.log('tar 流式推送完成'); }
        }
      }

      if (!results['tar 流式推送']) {
        const steps = [
          { desc: '远端建目录', argv: [...sshRun, target, `mkdir -p '${remote}'`] },
          { desc: 'scp 传送', argv: cli.scpArgs({ src: [local], dst: `${ro.user}@${ro.host}:${remote}`, port: ro.port, key: ro.key }) },
        ];
        if (!noExec && startCmd) {
          steps.push({ desc: `远端启动: ${startCmd}`, argv: [...sshRun, target, `cd '${remote}' && nohup ${startCmd} > run.log 2>&1 &`] });
        }
        for (const st of steps) {
          if (dryRun) { cli.log(`[dry-run] ${st.argv.join(' ')}`); continue; }
          const r = await cli.run(st.argv, { capture: true });
          results[st.desc] = r.code === 0 ? 'ok' : 'fail';
          if (r.code !== 0) { cli.warn(`步骤失败: ${st.desc}（退出码 ${r.code}）${r.stderr ? ' ' + r.stderr.trim() : ''}`); break; }
        }
      }

      const ok = dryRun || Object.values(results).every((v) => v === 'ok');
      await cli.writeJson(path.join(path.dirname(local), 'push_report.json'),
        { ok, host: ro.host, remote, start: startCmd, results, created_at: cli.isoNow() });
      cli.log(`推送: ${local} → ${ro.user}@${ro.host}:${remote}`);
      cli.log(ok ? '推送完成。' : '推送遇到问题，见上方告警。');
      cli.log(`  日志: ssh 到远端后 tail -f ${remote}/run.log，或用 llm_eval_monitor watch`);
      return { ok, host: ro.host, remote, results };
    }
    case 'status': {
      const ro = render.remoteOpts(args);
      if (!ro.host) cli.die('缺少远程主机：设置 .env 的 REMOTE_HOST 或传 --remote-host');
      const dryRun = cli.bool(args.dryRun === undefined ? false : args.dryRun);
      const cmd = [
        'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total --format=csv',
        'df -h ' + ro.workdir,
        `ls -la ${ro.workdir}/ckpt 2>/dev/null || echo "no ckpt dir"`,
        `tail -n 5 ${ro.workdir}/train/run.log 2>/dev/null || echo "no run.log yet"`,
      ].join(' ; ');
      const sshFull = cli.sshArgs({ host: ro.host, user: ro.user, port: ro.port, key: ro.key });
      const argv = [...sshFull.slice(0, -1), sshFull[sshFull.length - 1], cmd];
      if (dryRun) { cli.log(`[dry-run] ${argv.join(' ')}`); return { planned: true, cmd: argv.join(' ') }; }
      const r = await cli.run(argv, { capture: true });
      if (r.stdout) console.log(r.stdout);
      if (r.stderr) console.error(r.stderr);
      return { code: r.code };
    }
    case 'cluster-setup': {
      const outDir = path.resolve(cli.pick(args.out, path.join('out', 'cloud', 'cluster')));
      await cli.ensureDir(outDir);
      const gpus = String(cli.num(args.gpus, 8));
      const hosts = (cli.pick(args.hosts, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (!hosts.length) cli.die('cluster-setup 需要 --hosts（逗号分隔的节点 IP 列表）');
      const tpl = render.readTemplate('cluster_setup.sh');
      const script = cli.template(tpl, { NODE_LIST: hosts.map((h) => `"${h}"`).join(' '), GPU_HINT: gpus });
      await render.writeScript(outDir, 'cluster_setup.sh', script, true);
      // 附带各模板依赖
      await cli.copyFile(path.join(__dirname, 'scripts', 'provision_autodel.sh'), path.join(outDir, 'provision_autodel.sh'));
      await cli.copyFile(path.join(__dirname, 'scripts', 'cloud_requirements.txt'), path.join(outDir, 'cloud_requirements.txt'));
      cli.log(`集群准备脚本已生成 → ${outDir}/`);
      cli.log('  执行: bash cluster_setup.sh（需对全部节点 ssh 免密）');
      return { out_dir: outDir, hosts, files: ['cluster_setup.sh', 'provision_autodel.sh', 'cloud_requirements.txt'] };
    }
    default:
      cli.die(`未知子命令: ${sub}（--help 查看用法）`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--json') {
    let req;
    try { req = JSON.parse(argv[1] || '{}'); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: `--json 参数解析失败: ${e.message}` })); process.exit(1); }
    if (!req.subcommand) { console.log(JSON.stringify({ ok: false, error: '缺少 subcommand' })); process.exit(1); }
    try {
      const data = await dispatch(req.subcommand, req.args || {});
      console.log(JSON.stringify({ ok: true, data }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      process.exit(1);
    }
    return;
  }
  const parsed = cli.parseArgs(argv);
  const sub = parsed._[0];
  const flags = parsed.flags;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { console.log(HELP); return; }
  if (sub === 'version' || sub === '-v') { console.log('llm_cloud_provision v0.1.0'); return; }
  if (flags.help === true) { console.log(HELP_MAP[sub] || HELP); return; }
  try { await dispatch(sub, flags); }
  catch (e) { cli.die(String(e && e.message || e)); }
}

main();
