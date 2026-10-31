'use strict';
// tools/llm_data_forge/lib/download.js — 数据集下载脚本渲染
// 本地只生成脚本与清单，真实下载在本地（小数据）或云端（大数据）执行。

const fs = require('fs');
const path = require('path');
const cli = require('../../../lib/cli.js');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

function readTemplate(name) {
  const p = path.join(SCRIPTS_DIR, name);
  if (!fs.existsSync(p)) cli.die(`模板缺失: ${p}`);
  return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
}

const WIKIPEDIA_DEFAULTS = {
  zh: 'wikimedia/wikipedia',
  en: 'wikimedia/wikipedia',
  ja: 'wikimedia/wikipedia',
};

/**
 * 渲染 HuggingFace / Wikipedia 下载脚本
 * wikipedia 等价于带默认 dataset 配置的 huggingface 源
 */
async function renderHf(args) {
  const outDir = path.resolve(args.out);
  await cli.ensureDir(outDir);
  const datasetId = args.datasetId || 'wikimedia/wikipedia';
  const split = args.split || 'train';
  const limit = args.limitDocs ? String(args.limitDocs) : '';
  const lang = args.lang || 'zh';
  const tokenEnv = args.tokenEnv || 'HF_TOKEN';

  const script = cli.template(readTemplate('hf_download.py'), {
    DATASET_ID: datasetId,
    CONFIG_NAME: args.configName || lang,
    SPLIT: split,
    LIMIT_DOCS: limit,
    OUT_DIR: path.join(outDir, 'raw').replace(/\\/g, '/'),
    HF_TOKEN_ENV: tokenEnv,
    HF_ENDPOINT: cli.envValue('HF_ENDPOINT', 'https://huggingface.co'),
  });
  const scriptPath = path.join(outDir, 'hf_download.py');
  await cli.writeText(scriptPath, script);

  const manifest = {
    tool: 'llm_data_forge', source: args.source, dataset_id: datasetId,
    config: args.configName || lang, split, limit_docs: limit || null,
    lang, est_bytes: null, created_at: cli.isoNow(),
    scripts: [path.basename(scriptPath)],
    how_to_run: `python ${path.basename(scriptPath)}  # 数据写入 raw/ 目录`,
    cloud_instructions: '数据量 >10GB 时建议在云端节点执行：scp 上传脚本后 python hf_download.py',
  };
  await cli.writeJson(path.join(outDir, 'download_manifest.json'), manifest);
  return { manifest, files: [scriptPath, path.join(outDir, 'download_manifest.json')] };
}

/**
 * 渲染 Common Crawl WET 下载脚本
 */
async function renderCommonCrawl(args) {
  const outDir = path.resolve(args.out);
  await cli.ensureDir(outDir);
  const limit = args.limitDocs ? String(args.limitDocs) : '1'; // 分片数
  const collection = args.collection || 'latest';

  const script = cli.template(readTemplate('commoncrawl_download.sh'), {
    COLLECTION: collection,
    LIMIT_SHARDS: limit,
    OUT_DIR: path.join(outDir, 'raw').replace(/\\/g, '/'),
    CC_INDEX: cli.envValue('CC_INDEX', 'https://index.commoncrawl.org'),
  });
  const scriptPath = path.join(outDir, 'commoncrawl_download.sh');
  await cli.writeText(scriptPath, script);

  const manifest = {
    tool: 'llm_data_forge', source: 'commoncrawl', collection,
    limit_shards: limit, est_bytes: null, created_at: cli.isoNow(),
    scripts: [path.basename(scriptPath)],
    how_to_run: `bash ${path.basename(scriptPath)}  # 下载 WET 分片到 raw/`,
    cloud_instructions: 'Common Crawl 单分片约 5GB，务必在云端节点执行下载与解压',
  };
  await cli.writeJson(path.join(outDir, 'download_manifest.json'), manifest);
  return { manifest, files: [scriptPath, path.join(outDir, 'download_manifest.json')] };
}

/**
 * 自定义 URL 列表下载脚本（半自动骨架：填入 URL 后执行）
 */
async function renderCustom(args) {
  const outDir = path.resolve(args.out);
  await cli.ensureDir(outDir);
  const urls = (cli.pick(args.urls, '') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const script = [
    '#!/usr/bin/env python3',
    '# 由 dsh-llm-architect llm_data_forge 生成的自定义 URL 下载脚本',
    '# 在本地或云端执行：python custom_download.py',
    'import os, sys, urllib.request, hashlib',
    '',
    'URLS = [',
    ...(urls.length ? urls.map((u) => `    ${JSON.stringify(u)},`) : ['    # "https://example.com/corpus.txt",']),
    ']',
    'OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "raw")',
    'os.makedirs(OUT_DIR, exist_ok=True)',
    '',
    'for i, url in enumerate(URLS):',
    '    dst = os.path.join(OUT_DIR, "custom_%03d_%s" % (i, os.path.basename(url.split("?")[0]) or "data"))',
    '    print("[download]", url, "->", dst)',
    '    urllib.request.urlretrieve(url, dst)',
    'print("done, %d files -> %s" % (len(URLS), OUT_DIR))',
    '',
  ].join('\n');
  const scriptPath = path.join(outDir, 'custom_download.py');
  await cli.writeText(scriptPath, script);
  const manifest = {
    tool: 'llm_data_forge', source: 'custom', urls, created_at: cli.isoNow(),
    scripts: ['custom_download.py'],
    how_to_run: '编辑 URLS 列表后 python custom_download.py',
  };
  await cli.writeJson(path.join(outDir, 'download_manifest.json'), manifest);
  return { manifest, files: [scriptPath, path.join(outDir, 'download_manifest.json')] };
}

module.exports = { renderHf, renderCommonCrawl, renderCustom };
