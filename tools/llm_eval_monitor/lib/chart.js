'use strict';
// tools/llm_eval_monitor/lib/chart.js — 纯字符串 SVG 图表生成（零依赖）

const cli = require('../../../lib/cli.js');

/** 生成 loss / lr 双曲线 SVG */
function lossChart(points, opts) {
  opts = opts || {};
  const W = cli.num(opts.width, 960);
  const H = cli.num(opts.height, 480);
  const padL = 64, padR = 24, padT = 36, padB = 48;
  const iw = W - padL - padR, ih = H - padT - padB;

  const losses = points.map((p) => p.loss).filter((v) => v !== undefined && Number.isFinite(v));
  const lrs = points.map((p) => p.lr).filter((v) => v !== undefined && Number.isFinite(v));
  if (!losses.length) return null;

  const n = points.length;
  const minX = 0, maxX = Math.max(1, n - 1);
  let minY = Math.min(...losses), maxY = Math.max(...losses);
  if (minY === maxY) { minY -= 0.1; maxY += 0.1; }
  minY = Math.max(0, minY - (maxY - minY) * 0.08);
  maxY += (maxY - Math.min(...losses) + 1e-9) * 0.08;

  const X = (i) => padL + (i - minX) / (maxX - minX) * iw;
  const Y = (v) => padT + (1 - (v - minY) / (maxY - minY)) * ih;

  // loss 折线（路径采样，避免 path 字符串过长）
  const step = Math.max(1, Math.ceil(n / 600));
  let d = '';
  let started = false;
  for (let i = 0; i < n; i += step) {
    const v = points[i].loss;
    if (v === undefined || !Number.isFinite(v)) continue;
    d += (started ? ' L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
    started = true;
  }

  // Y 轴刻度（5 条网格线）
  const grid = [];
  for (let g = 0; g <= 4; g++) {
    const v = minY + (maxY - minY) * g / 4;
    const y = Y(v);
    grid.push(`<line x1="${padL}" y1="${y.toFixed(1)}" x2="${padL + iw}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`
      + `<text x="${padL - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#6b7280">${v.toFixed(3)}</text>`);
  }

  // X 轴刻度
  const xTicks = [];
  for (let g = 0; g <= 4; g++) {
    const i = Math.round(maxX * g / 4);
    xTicks.push(`<text x="${X(i).toFixed(1)}" y="${H - padB + 18}" font-size="11" text-anchor="middle" fill="#6b7280">${i}</text>`);
  }

  // lr 曲线（右侧轴，可选）
  let lrPath = '', lrLabels = '';
  if (lrs.length > 1) {
    const lrMin = Math.min(...lrs), lrMax = Math.max(...lrs);
    const ry = (v) => padT + (1 - (v - lrMin) / (lrMax - lrMin || 1e-12)) * ih;
    let ld = '', s2 = false;
    for (let i = 0; i < n; i += step) {
      const v = points[i].lr;
      if (v === undefined || !Number.isFinite(v)) continue;
      ld += (s2 ? ' L' : 'M') + X(i).toFixed(1) + ' ' + ry(v).toFixed(1);
      s2 = true;
    }
    lrPath = `<path d="${ld}" fill="none" stroke="#f59e0b" stroke-width="1.6" opacity="0.85"/>`;
    lrLabels = `<text x="${padL + iw}" y="${padT - 10}" font-size="11" text-anchor="end" fill="#f59e0b">lr(max=${fmtSci(lrMax)})</text>`;
  }

  const first = losses[0], last = losses[losses.length - 1];
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<rect width="${W}" height="${H}" fill="#ffffff"/>`,
    `<text x="${padL}" y="${padT - 12}" font-size="14" font-weight="bold" fill="#111827">${escHtml(opts.title || 'Training Loss')}</text>`,
    grid.join(''), xTicks.join(''),
    `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + ih}" stroke="#9ca3af"/>`,
    `<line x1="${padL}" y1="${padT + ih}" x2="${padL + iw}" y2="${padT + ih}" stroke="#9ca3af"/>`,
    `<path d="${d}" fill="none" stroke="#2563eb" stroke-width="2"/>`,
    lrPath, lrLabels,
    `<text x="${padL}" y="${H - 8}" font-size="11" fill="#6b7280">step/iteration  ·  loss ${first !== undefined ? first.toFixed(3) : '?'} → ${last !== undefined ? last.toFixed(3) : '?'}  ·  ${n} points  ·  dsh-llm-architect</text>`,
    `</svg>`,
  ].join('\n');
  return { svg, meta: { n, min_loss: Math.min(...losses), first_loss: first, last_loss: last } };
}

/** 吞吐量柱状图 */
function throughputChart(points, opts) {
  opts = opts || {};
  const W = cli.num(opts.width, 960), H = cli.num(opts.height, 360);
  const padL = 64, padR = 24, padT = 36, padB = 48;
  const iw = W - padL - padR, ih = H - padT - padB;
  const tps = points.map((p) => p.tokens_per_sec).filter((v) => v !== undefined && Number.isFinite(v));
  if (!tps.length) return null;
  // 分桶：20 个桶取均值
  const B = Math.min(20, tps.length);
  const bucket = [];
  const per = Math.ceil(tps.length / B);
  for (let i = 0; i < tps.length; i += per) {
    const seg = tps.slice(i, i + per);
    bucket.push(seg.reduce((a, b) => a + b, 0) / seg.length);
  }
  const maxV = Math.max(...bucket) * 1.1;
  const bw = iw / bucket.length;
  const bars = bucket.map((v, i) => {
    const h = (v / maxV) * ih;
    const x = padL + i * bw;
    return `<rect x="${(x + 2).toFixed(1)}" y="${(padT + ih - h).toFixed(1)}" width="${(bw - 4).toFixed(1)}" height="${h.toFixed(1)}" fill="#10b981" rx="2"/>`
      + `<text x="${(x + bw / 2).toFixed(1)}" y="${padT + ih + 16}" font-size="10" text-anchor="middle" fill="#6b7280">${i * per}</text>`;
  });
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Helvetica, Arial, sans-serif">`,
    `<text x="${padL}" y="${padT - 12}" font-size="14" font-weight="bold" fill="#111827">${escHtml(opts.title || 'Throughput (tokens/s)')}</text>`,
    `<line x1="${padL}" y1="${padT + ih}" x2="${padL + iw}" y2="${padT + ih}" stroke="#9ca3af"/>`,
    bars.join(''),
    `<text x="${padL}" y="${H - 8}" font-size="11" fill="#6b7280">avg ${ (tps.reduce((a,b)=>a+b,0)/tps.length).toFixed(0)} tokens/s · max ${Math.max(...tps).toFixed(0)} · dsh-llm-architect</text>`,
    `</svg>`,
  ].join('\n');
  return { svg, meta: { avg: tps.reduce((a, b) => a + b, 0) / tps.length, max: Math.max(...tps) } };
}

function fmtSci(v) {
  if (v === undefined) return '?';
  if (v === 0) return '0';
  const e = Math.floor(Math.log10(Math.abs(v)));
  return (v / Math.pow(10, e)).toFixed(1) + 'e' + e;
}

function escHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

module.exports = { lossChart, throughputChart };
