#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
train.py — 通用 HuggingFace Trainer + DeepSpeed 训练入口（由 llm_cloud_provision 生成）。
在云端 GPU 节点执行；支持 ZeRO-2/3、bf16、梯度检查点、jsonl 语料。
"""

import argparse
import json
import os
import sys


def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--model_config", required=True, help="模型结构 json（from_config 用）")
    p.add_argument("--tokenizer_dir", required=True)
    p.add_argument("--data_dir", required=True, help="含 train.jsonl（可选 eval.jsonl）")
    p.add_argument("--output_dir", default="./ckpt")
    p.add_argument("--deepspeed", default=None, help="DeepSpeed 配置 json")
    p.add_argument("--per_device_batch", type=int, default=4)
    p.add_argument("--grad_accum", type=int, default=8)
    p.add_argument("--lr", type=float, default=3e-4)
    p.add_argument("--min_lr_ratio", type=float, default=0.1)
    p.add_argument("--warmup_ratio", type=float, default=0.03)
    p.add_argument("--epochs", type=float, default=1.0)
    p.add_argument("--max_steps", type=int, default=-1)
    p.add_argument("--max_seq_len", type=int, default=4096)
    p.add_argument("--save_steps", type=int, default=1000)
    p.add_argument("--log_steps", type=int, default=10)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--init_from", default=None, help="可选：从已有 ckpt 继续训练")
    return p.parse_args()


def main():
    args = parse_args()
    try:
        import torch
        from transformers import (
            AutoConfig, AutoModelForCausalLM, AutoTokenizer, Trainer,
            TrainingArguments, default_data_collator,
        )
        from datasets import load_dataset
    except ImportError as e:
        print(f"[fatal] 依赖缺失: {e}", file=sys.stderr)
        sys.exit(2)

    torch.manual_seed(args.seed)
    os.makedirs(args.output_dir, exist_ok=True)

    # 1. 模型：从结构 config 从零初始化，或从 ckpt 恢复
    if args.init_from:
        print(f"[info] 从 {args.init_from} 恢复")
        model = AutoModelForCausalLM.from_pretrained(
            args.init_from, torch_dtype=torch.bfloat16, trust_remote_code=True)
    else:
        cfg = AutoConfig.from_pretrained(args.model_config, trust_remote_code=True)
        with open(args.model_config, "r", encoding="utf-8") as f:
            raw = json.load(f)
        dtype = raw.get("torch_dtype", "bfloat16")
        cfg.torch_dtype = getattr(torch, dtype) if isinstance(dtype, str) else dtype
        model = AutoModelForCausalLM.from_config(cfg)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[info] model params: {n_params/1e9:.2f}B")

    tokenizer = AutoTokenizer.from_pretrained(args.tokenizer_dir, trust_remote_code=True)
    if tokenizer.pad_token is None:
        tokenizer.pad_token = tokenizer.eos_token

    # 2. 数据：jsonl → tokenize → group 到固定长度
    def tok(batch):
        return tokenizer(
            batch["text"], truncation=True, max_length=args.max_seq_len,
            add_special_tokens=True,
        )

    data_files = {"train": os.path.join(args.data_dir, "train.jsonl")}
    if os.path.exists(os.path.join(args.data_dir, "eval.jsonl")):
        data_files["validation"] = os.path.join(args.data_dir, "eval.jsonl")
    ds = load_dataset("json", data_files=data_files)
    ds = ds.map(tok, batched=True, num_proc=None, remove_columns=ds["train"].column_names)

    # 3. 训练参数
    targs = TrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=args.per_device_batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine_with_min_lr",
        lr_scheduler_kwargs={"min_lr_rate": args.min_lr_ratio},
        warmup_ratio=args.warmup_ratio,
        num_train_epochs=args.epochs,
        max_steps=args.max_steps,
        bf16=True,
        gradient_checkpointing=True,
        logging_steps=args.log_steps,
        save_steps=args.save_steps,
        save_total_limit=5,
        report_to=["tensorboard"],
        deepspeed=args.deepspeed,
        seed=args.seed,
        dataloader_num_workers=4,
        remove_unused_columns=False,
    )

    trainer = Trainer(
        model=model, args=targs, train_dataset=ds["train"],
        eval_dataset=ds.get("validation"),
        data_collator=default_data_collator,
    )
    metrics = trainer.train(resume_from_checkpoint=args.init_from)
    trainer.save_model(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print("[done] metrics:", metrics)
    print(f"[done] 模型已保存 → {args.output_dir}")


if __name__ == "__main__":
    main()
