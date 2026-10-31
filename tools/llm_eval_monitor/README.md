# llm_eval_monitor · 训练监控与模型评测

本地控制面的"哨兵"：通过 SSH/Webhook 拉取云端训练日志，解析 loss 曲线、learning rate、吞吐量（tokens/s），
命中异常模式（OOM/发散/NCCL 错误）立即告警；评测阶段自动生成 lm-evaluation-harness 脚本并远程执行。

## 架构

```
远端 GPU 节点                        Win7 控制面（本工具）
  run.log ──ssh tail──►  watch ──增量解析──► 指标点
                          parse ──全量解析──► metrics.json
                          chart ──纯字符串──► loss_curve.svg / throughput.svg
                          eval  ──scp 脚本+ssh 执行+拉回──► eval_results.json
                          report ──────────► REPORT.md
```

## 快速开始

```bash
# 1. 持续监控远端训练（15s 轮询，异常即告警退出）
node index.js watch --remote /root/llm-training/train/run.log --interval 15

# 2. 全量解析 + 出图
node index.js parse run.log --out metrics.json
node index.js chart --metrics metrics.json

# 3. 评测 checkpoint
node index.js eval --model /root/llm-training/ckpt/step-2000 --tasks mmlu,gsm8k

# 4. 汇总报告
node index.js report --metrics metrics.json --eval out/eval/eval_results.json
```

## 支持的日志格式

| 格式 | 识别示例 |
|---|---|
| HF Trainer JSON | `{'loss': 1.23, 'learning_rate': 3.45e-05, 'epoch': 0.5, 'grad_norm': 0.7, 'step': 100}` |
| DeepSpeed | `step:10, loss:1.23, lr:3.45e-05, tokens/s: 12500` |
| Megatron-LM | `iteration 100/1000 | lm loss: 1.2345 | lr: 3.45E-05 | ...` |
| 通用 | 任何含 `loss=` / `loss:` 的行 |

## 异常告警模式（watch）

- CUDA OOM（显存不足）
- loss nan/inf（发散）
- Python Traceback / RuntimeError
- NCCL / 网络通信错误
- 磁盘满 / 系统 OOM Killer

watch 会在增量日志中命中以上模式时打印 `[ALERT]`、写入 `.dsh-eval/watch_state.json` 并立即退出，
便于上层 Agent（或 webhook）直接对接钉钉/飞书告警。

## 评测任务

默认任务集：`mmlu, hellaswag, arc_challenge, arc_easy, winogrande, piqa, truthfulqa_mc2, gsm8k`。
远端脚本会创建独立 venv（`.venv-eval`）安装 `lm-eval>=0.4,<0.5`，避免污染训练环境。
可用 `--tasks` 自定义，或设置远端环境变量 `LM_EVAL_TASKS/LM_EVAL_FEWSHOT/LM_EVAL_BATCH`。

## 文件结构

```
index.js                    # CLI 入口（--json MCP 模式）
manifest.json               # DSH 工具清单
lib/parse.js                # 四格式日志解析（纯字符串）
lib/chart.js                # 纯字符串 SVG 生成
lib/watch.js                # 增量 tail + 告警
scripts/run_lm_eval.sh      # lm-eval-harness 评测脚本（远端执行）
scripts/eval_remote.sh      # 本地一键：上传→评测→拉回
scripts/parse_log.py        # Python 版解析器（云端流水线可用）
```
