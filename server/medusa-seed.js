// 把仿真商品灌进真 Medusa 店铺（一次性种子脚本）。
// 用法: node server/medusa-seed.js   （需 MEDUSA_URL/MEDUSA_EMAIL/MEDUSA_PASSWORD 或默认值）
'use strict';
const medusa = require('./medusa');

const PRODUCTS = [
  { title: '云朵衬衫', category: '上衣', items: [['米白 / S', 'MD-CY-01', 159], ['黑色 / M', 'MD-CY-02', 159], ['雾蓝 / L', 'MD-CY-03', 169]] },
  { title: '晚风连衣裙', category: '裙装', items: [['燕麦 / M', 'MD-WF-01', 299], ['咖色 / L', 'MD-WF-02', 299]] },
  { title: '星野卫衣', category: '上衣', items: [['米白 / M', 'MD-XY-01', 219], ['青柠 / L', 'MD-XY-02', 229]] },
  { title: '山雾半身裙', category: '裙装', items: [['雾蓝 / S', 'MD-SW-01', 189], ['黑色 / M', 'MD-SW-02', 189]] },
  { title: '麦浪针织开衫', category: '外套', items: [['燕麦 / M', 'MD-ML-01', 259]] },
  { title: '白鹭帆布鞋', category: '鞋靴', items: [['米白 / 38', 'MD-BL-01', 269], ['黑色 / 40', 'MD-BL-02', 269]] },
  { title: '拾光贝雷帽', category: '配饰', items: [['咖色 / 均码', 'MD-SG-01', 89]] },
  { title: '栖岸休闲裤', category: '裤装', items: [['黑色 / M', 'MD-QA-01', 239], ['雾蓝 / L', 'MD-QA-02', 249]] },
];

(async () => {
  const existing = await medusa.listProducts(200);
  const have = new Set(existing.map(p => p.title));
  let created = 0, skipped = 0;
  for (const p of PRODUCTS) {
    if (have.has(p.title)) { skipped++; continue; }
    const options = [{ title: '规格', values: p.items.map(i => i[0]) }];
    const variants = p.items.map(([title, sku, price]) => ({
      title, sku,
      options: { '规格': title },
      prices: [{ amount: price, currency_code: 'usd' }],
    }));
    try {
      const r = await medusa.api('/admin/products', {
        method: 'POST',
        body: JSON.stringify({
          title: p.title,
          status: 'published',
          description: `${p.title}，${p.category}品类经典款。面料舒适，版型百搭，适合日常与通勤场景。`,
          options, variants,
        }),
      });
      created++;
      console.log(`✅ ${p.title} -> ${r.product.id} (${p.items.length} 变体)`);
    } catch (e) {
      console.log(`❌ ${p.title}: ${e.message}`);
    }
  }
  console.log(`\n完成: 新建 ${created}, 跳过 ${skipped}, 店铺现有 ${created + existing.length} 个商品`);
})().catch(e => { console.error(e.message); process.exit(1); });
