#!/usr/bin/env node
'use strict';
// tools/llm_eval_monitor/index.js — 训练监控与模型评测（DSH 工具入口）
// 本地控制面：ssh 拉取远端训练日志 → 解析 loss/lr/吞吐 → SVG 曲线 → lm-eval-harness 评测。

const cli = require('../../lib/cli.js');
const fs = require('fs');
const path = require('path');
const parseMod = require('./lib/parse.js');
const chartMod = require('./lib/chart.js');
const watchMod = require('./lib/watch.js');

const HELP = `llm_eval_monitor · 训练监控与模型评测

用法:
  node tools/llm_eval_monitor/index.js <subcommand> [flags]
  node tools/llm_eval_monitor/index.js --json '{"subcommand":"parse","args":{...}}'

子命令:
  tail-log   拉取远端训练日志尾部（或读本地日志）
  watch      增量监控：轮询新日志，解析指标，命中异常模式立即告警退出
  parse      全量解析日志 → metrics.json（支持 HF Trainer/DeepSpeed/Megatron/通用）
  chart      用 metrics.json/日志生成 loss 与吞吐 SVG 曲线
  eval       生成/执行 lm-evaluation-harness 评测脚本
  report     汇总 metrics + 评测结果 → markdown 报告

示例:
  node index.js watch --remote /root/llm-training/train/run.log --interval 15
  node index.js parse train.log --out metrics.json && node index.js chart metrics.json
  node index.js eval --remote /root/llm-training/ckpt/step-1000 --tasks mmlu,arc_challenge
`;

function remoteOpts(args) {
  const host = cli.pick(args.remoteHost, cli.envValue('REMOTE_HOST', ''));
  const user = cli.pick(args.remoteUser, cli.envValue('REMOTE_USER', 'root'));
  const port = cli.pick(args.remotePort, cli.envValue('REMOTE_PORT', '22'));
  const key = cli.pick(args.sshKeyPath, cli.envValue('SSH_KEY_PATH', ''));
  return { host, user, port, key };
}

function sshCmdOf(ro, remoteCmd) {
  const full = cli.sshArgs(ro);
  return [...full.slice(0, -1), full[full.length - 1], remoteCmd];
}

