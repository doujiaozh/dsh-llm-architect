'use strict';
// tools/llm_data_forge/lib/clean.js — 文本清洗管线
// 纯 Node.js：HTML 剥离 / 实体解码 / NFKC 规范化 / 重复行 / 质量过滤 / 语种过滤 / PII 脱敏
// 兼容 Win7 Node16+，流式处理，内存友好。

const fs = require('fs');
const path = require('path');
const cli = require('../../../lib/cli.js');
const dedupeMod = require('./dedupe.js');

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#39;': "'", '&apos;': "'", '&ldquo;': '“', '&rdquo;': '”',
  '&lsquo;': '‘', '&rsquo;': '’', '&hellip;': '…', '&mdash;': '—',
  '&ndash;': '–', '&middot;': '·', '&deg;': '°', '&plusmn;': '±',
  '&times;': '×', '&divide;': '÷', '&copy;': '©', '&reg;': '®',
  '&trade;': '™', '&para;': '¶', '&sect;': '§', '&laquo;': '«',
  '&raquo;': '»', '&bull;': '•', '&dagger;': '†', '&permil;': '‰',
  '&larr;': '←', '&rarr;': '→', '&uarr;': '↑', '&darr;': '↓',
  '&euro;': '€', '&pound;': '£', '&yen;': '¥', '&cent;': '¢',
  '&alpha;': 'α', '&beta;': 'β', '&gamma;': 'γ', '&delta;': 'δ',
  '&pi;': 'π', '&sigma;': 'σ', '&omega;': 'ω', '&infin;': '∞',
  '&le;': '≤', '&ge;': '≥', '&ne;': '≠', '&asymp;': '≈',
  '&nequiv;': '≢', '&isin;': '∈', '&notin;': '∉', '&sum;': '∑',
  '&int;': '∫', '&radic;': '√', '&part;': '∂', '&forall;': '∀',
  '&exist;': '∃', '&empty;': '∅', '&crarr;': '↵', '&szlig;': 'ß',
  '&auml;': 'ä', '&ouml;': 'ö', '&uuml;': 'ü', '&Auml;': 'Ä',
  '&Ouml;': 'Ö', '&Uuml;': 'Ü', '&aacute;': 'á', '&eacute;': 'é',
  '&iacute;': 'í', '&oacute;': 'ó', '&uacute;': 'ú', '&ntilde;': 'ñ',
  '&ccedil;': 'ç', '&agrave;': 'à', '&egrave;': 'è', '&igrave;': 'ì',
  '&ograve;': 'ò', '&ugrave;': 'ù', '&aring;': 'å', '&aelig;': 'æ',
  '&oslash;': 'ø', '&thorn;': 'þ', '&eth;': 'ð', '&ouml;': 'ö',
};

const SCRIPT_BLOCK = /<(script|style|noscript|template|head)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const TAG = /<\/?[a-zA-Z][^>]{0,300}>/g;
const COMMENT = /<!--[\s\S]*?-->/g;
const NUMERIC_ENTITY = /&#(x?[0-9a-fA-F]+);/g;

