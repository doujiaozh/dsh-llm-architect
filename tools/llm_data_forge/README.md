# llm_data_forge · 数据锻造与清洗

DSH LLM Architect 的第一步：把原始网页/语料锻造成为高质量预训练数据。
本工具是**纯 Node.js 零依赖**的本地控制面组件，可在 Win7 上直接运行清洗小批量数据，并生成在云端节点执行的大数据下载/分词脚本。

## 设计原则

- **本地只做轻活**：清洗、去重、统计、配置生成（纯计算，无 CUDA/PyTorch）。
- **云端做重活**：Common Crawl 下载、TB 级清洗流水线、Tokenizer 训练都生成脚本后扔到服务器执行。

## 快速开始

```bash
# 1. 体检
node ../../bin/dsh-llm.js doctor

# 2. 清洗示例语料（去重 + PII 脱敏 + HTML 剥离）
node index.js clean --input ../../examples/sample_corpus.jsonl \
  --out ../../out/data/clean.jsonl --dedupe minhash --redact-pii

# 3. 生成 Wikipedia 下载脚本（在云端执行）
node index.js download --source wikipedia --lang zh --limit-docs 100000 --out ../../out/data

# 4. 生成 Tokenizer 训练配置（在云端执行）
node index.js tokenizer-config --vocab-size 32000 --langs zh,en --out ../../out/tok
```

## 子命令

| 子命令 | 用途 | 是否本地执行 |
|---|---|---|
| `download` | 生成数据集下载脚本（huggingface / wikipedia / commoncrawl / custom） | 生成本地，执行建议云端 |
| `clean` | 流式清洗：HTML 剥离、NFKC 规范化、重复行删除、质量过滤、语种过滤、PII 脱敏、去重 | ✅ 本地 |
| `dedupe` | 独立去重（exact SHA-1 / MinHash LSH） | ✅ 本地 |
| `tokenizer-config` | 生成云端 Tokenizer 训练配置 + 脚本 | 生成本地 |
| `forge` | 按 json 配置编排完整云端数据流水线 | 生成本地 |

各子命令的完整 flags 见 `node index.js <subcommand> --help`。

## 清洗能力明细

- **HTML 剥离**：删 script/style/noscript/template/head 块与注释，解码 60+ 命名实体与数字实体。
- **规范化**：NFKC、控制字符清理、全角空格转半角、行内空白压缩、3+ 换行压 2。
- **PII 脱敏**：邮箱、中国手机号、18 位身份证、16 位信用卡 → `[REDACTED]`。
- **重复行删除**：相邻 ≥3 相同行删除、单字符连续 ≥10 次的刷屏行删除。
- **质量过滤**：符号率 >0.3 或字母数字占比 <0.2 的文档丢弃（使用 `\p{L}\p{N}`，中文友好）。
- **语种过滤**：CJK/Latin 比率判定 `zh|en|mixed`，`--lang` 可硬过滤。
- **去重**：
  - `exact`：规范化后 SHA-1 精确去重。
  - `minhash`：128 维 MinHash 签名（字符 5-gram）+ LSH（16 带 × 8 行，阈值 ≈0.66）近似去重，保留首见。

## 输入/输出格式

- 输入：`.jsonl`（每行 `{text, ...meta}` 或纯字符串）、`.json`（数组或 `{data|records}`）、`.txt`/`.md`（空行分段）、目录（递归）。
- 输出：`clean.jsonl`（每行 `{"text","meta"}`，含 `chars`/`lang`/`source`）或 `--format txt`。
- 统计报告 `clean_report.json`：进出文档数、字节、四类丢片计数、去重碰撞数、耗时。

## 云端流水线（forge）

```json
{
  "download": { "source": "wikipedia", "lang": "zh", "limit-docs": 1000000 },
  "tokenizer": { "vocab-size": 32000, "langs": "zh,en" }
}
```

```bash
node index.js forge --config my_forge.json --out ../../out/forge
# 然后：
scp -r out/forge root@gpu-host:/root/llm-data/
ssh root@gpu-host "cd /root/llm-data/forge && PARALLEL=8 bash forge_pipeline.sh"
```

流水线内部执行：下载 → 分片（200MB）→ 并行清洗 → 合并 → 全局 MinHash 去重 → Tokenizer 训练。

## 文件结构

```
index.js                        # CLI 入口（--json MCP 模式：{"subcommand","args"}）
manifest.json                   # DSH 工具清单（inputSchema 供 Agent 调用）
lib/clean.js                    # 清洗引擎
lib/dedupe.js                   # MinHash + LSH / exact 去重
lib/download.js                 # 下载脚本渲染
lib/tokenizer.js                # Tokenizer 配置生成
lib/clean_worker.js             # forge 流水线的并行 worker
scripts/hf_download.py          # HuggingFace/Wikipedia 下载脚本模板
scripts/commoncrawl_download.sh # Common Crawl WET 下载脚本模板
scripts/train_tokenizer.py      # tokenizers 库训练脚本模板
scripts/forge_pipeline.sh       # 云端流水线骨架
```
