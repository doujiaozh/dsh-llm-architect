#!/usr/bin/env node
'use strict';
// llm_open_source —— 模型转换与开源发布（本地控制面调度，转换在云端执行）
const fs = require('fs');
const path = require('path');
const cli = require('../../lib/cli.js');
const card = require('./lib/card.js');

const SCRIPTS = path.join(__dirname, 'scripts');
const LICENSES = path.join(__dirname, 'licenses');
const REMOTE_CONVERT_SCRIPT = `
# 在 GPU 节点执行（本地 Win7 无需 torch）:
cd {{REMOTE_WORKDIR}}
{{CONVERT_CMD}}
{{VERIFY_CMD}}
{{PUBLISH_CMD}}
`;

function remoteSsh() {
  return {
    host: cli.envValue('REMOTE_HOST', ''),
    user: cli.envValue('REMOTE_USER', 'root'),
    port: cli.num(cli.envValue('REMOTE_PORT', '22'), 22),
    key: cli.envValue('SSH_KEY_PATH', '')
  };
}

function subConvert(a) {
  const from = String(cli.pick(a.flags['from']) || 'hf');
  const src = String(cli.pick(a.flags.src) || '');
  const dst = String(cli.pick(a.flags.dst) || 'out/model_release');
  const dtype = String(cli.pick(a.flags.dtype) || 'bfloat16');
  const workdir = String(cli.pick(a.flags['remote-workdir']) || cli.envValue('REMOTE_WORKDIR', '/root/llm-training'));
  const dry = cli.bool(a.flags['dry-run']);
  const ssh = remoteSsh();
  if (!src) cli.die('convert 需要 --src <远端 checkpoint 目录>');
  const script = from === 'zero3' ? 'convert_zero3_safetensors.py' : 'convert_safetensors.py';
  const cmds = [
    `python3 ${workdir}/dsh-llm-architect/tools/llm_open_source/scripts/${script} --src ${src} --dst ${workdir}/model_release --dtype ${dtype}`,
    `python3 ${workdir}/dsh-llm-architect/tools/llm_open_source/scripts/verify_model.py --dir ${workdir}/model_release`
  ];
  const scriptText = cli.template(REMOTE_CONVERT_SCRIPT, {
    REMOTE_WORKDIR: workdir,
    CONVERT_CMD: cmds[0],
    VERIFY_CMD: cmds[1],
    PUBLISH_CMD: dry ? '# (dry-run) 跳过发布' : ''
  });
  const outDir = path.resolve(dst);
  cli.ensureDir(outDir);
  const scriptPath = path.join(outDir, 'convert_remote.sh');
  cli.writeText(scriptPath, scriptText);
  const report = {
    mode: from,
    src,
    remote_release_dir: `${workdir}/model_release`,
    script: scriptPath,
    note: '在 GPU 节点 bash convert_remote.sh 完成转换+校验'
  };
  if (dry || !ssh.host) {
    cli.log(`转换脚本已生成 → ${scriptPath}`);
    cli.log(`远端执行: ssh ${ssh.user}@${ssh.host || '<REMOTE_HOST>'} 'bash ${workdir}/model_release/convert_remote.sh'`);
    return report;
  }
  // scp 上传脚本并远程执行
  const remotePath = `${workdir}/model_release/convert_remote.sh`;
  const scp = cli.scpArgs({ src: scriptPath, dst: `${ssh.user}@${ssh.host}:${remotePath}`, port: ssh.port, key: ssh.key });
  cli.log(`上传转换脚本 → ${ssh.host}:${remotePath}`);
  cli.run(scp, { dryRun: false });
  const sshFull = cli.sshArgs({ host: ssh.host, user: ssh.user, port: ssh.port, key: ssh.key });
  const argv = [...sshFull.slice(0, -1), sshFull[sshFull.length - 1], `mkdir -p ${workdir}/model_release && bash ${remotePath}`];
  cli.log('远程执行转换（可能耗时较长）…');
  const r = cli.run(argv, { dryRun: false });
  if (r.code !== 0) cli.die(`远端转换失败，exit=${r.code}`);
  report.done = true;
  return report;
}