/** HTML 剥离：去 script/style/head 块、注释、标签，解码实体 */
function stripHtml(text) {
  let s = String(text);
  s = s.replace(SCRIPT_BLOCK, ' ');
  s = s.replace(COMMENT, ' ');
  s = s.replace(TAG, ' ');
  // 先命名实体后数字实体（数字实体解码后再处理命名实体会产生双重解码问题，故分离两步）
  s = s.replace(/&[a-zA-Z]{2,8};/g, (m) => (m in ENTITIES ? ENTITIES[m] : m));
  s = s.replace(NUMERIC_ENTITY, (m, g1) => {
    const code = /^x/i.test(g1) ? parseInt(g1.slice(1), 16) : parseInt(g1, 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
  return s;
}

/** 规范化：NFKC + 去控制字符（保留 \n\t）+ 全角空格 + 空白压缩 */
function normalizeText(text) {
  let s = String(text).normalize('NFKC');
  // 去除控制字符，保留 \n 与 \t
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  s = s.replace(/[\u00A0\u2002-\u200B\u2028\u2029\u3000]/g, ' ');
  // 行内连续空白压成单个空格
  s = s.split('\n').map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim()).join('\n');
  // 连续 3+ 换行压成 1 个
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MOBILE_CN = /(?<!\d)1[3-9]\d{9}(?!\d)/g;
const IDCARD_CN = /(?<!\d)\d{17}[\dXx](?!\d)/g;
const CREDIT_CARD = /(?<!\d)\d{4}[- ]?\d{4}[- ]?\d{4}[- ]?\d{4}(?!\d)/g;

/** PII 脱敏：邮箱 / 中国手机号 / 18 位身份证 / 16 位信用卡号 → [REDACTED] */
function redactPii(text) {
  return String(text)
    .replace(EMAIL, '[REDACTED]')
    .replace(IDCARD_CN, '[REDACTED]')
    .replace(MOBILE_CN, '[REDACTED]')
    .replace(CREDIT_CARD, '[REDACTED]');
}

/** 删除连续重复行（相邻 >=3 完全相同）与单字刷屏行（同一字符连续 >=10 次） */
function dropRepeatLines(text, stats) {
  const lines = String(text).split('\n');
  const out = [];
  let run = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (i > 0 && line === lines[i - 1]) {
      run++;
      if (run >= 3) { stats.dropped.quality++; continue; } // 保留前两行，删后续
    } else {
      run = 1;
    }
    if (/(.)\1{9,}/.test(line)) { stats.dropped.quality++; continue; }
    out.push(line);
  }
  return out.join('\n');
}

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g;
const LATIN = /[A-Za-z]/g;
const SYMBOL = /[^\p{L}\p{N}\s]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/gu;

/** 粗语种判定：zh | en | mixed */
function detectLang(text) {
  const s = String(text);
  const cjk = (s.match(CJK) || []).length;
  const latin = (s.match(LATIN) || []).length;
  if (cjk > latin * 1.2 && cjk > 10) return 'zh';
  if (latin > cjk * 1.2 && latin > 10) return 'en';
  return 'mixed';
}

/** 质量过滤：返回 true 表示保留 */
function qualityOk(text, stats) {
  const s = String(text);
  const len = s.length;
  if (!len) { stats.dropped.quality++; return false; }
  const stripped = s.replace(SYMBOL, '');
  const symbolRatio = (len - stripped.length) / len;
  if (symbolRatio > 0.3) { stats.dropped.quality++; return false; }
  const valid = (s.match(LETTER_OR_DIGIT) || []).length;
  if (valid / len < 0.2) { stats.dropped.quality++; return false; }
  return true;
}

function newStats() {
  return {
    in_docs: 0, out_docs: 0, bytes_in: 0, bytes_out: 0,
    dropped: { length: 0, lang: 0, dup: 0, quality: 0 },
    dedupe_mode: 'none', dedupe_collisions: 0,
    duration_ms: 0, format_version: 1,
  };
}

const TEXT_KEYS = ['text', 'content', 'body', 'raw', 'data'];

/** 从 jsonl/json 单条记录抽取文本与 meta */
function extractFromRecord(rec) {
  if (typeof rec === 'string') return { text: rec, meta: {} };
  if (!rec || typeof rec !== 'object') return null;
  for (const k of TEXT_KEYS) {
    if (typeof rec[k] === 'string' && rec[k].length) {
      const meta = { ...rec };
      delete meta[k];
      return { text: rec[k], meta };
    }
  }
  // 嵌套结构降级：任意字符串字段
  for (const k of Object.keys(rec)) {
    if (typeof rec[k] === 'string' && rec[k].length > 20) {
      const meta = { ...rec }; delete meta[k];
      return { text: rec[k], meta };
    }
  }
  return null;
}

/** 枚举输入文件（目录递归，按路径排序保证可复现） */
function listInputFiles(input) {
  const abs = path.resolve(input);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return [abs];
  if (!fs.existsSync(abs)) cli.die(`输入不存在: ${abs}`);
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const p = path.join(dir, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(jsonl|json|txt|md)$/i.test(name)) out.push(p);
    }
  };
  walk(abs);
  if (!out.length) cli.die(`输入目录中没有可处理文件: ${abs}`);
  return out;
}

