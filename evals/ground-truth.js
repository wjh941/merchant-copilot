// 独立 ground truth：直接从 data/store.json 原始数据计算，
// 与 server 的 analytics 接口互为独立实现（避免循环验证）。
'use strict';
const fs = require('fs');
const path = require('path');

function freshDb() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'store.json'), 'utf8'));
}

function computeGroundTruth() {
  const db = freshDb();
  const published = db.products.filter(p => p.status === 'published');

  // 与 server 相同的窗口规则（>= now - days*864e5）
  const inWindow = (days) => db.orders.filter(o => new Date(o.created_at).getTime() >= Date.now() - days * 864e5);
  const round2 = x => Math.round(x * 100) / 100;

  const gt = { db };

  gt.published_count = published.length;
  gt.draft_count = db.products.length - published.length;
  gt.pending_orders = db.orders.filter(o => o.status === 'pending');
  gt.pending_count = gt.pending_orders.length;
  gt.pending_total = round2(gt.pending_orders.reduce((s, o) => s + o.total, 0));

  gt.revenue_7d = round2(inWindow(7).filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0));
  gt.revenue_30d = round2(inWindow(30).filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0));
  gt.order_count_30d = inWindow(30).length;
  const completed30 = inWindow(30).filter(o => o.status === 'completed');
  gt.aov_30d = round2(completed30.length ? gt.revenue_30d / completed30.length : 0);

  const qty = {};
  for (const o of completed30) for (const it of o.items) qty[it.product_id] = (qty[it.product_id] || 0) + it.quantity;
  const top = Object.entries(qty).sort((a, b) => b[1] - a[1])[0];
  gt.top_product = top && { product_id: top[0], qty: top[1], title: (db.products.find(p => p.id === top[0]) || {}).title };

  // 数据质量
  gt.zero_price = [];
  gt.low_stock = [];
  gt.missing_desc = [];
  for (const p of published) {
    if (!p.description) gt.missing_desc.push({ id: p.id, title: p.title });
    for (const v of p.variants) {
      if (v.inventory < 10) gt.low_stock.push({ product: p.title, variant_id: v.id, sku: v.sku, inventory: v.inventory });
      if (v.price <= 0) gt.zero_price.push({ product: p.title, product_id: p.id, variant_id: v.id, sku: v.sku });
    }
  }

  // 动态参数：取一条真实订单作为查询任务样本
  gt.sample_order = [...db.orders].sort((a, b) => b.created_at.localeCompare(a.created_at))[10];
  // 一个用于改价任务的商品/变体（正常价格的第一个变体）
  const wp = published.find(p => p.variants.every(v => v.price > 0) && p.variants.length >= 2);
  gt.price_task = { product_id: wp.id, title: wp.title, variants: wp.variants.map(v => ({ id: v.id, sku: v.sku, price: v.price })) };
  // 同名重复商品对
  const byTitle = {};
  for (const p of db.products) (byTitle[p.title] = byTitle[p.title] || []).push(p);
  gt.dup_pair = Object.values(byTitle).find(list => list.length >= 2);

  // 滞销品：近14天零销量（已完成订单）且总库存 > 60 的在售商品
  const twoWeeksAgo = Date.now() - 14 * 864e5;
  const soldProducts = new Set();
  for (const o of db.orders) {
    if (o.status !== 'completed' || new Date(o.created_at).getTime() < twoWeeksAgo) continue;
    for (const it of o.items) soldProducts.add(it.product_id);
  }
  gt.stale = published
    .filter(p => !soldProducts.has(p.id) && p.variants.reduce((s, v) => s + v.inventory, 0) > 60)
    .map(p => ({ id: p.id, title: p.title, variants: p.variants.map(v => ({ id: v.id, sku: v.sku, price: v.price })) }));
  return gt;
}

module.exports = { computeGroundTruth, freshDb };
