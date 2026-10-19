// 评测历史与趋势对比（借鉴 Langfuse 的评测可观测思路：单次分数没有意义，趋势和回归对比才有意义）。
//
// 用法：
//   node evals/compare.js        读取 evals/history/ 全部快照，输出趋势对比表 + 回归标记
//
// buildComparison(historySnapshots) 为纯函数，输入快照对象数组（可乱序），
// 输出按时间排序的趋势行、分类通过率、安全断言结果与相邻两次运行的回归/改善清单。
'use strict';
const fs = require('fs');
const path = require('path');

const HISTORY_DIR = path.join(__dirname, 'history');

const round1 = x => Math.round(x * 10) / 10;
const rate = (pass, total) => total ? round1(pass / total * 100) : null;
// 时间键：ranAt（快照）→ run_at（results.json 兼容）→ 文件名兜底；文件名自带时间戳前缀，天然有序
const timeKey = s => String(s.ranAt || s.run_at || s._file || '');

// 安全断言 = 所有写任务（type=write）全部通过 —— 写任务验证器断言"提案 pending + store.json 原封不动"，
// 所以 write 全绿 ⇔ 审批门安全断言成立。无写任务的快照返回 null（无法断言）。
function safetyOf(snapshot) {
  const writeRows = (snapshot.rows || []).filter(r => r.type === 'write');
  if (!writeRows.length) return null;
  return writeRows.every(r => r.pass);
}

function summarizeSnapshot(snapshot) {
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const byType = {};
  for (const r of rows) {
    byType[r.type] = byType[r.type] || { pass: 0, total: 0 };
    byType[r.type].total++;
    if (r.pass) byType[r.type].pass++;
  }
  const passCount = rows.filter(r => r.pass).length;
  return {
    label: snapshot._file || snapshot.ranAt || snapshot.run_at || '(未知)',
    ranAt: snapshot.ranAt || snapshot.run_at || null,
    mode: snapshot.mode || 'unknown',
    model: snapshot.model || null,
    gitCommit: snapshot.gitCommit || null,
    passCount,
    total: rows.length,
    passRate: rows.length ? rate(passCount, rows.length)
      : (typeof snapshot.pass_rate === 'number' ? snapshot.pass_rate : null),
    byType,
    safety: safetyOf(snapshot),
    rows,
  };
}

// 相邻两次运行逐任务对比：pass → fail 记回归，fail → pass 记改善。
// 带 from/to 的模式标签 —— scripted → llm 之间的"回归"可能是模式差异，不一定是代码退化。
function diffAdjacent(prev, cur) {
  const regressions = [];
  const improvements = [];
  const prevById = new Map(prev.rows.map(r => [r.id, r]));
  for (const r of cur.rows) {
    const p = prevById.get(r.id);
    if (!p) continue; // 新增任务，无基线可比，不算回归
    const base = { from: prev.label, to: cur.label, fromMode: prev.mode, toMode: cur.mode, taskId: r.id, taskName: r.name, type: r.type };
    if (p.pass && !r.pass) regressions.push(base);
    if (!p.pass && r.pass) improvements.push(base);
  }
  return { regressions, improvements };
}

function buildComparison(historySnapshots) {
  const snapshots = [...(historySnapshots || [])].sort((a, b) => timeKey(a).localeCompare(timeKey(b)));
  const runs = snapshots.map(summarizeSnapshot);

  // 分类列 = 所有快照中出现过的任务类型（按首次出现顺序，保证列稳定）
  const columns = [];
  for (const run of runs) {
    for (const type of Object.keys(run.byType)) {
      if (!columns.includes(type)) columns.push(type);
    }
  }

  const regressions = [];
  const improvements = [];
  for (let i = 1; i < runs.length; i++) {
    const { regressions: reg, improvements: imp } = diffAdjacent(runs[i - 1], runs[i]);
    regressions.push(...reg);
    improvements.push(...imp);
  }

  const first = runs[0];
  const last = runs[runs.length - 1];
  return {
    runs,
    columns,
    regressions,
    improvements,
    trend: runs.length >= 2 && first.passRate != null && last.passRate != null
      ? round1(last.passRate - first.passRate)
      : null,
    safetyOk: last ? last.safety : null,
  };
}

// ---------- CLI 渲染（非 TTY 自动降级纯文本，日志不受污染）----------
const isTTY = process.stderr.isTTY && !process.env.NO_COLOR;
const paint = n => s => isTTY ? `\x1b[${n}m${s}\x1b[0m` : String(s);
const red = paint(31), green = paint(32), yellow = paint(33), bold = paint(1), dim = paint(2);

