#!/usr/bin/env node
'use strict';
// lib/cli.js — shared helpers for the dsh-llm-architect plugin suite.
// Zero third-party dependencies. Only Node.js built-ins.
// Designed to run safely on Windows 7 (Node 16+) and Linux.
// NEVER imports or requires CUDA / PyTorch / native C++ extensions.

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const crypto = require('crypto');
const { spawn } = require('child_process');

const TAG = '[dsh-llm]';

/* ----------------------------- argv parsing ----------------------------- */

function camel(s) { return s.replace(/-([a-zA-Z0-9])/g, (_, c) => c.toUpperCase()); }

function parseArgs(argv) {
  /** `parseArgs(['clean', '--input', 'a', '--flag=b', '--verbose', '--no-strip-html'])`
   *  -> { _: ['clean'], flags: { input: 'a', flag: 'b', verbose: true, stripHtml: false } }
   *  kebab-case 与 camelCase 双键同值；--no-x 等价 x=false。 */
  const out = { _: [], flags: {} };
  const set = (key, val) => {
    out.flags[key] = val;
    if (key.includes('-')) out.flags[camel(key)] = val;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const raw = a.slice(2);
      const eq = raw.indexOf('=');
      if (eq >= 0) { set(raw.slice(0, eq), raw.slice(eq + 1)); continue; }
      if (raw.startsWith('no-')) { set(raw.slice(3), false); continue; }
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) set(raw, true);
      else { set(raw, next); i++; }
    } else out._.push(a);
  }
  return out;
}

/* ----------------------------- logging ----------------------------- */

function log(...a) { console.log(TAG, ...a); }
function warn(...a) { console.error(TAG, 'WARN:', ...a); }
function die(msg, code = 1) {
  console.error(TAG, 'ERROR:', msg);
  process.exit(typeof code === 'number' ? code : 1);
}

/* ----------------------------- value coercion ----------------------------- */

function str(v) { return v === undefined || v === true ? '' : String(v); }
function num(v, dflt) {
  if (v === undefined || v === null) return dflt;
  const s = String(v).trim();
  if (s === '') return dflt;
  const n = Number(s);
  return Number.isFinite(n) ? n : dflt;
}
function bool(v) { return v === true || str(v) === 'true' || str(v) === '1'; }
function pick(...vals) {
  for (const v of vals) {
    if (v === undefined || v === null) continue;
    const s = String(v).trim();
    if (s !== '') return s;
  }
  return undefined;
}

/* ----------------------------- filesystem ----------------------------- */

function ensureDir(dir) { fs.mkdirSync(dir, { recursive: true }); return dir; }
function writeText(file, text) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, text);
  return file;
}
function writeJson(file, obj) {
  return writeText(file, JSON.stringify(obj, null, 2) + '\n');
}
function readText(file) { return fs.readFileSync(file, 'utf8'); }
function readJson(file) { return JSON.parse(readText(file)); }
function exists(p) { try { fs.accessSync(p); return true; } catch { return false; } }
function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  return dst;
}
function fileSize(p) {
  try { return fs.statSync(p).size; } catch { return 0; }
}

/** Iterate JSONL / plain-text lines without loading the file into memory. */
async function eachLine(file, onData) {
  const readline = require('readline');
  const stream = fs.createReadStream(file, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) await onData(line);
}

/* ----------------------------- templating ----------------------------- */

/** Replace {{UPPER_SNAKE}} placeholders. Unknown keys are kept as-is. */
function template(text, vars) {
  return String(text).replace(/\{\{([A-Z0-9_]+)\}\}/g, (m, k) => {
    const v = vars[k];
    return (v === undefined || v === null) ? m : String(v);
  });
}

/* ----------------------------- env helpers ----------------------------- */

function loadEnv(file) {
  const env = {};
  if (!exists(file)) return env;
  for (const line of readText(file).split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq < 0) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    env[k] = v;
  }
  return env;
}

/** Load .env from cwd upward (nearest first), merged over process.env. */
function loadDotEnv(extraPath) {
  const merged = {};
  const candidates = [];
  if (extraPath) candidates.push(extraPath);
  candidates.push(path.join(process.cwd(), '.env'));
  for (const c of candidates) {
    if (exists(c)) Object.assign(merged, loadEnv(c));
  }
  for (const k of Object.keys(merged)) {
    if (process.env[k] === undefined) process.env[k] = merged[k];
  }
  return merged;
}

function envValue(name, ...fallback) {
  if (process.env[name] !== undefined && process.env[name] !== '') return process.env[name];
  return pick(...fallback);
}

/* ----------------------------- http ----------------------------- */

