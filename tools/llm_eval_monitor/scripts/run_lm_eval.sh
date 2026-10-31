#!/bin/bash
# run_lm_eval.sh — 在 GPU 节点上用 lm-evaluation-harness 评测 checkpoint（由 llm_eval_monitor 生成）。
# 用法: bash run_lm_eval.sh <model_path> [tasks...]   # tasks 为空时用 LM_EVAL_TASKS
set -euo pipefail

MODEL_PATH="${1:?用法: bash run_lm_eval.sh <model_path> [tasks...]}"
shift || true
TASKS="${*:-${LM_EVAL_TASKS:-mmlu,hellaswag,arc_challenge,arc_easy,winogrande,piqa,truthfulqa_mc2,gsm8k}}"

if [ ! -d "$MODEL_PATH" ] && [ ! -f "$MODEL_PATH" ]; then
  echo "[fatal] 模型路径不存在: $MODEL_PATH"; exit 1
fi

# 可选：venv 隔离
if [ "${USE_VENV:-1}" = "1" ] && [ ! -d .venv-eval ]; then
  python3 -m venv .venv-eval
fi
if [ -d .venv-eval ]; then source .venv-eval/bin/activate; fi

pip install --quiet "lm-eval>=0.4,<0.5" 2>/dev/null || pip install --quiet lm-eval

echo "[eval] model=$MODEL_PATH"
echo "[eval] tasks=$TASKS"
python -m lm_eval --model hf \
  --model_args pretrained="$MODEL_PATH",dtype=bfloat16,device_map=auto \
  --tasks "$TASKS" \
  --num_fewshot "${LM_EVAL_FEWSHOT:-0}" \
  --batch_size "${LM_EVAL_BATCH:-8}" \
  --output_path "${LM_EVAL_OUT:-eval_results.json}" \
  --log_samples ${LM_EVAL_LOG_SAMPLES:-} \
  "$@"

echo "[done] 结果写入 ${LM_EVAL_OUT:-eval_results.json}"
python3 - <<'EOF' 2>/dev/null || true
import json, sys
try:
    d = json.load(open("eval_results.json"))
    r = d.get("results", d)
    print("\n===== 评测摘要 =====")
    for task, m in sorted(r.items()):
        if not isinstance(m, dict): continue
        acc = m.get("acc,none", m.get("acc"))
        accs = m.get("acc_norm,none", m.get("acc_norm"))
        print(f"{task:<20} acc={acc} acc_norm={accs}")
except Exception as e:
    print("（摘要生成失败，直接查看 json）", e)
EOF
