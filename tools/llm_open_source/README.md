# llm_open_source · 模型转换与开源发布

把云端训练出的权重变成"可发布的产品"：Safetensors 转换（含 ZeRO-3 分片合并）、
模型卡 README、LICENSE、一键推送到 HuggingFace Hub。

## 架构

```
远端 GPU 节点（转换/校验/发布都在这里）      Win7 控制面（本工具）
  convert_safetensors.py  ◄──ssh 脚本──    convert
  convert_zero3_safetensors.py              readme（模型卡）
  verify_model.py                           license
  publish_hub.py ──推送──► HF Hub           publish / release（一条龙）
```

## 快速开始

```bash
# 一条龙（dry-run 先看命令）
node index.js release --src /root/llm-training/ckpt/step-3000 \
  --name dsh-llm-1.3b --params 1300000000 \
  --metrics metrics.json --eval out/eval/eval_results.json \
  --repo dsh-architect/dsh-llm-1.3b --dry-run

# 分步
node index.js license --kind apache-2.0 --holder "DSH Agent"
node index.js readme --name dsh-llm-1.3b --params 1300000000 --last-loss 0.27
node index.js convert --from zero3 --src /root/llm-training/ckpt/step-3000
node index.js publish --repo dsh-architect/dsh-llm-1.3b
```

## 子命令

| 子命令 | 作用 |
|---|---|
| `convert --from hf\|zero3` | 生成 Safetensors 转换脚本；`--from zero3` 用于 DeepSpeed ZeRO-3 分片合并 |
| `readme` | 模型卡：徽章、详情表、训练摘要、Benchmark 表、Python 使用示例、BibTeX |
| `license` | 生成 LICENSE（apache-2.0 / mit 自动填年份与持有人；llama3 为声明文件） |
| `publish` | 远端执行 publish_hub.py → HuggingFace Hub |
| `release` | 上面四步的组合 |

## 模型卡包含

- 徽章（License / Training 框架 / 参数量 / dtype）
- Model Details 表（架构、hidden/layers/heads、vocab、max_pos、dtype）
- Training Summary（steps、final loss、tokenizer、dataset）
- Benchmark Results（从 `llm_eval_monitor` 的 eval_results.json 自动填表）
- Usage 代码块（transformers 加载 + 生成）
- 训练流水线 ASCII 图、License、BibTeX 引用块

## 注意事项

- `convert`/`publish` 需要 `.env` 中的 `REMOTE_HOST`/`REMOTE_USER`/`SSH_KEY_PATH`（无配置时退化为"生成脚本 + 打印命令"）。
- `publish` 需要 `HF_TOKEN`；未设置会告警。
- ZeRO-3 合并依赖 `deepspeed.utils.zero_to_fp32`，需在训练同一节点或装了同版本 deepspeed 的节点执行。

## 文件结构

```
index.js                        # CLI 入口（--json MCP 模式）
manifest.json                   # DSH 工具清单
lib/card.js                     # 模型卡模板
scripts/convert_safetensors.py  # HF ckpt → Safetensors（云端执行）
scripts/convert_zero3_safetensors.py  # ZeRO-3 分片合并（云端执行）
scripts/verify_model.py         # 发布前自检（前向 + config 校验）
scripts/publish_hub.py          # HF Hub 上传
licenses/                       # apache-2.0.txt / mit.txt / llama3_notice.txt
```
