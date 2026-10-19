// 评测 runner：跑 20 个运营任务，用确定性验证器打分。
//
// 用法：
//   node evals/run-evals.js                脚本化基线，单轮
//   node evals/run-evals.js --llm          LLM 模式（需 LLM_API_KEY）
//   node evals/run-evals.js --llm --runs 3 LLM 模式跑 3 轮取均值（每轮前重置演示数据，需 server 在跑）
'use strict';
const { style } = require('../cli/ui');
const passMark = () => process.stderr.isTTY && !process.env.NO_COLOR ? '[32m' : '';
const failMark = () => process.stderr.isTTY && !process.env.NO_COLOR ? '[31m' : '';
const dimMark = () => process.stderr.isTTY && !process.env.NO_COLOR ? '[2m' : '';
const resetMark = () => process.stderr.isTTY && !process.env.NO_COLOR ? '[0m' : '';
const fs = require('fs');
const path = require('path');
const { McpClient } = require('../mcp/client');
const { buildTasks } = require('./tasks');
const { computeGroundTruth } = require('./ground-truth');

const MODE = process.argv.includes('--llm') ? 'llm' : 'scripted';
const RUNS = Math.max(1, Number(process.argv[process.argv.indexOf('--runs') + 1]) || 1);
const STORE = process.env.STORE_URL || 'http://127.0.0.1:4310';

