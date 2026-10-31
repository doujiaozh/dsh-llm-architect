#!/bin/bash
# forge_pipeline.sh — 由 dsh-llm-architect (llm_data_forge) 生成的云端数据流水线。
# 用途：在云端节点上执行"下载 → 分片 → 并行清洗 → 合并 → 去重 → Tokenizer"全流程。
# 设计：本地控制面只生成此脚本，数据面（GPU/CPU 服务器）执行。
set -euo pipefail

PIPELINE_DIR="$(cd "$(dirname "$0")" && pwd)"
RAW_DIR="$PIPELINE_DIR/raw"
SHARDS_DIR="$PIPELINE_DIR/shards"
CLEAN_DIR="$PIPELINE_DIR/clean"
MERGED="$PIPELINE_DIR/merged.jsonl"
FINAL="$PIPELINE_DIR/final.jsonl"

PARALLEL="${PARALLEL:-8}"   # 并行 worker 数，按机器核数调整

echo "== [1/6] 下载（如已预置 raw/ 可跳过）=="
if [ ! -d "$RAW_DIR" ] || [ -z "$(ls -A "$RAW_DIR" 2>/dev/null)" ]; then
  bash "$PIPELINE_DIR/download.sh" || true
fi

echo "== [2/6] 分片（每片 200MB）=="
mkdir -p "$SHARDS_DIR"
if [ -n "$(ls -A "$RAW_DIR"/*.jsonl 2>/dev/null)" ]; then
  split -l 200000 -d -a 3 "$RAW_DIR"/*.jsonl "$SHARDS_DIR/shard_"
else
  # 非 jsonl（warc.wet 等）：按字节切分后逐行规整
  for f in "$RAW_DIR"/*; do
    split -b 200m -d -a 3 "$f" "$SHARDS_DIR/$(basename "$f")_"
  done
fi

echo "== [3/6] 并行清洗（$PARALLEL workers）=="
mkdir -p "$CLEAN_DIR"
clean_one() {
  shard="$1"
  out="$CLEAN_DIR/$(basename "$shard").clean.jsonl"
  node "$PIPELINE_DIR/clean_worker.js" --input "$shard" --out "$out" || \
    python3 "$PIPELINE_DIR/clean_worker.py" --input "$shard" --out "$out"
}
export -f clean_one
ls "$SHARDS_DIR"/* | xargs -P "$PARALLEL" -I{} bash -c 'clean_one "$@"' _ {}

echo "== [4/6] 合并 =="
cat "$CLEAN_DIR"/*.clean.jsonl > "$MERGED"

echo "== [5/6] 全局去重与二次清洗 =="
node "$PIPELINE_DIR/clean_worker.js" --input "$MERGED" --out "$FINAL" --dedupe minhash --redact-pii

echo "== [6/6] Tokenizer 训练 =="
if [ -f "$PIPELINE_DIR/train_tokenizer.py" ]; then
  python3 "$PIPELINE_DIR/train_tokenizer.py" --corpus "$FINAL" --output-dir "$PIPELINE_DIR/tokenizer_output"
fi

echo "[done] 最终语料: $FINAL"
wc -l "$FINAL"
