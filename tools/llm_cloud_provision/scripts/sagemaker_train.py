#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
sagemaker_train.py — AWS SageMaker 分布式训练启动器（由 llm_cloud_provision 生成）。
本地控制面调用此脚本，由 boto3 把训练任务提交到 SageMaker 托管 GPU 集群。
依赖：pip install boto3 sagemaker
鉴权：AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_REGION 环境变量。
"""

import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--role-arn", default=os.environ.get("SAGEMAKER_ROLE_ARN"), help="SageMaker 执行角色 ARN")
    ap.add_argument("--image", default=os.environ.get("SAGEMAKER_ECR_IMAGE"), help="ECR 训练镜像 URI")
    ap.add_argument("--entry-point", default="train.py")
    ap.add_argument("--source-dir", default="./")
    ap.add_argument("--instance-type", default="ml.g5.48xlarge")  # 8×A10G
    ap.add_argument("--instance-count", type=int, default=1)
    ap.add_argument("--job-name", default="dsh-llm-train")
    ap.add_argument("--hyperparameters", default="{}", help="JSON 字符串：传给 entry_point 的超参")
    ap.add_argument("--channels", default="{}", help="JSON：S3 输入通道 {channel: s3_uri}")
    ap.add_argument("--output-s3", default=None, help="模型输出 S3 前缀")
    ap.add_argument("--estimator", default="pytorch", choices=["pytorch", "huggingface"])
    args = ap.parse_args()

    try:
        import boto3
        import sagemaker
        from sagemaker.pytorch import PyTorch
    except ImportError:
        print("[fatal] pip install boto3 sagemaker", file=sys.stderr)
        sys.exit(2)

    if not args.role_arn or not args.image:
        print("[fatal] 需要 --role-arn（SAGEMAKER_ROLE_ARN）与 --image（SAGEMAKER_ECR_IMAGE）", file=sys.stderr)
        sys.exit(2)

    hps = json.loads(args.hyperparameters)
    channels = json.loads(args.channels)
    sess = sagemaker.Session()
    boto_session = boto3.Session(region_name=os.environ.get("AWS_REGION", "us-east-1"))

    cls = PyTorch
    if args.estimator == "huggingface":
        try:
            from sagemaker.huggingface import HuggingFace
            cls = HuggingFace
        except ImportError:
            print("[warn] sagemaker 无 HuggingFace 估计器，回退 PyTorch", file=sys.stderr)

    est = cls(
        role=args.role_arn,
        image_uri=args.image,
        entry_point=args.entry_point,
        source_dir=args.source_dir,
        instance_type=args.instance_type,
        instance_count=args.instance_count,
        hyperparameters=hps,
        py_version="py310",
        sagemaker_session=sagemaker.Session(boto_session=boto_session),
        output_path=args.output_s3,
    )
    print(f"[info] 提交训练任务 {args.job_name} → {args.instance_type} ×{args.instance_count}")
    est.fit(inputs=channels or None, job_name=args.job_name, wait=False)
    print(f"[done] 已提交。控制台/CLI 查看: aws sagemaker describe-training-job --training-job-name {args.job_name}")
    print(f"[logs] CloudWatch: /aws/sagemaker/TrainingJobs/{args.job_name}")


if __name__ == "__main__":
    main()