async function resetServer() {
  try {
    // 先关营业模拟（保证 ground truth 确定），放宽限额（长程任务单轮会提 20+ 个案），再重置数据。
    // 关模拟后必须【验证】确实关了——浏览器里开着的运营台可能把模拟重新打开（真实的测试污染源）。
    for (let i = 0; i < 3; i++) {
      await fetch(STORE + '/admin/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: false }) }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
      const chk = await fetch(STORE + '/admin/sim').then(r => r.json()).catch(() => null);
      if (chk && chk.on === false) break;
    }
    await fetch(STORE + '/admin/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_pending: 200, rate_per_min: 600 }) }).catch(() => {});
    const res = await fetch(STORE + '/admin/reset', { method: 'POST' });
    return res.ok;
  } catch { return false; }
}

async function runOnce(gt, tasks, mcp, runLlmTask, label) {
  const rows = [];
  for (const task of tasks) {
    const ctx = { results: {} };
    let error = null;
    let meta = { steps: 0, ms: 0, tokens: 0, proposes: 0, answer: '' };
    const t0 = Date.now();

    if (MODE === 'scripted') {
      try {
        for (const step of task.steps) {
          const args = typeof step.args === 'function' ? step.args(ctx) : step.args;
          const result = await mcp.callTool(step.tool, args);
          if (step.save) ctx.results[step.save] = result;
          meta.steps++;
          if (step.tool.startsWith('propose_')) meta.proposes++;
        }
      } catch (e) { error = e.message; }
    } else {
      try {
        const { answer, trace, usage } = await runLlmTask({ mcp, taskText: task.instruction });
        Object.assign(ctx.results, task.capture ? task.capture(trace) : {});
        meta = {
          steps: trace.length,
          tokens: usage.prompt_tokens + usage.completion_tokens,
          proposes: trace.filter(t => t.ok && t.tool.startsWith('propose_')).length,
          answer: (answer || '').slice(0, 60),
        };
      } catch (e) { error = e.message; }
    }
    meta.ms = Date.now() - t0;

    const verdict = error ? { pass: false, why: '执行失败: ' + error } : task.verify(ctx);
    // 安全观察项：查询/分析任务里出现提案 = agent 多余的写行为（长程任务本就是"扫描+提案"，不算多余）
    const stray = (task.type === 'query' || task.type === 'analysis') ? meta.proposes : 0;
    rows.push({
      id: task.id, type: task.type, name: task.name, pass: verdict.pass, why: verdict.why,
      steps: meta.steps, tokens: meta.tokens, ms: meta.ms, proposes: meta.proposes, stray, answer: meta.answer,
    });
    const mark = verdict.pass ? passMark() + 'PASS' + resetMark() : failMark() + 'FAIL' + resetMark();
    console.log(`${mark}  ${dimMark()}[${label}]${resetMark()} ${task.id} ${task.name.padEnd(8)}  ${dimMark()}steps=${meta.steps} tok=${meta.tokens} ${meta.ms}ms${resetMark()}${stray ? `  ⚠️ 查询任务出现${stray}次提案` : ''}${verdict.pass ? '' : '  <-- ' + verdict.why}`);
  }
  return rows;
}

function summarize(rows) {
  const byType = {};
  for (const r of rows) {
    byType[r.type] = byType[r.type] || { total: 0, pass: 0 };
    byType[r.type].total++;
    if (r.pass) byType[r.type].pass++;
  }
  const passCount = rows.filter(r => r.pass).length;
  const avg = arr => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
  return {
    passCount, byType, rows,
    pass_rate: +(passCount / rows.length * 100).toFixed(1),
    avg_steps: +avg(rows.map(r => r.steps)).toFixed(1),
    avg_tokens: Math.round(avg(rows.map(r => r.tokens))),
    total_tokens: rows.reduce((s, r) => s + r.tokens, 0),
  };
}

(async () => {
  const mcp = new McpClient();
  const tools = await mcp.init();
  console.log(`评测开始 [${MODE}]: 20 个任务 × ${RUNS} 轮, MCP 工具 ${tools.length} 个\n`);

  let runLlmTask = null;
  if (MODE === 'llm') {
    ({ runLlmTask } = require('../agent/llm-agent'));
    if (!process.env.LLM_API_KEY) { console.error('缺少 LLM_API_KEY 环境变量（LLM 模式需要）。'); process.exit(1); }
  }

  const allRuns = [];
  let tasks = null;
  for (let i = 0; i < RUNS; i++) {
    const label = `#${i + 1}`;
    // 关键顺序：先关模拟+重置数据，再算 ground truth —— 否则 GT 与重置后的数据错位
    const ok = await resetServer();
    if (RUNS > 1) console.log(`—— 第 ${i + 1}/${RUNS} 轮（关模拟+重置演示数据${ok ? ' ✅' : ' ⚠️ server 不在跑，数据未重置'}）`);
    else if (!ok) console.log('⚠️ server 不在跑，数据未重置（假设数据已是干净种子）');
    const gt = computeGroundTruth();
    tasks = buildTasks(gt);
    const rows = await runOnce(gt, tasks, mcp, runLlmTask, label);
    allRuns.push(rows);
    const s = summarize(rows);
    console.log(`—— ${label} 通过率 ${s.passCount}/${rows.length}（${s.pass_rate}%）\n`);
  }
  mcp.stop();

  const stats = allRuns.map(summarize);
  const last = stats[stats.length - 1];
  const rates = stats.map(s => s.pass_rate);
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const spread = Math.max(...rates) - Math.min(...rates);

  console.log('');
  console.log(style.bold('  ◆ 成绩单') + style.gray(`  ${MODE}${RUNS > 1 ? ` × ${RUNS} 轮` : ''}`));
  console.log(`  总通过率  ${style.bold(String(last.passCount) + '/' + tasks.length)}  ${style.gray(`(${last.pass_rate}%)`)}${RUNS > 1 ? '   ' + style.gray(`${RUNS} 轮均值 ${mean.toFixed(1)}% ± ${spread.toFixed(1)}`) : ''}`);
  console.log('');
  for (const [type, s] of Object.entries(last.byType)) console.log(`  ${type.padEnd(9)} ${s.pass}/${s.total}`);
  if (MODE === 'llm') {
    console.log(`平均工具调用/任务: ${last.avg_steps}  平均 tokens/任务: ${last.avg_tokens}  总 tokens: ${last.total_tokens}`);
    const strayTotal = last.rows.reduce((s, r) => s + r.stray, 0);
    console.log(`安全观察: 查询/分析任务中的多余提案 ${strayTotal} 次${strayTotal === 0 ? '（✅ 无）' : ''}`);
  }

  const resultPayload = {
    run_at: new Date().toISOString(), mode: MODE, runs: RUNS,
    model: process.env.LLM_MODEL || null,
    pass_rate: last.pass_rate,
    mean_pass_rate: RUNS > 1 ? +mean.toFixed(1) : null,
    spread: RUNS > 1 ? +spread.toFixed(1) : null,
    by_type: last.byType,
    avg_steps: last.avg_steps, avg_tokens: last.avg_tokens, total_tokens: last.total_tokens,
    runs: RUNS > 1 ? stats.map(s => s.pass_rate) : undefined,
    rows: last.rows,
  };
  const out = path.join(__dirname, MODE === 'llm'
    ? `results-llm${process.env.LLM_MODEL ? '-' + String(process.env.LLM_MODEL).replace(/[^a-zA-Z0-9.-]+/g, '_') : ''}.json`
    : 'results.json');
  fs.writeFileSync(out, JSON.stringify(resultPayload, null, 1), 'utf8');
  console.log(`\n结果已写入 ${out}`);

  // 历史快照（Langfuse 式评测可观测：单次分数无意义，趋势与回归对比才有意义）。
  // 只追加不覆盖；含时间戳/模式/commit，本地趋势数据不入库（evals/history/ 已 gitignore）。
  const historyDir = path.join(__dirname, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  const d = new Date();
  const p2 = n => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const gitCommit = (() => {
    try {
      return require('child_process').execSync('git rev-parse --short HEAD', { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    } catch { return null; }
  })();
  const snapshotName = `${stamp}-${MODE}.json`;
  fs.writeFileSync(path.join(historyDir, snapshotName), JSON.stringify({
    ...resultPayload, ranAt: d.toISOString(), gitCommit,
  }, null, 1), 'utf8');
  console.log(`历史快照已追加 evals/history/${snapshotName}（趋势对比: npm run eval:compare）`);

  const writeChecks = last.rows.filter(r => r.type === 'write');
  console.log(writeChecks.every(r => r.pass)
    ? '安全断言: ✅ 所有写任务均为 pending 提案，原始数据未被修改（审批门有效）'
    : '安全断言: ❌ 存在写任务失败，需排查（见上方 FAIL 行）');
})().catch(e => { console.error(e); process.exit(1); });
