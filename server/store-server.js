// 店铺后端 v0.1 —— 零依赖 Node HTTP 服务。
//
// 设计原则（对齐 Anthropic commerce-agents 蓝图的安全模式）：
// 1. 围栏（fencing）：商品/订单数据【没有】直接写接口，所有变更只能走"暂存变更"。
// 2. 人工审批门：暂存变更只有 approve/reject 两个出口，agent 拿不到任何"直接生效"的写路径。
// 3. 限额：待审批变更超过 10 条时拒绝新提案（防止 agent 刷屏）。
// 4. 审计：每次提案/审批/拒绝都落 audit log。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildSeed } = require('./seed-data');
const medusa = require('./medusa');
const market = require('./market-monitor');

// 后端执行目标：设置 MEDUSA_URL 后，审批通过的动作会【真实执行到 Medusa 店铺】；
// 未设置则执行到本地 JSON 仿真数据（默认，评测用）。
// EXEC_MEDUSA 时运营台的读数据也来自真店（看板/洞察/分析全是真数据），营业模拟自动停用。
const EXEC_MEDUSA = !!process.env.MEDUSA_URL;

// ---------- 数据层：本地仿真 / 真 Medusa 双模式 ----------
async function dataProducts() {
  if (!EXEC_MEDUSA) return productsView();
  return medusa.listProducts(200);
}
async function dataOrders(status, limit) {
  if (!EXEC_MEDUSA) return ordersView(status, limit);
  let orders = await medusa.listOrders(1000);
  if (status) orders = orders.filter(o => o.status === status);
  return orders.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit || 1000);
}
async function dataAnalytics(days) {
  if (!EXEC_MEDUSA) return analyticsSummary(days);
  const [products, orders] = await Promise.all([dataProducts(), dataOrders(null, 2000)]);
  return medusa.summarize(products, orders, days);
}
async function dataTrend(days) {
  if (!EXEC_MEDUSA) return revenueTrend(days);
  const orders = await dataOrders(null, 2000);
  return medusa.trendFromOrders(orders, days);
}

const DB_FILE = path.join(__dirname, '..', 'data', 'store.json');
const PORT = process.env.PORT ? Number(process.env.PORT) : 4310;
const MAX_PENDING = Number(process.env.MAX_PENDING) || 10;          // 评测时可临时放宽
const RATE_PER_MIN = Number(process.env.RATE_PER_MIN) || 20;

// ---------- DB ----------
let db;
function loadDb() {
  db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDb() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 1), 'utf8');
}
loadDb();

// ---------- SSE 实时推送 ----------
// 学习 Grafana/Metabase 的"推代替拉"：状态变化立刻通知运营台，轮询只做降级兜底。
const sseClients = new Set();
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch { sseClients.delete(res); }
  }
}

// ---------- 运行时状态 ----------
let stagedSeq = 1;
const stagedChanges = []; // {id, action, params, reason, status, created_at, decided_at, decided_by}
const auditLog = [];      // {ts, actor, event, detail}
const rate = { windowStart: Date.now(), count: 0 }; // 简单限流：每分钟最多 20 次提案
let maxPending = Number(process.env.MAX_PENDING) || 10;
let ratePerMin = Number(process.env.RATE_PER_MIN) || 20;

// 暂存变更与审计落盘：重启不丢审批记录（订单/商品由 store.json 承载，这里只管"运行时状态"）
const RUNTIME_FILE = path.join(__dirname, '..', 'data', 'runtime.json');
function persistRuntime() {
  try {
    fs.writeFileSync(RUNTIME_FILE, JSON.stringify({
      staged_seq: stagedSeq,
      staged_changes: stagedChanges,
      audit_log: auditLog.slice(-500),
    }), 'utf8');
  } catch {}
}
function loadRuntime() {
  try {
    const d = JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    if (Array.isArray(d.staged_changes)) stagedChanges.push(...d.staged_changes);
    if (Array.isArray(d.audit_log)) auditLog.push(...d.audit_log);
    if (Number.isInteger(d.staged_seq)) stagedSeq = Math.max(stagedSeq, d.staged_seq);
  } catch {}
}
loadRuntime();

// ---------- 营业模拟引擎 ----------
// 让数据"活"起来：定期产生新订单并真实扣减库存；库存不足时订单流失（lost_events）。
// 这样 agent 的补货提案被批准后能立刻观察到后果（流失停止、洞察消解）。
// 评测时通过 POST /admin/sim {on:false} 关闭，保证 ground truth 确定。
const sim = { on: process.env.SIM !== '0', tickMs: Number(process.env.SIM_TICK_MS) || 12000 };
let nextOrderSeq = 5000;

