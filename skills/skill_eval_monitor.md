---
name: skill_eval_monitor
category: llm-pipeline
tool: llm_eval_monitor
---

# Skill: 训练监控与评测（llm_eval_monitor）

## 何时使用
当任务涉及：拉取远程训练日志、解析 Loss/Learning Rate/吞吐量、生成曲线与报告、对 Checkpoint 跑开源评测（lm-evaluation-harness）时。

## 核心原则
- 监控通过 SSH 拉取或本地日志文件解析，**不在本地做任何 GPU 计算**。
- 评测脚本生成后在**云端 GPU 节点**执行 lm-eval-harness，本地只汇总结果。

## 标准流程
1. 单次拉取日志：`tail-log --host <ip> --remote-log /root/llm-training/logs/train.log`
2. 持续监控（轮询 + 增量解析 + 本地留档）：
   `node tools/llm_eval_monitor/index.js watch --host <ip> --remote-log .../train.log --local-dir logs/ --interval 60`
3. 解析指标（兼容 HF Trainer / DeepSpeed / Megatron 三种日志格式，自动识别）：
   `parse --log logs/train.log --out logs/metrics.json`
4. 生成可视化：`chart --metrics logs/metrics.json --out logs/loss_curve.svg`
   → 纯字符串模板生成 SVG，无任何原生绘图依赖；附带 ASCII 预览与 Markdown 表。
5. 跑分：`eval --checkpoint /root/llm-training/ckpt/final --tasks mmlu,ceval,hellaswag --host <ip> --out out/eval`
6. 汇总：`report --metrics logs/metrics.json --eval out/eval/results.json --out logs/report.md`

## 输出物
- `metrics.json`：`{series: [{step, loss, lr, tokens_per_sec, ts}], summary: {min_loss, last_loss, total_tokens, avg_tokens_per_sec}}`
- `loss_curve.svg`：Loss 与 tokens/s 双曲线 SVG
- `results.json`（lm-eval-harness 格式汇总）+ `report.md`

## 排障信号
- Loss 飞天/NaN → watch 会在日志出现 `Traceback|NaN|OOM` 时立即告警并停止。
- tokens/s 远低于预期 → 检查 `status`（GPU 利用率）、dataloader num_workers、flash attention 开关。
