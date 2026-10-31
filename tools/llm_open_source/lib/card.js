'use strict';
// 模型卡（README.md）生成 —— 纯字符串模板，零依赖。
const cli = require('../../../lib/cli.js');

const BADGES = (m) => [
  `[![License: ${m.licenseSpdx}](https://img.shields.io/badge/License-${encodeURIComponent(m.licenseSpdx)}-blue.svg)](./LICENSE)`,
  `[![Framework: ${m.framework}](https://img.shields.io/badge/Training-${encodeURIComponent(m.framework)}-orange.svg)](https://github.com/microsoft/DeepSpeed)`,
  `[![Params: ${m.paramsHuman}](https://img.shields.io/badge/Parameters-${encodeURIComponent(m.paramsHuman)}-green.svg)](#model-details)`,
  `[![Dtype: ${m.dtype}](https://img.shields.io/badge/Dtype-${encodeURIComponent(m.dtype)}-red.svg)](#model-details)`
];

function humanParams(n) {
  if (!n && n !== 0) return 'unknown';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  return String(n);
}

function table(rows, headers) {
  const lines = [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`];
  rows.forEach((r) => lines.push(`| ${r.join(' | ')} |`));
  return lines.join('\n');
}

function buildModelCard(info) {
  const m = {
    name: info.name || 'dsh-llm-base',
    org: info.org || 'dsh-architect',
    licenseSpdx: info.licenseSpdx || 'Apache-2.0',
    licenseFile: info.licenseFile || 'LICENSE',
    framework: info.framework || 'DeepSpeed',
    paramsHuman: humanParams(info.params),
    dtype: info.dtype || 'bfloat16',
    arch: info.arch || 'LlamaForCausalLM',
    vocab: info.vocab || 32000,
    hidden: info.hidden || 2048,
    layers: info.layers || 24,
    heads: info.heads || 16,
    maxPos: info.maxPos || 4096,
    dataset: info.dataset || '清洗后的自建语料（MinHash 去重 + PII 脱敏）',
    trainSteps: info.trainSteps || 0,
    _trainLoss: undefined,
    evalRows: info.evalRows || [],
    extra: info.extra || {}
  };
  m._trainLoss = info.lastLoss;
  const repoId = `${m.org}/${m.name}`;

  const out = [];
  out.push(`# ${m.name}`, '');
  out.push(BADGES(m).join(' '), '');
  out.push(info.tagline || `${m.name} 是由 DeepSeek Harness LLM Architect 流水线从零训练的开源大语言模型。`, '');

  out.push('## Model Details', '');
  out.push(table([
    ['Model', repoId],
    ['Architecture', m.arch],
    ['Parameters', `${m.paramsHuman}${info.params ? ` (${info.params.toLocaleString('en-US')})` : ''}`],
    ['Hidden size', String(m.hidden)],
    ['Layers', String(m.layers)],
    ['Attention heads', String(m.heads)],
    ['Vocab size', String(m.vocab)],
    ['Max position embeddings', String(m.maxPos)],
    ['Dtype', m.dtype],
    ['Training framework', m.framework],
    ['License', `${m.licenseSpdx}（见 ${m.licenseFile}）`]
  ], ['Field', 'Value']), '');

  if (m._trainLoss !== undefined) {
    out.push('## Training Summary', '');
    out.push(table([
      ['Steps', String(m.trainSteps)],
      ['Final loss', String(m._trainLoss)],
      ['Tokenizer', 'BBPE (SentencePiece 兼容), vocab ' + m.vocab],
      ['Dataset', m.dataset]
    ], ['Item', 'Value']), '');
  }

  if (m.evalRows.length) {
    out.push('## Benchmark Results', '');
    out.push(table(m.evalRows.map((r) => [r[0], r[1], r[2] || '']), ['Task', 'Metric', 'Score']), '');
  }

  out.push('## Usage', '');
  out.push('```python');
  out.push('import torch');
  out.push('from transformers import AutoModelForCausalLM, AutoTokenizer');
  out.push('');
  out.push(`model = AutoModelForCausalLM.from_pretrained("${repoId}", torch_dtype=torch.bfloat16, device_map="auto")`);
  out.push(`tokenizer = AutoTokenizer.from_pretrained("${repoId}")`);
  out.push('');
  out.push('prompt = "DeepSeek Harness 是一个"');
  out.push('inputs = tokenizer(prompt, return_tensors="pt").to(model.device)');
  out.push('out = model.generate(**inputs, max_new_tokens=64, do_sample=False)');
  out.push('print(tokenizer.decode(out[0], skip_special_tokens=True))');
  out.push('```', '');

  out.push('## Training Pipeline', '');
  out.push(['本项目由 [dsh-llm-architect](https://github.com/dsh-architect/dsh-llm-architect) 流水线生成：',
    '',
    '```',
    '本地控制面 (Win7/Node.js)                云端数据面 (GPU 集群)',
    '  llm_data_forge  ──清洗语料──►          训练节点',
    '  llm_cloud_provision ──下发►            DeepSpeed/Megatron 训练',
    '  llm_eval_monitor ◄──指标/告警──        lm-eval 评测',
    '  llm_open_source  ◄──Safetensors──      发布到 HuggingFace Hub',
    '```'].join('\n'), '');

  out.push('## License', '');
  out.push(`本模型以 ${m.licenseSpdx} 协议开源，详见 [${m.licenseFile}](./${m.licenseFile})。`, '');
  if (info.licenseNote) out.push(info.licenseNote, '');

  out.push('## Citation', '');
  out.push('```bibtex');
  out.push(`@misc{${m.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()},`);
  out.push('  title       = {' + m.name + '},');
  out.push(`  author      = {${m.org}},`);
  out.push(`  year        = {${new Date().getUTCFullYear()}},`);
  out.push('  howpublished = {HuggingFace Hub},');
  out.push(`  url         = {https://huggingface.co/${repoId}}`);
  out.push('}');
  out.push('```', '');
  return { text: out.join('\n'), repoId };
}

module.exports = { buildModelCard, humanParams, table, BADGES };
