#!/usr/bin/env python3
"""convert_zero3_safetensors.py — 合并 DeepSpeed ZeRO-3 分片权重 → 完整 Safetensors。

ZeRO-3 的 checkpoint 里每张卡只有一部分参数；本脚本读取 zero_to_fp32 逻辑
（等价于 deepspeed.utils.zero_to_fp32），合并后转 Safetensors。
用法:
  python3 convert_zero3_safetensors.py --src <ckpt_dir> --dst <out_dir> [--dtype bfloat16]
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--src", required=True, help="DeepSpeed checkpoint 目录（含 zero_pp_rank_*）")
    ap.add_argument("--dst", required=True)
    ap.add_argument("--dtype", default="bfloat16", choices=["bfloat16", "float16", "float32"])
    a = ap.parse_args()

    try:
        import torch
        from transformers import AutoConfig, AutoModelForCausalLM
        from safetensors.torch import save_file
        from deepspeed.utils.zero_to_fp32 import get_fp32_state_dict_from_zero_checkpoint
    except ImportError as e:
        print(f"[fatal] 缺少依赖: {e}")
        return 1

    os.makedirs(a.dst, exist_ok=True)
    print(f"[1/4] 合并 ZeRO-3 分片: {a.src}")
    state = get_fp32_state_dict_from_zero_checkpoint(a.src)

    cfg_path = os.path.join(a.src, "config.json")
    if not os.path.exists(cfg_path):
        # 训练时保存的 config 在上一级
        for cand in (os.path.dirname(a.src.rstrip("/")), os.path.join(a.src, "../")):
            if os.path.exists(os.path.join(cand, "config.json")):
                cfg_path = os.path.join(cand, "config.json")
                break
    config = AutoConfig.from_pretrained(cfg_path) if os.path.exists(cfg_path) else None

    dt = getattr(torch, a.dtype)
    print(f"[2/4] 转换 dtype → {a.dtype}")
    state = {k.replace("_orig_mod.", ""): v.to(dt).contiguous() for k, v in state.items()}

    if config is not None:
        print("[3/4] 初始化模型并加载合并权重")
        model = AutoModelForCausalLM.from_config(config, torch_dtype=dt)
        missing, unexpected = model.load_state_dict(state, strict=False)
        if missing:
            print(f"  [warn] missing keys: {missing[:5]}{'...' if len(missing) > 5 else ''}")
        model.config.torch_dtype = a.dtype
        model.config.save_pretrained(a.dst)
        state = {k: v.contiguous() for k, v in model.state_dict().items()}

    print(f"[4/4] 写 Safetensors → {a.dst}")
    save_file(state, os.path.join(a.dst, "model.safetensors"), metadata={"format": "pt", "zero3_merged": "true"})
    try:
        from transformers import AutoTokenizer
        tok_src = os.path.dirname(a.src.rstrip("/"))
        AutoTokenizer.from_pretrained(tok_src).save_pretrained(a.dst)
        print("  tokenizer 已保存")
    except Exception:
        print("  [warn] tokenizer 未找到，请手动复制 tokenizer.json")
    print("[done] 合并完成")
    return 0


if __name__ == "__main__":
    sys.exit(main())
