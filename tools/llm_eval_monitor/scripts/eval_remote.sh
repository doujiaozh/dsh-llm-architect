#!/bin/bash
# eval_remote.sh — 本地控制面执行：ssh 到 GPU 节点跑评测并把结果拉回。
# 用法: bash eval_remote.sh <model_path> [tasks...]（依赖 .env 的 REMOTE_* 变量）
set -euo pipefail

MODEL_PATH="${1:?用法: bash eval_remote.sh <model_path> [tasks...]}"
shift || true
TASKS="${*:-mmlu,hellaswag,arc_challenge,arc_easy,winogrande,piqa,truthfulqa_mc2,gsm8k}"

REMOTE_HOST="${REMOTE_HOST:?设置 .env 的 REMOTE_HOST}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_PORT="${REMOTE_PORT:-22}"
SSH_KEY="${SSH_KEY_PATH:-}"
WORKDIR="${REMOTE_WORKDIR:-/root/llm-training}"

SSH_OPTS="-o StrictHostKeyChecking=no -o ConnectTimeout=15 -o ServerAliveInterval=30"
if [ -n "$SSH_KEY" ]; then SSH_OPTS="$SSH_OPTS -i $SSH_KEY"; fi

echo "[1/3] 上传 run_lm_eval.sh"
scp $SSH_OPTS -P "$REMOTE_PORT" run_lm_eval.sh "$REMOTE_USER@$REMOTE_HOST:$WORKDIR/"

echo "[2/3] 远端评测中（tasks: $TASKS）"
ssh $SSH_OPTS -p "$REMOTE_PORT" "$REMOTE_USER@$REMOTE_HOST" \
  "cd $WORKDIR && LM_EVAL_TASKS='$TASKS' LM_EVAL_OUT='eval_results.json' bash run_lm_eval.sh $WORKDIR/$MODEL_PATH"

echo "[3/3] 拉回结果"
mkdir -p eval_out
scp $SSH_OPTS -P "$REMOTE_PORT" \
  "$REMOTE_USER@$REMOTE_HOST:$WORKDIR/eval_results.json" \
  "eval_out/eval_results_${REMOTE_HOST}.json" || echo "[warn] 结果文件未找到"

echo "[done] → eval_out/eval_results_${REMOTE_HOST}.json"
