// 竞品价格监测 + 改价建议引擎
//
// 数据来源（适配器架构，诚实边界）：
// - 内置「仿真市场监测器」：为每个商品生成 3 家虚拟竞店的 30 天价格随机游走（确定性种子，可复现），
//   用于看板/建议引擎的完整演示；
// - 真实数据源（平台 API、比价服务、CSV 导入）未来通过 recordObservation() 接入，
//   看板和建议引擎对数据来源无感知。
//
// 建议模型（披露假设）：
// - 价格位置 position = 本店价 / 市场均价
// - 销量趋势 = 近7天销量 vs 之前7天
// - 弹性假设：单位销量变化% ≈ -1.5 × 价格变化%（价格弹性 1.5，写在输出里供审视）
'use strict';
const fs = require('fs');
const path = require('path');
const medusa = require('./medusa');

const MARKET_FILE = process.env.MARKET_FILE || path.join(__dirname, '..', 'data', 'market.json');
const COMPETITORS = ['友商·快时尚 A', '友商·品牌折扣 B', '友商·工厂店 C'];
const ELASTICITY = 1.5;

// 每个商品固定的"市场锚点系数"（本店价的 0.82~1.18），由标题哈希决定——保证可复现
function anchorFactor(title) {
  let h = 0;
  for (const c of title) h = (h * 31 + c.charCodeAt(0)) % 100000;
  return 0.8 + (h % 41) / 100; // 0.80 ~ 1.20
}

function loadMarket() {
  try { return JSON.parse(fs.readFileSync(MARKET_FILE, 'utf8')); } catch { return { observations: {} }; }
}
function saveMarket(m) {
  fs.writeFileSync(MARKET_FILE, JSON.stringify(m), 'utf8');
}

// 生成/补齐某商品过去 N 天的竞品价格随机游走（确定性）
function ensureHistory(title, ourPrice, days = 30) {
  const m = loadMarket();
  if (!m.observations[title]) m.observations[title] = {};
  const now = Date.now();
  let anchor = ourPrice * anchorFactor(title);
  let seed = 0;
  for (const c of title) seed = (seed * 131 + c.charCodeAt(0)) % 2147483647;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };

  for (const comp of COMPETITORS) {
    if (m.observations[title][comp] && m.observations[title][comp].length >= days) continue;
    const series = [];
    let price = anchor * (0.92 + rnd() * 0.16);
    for (let d = days - 1; d >= 0; d--) {
      const ts = now - d * 864e5;
      // 只补缺失的日期
      price = price * (0.985 + rnd() * 0.03); // 日波动 ±1.5%
      price = Math.max(anchor * 0.75, Math.min(anchor * 1.3, price)); // 锚定回归
      const existing = (m.observations[title][comp] || []).find(o => Math.abs(new Date(o.observed_at).getTime() - ts) < 12 * 36e5);
      if (!existing) series.push({ competitor: comp, price: Math.round(price * 100) / 100, observed_at: new Date(ts).toISOString() });
    }
    m.observations[title][comp] = [...(m.observations[title][comp] || []), ...series].slice(-days);
  }
  // 锚点跟随本店价缓慢漂移（记录最新本店价）
  m.observations[title]._meta = { our_price: ourPrice, anchor: Math.round(anchor * 100) / 100, updated_at: new Date().toISOString() };
  saveMarket(m);
  return m.observations[title];
}