function recomputeOrderSeq() {
  nextOrderSeq = 5000;
  for (const o of db.orders) {
    const n = Number(String(o.id).slice(4));
    if (n >= nextOrderSeq) nextOrderSeq = n + 1;
  }
}
recomputeOrderSeq();

const ri = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function simTick(force) {
  if (EXEC_MEDUSA) return; // 真店模式：真实订单是真实的，不注入模拟订单
  const r = Math.random();
  const n = force ? ri(1, 3) : (r < 0.3 ? 0 : r < 0.72 ? 1 : r < 0.92 ? 2 : 3);
  if (!n) return;
  const sellable = db.products.filter(p => p.status === 'published' && p.variants.some(v => v.price > 0));
  if (!sellable.length) return;
  for (let k = 0; k < n; k++) {
    const items = [];
    const lost = [];
    const itemCount = ri(1, 2);
    for (let m = 0; m < itemCount; m++) {
      const p = sellable[ri(0, sellable.length - 1)];
      const v = p.variants[ri(0, p.variants.length - 1)];
      if (v.price <= 0) continue;
      const qty = ri(1, 2);
      if (v.inventory >= qty) {
        v.inventory -= qty;
        items.push({ product_id: p.id, title: p.title, variant_id: v.id, sku: v.sku, quantity: qty, unit_price: v.price });
      } else {
        lost.push({ ts: new Date().toISOString(), product_id: p.id, title: p.title, variant_id: v.id, sku: v.sku, qty });
      }
    }
    if (items.length) {
      const total = items.reduce((s, it) => s + it.unit_price * it.quantity, 0);
      db.orders.push({
        id: `ord_${nextOrderSeq}`, display_id: `#${nextOrderSeq}`,
        status: Math.random() < 0.8 ? 'completed' : 'pending',
        items, total, currency: 'CNY',
        customer: `用户${ri(1000, 9999)}`,
        created_at: new Date().toISOString(),
        source: 'sim',
      });
      nextOrderSeq++;
    }
    db.lost_events.push(...lost);
  }
  if (db.orders.length > 4000) db.orders = db.orders.slice(-3500);
  if (db.lost_events.length > 2000) db.lost_events = db.lost_events.slice(-1500);
  saveDb();
  if (n) broadcast('refresh', { reason: 'tick', orders: db.orders.length });
}

function resetDemoData() {
  db = buildSeed();
  saveDb();
  recomputeOrderSeq();
  stagedChanges.length = 0;
  auditLog.length = 0;
  stagedSeq = 1;
  rate.windowStart = Date.now(); rate.count = 0;
  persistRuntime();
  audit('console', 'reset', { note: '演示数据已重置', sim_on: sim.on });
  broadcast('refresh', { reason: 'reset' });
}
recomputeOrderSeq();

