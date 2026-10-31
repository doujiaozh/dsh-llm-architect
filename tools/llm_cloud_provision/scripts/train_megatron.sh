#!/bin/bash
# train_megatron.sh — Megatron-LM 分布式预训练启动脚本（由 llm_cloud_provision 生成）。
# 适用于多机多卡大规模训练（张量并行 TP + 流水并行 PP + 数据并行 DP）。
set -euo pipefail

GPUS_PER_NODE="{{NUM_GPUS}}"     # 每卡数
NNODES="{{NNODES}}"
TP="{{TP}}"                       # 张量并行度
PP="{{PP}}"                       # 流水并行度
DATA_DIR="{{DATA_DIR}}"
TOKENIZER_DIR="{{TOKENIZER_DIR}}"
OUTPUT_DIR="{{OUTPUT_DIR}}"
EXTRA="{{EXTRA_ARGS}}"

if [ "$NNODES" -gt 1 ]; then
  MASTER_ADDR=$(head -n1 "{{HOSTFILE}}" | awk '{print $1}')
  LAUNCHER="deepspeed --hostfile {{HOSTFILE}} --num_nodes $NNODES --num_gpus $GPUS_PER_NODE"
else
  MASTER_ADDR=localhost
  LAUNCHER="deepspeed --num_nodes 1 --num_gpus $GPUS_PER_NODE"
fi

export NCCL_DEBUG=WARN
export CUDA_DEVICE_MAX_CONNECTIONS=1

DP=$(( (NNODES * GPUS_PER_NODE) / (TP * PP) ))
echo "[info] TP=$TP PP=$PP DP=$DP world=$((NNODES * GPUS_PER_NODE))"

$LAUNCHER pretrain_gpt.py \
  --tensor-model-parallel-size "$TP" \
  --pipeline-model-parallel-size "$PP" \
  --num-layers 24 --hidden-size 2048 --num-attention-heads 16 \
  --seq-length 4096 --max-position-embeddings 4096 \
  --micro-batch-size 4 --global-batch-size 256 \
  --bf16 --use-distributed-optimizer --overlap-grad-reduce \
  --tokenizer-type HuggingFaceTokenizer \
  --tokenizer-model "$TOKENIZER_DIR" \
  --data-path "$DATA_DIR" \
  --save "$OUTPUT_DIR" \
  --log-interval 10 --save-interval 1000 \
  $EXTRA
