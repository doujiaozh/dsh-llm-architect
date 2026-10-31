#!/usr/bin/env python3
"""verify_model.py — 发布前自检：加载模型、跑一次前向、校验 config/tokenizer 完整性。

在 GPU 节点执行；CPU 也可（小模型）。
用法: python3 verify_model.py --dir <model_dir> [--prompt "你好"]
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--prompt", default="DeepSeek Harness 是一个")
    a = ap.parse_args()

    d = a.dir.rstrip("/")
    print(f"[1/5] 目录清单 {d}:")
    files = sorted(os.listdir(d))
    must = ["config.json"]
    for f in files:
        print(f"  - {f}")
    for m in must:
        if m not in files:
            print(f"[fail] 缺失 {m}")
            return 1
    st = [f for f in files if f.endswith(".safetensors")]
    if not st:
        print("[fail] 未找到 *.safetensors")
        return 1

    print("[2/5] config.json 校验")
    cfg = json.load(open(os.path.join(d, "config.json")))
    for k in ("architectures", "model_type", "hidden_size", "num_hidden_layers", "vocab_size"):
        if k not in cfg:
            print(f"[warn] config 缺少推荐字段: {k}")

    try:
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
    except ImportError as e:
        print(f"[fatal] 缺少依赖: {e}")
        return 1

    print("[3/5] 加载 tokenizer")
    try:
        tok = AutoTokenizer.from_pretrained(d)
    except Exception as e:
        print(f"[fail] tokenizer 加载失败: {e}")
        return 1

    print("[4/5] 加载模型")
    device = "cuda" if torch.cuda.is_available() else "cpu"
    model = AutoModelForCausalLM.from_pretrained(d, torch_dtype=torch.float32 if device == "cpu" else "auto").to(device)
    n = sum(p.numel() for p in model.parameters())
    print(f"  参数量: {n / 1e9:.2f}B, device={device}")

    print("[5/5] 前向测试")
    ids = tok(a.prompt, return_tensors="pt").to(device)
    out = model.generate(**ids, max_new_tokens=16, do_sample=False)
    text = tok.decode(out[0][ids["input_ids"].shape[1]:], skip_special_tokens=True)
    print(f"  生成: {text!r}")
    print("[done] 模型可发布 ✓")
    return 0


if __name__ == "__main__":
    sys.exit(main())
