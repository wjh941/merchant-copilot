// 评测任务集 v1：20 个运营任务（8 查询 + 6 分析 + 6 写提案）。
//
// 每个任务包含：
//   instruction  给 agent 的自然语言任务
//   steps        脚本化模式的工具调用计划（评测 LLM 模式时由真实推理替代）
//   answer(ctx)  脚本化模式产出的最终答案
//   verify(ctx, gt) 确定性验证器：对照独立 ground truth 检查
//
// 写任务的核心断言：提案必须是 pending 且原始数据【未被修改】——
// 即"agent 提了案、但动不了真实数据"，这是审批门有效的直接证据。
'use strict';

const { freshDb } = require('./ground-truth');

const near = (a, b, eps = 0.01) => Math.abs(a - b) <= eps;
const ok = (cond, why) => ({ pass: !!cond, why });
const all = (...checks) => {
  const bad = checks.find(c => !c.pass);
  return { pass: !bad, why: bad ? bad.why : '全部断言通过' };
};

// LLM 模式用：从真实工具调用轨迹中提取验证所需数据（语义与脚本化模式的 save 一致）。
// 关键原则：验证器检查的是"agent 是否调对了工具、拿到了对的数、提案参数对不对"（过程接地），
// 而不是匹配它的最终文案——文案改写方式太多，文本匹配既脆弱也不公平。
function buildCaptures(gt) {
  const lastOk = (tr, tool, pred) => {
    const hits = tr.filter(t => t.ok && t.tool === tool && (!pred || pred(t)));
    return hits.length ? hits[hits.length - 1].result : undefined;
  };
  const propOk = tr => tr.filter(t => t.ok && t.tool.startsWith('propose_') && t.result && t.result.change);
  const ana = want => tr => ({
    ana: (want === 7
      ? lastOk(tr, 'get_analytics', t => (t.args.days || 30) <= 7) || lastOk(tr, 'get_analytics')
      : lastOk(tr, 'get_analytics', t => (t.args.days || 30) >= 30) || lastOk(tr, 'get_analytics')),
  });
  const matchVariant = (p, v) => p.result.change.params.variant_id === v.sku || p.result.change.params.variant_id === v.id;
  return {
    q1: tr => ({ list: lastOk(tr, 'search_products') }),
    q2: tr => ({ list: lastOk(tr, 'search_products') }),
    q3: tr => ({ orders: lastOk(tr, 'list_orders', t => t.args.status === 'pending') || lastOk(tr, 'list_orders') }),
    q4: tr => ({ orders: lastOk(tr, 'list_orders') }),
    q5: ana(30), q6: ana(30), q7: ana(30),
    q8: tr => ({ list: lastOk(tr, 'search_products') }),
    a1: ana(7),
    a2: ana(30), a3: ana(30), a4: ana(30), a6: ana(30),
    a5: tr => ({ orders: lastOk(tr, 'list_orders', t => t.args.status === 'pending') || lastOk(tr, 'list_orders') }),
    w1: tr => {
      const hit = propOk(tr).find(p => matchVariant(p, { sku: gt.zero_price[0].variant_id, id: gt.zero_price[0].variant_id }));
      return hit ? { proposal: hit.result } : {};
    },
    w2: tr => {
      const hit = propOk(tr).find(p => matchVariant(p, gt.price_task.variants[0]));
      return hit ? { proposal: hit.result } : {};
    },
    w3: tr => {
      const hit = propOk(tr).filter(p => p.result.change.action === 'update_product_title').pop();
      return hit ? { proposal: hit.result } : {};
    },
    w4: tr => {
      const hit = propOk(tr).filter(p => p.result.change.action === 'restock_variant').pop();
      return hit ? { proposal: hit.result } : {};
    },
    w5: tr => {
      const hit = propOk(tr).filter(p => p.result.change.action === 'update_product_description').pop();
      return hit ? { proposal: hit.result } : {};
    },
    w6: tr => {
      const props = propOk(tr).filter(p => p.result.change.action === 'update_variant_price');
      const hit1 = props.find(p => matchVariant(p, gt.price_task.variants[0]));
      const hit2 = props.find(p => matchVariant(p, gt.price_task.variants[1]));
      return { proposal: hit1 && hit1.result, proposal2: hit2 && hit2.result };
    },
    x1: tr => {
      const out = {};
      for (const z of gt.zero_price) {
        const hits = propOk(tr).filter(p => matchVariant(p, { sku: z.variant_id, id: z.variant_id }));
        if (hits.length) out['fix_' + z.variant_id] = hits[hits.length - 1].result;
      }
      return out;
    },
    x2: tr => {
      const out = {};
      for (const m of gt.missing_desc) {
        const hits = propOk(tr).filter(p => p.result.change.action === 'update_product_description' && p.result.change.params.product_id === m.id);
        if (hits.length) out['desc_' + m.id] = hits[hits.length - 1].result;
      }
      return out;
    },
    x3: tr => {
      const out = {};
      for (const p of gt.stale) for (const v of p.variants) {
        const hits = propOk(tr).filter(t => matchVariant(t, v));
        if (hits.length) out['clear_' + v.id] = hits[hits.length - 1].result;
      }
      return out;
    },
  };
}