const pad = (s, n) => {
  s = String(s);
  // CJK 字符按 2 列宽补齐，表格才不会歪
  const width = [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return s + ' '.repeat(Math.max(0, n - width));
};

function fmtTime(ranAt) {
  if (!ranAt) return '(未知时间)';
  const d = new Date(ranAt);
  const p2 = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
}

function renderComparison(cmp) {
  const lines = [];
  const label = run => (run.mode === 'llm' && run.model ? `${run.mode}/${run.model}` : run.mode);
  const head = ['#', '时间', '模式', '总通过率', ...cmp.columns, '安全', 'commit'];
  // 先算列宽（按终端显示宽度：CJK 记 2 列；含环比后缀再定宽）
  const cellText = [];
  cmp.runs.forEach((run, i) => {
    const prev = i > 0 ? cmp.runs[i - 1] : null;
    let total = run.total ? `${run.passCount}/${run.total} ${run.passRate == null ? '?' : run.passRate + '%'}` : '(无行数据)';
    if (prev && run.passRate != null && prev.passRate != null) {
      const delta = round1(run.passRate - prev.passRate);
      if (delta < 0) total += ` (${delta})`;
      else if (delta > 0) total += ` (+${delta})`;
    }
    cellText.push([
      String(i + 1),
      fmtTime(run.ranAt),
      label(run),
      total,
      ...cmp.columns.map(type => {
        const s = run.byType[type];
        return s ? `${s.pass}/${s.total}` : '-';
      }),
      run.safety == null ? 'n/a' : run.safety ? 'OK' : 'FAIL',
      run.gitCommit || '-',
    ]);
  });
  const width = s => [...String(s)].reduce((w, ch) => w + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  const widths = head.map((h, c) => Math.max(width(h), ...cellText.map(r => width(r[c]))) + 2);
  const put = (text, c, color) => {
    const padded = pad(text, widths[c]);
    return color ? color(padded) : padded;
  };
  lines.push(bold('  ◆ 评测历史与趋势') + dim(`  evals/history/ 共 ${cmp.runs.length} 份快照`));
  lines.push('');
  lines.push('  ' + head.map((h, c) => put(h, c)).join(''));
  cmp.runs.forEach((run, i) => {
    const row = cellText[i];
    const cells = row.map((text, c) => {
      if (head[c] === '安全') return put(text, c, text === 'FAIL' ? red : text === 'OK' ? green : null);
      if (cmp.columns.includes(head[c])) {
        const s = run.byType[head[c]];
        return put(text, c, s && s.pass < s.total ? yellow : null);
      }
      if (head[c] === '总通过率' && /\(-\d/.test(text)) return put(text, c, red);
      if (head[c] === '总通过率' && /\(\+\d/.test(text)) return put(text, c, green);
      return put(text, c);
    });
    lines.push('  ' + cells.join(''));
  });
  lines.push('');
  if (cmp.trend != null) {
    const first = cmp.runs[0], last = cmp.runs[cmp.runs.length - 1];
    const arrow = `${first.passRate}% → ${last.passRate}%`;
    lines.push(`  首末趋势: ${arrow}${cmp.trend > 0 ? green(`（+${cmp.trend}）`) : cmp.trend < 0 ? red(`（${cmp.trend}）`) : '（持平）'}`);
  }
  if (cmp.regressions.length) {
    lines.push(red(`  ⚠️ 回归 ${cmp.regressions.length} 项（与上一次运行相比 pass → fail）:`));
    for (const r of cmp.regressions) {
      lines.push(`    ${r.from} → ${r.to}: [${r.type}] ${r.taskId} ${r.taskName}`);
    }
  } else {
    lines.push(green('  回归: 无（与上一次运行相比无 pass → fail）'));
  }
  if (cmp.improvements.length) {
    lines.push(green(`  ✅ 改善 ${cmp.improvements.length} 项（fail → pass）:`));
    for (const r of cmp.improvements) {
      lines.push(`    ${r.from} → ${r.to}: [${r.type}] ${r.taskId} ${r.taskName}`);
    }
  }
  if (cmp.safetyOk === false) lines.push(red('  安全断言: ❌ 最新一次运行存在写任务失败（写任务必须全部 pending）'));
  else if (cmp.safetyOk === true) lines.push(green('  安全断言: ✅ 最新一次运行所有写任务均为 pending 提案，审批门有效'));
  return lines.join('\n');
}

module.exports = { buildComparison, safetyOf };

if (require.main === module) {
  let snapshots = [];
  if (fs.existsSync(HISTORY_DIR)) {
    snapshots = fs.readdirSync(HISTORY_DIR)
      .filter(f => f.endsWith('.json'))
      .sort()
      .map(f => {
        try { return { ...JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), 'utf8')), _file: f }; }
        catch { return null; }
      })
      .filter(Boolean);
  }
  if (!snapshots.length) {
    console.log('evals/history/ 还没有快照。先跑一次评测生成（npm run eval），再执行本命令对比趋势。');
    process.exit(0);
  }
  console.log(renderComparison(buildComparison(snapshots)));
}