function fetchText(url, { headers = {}, timeoutMs = 30000, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad url: ' + url)); }
    const req = (u.protocol === 'https:' ? https : http).get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) return reject(new Error('too many redirects: ' + url));
        return resolve(fetchText(res.headers.location, { headers, timeoutMs, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) {
        res.resume();
        const err = new Error('HTTP ' + res.statusCode + ' for ' + url);
        err.statusCode = res.statusCode;
        return reject(err);
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    req.on('timeout', () => req.destroy(new Error('timeout fetching ' + url)));
    req.on('error', reject);
  });
}

async function fetchJson(url, opts) { return JSON.parse(await fetchText(url, opts)); }

/** Stream-download a file (supports redirects). Returns the destination path. */
function downloadFile(url, dest, { headers = {}, timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad url: ' + url)); }
    ensureDir(path.dirname(dest));
    const file = fs.createWriteStream(dest);
    const req = (u.protocol === 'https:' ? https : http).get(url, { headers, timeout: timeoutMs }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(dest);
        return resolve(downloadFile(res.headers.location, dest, { headers, timeoutMs }));
      }
      if (res.statusCode !== 200) {
        file.close();
        try { fs.unlinkSync(dest); } catch {}
        return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      }
      res.pipe(file);
      file.on('finish', () => file.close(() => resolve(dest)));
    });
    req.on('timeout', () => req.destroy(new Error('timeout downloading ' + url)));
    req.on('error', reject);
  });
}

/* ----------------------------- subprocess / ssh ----------------------------- */

function sshArgs({ host, user = 'root', port = 22, key, extra = [] }) {
  const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=30'];
  if (key) args.push('-i', key);
  args.push('-p', String(port), user ? `${user}@${host}` : host);
  return ['ssh', ...args, ...extra];
}

function scpArgs({ src, dst, port = 22, key, extra = [] }) {
  const srcs = Array.isArray(src) ? src : [src];
  const args = ['-o', 'StrictHostKeyChecking=no', '-o', 'ConnectTimeout=15'];
  if (key) args.push('-i', key);
  args.push('-P', String(port));
  return ['scp', ...args, ...srcs, dst, ...extra];
}

/** Run a command. capture=false streams output to stdio. Returns {code,stdout,stderr}. */
function run(cmdArray, { dryRun = false, capture = false, cwd, shell = false } = {}) {
  if (dryRun) {
    log('dry-run:', cmdArray.map(x => /[ \t"]/.test(x) ? `"${x}"` : x).join(' '));
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  }
  return new Promise((resolve) => {
    const child = spawn(cmdArray[0], cmdArray.slice(1), { cwd, shell, windowsHide: true });
    let stdout = '', stderr = '';
    if (capture) {
      child.stdout.on('data', (c) => { stdout += c; });
      child.stderr.on('data', (c) => { stderr += c; });
    } else {
      child.stdout.on('data', (c) => process.stdout.write(c));
      child.stderr.on('data', (c) => process.stderr.write(c));
    }
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: String(e && e.message || e) }));
  });
}

function shQuote(s) { return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

/* ----------------------------- hashing ----------------------------- */

function sha1(text) { return crypto.createHash('sha1').update(text, 'utf8').digest('hex'); }
function sha256(text) { return crypto.createHash('sha256').update(text, 'utf8').digest('hex'); }

/** cyrb53 — fast non-cryptographic hash, used for MinHash signatures. */
function fastHash(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed, h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/* ----------------------------- misc formatting ----------------------------- */

function isoNow() { return new Date().toISOString().replace(/[:.]/g, '-'); }
function nowStamp() { return new Date().toISOString(); }

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0, v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(v < 10 && i > 0 ? 1 : 0) + ' ' + units[i];
}

function fmtMs(ms) {
  if (ms < 1000) return ms + 'ms';
  const s = ms / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60), rs = Math.floor(s % 60);
  if (m < 60) return m + 'm' + rs + 's';
  const h = Math.floor(m / 60), rm = m % 60;
  return h + 'h' + rm + 'm';
}

/** Best-effort platform check: is this a low-RAM Windows box (Win7 control plane)? */
function isLowResourceHost() {
  const totalMb = (require('os').totalmem() / 1024 / 1024) | 0;
  return process.platform === 'win32' && totalMb < 12 * 1024;
}

module.exports = {
  parseArgs, log, warn, die,
  str, num, bool, pick,
  ensureDir, writeText, writeJson, readText, readJson, exists, copyFile, fileSize, eachLine,
  template, loadEnv, loadDotEnv, envValue,
  fetchText, fetchJson, downloadFile,
  sshArgs, scpArgs, run, shQuote,
  sha1, sha256, fastHash,
  isoNow, nowStamp, fmtBytes, fmtMs, isLowResourceHost,
  TAG,
};
