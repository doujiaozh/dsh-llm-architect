#!/usr/bin/env node
'use strict';
// bin/dsh-llm.js — dsh-llm-architect 总控入口
// 子命令: version | doctor | plan | list
// 零依赖，Win7/Node16+ 可直接运行。

const cli = require('../lib/cli.js');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const VERSION = '0.1.0';

const TOOLS = [
  ['llm_data_forge', '数据锻造：下载脚本 / 本地清洗去重 / Tokenizer 配置', 'tools/llm_data_forge/index.js'],
  ['llm_cloud_provision', '云算力调度：AutoDL/SageMaker/K8s + DeepSpeed/Megatron 下发', 'tools/llm_cloud_provision/index.js'],
  ['llm_eval_monitor', '训练监控与评测：日志解析 / Loss 曲线 / lm-eval-harness', 'tools/llm_eval_monitor/index.js'],
  ['llm_open_source', '开源发布：Safetensors 转换 / 模型卡 / HF Hub', 'tools/llm_open_source/index.js'],
];

function printVersion() {
  console.log(`dsh-llm-architect v${VERSION} (node ${process.version})`);
  console.log('控制面在本地 · 数据面在云端 · Win7 友好 · 零原生依赖');
}

function hasBin(name) {
  try { execSync(`${process.platform === 'win32' ? 'where' : 'command -v'} ${name}`, { stdio: 'ignore', windowsHide: true }); return true; }
  catch { return false; }
}

async function doctor() {
  cli.loadDotEnv(path.join(ROOT, '.env'));
  console.log('== dsh-llm-architect doctor ==\n');
  const totalMb = (require('os').totalmem() / 1024 / 1024) | 0;
  console.log(`[ok]   Node.js            ${process.version}  (需要 >=16)`);
  console.log(`[info] 平台               ${process.platform} / 内存 ${(totalMb / 1024).toFixed(1)}GB`);
  console.log(`[info] 控制面策略         本地禁止 CUDA/PyTorch，仅纯 Node.js 调度`);

  const python = hasBin('python') || hasBin('python3');
  console.log(`${python ? '[ok]   ' : '[warn] '}Python             ${python ? '已安装（可选：用于云端脚本的本地预览）' : '未安装（不影响主流程，云端脚本在 GPU 节点执行）'}`);

  const ssh = hasBin('ssh');
  console.log(`${ssh ? '[ok]   ' : '[warn] '}ssh                ${ssh ? '已安装（用于远程训练下发与日志拉取）' : '未安装（Win7 建议安装 Git for Windows 或 OpenSSH）'}`);

  const envKeys = ['HF_TOKEN', 'AUTODL_TOKEN', 'AWS_ACCESS_KEY_ID', 'REMOTE_HOST'];
  const setted = envKeys.filter(k => process.env[k]);
  console.log(`[info] .env 密钥         已配置 ${setted.length}/${envKeys.length} ${setted.length ? '(' + setted.join(', ') + ')' : ''}`);
  if (!setted.length) console.log('        提示: cp .env.example .env 并填入云平台密钥');

  const localCuda = (() => {
    try { return !!require.resolve('torch') || fs.existsSync('/usr/local/cuda'); } catch { return false; }
  })();
  console.log(`${localCuda ? '[WARN] ' : '[ok]   '}本地 PyTorch/CUDA    ${localCuda ? '检测到！本机应仅作控制面，请勿在本地训练' : '未安装（符合架构约束）'}`);

  console.log('\n工具清单:');
  for (const [name, desc, rel] of TOOLS) {
    const p = path.join(ROOT, rel);
    console.log(`  ${fs.existsSync(p) ? '[ok]  ' : '[miss]'} ${name.padEnd(22)} ${desc}`);
  }
  console.log('\n下一步: npm run plan  (查看从零到开源的完整蓝图)');
}

