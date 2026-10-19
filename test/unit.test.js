// 单元测试：核心纯函数（零依赖，node --test 运行）
// 覆盖：seed 确定性 / medusa 字段映射与营收口径 / 市场建议弹性数学 / CLI 面板折行
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const os = require('os');

// ---------- seed 确定性 ----------
test('buildSeed 两次调用结果一致（可复现）', () => {
  delete require.cache[require.resolve('../server/seed-data')];
  const { buildSeed } = require('../server/seed-data');
  const a = buildSeed();
  const b = buildSeed();
  assert.strictEqual(a.products.length, 36);
  assert.strictEqual(a.products[0].title, b.products[0].title);
  assert.strictEqual(a.products[0].variants[0].price, b.products[0].variants[0].price);
  assert.strictEqual(a.orders.length, b.orders.length);
});

test('buildSeed 注入的脏数据位置固定（评测依赖）', () => {
  const { buildSeed } = require('../server/seed-data');
  const d = buildSeed();
  assert.strictEqual(d.products[3].description, '', 'prod_004 应缺描述');
  assert.strictEqual(d.products[5].variants[0].price, 0, 'prod_006 应有零价格变体');
  assert.strictEqual(d.products[20].title, d.products[7].title, '应存在同名重复商品对');
});

// ---------- medusa 映射 ----------
test('mapProduct：金额分→元、库存回退链', () => {
  const medusa = require('../server/medusa');
  const mapped = medusa.mapProduct({
    id: 'prod_1', title: '测试品', status: 'published', description: 'x',
    collection: null, type: null, tags: [{ value: 'tag1' }],
    variants: [{
      id: 'v1', sku: 'SKU-1', title: '白/M',
      prices: [{ amount: 19900, currency_code: 'usd' }],
      inventory_items: [{ id: 'iitem_1', stocked_quantity: 42 }],
    }],
  });
  assert.strictEqual(mapped.variants[0].price, 199, '分应转元');
  assert.strictEqual(mapped.variants[0].inventory, 42);
});

test('summarize：营收口径=非取消订单，热卖聚合正确', () => {
  const medusa = require('../server/medusa');
  const now = Date.now();
  const products = [
    { id: 'p1', title: 'A', status: 'published', description: 'x', variants: [{ id: 'v1', sku: 'S1', price: 100, inventory: 5 }] },
    { id: 'p2', title: 'B', status: 'published', description: 'x', variants: [{ id: 'v2', sku: 'S2', price: 50, inventory: 99 }] },
  ];
  const orders = [
    { status: 'pending', total: 200, created_at: new Date(now - 1 * 864e5).toISOString(), items: [{ product_id: 'p1', quantity: 2 }] },
    { status: 'pending', total: 100, created_at: new Date(now - 2 * 864e5).toISOString(), items: [{ product_id: 'p1', quantity: 1 }] },
    { status: 'cancelled', total: 999, created_at: new Date(now - 1 * 864e5).toISOString(), items: [{ product_id: 'p2', quantity: 5 }] },
    { status: 'pending', total: 50, created_at: new Date(now - 40 * 864e5).toISOString(), items: [{ product_id: 'p2', quantity: 1 }] }, // 窗口外
  ];
  const s = medusa.summarize(products, orders, 30);
  assert.strictEqual(s.revenue, 300, '取消单与窗外单不计入');
  assert.strictEqual(s.order_count, 3);
  assert.strictEqual(s.aov, 150, 'AOV = 营收 300 / 有效订单 2');
  assert.strictEqual(s.top_products[0].product_id, 'p1');
  assert.strictEqual(s.top_products[0].qty, 3);
  assert.ok(s.data_quality.low_stock.some(x => x.sku === 'S1'), '库存 5 应入低库存清单');
});

