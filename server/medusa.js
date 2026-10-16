// Medusa v2 Admin API 客户端（零依赖）—— merchant-copilot 的"真店铺"后端适配器。
//
// 职责：
// - 登录换取 JWT 并自动续期（/auth/user/emailpass）
// - 读：商品（含变体/价格/库存）、订单
// - 写：改价、改标题/描述、补库存（审批门批准后由 store-server 调用执行）
//
// 环境变量：
//   MEDUSA_URL      默认 http://127.0.0.1:9000
//   MEDUSA_EMAIL    管理员邮箱
//   MEDUSA_PASSWORD 管理员密码
'use strict';

const BASE = (process.env.MEDUSA_URL || 'http://127.0.0.1:9000').replace(/\/$/, '');
const EMAIL = process.env.MEDUSA_EMAIL || 'admin@merchant.local';
const PASSWORD = process.env.MEDUSA_PASSWORD || 'copilot2026';

let token = null;
let tokenAt = 0;

async function login(force) {
  if (token && !force && Date.now() - tokenAt < 20 * 60 * 1000) return token;
  const res = await fetch(BASE + '/auth/user/emailpass', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.token) throw new Error('Medusa 登录失败: HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 150));
  token = data.token;
  tokenAt = Date.now();
  return token;
}

async function api(pathname, init = {}, retried = false) {
  const t = await login();
  const res = await fetch(BASE + pathname, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t, ...(init.headers || {}) },
  });
  // 401 → 登录态过期，强制续期重试一次
  if (res.status === 401 && !retried) {
    await login(true);
    return api(pathname, init, true);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || ('Medusa HTTP ' + res.status));
    err.status = res.status;
    err.invalidFields = data.message && /Unrecognized fields/.test(data.message) ? data.message : null;
    throw err;
  }
  return data;
}

// ---------- 字段映射：Medusa 形状 → merchant-copilot 工具形状 ----------
function mapProduct(p) {
  return {
    id: p.id,
    title: p.title,
    category: (p.collection && p.collection.title) || (p.type && p.type.value) || '-',
    status: p.status,
    description: p.description || '',
    tags: (p.tags || []).map(t => t.value),
    variants: (p.variants || []).map(v => ({
      id: v.id,
      sku: v.sku || v.id,
      title: v.title,
      price: (v.prices && v.prices.length ? v.prices[0].amount / 100 : 0), // 分 → 元
      currency: (v.prices && v.prices.length && v.prices[0].currency_code) || 'usd',
      inventory: v.inventory_quantity != null ? v.inventory_quantity : (v.inventory_items?.[0]?.stocked_quantity ?? 0),
      inventory_item_id: v.inventory_items && v.inventory_items[0] && v.inventory_items[0].id,
    })),
  };
}

// ---------- 读 ----------
let stockLocationId = null;

async function ensureStockLocation() {
  if (stockLocationId) return stockLocationId;
  const sl = await api('/admin/stock-locations');
  if (sl.stock_locations && sl.stock_locations.length) {
    stockLocationId = sl.stock_locations[0].id;
  } else {
    const created = await api('/admin/stock-locations', { method: 'POST', body: JSON.stringify({ name: 'Default Warehouse' }) });
    stockLocationId = created.stock_location.id;
  }
  return stockLocationId;
}

async function listProducts(limit = 100) {
  // 带 inventory_items 展开字段，才能拿到 variant -> inventory_item 的映射
  const data = await api('/admin/products?limit=' + limit + '&order=-created_at&fields=+variants.inventory_items.*');
  const products = data.products || [];
  // 一次性拉库存项（location_levels 里有各仓 stocked_quantity）
  const stocked = {};
  try {
    const inv = await api('/admin/inventory-items?limit=500');
    for (const it of inv.inventory_items || []) {
      stocked[it.id] = (it.location_levels || []).reduce((s, l) => s + (l.stocked_quantity || 0), 0);
    }
  } catch {}
  return products.map(p => ({
    ...mapProduct(p),
    variants: (p.variants || []).map(v => ({
      id: v.id,
      sku: v.sku || v.id,
      title: v.title,
      price: (v.prices && v.prices.length ? v.prices[0].amount / 100 : 0),
      currency: (v.prices && v.prices.length && v.prices[0].currency_code) || 'usd',
      inventory: v.inventory_items && v.inventory_items[0] ? (stocked[v.inventory_items[0].inventory_item_id] || 0) : 0,
      inventory_item_id: v.inventory_items && v.inventory_items[0] && v.inventory_items[0].inventory_item_id,
    })),
  }));
}

async function listOrders(limit = 200) {
  const data = await api('/admin/orders?limit=' + limit + '&order=-created_at');
  return data.orders || [];
}

// ---------- 写（审批门批准后执行）----------
async function updateVariantPrice(productId, variantId, amountYuan, currency) {
  // v2 改价 = 更新变体 prices（全量替换该变体价格集）
  return api(`/admin/products/${productId}/variants/${variantId}`, {
    method: 'POST',
    body: JSON.stringify({ prices: [{ amount: Math.round(amountYuan * 100), currency_code: currency || 'usd' }] }),
  });
}

async function updateProduct(productId, fields) {
  const body = {};
  if (fields.title) body.title = fields.title;
  if (fields.description) body.description = fields.description;
  return api('/admin/products/' + productId, { method: 'POST', body: JSON.stringify(body) });
}

async function restock(productId, variant, quantity) {
  // v2 库存模型：variant -> inventory_item -> location_level（按仓记库存）
  const locId = await ensureStockLocation();
  let iid = variant.inventory_item_id;
  if (!iid) {
    const detail = await api(`/admin/products/${productId}?fields=+variants.inventory_items.*`);
    const v = (detail.product.variants || []).find(x => x.id === variant.id);
    iid = v && v.inventory_items && v.inventory_items[0] && v.inventory_items[0].inventory_item_id;
  }
  if (!iid) throw new Error('找不到变体对应的 inventory_item: ' + (variant.sku || variant.id));
  const levels = await api(`/admin/inventory-items/${iid}/location-levels`);
  const existing = (levels.inventory_levels || []).find(l => l.location_id === locId);
  if (existing) {
    return api(`/admin/inventory-items/${iid}/location-levels/${locId}`, {
      method: 'POST',
      body: JSON.stringify({ stocked_quantity: quantity }),
    });
  }
  return api(`/admin/inventory-items/${iid}/location-levels`, {
    method: 'POST',
    body: JSON.stringify({ location_id: locId, stocked_quantity: quantity }),
  });
}

module.exports = {
  BASE,
  available: () => !!(process.env.MEDUSA_URL || process.env.MEDUSA_EMAIL),
  login,
  api,
  mapProduct,
  listProducts,
  listOrders,
  updateVariantPrice,
  updateProduct,
  restock,
};
