// buildComparison 纯函数测试：趋势计算 + 回归检测（node:test，零依赖，node --test 运行）
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const { buildComparison, safetyOf } = require('./compare');

// ---- 构造假快照的小工具 ----
const row = (id, type, name, pass) => ({ id, type, name, pass });
const snap = (ranAt, mode, rows, extra = {}) => ({ ranAt, mode, rows, ...extra });

const BASE_ROWS = [
  row('q1', 'query', '在售商品数', true),
  row('a1', 'analysis', '近7天营收', true),
  row('w1', 'write', '修复零价格', true),
  row('w2', 'write', '指定变体改价', true),
  row('x1', 'long', '全量修零价格', true),
];

test('趋势计算：逐快照通过率、分类通过率、安全断言与首末趋势', () => {
  const later = BASE_ROWS.map(r => r.id === 'w1' ? row('w1', 'write', '修复零价格', false) : r); // 回归：write 掉一个
  const cmp = buildComparison([
    snap('2026-10-16T07:30:00Z', 'scripted', BASE_ROWS, { gitCommit: 'abc1234' }),
    snap('2026-10-16T08:00:00Z', 'scripted', later, { gitCommit: 'def5678' }),
  ]);

  assert.equal(cmp.runs.length, 2);
  // 第一次：5/5 = 100%
  assert.equal(cmp.runs[0].passCount, 5);
  assert.equal(cmp.runs[0].total, 5);
  assert.equal(cmp.runs[0].passRate, 100);
  assert.equal(cmp.runs[0].safety, true);
  // 第二次：4/5 = 80%
  assert.equal(cmp.runs[1].passRate, 80);
  assert.equal(cmp.runs[1].safety, false); // 写任务有 fail → 安全断言不成立
  assert.equal(cmp.trend, -20); // 100 → 80
  // 分类通过率
  assert.deepEqual(cmp.runs[1].byType.write, { pass: 1, total: 2 });
  assert.deepEqual(cmp.runs[0].byType.query, { pass: 1, total: 1 });
  // 分类列 = 出现过的类型，按首次出现顺序
  assert.deepEqual(cmp.columns, ['query', 'analysis', 'write', 'long']);
  // 快照元数据透传
  assert.equal(cmp.runs[0].gitCommit, 'abc1234');
  assert.equal(cmp.runs[0].mode, 'scripted');
});

test('输入乱序也能按时间正确排序（趋势的方向不能靠数组顺序赌运气）', () => {
  const cmp = buildComparison([
    snap('2026-10-17T02:00:00Z', 'scripted', BASE_ROWS),
    snap('2026-10-16T02:00:00Z', 'scripted', BASE_ROWS.map(r => ({ ...r, pass: r.id !== 'q1' }))),
  ]);
  assert.equal(cmp.runs[0].ranAt, '2026-10-16T02:00:00Z');
  assert.equal(cmp.runs[0].passRate, 80);
  assert.equal(cmp.runs[1].passRate, 100);
  assert.equal(cmp.trend, 20); // 80 → 100，方向正确
  // 不改变入参顺序（纯函数）
  assert.equal(cmp.runs.length, 2);
});

test('回归检测：任务从 pass 变 fail 被标出（含任务名与类型）', () => {
  const cmp = buildComparison([
    snap('2026-10-16T07:30:00Z', 'scripted', BASE_ROWS),
    snap('2026-10-16T08:00:00Z', 'llm', [
      ...BASE_ROWS.filter(r => r.id !== 'w1'),
      row('w1', 'write', '修复零价格', false),
    ], { model: 'glm-4-flash' }),
  ]);
  assert.equal(cmp.regressions.length, 1);
  const reg = cmp.regressions[0];
  assert.equal(reg.taskId, 'w1');
  assert.equal(reg.taskName, '修复零价格');
  assert.equal(reg.type, 'write');
  assert.equal(reg.fromMode, 'scripted');
  assert.equal(reg.toMode, 'llm'); // 模式切换间的"回归"要能看出来
  assert.equal(reg.to, '2026-10-16T08:00:00Z');
});

test('改善不算回归：fail → pass 只进 improvements', () => {
  const cmp = buildComparison([
    snap('2026-10-16T07:30:00Z', 'scripted', BASE_ROWS.map(r => ({ ...r, pass: r.id !== 'q1' }))),
    snap('2026-10-16T08:00:00Z', 'scripted', BASE_ROWS),
  ]);
  assert.deepEqual(cmp.regressions, []);
  assert.equal(cmp.improvements.length, 1);
  assert.equal(cmp.improvements[0].taskId, 'q1');
});

test('新增任务与消失任务都不算回归（无基线可比）', () => {
  const cmp = buildComparison([
    snap('2026-10-16T07:30:00Z', 'scripted', BASE_ROWS),
    snap('2026-10-16T08:00:00Z', 'scripted', [
      ...BASE_ROWS,
      row('q9', 'query', '新任务', false), // 新增且失败：不是回归
    ]),
  ]);
  assert.deepEqual(cmp.regressions, []);
});

test('安全断言：写任务全 pass 才算成立；无写任务返回 null（无法断言）', () => {
  assert.equal(safetyOf({ rows: [row('w1', 'write', 'a', true), row('w2', 'write', 'b', true)] }), true);
  assert.equal(safetyOf({ rows: [row('w1', 'write', 'a', true), row('w2', 'write', 'b', false)] }), false);
  assert.equal(safetyOf({ rows: [row('q1', 'query', 'c', true)] }), null);
  // safetyOk 只看最新一次运行
  const cmp = buildComparison([
    snap('2026-10-16T07:30:00Z', 'scripted', [row('w1', 'write', 'a', false)]),
    snap('2026-10-16T08:00:00Z', 'scripted', [row('w1', 'write', 'a', true)]),
  ]);
  assert.equal(cmp.safetyOk, true);
  assert.equal(cmp.improvements[0].taskId, 'w1'); // 修好记改善
});

test('边界：空历史 / 单次快照不抛错，趋势与回归为空', () => {
  const empty = buildComparison([]);
  assert.deepEqual(empty, {
    runs: [], columns: [], regressions: [], improvements: [],
    trend: null, safetyOk: null,
  });

  const single = buildComparison([snap('2026-10-16T07:30:00Z', 'scripted', BASE_ROWS)]);
  assert.equal(single.runs.length, 1);
  assert.equal(single.trend, null);
  assert.deepEqual(single.regressions, []);
  assert.equal(single.safetyOk, true);
});

test('缺失 rows 的快照兜底用 pass_rate（与 results.json 旧格式兼容）', () => {
  const cmp = buildComparison([
    { ranAt: '2026-10-16T07:30:00Z', mode: 'scripted', pass_rate: 95.7, rows: [] },
  ]);
  assert.equal(cmp.runs[0].passRate, 95.7);
});
