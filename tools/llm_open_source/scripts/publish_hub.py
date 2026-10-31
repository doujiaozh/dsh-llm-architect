#!/usr/bin/env python3
"""publish_hub.py — 一键推送模型仓库到 HuggingFace Hub。

在 GPU 节点执行（或本地，只要装了 huggingface_hub）。
用法:
  HF_TOKEN=hf_xxx python3 publish_hub.py --dir <model_dir> --repo <user/name> [--dry-run]
"""
import argparse
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--repo", required=True, help="HF repo id，如 dsh-architect/dsh-llm-1.3b")
    ap.add_argument("--endpoint", default=os.environ.get("HF_ENDPOINT", "https://huggingface.co"))
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    token = os.environ.get("HF_TOKEN")
    if not token:
        print("[fatal] 未设置 HF_TOKEN")
        return 1
    if "/" not in a.repo:
        print("[fatal] repo 需为 <user>/<name> 形式")
        return 1

    try:
        from huggingface_hub import HfApi, create_repo, upload_folder
    except ImportError:
        print("[fatal] 缺少 huggingface_hub：pip install huggingface_hub")
        return 1

    print(f"[1/3] 目标: {a.endpoint}/{a.repo}（dry-run={a.dry_run}）")
    for f in sorted(os.listdir(a.dir)):
        print(f"  - {f}")
    if a.dry_run:
        print("[done] dry-run，未推送")
        return 0

    print("[2/3] 创建仓库")
    create_repo(a.repo, token=token, exist_ok=True, endpoint=a.endpoint)
    print("[3/3] 上传")
    api = HfApi(token=token, endpoint=a.endpoint)
    commit = api.upload_folder(folder_path=a.dir, repo_id=a.repo, repo_type="model")
    print(f"[done] 已推送: {a.endpoint}/{a.repo} @ {commit.oid[:8]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
