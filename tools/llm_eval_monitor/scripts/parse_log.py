#!/usr/bin/env python3
"""parse_log.py — 云端可用的训练日志解析（与 Node 版 parse.js 同语义，供远程流水线使用）。

用法:
  python3 parse_log.py <logfile> [--out metrics.json] [--max-points 5000]
输出 metrics.json（points + summary + alerts），供 chart/报告使用。
"""
import argparse
import json
import math
import re
import sys

RE = {
    "hf_loss": re.compile(r"['\"]loss['\"]\s*:\s*([0-9.eE+-]+)"),
    "hf_lr": re.compile(r"['\"]learning_rate['\"]\s*:\s*([0-9.eE+-]+)"),
    "hf_epoch": re.compile(r"['\"]epoch['\"]\s*:\s*([0-9.eE+-]+)"),
    "hf_grad": re.compile(r"['\"]grad_norm['\"]\s*:\s*([0-9.eE+-]+)"),
    "hf_step": re.compile(r"['\"](?:step|global_step)['\"]\s*:\s*(\d+)"),
    "ds_loss": re.compile(r"\bloss[:=]\s*([0-9.eE+-]+)", re.I),
    "ds_lr": re.compile(r"\blr[:=]\s*([0-9.eE+-]+)", re.I),
    "ds_step": re.compile(r"\bstep[:=]\s*(\d+)", re.I),
    "mg_iter": re.compile(r"\biteration\s+(\d+)\s*(?:/\s*(\d+))?"),
    "mg_loss": re.compile(r"lm loss:\s*([0-9.eE+-]+)", re.I),
    "mg_lr": re.compile(r"\blr:\s*([0-9.eE+-]+)", re.I),
    "tps": re.compile(r"\b([\d.]+)\s*(?:tokens/s|t/s|tokens_per_second)", re.I),
}

STOP_PATTERNS = [
    (re.compile(r"CUDA out of memory", re.I), "CUDA OOM"),
    (re.compile(r"Traceback \(most recent call last\)|RuntimeError|AssertionError"), "Python 运行时错误"),
    (re.compile(r"loss[:=]\s*(?:nan|inf)", re.I), "loss nan/inf"),
    (re.compile(r"NCCL error|Connection (reset|refused)|timeout", re.I), "通信/网络错误"),
    (re.compile(r"No space left on device"), "磁盘满"),
    (re.compile(r"OOM Killer|Killed"), "系统 OOM"),
]


def to_num(s):
    if s is None:
        return None
    try:
        return float(s)
    except (TypeError, ValueError):
        return None


def parse_line(line):
    out = {}
    if RE["hf_loss"].search(line):
        out["source"] = "hf_trainer"
        out["loss"] = to_num(RE["hf_loss"].search(line).group(1))
        m = RE["hf_lr"].search(line)
        out["lr"] = to_num(m.group(1)) if m else None
        m = RE["hf_epoch"].search(line)
        out["epoch"] = to_num(m.group(1)) if m else None
        m = RE["hf_grad"].search(line)
        out["grad_norm"] = to_num(m.group(1)) if m else None
        m = RE["hf_step"].search(line)
        out["step"] = int(m.group(1)) if m else None
    else:
        m = RE["mg_iter"].search(line)
        if m and RE["mg_loss"].search(line):
            out["source"] = "megatron"
            out["iteration"] = int(m.group(1))
            out["max_iteration"] = int(m.group(2)) if m.group(2) else None
            out["loss"] = to_num(RE["mg_loss"].search(line).group(1))
            m2 = RE["mg_lr"].search(line)
            out["lr"] = to_num(m2.group(1)) if m2 else None
        else:
            m = RE["ds_loss"].search(line)
            if m:
                out["source"] = "deepspeed"
                out["loss"] = to_num(m.group(1))
                m2 = RE["ds_lr"].search(line)
                out["lr"] = to_num(m2.group(1)) if m2 else None
                m2 = RE["ds_step"].search(line)
                out["step"] = int(m2.group(1)) if m2 else None
            else:
                return None
    m = RE["tps"].search(line)
    if m:
        out["tokens_per_sec"] = to_num(m.group(1))
    return out or None


def summarize(points):
    losses = [p["loss"] for p in points if p.get("loss") is not None]
    lrs = [p["lr"] for p in points if p.get("lr") is not None]
    tps = [p["tokens_per_sec"] for p in points if p.get("tokens_per_sec") is not None]
    last = points[-1] if points else {}
    return {
        "n_points": len(points),
        "first_loss": losses[0] if losses else None,
        "last_loss": losses[-1] if losses else None,
        "min_loss": min(losses) if losses else None,
        "last_lr": lrs[-1] if lrs else None,
        "max_lr": max(lrs) if lrs else None,
        "avg_tokens_per_sec": round(sum(tps) / len(tps), 1) if tps else None,
        "last_step": last.get("step") or last.get("iteration"),
        "last_epoch": last.get("epoch"),
        "last_source": last.get("source"),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("logfile")
    ap.add_argument("--out", default="metrics.json")
    ap.add_argument("--max-points", type=int, default=5000)
    a = ap.parse_args()

    points, alerts = [], []
    with open(a.logfile, "r", encoding="utf-8", errors="replace") as f:
        for i, line in enumerate(f, 1):
            for pat, label in STOP_PATTERNS:
                if pat.search(line):
                    alerts.append({"line": i, "label": label, "text": line.strip()[:200]})
            p = parse_line(line)
            if p:
                p["line_no"] = i
                points.append(p)
    if len(points) > a.max_points:
        stride = len(points) / a.max_points
        points = [points[int(i * stride)] for i in range(a.max_points)]
    result = {"points": points, "total_points": len(points), "alerts": alerts, "summary": summarize(points)}
    with open(a.out, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    s = result["summary"]
    print(f"[parse] points={s['n_points']} loss={s['first_loss']}→{s['last_loss']} "
          f"min={s['min_loss']} lr={s['last_lr']} tps={s['avg_tokens_per_sec']} alerts={len(alerts)}")
    print(f"[done] → {a.out}")


if __name__ == "__main__":
    sys.exit(main())
