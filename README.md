# 🏗️ dsh-llm-architect · DSH 大模型研发与云端调度插件集

> **让 DeepSeek Harness 拥有从零规划、数据锻造、云端调度训练、评测并开源一个世界级 LLM 的全套能力。**

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache--2.0-blue.svg)](./LICENSE)
[![Node: >=16](https://img.shields.io/badge/Node.js-%3E%3D16-green.svg)](https://nodejs.org/)
[![Platform: Win7+](https://img.shields.io/badge/Platform-Win7%20%7C%20Linux%20%7C%20macOS-lightgrey.svg)](#)
[![Zero Native Deps](https://img.shields.io/badge/Dependencies-Zero%20Native-success.svg)](#)

---

## 📐 设计哲学：控制面在本地，数据面在云端

本插件集为一个**低配宿主机**（Windows 7 / 8GB 内存 / 无 GPU）而设计。铁律如下：

| 层面 | 规则 |
| --- | --- |
| 🖥️ **控制面（本地）** | 只运行**纯 Node.js**（零 npm 依赖、零原生 C++ 扩展）。负责：生成脚本、发起 SSH/HTTPS 调度、清洗轻量数据、解析日志、渲染模型卡。 |
| ☁️ **数据面（云端）** | 所有 GPU 计算（训练、转换、评测）由**生成的 Python/Bash 脚本**在远程节点执行（AutoDL / AWS SageMaker / K8s / 阿里云 PAI）。 |
| 🚫 **绝对禁止** | 本地安装 CUDA、PyTorch 或任何需要编译原生扩展的库。 |
| ✅ **允许** | 本地可选安装纯 Python（仅用于"预览执行"生成的脚本）与 ssh 客户端（用于训练下发与日志拉取）。 |

```
                 ┌──────────────────────────────────────────────┐
                 │            Win7 控制面（8GB，无 GPU）          │
                 │  dsh-llm-architect (纯 Node.js，零依赖)       │
                 │  ┌────────────┐ ┌──────────┐ ┌────────────┐  │
                 │  │data_forge  │ │eval_mon  │ │open_source │  │
                 │  │(清洗/去重) │ │(解析/报告)│ │(卡片/发布)  │  │
                 │  └────────────┘ └──────────┘ └────────────┘  │
                 │            ┌──────────────────┐              │
                 │            │ cloud_provision  │              │
                 │            │  (脚本生成+SSH)  │              │
                 │            └────────┬─────────┘              │
                 └─────────────────────┼────────────────────────┘
                                       │ scp / ssh / HTTPS
        ┌──────────────────────────────┼──────────────────────────────┐
        │                              ▼                              │
        │   ┌───────────┐    ┌─────────────────┐    ┌─────────────┐   │
        │   │  AutoDL   │    │  AWS SageMaker  │    │   K8s/PAI   │   │
        │   │  H800×8   │    │  ml.p4d.24xlarge │    │  GPU 集群   │   │
        │   └─────┬─────┘    └────────┬────────┘    └──────┬──────┘   │
        │         │  DeepSpeed / Megatron-LM 训练 + lm-eval  │         │
        │         └──────────────────────────────────────────┘         │
        │                              │ checkpoints / logs / metrics   │
        └──────────────────────────────┴───────────────────────────────┘
                                       │
                                       ▼
                        HuggingFace Hub + GitHub 开源发布
```

---

## 📁 目录结构

```
dsh-llm-architect/
├── bin/dsh-llm.js                  # 总控入口：doctor / plan / list
├── lib/cli.js                      # 公共零依赖库（argv/模板/SSH/HTTP/哈希）
├── tools/
│   ├── llm_data_forge/             # ① 数据锻造与清洗
│   │   ├── index.js  manifest.json  README.md
│   │   ├── lib/      # clean.js dedupe.js download.js tokenizer.js
│   │   └── scripts/  # hf_download.py commoncrawl_download.sh
│   │                 # train_tokenizer.py forge_pipeline.sh
│   ├── llm_cloud_provision/        # ② 云端算力调度与训练下发
│   │   ├── index.js  manifest.json  README.md
│   │   ├── lib/render.js
│   │   └── scripts/  # provision_autodel.{sh,py} sagemaker_train.py
│   │                 # k8s_job.yaml k8s_mpijob.yaml
│   │                 # train_deepspeed.sh train_megatron.sh train.py
│   │                 # hostfile cloud_requirements.txt cluster_setup.sh
│   ├── llm_eval_monitor/           # ③ 训练监控与模型评测
│   │   ├── index.js  manifest.json  README.md
│   │   ├── lib/      # parse.js chart.js watch.js
│   │   └── scripts/  # run_lm_eval.sh eval_remote.sh parse_log.py
│   └── llm_open_source/            # ④ 模型转换与开源发布
│       ├── index.js  manifest.json  README.md
│       ├── lib/card.js
│       ├── licenses/ # apache-2.0.txt mit.txt llama3_notice.txt
│       └── scripts/  # convert_safetensors.py convert_zero3_safetensors.py
│                      # publish_hub.py verify_model.py
├── configs/
│   ├── ds_config_zero2.json        # DeepSpeed ZeRO-2 配置
│   ├── ds_config_zero3.json        # DeepSpeed ZeRO-3 配置
│   └── model_config_llama_1.3b.json # LLaMA 系 1.3B 参考模型配置
├── skills/                         # Agent 可加载的 Skill 文档（何时用哪个工具）
├── examples/sample_corpus.jsonl    # 快速体验用的脏语料（含重复/HTML/PII/垃圾文本）
├── dsh-plugin.json                 # 插件集清单（DSH 注册用）
├── package.json
└── .env.example                    # 环境变量模板
```

---

## 🚀 快速开始（Win7 五分钟体验）

### 0. 体检

```bash
git clone https://github.com/your-org/dsh-llm-architect.git
cd dsh-llm-architect
node bin/dsh-llm.js doctor     # 检查 Node / Python / ssh / .env / 工具完整性
cp .env.example .env           # 按需填入密钥（见下方"环境变量"）
```

### 1. 数据锻造：本地清洗示例语料（纯 Node，秒级完成）

```bash
node tools/llm_data_forge/index.js clean \
  --input examples/sample_corpus.jsonl \
  --out out/data/clean.jsonl \
  --dedupe minhash --redact-pii --strip-html --normalize --drop-repeat-lines \
  --stats out/data/clean_report.json
```

你会看到：重复文档被去重、HTML 被剥离、邮箱/手机号/身份证被 `[REDACTED]`、垃圾文本被过滤，并产出 `clean_report.json` 统计报告。

### 2. 一键生成云端训练脚本

```bash
node tools/llm_cloud_provision/index.js train-script \
  --framework deepspeed --gpus 8 --zero 3 \
  --model-config configs/model_config_llama_1.3b.json \
  --data-path /root/llm-training/data/clean.jsonl \
  --out out/train
```

`out/train/` 内会生成完整的可推送训练包：`run_train.sh`（总入口）、`train_deepspeed.sh`、`ds_config_zero3.json`、`train.py`、`hostfile`、`cloud_requirements.txt`、`runbook.md`。

### 3. 推送到远程 GPU 集群（一条命令）

```bash
node tools/llm_cloud_provision/index.js push \
  --local-dir out/train --remote-dir /root/llm-training \
  --host %REMOTE_HOST% --run run_train.sh
```

内部自动完成：打包 → scp 传输 → 远程依赖检查 → `nohup` 后台启动 → 回传首屏日志，并告诉你如何 `watch`。

### 4. 监控与评测

```bash
node tools/llm_eval_monitor/index.js watch --host %REMOTE_HOST% \
  --remote-log /root/llm-training/logs/train.log --local-dir logs/
node tools/llm_eval_monitor/index.js chart --metrics logs/metrics.json --out logs/loss_curve.svg
node tools/llm_eval_monitor/index.js eval --checkpoint /root/llm-training/ckpt/final \
  --tasks mmlu,ceval,hellaswag --host %REMOTE_HOST% --out out/eval
```

### 5. 转换、写卡、发布

```bash
node tools/llm_open_source/index.js convert --checkpoint /root/llm-training/ckpt/final --from hf --dtype bf16 --out out/model
node tools/llm_open_source/index.js readme --model-name MyLLM-1.3B --benchmarks out/eval/results.json --config configs/model_config_llama_1.3b.json --out out/model/README.md
node tools/llm_open_source/index.js license --type apache-2.0 --out out/model/LICENSE
node tools/llm_open_source/index.js publish --repo-id your-name/MyLLM-1.3B --local-dir out/model --dry-run   # 先预览
```

**或者交给 Agent 自动完成**：`node bin/dsh-llm.js plan` 打印完整 7 阶段蓝图，`skills/` 下的四份 Skill 文档告诉 Agent 何时、按什么顺序调用哪个工具。

---

## 🧰 四个工具的完整命令参考

### ① llm_data_forge（数据锻造）

| 子命令 | 作用 | 关键 flags |
| --- | --- | --- |
| `download` | 生成数据集下载脚本（HF / Wikipedia / Common Crawl / 自定义 URL） | `--source --dataset-id --split --lang --limit-docs` |
| `clean` | **本地纯 Node** 流式清洗：去 HTML、NFKC 规范化、去重复行、质量过滤、语种过滤、**PII 脱敏**、exact/minhash 去重 | `--input --out --min-chars --max-chars --lang --strip-html --normalize --dedupe --redact-pii --drop-repeat-lines --quality-filter --stats` |
| `dedupe` | 独立去重（exact SHA-1 或 MinHash LSH，默认 16×8 桶，阈值≈0.66） | `--input --out --mode --shingles --bands --rows` |
| `tokenizer-config` | 生成云端 Tokenizer 训练配置 + `train_tokenizer.py`（BPE/Unigram/WordPiece） | `--out --vocab-size --model --langs --special-tokens --corpus` |
| `forge` | 按 json 配置编排：下载→清洗→分片→合并→Tokenizer | `--config` |

清洗统计报告 `clean_report.json` 含：输入/输出文档数、按原因分类的丢片数（length/lang/dup/quality）、字节数、去重碰撞数、耗时。

### ② llm_cloud_provision（云端算力调度）

| 子命令 | 作用 |
| --- | --- |
| `autodel` | 生成 AutoDL OpenAPI 开通脚本（`.sh` curl 版 + `.py` requests 版），`--gpu H800 --image pytorch2.3-cuda12.1` |
| `sagemaker` | 生成 AWS SageMaker `boto3` 训练脚本（Estimator + S3 上传 + fit） |
| `k8s` | 生成 K8s `Job`（DeepSpeed）或 `MPIJob`（Megatron）YAML，含 `nvidia.com/gpu` 资源声明 |
| `train-script` | 生成 DeepSpeed（`deepspeed --num_gpus 8 --hostfile … train.py`）或 Megatron-LM（`torchrun` 全套并行参数）启动脚本 + `ds_config_zero{2,3}.json` + 参考预训练 `train.py` |
| `push` | **一条命令推送训练**：打包→scp→远程装依赖→`nohup` 启动→回传首屏日志。优先读 `.env` 的 `REMOTE_*` |
| `status` | 远程 `nvidia-smi` + 磁盘 + 负载巡检 |
| `cluster-setup` | 远程执行环境检查（Python/pip/CUDA/磁盘） |

所有涉及 SSH/网络的子命令均支持 `--dry-run`。

### ③ llm_eval_monitor（监控与评测）

| 子命令 | 作用 |
| --- | --- |
| `tail-log` | SSH 单次拉取远程训练日志 |
| `watch` | 轮询监控：增量拉取（不断点续传 offset）、实时解析、本地留档、检测到 `Traceback/NaN/OOM/training complete` 自动告警退出 |
| `parse` | 日志解析为 `metrics.json`，**自动识别 HF Trainer / DeepSpeed / Megatron / 通用** 四种日志格式 |
| `chart` | 纯字符串生成 **SVG** Loss + tokens/s 双曲线（无任何原生绘图依赖），附 ASCII sparkline 与 Markdown 表 |
| `eval` | 生成并执行 lm-evaluation-harness 评测（`--tasks mmlu,ceval,hellaswag`），支持远程执行 + 结果回传 |
| `report` | 汇总训练指标与评测分数，生成带自动结论的 Markdown 报告 |

### ④ llm_open_source（开源发布）

| 子命令 | 作用 |
| --- | --- |
| `convert` | 生成 PyTorch 权重 → **Safetensors** 转换脚本（分片 + `index.json` + dtype 转换），支持从 HF checkpoint 或 DeepSpeed ZeRO-3 checkpoint 出发 |
| `readme` | 生成漂亮的模型卡：徽章、模型详情表、训练数据摘要、Benchmark 表、transformers/vLLM/llama.cpp 使用示例、许可证、BibTeX |
| `license` | 写入许可证文件（Apache-2.0 / MIT / Llama3 声明模板） |
| `publish` | 生成 HuggingFace Hub 发布脚本（`create_repo` + `upload_folder`，传前校验齐全），`--execute` 本地直跑或 `--dry-run` 预览 |
| `release` | 生成 GitHub release 命令（git tag / gh release，只打印不执行） |

---

## 🔧 云平台配置指南

### AutoDL（国内推荐）

1. 注册 [autodl.com](https://www.autodl.com)，控制台 → API 文档获取 `AUTODL_TOKEN`。
2. `.env` 填 `AUTODL_TOKEN` 与 `AUTODL_ACCOUNT`。
3. 生成开通脚本并执行（或控制台手动开通后只做 SSH 下发）：
   ```bash
   node tools/llm_cloud_provision/index.js autodel --gpu H800 --image pytorch2.3-cuda12.1 --out out/cloud
   bash out/cloud/provision_autodel.sh
   ```
4. 把实例的 SSH 信息填入 `.env`（`REMOTE_HOST/REMOTE_USER/SSH_KEY_PATH`），即可用 `push` 一键下发训练。

### AWS SageMaker

1. IAM 创建执行角色，记下 `AWS_SAGEMAKER_ROLE_ARN`（需 S3/ECR 权限）。
2. `.env` 填 `AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION`。
3. 生成训练脚本（可选自定义 ECR 镜像 `AWS_ECR_IMAGE`），生成的 `sagemaker_train.py` 会自动上传代码到 S3 并 `fit`。

### K8s 集群（自建/公有云）

```bash
node tools/llm_cloud_provision/index.js k8s --framework megatron --gpus 16 --image registry.example.com/llm:latest --out out/cloud
kubectl apply -f out/cloud/k8s_mpijob.yaml
```

### 阿里云 PAI

`.env` 填 `ALIYUN_AK_ID / ALIYUN_AK_SECRET / ALIYUN_PAI_REGION`，使用 `train-script` 生成的脚本配合 PAI 的 DLC/DSW 执行（脚本与平台无关）。

---

## ⚙️ 环境变量参考（`.env`）

| 变量 | 用途 | 必要性 |
| --- | --- | --- |
| `HF_TOKEN` | HuggingFace 数据下载 / 模型发布 | 发布时必填 |
| `HF_USER` | 发布仓库所有者 | 发布时必填 |
| `AUTODL_TOKEN` / `AUTODL_ACCOUNT` | AutoDL API 开通实例 | 仅 autodel 子命令 |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | SageMaker | 仅 sagemaker 子命令 |
| `AWS_SAGEMAKER_ROLE_ARN` / `AWS_ECR_IMAGE` | SageMaker 角色与镜像 | sagemaker 推荐 |
| `SSH_KEY_PATH` / `REMOTE_HOST` / `REMOTE_USER` / `REMOTE_PORT` | 训练下发与日志拉取 | push/watch/eval 必填 |
| `REMOTE_WORKDIR` | 远程工作目录 | push 默认值 |
| `WANDB_TOKEN` | 实验追踪（云端脚本可选读取） | 可选 |
| `GH_TOKEN` | GitHub release | 可选 |

---

## 🧠 训练框架说明

- **DeepSpeed**：`train-script --framework deepspeed --zero 3` 生成 ZeRO-3 配置（支持 `gather_16bit_weights_on_model_save`，适合 8×H800 训练 1.3B~13B 模型）。`zero 2` 显存占用更均衡，训练更快。
- **Megatron-LM**：`train-script --framework megatron` 生成含 `tensor-model-parallel-size / pipeline-model-parallel-size / data-parallel-size` 的完整启动脚本，配合 `k8s --framework megatron` 的 MPIJob 使用。
- 参考预训练 `train.py` 直接读取 `clean.jsonl`，按 `model-config` 从零初始化 LLaMA 系模型，`Trainer` + DeepSpeed plugin，按 `--save-steps` 保存 checkpoint。

---

## 🏆 评测说明

评测基于 [EleutherAI lm-evaluation-harness](https://github.com/EleutherAI/lm-evaluation-harness)：

```bash
# 中文模型常用任务
--tasks ceval,cmnli,clue,lcsts
# 英文模型常用任务
--tasks mmlu,hellaswag,arc_challenge,winogrande,truthfulqa,gsm8k
```

`eval` 子命令把任务串传给生成的 `run_lm_eval.sh`，在云端 GPU 节点执行后回传 `results.json`，`report` 会自动汇总进报告，`readme` 会自动渲染进模型卡 Benchmark 表。

---

## 🪟 Win7 特别注意事项

1. **Node.js**：安装 16.x 及以上的 Windows 版本（推荐 18 LTS）。本插件集**零 npm 依赖**，`clone` 后即可运行，无需 `npm install`。
2. **SSH 客户端**：Win7 无内置 OpenSSH，请安装 Git for Windows（自带 `ssh.exe`/`scp.exe`）或 Win32 OpenSSH。工具自动从 PATH 查找 `ssh`。
3. **tar**：Win7 无 tar，`push` 会自动回退为 `scp -r` 全量传输（云端目录建议先清空再推）。
4. **路径与空格**：所有工具使用 `path.resolve`，兼容路径含空格；建议 nonetheless 把仓库放在 `D:\Code\` 这类无空格短路径下。
5. **内存**：本地清洗为**流式逐行**处理，8GB 内存可处理 GB 级 jsonl；MinHash 去重做单遍 LSH，内存占用约为 `文档数 × 1KB`，超大语料请用 `forge` 生成云端分片流水线。
6. **代理**：若 Win7 需代理访问 HuggingFace，设置 `HTTP_PROXY/HTTPS_PROXY` 环境变量，或在 HF 端使用 `HF_ENDPOINT=https://hf-mirror.com` 镜像。
7. **安全**：`.env` 已在 `.gitignore` 中，密钥永不入库；`publish` 默认 `--dry-run`，确认后才真传。

---

## 🤖 作为 DSH 插件被 Agent 调用

- `dsh-plugin.json` 声明了 4 个工具与 4 份 Skill，`manifest.json` 提供每个工具的 `inputSchema`（JSON Schema）。
- 每个工具除 CLI 外还支持 **MCP 风格 JSON 调用**：
  ```bash
  node tools/llm_data_forge/index.js --json '{"subcommand":"clean","args":{"input":"examples/sample_corpus.jsonl","out":"out/c.jsonl"}}'
  ```
  返回单行 `{"ok":true,"data":{...}}`，便于 Agent 程序化解析。
- Skill 文档（`skills/skill_*.md`）告诉 Agent 各阶段的决策点与升级路径。

---

## 🗺️ 完整蓝图

```bash
node bin/dsh-llm.js plan
```

```
阶段 0 · 环境体检        → doctor + .env
阶段 1 · 数据锻造        → download / clean / tokenizer-config
阶段 2 · 云端算力与脚本  → train-script / autodel / sagemaker / k8s
阶段 3 · 一键推送训练    → push（一条命令）
阶段 4 · 监控与评测      → watch / chart / eval
阶段 5 · 评测报告        → report
阶段 6 · 转换与开源发布  → convert / readme / license / publish
阶段 7 · GitHub 开源     → git tag / gh release
```

---

## 📜 许可证

[Apache License 2.0](./LICENSE) — 生成物（模型、数据、脚本）的许可证由你在发布时通过 `license` 子命令自行选择。

## 🤝 贡献

欢迎 Issue / PR。开发约定：

- 零依赖：只用 Node 内置模块；新增云端脚本一律放对应工具的 `scripts/` 模板目录。
- 所有会修改远端/网络的子命令必须支持 `--dry-run`。
- 提交信息遵循 `<type>: <desc>`（如 `feat: …` / `fix: …`）。
