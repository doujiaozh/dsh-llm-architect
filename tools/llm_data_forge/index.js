#!/usr/bin/env node
'use strict';
// tools/llm_data_forge/index.js — 数据锻造与清洗（DSH 工具入口）
// 纯 Node.js 零依赖：下载脚本生成 / 本地清洗去重 / Tokenizer 训练配置 / 流水线编排。

const cli = require('../../lib/cli.js');
const cleanMod = require('./lib/clean.js');
const dedupeMod = require('./lib/dedupe.js');
const downloadMod = require('./lib/download.js');
const tokenizerMod = require('./lib/tokenizer.js');
const fs = require('fs');
const path = require('path');

const CMD = 'llm_data_forge';

const HELP = `llm_data_forge · 数据锻造与清洗

用法:
  node tools/llm_data_forge/index.js <subcommand> [flags]
  node tools/llm_data_forge/index.js <subcommand> --help
  node tools/llm_data_forge/index.js --json '{"subcommand":"clean","args":{...}}'

子命令:
  download          生成数据集下载脚本（huggingface / wikipedia / commoncrawl / custom）
  clean             本地流式清洗：去 HTML / 规范化 / 去重复行 / 质量过滤 / 语种过滤 / PII 脱敏 / 去重
  dedupe            独立去重（exact SHA-1 或 MinHash LSH）
  tokenizer-config  生成云端 Tokenizer 训练配置 + 脚本
  forge             按 json 配置编排完整云端数据流水线

示例:
  node tools/llm_data_forge/index.js clean --input examples/sample_corpus.jsonl \\
      --out out/data/clean.jsonl --dedupe minhash --redact-pii --stats out/data/report.json
  node tools/llm_data_forge/index.js download --source commoncrawl --out out/data
  node tools/llm_data_forge/index.js tokenizer-config --vocab-size 32000 --lang zh,en --out out/tok
`;

const CLEAN_HELP = `clean · 本地文本清洗

flags:
  --input PATH          输入文件或目录（.jsonl/.json/.txt/.md；目录递归；txt 按空行分段）
  --out PATH            输出 jsonl（每行 {"text","meta"}）
  --min-chars N         最小字符数 [默认 100]
  --max-chars N         最大字符数 [默认 100000]
  --lang auto|zh|en     语言过滤（auto=不过滤，仅标注）[默认 auto]
  --strip-html / --no-strip-html        HTML 标签与实体剥离 [默认开]
  --normalize / --no-normalize          NFKC 规范化 + 空白压缩 [默认开]
  --drop-repeat-lines / --no-...        删连续重复行与刷屏行 [默认开]
  --quality-filter / --no-...           质量过滤（符号率/有效字符率）[默认开]
  --redact-pii / --no-...               PII 脱敏（邮箱/手机号/身份证/信用卡）[默认关]
  --dedupe none|exact|minhash           去重模式 [默认 none]
  --shingles N          MinHash 字符 n-gram 长度 [默认 5]
  --bands N             LSH 带数 [默认 16]
  --rows N              LSH 每带行数 [默认 8，阈值≈0.66]
  --format jsonl|txt    输出格式 [默认 jsonl]
  --stats PATH          统计报告路径 [默认 <out> 同目录 clean_report.json]
  --dry-run             只打印计划不执行
`;

const DOWNLOAD_HELP = `download · 生成数据集下载脚本

flags:
  --source huggingface|wikipedia|commoncrawl|custom  [必填]
  --dataset-id ID      huggingface 数据集 ID [默认 wikimedia/wikipedia]
  --config-name NAME   数据集配置名（如 20231101.zh）[默认取 --lang]
  --split train        切分名 [默认 train]
  --lang zh            语言 [默认 zh]
  --limit-docs N       只取前 N 条（下载脚本参数；0=全量）
  --limit-shards N     commoncrawl 分片数 [默认 1]
  --urls A,B           custom 源的 URL 列表
  --out DIR            输出目录 [默认 ./out/data]
  --dry-run            只打印计划
`;

