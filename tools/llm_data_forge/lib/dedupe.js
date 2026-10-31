'use strict';
// tools/llm_data_forge/lib/dedupe.js — 文档去重（exact SHA-1 / MinHash LSH）
// 纯 Node.js，零第三方依赖，兼容 Win7 Node16+。

const crypto = require('crypto');
const cli = require('../../../lib/cli.js');

/** sha1 哈希 */
function sha1(text) {
  return crypto.createHash('sha1').update(text, 'utf8').digest('hex');
}

/** 规范化文本用于 MinHash：小写 + 压缩空白 */
function normalizeText(text) {
  return String(text).toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 字符 n-gram shingles */
function shinglesOf(text, n) {
  const s = normalizeText(text);
  if (s.length < n) return [s];
  const out = [];
  for (let i = 0; i + n <= s.length; i++) out.push(s.slice(i, i + n));
  return out;
}

const DEFAULT_SIGS = 128;

/**
 * MinHash 签名：对每个 seed 下的 fastHash 取最小值，得到 sim 估计向量。
 * 相同 shingle 集合 → 相同签名；Jaccard 越高签名相同位越多。
 */
function minhashSignature(text, { shingles = 5, sigs = DEFAULT_SIGS } = {}) {
  const tokens = shinglesOf(text, shingles);
  const sig = new Array(sigs);
  for (let s = 0; s < sigs; s++) {
    let min = Infinity;
    for (const t of tokens) {
      const h = cli.fastHash(t, s) >>> 0;
      if (h < min) min = h;
    }
    sig[s] = min;
  }
  return sig;
}

/**
 * LSH 桶判重器：bands × rows 分组，任一 band 内签名片段相同即判为近似重复。
 * 默认 bands=16, rows=8（sigs 需 = bands*rows）→ 相似度阈值约 0.66。
 */
class LshDeduper {
  constructor({ bands = 16, rows = 8, shingles = 5 } = {}) {
    this.bands = bands;
    this.rows = rows;
    this.shingles = shingles;
    this.sigs = bands * rows;
    if (this.sigs <= 0 || this.sigs > 1024) cli.die(`非法的 bands*rows: ${this.sigs}`);
    this.buckets = new Map(); // key: "bandIdx:hash" -> firstDocId
    this.seen = 0;
    this.collisions = 0;
  }

  /** 返回 true 表示与已见文档近似重复 */
  check(text, docId) {
    const sig = minhashSignature(text, { shingles: this.shingles, sigs: this.sigs });
    const id = docId === undefined ? this.seen : docId;
    for (let b = 0; b < this.bands; b++) {
      let h = 5381;
      for (let r = 0; r < this.rows; r++) {
        h = ((h * 33) ^ sig[b * this.rows + r]) >>> 0;
      }
      const key = b + ':' + h;
      const prev = this.buckets.get(key);
      if (prev !== undefined && prev !== id) {
        this.collisions++;
        return true; // 命中即判重，docId 不入桶（保留首见）
      }
    }
    for (let b = 0; b < this.bands; b++) {
      let h = 5381;
      for (let r = 0; r < this.rows; r++) {
        h = ((h * 33) ^ sig[b * this.rows + r]) >>> 0;
      }
      this.buckets.set(b + ':' + h, id);
    }
    this.seen++;
    return false;
  }
}

/** exact 去重器：SHA-1 全文集合判重 */
class ExactDeduper {
  constructor() { this.seen = new Set(); this.collisions = 0; }
  check(text) {
    const h = sha1(normalizeText(text));
    if (this.seen.has(h)) { this.collisions++; return true; }
    this.seen.add(h);
    return false;
  }
}

function createDeduper(mode, opts) {
  if (mode === 'exact') return new ExactDeduper();
  if (mode === 'minhash') return new LshDeduper(opts);
  if (mode === 'none' || !mode) return null;
  cli.die(`未知去重模式: ${mode}（可选: none | exact | minhash）`);
}

module.exports = { sha1, normalizeText, shinglesOf, minhashSignature, LshDeduper, ExactDeduper, createDeduper };