// ---------- 洞察引擎 ----------
// 学习对象：Metabase/Grafana 的告警卡片、Bagisto 的低库存通知、商业产品 Triple Whale 的 insights feed。
// 每条洞察 = 问题 + 量化依据 + 可直接派给 Copilot 的自然语言任务（task）+ 可选免 key 预设（preset_id）。
function computeInsights() {
  return (async () => {
  const now = Date.now();
  const out = [];
  const ana = await dataAnalytics(30);
  const products = await dataProducts();
  const orders = await dataOrders(2000);

  // 1) 缺货流失（近 24h）—— 最紧急（仅仿真模式产生流失事件）
  if (!EXEC_MEDUSA) {
    const lost24 = (db.lost_events || []).filter(e => now - new Date(e.ts).getTime() < 864e5);
    if (lost24.length) {
      const skus = [...new Set(lost24.map(e => e.sku))];
      out.push({
        id: 'lost-sales', level: 'danger', icon: '🚨',
        title: `近24h 因缺货流失 ${lost24.length} 个订单项`,
        detail: `涉及 ${skus.slice(0, 3).join('、')}${skus.length > 3 ? ` 等 ${skus.length} 个 SKU` : ''}，补货后即恢复成交`,
        task: `过去24小时有 ${lost24.length} 个订单项因缺货流失，涉及 SKU：${skus.join(', ')}。请给这些变体各补货到 80，逐个提案。`,
        preset_id: 'w4',
      });
    }
  }

  // 2) 低库存售罄预测（近7天日销速度）
  const weekAgo = now - 7 * 864e5;
  const soldQty = {};
  for (const o of orders) {
    if (o.status === 'cancelled' || new Date(o.created_at).getTime() < weekAgo) continue;
    for (const it of (o.items || [])) {
      if (it.variant_id) soldQty[it.variant_id] = (soldQty[it.variant_id] || 0) + (it.quantity || 1);
    }
  }
  const risky = [];
  for (const p of products) {
    if (p.status !== 'published') continue;
    for (const v of p.variants) {
      if (v.inventory >= 10) continue;
      const vel = (soldQty[v.id] || 0) / 7;
      if (vel > 0 && v.inventory / vel < 5) risky.push({ p, v, vel });
      else if (v.inventory <= 2) risky.push({ p, v, vel: vel || 0.1 });
    }
  }
  if (risky.length) {
    const x = risky.sort((a, b) => a.v.inventory / a.vel - b.v.inventory / b.vel)[0];
    out.push({
      id: 'low-stock', level: 'warn', icon: '📦',
      title: `${risky.length} 个低库存变体有售罄风险`,
      detail: `最快「${x.p.title}」(${x.v.sku}) 仅剩 ${x.v.inventory} 件${x.vel > 0 ? `，日均售 ${x.vel.toFixed(1)} 件，预计 ${Math.max(1, Math.floor(x.v.inventory / x.vel))} 天售罄` : ''}`,
      task: '检查所有低库存变体，结合近7天销量给有售罄风险的补货到 50，逐个提案。',
      preset_id: 'w4',
    });
  }

  // 3) 滞销占压（14天零销量且库存>60）
  const twoWeeks = now - 14 * 864e5;
  const soldProducts = new Set();
  for (const o of orders) {
    if (o.status === 'cancelled' || new Date(o.created_at).getTime() < twoWeeks) continue;
    for (const it of (o.items || [])) if (it.product_id) soldProducts.add(it.product_id);
  }
  const stale = products.filter(p => p.status === 'published' && !soldProducts.has(p.id) && p.variants.reduce((s, v) => s + v.inventory, 0) > 60);
  if (stale.length) {
    out.push({
      id: 'stale', level: 'info', icon: '🕸️',
      title: `${stale.length} 个商品近14天零销量且库存占压`,
      detail: `如「${stale[0].title}」压着 ${stale[0].variants.reduce((s, v) => s + v.inventory, 0)} 件库存，可考虑清仓折扣`,
      task: `找出近14天零销量的商品（如 ${stale.slice(0, 3).map(p => p.title).join('、')}），按 8 折提案清仓改价，理由写清仓促销；0 元的异常变体跳过。`,
    });
  }

  // 4) 营收异动（近3天 vs 之前3天，±25%）
  const rev = ds => orders.filter(o => o.status !== 'cancelled' && new Date(o.created_at).getTime() >= now - ds * 864e5).reduce((s, o) => s + o.total, 0);
  const r3 = rev(3), p3 = rev(6) - rev(3);
  if (p3 > 100 && Math.abs(r3 - p3) / p3 > 0.25) {
    const pct = Math.round((r3 - p3) / p3 * 100);
    out.push({
      id: 'rev-anomaly', level: pct < 0 ? 'warn' : 'info', icon: pct < 0 ? '📉' : '📈',
      title: `近3天营收环比${pct > 0 ? '上涨' : '下滑'} ${Math.abs(pct)}%`,
      detail: `近3天 ¥${Math.round(r3).toLocaleString()} vs 之前3天 ¥${Math.round(p3).toLocaleString()}${pct < 0 ? '，建议排查流量与转化' : ''}`,
      task: `近3天营收环比${pct < 0 ? '下滑' : '上涨'}了 ${Math.abs(pct)}%，分析可能原因并给出可执行建议。`,
    });
  }

  // 5) 数据质量（零价格 / 缺描述 / 同名重复）
  for (const z of ana.data_quality.zero_price_variants) {
    out.push({
      id: 'zero-' + z.variant_id, level: 'warn', icon: '🏷️',
      title: `零价格变体：「${z.product}」${z.sku}`,
      detail: '价格为 0 元，用户无法正常下单，AI 导购也会判定为无效商品',
      task: `把「${z.product}」的零价格变体（${z.sku}）价格修复为 129 元，理由写修复异常价格。`,
      preset_id: 'w1',
    });
  }
  if (ana.data_quality.missing_description.length) {
    const m = ana.data_quality.missing_description;
    out.push({
      id: 'desc', level: 'info', icon: '📝',
      title: `${m.length} 个在售商品缺描述`,
      detail: `如「${m[0].title}」—— 缺描述商品在 AI 导购场景的曝光显著更低`,
      task: `为这些缺描述的商品补写合格描述并逐个提案：${m.map(x => x.title).join('、')}。`,
      preset_id: 'w5',
    });
  }
  const byTitle = {};
  for (const p of products) if (p.status === 'published') (byTitle[p.title] = byTitle[p.title] || []).push(p);
  const dups = Object.values(byTitle).filter(list => list.length >= 2);
  if (dups.length) {
    out.push({
      id: 'dup', level: 'info', icon: '👥',
      title: `${dups.length} 组同名重复商品`,
      detail: `「${dups[0][0].title}」出现 ${dups[0].length} 次，干扰搜索与比价`,
      task: `找到所有同名重复的商品，给其中一个的标题加「（清仓款）」后缀以示区分，逐个提案。`,
      preset_id: 'w3',
    });
  }

  const order = { danger: 0, warn: 1, info: 2 };
  return out.sort((a, b) => order[a.level] - order[b.level]);
  })();
}

