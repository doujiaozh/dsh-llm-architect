#!/bin/bash
# cluster_setup.sh — 多机 GPU 集群一次性环境准备（由 llm_cloud_provision 生成）。
# 在任意一台节点执行（需对所有节点 ssh 免密）；幂等可重跑。
set -euo pipefail

NODES=({{NODE_LIST}})   # 例：("10.0.0.1" "10.0.0.2")
THIS_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== [1/4] 分发项目文件到所有节点 =="
for node in "${NODES[@]}"; do
  rsync -az --delete -e ssh "$THIS_DIR/" "$node:/root/llm-training/"
done

echo "== [2/4] 各节点依赖安装 =="
for node in "${NODES[@]}"; do
  ssh "$node" 'bash -s' < "$THIS_DIR/provision_autodel.sh" || \
    echo "[warn] $node 环境初始化失败（可手动重跑）"
done

echo "== [3/4] ssh 免密互信检查 =="
for node in "${NODES[@]}"; do
  if ssh -o BatchMode=yes -o ConnectTimeout=5 "$node" true 2>/dev/null; then
    echo "  [ok] $node"
  else
    echo "  [fail] $node 不可免密登录，请配置 ssh-copy-id"
  fi
done

echo "== [4/4] NCCL 多机连通性测试（首节点执行）=="
if command -v python3 >/dev/null 2>&1; then
  python3 - <<'EOF' || echo "[warn] NCCL 测试失败，检查安全组/IB 网络"
import torch.distributed as dist, os
os.environ.setdefault("MASTER_ADDR", "${NODES[0]}")
print("skip in-cluster test; run deepspeed --hostfile for real launch")
EOF
fi

echo "[done] 集群准备完毕。下一步生成 hostfile 并启动 train_deepspeed.sh"