/** txt 按空行分段为文档 */
function paragraphsFromTxt(text) {
  return String(text)
    .split(/\n\s*\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * 清洗一条文档，返回 {text, meta, dropped: reason|null}
 */
function cleanDoc(text, opts, stats) {
  let s = String(text);
  if (opts.stripHtml) s = stripHtml(s);
  if (opts.normalize) s = normalizeText(s);
  if (opts.dropRepeatLines) s = dropRepeatLines(s, stats);
  if (opts.redactPii) s = redactPii(s);

  const len = s.length;
  if (len < opts.minChars || len > opts.maxChars) { stats.dropped.length++; return { dropped: 'length' }; }
  if (opts.qualityFilter && !qualityOk(s, stats)) return { dropped: 'quality' };

  const lang = detectLang(s);
  if (opts.lang !== 'auto' && lang !== opts.lang) { stats.dropped.lang++; return { dropped: 'lang' }; }
  return { text: s, meta: { chars: len, lang } };
}

/**
 * 主清洗流程：读输入 → 逐文档清洗 → 去重 → 写出 jsonl/txt + 统计
 * @returns {Promise<object>} stats
 */
async function runClean(input, out, opts) {
  const start = Date.now();
  const stats = newStats();
  stats.dedupe_mode = opts.dedupe || 'none';
  const deduper = dedupeMod.createDeduper(stats.dedupe_mode, {
    shingles: opts.shingles, bands: opts.bands, rows: opts.rows,
  });
  await cli.ensureDir(path.dirname(path.resolve(out)));
  const files = listInputFiles(input);
  const writeStream = fs.createWriteStream(path.resolve(out), { encoding: 'utf8' });
  const lineSep = opts.format === 'txt' ? '\n\n' : null;
  let docId = 0;

  const emit = (text, meta) => {
    stats.out_docs++;
    const bytes = Buffer.byteLength(text, 'utf8');
    stats.bytes_out += bytes;
    if (lineSep) {
      writeStream.write(text + lineSep);
    } else {
      writeStream.write(JSON.stringify({ text, meta }) + '\n');
    }
  };

  for (const file of files) {
    const ext = path.extname(file).toLowerCase();
    const rel = path.relative(process.cwd(), file);
    if (ext === '.jsonl') {
      await cli.eachLine(file, async (line) => {
        if (!line.trim()) return;
        stats.in_docs++;
        stats.bytes_in += Buffer.byteLength(line, 'utf8');
        let rec;
        try { rec = JSON.parse(line); } catch { stats.dropped.quality++; return; }
        const ex = extractFromRecord(rec);
        if (!ex) { stats.dropped.quality++; return; }
        const r = cleanDoc(ex.text, opts, stats);
        if (r.dropped) return;
        if (deduper && deduper.check(r.text, docId)) { stats.dropped.dup++; return; }
        docId++;
        emit(r.text, { source: rel, ...ex.meta, ...r.meta });
      });
    } else if (ext === '.json') {
      const raw = await cli.readText(file);
      stats.bytes_in += Buffer.byteLength(raw, 'utf8');
      let arr;
      try {
        const j = JSON.parse(raw);
        arr = Array.isArray(j) ? j : (Array.isArray(j.data) ? j.data : (j.records ? j.records : null));
      } catch (e) { cli.die(`JSON 解析失败 ${file}: ${e.message}`); }
      if (!arr) cli.die(`JSON 不是数组结构: ${file}`);
      for (const rec of arr) {
        stats.in_docs++;
        const ex = extractFromRecord(rec);
        if (!ex) { stats.dropped.quality++; continue; }
        const r = cleanDoc(ex.text, opts, stats);
        if (r.dropped) continue;
        if (deduper && deduper.check(r.text, docId)) { stats.dropped.dup++; continue; }
        docId++;
        emit(r.text, { source: rel, ...ex.meta, ...r.meta });
      }
    } else {
      // txt / md：按空行分段
      const raw = await cli.readText(file);
      stats.bytes_in += Buffer.byteLength(raw, 'utf8');
      for (const para of paragraphsFromTxt(raw)) {
        stats.in_docs++;
        const r = cleanDoc(para, opts, stats);
        if (r.dropped) continue;
        if (deduper && deduper.check(r.text, docId)) { stats.dropped.dup++; continue; }
        docId++;
        emit(r.text, { source: rel, ...r.meta });
      }
    }
  }

  await new Promise((res, rej) => { writeStream.end((e) => (e ? rej(e) : res())); });
  if (deduper) stats.dedupe_collisions = deduper.collisions;
  stats.duration_ms = Date.now() - start;
  return stats;
}

module.exports = {
  stripHtml, normalizeText, redactPii, dropRepeatLines,
  detectLang, qualityOk, cleanDoc, runClean, newStats,
  extractFromRecord, listInputFiles, paragraphsFromTxt,
};
