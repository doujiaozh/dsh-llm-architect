#!/bin/bash
# examples/usage.sh — dsh-llm-architect 端到端演示（纯本地可安全运行的部分）
# 用法: bash examples/usage.sh [临时目录]
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="${1:-$(mktemp -d)}"
mkdir -p "$WORK"

echo "== 0. 环境体检 =="
node "$ROOT/bin/dsh-llm.js" doctor

echo
echo "== 1. 数据锻造：清洗示例语料（含重复/HTML/PII/垃圾文本）=="
node "$ROOT/tools/llm_data_forge/index.js" clean \
  --input "$ROOT/examples/sample_corpus.jsonl" \
  --out "$WORK/clean.jsonl" \
  --dedupe minhash --redact-pii --strip-html --normalize --drop-repeat-lines \
  --stats "$WORK/clean_report.json"

echo
echo "== 清洗结果预览 =="
head -n 5 "$WORK/clean.jsonl"

echo
echo "== 2. 生成云端训练脚本（不连云，仅生成）=="
node "$ROOT/tools/llm_cloud_provision/index.js" train-script \
  --framework deepspeed --gpus 8 --zero 3 \
  --model-config "$ROOT/configs/model_config_llama_1.3b.json" \
  --data-path /root/llm-training/data/clean.jsonl \
  --out "$WORK/train"
echo "生成的训练包: $(ls "$WORK/train")"

echo
echo "== 3. 推送训练（dry-run，打印完整命令序列）=="
node "$ROOT/tools/llm_cloud_provision/index.js" push \
  --local-dir "$WORK/train" --remote-dir /root/llm-training \
  --host 127.0.0.1 --port 22 --run run_train.sh --dry-run

echo
echo "== 4. 日志解析与图表（用模拟日志）=="
cat > "$WORK/train.log" <<'LOG'
{'loss': 9.832, 'learning_rate': 3.0e-04, 'epoch': 0.01, 'step': 20}
step: 40 | loss: 8.214 | LR: 3.0e-04 | tokens/s: 11200
{'loss': 7.511, 'learning_rate': 3.0e-04, 'epoch': 0.02, 'step': 60}
step: 80 | loss: 6.902 | LR: 2.9e-04 | tokens/s: 11800
{'loss': 6.331, 'learning_rate': 2.8e-04, 'epoch': 0.03, 'step': 100}
LOG
node "$ROOT/tools/llm_eval_monitor/index.js" parse --log "$WORK/train.log" --out "$WORK/metrics.json"
node "$ROOT/tools/llm_eval_monitor/index.js" chart --metrics "$WORK/metrics.json" --out "$WORK/loss_curve.svg"
ls -la "$WORK/loss_curve.svg"

echo
echo "== 5. 转换 + 模型卡 + 许可证（生成脚本，不执行）=="
node "$ROOT/tools/llm_open_source/index.js" convert --checkpoint /root/llm-training/ckpt/final --from hf --dtype bf16 --out "$WORK/model"
node "$ROOT/tools/llm_open_source/index.js" readme --model-name MyLLM-1.3B \
  --config "$ROOT/configs/model_config_llama_1.3b.json" --out "$WORK/model/README.md"
node "$ROOT/tools/llm_open_source/index.js" license --type apache-2.0 --out "$WORK/model/LICENSE"

echo
echo "== 6. 发布预览（dry-run）=="
node "$ROOT/tools/llm_open_source/index.js" publish --repo-id your-name/MyLLM-1.3B \
  --local-dir "$WORK/model" --dry-run

echo
echo "== 完成！产出目录: $WORK"
