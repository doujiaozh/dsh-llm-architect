#!/bin/bash
# commoncrawl_download.sh — 由 dsh-llm-architect (llm_data_forge) 生成。
# 用途：查询 Common Crawl 最新 collection，下载指定数量的 WET（提取后纯文本）分片。
# 运行环境：云端节点（单分片压缩包约 500MB，解压后约 5GB）。
# 用法：bash commoncrawl_download.sh
set -euo pipefail

CC_INDEX="{{CC_INDEX}}"
COLLECTION="{{COLLECTION}}"        # "latest" 表示取最新一版，如 2024-10
LIMIT_SHARDS="{{LIMIT_SHARDS}}"    # 下载分片数
OUT_DIR="{{OUT_DIR}}"

mkdir -p "$OUT_DIR"

# 1. 解析 collection（latest → 实际版本号）
if [ "$COLLECTION" = "latest" ]; then
  COLLECTION=$(curl -sS "$CC_INDEX/collinfo.json" \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)[0]["id"])')
fi
echo "[info] collection: $COLLECTION"

# 2. 拉取 WET 文件列表
WET_LIST="$OUT_DIR/wet.paths"
curl -sS "https://data.commoncrawl.org/$COLLECTION/wet.paths.gz" -o "$OUT_DIR/wet.paths.gz"
gunzip -f "$OUT_DIR/wet.paths.gz"
echo "[info] total WET shards: $(wc -l < "$WET_LIST")"

# 3. 下载前 N 个分片
i=0
while IFS= read -r wet_path; do
  i=$((i + 1))
  if [ "$i" -gt "$LIMIT_SHARDS" ]; then break; fi
  fname=$(basename "$wet_path")
  echo "[download] ($i/$LIMIT_SHARDS) $fname"
  curl -sS --retry 3 "https://data.commoncrawl.org/$wet_path" -o "$OUT_DIR/$fname"
done < "$WET_LIST"

# 4. 输出清单
echo "[done] downloaded shards:"
ls -lh "$OUT_DIR"/*.warc.wet.gz 2>/dev/null || ls -lh "$OUT_DIR"
echo "[next] 解压: gunzip -k $OUT_DIR/*.warc.wet.gz   （或直接交给 clean 阶段流式处理）"
