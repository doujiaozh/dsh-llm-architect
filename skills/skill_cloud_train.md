---
name: skill_cloud_train
category: llm-pipeline
tool: llm_cloud_provision
---

# Skill: 云端训练下发（llm_cloud_provision）

## 何时使用
当任务涉及：准备云端 GPU 环境（AutoDL / AWS SageMaker / K8s）、生成 DeepSpeed/Megatron 分布式训练脚本、把训练任务推送到远程集群时。

## 核心原则
- **控制面在本地**：本地只生成脚本、发起 SSH/HTTPS 调度。
- **数据面在云端**：训练真正运行在远程 GPU 节点上（deepspeed --num_gpus 8 …）。

## 标准流程
1. 生成训练启动脚本（DeepSpeed 或 Megatron-LM）：
   `node tools/llm_cloud_provision/index.js train-script --framework deepspeed --gpus 8 --zero 3 --model-config configs/model_config_llama_1.3b.json --data-path /root/llm-training/data/clean.jsonl --out out/train`
2. 生成云平台开通脚本：
   - AutoDL: `autodel --gpu H800 --image pytorch2.3-cuda12.1 --out out/cloud`
   - SageMaker: `sagemaker --instance-type ml.p4d.24xlarge --out out/cloud`
   - K8s: `k8s --framework megatron --gpus 16 --image xxx --out out/cloud`
3. **一条命令推送训练**：
   `node tools/llm_cloud_provision/index.js push --local-dir out/train --remote-dir /root/llm-training --host <ip> --run run_train.sh`
   内部完成：tar 打包 → scp 传输 → 远程依赖检查 → nohup 启动 → 回传首屏日志。
4. 状态巡检：`status --host <ip>`（nvidia-smi / 磁盘 / 进程）。

## 输出物
- `train_deepspeed.sh` / `train_megatron.sh` / `train.py`（参考预训练实现）
- `ds_config_zero2.json` 或 `ds_config_zero3.json`
- `hostfile`、`cloud_requirements.txt`、`provision_*.sh|py`、`k8s-*.yaml`
- 推送后输出远程日志查看命令与 `train.log` 路径

## 升级路径
- 多机多卡 → 编辑 `hostfile` 后用同一 push 命令（DeepSpeed 自动用 hostfile 做 SSH 多机启动）。
- 显存不足 → 重新生成 `--zero 3`，或降低 `--batch-size` / 开启 activation checkpointing。
