'use strict';
// tools/llm_eval_monitor/lib/parse.js — 训练日志解析器（纯字符串处理，零依赖）

const cli = require('../../../lib/cli.js');

const RE = {
  // HF Trainer: {'loss': 1.23, 'learning_rate': 3.45e-05, 'epoch': 0.5, 'grad_norm': 0.7, 'train_runtime': ...}
  hfTrainer: /\{\s*['"]loss['"]\s*:\s*([0-9.eE+-]+)/,
  hfLr: /['"]learning_rate['"]\s*:\s*([0-9.eE+-]+)/,
  hfSteps: /['"](?:step|global_step)['"]\s*:\s*(\d+)|\bstep\s*=?\s*(\d+)/,
  hfEpoch: /['"]epoch['"]\s*:\s*([0-9.eE+-]+)/,
  hfGradNorm: /['"]grad_norm['"]\s*:\s*([0-9.eE+-]+)/,
  // DeepSpeed: "step:10, loss:1.23, lr:3.45e-05, ...
  dsLoss: /\bloss[:=]\s*([0-9.eE+-]+)/i,
  dsLr: /\blr[:=]\s*([0-9.eE+-]+)/i,
  dsStep: /\bstep[:=]\s*(\d+)/i,
  // Megatron: iteration 10 / 100 | lm loss: 1.2345 | lr: 3.45E-05 | ...
  mgIter: /\biteration\s+(\d+)\s*(?:\/\s*(\d+))?/,
  mgLoss: /lm loss:\s*([0-9.eE+-]+)/i,
  mgLr: /\blr:\s*([0-9.eE+-]+)/i,
  // 吞吐量
  tps: /\b([\d.]+)\s*(?:tokens\/s|t\/s|tokens_per_second|TFLOP)/i,
  samples: /\b([\d.]+)\s*samples\/s/i,
  runtime: /\b(train_runtime|elapsed)[^0-9]*([\d.]+)/,
};

const STOP_PATTERNS = [
  { re: /CUDA out of memory/i, label: 'CUDA OOM（显存不足：降 batch / 升 ZeRO stage）' },
  { re: /RuntimeError|AssertionError|Traceback \(most recent call last\)/i, label: 'Python 运行时错误' },
  { re: /loss[:=]\s*(?:nan|inf)/i, label: 'loss 为 nan/inf（发散：降 lr / 检查数据）' },
  { re: /NaN loss|loss diverged/i, label: '训练发散' },
  { re: /Connection (reset|refused)|NCCL error|timeout/i, label: '通信/网络错误（NCCL）' },
  { re: /No space left on device/i, label: '磁盘满（清 ckpt 或换数据盘）' },
  { re: /Killed|OOM Killer/i, label: '被系统 OOM Killer 杀死（内存不足）' },
];

function toNum(s) {
  if (s === undefined || s === null) return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function first(re, line) {
  const m = re.exec(line);
  if (!m) return undefined;
  for (let i = 1; i < m.length; i++) if (m[i] !== undefined) return m[i];
  return undefined;
}

/**
 * 解析单行 → metrics 点（undefined 表示该行无指标）
 * 返回 {source, step, loss, lr, epoch, grad_norm, tokens_per_sec, samples_per_sec, iteration, max_iteration}
 */
function parseLine(line) {
  const out = {};
  // HF Trainer JSON 行
  if (RE.hfTrainer.test(line)) {
    out.source = 'hf_trainer';
    out.loss = toNum(first(RE.hfTrainer, line));
    out.lr = toNum(first(RE.hfLr, line));
    out.epoch = toNum(first(RE.hfEpoch, line));
    out.grad_norm = toNum(first(RE.hfGradNorm, line));
    out.step = toNum(first(RE.hfSteps, line));
    out.tokens_per_sec = toNum(first(RE.tps, line));
    return out;
  }
  // Megatron
  const mgStep = first(RE.mgIter, line);
  if (mgStep && RE.mgLoss.test(line)) {
    const mgm = RE.mgIter.exec(line);
    out.source = 'megatron';
    out.iteration = mgStep !== undefined ? Number(mgStep) : undefined;
    out.max_iteration = mgm && mgm[2] !== undefined ? Number(mgm[2]) : undefined;
    out.loss = toNum(first(RE.mgLoss, line));
    out.lr = toNum(first(RE.mgLr, line));
    out.tokens_per_sec = toNum(first(RE.tps, line));
    out.samples_per_sec = toNum(first(RE.samples, line));
    return out;
  }
  // DeepSpeed 通用 key=value
  if (RE.dsLoss.test(line)) {
    out.source = line.includes('deepspeed') ? 'deepspeed' : 'generic';
    out.loss = toNum(first(RE.dsLoss, line));
    out.lr = toNum(first(RE.dsLr, line));
    out.step = toNum(first(RE.dsStep, line));
    out.tokens_per_sec = toNum(first(RE.tps, line));
    out.samples_per_sec = toNum(first(RE.samples, line));
    return out;
  }
  // 只有吞吐量的行
  const tps = toNum(first(RE.tps, line));
  if (tps !== undefined) { out.source = 'generic'; out.tokens_per_sec = tps; return out; }
  return undefined;
}

/** 全量解析文本/文件 → {points, summary, alerts} */
async function parseLog(input, opts) {
  const points = [];
  const alerts = [];
  const lines = [];
  if (Buffer.isBuffer(input)) {
    input.toString('utf8').split(/\r?\n/).forEach((l) => lines.push(l));
  } else if (typeof input === 'string' && cli.exists(input)) {
    await cli.eachLine(input, (l) => lines.push(l));
  } else if (typeof input === 'string') {
    input.split(/\r?\n/).forEach((l) => lines.push(l));
  } else {
    await cli.eachLine(input, (l) => lines.push(l));
  }
  const maxPoints = cli.num(opts && opts.maxPoints, 5000);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const sp of STOP_PATTERNS) {
      if (sp.re.test(line)) alerts.push({ line: i + 1, label: sp.label, text: line.trim().slice(0, 200) });
    }
    const p = parseLine(line);
    if (p) { p.line_no = i + 1; points.push(p); }
    if (points.length > maxPoints * 4) { /* 只截断采样，不丢告警 */ }
  }
  // 均匀采样到 maxPoints 内
  let sampled = points;
  if (points.length > maxPoints) {
    sampled = [];
    const stride = points.length / maxPoints;
    for (let i = 0; i < maxPoints; i++) sampled.push(points[Math.floor(i * stride)]);
  }
  return { points: sampled, total_points: points.length, alerts, summary: summarize(sampled) };
}

function summarize(points) {
  const losses = points.map((p) => p.loss).filter((v) => v !== undefined && Number.isFinite(v));
  const lrs = points.map((p) => p.lr).filter((v) => v !== undefined && Number.isFinite(v));
  const tps = points.map((p) => p.tokens_per_sec).filter((v) => v !== undefined && Number.isFinite(v));
  const last = points[points.length - 1] || {};
  const quartile = (arr, q) => {
    if (!arr.length) return undefined;
    const a = [...arr].sort((x, y) => x - y);
    const p = (a.length - 1) * q;
    const b = Math.floor(p);
    return a[b] + (a[b + 1] !== undefined ? (a[b + 1] - a[b]) * (p - b) : 0);
  };
  return {
    n_points: points.length,
    first_loss: losses[0],
    last_loss: losses[losses.length - 1],
    min_loss: losses.length ? Math.min(...losses) : undefined,
    p25_loss: quartile(losses, 0.25),
    p50_loss: quartile(losses, 0.5),
    p75_loss: quartile(losses, 0.75),
    loss_drop_pct: (losses.length > 1 && losses[0]) ? +(((losses[0] - losses[losses.length - 1]) / losses[0]) * 100).toFixed(2) : undefined,
    last_lr: lrs[lrs.length - 1],
    max_lr: lrs.length ? Math.max(...lrs) : undefined,
    avg_tokens_per_sec: tps.length ? +(tps.reduce((a, b) => a + b, 0) / tps.length).toFixed(1) : undefined,
    last_step: last.step || last.iteration,
    last_epoch: last.epoch,
    last_source: last.source,
  };
}

/** 增量 watch 的状态文件 */
function statePath(stateDir) {
  return require('path').join(stateDir || '.dsh-eval', 'watch_state.json');
}

async function loadState(stateDir) {
  const p = statePath(stateDir);
  if (!cli.exists(p)) return { offset: 0, size: 0 };
  return await cli.readJson(p);
}

async function saveState(stateDir, st) {
  await cli.ensureDir(stateDir || '.dsh-eval');
  await cli.writeJson(statePath(stateDir), st);
}

module.exports = { RE, STOP_PATTERNS, parseLine, parseLog, summarize, loadState, saveState };
