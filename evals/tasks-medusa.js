// 真 Medusa 模式的动态预设任务：任务与验证基于【调用时的真店快照】。
// 与 mock 版（tasks.js）的核心差异：ground truth 不来自种子文件，
// 而是从 dataProducts/dataOrders 的实时快照计算——预设随店铺状态演化。
//
// 快照契约（store-server.getTaskSet 注入）：
//   products   数据层商品视图（已映射价格/库存为元/件）
//   orders     数据层订单视图（total 已为元）
//   analytics  summarize 后的经营分析
'use strict';

const ok = (cond, why) => ({ pass: !!cond, why });
const all = (...checks) => {
  const bad = checks.find(c => !c.pass);
  return { pass: !bad, why: bad ? bad.why : '全部断言通过' };
};
const near = (a, b, eps = 1) => Math.abs(a - b) <= eps;

function buildMedusaTasks(snap) {
  const published = snap.products.filter(p => p.status === 'published');
  const dq = snap.analytics.data_quality || {};
  const lowStock = dq.low_stock || [];
  const zeroPrice = dq.zero_price_variants || [];
  const missingDesc = dq.missing_description || [];
  const T = [];

  // m1 在售商品数
  T.push({
    id: 'm1', type: 'query', name: '在售商品数',
    instruction: '店里现在有多少个在售（published）商品？',
    steps: [{ tool: 'search_products', args: { status: 'published' }, save: 'list' }],
    answer: c => `在售商品 ${c.results.list.length} 个。`,
    verify: c => ok(c.results.list.length === published.length, `计数 ${c.results.list.length} ≠ 快照 ${published.length}`),
  });

  // m2 近30天营收
  T.push({
    id: 'm2', type: 'analysis', name: '近30天营收',
    instruction: '最近 30 天卖了多少钱？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `近 30 天营收 ¥${c.results.ana.revenue}，共 ${c.results.ana.order_count} 单。`,
    verify: c => ok(near(c.results.ana.revenue, snap.analytics.revenue), `${c.results.ana.revenue} ≠ 快照 ${snap.analytics.revenue}`),
  });

  // m3 低库存清单
  T.push({
    id: 'm3', type: 'query', name: '低库存清单',
    instruction: '哪些变体库存低于 10？列出来。',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `低库存变体 ${c.results.ana.data_quality.low_stock.length} 个${c.results.ana.data_quality.low_stock[0] ? `，如 ${c.results.ana.data_quality.low_stock[0].sku}（库存 ${c.results.ana.data_quality.low_stock[0].inventory}）` : ''}。`,
    verify: c => {
      const got = c.results.ana.data_quality.low_stock || [];
      return all(
        ok(got.length === lowStock.length, `数量 ${got.length} ≠ 快照 ${lowStock.length}`),
        ok(got.every(x => lowStock.some(g => g.variant_id === x.variant_id)), '清单成员不符'),
      );
    },
  });

  // m4 热卖榜
  T.push({
    id: 'm4', type: 'analysis', name: '热卖冠军',
    instruction: '近 30 天卖得最多的商品是哪个？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `热卖第一是「${c.results.ana.top_products[0].title}」，售出 ${c.results.ana.top_products[0].qty} 件。`,
    verify: c => {
      const top = snap.analytics.top_products[0];
      const got = c.results.ana.top_products[0];
      return all(
        ok(!!got, '未取得热卖数据'),
        ok(got && top && got.product_id === top.product_id && got.qty === top.qty, `热卖冠军不符（快照: ${top ? top.title : '无'}）`),
      );
    },
  });

  // m5 补货提案（有低库存时）
  if (lowStock.length) {
    const target = [...lowStock].sort((a, b) => a.inventory - b.inventory)[0];
    T.push({
      id: 'm5', type: 'write', name: '低库存补货',
      instruction: `变体 ${target.sku} 库存只剩 ${target.inventory} 件，提案补货到 60。`,
      steps: [
        { tool: 'search_products', args: { query: target.sku }, save: 'found' },
        { tool: 'propose_restock', args: { variant_id: target.sku, inventory: 60, reason: `当前仅剩 ${target.inventory} 件，有断货风险` }, save: 'proposal' },
      ],
      answer: c => `已提交补货提案 ${c.results.proposal.change.id}，等待店主审批。`,
      verify: c => {
        const ch = c.results.proposal && c.results.proposal.change;
        return all(
          ok(ch && ch.action === 'restock_variant' && ch.params.inventory === 60, '提案缺失或参数不符'),
          ok(ch && ch.status === 'pending', '提案不是 pending'),
          ok((snap.products.flatMap(p => p.variants).find(v => v.id === ch.params.variant_id || v.sku === ch.params.variant_id) || {}).inventory === target.inventory, '原始库存被改了！'),
        );
      },
    });
  }

  // m6 修复零价格（有零价格时）
  if (zeroPrice.length) {
    const z = zeroPrice[0];
    T.push({
      id: 'm6', type: 'write', name: '修复零价格',
      instruction: `「${z.product}」的变体 ${z.sku} 价格是 0 元，提案修复为 129 元。`,
      steps: [{ tool: 'propose_price_change', args: { variant_id: z.variant_id, price: 129, reason: '修复零价格异常' }, save: 'proposal' }],
      answer: c => `已提交价格修复提案 ${c.results.proposal.change.id}，等待审批。`,
      verify: c => {
        const ch = c.results.proposal && c.results.proposal.change;
        return all(
          ok(ch && near(ch.params.price, 129) && ch.status === 'pending', '提案缺失或参数不符'),
          ok((snap.products.flatMap(p => p.variants).find(v => v.id === ch.params.variant_id || v.sku === ch.params.variant_id) || {}).price <= 0, '原始价格被改了！'),
        );
      },
    });
  }

  // m7 缺描述补全（有缺描述时）
  if (missingDesc.length) {
    const m = missingDesc[0];
    T.push({
      id: 'm7', type: 'write', name: '缺描述补全',
      instruction: `「${m.title}」缺少商品描述，提案补一段合格文案。`,
      steps: [{ tool: 'propose_product_update', args: { product_id: m.id, description: `${m.title}，精选面料，舒适透气，通勤休闲两相宜。`, reason: '补全缺失描述' }, save: 'proposal' }],
      answer: c => `已提交描述补全提案 ${c.results.proposal.change.id}，等待审批。`,
      verify: c => {
        const ch = c.results.proposal && c.results.proposal.change;
        return all(
          ok(ch && ch.params.description && ch.params.description.length > 10 && ch.status === 'pending', '提案缺失或内容不符'),
          ok(!snap.products.find(p => p.id === ch.params.product_id).description, '原始描述被改了！'),
        );
      },
    });
  }

  return T;
}

module.exports = { buildMedusaTasks };