async function dispatch(sub, args) {
  switch (sub) {
    case 'tail-log': {
      const ro = remoteOpts(args);
      const tail = args.tail === undefined ? undefined : args.tail;
      const n = String(cli.num(args.lines, 80));
      if (ro.host) {
        const dryRun = cli.bool(args.dryRun === undefined ? false : args.dryRun);
        const cmd = sshCmdOf(ro, `tail -n ${n} '${args.remote || (cli.envValue('REMOTE_WORKDIR', '/root/llm-training') + '/train/run.log')}'`);
        if (dryRun) { cli.log(`[dry-run] ${cmd.join(' ')}`); return { planned: true }; }
        const r = await cli.run(cmd, { capture: true });
        if (r.stdout) console.log(r.stdout);
        if (r.code !== 0 && r.stderr) console.error(r.stderr);
        return { code: r.code };
      }
      const local = args.local || 'run.log';
      if (!cli.exists(local)) cli.die(`需要远端（--remote-host）或本地日志（--local ${local}）`);
      const text = fs.readFileSync(local, 'utf8');
      const lines = text.split(/\r?\n/).filter(Boolean);
      console.log(lines.slice(-n).join('\n'));
      return { lines: Math.min(n, lines.length) };
    }
    case 'watch': {
      const ro = remoteOpts(args);
      const localLog = args.local || '';
      const interval = cli.num(args.interval, 15);
      const maxRounds = cli.num(args.maxRounds, args.forever ? 0 : 0);
      const dryRun = cli.bool(args.dryRun === undefined ? false : args.dryRun);
      const opts = {
        ssh: ro.host ? { host: ro.host, user: ro.user, port: ro.port, key: ro.key, remoteLog: args.remote || '' } : null,
        localLog, interval, maxRounds,
        stateDir: args.stateDir || path.join(process.cwd(), '.dsh-eval'),
      };
      if (!opts.ssh && !localLog) cli.die('watch 需要 --remote（配合 --remote-host）或 --local 日志路径');
      if (dryRun) {
        const where = opts.ssh ? `ssh ${ro.user}@${ro.host}:${opts.ssh.remoteLog}` : localLog;
        cli.log(`[dry-run] watch ${where} 间隔 ${interval}s${maxRounds ? ` × ${maxRounds} 轮` : '（无限）'}`);
        cli.log('  异常模式: ' + parseMod.STOP_PATTERNS.map((p) => p.label).join(' / '));
        return { planned: true, interval, mode: where };
      }
      const report = await watchMod.watch(opts);
      cli.log(`监控结束: 更新 ${report.updates} 点, 告警 ${report.alerts}${report.stopped ? ', 停止原因: ' + report.stop_reason : ''}`);
      return report;
    }
    case 'parse': {
      const input = args.log || args.input;
      if (!input) cli.die('parse 需要 --log 日志路径');
      const r = await parseMod.parseLog(input, { maxPoints: cli.num(args.maxPoints, 5000) });
      const out = args.out || (typeof input === 'string' && !fs.existsSync(input) ? 'metrics.json' : path.join(path.dirname(path.resolve(input)), 'metrics.json'));
      await cli.writeJson(out, r);
      const s = r.summary;
      cli.log(`解析: ${r.total_points} 指标点, 告警 ${r.alerts.length}`);
      cli.log(`  loss ${s.first_loss} → ${s.last_loss}（min ${s.min_loss}, 降幅 ${s.loss_drop_pct}%）`);
      if (s.avg_tokens_per_sec !== undefined) cli.log(`  吞吐 ${s.avg_tokens_per_sec} tokens/s`);
      if (r.alerts.length) { cli.warn('异常:'); r.alerts.slice(0, 5).forEach((a) => cli.warn(`  L${a.line}: ${a.label}`)); }
      cli.log(`  → ${out}`);
      return { out, ...r };
    }
    case 'chart': {
      const src = args.metrics || args.log;
      if (!src) cli.die('chart 需要 --metrics（metrics.json）或 --log');
      let points;
      if (src.endsWith('.json')) {
        const m = await cli.readJson(src);
        points = m.points || [];
      } else {
        const r = await parseMod.parseLog(src);
        points = r.points;
      }
      if (!points.length) cli.die('没有可绘制的指标点');
      const outDir = path.resolve(cli.pick(args.out, path.join('out', 'charts')));
      await cli.ensureDir(outDir);
      const files = [];
      const loss = chartMod.lossChart(points, { title: args.title || 'Training Loss', width: cli.num(args.width, 960), height: cli.num(args.height, 480) });
      if (loss) {
        const p = path.join(outDir, 'loss_curve.svg');
        await cli.writeText(p, loss.svg);
        files.push(p);
        cli.log(`loss 曲线 → ${p}（${loss.meta.n} 点, min ${loss.meta.min_loss}）`);
      }
      const tps = chartMod.throughputChart(points, { title: 'Throughput (tokens/s)' });
      if (tps) {
        const p = path.join(outDir, 'throughput.svg');
        await cli.writeText(p, tps.svg);
        files.push(p);
        cli.log(`吞吐图 → ${p}（avg ${tps.meta.avg.toFixed(0)} tokens/s）`);
      }
      return { files, points: points.length };
    }
    case 'eval': {
      const ro = remoteOpts(args);
      const modelPath = args.model || '';
      const tasks = cli.pick(args.tasks, 'mmlu,hellaswag,arc_challenge,arc_easy,winogrande,piqa,truthfulqa_mc2,gsm8k');
      const outDir = path.resolve(cli.pick(args.out, path.join('out', 'eval')));
      await cli.ensureDir(outDir);
      const tplPath = path.join(__dirname, 'scripts', 'run_lm_eval.sh');
      const tpl = fs.existsSync(tplPath) ? fs.readFileSync(tplPath, 'utf8').replace(/\r\n/g, '\n') : '';
      const localScript = path.join(outDir, 'run_lm_eval.sh');
      await cli.writeText(localScript, tpl);

      if (!ro.host || !modelPath) {
        // 生成就绪包：拷贝 eval_remote.sh + 说明
        const remote = fs.readFileSync(path.join(__dirname, 'scripts', 'eval_remote.sh'), 'utf8').replace(/\r\n/g, '\n');
        await cli.writeText(path.join(outDir, 'eval_remote.sh'), remote);
        cli.log(`评测脚本已生成 → ${outDir}/`);
        cli.log('  远端执行: scp 上传后 bash run_lm_eval.sh <model_path> ' + tasks);
        cli.log('  本地一键: 设置 .env REMOTE_HOST 后 node index.js eval --model <远端模型路径>');
        return { out_dir: outDir, files: ['run_lm_eval.sh', 'eval_remote.sh'], tasks };
      }
      const dryRun = cli.bool(args.dryRun === undefined ? false : args.dryRun);
      const workdir = cli.envValue('REMOTE_WORKDIR', '/root/llm-training');
      const scp = cli.scpArgs({ src: [localScript], dst: `${ro.user}@${ro.host}:${workdir}/`, port: ro.port, key: ro.key });
      const runEval = sshCmdOf(ro,
        `cd ${workdir} && LM_EVAL_TASKS='${tasks}' LM_EVAL_OUT='eval_results.json' bash run_lm_eval.sh ${modelPath}`);
      const pull = cli.scpArgs({ src: [`${ro.user}@${ro.host}:${workdir}/eval_results.json`], dst: path.join(outDir, 'eval_results.json'), port: ro.port, key: ro.key });
      if (dryRun) {
        [scp, runEval, pull].forEach((c) => cli.log(`[dry-run] ${c.join(' ')}`));
        return { planned: true, tasks };
      }
      const results = {};
      let r1 = await cli.run(scp, { capture: true });
      results['上传脚本'] = r1.code === 0 ? 'ok' : 'fail';
      if (r1.code !== 0) { cli.warn('上传失败' + (r1.stderr ? ': ' + r1.stderr.trim() : '')); }
      else {
        cli.log('远端评测中（可能耗时较长）…');
        const r2 = await cli.run(runEval, { capture: false });
        results['远端评测'] = r2.code === 0 ? 'ok' : 'fail';
        if (r2.code === 0) {
          const r3 = await cli.run(pull, { capture: true });
          results['拉回结果'] = r3.code === 0 ? 'ok' : 'fail';
          if (r3.code === 0) cli.log(`结果 → ${path.join(outDir, 'eval_results.json')}`);
        }
      }
      await cli.writeJson(path.join(outDir, 'eval_report.json'), { ok: Object.values(results).every((v) => v === 'ok'), tasks, model: modelPath, results, created_at: cli.isoNow() });
      return { results, out_dir: outDir };
    }
    case 'report': {
      const metricsFile = args.metrics;
      const evalFile = args.eval;
      const out = args.out || path.join('out', 'charts', 'REPORT.md');
      let summary = null, alerts = [];
      if (metricsFile && cli.exists(metricsFile)) {
        const m = await cli.readJson(metricsFile);
        summary = m.summary; alerts = m.alerts || [];
      }
      let evalResults = null;
      if (evalFile && cli.exists(evalFile)) {
        const e = await cli.readJson(evalFile);
        evalResults = e.results || e;
      }
      if (!summary && !evalResults) cli.die('report 需要 --metrics 和/或 --eval 的 json 文件');
      const lines = ['# 训练监控与评测报告', '', `生成时间: ${cli.nowStamp()}`, ''];
      if (summary) {
        lines.push('## 训练指标', '');
        lines.push('| 指标 | 值 |', '| --- | --- |');
        const fmt = (v) => {
          if (typeof v !== 'number') return String(v);
          if (!isFinite(v)) return String(v);
          if (v === 0) return '0';
          if (Math.abs(v) < 0.0001) return v.toExponential(2);
          return +v.toFixed(4);
        };
        Object.entries(summary).forEach(([k, v]) => {
          if (v !== undefined && v !== null) lines.push(`| ${k} | ${fmt(v)} |`);
        });
        lines.push('');
        if (alerts.length) {
          lines.push('## 异常告警', '');
          alerts.slice(0, 20).forEach((a) => lines.push(`- **L${a.line} ${a.label}**: \`${a.text.slice(0, 100)}\``));
          lines.push('');
        }
      }
      if (evalResults) {
        lines.push('## 评测结果（lm-evaluation-harness）', '');
        lines.push('| task | acc | acc_norm |', '| --- | --- | --- |');
        Object.entries(evalResults).forEach(([task, m]) => {
          if (!m || typeof m !== 'object') return;
          const acc = m['acc,none'] !== undefined ? m['acc,none'] : (m.acc !== undefined ? m.acc : '');
          const accn = m['acc_norm,none'] !== undefined ? m['acc_norm,none'] : (m.acc_norm !== undefined ? m.acc_norm : '');
          lines.push(`| ${task} | ${acc} | ${accn} |`);
        });
        lines.push('');
      }
      lines.push('---', '由 dsh-llm-architect · llm_eval_monitor 生成');
      await cli.ensureDir(path.dirname(path.resolve(out)));
      await cli.writeText(out, lines.join('\n'));
      cli.log(`报告 → ${out}`);
      return { out };
    }
    default:
      cli.die(`未知子命令: ${sub}（--help 查看用法）`);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--json') {
    let req;
    try { req = JSON.parse(argv[1] || '{}'); }
    catch (e) { console.log(JSON.stringify({ ok: false, error: `--json 参数解析失败: ${e.message}` })); process.exit(1); }
    if (!req.subcommand) { console.log(JSON.stringify({ ok: false, error: '缺少 subcommand' })); process.exit(1); }
    try {
      const data = await dispatch(req.subcommand, req.args || {});
      console.log(JSON.stringify({ ok: true, data }, (k, v) => (k === 'points' && Array.isArray(v) ? `[${v.length} points]` : v)));
    } catch (e) {
      console.log(JSON.stringify({ ok: false, error: String(e && e.message || e) }));
      process.exit(1);
    }
    return;
  }
  const parsed = cli.parseArgs(argv);
  const sub = parsed._[0];
  const flags = parsed.flags;
  if (!sub || sub === 'help' || sub === '--help' || sub === '-h') { console.log(HELP); return; }
  if (sub === 'version' || sub === '-v') { console.log('llm_eval_monitor v0.1.0'); return; }
  if (flags.help === true) { console.log(HELP); return; }
  try { await dispatch(sub, flags); }
  catch (e) { cli.die(String(e && e.message || e)); }
}

main();