// 市场快照 + 建议（products: 数据层商品视图；orders: 数据层订单视图）
async function marketReport(products, orders, days = 30) {
  const now = Date.now();
  const since7 = now - 7 * 864e5, since14 = now - 14 * 864e5;

  // 近30天销量（按变体聚合）与 7d/前7d 趋势
  const units = {}, units7 = {}, unitsPrev7 = {};
  for (const o of orders) {
    if (o.status === 'cancelled') continue;
    const t = new Date(o.created_at).getTime();
    for (const it of (o.items || [])) {
      const pid = it.product_id;
      if (!pid) continue;
      units[pid] = (units[pid] || 0) + (it.quantity || 1);
      if (t >= since7) units7[pid] = (units7[pid] || 0) + (it.quantity || 1);
      else if (t >= since14) unitsPrev7[pid] = (unitsPrev7[pid] || 0) + (it.quantity || 1);
    }
  }

  const rows = [];
  for (const p of products) {
    if (p.status !== 'published') continue;
    const v0 = p.variants[0];
    if (!v0 || v0.price <= 0) continue; // 脏价格不参与市场对比
    const hist = ensureHistory(p.title, v0.price, days);
    const latest = [];
    for (const comp of COMPETITORS) {
      const series = hist[comp] || [];
      if (series.length) latest.push(series[series.length - 1].price);
    }
    if (!latest.length) continue;
    const min = Math.min(...latest), max = Math.max(...latest);
    const avg = latest.reduce((s, x) => s + x, 0) / latest.length;
    const position = v0.price / avg;
    const u30 = units[p.id] || 0;
    const u7 = units7[p.id] || 0, uPrev = unitsPrev7[p.id] || 0;
    const trend = uPrev === 0 ? (u7 > 0 ? 'up' : 'flat') : (u7 / uPrev > 1.15 ? 'up' : u7 / uPrev < 0.85 ? 'down' : 'flat');

    rows.push({
      product_id: p.id, title: p.title, sku: v0.sku,
      our_price: v0.price, currency: v0.currency,
      market_min: Math.round(min * 100) / 100,
      market_avg: Math.round(avg * 100) / 100,
      market_max: Math.round(max * 100) / 100,
      competitors: latest.length,
      position: Math.round(position * 100) / 100,
      position_pct: Math.round((position - 1) * 1000) / 10,
      units_30d: u30, units_7d: u7, trend,
      history: hist,
    });
  }

  // ---------- 建议引擎 ----------
  // 与弹性模型自洽的规则：弹性 1.5 下，提价只有在对价格不敏感（需求上行）时才增收入；
  // 降价只有在溢价明显且需求平淡/下滑时才换得增量。
  const suggestions = [];
  for (const r of rows) {
    const monthlyUnits = r.units_30d;
    const monthlyRevenue = monthlyUnits * r.our_price;
    let s = null;
    if (r.position > 1.12 && (r.trend === 'down' || r.position > 1.25)) {
      // 偏高：向市场均价靠拢（不超过 -12% 单次步长）
      const suggested = Math.max(r.market_avg, Math.round(r.our_price * 0.88 * 100) / 100);
      const delta = (suggested - r.our_price) / r.our_price;
      const unitsDelta = -ELASTICITY * delta;
      const newRevenue = monthlyUnits * (1 + unitsDelta) * suggested;
      s = {
        product_id: r.product_id, title: r.title, sku: r.sku,
        action: 'decrease', current: r.our_price, suggested,
        reason: `本店价高于市场均价 ${Math.round((r.position - 1) * 100)}%${r.trend === 'down' ? '，且近7天销量在下滑' : r.trend === 'flat' ? '，销量未见溢价支撑' : ''}`,
        expected: {
          price_change_pct: Math.round(delta * 1000) / 10,
          units_change_pct: Math.round(unitsDelta * 1000) / 10,
          monthly_revenue_delta: Math.round((newRevenue - monthlyRevenue) * 100) / 100,
        },
      };
    } else if (r.position < 0.88 && r.trend === 'up') {
      // 偏低且需求上行：提价空间（需求上行使有效弹性降低）
      const suggested = Math.min(Math.round(r.our_price * 1.08 * 100) / 100, r.market_avg);
      const delta = (suggested - r.our_price) / r.our_price;
      const unitsDelta = -ELASTICITY * delta * 0.6; // 需求上行时折减弹性影响
      const newRevenue = monthlyUnits * (1 + unitsDelta) * suggested;
      s = {
        product_id: r.product_id, title: r.title, sku: r.sku,
        action: 'increase', current: r.our_price, suggested,
        reason: `本店价低于市场均价 ${Math.round((1 - r.position) * 100)}% 且近7天销量上行，存在提价空间（需求强劲期价格敏感度较低）`,
        expected: {
          price_change_pct: Math.round(delta * 1000) / 10,
          units_change_pct: Math.round(unitsDelta * 1000) / 10,
          monthly_revenue_delta: Math.round((newRevenue - monthlyRevenue) * 100) / 100,
        },
      };
    } else if (r.position < 0.85 && r.trend !== 'up') {
      // 低价但需求平淡：不宜提价（提价在弹性 1.5 下降收入），标注观察
      suggestions.push({
        product_id: r.product_id, title: r.title, sku: r.sku,
        action: 'hold', current: r.our_price, suggested: r.our_price,
        reason: `价格低于市场 ${Math.round((1 - r.position) * 100)}% 但销量平淡——按弹性 1.5 测算提价会降收入，建议先做流量/详情优化再议价`,
        expected: { price_change_pct: 0, units_change_pct: 0, monthly_revenue_delta: 0 },
      });
    }
    if (s) suggestions.push(s);
  }
  suggestions.sort((a, b) => Math.abs(b.expected.monthly_revenue_delta) - Math.abs(a.expected.monthly_revenue_delta));

  const summary = {
    above: rows.filter(r => r.position > 1.15).length,
    below: rows.filter(r => r.position < 0.85).length,
    fair: rows.filter(r => r.position >= 0.85 && r.position <= 1.15).length,
    suggestion_count: suggestions.length,
    elasticity: ELASTICITY,
    assumption: '预期基于价格弹性 1.5 的线性估算（销量变化% ≈ -1.5 × 价格变化%），实际受流量/竞争/季节影响，仅供决策参考',
  };
  return { rows, suggestions, summary, competitors: COMPETITORS, generated_at: new Date().toISOString() };
}

module.exports = { marketReport, ensureHistory, loadMarket, saveMarket, COMPETITORS, ELASTICITY };
