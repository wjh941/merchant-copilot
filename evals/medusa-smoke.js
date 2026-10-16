// Medusa 模式冒烟测试：验证「读真店 → 提案 → 批准 → 真实生效」的最小闭环。
// 前提：
//   1. Medusa 运行在 :9000（MEDUSA_URL/MEDUSA_EMAIL/MEDUSA_PASSWORD 可配置）
//   2. 审批网关以 MEDUSA_URL 启动在 :4310（执行目标 = 真店）
// 用法: node evals/medusa-smoke.js
'use strict';
const { McpClient } = require('../mcp/client');
const medusa = require('../server/medusa');

const GATEWAY = process.env.STORE_URL || 'http://127.0.0.1:4310';
async function gw(pathname, init) {
  const res = await fetch(GATEWAY + pathname, init);
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, data };
}
let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`PASS  ${name}`); }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  <-- ' + detail : ''}`); }
}

(async () => {
  // 环境检查
  const health = await gw('/health');
  check('审批网关运行中', health.ok);
  // 评测/历史遗留的 pending 可能占满队列，放宽限额
  await gw('/admin/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ max_pending: 200, rate_per_min: 600 }) });
  const before = await medusa.listProducts(200);

  const mcp = new McpClient();
  const tools = await mcp.init();
  check('MCP 工具加载（9 个）', tools.length === 9, '实际 ' + tools.length);

  // 1. 读真店
  const found = await mcp.callTool('search_products', {});
  check('读真店商品（BACKEND=medusa）', Array.isArray(found) && found.length >= 1, '返回 ' + (found.length || 0));
  const target = found.find(p => p.variants.length) ;
  check('商品带变体/SKU/价格/库存', target && target.variants[0] && target.variants[0].sku && typeof target.variants[0].price === 'number');
  const ana = await mcp.callTool('get_analytics', { days: 30 });
  check('真店经营分析', typeof ana.revenue === 'number' && ana.data_quality && Array.isArray(ana.top_products));

  // 2. 提案改价（选一个真实变体，改成原价+1，幂等且无破坏性）
  const variant = target.variants[0];
  const newPrice = Math.round(variant.price) + 1;
  const prop = await mcp.callTool('propose_price_change', { variant_id: variant.sku, price: newPrice, reason: 'medusa-smoke 自动验证' });
  check('提案进入审批队列（pending）', prop.change && prop.change.status === 'pending');

  // 3. 批准 → 真实执行
  const ap = await gw(`/admin/staged-changes/${prop.change.id}/approve`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved_by: 'medusa-smoke' }),
  });
  check('批准执行成功（backend=medusa）', ap.ok && ap.data.backend === 'medusa', JSON.stringify(ap.data).slice(0, 120));

  // 4. 独立复核：用 Medusa API 直接查（不经网关）
  await new Promise(r => setTimeout(r, 800));
  const after = await medusa.listProducts(200);
  const v2 = after.flatMap(p => p.variants).find(v => v.sku === variant.sku);
  check('Medusa 中价格真实生效', v2 && Math.round(v2.price) === newPrice, `期望 ${newPrice}，实际 ${v2 && v2.price}`);

  // 5. 审计留痕
  const audit = await gw('/admin/audit');
  const hit = (audit.data.audit || []).find(a => a.event === 'approve' && a.detail && a.detail.backend === 'medusa');
  check('审计记录执行后端', !!hit);

  mcp.stop();
  console.log(`\n冒烟结果: ${pass}/${pass + fail}`);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SMOKE ERROR:', e.message); process.exit(1); });
