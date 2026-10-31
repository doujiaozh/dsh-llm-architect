'use strict';
// clean_worker.js — forge 流水线的清洗 worker（拷贝到流水线目录后独立运行）
// 依赖同目录 ./lib/cli.js 与 ./lib/clean.js（由 forge 段一并拷贝）。

const path = require('path');
const cli = require('./lib/cli.js');
const cleanMod = require('./lib/clean.js');

async function main() {
  const parsed = cli.parseArgs(process.argv.slice(2));
  const f = parsed.flags;
  const input = cli.pick(f.input, '');
  const out = cli.pick(f.out, '');
  if (!input || !out) {
    console.error('用法: node clean_worker.js --input SHARD --out OUT.jsonl [--dedupe none|exact|minhash] [--redact-pii]');
    process.exit(1);
  }
  const opts = {
    minChars: cli.num(f['min-chars'], 1),
    maxChars: cli.num(f['max-chars'], Infinity),
    lang: cli.pick(f.lang, 'auto'),
    stripHtml: true, normalize: true, dropRepeatLines: true, qualityFilter: true,
    redactPii: cli.bool(f['redact-pii'] === undefined ? false : f['redact-pii']),
    dedupe: cli.pick(f.dedupe, 'none'),
    shingles: 5, bands: 16, rows: 8, format: 'jsonl',
  };
  const stats = await cleanMod.runClean(input, out, opts);
  await cli.writeJson(out + '.report.json', stats);
  console.log(`[worker] ${path.basename(input)}: ${stats.in_docs} → ${stats.out_docs} docs`);
}

main().catch((e) => { console.error('[worker] ERROR: ' + (e && e.message || e)); process.exit(1); });
