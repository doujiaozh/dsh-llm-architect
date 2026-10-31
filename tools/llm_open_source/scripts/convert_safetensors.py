#!/usr/bin/env python3
"""convert_safetensors.py — 把 HF Trainer/PyTorch 权重转成 Safetensors 并写 config.json。

在 GPU 节点执行（本地 Win7 不需要 torch）。
用法:
  python3 convert_safetensors.py --src <ckpt_dir> --dst <out_dir> [--dtype bfloat16|float16|float32]
"""
import argparse
import json
import os
import shutil
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="HF Trainer checkpoint 目录")
    ap.add_argument("--dst", required=True, help="输出目录（可直接传 HF Hub）")
    ap.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    ap.add_argument("--max-shard", default="5GB")
    a = ap.parse_args()

    try:
        import torch
        from transformers import AutoConfig, AutoModelForCausalLM, AutoTokenizer
        from safetensors.torch import save_file
    except ImportError as e:
        print(f"[fatal] 缺少依赖: {e}（请在 GPU 节点 pip install -r cloud_requirements.txt）")
        return 1

    os.makedirs(a.dst, exist_ok=True)
    print(f"[1/4] 加载 checkpoint: {a.src}")
    config = AutoConfig.from_pretrained(a.src)
    model = AutoModelForCausalLM.from_pretrained(a.src, torch_dtype=getattr(torch, a.dtype))
    model = model.to(getattr(torch, a.dtype))
    model.config.torch_dtype = a.dtype

    try:
        tok = AutoTokenizer.from_pretrained(a.src)
        tok.save_pretrained(a.dst)
        print("[2/4] tokenizer 已保存")
    except Exception:
        print("[2/4] 无 tokenizer，跳过（训练时未保存）")

    print(f"[3/4] 转 Safetensors（dtype={a.dtype}）")
    state = {k: v.contiguous() for k, v in model.state_dict().items()}
    # 分片：按 max-shard（简化实现：单文件 + GB 级时自动分片用 save_pretrained）
    max_bytes = parse_size(a.max_shard)
    total = sum(v.numel() * v.element_size() for v in state.values())
    if total <= max_bytes:
        save_file(state, os.path.join(a.dst, "model.safetensors"), metadata={"format": "pt"})
    else:
        model.save_pretrained(a.dst, safe_serialization=True, max_shard_size=a.max_shard)
        print("       （权重超限，已自动分片）")

    model.config.save_pretrained(a.dst)
    print(f"[4/4] 写出: {a.dst}")
    for f in sorted(os.listdir(a.dst)):
        size = os.path.getsize(os.path.join(a.dst, f))
        print(f"  - {f} ({size / 1024 / 1024:.1f} MiB)")
    print("[done] 下一步: python3 verify_model.py --dir", a.dst)
    return 0


def parse_size(s):
    s = s.strip().upper()
    mult = {"B": 1, "KB": 1024, "MB": 1024**2, "GB": 1024**3, "TB": 1024**4}
    for suf, m in sorted(mult.items(), key=lambda x: -len(x[0])):
        if s.endswith(suf):
            return float(s[: -len(suf)]) * m
    return float(s)


if __name__ == "__main__":
    sys.exit(main())