const DEDUPE_HELP = `dedupe · 独立去重

flags:
  --input PATH         输入 jsonl/txt
  --out PATH           输出路径
  --mode exact|minhash [默认 minhash]
  --shingles N --bands N --rows N   MinHash LSH 参数
  --stats PATH         统计报告路径
`;

const TOKENIZER_HELP = `tokenizer-config · 生成 Tokenizer 训练配置

flags:
  --out DIR            输出目录 [默认 ./out/tokenizer]
  --vocab-size N       [默认 32000]
  --model bpe|unigram|wordpiece  [默认 bpe]
  --name NAME          [默认 dsh-tokenizer]
  --langs zh,en        [默认 zh,en]
  --special-tokens A,B [默认 <unk>,<pad> 等]
  --corpus PATH        训练语料路径 [默认 clean.jsonl]
`;

const FORGE_HELP = `forge · 完整云端数据流水线

flags:
  --config PATH        json 配置（download/clean/tokenizer 三段）
  --out DIR            输出目录
  --dry-run            只生成脚本不执行
`;

function usageHelp(name) {
  const map = {
    clean: CLEAN_HELP, download: DOWNLOAD_HELP, dedupe: DEDUPE_HELP,
    'tokenizer-config': TOKENIZER_HELP, forge: FORGE_HELP,
  };
  if (map[name]) { console.log(map[name]); return true; }
  return false;
}

function flagBool(flags, name, dflt) {
  const v = flags[name];
  if (v === undefined) return dflt;
  return cli.bool(v);
}

