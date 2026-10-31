'use strict';
// tools/llm_data_forge/lib/tokenizer.js — Tokenizer 训练配置生成（云端执行）

const fs = require('fs');
const path = require('path');
const cli = require('../../../lib/cli.js');

const SCRIPTS_DIR = path.join(__dirname, '..', 'scripts');

const SPECIAL_DEFAULT = [
  '<|endoftext|>', '<|padding|>', '<|system|>', '<|user|>', '<|assistant|>',
];

/**
 * 生成 tokenizer 训练配置 + 训练脚本（填好参数，可直接在云端节点执行）
 */
async function generate(args) {
  const outDir = path.resolve(args.out);
  await cli.ensureDir(outDir);

  const vocabSize = cli.num(args.vocabSize, 32000);
  const model = cli.pick(args.model, 'bpe'); // bpe | unigram | wordpiece
  const name = cli.pick(args.name, 'dsh-tokenizer');
  const langs = cli.pick(args.langs, 'zh,en');
  const corpus = cli.pick(args.corpus, 'clean.jsonl');
  const special = (cli.pick(args.specialTokens, SPECIAL_DEFAULT.join(',')))
    .split(',').map((s) => s.trim()).filter(Boolean);

  const config = {
    name, version: 1, model, vocab_size: vocabSize,
    languages: langs.split(',').map((s) => s.trim()).filter(Boolean),
    corpus_path: corpus,
    corpus_field: 'text',
    training: {
      character_coverage: 0.9995,
      byte_fallback: true,
      unk_token: '<unk>',
      bos_token: '<s>',
      eos_token: '</s>',
      pad_token: '<pad>',
      special_tokens: special,
      max_input_chars_per_word: 32,
      max_sentence_length: 8192,
      num_threads: null, // 云端按机器核数
    },
    output_dir: './tokenizer_output',
    created_at: cli.isoNow(),
  };

  const tpl = fs.existsSync(path.join(SCRIPTS_DIR, 'train_tokenizer.py'))
    ? fs.readFileSync(path.join(SCRIPTS_DIR, 'train_tokenizer.py'), 'utf8').replace(/\r\n/g, '\n')
    : cli.die(`模板缺失: ${path.join(SCRIPTS_DIR, 'train_tokenizer.py')}`);

  const script = cli.template(tpl, {
    TOKENIZER_NAME: name,
    MODEL_TYPE: model,
    VOCAB_SIZE: String(vocabSize),
    LANGS: langs,
    CORPUS_PATH: corpus,
    CHARACTER_COVERAGE: String(config.training.character_coverage),
    SPECIAL_TOKENS_PY: JSON.stringify(special),
    OUTPUT_DIR: config.output_dir,
  });

  const configPath = path.join(outDir, 'tokenizer_training_config.json');
  const scriptPath = path.join(outDir, 'train_tokenizer.py');
  await cli.writeJson(configPath, config);
  await cli.writeText(scriptPath, script);

  return {
    config_path: configPath, script_path: scriptPath,
    next_step: `把语料与脚本传到云端节点后执行: python train_tokenizer.py --config tokenizer_training_config.json`,
  };
}

module.exports = { generate, SPECIAL_DEFAULT };