function plan() {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║   dsh-llm-architect · 从零训练并开源一个世界级 LLM 的完整蓝图     ║
╚══════════════════════════════════════════════════════════════════╝

阶段 0 · 环境体检
    node bin/dsh-llm.js doctor
    cp .env.example .env   # 填入 HF_TOKEN / AUTODL_TOKEN / SSH 密钥

阶段 1 · 数据锻造 (llm_data_forge)
    node tools/llm_data_forge/index.js download --source huggingface \\
        --dataset-id wikimedia/wikipedia --lang zh --out out/data
    node tools/llm_data_forge/index.js clean --input out/data/raw \\
        --out out/data/clean.jsonl --lang auto --dedupe minhash --redact-pii
    node tools/llm_data_forge/index.js tokenizer-config --vocab-size 32000 \\
        --lang zh,en --out out/tokenizer

阶段 2 · 云端算力与训练脚本 (llm_cloud_provision)
    node tools/llm_cloud_provision/index.js train-script --framework deepspeed \\
        --gpus 8 --model-config configs/model_config_llama_1.3b.json \\
        --data-path /root/llm-training/data/clean.jsonl --out out/train
    node tools/llm_cloud_provision/index.js autodel --gpu H800 \\
        --image pytorch2.3-cuda12.1 --out out/cloud

阶段 3 · 一键推送训练到远程 GPU 集群
    node tools/llm_cloud_provision/index.js push --local-dir out/train \\
        --remote-dir /root/llm-training --host $REMOTE_HOST --run run_train.sh
    # 等价的一条命令: 传送脚本 → 远程装依赖 → nohup 启动 → 回传首屏日志

阶段 4 · 训练监控与评测 (llm_eval_monitor)
    node tools/llm_eval_monitor/index.js watch --host $REMOTE_HOST \\
        --remote-log /root/llm-training/logs/train.log --local-dir logs/
    node tools/llm_eval_monitor/index.js chart --metrics logs/metrics.json \\
        --out logs/loss_curve.svg
    node tools/llm_eval_monitor/index.js eval --checkpoint /root/llm-training/ckpt/final \\
        --tasks mmlu,ceval,hellaswag --host $REMOTE_HOST --out out/eval

阶段 5 · 模型评测报告
    node tools/llm_eval_monitor/index.js report --metrics logs/metrics.json \\
        --eval out/eval/results.json --out logs/report.md

阶段 6 · 转换与开源发布 (llm_open_source)
    node tools/llm_open_source/index.js convert --checkpoint /root/llm-training/ckpt/final \\
        --dtype bf16 --out out/model --from hf
    node tools/llm_open_source/index.js readme --model-name MyLLM-1.3B \\
        --benchmarks out/eval/results.json --out out/model/README.md
    node tools/llm_open_source/index.js license --type apache-2.0 --out out/model/LICENSE
    node tools/llm_open_source/index.js publish --repo-id your-name/MyLLM-1.3B \\
        --local-dir out/model --execute

阶段 7 · GitHub 开源
    git add -A && git commit -m "feat: release MyLLM-1.3B"
    git tag v1.0 && git push origin main --tags

提示: 每个工具都支持 --help；Agent 可通过 --json 模式以 MCP 风格调用。
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] || 'help';
  if (cmd === 'version' || cmd === '-v' || cmd === '--version') return printVersion();
  if (cmd === 'doctor') return await doctor();
  if (cmd === 'plan') return plan();
  if (cmd === 'list' || cmd === 'help' || cmd === '--help') {
    printVersion();
    console.log('\n用法: node bin/dsh-llm.js <command>\n');
    console.log('Commands:');
    console.log('  doctor   环境体检：Node/Python/SSH/.env/工具完整性');
    console.log('  plan     打印从零到开源的 7 阶段蓝图与完整命令');
    console.log('  list     列出插件集内的四个工具');
    console.log('  version  打印版本号\n');
    for (const [name, desc] of TOOLS) console.log(`  ${name.padEnd(22)} ${desc}`);
    return;
  }
  cli.die(`未知子命令: ${cmd}（试试 --help）`);
}

main().catch(e => cli.die(String(e && e.message || e)));