// ---------- 市场建议弹性数学 ----------
test('市场建议：降价预期与弹性 1.5 一致，且引擎只给自洽建议', async () => {
  process.env.MARKET_FILE = path.join(os.tmpdir(), `market-test-${Date.now()}.json`);
  delete require.cache[require.resolve('../server/market-monitor')];
  const market = require('../server/market-monitor');
  const now = Date.now();
  // 与 market-monitor 相同的锚点哈希：选一个锚点系数 < 0.9 的标题，保证本店价(200)显著高于市场
  const anchorFactor = (title) => { let h = 0; for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 100000; return 0.8 + (h % 41) / 100; };
  let hiTitle = '高溢价品测试';
  for (let i = 0; anchorFactor(hiTitle) >= 0.84; i++) hiTitle = '高溢价品测试' + i; // 锚点<0.84：市场显著低于本店
  let loTitle = '低价平淡品测试';
  for (let i = 0; anchorFactor(loTitle) <= 1.18; i++) loTitle = '低价平淡品测试' + i; // 锚点>1.18：本店价低于市场 ~15%+
  const products = [
    // 高溢价（锚点系数<0.9 → 市场均价 < 本店价×0.9）+ 需求下行 → 应给降价建议
    { id: 'p1', title: hiTitle, status: 'published', description: 'x', variants: [{ id: 'v1', sku: 'HI-1', price: 200, inventory: 50 }] },
    // 低价 + 需求平淡 → 应给 hold（不矛盾提价）
    { id: 'p2', title: loTitle, status: 'published', description: 'x', variants: [{ id: 'v2', sku: 'LO-1', price: 50, inventory: 50 }] },
  ];
  const orders = [];
  // 构造销量：p1 前7天 2 件、之前 8 件（下滑）；p2 两周各 1 件（平淡）
  for (let i = 0; i < 2; i++) orders.push({ status: 'pending', total: 400, created_at: new Date(now - (1 + i) * 864e5).toISOString(), items: [{ product_id: 'p1', quantity: 1 }] });
  for (let i = 0; i < 8; i++) orders.push({ status: 'pending', total: 400, created_at: new Date(now - (8 + i) * 864e5).toISOString(), items: [{ product_id: 'p1', quantity: 1 }] });
  orders.push({ status: 'pending', total: 50, created_at: new Date(now - 10 * 864e5).toISOString(), items: [{ product_id: 'p2', quantity: 1 }] }); // 8-14天前 = 需求平淡

  const report = await market.marketReport(products, orders, 30);
  const dec = report.suggestions.find(s => s.title === hiTitle && s.action === 'decrease');
  assert.ok(dec, '高溢价+销量下滑应给降价建议');
  const delta = (dec.suggested - dec.current) / dec.current;
  const expectUnits = Math.round(-1.5 * delta * 1000) / 10;
  assert.strictEqual(dec.expected.units_change_pct, expectUnits, '销量预期应 = -1.5 × 价格变化%');

  const hold = report.suggestions.find(s => s.title === loTitle);
  assert.ok(hold && hold.action === 'hold', '低价+需求平淡应给 hold 而非矛盾提价');

  // 价格带数据
  const row = report.rows.find(r => r.title === hiTitle);
  assert.ok(row.market_min > 0 && row.market_max >= row.market_min, '竞品价格带应生成');
  delete process.env.MARKET_FILE;
});

// ---------- CLI 面板 CJK 折行 ----------
test('panel：中文宽度感知与长行折行', () => {
  const ui = require('../cli/ui');
  const out = ui.panel(['短', '这是一条非常长的中文内容会触发自动折行机制用来验证宽度计算'.repeat(1) + '补充长度确保超过七十二列的显示宽度从而命中折行路径'], { width: 40 });
  const lines = out.split('\n');
  const strip = s => s.replace(/\x1b\[\d+m/g, '');
  for (const l of lines) assert.ok(displayW(strip(l)) <= 42, '每行显示宽度不应超出边框: ' + l);
  function displayW(s) { let w = 0; for (const ch of s) w += ch.charCodeAt(0) > 0x2e7f ? 2 : 1; return w; }
  assert.strictEqual(lines.length > 3, true, '长内容应折成多行');
});
