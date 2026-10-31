#!/bin/bash
# train_deepspeed.sh — 单机/多机 DeepSpeed 启动脚本（由 llm_cloud_provision 生成）。
# 多机时用 --hostfile 指定节点（ ssh 免密已配置）；单机8卡可去掉 --hostfile。
set -euo pipefail

NUM_GPUS="{{NUM_GPUS}}"
NNODES="{{NNODES}}"
HOSTFILE="{{HOSTFILE}}"
TRAIN_PY="{{TRAIN_PY}}"
DS_CONFIG="{{DS_CONFIG}}"
OUTPUT_DIR="{{OUTPUT_DIR}}"
DATA_DIR="{{DATA_DIR}}"
TOKENIZER_DIR="{{TOKENIZER_DIR}}"
MODEL_CONFIG="{{MODEL_CONFIG}}"
EXTRA="{{EXTRA_ARGS}}"

if [ ! -f "$DS_CONFIG" ]; then
  echo "[fatal] 缺少 DeepSpeed 配置: $DS_CONFIG"; exit 1
fi

export TOKENIZERS_PARALLELISM=false
export HF_HUB_OFFLINE=0
# NCCL 多机加速
export NCCL_DEBUG=WARN
export NCCL_IB_DISABLE=0
export NCCL_NET_GDR_LEVEL=2

if [ "$NNODES" -gt 1 ]; then
  LAUNCHER_ARGS="--hostfile $HOSTFILE --num_nodes $NNODES"
else
  LAUNCHER_ARGS="--num_nodes 1"
fi

deepspeed $LAUNCHER_ARGS \
  --num_gpus "$NUM_GPUS" \
  "$TRAIN_PY" \
  --deepspeed "$DS_CONFIG" \
  --model_config "$MODEL_CONFIG" \
  --tokenizer_dir "$TOKENIZER_DIR" \
  --data_dir "$DATA_DIR" \
  --output_dir "$OUTPUT_DIR" \
  --bf16 \
  --gradient_checkpointing \
  $EXTRA
