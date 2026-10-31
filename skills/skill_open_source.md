---
name: skill_open_source
category: llm-pipeline
tool: llm_open_source
---

# Skill: 开源发布（llm_open_source）

## 何时使用
当任务涉及：把训练好的 Checkpoint 转成 Safetensors、生成模型卡 README、选择许可证、一键发布到 HuggingFace Hub 时。

## 核心原则
- 权重转换（PyTorch → Safetensors）在**云端节点**执行（torch/safetensors 在那边），本地只生成并校验脚本。
- 发布前必须完成：转换成功 + 模型卡 + 许可证 + 评测结果。

## 标准流程
1. 生成转换脚本（云端执行）：
   `node tools/llm_open_source/index.js convert --checkpoint /root/llm-training/ckpt/final --dtype bf16 --from hf --out out/model`
   （DeepSpeed ZeRO-3 Checkpoint 用 `--from zero3`）
2. 生成模型卡：
   `readme --model-name MyLLM-1.3B --base-model - --benchmarks out/eval/results.json --config configs/model_config_llama_1.3b.json --out out/model/README.md`
3. 写许可证：`license --type apache-2.0 --out out/model/LICENSE`
4. 一键发布：`publish --repo-id your-name/MyLLM-1.3B --local-dir out/model --dry-run` 先预览，确认后去掉 `--dry-run`（或加 `--execute` 本地直接跑 `publish_hub.py`）。
5. GitHub 发布：`release --tag v1.0 --repo-url https://github.com/you/MyLLM` 打印 gh/git 命令。

## 输出物
- `convert_safetensors.py`（分片 + index.json + dtype 转换）
- 完整 HuggingFace 模型目录：`config.json` / `model-*.safetensors` / `model.safetensors.index.json` / `tokenizer.*` / `README.md` / `LICENSE`
- `publish_hub.py`（create_repo + upload_folder，支持断点续传与大文件）

## 检查清单
- [ ] 评测分数已写进模型卡的 Benchmark 表
- [ ] 训练数据来源已在模型卡声明
- [ ] 许可证与数据集compatibility（e.g. Llama 系衍生模型注意 llama 协议）
- [ ] `publish --dry-run` 通过后再真传
