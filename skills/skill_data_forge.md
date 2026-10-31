---
name: skill_data_forge
category: llm-pipeline
tool: llm_data_forge
---

# Skill: 数据锻造（llm_data_forge）

## 何时使用
当任务涉及：获取开源语料（Wikipedia / Common Crawl / HuggingFace）、本地清洗去重去噪、生成 Tokenizer 训练配置时。

## 核心原则
- 本地只做**轻量纯 Node.js 计算**（清洗/去重/统计），绝对不在本地跑深度学习。
- 大规模下载与 Tokenizer 训练生成**云端脚本**，交给 GPU/CPU 服务器执行。

## 标准流程
1. 生成下载脚本（脚本会被写到 out 目录，可本地或云端执行）：
   `node tools/llm_data_forge/index.js download --source wikipedia --lang zh --out out/data`
2. 本地清洗（流式，内存友好）：
   `node tools/llm_data_forge/index.js clean --input out/data --out out/data/clean.jsonl --dedupe minhash --redact-pii`
3. 检查 `clean_report.json`：丢片率、去重率、语种分布是否合理；丢片率 >30% 时降级过滤强度。
4. 生成 Tokenizer 配置：
   `node tools/llm_data_forge/index.js tokenizer-config --vocab-size 32000 --lang zh,en --out out/tokenizer`

## 输出物
- `clean.jsonl`（每行 `{"text": "...", "meta": {...}}`）
- `clean_report.json`（输入/输出文档数、各过滤器丢片统计、字节统计）
- `tokenizer_training_config.json` + `train_tokenizer.py`（云端执行）
- `runbook.md`（该批次数据锻造的可复现记录）

## 升级路径
- 清洗结果异常 → 调整 `--min-chars/--max-chars/--lang` 或关闭个别过滤器重跑。
- 语料超 10GB → 使用 `forge` 子命令生成云端流水线脚本（split + 并行清洗 + 合并）。