/** 把 CLI flags 归一化为 args 对象（供 --json 复用） */
async function dispatch(sub, args) {
  switch (sub) {
    case 'download': {
      const source = cli.pick(args.source, '');
      if (!['huggingface', 'wikipedia', 'commoncrawl', 'custom'].includes(source)) {
        cli.die(`--source 必须为 huggingface|wikipedia|commoncrawl|custom，得到: "${source}"`);
      }
      const out = cli.pick(args.out, path.join('out', 'data'));
      let result;
      if (source === 'commoncrawl') result = await downloadMod.renderCommonCrawl(args);
      else if (source === 'custom') result = await downloadMod.renderCustom(args);
      else {
        // wikipedia 与 huggingface 共用 HF 渠道，wikipedia 时给默认 dataset-id
        const a = { ...args, source };
        if (source === 'wikipedia' && !a.datasetId) a.datasetId = 'wikimedia/wikipedia';
        result = await downloadMod.renderHf(a);
      }
      cli.log(`下载脚本已生成 → ${out}/`);
      for (const f of result.files) cli.log(`  - ${path.relative(process.cwd(), f)}`);
      cli.log(`  运行: ${result.manifest.how_to_run.trim()}`);
      return { out_dir: out, files: result.files.map((f) => path.relative(process.cwd(), f)), manifest: result.manifest };
    }

    case 'clean': {
      const input = cli.pick(args.input, '');
      const out = cli.pick(args.out, '');
      if (!input || !out) cli.die('clean 需要 --input 与 --out');
      const opts = {
        minChars: cli.num(args.minChars, 100),
        maxChars: cli.num(args.maxChars, 100000),
        lang: cli.pick(args.lang, 'auto'),
        stripHtml: flagBool(args, 'stripHtml', true),
        normalize: flagBool(args, 'normalize', true),
        dropRepeatLines: flagBool(args, 'dropRepeatLines', true),
        qualityFilter: flagBool(args, 'qualityFilter', true),
        redactPii: flagBool(args, 'redactPii', false),
        dedupe: cli.pick(args.dedupe, 'none'),
        shingles: cli.num(args.shingles, 5),
        bands: cli.num(args.bands, 16),
        rows: cli.num(args.rows, 8),
        format: cli.pick(args.format, 'jsonl'),
      };
      if (args.dryRun) {
        cli.log('[dry-run] 清洗计划:');
        cli.log(`  输入: ${path.resolve(input)}`);
        cli.log(`  输出: ${path.resolve(out)}`);
        cli.log(`  选项: ${JSON.stringify(opts)}`);
        return { planned: true, options: opts };
      }
      cli.log(`开始清洗: ${input} → ${out}`);
      const stats = await cleanMod.runClean(input, out, opts);
      const statsPath = cli.pick(args.stats, path.join(path.dirname(path.resolve(out)), 'clean_report.json'));
      await cli.writeJson(statsPath, { ...stats, input: path.resolve(input), output: path.resolve(out) });
      cli.log(`完成: 输入 ${stats.in_docs} 文档 → 输出 ${stats.out_docs} 文档`);
      cli.log(`  丢片: 长度 ${stats.dropped.length} / 语种 ${stats.dropped.lang} / 去重 ${stats.dropped.dup} / 质量 ${stats.dropped.quality}`);
      cli.log(`  字节: ${cli.fmtBytes(stats.bytes_in)} → ${cli.fmtBytes(stats.bytes_out)}  耗时 ${cli.fmtMs(stats.duration_ms)}`);
      cli.log(`  报告: ${statsPath}`);
      return { output: path.resolve(out), stats_path: statsPath, stats };
    }

    case 'dedupe': {
      const input = cli.pick(args.input, '');
      const out = cli.pick(args.out, '');
      if (!input || !out) cli.die('dedupe 需要 --input 与 --out');
      const mode = cli.pick(args.mode, 'minhash');
      const opts = { shingles: cli.num(args.shingles, 5), bands: cli.num(args.bands, 16), rows: cli.num(args.rows, 8) };
      cli.log(`独立去重（${mode}）: ${input} → ${out}`);
      const stats = await cleanMod.runClean(input, out, {
        minChars: 1, maxChars: Infinity, lang: 'auto',
        stripHtml: false, normalize: false, dropRepeatLines: false,
        qualityFilter: false, redactPii: false, dedupe: mode, format: 'jsonl',
        ...opts,
      });
      const statsPath = cli.pick(args.stats, path.join(path.dirname(path.resolve(out)), 'dedupe_report.json'));
      await cli.writeJson(statsPath, { ...stats, input: path.resolve(input), output: path.resolve(out) });
      cli.log(`完成: ${stats.in_docs} → ${stats.out_docs}（去重 ${stats.dropped.dup}）`);
      return { output: path.resolve(out), stats_path: statsPath, stats };
    }

    case 'tokenizer-config': {
      const out = cli.pick(args.out, path.join('out', 'tokenizer'));
      if (!fs.existsSync(path.resolve(out))) await cli.ensureDir(path.resolve(out));
      const result = await tokenizerMod.generate(args);
      cli.log(`Tokenizer 配置已生成 → ${out}/`);
      cli.log(`  - ${path.relative(process.cwd(), result.config_path)}`);
      cli.log(`  - ${path.relative(process.cwd(), result.script_path)}`);
      cli.log(`  ${result.next_step}`);
      return { out_dir: out, ...result, config_path: path.relative(process.cwd(), result.config_path), script_path: path.relative(process.cwd(), result.script_path) };
    }

    case 'forge': {
      const configPath = cli.pick(args.config, '');
      const out = cli.pick(args.out, path.join('out', 'forge'));
      if (!configPath) cli.die('forge 需要 --config（json 配置：download/clean/tokenizer 三段）');
      const config = await cli.readJson(path.resolve(configPath));
      const scriptsDir = path.resolve(__dirname, 'scripts');
      const outDir = path.resolve(out);
      await cli.ensureDir(outDir);
      // 拷贝流水线骨架
      const pipeline = await cli.readText(path.join(scriptsDir, 'forge_pipeline.sh'));
      await cli.writeText(path.join(outDir, 'forge_pipeline.sh'), pipeline);
      // 拷贝清洗 worker 及其依赖（保证云端节点独立可跑）
      const worker = await cli.readText(path.join(__dirname, 'lib', 'clean_worker.js'));
      await cli.writeText(path.join(outDir, 'clean_worker.js'), worker);
      const depLibDir = path.join(outDir, 'lib');
      await cli.ensureDir(depLibDir);
      await cli.copyFile(path.join(__dirname, 'lib', 'clean.js'), path.join(depLibDir, 'clean.js'));
      await cli.copyFile(path.join(__dirname, 'lib', 'dedupe.js'), path.join(depLibDir, 'dedupe.js'));
      await cli.copyFile(path.join(path.resolve(__dirname, '..', '..'), 'lib', 'cli.js'), path.join(depLibDir, 'cli.js'));
      // 按 config 段渲染各步骤
      const sections = [];
      if (config.download) {
        const args2 = { out: outDir, ...config.download };
        if (config.download.source === 'commoncrawl') await downloadMod.renderCommonCrawl(args2);
        else if (config.download.source === 'custom') await downloadMod.renderCustom(args2);
        else await downloadMod.renderHf(args2);
        sections.push('download');
        if (config.download.source !== 'custom') {
          await cli.writeText(path.join(outDir, 'download.sh'),
            `#!/bin/bash\nset -euo pipefail\npython3 hf_download.py "$@"\n`);
        } else {
          await cli.writeText(path.join(outDir, 'download.sh'),
            `#!/bin/bash\nset -euo pipefail\npython3 custom_download.py "$@"\n`);
        }
      }
      if (config.tokenizer) {
        await tokenizerMod.generate({ out: outDir, ...config.tokenizer });
        sections.push('tokenizer');
      }
      // 生成 runbook
      const runbook = [
        '# Forge Runbook（由 dsh-llm-architect 生成）',
        '',
        `生成时间: ${cli.isoNow()}`,
        `配置: ${path.resolve(configPath)}`,
        '',
        '## 执行方式（云端节点）',
        '',
        '```bash',
        'scp -r 本地 out/forge 远程:/root/llm-data/',
        'ssh 远程 "cd /root/llm-data/forge && PARALLEL=8 bash forge_pipeline.sh"',
        '```',
        '',
        `## 生成的段: ${sections.join(', ') || '仅流水线骨架'}`,
        '',
        '## 输出',
        '- raw/         原始下载',
        '- shards/      分片',
        '- clean/       并行清洗结果',
        '- final.jsonl  最终去重语料',
        '- tokenizer_output/ （若配置了 tokenizer 段）',
        '',
      ].join('\n');
      await cli.writeText(path.join(outDir, 'runbook.md'), runbook);
      cli.log(`Forge 流水线已生成 → ${out}/`);
      cli.log(`  段: ${sections.join(', ') || '骨架'}`);
      cli.log('  云端执行: bash forge_pipeline.sh');
      return { out_dir: outDir, sections, files: fs.readdirSync(outDir) };
    }

    default:
      cli.die(`未知子命令: ${sub}（--help 查看用法）`);
  }
}

async function main() {
  const argv = process.argv.slice(2);

  // MCP 风格 JSON 调用
  if (argv[0] === '--json') {
    let req;
    try { req = JSON.parse(argv[1] || '{}'); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: `--json 参数解析失败: ${e.message}` })); process.exit(1); }
    const sub = req.subcommand;
    if (!sub) { console.log(JSON.stringify({ ok: false, error: '缺少 subcommand' })); process.exit(1); }
    try {
      const data = await dispatch(sub, req.args || {});
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

  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') {
    console.log(HELP);
    process.exit(sub ? 0 : 0);
  }
  if (sub === 'version' || sub === '-v') {
    console.log('llm_data_forge v0.1.0');
    return;
  }
  if (flags.help === true || flags['--help'] === true) {
    if (!usageHelp(sub)) console.log(HELP);
    return;
  }
  try {
    await dispatch(sub, flags);
  } catch (e) {
    cli.die(String(e && e.message || e));
  }
}

main();