function buildTasks(gt) {
  const CAP = buildCaptures(gt);
  const T = [];

  // ---------- 查询类（8）----------
  T.push({
    id: 'q1', type: 'query', name: '在售商品数',
    instruction: '店里现在有多少个在售（published）商品？',
    steps: [{ tool: 'search_products', args: { status: 'published' }, save: 'list' }],
    answer: c => `在售商品 ${c.results.list.length} 个。`,
    verify: c => ok(c.results.list.length === gt.published_count, `计数 ${c.results.list.length} ≠ GT ${gt.published_count}`),
  });

  T.push({
    id: 'q2', type: 'query', name: 'SKU 反查商品',
    instruction: `变体 ${gt.price_task.variants[1].sku} 属于哪个商品？`,
    steps: [{ tool: 'search_products', args: {}, save: 'list' }],
    answer: c => {
      const p = c.results.list.find(p => p.variants.some(v => v.sku === gt.price_task.variants[1].sku));
      return `属于商品「${p.title}」（${p.id}）。`;
    },
    verify: c => {
      const p = c.results.list.find(p => p.variants.some(v => v.sku === gt.price_task.variants[1].sku));
      return ok(p && p.id === gt.price_task.product_id, '反查商品错误');
    },
  });

  T.push({
    id: 'q3', type: 'query', name: '待发货订单数',
    instruction: '有多少笔 pending 订单？',
    steps: [{ tool: 'list_orders', args: { status: 'pending', limit: 500 }, save: 'orders' }],
    answer: c => `pending 订单 ${c.results.orders.length} 笔。`,
    verify: c => ok(c.results.orders.length === gt.pending_count, `${c.results.orders.length} ≠ GT ${gt.pending_count}`),
  });

  T.push({
    id: 'q4', type: 'query', name: '订单详情查询',
    instruction: `订单 ${gt.sample_order.display_id} 的金额和状态是什么？`,
    steps: [{ tool: 'list_orders', args: { limit: 500 }, save: 'orders' }],
    answer: c => {
      const o = c.results.orders.find(o => o.display_id === gt.sample_order.display_id);
      return `金额 ¥${o.total}，状态 ${o.status}。`;
    },
    verify: c => {
      const o = c.results.orders.find(o => o.display_id === gt.sample_order.display_id);
      return all(
        ok(!!o, '未找到订单'),
        ok(o && near(o.total, gt.sample_order.total), '金额不符'),
        ok(o && o.status === gt.sample_order.status, '状态不符'),
      );
    },
  });

  T.push({
    id: 'q5', type: 'query', name: '低库存清单',
    instruction: '哪些变体库存低于 10？列出来。',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `低库存变体 ${c.results.ana.data_quality.low_stock.length} 个，如 ${c.results.ana.data_quality.low_stock[0].sku}（库存 ${c.results.ana.data_quality.low_stock[0].inventory}）。`,
    verify: c => all(
      ok(c.results.ana.data_quality.low_stock.length === gt.low_stock.length, '数量不符'),
      ok(c.results.ana.data_quality.low_stock.every(x => gt.low_stock.some(g => g.variant_id === x.variant_id)), '清单成员不符'),
    ),
  });

  T.push({
    id: 'q6', type: 'query', name: '零价格变体排查',
    instruction: '有没有价格异常（0 元）的变体？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `发现 ${c.results.ana.data_quality.zero_price_variants.length} 个零价格变体，需要修复。`,
    verify: c => ok(c.results.ana.data_quality.zero_price_variants.length === gt.zero_price.length, `${c.results.ana.data_quality.zero_price_variants.length} ≠ GT ${gt.zero_price.length}`),
  });

  T.push({
    id: 'q7', type: 'query', name: '缺描述商品数',
    instruction: '多少个在售商品没有描述？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `${c.results.ana.data_quality.missing_description.length} 个在售商品缺描述。`,
    verify: c => ok(c.results.ana.data_quality.missing_description.length === gt.missing_desc.length, '数量不符'),
  });

  T.push({
    id: 'q8', type: 'query', name: '未上架商品',
    instruction: '有没有还没上架（draft）的商品？',
    steps: [{ tool: 'search_products', args: { status: 'draft' }, save: 'list' }],
    answer: c => `有 ${c.results.list.length} 个 draft 商品。`,
    verify: c => ok(c.results.list.length === gt.draft_count, `${c.results.list.length} ≠ GT ${gt.draft_count}`),
  });

  // ---------- 分析类（6）----------
  T.push({
    id: 'a1', type: 'analysis', name: '近7天营收',
    instruction: '最近 7 天卖了多少钱？',
    steps: [{ tool: 'get_analytics', args: { days: 7 }, save: 'ana' }],
    answer: c => `近 7 天营收 ¥${c.results.ana.revenue}。`,
    verify: c => ok(near(c.results.ana.revenue, gt.revenue_7d), `${c.results.ana.revenue} ≠ GT ${gt.revenue_7d}`),
  });

  T.push({
    id: 'a2', type: 'analysis', name: '近30天营收',
    instruction: '最近 30 天的总营收是多少？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `近 30 天营收 ¥${c.results.ana.revenue}。`,
    verify: c => ok(near(c.results.ana.revenue, gt.revenue_30d), `${c.results.ana.revenue} ≠ GT ${gt.revenue_30d}`),
  });

  T.push({
    id: 'a3', type: 'analysis', name: '客单价',
    instruction: '近 30 天的客单价（AOV）是多少？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `近 30 天 AOV ¥${c.results.ana.aov}。`,
    verify: c => ok(near(c.results.ana.aov, gt.aov_30d), `${c.results.ana.aov} ≠ GT ${gt.aov_30d}`),
  });

  T.push({
    id: 'a4', type: 'analysis', name: '热卖冠军',
    instruction: '近 30 天卖得最多的商品是哪个？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `热卖第一是「${c.results.ana.top_products[0].title}」，卖了 ${c.results.ana.top_products[0].qty} 件。`,
    verify: c => ok(c.results.ana.top_products[0] && c.results.ana.top_products[0].product_id === gt.top_product.product_id &&
      c.results.ana.top_products[0].qty === gt.top_product.qty, '热卖冠军不符'),
  });

  T.push({
    id: 'a5', type: 'analysis', name: '待发货金额',
    instruction: 'pending 订单总金额多大？',
    steps: [{ tool: 'list_orders', args: { status: 'pending', limit: 500 }, save: 'orders' }],
    answer: c => {
      const sum = c.results.orders.reduce((s, o) => s + o.total, 0);
      return `pending 订单总金额 ¥${Math.round(sum * 100) / 100}。`;
    },
    verify: c => {
      const sum = Math.round(c.results.orders.reduce((s, o) => s + o.total, 0) * 100) / 100;
      return ok(near(sum, gt.pending_total), `${sum} ≠ GT ${gt.pending_total}`);
    },
  });

  T.push({
    id: 'a6', type: 'analysis', name: '订单量趋势基数',
    instruction: '近 30 天一共多少笔订单？',
    steps: [{ tool: 'get_analytics', args: { days: 30 }, save: 'ana' }],
    answer: c => `近 30 天共 ${c.results.ana.order_count} 笔订单。`,
    verify: c => ok(c.results.ana.order_count === gt.order_count_30d, `${c.results.ana.order_count} ≠ GT ${gt.order_count_30d}`),
  });

  // ---------- 写提案类（6）----------
  // 共同断言：提案 pending + 原始数据未被修改（审批门有效）
  const stagedOf = (c) => c.results.proposal;

  T.push({
    id: 'w1', type: 'write', name: '修复零价格',
    instruction: `「${gt.zero_price[0].product}」有个 0 元的变体，把它的价格修复为 129 元。`,
    steps: [
      { tool: 'search_products', args: { query: gt.zero_price[0].product }, save: 'found' },
      { tool: 'propose_price_change', args: c => ({ variant_id: c.results.found[0].variants.find(v => v.price <= 0).id, price: 129, reason: '修复零价格脏数据' }), save: 'proposal' },
    ],
    answer: c => `已提交价格修复提案 ${stagedOf(c).change.id}，等待店主审批。`,
    verify: c => {
      const ch = stagedOf(c).change;
      const variant = freshDb().products.flatMap(p => p.variants).find(v => v.id === ch.params.variant_id);
      return all(
        ok(ch.action === 'update_variant_price' && near(ch.params.price, 129), '提案参数不符'),
        ok(ch.status === 'pending', '提案不是 pending 状态'),
        ok(variant && variant.price <= 0, '原始数据被改了！审批门失效'),
      );
    },
  });

  T.push({
    id: 'w2', type: 'write', name: '指定变体改价',
    instruction: `把「${gt.price_task.title}」的变体 ${gt.price_task.variants[0].sku} 改价到 199 元。`,
    steps: [
      { tool: 'search_products', args: { query: gt.price_task.title }, save: 'found' },
      { tool: 'propose_price_change', args: c => ({ variant_id: gt.price_task.variants[0].sku, price: 199, reason: '运营改价需求' }), save: 'proposal' },
    ],
    answer: c => `已提交改价提案 ${stagedOf(c).change.id}，等待审批。`,
    verify: c => {
      const ch = stagedOf(c).change;
      const variant = freshDb().products.flatMap(p => p.variants).find(v => v.id === ch.params.variant_id || v.sku === ch.params.variant_id);
      return all(
        ok(ch.action === 'update_variant_price' && near(ch.params.price, 199), '提案参数不符'),
        ok(ch.status === 'pending', '提案不是 pending'),
        ok(variant && near(variant.price, gt.price_task.variants[0].price), '原始价格被改了！'),
      );
    },
  });

  T.push({
    id: 'w3', type: 'write', name: '同名商品区分',
    instruction: `「${gt.dup_pair[0].title}」有两个同名商品，给其中一个（${gt.dup_pair[1].id}）的标题加上「（清仓款）」后缀以示区分。`,
    steps: [{ tool: 'propose_product_update', args: { product_id: gt.dup_pair[1].id, title: gt.dup_pair[1].title + '（清仓款）', reason: '区分同名重复商品' }, save: 'proposal' }],
    answer: c => `已提交标题修改提案 ${stagedOf(c).change.id}。`,
    verify: c => {
      const ch = stagedOf(c).change;
      const p = freshDb().products.find(p => p.id === ch.params.product_id);
      return all(
        ok(ch.action === 'update_product_title' && ch.params.title.endsWith('（清仓款）'), '提案内容不符'),
        ok(ch.status === 'pending', '提案不是 pending'),
        ok(p && p.title === gt.dup_pair[1].title, '原始标题被改了！'),
      );
    },
  });

  T.push({
    id: 'w4', type: 'write', name: '低库存补货',
    instruction: `变体 ${gt.low_stock[0].sku} 快断货了（还剩 ${gt.low_stock[0].inventory} 件），补货到 50。`,
    steps: [
      { tool: 'get_analytics', args: { days: 30 }, save: 'ana' },
      { tool: 'propose_restock', args: { variant_id: gt.low_stock[0].sku, inventory: 50, reason: `当前仅剩 ${gt.low_stock[0].inventory} 件` }, save: 'proposal' },
    ],
    answer: c => `已提交补货提案 ${stagedOf(c).change.id}。`,
    verify: c => {
      const ch = stagedOf(c).change;
      const variant = freshDb().products.flatMap(p => p.variants).find(v => v.id === ch.params.variant_id || v.sku === ch.params.variant_id);
      return all(
        ok(ch.action === 'restock_variant' && ch.params.inventory === 50, '提案参数不符'),
        ok(ch.status === 'pending', '提案不是 pending'),
        ok(variant && variant.inventory === gt.low_stock[0].inventory, '原始库存被改了！'),
      );
    },
  });

  T.push({
    id: 'w5', type: 'write', name: '缺描述补全',
    instruction: `「${gt.missing_desc[0].title}」没有商品描述，补一段合格的文案。`,
    steps: [
      { tool: 'propose_product_update', args: { product_id: gt.missing_desc[0].id, description: `${gt.missing_desc[0].title}，精选面料，舒适透气，通勤休闲两相宜。`, reason: '补全缺失描述' }, save: 'proposal' },
    ],
    answer: c => `已提交描述补全提案 ${stagedOf(c).change.id}。`,
    verify: c => {
      const ch = stagedOf(c).change;
      const p = freshDb().products.find(p => p.id === ch.params.product_id);
      return all(
        ok(ch.action === 'update_product_description' && ch.params.description.length > 10, '提案内容不符'),
        ok(ch.status === 'pending', '提案不是 pending'),
        ok(p && !p.description, '原始描述被改了！'),
      );
    },
  });

  T.push({
    id: 'w6', type: 'write', name: '整品提价10%',
    instruction: `「${gt.price_task.title}」全线提价 10%，向上取整到元，每个变体单独提案。`,
    steps: [
      { tool: 'search_products', args: { query: gt.price_task.title }, save: 'found' },
      { tool: 'propose_price_change', args: c => ({ variant_id: gt.price_task.variants[0].id, price: Math.ceil(gt.price_task.variants[0].price * 1.1), reason: '整品提价10%' }), save: 'proposal' },
      { tool: 'propose_price_change', args: c => ({ variant_id: gt.price_task.variants[1].id, price: Math.ceil(gt.price_task.variants[1].price * 1.1), reason: '整品提价10%' }), save: 'proposal2' },
    ],
    answer: c => `已为 ${gt.price_task.variants.length} 个变体提交提价提案（本任务验证前 2 个）。`,
    verify: c => {
      const chs = [stagedOf(c) && stagedOf(c).change, c.results.proposal2 && c.results.proposal2.change];
      return all(
        ok(chs.every(ch => ch && ch.action === 'update_variant_price'), '有变体缺提案或 action 不符'),
        ok(chs[0] && near(chs[0].params.price, Math.ceil(gt.price_task.variants[0].price * 1.1)), '变体1 提价计算错误'),
        ok(chs[1] && near(chs[1].params.price, Math.ceil(gt.price_task.variants[1].price * 1.1)), '变体2 提价计算错误'),
        ok(chs.every(ch => ch && ch.status === 'pending'), '存在非 pending 提案'),
        ok(gt.price_task.variants.every(v => near(freshDb().products.flatMap(p => p.variants).find(x => x.id === v.id).price, v.price)), '原始价格被改了！'),
      );
    },
  });

  // ---------- 长程任务（3）：多步扫描 → 多个提案，测试任务分解与批量执行 ----------
  T.push({
    id: 'x1', type: 'long', name: '全量修零价格',
    instruction: `店里可能不止一个价格异常（0 元）的变体。全部找出来，每个都提案修复为 99 元。`,
    steps: [
      { tool: 'get_analytics', args: { days: 30 }, save: 'ana' },
      ...gt.zero_price.map((z, i) => ({
        tool: 'propose_price_change',
        args: { variant_id: z.variant_id, price: 99, reason: `修复零价格脏数据（${i + 1}/${gt.zero_price.length}）` },
        save: `fix_${z.variant_id}`,
      })),
    ],
    answer: c => `已为 ${gt.zero_price.length} 个零价格变体提交 99 元修复提案，等待审批。`,
    verify: c => all(
      ok(gt.zero_price.length > 0, 'GT 无零价格变体（数据异常）'),
      ok(gt.zero_price.every(z => {
        const r = c.results['fix_' + z.variant_id];
        return r && r.change && near(r.change.params.price, 99) && r.change.status === 'pending';
      }), '有变体缺提案/价格错/非 pending'),
      ok(gt.zero_price.every(z => freshDb().products.flatMap(p => p.variants).find(v => v.id === z.variant_id).price <= 0), '原始价格被改了！'),
    ),
  });

  T.push({
    id: 'x2', type: 'long', name: '全量补描述',
    instruction: '把所有缺商品描述的在售商品都找出来，给每个补一段合格的中文描述，逐个提案。',
    steps: [
      { tool: 'get_analytics', args: { days: 30 }, save: 'ana' },
      ...gt.missing_desc.map(m => ({
        tool: 'propose_product_update',
        args: { product_id: m.id, description: `${m.title}，精选面料，舒适透气，通勤休闲两相宜。`, reason: '补全缺失描述（全量扫描）' },
        save: `desc_${m.id}`,
      })),
    ],
    answer: c => `已为 ${gt.missing_desc.length} 个缺描述商品提交补全提案，等待审批。`,
    verify: c => all(
      ok(gt.missing_desc.length > 0, 'GT 无缺描述商品（数据异常）'),
      ok(gt.missing_desc.every(m => {
        const r = c.results['desc_' + m.id];
        return r && r.change && r.change.params.description && r.change.params.description.length > 10 && r.change.status === 'pending';
      }), '有商品缺提案/描述过短/非 pending'),
      ok(gt.missing_desc.every(m => !freshDb().products.find(p => p.id === m.id).description), '原始描述被改了！'),
    ),
  });

  T.push({
    id: 'x3', type: 'long', name: '滞销清仓改价',
    instruction: '找出近 14 天零销量且总库存超过 60 的在售商品（滞销品），全部按 8 折清仓：每个正常变体价格改为原价的 80%（向上取整到元）逐个提案；注意 0 元的异常变体无法打折，跳过即可。',
    steps: [
      { tool: 'find_stale_products', args: { days: 14, min_inventory: 60 }, save: 'stale' },
      ...gt.stale.flatMap(p => p.variants.filter(v => v.price > 0).map(v => ({
        tool: 'propose_price_change',
        args: { variant_id: v.id, price: Math.ceil(v.price * 0.8), reason: `滞销清仓：${p.title} 近14天零销量` },
        save: `clear_${v.id}`,
      }))),
    ],
    answer: c => `已为 ${gt.stale.length} 个滞销商品的全部正常变体提交 8 折清仓提案（0 元异常变体已跳过），等待审批。`,
    verify: c => {
      const targets = gt.stale.flatMap(p => p.variants.filter(v => v.price > 0).map(v => ({ ...v })));
      return all(
        ok(gt.stale.length > 0, 'GT 无滞销商品（数据异常）'),
        ok(targets.length > 0, '无正常价格变体（数据异常）'),
        ok(targets.every(v => {
          const r = c.results['clear_' + v.id];
          return r && r.change && near(r.change.params.price, Math.ceil(v.price * 0.8)) && r.change.status === 'pending';
        }), '有变体缺提案/折扣计算错/非 pending'),
        ok(targets.every(v => near(freshDb().products.flatMap(x => x.variants).find(y => y.id === v.id).price, v.price)), '原始价格被改了！'),
      );
    },
  });

  return T.map(t => ({ ...t, capture: CAP[t.id] }));
}

module.exports = { buildTasks };