function subReadme(a) {
  const flags = a.flags;
  const info = {
    name: String(cli.pick(flags.name) || 'dsh-llm-base'),
    org: String(cli.pick(flags.org) || cli.envValue('HF_USER', 'dsh-architect')),
    licenseSpdx: String(cli.pick(flags.license) || 'Apache-2.0'),
    framework: String(cli.pick(flags.framework) || 'DeepSpeed'),
    params: cli.num(flags.params, 0),
    dtype: String(cli.pick(flags.dtype) || 'bfloat16'),
    vocab: cli.num(flags.vocab, 32000),
    hidden: cli.num(flags.hidden, 2048),
    layers: cli.num(flags.layers, 24),
    heads: cli.num(flags.heads, 16),
    maxPos: cli.num(flags['max-pos'], 4096),
    dataset: String(cli.pick(flags.dataset) || ''),
    trainSteps: cli.num(flags['train-steps'], 0),
    lastLoss: flags['last-loss'] === undefined ? undefined : cli.num(flags['last-loss'], undefined),
    evalRows: []
  };
  const metricsPath = String(cli.pick(flags.metrics) || '');
  if (metricsPath && cli.exists(metricsPath)) {
    const mtx = cli.readJson(metricsPath);
    const sum = mtx.summary || {};
    if (info.trainSteps === 0 && sum.last_step) info.trainSteps = sum.last_step;
    if (info.lastLoss === undefined && sum.last_loss !== undefined) info.lastLoss = sum.last_loss;
  }
  const evalPath = String(cli.pick(flags.eval) || '');
  let evalRows = [];
  if (evalPath && cli.exists(evalPath)) {
    const ev = cli.readJson(evalPath);
    Object.entries(ev.results || {}).forEach(([task, scores]) => {
      const acc = scores['acc,none'];
      const accNorm = scores['acc_norm,none'];
      if (acc !== undefined) evalRows.push([task, 'acc', acc]);
      if (accNorm !== undefined) evalRows.push([task, 'acc_norm', accNorm]);
    });
  }
  info.evalRows = evalRows;
  const built = card.buildModelCard(info);
  const out = String(cli.pick(flags.out) || 'out/model_release/README.md');
  cli.ensureDir(path.dirname(path.resolve(out)));
  cli.writeText(out, built.text);
  return { readme: path.resolve(out), repoId: built.repoId };
}

function subLicense(a) {
  const kind = String(cli.pick(a.flags.kind) || 'apache-2.0');
  const year = new Date().getUTCFullYear();
  const holder = String(cli.pick(a.flags.holder) || cli.envValue('HF_USER', 'dsh-architect'));
  const outDir = String(cli.pick(a.flags.out) || 'out/model_release');
  const mapping = { 'apache-2.0': 'apache-2.0.txt', mit: 'mit.txt', llama3: 'llama3_notice.txt' };
  const file = mapping[kind];
  if (!file) cli.die(`不支持的许可证: ${kind}（可选 apache-2.0 | mit | llama3）`);
  const src = path.join(LICENSES, file);
  const dst = path.resolve(outDir, kind === 'llama3' ? 'LLAMA3_NOTICE' : kind.toUpperCase() === 'MIT' ? 'LICENSE' : 'LICENSE');
  cli.ensureDir(outDir);
  let text = cli.readText(src);
  if (kind === 'mit') text = text.replace(/\[year\]/g, String(year)).replace(/\[fullname\]/g, holder);
  if (kind === 'apache-2.0') text = text.replace('Copyright [yyyy] [name of copyright owner]', `Copyright ${year} ${holder}`);
  cli.writeText(dst, text);
  return { license: dst, kind, holder };
}

function subPublish(a) {
  const dry = cli.bool(a.flags['dry-run']);
  const dir = String(cli.pick(a.flags.dir) || 'out/model_release');
  const repo = String(cli.pick(a.flags.repo) || `${cli.envValue('HF_USER', 'dsh-architect')}/dsh-llm-base`);
  const token = cli.envValue('HF_TOKEN', '');
  const endpoint = cli.envValue('HF_ENDPOINT', 'https://huggingface.co');
  const workdir = cli.envValue('REMOTE_WORKDIR', '/root/llm-training');
  const ssh = remoteSsh();
  if (!token) cli.warn('未设置 HF_TOKEN（远端发布将失败）');
  const cmd = `HF_TOKEN=${token || '<HF_TOKEN>'} python3 ${workdir}/dsh-llm-architect/tools/llm_open_source/scripts/publish_hub.py --dir ${path.posix.join(workdir, 'model_release')} --repo ${repo} --endpoint ${endpoint}${dry ? ' --dry-run' : ''}`;
  const manifest = { repo, endpoint, local_dir: path.resolve(dir), remote_cmd: cmd, dry_run: dry };
  if (dry || !ssh.host) {
    cli.log(`发布命令${dry ? '（dry-run）' : '（未配置 REMOTE_HOST，请复制到 GPU 节点执行）'}:`);
    console.log('  ' + cmd);
    cli.writeJson(path.resolve(dir, 'publish_manifest.json'), manifest);
    return manifest;
  }
  const sshFull = cli.sshArgs({ host: ssh.host, user: ssh.user, port: ssh.port, key: ssh.key });
  const argv = [...sshFull.slice(0, -1), sshFull[sshFull.length - 1], cmd];
  cli.log(`推送到 ${repo} …`);
  const r = cli.run(argv, { dryRun: false });
  if (r.code !== 0) cli.die(`远端发布失败，exit=${r.code}`);
  manifest.done = true;
  cli.writeJson(path.resolve(dir, 'publish_manifest.json'), manifest);
  return manifest;
}

