// 给真 Medusa 店铺灌演示订单（草稿单 → convert-to-order）。
// 用法: node server/medusa-orders-seed.js [数量]   默认 12 笔
'use strict';
const medusa = require('./medusa');

(async () => {
  const count = Number(process.argv[2]) || 12;
  const regions = (await medusa.api('/admin/regions')).regions;
  const ch = (await medusa.api('/admin/sales-channels')).sales_channels[0];
  const products = await medusa.listProducts(100);
  if (!products.length) { console.error('店铺没有商品，先跑 medusa-seed.js'); process.exit(1); }

  let ok = 0;
  for (let i = 0; i < count; i++) {
    const picks = [];
    const n = 1 + Math.floor(Math.random() * 2);
    for (let k = 0; k < n; k++) {
      const p = products[Math.floor(Math.random() * products.length)];
      const v = p.variants[Math.floor(Math.random() * p.variants.length)];
      // 跳过没库存的变体（建单会预留库存）
      if (v.inventory < 1) continue;
      picks.push({ variant_id: v.id, quantity: 1 + Math.floor(Math.random() * 2) });
    }
    if (!picks.length) continue;
    try {
      const r = await medusa.api('/admin/draft-orders', {
        method: 'POST',
        body: JSON.stringify({
          region_id: regions[0].id,
          sales_channel_id: ch.id,
          email: `demo${i}@merchant.local`,
          items: picks,
          shipping_address: { first_name: 'Demo', last_name: String(i), address_1: 'Test Road ' + i, city: 'Guangzhou', country_code: 'cn', postal_code: '510000' },
        }),
      });
      const d = r.draft_order || r.order;
      const done = await medusa.api('/admin/draft-orders/' + d.id + '/convert-to-order', { method: 'POST', body: '{}' });
      const o = done.order || {};
      ok++;
      console.log(`✅ #${o.display_id} ${o.id} status=${o.status} total=${o.total}`);
    } catch (e) {
      console.log(`❌ 第${i + 1}笔: ${String(e.message).slice(0, 100)}`);
    }
  }
  const orders = await medusa.listOrders(500);
  console.log(`\n完成: 本轮 +${ok}，店铺现有订单 ${orders.length} 笔`);
})().catch(e => { console.error(e.message); process.exit(1); });
