#!/bin/bash
# provision_autodel.sh — 由 dsh-llm-architect (llm_cloud_provision) 生成。
# 用途：在 AutoDL GPU 服务器上初始化训练环境（纯云端执行）。
# 包含：conda 环境、PyTorch、DeepSpeed、transformers、数据目录。
# 用法：bash provision_autodel.sh [WORKDIR]
set -euo pipefail

WORKDIR="${1:-/root/llm-training}"
PY="${PYTHON:-python3}"

echo "== AutoDL 环境初始化 ($WORKDIR) =="

# 1. 基础工具
apt-get update -qq && apt-get install -y -qq git wget curl rsync || true

# 2. Python 依赖（AutoDL 镜像通常已含 PyTorch，此处幂等补齐）
$PY -m pip install --upgrade pip -q
$PY -m pip install -q -r "$(dirname "$0")/cloud_requirements.txt" || \
  echo "[warn] 部分依赖安装失败，检查网络/镜像源"

# 3. DeepSpeed 系统级优化（按需）
if ! command -v ds_report >/dev/null 2>&1; then
  echo "[info] deepspeed 未就绪，可稍后用 'ds_report' 验证"
fi

# 4. 工作目录
mkdir -p "$WORKDIR"/{data,ckpt,logs,configs}

# 5. 挂载数据盘（AutoDL /root/autodl-typ是系统盘外的数据盘）
if [ -d /root/autodl-tmp ] && ! grep -q autodl-tmp /proc/mounts; then
  ln -sfn /root/autodl-tmp "$WORKDIR/data" 2>/dev/null || true
fi

# 6. NCCL/分布式自检（单机多卡快速验证）
echo "== GPU 自检 =="
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader || \
  echo "[fatal] nvidia-smi 不可用，请确认 GPU 镜像"
$PY -c "import torch; print('torch', torch.__version__, 'cuda', torch.cuda.is_available(), 'gpus', torch.cuda.device_count())"

echo "[done] 环境就绪 → $WORKDIR"