function subRelease(a) {
  // 一条龙：convert（生成脚本）→ readme → license → publish
  const dry = cli.bool(a.flags['dry-run']);
  const steps = [];
  steps.push(['convert', subConvert({ flags: { src: a.flags.src, dst: a.flags.dst, from: a.flags.from, dtype: a.flags.dtype, 'dry-run': dry, 'remote-workdir': a.flags['remote-workdir'] } })]);
  steps.push(['readme', subReadme({ flags: { ...a.flags, out: a.flags['readme-out'] || path.join(String(a.flags.dst || 'out/model_release'), 'README.md'), metrics: a.flags.metrics, eval: a.flags.eval } })]);
  steps.push(['license', subLicense({ flags: { kind: a.flags.license || 'apache-2.0', out: a.flags.dst || 'out/model_release', holder: a.flags.holder } })]);
  steps.push(['publish', subPublish({ flags: { repo: a.flags.repo, dir: a.flags.dst || 'out/model_release', 'dry-run': dry } })]);
  return { steps: steps.map(([k, v]) => ({ step: k, ...(v || {}) })) };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--json') {
    let payload = null;
    try { payload = JSON.parse(argv[1] || '{}'); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: `--json 参数解析失败: ${e.message}` })); process.exit(1); }
    const flags = Object.assign({}, payload.args || {});
    Object.keys(flags).forEach((k) => { if (flags[k] === null || flags[k] === undefined) delete flags[k]; });
    const fn = { convert: subConvert, readme: subReadme, license: subLicense, publish: subPublish, release: subRelease }[payload.subcommand];
    if (!fn) { console.log(JSON.stringify({ ok: false, error: `未知子命令: ${payload.subcommand}` })); process.exit(1); }
    try {
      const out = await fn({ flags });
      console.log(JSON.stringify({ ok: true, result: out }));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: e.message }));
      process.exit(1);
    }
    return;
  }
  const a = cli.parseArgs(argv);
  const sub = a._[0] || '';
  if (cli.bool(a.flags.help) || sub === '' || sub === 'help') {
    console.log(HELP);
    return;
  }
  const flags = a.flags;
  const fn = { convert: subConvert, readme: subReadme, license: subLicense, publish: subPublish, release: subRelease }[sub];
  if (!fn) { cli.die(`未知子命令: ${sub}（见 --help）`); }
  const out = await fn({ flags });
  if (out && typeof out === 'object') cli.writeJson(path.resolve(String(flags['report-out'] || '.dsh-release-report.json')), out);
}

const HELP = `llm_open_source —— 模型转换与开源发布（控制面本地 / 转换在云端 GPU 节点执行）

子命令:
  convert   生成 Safetensors 转换脚本并（可选）远程执行
            --src <远端ckpt> --dst <本地输出目录> --from hf|zero3 --dtype bf16|fp16|fp32 --dry-run
  readme    生成模型卡 README.md（含徽章/详情表/Benchmark/使用示例/BibTeX）
            --name --org --license --framework --params --metrics <metrics.json> --eval <eval_results.json> --out
  license   生成 LICENSE 文件（apache-2.0 | mit | llama3）
            --kind apache-2.0 --holder "你的名字" --out <目录>
  publish   推送到 HuggingFace Hub（远端执行 publish_hub.py）
            --repo <user/name> --dir <本地发布目录> --dry-run
  release   一条龙: convert → readme → license → publish

环境变量: HF_TOKEN, HF_USER, HF_ENDPOINT, REMOTE_HOST/USER/PORT/SSH_KEY_PATH/REMOTE_WORKDIR
MCP: --json '{"subcommand":"readme","args":{"name":"dsh-llm-1.3b",...}}'`;

main().catch((e) => { cli.warn(e && e.stack ? e.stack : String(e)); process.exit(1); });
