'use strict';
// tools/llm_eval_monitor/lib/watch.js — 增量日志监控（轮询 + 停机模式告警）

const fs = require('fs');
const path = require('path');
const cli = require('../../../lib/cli.js');
const parseMod = require('./parse.js');

/**
 * watch：增量读取远端/本地日志，解析新行，命中 STOP_PATTERNS 立即告警。
 * @param {object} opts { ssh: {host,user,port,key}|null, remoteLog, localLog, interval, out, stateDir, maxRounds }
 */
async function watch(opts) {
  const intervalMs = cli.num(opts.interval, 15) * 1000;
  const maxRounds = cli.num(opts.maxRounds, 0); // 0 = 无限
  const stateDir = opts.stateDir || path.join(process.cwd(), '.dsh-eval');
  let state = await parseMod.loadState(stateDir);
  let round = 0;
  const report = { started_at: cli.isoNow(), updates: 0, alerts: 0, stopped: false };

  // 获取日志文本的函数：本地读文件 / ssh 远端 tail
  const ssh = opts.ssh || null;
  async function fetchTail(offset) {
    if (ssh) {
      const full = cli.sshArgs(ssh);
      const cmd = [...full.slice(0, -1), full[full.length - 1],
        `tail -c +${offset + 1} '${ssh.remoteLog}' 2>/dev/null || true`];
      const r = await cli.run(cmd, { capture: true });
      return r.code === 0 ? r.stdout : '';
    }
    if (!cli.exists(opts.localLog)) return '';
    const buf = fs.readFileSync(opts.localLog);
    if (buf.length <= offset) return '';
    return buf.slice(offset).toString('utf8');
  }
  async function currentSize() {
    if (ssh) {
      const full = cli.sshArgs(ssh);
      const r = await cli.run([...full.slice(0, -1), full[full.length - 1],
        `stat -c %s '${ssh.remoteLog}' 2>/dev/null || echo 0`], { capture: true });
      return cli.num(r.stdout.trim(), 0);
    }
    return cli.exists(opts.localLog) ? fs.statSync(opts.localLog).size : 0;
  }

  // 多轮循环
  for (;;) {
    round++;
    const size = await currentSize();
    let newText = '';
    if (size > state.size) {
      newText = await fetchTail(state.size);
      state.size = size;
    } else if (size < state.size) {
      // 日志被截断/轮转，从头开始
      state.size = 0; state.offset = 0;
    }
    if (newText) {
      const lines = newText.split(/\r?\n/).filter(Boolean);
      const newPoints = [];
      for (const line of lines) {
        for (const sp of parseMod.STOP_PATTERNS) {
          if (sp.re.test(line)) {
            report.alerts++;
            cli.warn(`[ALERT] ${sp.label}`);
            cli.warn(`  ${line.trim().slice(0, 200)}`);
            await parseMod.saveState(stateDir, { ...state, alert: sp.label, at: cli.isoNow(), line: line.trim().slice(0, 200) });
            report.stopped = true;
            report.stop_reason = sp.label;
            return report;
          }
        }
        const p = parseMod.parseLine(line);
        if (p) newPoints.push(p);
      }
      report.updates += newPoints.length;
      state.offset += lines.length;
      await parseMod.saveState(stateDir, state);
      if (newPoints.length) {
        const last = newPoints[newPoints.length - 1];
        cli.log(`[step ${last.step || last.iteration || '?'}] loss=${last.loss !== undefined ? last.loss.toFixed(4) : '?'}`
          + ` lr=${last.lr !== undefined ? last.lr.toExponential(2) : '?'}`
          + (last.tokens_per_sec !== undefined ? ` tps=${last.tokens_per_sec.toFixed(0)}` : ''));
      }
    }
    if (opts.onRound) await opts.onRound(round, report);
    if (report.stopped) return report;
    if (maxRounds > 0 && round >= maxRounds) { report.rounds = round; return report; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { watch };
