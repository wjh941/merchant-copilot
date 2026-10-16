// 确定性仿真数据生成（固定种子 LCG）——被 seed.js（CLI）和 store-server.js（/admin/reset）共用。
// 故意注入真实世界常见的脏数据：缺描述、零价格变体、低库存、同名重复商品。
'use strict';

// ---------- 确定性随机 ----------
let _s = 20260101;
function rnd() { _s = (_s * 1103515245 + 12345) % 2147483648; return _s / 2147483648; }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function ri(min, max) { return min + Math.floor(rnd() * (max - min + 1)); }

function buildSeed() {
  _s = 20260101; // 每次重建都从同一起点开始，保证可复现

  const CATEGORIES = ['连衣裙', 'T恤', '外套', '裤装', '配饰', '鞋靴'];
  const ADJ = ['云朵', '晚风', '初雪', '仲夏', '山雾', '麦浪', '星野', '青柠', '雾凇', '白鹭', '拾光', '栖岸'];
  const NOUN = ['衬衫', '连衣裙', '卫衣', '牛仔裤', '休闲裤', '针织开衫', '羽绒服', '帆布鞋', '腰带', '贝雷帽', '半身裙', '短靴'];
  const SIZES = ['S', 'M', 'L', 'XL'];
  const COLORS = ['米白', '黑色', '雾蓝', '燕麦', '咖色'];

  const products = [];
  const usedTitles = new Set();
  let skuSeq = 1000;

  for (let i = 0; i < 36; i++) {
    const cat = CATEGORIES[i % CATEGORIES.length];
    let title;
    if (i === 20) {
      // 注入脏数据：与 products[7] 完全同名的商品（真实店里合并/重复上架常见）
      title = products[7].title;
    } else {
      title = `${pick(ADJ)}${pick(NOUN)}`;
      while (usedTitles.has(title)) title = `${pick(ADJ)}${pick(NOUN)}`;
    }
    usedTitles.add(title);

    const p = {
      id: `prod_${String(i + 1).padStart(3, '0')}`,
      title,
      category: cat,
      status: i === 33 ? 'draft' : 'published', // 1 个未上架
      description: `${title}，${cat}品类经典款。面料舒适，版型百搭，适合日常与通勤场景。`,
      tags: [cat, pick(['新品', '热卖', '清仓', '基础款'])],
      created_at: new Date(Date.now() - ri(30, 300) * 864e5).toISOString(),
      variants: [],
    };
    const vCount = ri(1, 4);
    for (let v = 0; v < vCount; v++) {
      p.variants.push({
        id: `variant_${skuSeq}`,
        sku: `SKU-${skuSeq++}`,
        title: `${pick(COLORS)} / ${pick(SIZES)}`,
        price: ri(6, 40) * 10 + 9,
        inventory: ri(0, 220),
      });
    }
    products.push(p);
  }

  // ---- 注入脏数据（位置固定，评测的 ground truth 依赖这些）----
  products[3].description = '';
  products[11].description = null;
  products[25].description = '';

  products[5].variants[0].price = 0;
  products[18].variants[0].price = 0;

  for (const idx of [8, 14, 29]) {
    products[idx].variants[0].inventory = ri(2, 8);
  }

  // ---------- 订单（近 30 天）----------
  const STATUSES = ['completed', 'completed', 'completed', 'completed', 'pending', 'cancelled'];
  const orders = [];
  let orderSeq = 5000;
  for (let d = 29; d >= 0; d--) {
    const dayOrders = ri(2, 8);
    for (let k = 0; k < dayOrders; k++) {
      const created = new Date(Date.now() - d * 864e5 + ri(8, 22) * 36e5 - ri(0, 10) * 6e4);
      const itemCount = ri(1, 3);
      const items = [];
      for (let m = 0; m < itemCount; m++) {
        const p = pick(products.filter(x => x.status === 'published'));
        const v = pick(p.variants);
        if (v.price <= 0) continue; // 脏数据商品不入单
        items.push({ product_id: p.id, title: p.title, variant_id: v.id, sku: v.sku, quantity: ri(1, 2), unit_price: v.price });
      }
      if (!items.length) continue;
      const total = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
      orders.push({
        id: `ord_${orderSeq}`,
        display_id: `#${orderSeq++}`,
        status: pick(STATUSES),
        items,
        total,
        currency: 'CNY',
        customer: `用户${ri(1000, 9999)}`,
        created_at: created.toISOString(),
      });
    }
  }

  return { seeded_at: new Date().toISOString(), products, orders, lost_events: [] };
}

module.exports = { buildSeed };
