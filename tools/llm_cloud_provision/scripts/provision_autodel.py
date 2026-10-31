#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
provision_autodel.py — AutoDL OpenAPI 租用/查询脚本（由 llm_cloud_provision 生成）。
依赖：pip install requests；鉴权：环境变量 AUTODL_TOKEN。

支持操作：
    list      列出可租用的 GPU 商品（region 需指定）
    create    租用一台指定规格的实例
    status    查询已有实例状态
    release   释放实例
"""

import argparse
import json
import os
import sys

try:
    import requests
except ImportError:
    print("[fatal] pip install requests", file=sys.stderr)
    sys.exit(2)

BASE = "https://api.autodl.com/api/v1"


def headers():
    token = os.environ.get("AUTODL_TOKEN")
    if not token:
        print("[fatal] 未设置 AUTODL_TOKEN", file=sys.stderr)
        sys.exit(2)
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def call(method, path, payload=None):
    url = f"{BASE}{path}"
    r = requests.request(method, url, json=payload, headers=headers(), timeout=30)
    try:
        data = r.json()
    except ValueError:
        print(f"[fatal] {r.status_code} {r.text[:200]}", file=sys.stderr)
        sys.exit(3)
    if r.status_code >= 400 or str(data.get("code", "0")) != "0":
        print(f"[error] {json.dumps(data, ensure_ascii=False)[:400]}", file=sys.stderr)
        sys.exit(4)
    return data.get("data", data)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="op", required=True)
    p1 = sub.add_parser("list")
    p1.add_argument("--region", default="west")  # east/west 等
    p2 = sub.add_parser("create")
    p2.add_argument("--region", default="west")
    p2.add_argument("--gpu-name", default="RTX4090")
    p2.add_argument("--gpu-count", type=int, default=8)
    p2.add_argument("--image", default="pytorch2.1")
    p3 = sub.add_parser("status")
    p4 = sub.add_parser("release")
    p4.add_argument("--instance-id", required=True)
    args = ap.parse_args()

    if args.op == "list":
        data = call("GET", f"/compute/gpu/list?region={args.region}")
        for g in (data or {}).get("list", data or []):
            print(json.dumps(g, ensure_ascii=False))
    elif args.op == "create":
        payload = {
            "region": args.region,
            "gpu_name": args.gpu_name,
            "gpu_count": args.gpu_count,
            "image": args.image,
            "billing_method": "hourly",
        }
        data = call("POST", "/compute/gpu/create", payload)
        print(json.dumps(data, ensure_ascii=False))
    elif args.op == "status":
        data = call("GET", "/compute/gpu/list?status=running")
        print(json.dumps(data, ensure_ascii=False))
    elif args.op == "release":
        data = call("POST", "/compute/gpu/release", {"instance_id": args.instance_id})
        print(json.dumps(data, ensure_ascii=False))


if __name__ == "__main__":
    main()
