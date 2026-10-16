// MCP Server（stdio 传输，零依赖）—— 把店铺后端暴露为 agent 可调用的工具集。
//
// 安全设计要点：
// - 只读工具（search_products / list_orders / get_analytics ...）自由开放；
// - 写操作全部映射为 propose_* 工具 → 服务端只产生"暂存变更"，不直接生效；
// - 刻意【不提供】approve / reject 工具：审批是纯人工动作（运营台或 API），
//   agent 在协议层面就拿不到"自己批准自己"的路径。
//
// 协议：JSON-RPC 2.0 over stdio，换行分隔（与 MCP 官方 stdio 传输一致）。
'use strict';
const STORE = process.env.STORE_URL || 'http://127.0.0.1:4310';

// ---------- 工具定义 ----------
const TOOLS = [
  {
    name: 'search_products',
    description: '按关键词/类目搜索商品，返回标题、类目、状态、变体（含价格与库存）。用于查找商品及其 variant_id。',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '标题或标签关键词，可为空' },
        category: { type: 'string', description: '类目过滤，如 连衣裙' },
        status: { type: 'string', enum: ['published', 'draft'] },
      },
    },
  },
  {
    name: 'get_product',
    description: '按 product_id 获取单个商品详情。',
    inputSchema: { type: 'object', required: ['product_id'], properties: { product_id: { type: 'string' } } },
  },
  {
    name: 'list_orders',
    description: '查询订单列表，可按状态过滤（completed/pending/cancelled），按时间倒序。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['completed', 'pending', 'cancelled'] }, limit: { type: 'number' } },
    },
  },
  {
    name: 'get_analytics',
    description: '获取经营分析：近 N 天营收/订单数/AOV/热卖榜，以及数据质量问题清单（低库存、零价格变体、缺描述商品）。',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: '统计周期天数，默认 30' } } },
  },
  {
    name: 'find_stale_products',
    description: '找出近 N 天零销量（按已完成订单）且总库存超过阈值的在售商品——滞销品，用于清仓/促销决策。返回商品及其全部变体价格。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '观察期天数，默认 14' },
        min_inventory: { type: 'number', description: '总库存阈值，默认 60' },
      },
    },
  },
  {
    name: 'get_staged_changes',
    description: '查看当前暂存变更队列（agent 提出的、等待人工审批的变更）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'propose_price_change',
    description: '提议修改变体价格。注意：只产生暂存变更，需店主在运营台人工批准后才会生效。',
    inputSchema: {
      type: 'object',
      required: ['variant_id', 'price'],
      properties: {
        variant_id: { type: 'string', description: '变体 id 或 SKU' },
        price: { type: 'number', description: '新价格（正数，元）' },
        reason: { type: 'string', description: '提案理由，会展示给审批人' },
      },
    },
  },
  {
    name: 'propose_product_update',
    description: '提议修改商品标题或补全描述（至少填一项）。只产生暂存变更，需人工批准。',
    inputSchema: {
      type: 'object',
      required: ['product_id'],
      properties: {
        product_id: { type: 'string' },
        title: { type: 'string' },
        description: { type: 'string' },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'propose_restock',
    description: '提议对低库存变体补货（设置新库存数）。只产生暂存变更，需人工批准。',
    inputSchema: {
      type: 'object',
      required: ['variant_id', 'inventory'],
      properties: {
        variant_id: { type: 'string', description: '变体 id 或 SKU' },
        inventory: { type: 'number' },
        reason: { type: 'string' },
      },
    },
  },
];

// ---------- 工具实现（全部走店铺 HTTP API）----------
async function api(pathname, init) {
  const res = await fetch(STORE + pathname, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function callTool(name, args) {
  switch (name) {
    case 'search_products': {
      const { products } = await api('/admin/products');
      const q = (args.query || '').toLowerCase();
      const hit = products.filter(p =>
        (!q || p.title.toLowerCase().includes(q)
          || (p.tags || []).some(t => t.toLowerCase().includes(q))
          || p.variants.some(v => v.sku.toLowerCase().includes(q) || (v.title || '').toLowerCase().includes(q))) &&
        (!args.category || p.category === args.category) &&
        (!args.status || p.status === args.status)
      );
      return hit.map(p => ({ id: p.id, title: p.title, category: p.category, status: p.status,
        variants: p.variants.map(v => ({ id: v.id, sku: v.sku, title: v.title, price: v.price, inventory: v.inventory })) }));
    }
    case 'get_product': {
      const { products } = await api('/admin/products');
      const p = products.find(x => x.id === args.product_id);
      if (!p) throw new Error('商品不存在: ' + args.product_id);
      return p;
    }
    case 'list_orders':
      return (await api(`/admin/orders?status=${args.status || ''}&limit=${args.limit || 20}`)).orders;
    case 'get_analytics':
      return api('/admin/analytics/summary?days=' + (args.days || 30));
    case 'find_stale_products': {
      const days = args.days || 14;
      const minInv = args.min_inventory == null ? 60 : args.min_inventory;
      const [{ products }, { orders }] = await Promise.all([
        api('/admin/products'),
        api(`/admin/orders?status=completed&limit=2000`),
      ]);
      const since = Date.now() - days * 864e5;
      const sold = new Set();
      for (const o of orders) {
        if (new Date(o.created_at).getTime() < since) continue;
        for (const it of o.items) sold.add(it.product_id);
      }
      return products
        .filter(p => p.status === 'published' && !sold.has(p.id))
        .map(p => ({ ...p, total_inventory: p.variants.reduce((s, v) => s + v.inventory, 0) }))
        .filter(p => p.total_inventory > minInv)
        .map(p => ({ id: p.id, title: p.title, category: p.category, total_inventory: p.total_inventory,
          variants: p.variants.map(v => ({ id: v.id, sku: v.sku, price: v.price, inventory: v.inventory })) }));
    }
    case 'get_staged_changes':
      return (await api('/admin/staged-changes')).staged_changes;
    case 'propose_price_change':
      return api('/admin/staged-changes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'update_variant_price', params: { variant_id: args.variant_id, price: args.price }, reason: args.reason || '', actor: 'agent' }),
      });
    case 'propose_product_update': {
      const params = { product_id: args.product_id };
      const action = args.title ? 'update_product_title' : 'update_product_description';
      if (args.title) params.title = args.title;
      if (args.description) params.description = args.description;
      if (args.title && args.description) {
        // 两个都改 → 拆成两条暂存变更
        const a = await api('/admin/staged-changes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update_product_title', params: { product_id: args.product_id, title: args.title }, reason: args.reason || '', actor: 'agent' }) });
        const b = await api('/admin/staged-changes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'update_product_description', params: { product_id: args.product_id, description: args.description }, reason: args.reason || '', actor: 'agent' }) });
        return [a, b];
      }
      return api('/admin/staged-changes', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, params, reason: args.reason || '', actor: 'agent' }) });
    }
    case 'propose_restock':
      return api('/admin/staged-changes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'restock_variant', params: { variant_id: args.variant_id, inventory: args.inventory }, reason: args.reason || '', actor: 'agent' }),
      });
    default:
      throw new Error('未知工具: ' + name);
  }
}

// ---------- JSON-RPC over stdio ----------
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let idx;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line) handle(line).catch(e => e && console.error(String(e)));
  }
});

async function handle(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method } = msg;
  if (method === 'initialize') {
    return send({ jsonrpc: '2.0', id, result: {
      protocolVersion: msg.params?.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'merchant-copilot-store', version: '0.1.0' },
    } });
  }
  if (method && method.startsWith('notifications/')) return; // initialized 等
  if (method === 'tools/list') {
    return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  }
  if (method === 'tools/call') {
    const { name, arguments: args } = msg.params || {};
    try {
      const result = await callTool(name, args || {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] } });
    } catch (e) {
      return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: '工具执行失败: ' + String(e.message || e) }] } });
    }
  }
  if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
}

function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }
process.stderr.write(`[mcp] merchant-copilot-store MCP server ready -> ${STORE}\n`);
