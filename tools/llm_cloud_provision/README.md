# llm_cloud_provision · 云端算力调度与训练下发

本地控制面的"指挥中心"：生成各云平台的部署脚本、DeepSpeed/Megatron 分布式训练启动脚本，
并通过 SSH 一条命令把训练任务推送到远程 GPU 集群。**本地从不安装 CUDA/PyTorch**。

## 架构

```
Win7 控制面（本工具）              远程数据面（GPU 集群）
  train-script ──生成──► train_deepspeed.sh
  push ────scp/rsync──► /root/llm-training/
                           └─ nohup bash train_deepspeed.sh > run.log 2>&1 &
  status ─────ssh────► nvidia-smi / df / tail run.log
```

## 快速开始

```bash
# 1. 生成 DeepSpeed 训练脚本（8 卡，ZeRO-3）
node index.js train-script --framework deepspeed --gpus 8 --zero 3

# 2. 配置 .env（REMOTE_HOST/REMOTE_USER/SSH_KEY_PATH/REMOTE_PORT/REMOTE_WORKDIR）

# 3. 一条命令推送并启动
node index.js push --local out/cloud/train --start "bash train_deepspeed.sh"

# 4. 看状态
node index.js status
# 或持续监控：../llm_eval_monitor/index.js tail-log
```

## 子命令

| 子命令 | 用途 |
|---|---|
| `autodel` | AutoDL 环境初始化包：`provision_autodel.sh`（环境/依赖/GPU 自检）+ `provision_autodel.py`（OpenAPI 租管实例） |
| `sagemaker` | AWS SageMaker 提交脚本：`sagemaker_train.py`（boto3 提交）+ `submit.sh` |
| `k8s` | K8s `job.yaml`（单机）与 `mpijob.yaml`（MPI Operator 多机）+ `apply.sh` |
| `train-script` | DeepSpeed/Megatron 启动脚本 + `train.py` + `hostfile` + `ds_config` |
| `push` | scp/tar 推送 + 远程 nohup 启动（支持 `--dry-run`、`--no-exec`） |
| `status` | ssh 查看 GPU 占用、磁盘、checkpoint、run.log 尾部 |
| `cluster-setup` | 多机集群一次性环境准备（rsync 分发 + 各节点初始化 + 免密检查） |

## 远程连接配置

读 `.env`（优先级低于 CLI flags）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `REMOTE_HOST` | GPU 节点 IP | 必填 |
| `REMOTE_USER` | ssh 用户 | `root` |
| `REMOTE_PORT` | ssh 端口 | `22` |
| `SSH_KEY_PATH` | 私钥路径 | `C:\Users\you\.ssh\id_rsa` |
| `REMOTE_WORKDIR` | 远端工作目录 | `/root/llm-training` |

ssh 固定参数：`StrictHostKeyChecking=no ConnectTimeout=15 ServerAliveInterval=30`。

## 训练脚本参数（train-script）

- `--framework deepspeed|megatron`：DeepSpeed 适合 HF Trainer 路线；Megatron-LM 适合千卡级预训练（TP+PP+DP）。
- `--zero 1|2|3`：自动选用项目内置 `configs/ds_config_zero{1,2,3}.json`，也可 `--ds-config` 自定义。
- `--hosts 10.0.0.1,10.0.0.2`：生成多机 `hostfile`，`--nodes` 需与之匹配。
- Megatron：`--tp`（张量并行）、`--pp`（流水并行），自动推算 DP。

## push 的两种传输模式

- 默认 `scp -r`：简单直接，适合少文件。
- `--tar`：本地 `tar -czf -` 管道经 ssh 远端解包，大量小文件时显著更快（Win7 无 tar 时自动回退 scp）。
- 推送后默认 `nohup` 后台启动并写 `run.log`；`--no-exec` 只传不启动。

## 文件结构

```
index.js                # CLI 入口（--json MCP 模式）
manifest.json           # DSH 工具清单
lib/render.js           # 各平台脚本渲染器
scripts/provision_autodel.sh/.py   # AutoDL 环境/API
scripts/sagemaker_train.py         # SageMaker 提交
scripts/k8s_job.yaml / k8s_mpijob.yaml
scripts/train_deepspeed.sh / train_megatron.sh / train.py / hostfile
scripts/cloud_requirements.txt     # 云端 Python 依赖
scripts/cluster_setup.sh           # 多机集群准备
```