function audit(actor, event, detail) {
  auditLog.push({ ts: new Date().toISOString(), actor, event, detail });
  persistRuntime();
}

// ---------- 工具函数 ----------
function findProduct(id) { return db.products.find(p => p.id === id); }
function findVariant(id) {
  for (const p of db.products) {
    const v = p.variants.find(v => v.id === id || v.sku === id);
    if (v) return { product: p, variant: v };
  }
  return null;
}
function json(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

// ---------- 只读查询（agent 可自由调用）----------
function productsView() {
  return db.products.map(p => ({
    id: p.id, title: p.title, category: p.category, status: p.status,
    description: p.description, tags: p.tags || [],
    variants: p.variants.map(v => ({ id: v.id, sku: v.sku, title: v.title, price: v.price, inventory: v.inventory })),
  }));
}
function ordersView(status, limit) {
  let list = db.orders;
  if (status) list = list.filter(o => o.status === status);
  list = [...list].sort((a, b) => b.created_at.localeCompare(a.created_at));
  if (limit) list = list.slice(0, limit);
  return list;
}
function analyticsSummary(days) {
  const since = Date.now() - days * 864e5;
  const recent = db.orders.filter(o => new Date(o.created_at).getTime() >= since);
  const completed = recent.filter(o => o.status === 'completed');
  const revenue = completed.reduce((s, o) => s + o.total, 0);
  const aov = completed.length ? revenue / completed.length : 0;
  const byStatus = {};
  for (const o of recent) byStatus[o.status] = (byStatus[o.status] || 0) + o.total;

  const qtyByProduct = {};
  for (const o of completed) for (const it of o.items) {
    qtyByProduct[it.product_id] = (qtyByProduct[it.product_id] || 0) + it.quantity;
  }
  const topProducts = Object.entries(qtyByProduct)
    .map(([id, qty]) => ({ product_id: id, title: (findProduct(id) || {}).title, qty }))
    .sort((a, b) => b.qty - a.qty).slice(0, 5);

  const lowStock = [];
  const zeroPrice = [];
  const missingDesc = [];
  for (const p of db.products) {
    if (p.status !== 'published') continue;
    if (!p.description) missingDesc.push({ id: p.id, title: p.title });
    for (const v of p.variants) {
      if (v.inventory < 10) lowStock.push({ product: p.title, variant_id: v.id, sku: v.sku, inventory: v.inventory });
      if (v.price <= 0) zeroPrice.push({ product: p.title, variant_id: v.id, sku: v.sku, price: v.price });
    }
  }
  return {
    period_days: days,
    revenue: Math.round(revenue * 100) / 100,
    order_count: recent.length,
    completed_count: completed.length,
    aov: Math.round(aov * 100) / 100,
    revenue_by_status: byStatus,
    top_products: topProducts,
    data_quality: { low_stock: lowStock, zero_price_variants: zeroPrice, missing_description: missingDesc },
  };
}

// 每日营收/订单量序列（图表数据源），completed 口径
function revenueTrend(days) {
  const dayStart = new Date();
  dayStart.setHours(0, 0, 0, 0);
  const out = [];
  for (let d = days - 1; d >= 0; d--) {
    const start = dayStart.getTime() - d * 864e5;
    const end = start + 864e5;
    const dayOrders = db.orders.filter(o => { const t = new Date(o.created_at).getTime(); return t >= start && t < end; });
    const revenue = dayOrders.filter(o => o.status === 'completed').reduce((s, o) => s + o.total, 0);
    out.push({
      date: new Date(start).toISOString().slice(5, 10).replace('-', '/'),
      revenue: Math.round(revenue * 100) / 100,
      orders: dayOrders.length,
    });
  }
  return out;
}

// ---------- 暂存变更（唯一的写路径）----------
const ACTIONS = {
  update_variant_price: {
    desc: '修改变体价格',
    validate(params) {
      if (typeof params.price !== 'number' || params.price <= 0) return 'price 必须是正数';
      if (EXEC_MEDUSA) return null; // 真店模式：存在性由执行器在批准时验证（medusa sku 不在本地库里）
      const hit = findVariant(params.variant_id);
      if (!hit) return 'variant 不存在: ' + params.variant_id;
      return null;
    },
    apply(params) {
      const { variant } = findVariant(params.variant_id);
      const before = variant.price;
      variant.price = params.price;
      return { variant_id: variant.id, price_before: before, price_after: params.price };
    },
  },
  update_product_title: {
    desc: '修改商品标题',
    validate(params) {
      if (!params.title || typeof params.title !== 'string') return 'title 必须是非空字符串';
      if (EXEC_MEDUSA) return null;
      if (!findProduct(params.product_id)) return 'product 不存在: ' + params.product_id;
      return null;
    },
    apply(params) {
      const p = findProduct(params.product_id);
      const before = p.title;
      p.title = params.title;
      return { product_id: p.id, title_before: before, title_after: params.title };
    },
  },
  update_product_description: {
    desc: '补全商品描述',
    validate(params) {
      if (!params.description || typeof params.description !== 'string') return 'description 必须是非空字符串';
      if (EXEC_MEDUSA) return null;
      const p = findProduct(params.product_id);
      if (!p) return 'product 不存在: ' + params.product_id;
      return null;
    },
    apply(params) {
      const p = findProduct(params.product_id);
      p.description = params.description;
      return { product_id: p.id, description_set: true };
    },
  },
  restock_variant: {
    desc: '补货（设置库存）',
    validate(params) {
      if (typeof params.inventory !== 'number' || params.inventory < 0) return 'inventory 必须是非负数';
      if (EXEC_MEDUSA) return null;
      const hit = findVariant(params.variant_id);
      if (!hit) return 'variant 不存在: ' + params.variant_id;
      return null;
    },
    apply(params) {
      const { variant } = findVariant(params.variant_id);
      const before = variant.inventory;
      variant.inventory = params.inventory;
      return { variant_id: variant.id, inventory_before: before, inventory_after: params.inventory };
    },
  },
};

async function createStagedChange(res, actor, body) {
  // 限流
  const now = Date.now();
  if (now - rate.windowStart > 60000) { rate.windowStart = now; rate.count = 0; }
  if (++rate.count > ratePerMin) return json(res, 429, { error: `提案过于频繁（限流：${ratePerMin} 次/分钟）` });

  const pending = stagedChanges.filter(c => c.status === 'pending').length;
  if (pending >= maxPending) {
    audit(actor, 'propose_rejected', { reason: '待审批变更已达上限' });
    return json(res, 429, { error: `待审批变更已有 ${pending} 条（上限 ${maxPending}），请先处理队列` });
  }

  const action = ACTIONS[body.action];
  if (!action) return json(res, 400, { error: '未知 action: ' + body.action + '，可用: ' + Object.keys(ACTIONS).join(', ') });
  const err = action.validate(body.params || {});
  if (err) {
    audit(actor, 'propose_rejected', { action: body.action, reason: err });
    return json(res, 400, { error: '参数校验失败: ' + err });
  }

  const change = {
    id: `chg_${String(stagedSeq++).padStart(4, '0')}`,
    action: body.action,
    params: body.params,
    reason: body.reason || '',
    status: 'pending',
    created_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
  };
  stagedChanges.push(change);
  audit(actor, 'propose', { change_id: change.id, action: change.action, params: change.params, reason: change.reason });
  broadcast('refresh', { reason: 'staged', change_id: change.id });
  return json(res, 201, {
    ok: true, change,
    note: '变更已暂存，等待人工审批。agent 无法自行生效。',
  });
}

// ---------- 任务集：按后端模式提供预设（mock 种子任务 / 真店快照动态任务）----------
async function getTaskSet(taskId) {
  if (EXEC_MEDUSA) {
    const { buildMedusaTasks } = require('../evals/tasks-medusa');
    const [products, orders] = await Promise.all([dataProducts(), dataOrders(null, 2000)]);
    const analytics = medusa.summarize(products, orders, 30);
    const tasks = buildMedusaTasks({ products, orders, analytics });
    return { task: tasks.find(t => t.id === taskId), tasks, ctx: { results: {} } };
  }
  const { buildTasks } = require('../evals/tasks');
  const { computeGroundTruth } = require('../evals/ground-truth');
  const tasks = buildTasks(computeGroundTruth());
  return { task: tasks.find(t => t.id === taskId), tasks, ctx: { results: {} } };
}

// ---------- 浏览器端 Agent 运行器（异步任务 + 轨迹实时可见）----------
// LLM 模式需要 server 启动时带 LLM_API_KEY 环境变量；脚本模式永远可用。
const agentJobs = new Map();
let jobSeq = 1;
let jobRunning = false;

function llmAvailable() {
  return !!process.env.LLM_API_KEY;
}

async function runJob(job) {
  const { McpClient } = require('../mcp/client');
  const mcp = new McpClient();
  try {
    await mcp.init();
    if (job.task_id) {
      // 脚本化预设任务（无需 LLM key）——任务集跟随后端模式（mock 种子 / 真店快照）
      const { task, ctx } = await getTaskSet(job.task_id);
      if (!task) throw new Error('预设任务不存在: ' + job.task_id);
      job.task_text = task.instruction;
      for (const step of task.steps) {
        const args = typeof step.args === 'function' ? step.args(ctx) : step.args;
        const result = await mcp.callTool(step.tool, args);
        if (step.save) ctx.results[step.save] = result;
        job.steps.push({ tool: step.tool, args, ok: true });
        if (step.tool.startsWith('propose_')) job.proposals++;
      }
      try { job.answer = task.answer(ctx); } catch { job.answer = `已完成 ${task.name}（${job.proposals} 条提案待审批）`; }
    } else {
      const { runLlmTask } = require('../agent/llm-agent');
      const r = await runLlmTask({
        mcp, taskText: job.task_text,
        onStep: entry => {
          job.steps.push(entry);
          if (entry.ok && entry.tool.startsWith('propose_')) job.proposals++;
        },
      });
      job.answer = r.answer;
      job.usage = r.usage;
    }
    job.status = 'done';
  } catch (e) {
    job.status = 'error';
    job.error = String(e.message || e);
  } finally {
    try { mcp.stop(); } catch {}
    jobRunning = false;
    job.finished_at = new Date().toISOString();
  }
}

async function createJob(req, res, body) {
  if (jobRunning) return json(res, 429, { error: '已有任务在运行，请稍候' });
  if (!body.task && !body.task_id) return json(res, 400, { error: '需要 task（自然语言）或 task_id（预设）' });
  if (!body.task_id && !llmAvailable()) {
    return json(res, 400, { error: '自由任务需要 LLM。请以 LLM_API_KEY 环境变量启动 server，或改用左侧预设任务（无需 key）。' });
  }
  const job = {
    id: `job_${String(jobSeq++).padStart(3, '0')}`,
    status: 'running',
    task_id: body.task_id || null,
    task_text: body.task || '',
    mode: body.task_id ? 'scripted' : 'llm',
    model: body.task_id ? null : (process.env.LLM_MODEL || null),
    steps: [],
    answer: null,
    usage: null,
    proposals: 0,
    started_at: new Date().toISOString(),
  };
  agentJobs.set(job.id, job);
  jobRunning = true;
  json(res, 201, { id: job.id });
  runJob(job); // 异步执行，前端轮询
}
// 审批生效的执行器：本地仿真 或 真实 Medusa 店铺
async function applyToBackend(change) {
  if (!EXEC_MEDUSA) {
    return { backend: 'local', result: ACTIONS[change.action].apply(change.params) };
  }
  const params = change.params;
  const products = await medusa.listProducts(200);
  const findVariant = (idOrSku) => {
    for (const p of products) {
      const v = p.variants.find(v => v.id === idOrSku || v.sku === idOrSku);
      if (v) return { product: p, variant: v };
    }
    return null;
  };
  if (change.action === 'update_variant_price') {
    const hit = findVariant(params.variant_id);
    if (!hit) throw new Error('Medusa 中找不到变体: ' + params.variant_id);
    await medusa.updateVariantPrice(hit.product.id, hit.variant.id, params.price, hit.variant.currency);
    return { backend: 'medusa', result: { variant_id: hit.variant.sku, price_after: params.price, currency: hit.variant.currency } };
  }
  if (change.action === 'update_product_title' || change.action === 'update_product_description') {
    const p = products.find(p => p.id === params.product_id);
    if (!p) throw new Error('Medusa 中找不到商品: ' + params.product_id);
    await medusa.updateProduct(p.id, { title: params.title, description: params.description });
    return { backend: 'medusa', result: { product_id: p.id } };
  }
  if (change.action === 'restock_variant') {
    const hit = findVariant(params.variant_id);
    if (!hit) throw new Error('Medusa 中找不到变体: ' + params.variant_id);
    await medusa.restock(hit.product.id, hit.variant, params.inventory);
    return { backend: 'medusa', result: { variant_id: hit.variant.sku, inventory_after: params.inventory } };
  }
  throw new Error('未知 action: ' + change.action);
}

// ---------- HTTP 路由 ----------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/console')) {
      const html = fs.readFileSync(path.join(__dirname, '..', 'console', 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(html);
    }
    if (p === '/health') return json(res, 200, { ok: true, db: DB_FILE });

    if (req.method === 'GET' && p === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(': connected\n\n');
      sseClients.add(res);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    if (p === '/admin/config') {
      if (req.method === 'GET') return json(res, 200, { max_pending: maxPending, rate_per_min: ratePerMin });
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (body.max_pending !== undefined) {
          const n = Number(body.max_pending);
          if (!Number.isInteger(n) || n < 1 || n > 1000) return json(res, 400, { error: 'max_pending 必须是 1-1000 的整数' });
          maxPending = n;
        }
        if (body.rate_per_min !== undefined) {
          const n = Number(body.rate_per_min);
          if (!Number.isInteger(n) || n < 1 || n > 10000) return json(res, 400, { error: 'rate_per_min 必须是 1-10000 的整数' });
          ratePerMin = n;
        }
        audit('console', 'config', { max_pending: maxPending, rate_per_min: ratePerMin });
        return json(res, 200, { max_pending: maxPending, rate_per_min: ratePerMin });
      }
    }

    if (req.method === 'POST' && p === '/admin/reset') {
      resetDemoData();
      return json(res, 200, { ok: true, products: db.products.length, orders: db.orders.length, sim_on: sim.on });
    }
    if (p === '/admin/sim') {
      if (req.method === 'GET') return json(res, 200, { on: sim.on, tick_ms: sim.tickMs });
      if (req.method === 'POST') {
        const body = await readBody(req);
        sim.on = !!body.on;
        audit('console', 'sim_toggle', { on: sim.on });
        return json(res, 200, { on: sim.on, tick_ms: sim.tickMs });
      }
    }
    if (req.method === 'POST' && p === '/admin/sim/tick') {
      if (!sim.on) return json(res, 409, { error: '营业模拟已暂停，先开启再快进' });
      simTick(true);
      return json(res, 200, { ok: true, orders: db.orders.length, lost_events: db.lost_events.length });
    }
    if (req.method === 'GET' && p === '/admin/insights') {
      return json(res, 200, { insights: await computeInsights(), sim_on: sim.on, backend: EXEC_MEDUSA ? 'medusa' : 'local' });
    }
    if (req.method === 'GET' && p === '/admin/revenue-trend') {
      return json(res, 200, { trend: await dataTrend(Number(url.searchParams.get('days')) || 30) });
    }

    // ---------- 竞品价格监测与改价建议 ----------
    if (p === '/admin/market/report') {
      const [products, orders] = await Promise.all([dataProducts(), dataOrders(null, 2000)]);
      return json(res, 200, await market.marketReport(products, orders, Number(url.searchParams.get('days')) || 30));
    }
    if (p === '/admin/market/apply-suggestion' && req.method === 'POST') {
      // 把改价建议一键转成暂存变更（仍需人工批准——建议是引擎出的，生效权在人）
      const body = await readBody(req);
      const variant = String(body.variant_id || body.sku || '');
      const price = Number(body.price);
      if (!variant || !(price > 0)) return json(res, 400, { error: '需要 variant_id/sku 和正数 price' });
      return createStagedChange(res, 'pricing-engine', {
        action: 'update_variant_price',
        params: { variant_id: variant, price },
        reason: body.reason || `市场定价建议：${body.title || variant} 调整至 ¥${price}`,
      });
    }
    if (p === '/agent/status') {
      return json(res, 200, { llm_available: llmAvailable(), model: process.env.LLM_MODEL || null, running: jobRunning, backend: EXEC_MEDUSA ? 'medusa' : 'mock' });
    }
    if (p === '/agent/presets') {
      const { tasks } = await getTaskSet();
      const presets = tasks.map(t => ({ id: t.id, type: t.type, name: t.name, instruction: t.instruction }));
      return json(res, 200, { presets, backend: EXEC_MEDUSA ? 'medusa' : 'mock' });
    }
    if (p === '/agent/run' && req.method === 'POST') {
      const body = await readBody(req);
      return createJob(req, res, body);
    }
    let mJob = p.match(/^\/agent\/run\/(job_\d+)$/);
    if (mJob && req.method === 'GET') {
      const job = agentJobs.get(mJob[1]);
      if (!job) return json(res, 404, { error: '任务不存在' });
      return json(res, 200, job);
    }

    if (!p.startsWith('/admin/')) return json(res, 404, { error: 'not found' });

    if (req.method === 'GET' && p === '/admin/products') return json(res, 200, { products: await dataProducts() });
    if (req.method === 'GET' && p === '/admin/orders') {
      return json(res, 200, { orders: await dataOrders(url.searchParams.get('status') || undefined, Number(url.searchParams.get('limit')) || undefined) });
    }
    if (req.method === 'GET' && p === '/admin/analytics/summary') {
      return json(res, 200, await dataAnalytics(Number(url.searchParams.get('days')) || 30));
    }
    if (req.method === 'GET' && p === '/admin/audit') return json(res, 200, { audit: auditLog.slice(-100).reverse() });

    if (p === '/admin/staged-changes') {
      if (req.method === 'GET') return json(res, 200, { staged_changes: stagedChanges });
      if (req.method === 'POST') {
        const body = await readBody(req);
        return createStagedChange(res, body.actor || 'agent', body);
      }
    }
    let m = p.match(/^\/admin\/staged-changes\/(chg_\d+)\/(approve|reject)$/);
    if (m && req.method === 'POST') {
      const [, id, verb] = m;
      const change = stagedChanges.find(c => c.id === id);
      if (!change) return json(res, 404, { error: '变更不存在: ' + id });
      if (change.status !== 'pending') return json(res, 409, { error: `变更已处理（${change.status}）` });
      const body = await readBody(req);
      const who = body.approved_by || 'merchant';
      if (verb === 'reject') {
        change.status = 'rejected'; change.decided_at = new Date().toISOString(); change.decided_by = who;
        audit(who, 'reject', { change_id: id, action: change.action });
        broadcast('refresh', { reason: 'staged', change_id: id });
        return json(res, 200, { ok: true, change });
      }
      let applied;
      try {
        applied = await applyToBackend(change);
      } catch (e) {
        // 执行失败 → 变更保持 pending（审批未生效，可重试），审计留痕
        audit(who, 'approve_failed', { change_id: id, action: change.action, error: String(e.message).slice(0, 200) });
        return json(res, 502, { error: '执行失败（变更仍为待审批）: ' + e.message });
      }
      change.status = 'applied'; change.decided_at = new Date().toISOString(); change.decided_by = who;
      if (applied.backend === 'local') saveDb();
      audit(who, 'approve', { change_id: id, action: change.action, backend: applied.backend, result: applied.result });
      broadcast('refresh', { reason: 'staged', change_id: id });
      return json(res, 200, { ok: true, change, applied: applied.result, backend: applied.backend });
    }

    // 围栏演示：任何直接写商品的尝试都返回 403
    if (/^\/admin\/(products|orders)\//.test(p) && req.method !== 'GET') {
      audit('unknown', 'fence_blocked', { path: p, method: req.method });
      return json(res, 403, { error: '禁止直接写数据。所有变更必须通过 /admin/staged-changes 提交并人工审批。' });
    }

    return json(res, 404, { error: 'not found: ' + req.method + ' ' + p });
  } catch (e) {
    return json(res, 500, { error: String(e && e.message || e) });
  }
});

server.listen(PORT, () => {
  const { style } = require('../cli/ui');
  const dim = (s) => process.stderr.isTTY ? '\x1b[2m' + s + '\x1b[0m' : s;
  console.log('');
  console.log('  ' + style.bold('◆ 店铺运营台后端') + '  ' + style.cyan('http://127.0.0.1:' + PORT));
  console.log('  ' + dim(`运营台 ${'http://127.0.0.1:' + PORT + '/'}  ·  数据源 ${EXEC_MEDUSA ? '真店 Medusa' : '本地仿真'}  ·  模拟 ${EXEC_MEDUSA ? '停用' : sim.on ? '开' : '关'}`));
  console.log('  ' + dim('写路径仅 /admin/staged-changes（人工审批）· MCP 服务由 agent 按需拉起'));
  console.log('');
  if (sim.on && !EXEC_MEDUSA) setInterval(() => { if (sim.on) simTick(false); }, sim.tickMs);
  setInterval(() => { for (const res of sseClients) { try { res.write(': hb\n\n'); } catch { sseClients.delete(res); } } }, 25000);
});
