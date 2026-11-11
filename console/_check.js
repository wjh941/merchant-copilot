'use strict';
// ================= 基础 =================
const $ = id => document.getElementById(id);
const fmtY = n => '¥' + Math.round(n).toLocaleString('zh-CN');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function toast(msg, type) {
  const el = document.createElement('div');
  el.className = 'toast ' + (type || '');
  el.innerHTML = (type === 'ok' ? '✅ ' : type === 'bad' ? '⚠️ ' : '💡 ') + esc(msg);
  $('toasts').appendChild(el);
  setTimeout(() => { el.classList.add('leaving'); setTimeout(() => el.remove(), 320); }, 2800);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  return { ok: res.ok, status: res.status, data: data || {} };
}

// ================= 数字滚动动画 =================
const counters = new Map();
function setNum(id, target, fmt) {
  const el = $(id);
  const from = counters.has(id) ? counters.get(id) : 0;
  counters.set(id, target);
  if (from === target) { el.textContent = fmt(target); return; }
  const t0 = performance.now(), dur = 600;
  function frame(t) {
    const p = Math.min(1, (t - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (target - from) * eased);
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function setDelta(id, cur, prev) {
  const el = $(id);
  if (prev === undefined || prev === 0) { el.style.display = 'none'; return; }
  el.style.display = '';
  const pct = (cur - prev) / prev * 100;
  el.className = 'delta ' + (pct > 1 ? 'up' : pct < -1 ? 'down' : 'flat');
  el.textContent = (pct > 0 ? '↑ ' : pct < 0 ? '↓ ' : '· ') + Math.abs(pct).toFixed(1) + '%';
}

// ================= 趋势图（canvas，无依赖）=================
let trend = [], metric = 'revenue', chartAnim = null, chartPoints = [];

function setMetric(m) {
  metric = m;
  $('seg-rev').classList.toggle('on', m === 'revenue');
  $('seg-ord').classList.toggle('on', m === 'orders');
  drawChart(true);
}

function drawChart(animate) {
  const cv = $('chart'), tip = $('chart-tip');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 220;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  if (!trend.length) return;

  const pad = { l: 46, r: 12, t: 14, b: 24 };
  const data = trend.map(d => metric === 'revenue' ? d.revenue : d.orders);
  const max = Math.max(...data, 1) * 1.15;
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const x = i => pad.l + iw * (i / (data.length - 1 || 1));
  const y = v => pad.t + ih * (1 - v / max);
  chartPoints = data.map((v, i) => ({ x: x(i), y: y(v), d: trend[i] }));

  ctx.font = '10.5px "Segoe UI"'; ctx.fillStyle = '#646d84'; ctx.strokeStyle = 'rgba(255,255,255,.055)'; ctx.lineWidth = 1;
  for (let g = 0; g <= 4; g++) {
    const gy = pad.t + ih * g / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    const val = max * (1 - g / 4);
    ctx.fillText(metric === 'revenue' ? (val >= 10000 ? (val / 1000).toFixed(0) + 'k' : Math.round(val)) : Math.round(val), 6, gy + 3.5);
  }
  ctx.fillText(trend[0].date, pad.l - 8, H - 8);
  ctx.fillText(trend[trend.length - 1].date, W - pad.r - 30, H - 8);

  const draw = (frac) => {
    const n = Math.max(2, Math.ceil(data.length * frac));
    const pts = chartPoints.slice(0, n);
    const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    if (metric === 'revenue') { grad.addColorStop(0, 'rgba(129,140,248,.32)'); grad.addColorStop(1, 'rgba(129,140,248,0)'); }
    else { grad.addColorStop(0, 'rgba(52,211,153,.25)'); grad.addColorStop(1, 'rgba(52,211,153,0)'); }
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.lineTo(pts[pts.length - 1].x, H - pad.b); ctx.lineTo(pts[0].x, H - pad.b); ctx.closePath();
    ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath();
    pts.forEach((p, i) => i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y));
    ctx.strokeStyle = metric === 'revenue' ? '#818cf8' : '#34d399';
    ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.stroke();
    const last = pts[pts.length - 1];
    ctx.beginPath(); ctx.arc(last.x, last.y, 3.5, 0, 7); ctx.fillStyle = ctx.strokeStyle; ctx.fill();
    ctx.beginPath(); ctx.arc(last.x, last.y, 7, 0, 7); ctx.strokeStyle = ctx.strokeStyle; ctx.globalAlpha = .35; ctx.stroke(); ctx.globalAlpha = 1;
  };

  if (chartAnim) cancelAnimationFrame(chartAnim);
  if (animate) {
    const t0 = performance.now();
    (function frame(t) {
      const p = Math.min(1, (t - t0) / 650);
      draw(1 - Math.pow(1 - p, 3));
      if (p < 1) chartAnim = requestAnimationFrame(frame);
    })(t0);
  } else draw(1);

  cv.onmousemove = e => {
    const rect = cv.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    let best = null, bd = 1e9;
    for (const p of chartPoints) { const d = Math.abs(p.x - mx); if (d < bd) { bd = d; best = p; } }
    if (!best || bd > 28) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    tip.innerHTML = `<span style="color:var(--text-2)">${best.d.date}</span><br><b>${metric === 'revenue' ? fmtY(best.d.revenue) : best.d.orders + ' 单'}</b><br><span style="color:var(--text-3)">订单 ${best.d.orders} 笔</span>`;
    const tx = Math.min(best.x + 14, W - 130);
    tip.style.left = tx + 'px';
    tip.style.top = (best.y - 10) + 'px';
  };
  cv.onmouseleave = () => { tip.style.display = 'none'; };
}
window.addEventListener('resize', () => drawChart(false));

// ================= 数据加载与渲染 =================
const state = { analytics: null, staged: [], products: [], queueFilter: 'all' };

const VIEW_META = {
  overview: ['经营总览', '店铺的核心指标、Copilot 洞察与经营趋势'],
  queue: ['审批队列', 'agent 的提案在这里排队——批准后才会真实生效'],
  products: ['商品', '浏览全部商品，搜索（支持 SKU）/ 类目 / 状态过滤'],
  market: ['竞品价格', '市场价格带对比与改价建议（含预期影响测算）'],
  agent: ['Copilot', '给智能体派活：预设任务免 key，自由任务需 LLM key'],
  audit: ['审计日志', '每次提案 / 批准 / 拒绝 / 围栏拦截全留痕'],
};

function switchView(name) {
  document.querySelectorAll('.nav-item').forEach(t => t.classList.toggle('on', t.dataset.view === name));
  document.querySelectorAll('.view').forEach(p => p.classList.toggle('on', p.id === 'view-' + name));
  const meta = VIEW_META[name];
  if (meta) { $('t-title').textContent = meta[0]; $('t-sub') && ($('t-sub').textContent = meta[1]); }
  if (name === 'audit') refresh(true);
  if (name === 'market' && market) { renderMarket(); if (mktSel) selectProduct(mktSel); }
  if (name === 'overview') drawChart(false);
  history.replaceState(null, '', '#' + name);
}
document.querySelectorAll('.nav-item').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));

function renderKpis(a) {
  setNum('kpi-revenue', a.revenue, fmtY);
  setNum('kpi-orders', a.order_count, n => Math.round(n).toLocaleString());
  setNum('kpi-aov', a.aov, n => '¥' + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ','));
  const pending = state.staged.filter(c => c.status === 'pending').length;
  setNum('kpi-pending', pending, n => String(Math.round(n)));
  if (trend.length >= 14) {
    const sum = (arr, k) => arr.reduce((s, d) => s + d[k], 0);
    const cur = trend.slice(-7), prev = trend.slice(-14, -7);
    setDelta('d-revenue', sum(cur, 'revenue'), sum(prev, 'revenue'));
    $('sub-revenue').textContent = `近7天 ${fmtY(sum(cur, 'revenue'))}`;
    setDelta('d-orders', sum(cur, 'orders'), sum(prev, 'orders'));
    $('sub-orders').textContent = `近7天 ${sum(cur, 'orders')} 单`;
  }
  const badge = $('queue-n');
  badge.textContent = pending;
  badge.classList.toggle('zero', pending === 0);
  badge.classList.add('pop');
  setTimeout(() => badge.classList.remove('pop'), 220);
}

const ACTION_NAMES = { update_variant_price: '修改变体价格', update_product_title: '修改商品标题', update_product_description: '补全商品描述', restock_variant: '变体补货' };

function renderQueue() {
  const box = $('staged');
  let list = state.staged;
  if (state.queueFilter !== 'all') list = list.filter(c => c.status === state.queueFilter);
  if (!list.length) {
    box.innerHTML = `<div class="empty">队列空空如也 —— 去 <b onclick="switchView('agent')">🤖 Copilot</b> 派个活，或跑 <code>npm run -s demo</code></div>`;
    return;
  }
  box.innerHTML = list.map((c, i) => `
    <div class="chg ${c.status}" style="animation-delay:${Math.min(i * 40, 240)}ms">
      <div class="head">
        <span><span class="action">${ACTION_NAMES[c.action] || esc(c.action)}</span>&nbsp;&nbsp;<span class="id">${c.id}</span></span>
        <span class="badge ${c.status}">${({pending:'待审批', applied:'已生效', rejected:'已拒绝'})[c.status]}</span>
      </div>
      <div class="params">${esc(JSON.stringify(c.params, null, 1))}</div>
      ${c.reason ? `<div class="reason">${esc(c.reason)}</div>` : ''}
      ${c.status === 'pending' ? `
        <button class="btn btn-approve" onclick="decide('${c.id}','approve',this)">✓ 批准生效</button>
        <button class="btn btn-reject" onclick="decide('${c.id}','reject',this)">✕ 拒绝</button>` : ''}
    </div>`).join('');
}

async function decide(id, verb, btn) {
  btn.disabled = true;
  const { ok, data } = await api(`/admin/staged-changes/${id}/${verb}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ approved_by: '店主(运营台)' }),
  });
  if (ok) toast(verb === 'approve' ? `已生效：${id}` : `已拒绝：${id}`, 'ok');
  else toast(data.error || '操作失败', 'bad');
  refresh(true);
}

function renderQuality(dq) {
  const item = (tag, cls, main, sub) => `<div class="dq-item"><span><span class="tag ${cls}">${tag}</span>${esc(main)}</span><span class="muted">${esc(sub)}</span></div>`;
  let html = '';
  for (const z of dq.zero_price_variants) html += item('零价格', 'zero', z.product, z.sku);
  for (const l of dq.low_stock) html += item('低库存', 'low', l.product, `${l.sku} · 剩 ${l.inventory}`);
  for (const m of dq.missing_description) html += item('缺描述', 'desc', m.title, m.id);
  $('dq').innerHTML = html || '<div class="empty">数据质量良好 🎉</div>';
}

// ---------- 洞察建议 ----------
let insights = [], simOn = true;
const insTasks = {};
const INS_LEVEL = { danger: ['danger', '紧急'], warn: ['warn', '注意'], info: ['info', '建议'] };

function renderInsights() {
  const box = $('insights');
  $('ins-sub').textContent = medusaMode
    ? '真店数据 · 主动扫描，一键派给 agent（批准前数据不会变）'
    : simOn ? '营业模拟进行中 · 主动扫描，一键派给 agent（批准前数据不会变）' : '模拟已暂停 · 一键派给 agent（批准前数据不会变）';
  if (!insights.length) {
    box.innerHTML = '<div class="ins-card info"><div class="ins-title">✅ 一切正常</div><div class="ins-detail">暂无需要关注的经营风险。新订单进来后会持续扫描。</div></div>';
    return;
  }
  box.innerHTML = insights.map((c, i) => `
    <div class="ins-card ${INS_LEVEL[c.level]?.[0] || 'info'}" style="animation-delay:${Math.min(i * 50, 300)}ms">
      <div class="ins-title">${c.icon} ${esc(c.title)}<span class="tag ${INS_LEVEL[c.level]?.[0]}" style="margin-left:8px">${INS_LEVEL[c.level]?.[1]}</span></div>
      <div class="ins-detail">${esc(c.detail)}</div>
      <div class="ins-actions">
        ${llmOk ? `<button class="btn-mini primary" onclick="runInsightTask('${c.id}')">🤖 让 Copilot 处理</button>` : ''}
        ${c.preset_id ? `<button class="btn-mini" onclick="runPreset('${c.preset_id}', this)" title="无需 API key 的预设修复任务">⚡ 免 key 预设修复</button>` : ''}
        ${!llmOk && !c.preset_id ? `<button class="btn-mini" disabled title="配置 LLM_API_KEY 后可用">需 LLM key</button>` : ''}
      </div>
    </div>`).join('');
}

async function runInsightTask(insightId) {
  if (currentJob) { toast('有任务在跑，稍等', 'bad'); return; }
  const task = insTasks[insightId];
  if (!task) return;
  switchView('agent');
  const id = await startJob({ task });
  if (!id) return;
  currentJob = id;
  $('job-area').innerHTML = '<div class="empty">启动中…</div>';
  pollJob(id);
}

async function toggleSim() {
  const { ok, data } = await api('/admin/sim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ on: !simOn }) });
  if (ok) {
    simOn = data.on;
    updateSimBtn();
    toast(simOn ? '营业模拟已恢复：新订单会持续进来' : '营业模拟已暂停：数据冻结（评测模式）', 'ok');
    refresh(true);
  } else toast('切换失败', 'bad');
}

function updateSimBtn() {
  const b = $('btn-sim');
  b.style.display = medusaMode ? 'none' : '';
  b.textContent = simOn ? '⏸ 暂停营业模拟' : '▶ 恢复营业模拟';
  b.classList.toggle('sim-on', simOn);
}

let medusaMode = false;
async function loadSimState() {
  const { ok, data } = await api('/admin/insights');
  if (ok) {
    medusaMode = data.backend === 'medusa';
    const line = $('backend-line');
    if (line) line.textContent = medusaMode ? '数据源 · 真店 Medusa' : '数据源 · 本地仿真';
  }
  const r = await api('/admin/sim');
  if (r.ok) { simOn = !!r.data.on; updateSimBtn(); }
}

// ---------- 竞品价格 ----------
let market = null, mktSel = null;
const ACTION_ZH = { decrease: ['降价', 'var(--green)'], increase: ['提价', 'var(--amber)'], hold: ['观察', 'var(--muted)'] };
const COMP_COLORS = ['#22d3ee', '#c084fc', '#fbbf24'];

function renderMarket() {
  if (!market) return;
  const s = market.summary;
  $('mkt-summary').innerHTML = `
    <div class="mkt-card hot"><div class="n">${s.above}</div><div class="t">高于市场 &gt;15%</div></div>
    <div class="mkt-card cheap"><div class="n">${s.below}</div><div class="t">低于市场 &gt;15%</div></div>
    <div class="mkt-card fair"><div class="n">${s.fair}</div><div class="t">合理区间</div></div>
    <div class="mkt-card sug"><div class="n">${s.suggestion_count}</div><div class="t">改价建议</div></div>`;

  $('mkt-suggest').innerHTML = market.suggestions.length ? market.suggestions.map((sg, i) => {
    const [zh] = ACTION_ZH[sg.action] || ['—'];
    const e = sg.expected;
    const revCls = e.monthly_revenue_delta > 0 ? 'impact-pos' : e.monthly_revenue_delta < 0 ? 'impact-neg' : 'impact-zero';
    return `<div class="suggest-card ${sg.action}" style="animation-delay:${Math.min(i*50,250)}ms">
      <div class="sg-head"><span class="sg-title">${zh}建议 · ${esc(sg.title)}</span>
      <span class="sg-arrow">¥${sg.current} → ¥${sg.suggested}</span></div>
      <div class="sg-reason">${esc(sg.reason)}</div>
      <div class="sg-impact">
        <span>价格变化 <b>${e.price_change_pct > 0 ? '+' : ''}${e.price_change_pct}%</b></span>
        <span>预期销量 <b class="${e.units_change_pct < 0 ? 'impact-neg' : e.units_change_pct > 0 ? 'impact-pos' : 'impact-zero'}">${e.units_change_pct > 0 ? '+' : ''}${e.units_change_pct}%</b></span>
        <span>预期月营收 <b class="${revCls}">${e.monthly_revenue_delta > 0 ? '+' : ''}${fmtY(e.monthly_revenue_delta)}</b></span>
      </div>
      ${sg.action !== 'hold' ? `<button class="btn-mini primary" onclick="applySuggestion('${esc(sg.sku)}', ${sg.suggested}, '${esc(sg.title)}', this)">📋 按建议生成提案（走审批门）</button>` : ''}
    </div>`;
  }).join('') : '<div class="empty">当前没有需要调整的价格 —— 全店定价位于建议区间</div>';

  $('mkt-body').innerHTML = market.rows.map(r => {
    const cls = r.position > 1.15 ? 'over' : r.position < 0.85 ? 'under' : 'fair';
    const lo = r.market_min, hi = r.market_max;
    const span = hi - lo || 1;
    const leftPct = Math.max(0, Math.min(100, (Math.min(r.our_price, hi) - lo) / span * 100));
    const trendIcon = r.trend === 'up' ? '↑' : r.trend === 'down' ? '↓' : '→';
    return `<tr class="${mktSel === r.title ? 'sel' : ''}" onclick="selectProduct('${esc(r.title).replace(/'/g, "\\'")}')">
      <td><b>${esc(r.title)}</b><div style="color:var(--text-3);font-size:11px">${esc(r.sku)}</div></td>
      <td><span class="range ${cls}"><span class="marker" style="left:${leftPct}%"></span></span><br>
        <span style="font-weight:600">¥${r.our_price}</span> <span style="color:var(--text-3);font-size:11px">市场 ¥${r.market_min}~${r.market_max}</span></td>
      <td><span class="pos-chip ${cls}">${r.position_pct > 0 ? '+' : ''}${r.position_pct}%</span></td>
      <td>${r.units_30d} 件 <span class="trend-${r.trend}">${trendIcon}</span></td>
    </tr>`;
  }).join('');
}

function selectProduct(title) {
  mktSel = title;
  renderMarket();
  const row = market.rows.find(r => r.title === title);
  const hist = row && row.history;
  const box = $('mkt-detail');
  if (!hist) { box.innerHTML = '<div class="empty">暂无该商品的历史观测</div>'; return; }
  const seriesList = Object.entries(hist).filter(([k]) => k !== '_meta');
  const meta = hist._meta || {};
  const days = (seriesList[0] && seriesList[0][1] || []).length;
  box.innerHTML = `
    <h2>💹 ${esc(title)} · 近 ${days} 天价格走势</h2>
    <canvas id="mkt-canvas"></canvas>
    <div class="legend">
      <span><i style="background:var(--amber)"></i>本店 ¥${meta.our_price || '-'}</span>
      ${seriesList.map(([comp], i) => `<span><i style="background:${COMP_COLORS[i % COMP_COLORS.length]}"></i>${esc(comp)}</span>`).join('')}
      <span style="margin-left:auto">市场锚点 ≈ ¥${meta.anchor || '-'}</span>
    </div>
    <div class="assumption">📈 建议引擎假设：价格弹性 1.5（销量变化% ≈ -1.5 × 价格变化%）。竞品价格来自内置监测器（仿真），真实数据源可通过 <code>recordObservation</code> 接入。</div>`;
  drawMarketChart(title, seriesList);
}

function drawMarketChart(title, seriesList) {
  const cv = $('mkt-canvas');
  if (!cv) return;
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth, H = 235;
  cv.width = W * dpr; cv.height = H * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const pad = { l: 46, r: 10, t: 12, b: 22 };
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;

  const n = Math.max(...seriesList.map(([, s]) => s.length), 2);
  const all = seriesList.flatMap(([, s]) => s.map(o => o.price));
  const max = Math.max(...all) * 1.08, min = Math.min(...all) * 0.92;
  const x = i => pad.l + iw * (i / (n - 1 || 1));
  const y = v => pad.t + ih * (1 - (v - min) / (max - min || 1));

  ctx.font = '10.5px "Segoe UI"'; ctx.fillStyle = '#646d84'; ctx.strokeStyle = 'rgba(255,255,255,.055)';
  for (let g = 0; g <= 4; g++) {
    const gy = pad.t + ih * g / 4;
    ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(W - pad.r, gy); ctx.stroke();
    ctx.fillText(Math.round(max - (max - min) * g / 4), 6, gy + 3.5);
  }

  seriesList.forEach(([comp, series], si) => {
    ctx.beginPath();
    series.forEach((o, i) => i ? ctx.lineTo(x(i), y(o.price)) : ctx.moveTo(x(i), y(o.price)));
    ctx.strokeStyle = COMP_COLORS[si % COMP_COLORS.length]; ctx.lineWidth = 1.6; ctx.stroke();
  });
  const meta = market.rows.find(r => r.title === title);
  if (meta) {
    const ourPrice = meta.our_price;
    ctx.beginPath(); ctx.setLineDash([5, 4]);
    ctx.moveTo(pad.l, y(ourPrice)); ctx.lineTo(W - pad.r, y(ourPrice));
    ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 1.8; ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = '#fbbf24';
    ctx.fillText('本店 ¥' + ourPrice, W - pad.r - 66, y(ourPrice) - 5);
  }
}

async function applySuggestion(sku, price, title, btn) {
  btn.disabled = true;
  const { ok, data } = await api('/admin/market/apply-suggestion', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ variant_id: sku, price, title, reason: `市场定价建议：${title} 调整至 ¥${price}（预期影响见竞品价格页）` }),
  });
  if (ok) { toast(`已生成暂存提案（${data.change ? data.change.id : ''}），去审批队列拍板`, 'ok'); switchView('queue'); }
  else { toast(data.error || '生成提案失败', 'bad'); btn.disabled = false; }
}

// ---------- 商品 ----------
function renderProducts() {
  const q = $('prod-search').value.trim().toLowerCase();
  const cat = $('prod-cat').value, st = $('prod-status').value;
  const list = state.products.filter(p =>
    (!q || p.title.toLowerCase().includes(q) || p.tags.some(t => t.toLowerCase().includes(q)) || p.variants.some(v => v.sku.toLowerCase().includes(q))) &&
    (!cat || p.category === cat) && (!st || p.status === st));
  $('prod-count').textContent = `${list.length} / ${state.products.length} 个商品`;
  $('prod-body').innerHTML = list.map(p => {
    const variants = p.variants.map(v => {
      const invCls = v.inventory < 5 ? 'bad' : v.inventory < 10 ? 'warn' : '';
      return `<span class="vchip ${v.price <= 0 ? 'danger' : ''}" title="${esc(v.title)} · 库存 ${v.inventory}">${esc(v.sku)} <b>¥${v.price}</b><span class="inv-bar ${invCls}"><i style="width:${Math.min(100, v.inventory / 2)}%"></i></span>${v.inventory < 10 ? '⚠' : ''}</span>`;
    }).join('');
    const badges = (!p.description ? '<span class="tag desc">缺描述</span>' : '') + (p.status === 'draft' ? '<span class="tag low">未上架</span>' : '');
    return `<tr>
      <td><b>${esc(p.title)}</b> ${badges}<div style="color:var(--text-3);font-size:11px;margin-top:2px">${p.id}</div></td>
      <td>${esc(p.category)}</td>
      <td>${variants}</td>
    </tr>`;
  }).join('');
}

// ---------- Copilot ----------
let llmOk = false, presets = [], currentJob = null, jobTimer = null;
const TYPE_META = { query: ['🔍', '查询'], analysis: ['📊', '分析'], write: ['✏️', '写提案'], long: ['🧭', '长程'] };

function renderPresets() {
  const groups = { query: [], analysis: [], write: [], long: [] };
  for (const p of presets) (groups[p.type] = groups[p.type] || []).push(p);
  $('presets').innerHTML = Object.entries(groups).filter(([, list]) => list.length).map(([type, list]) => `
    <div class="preset-group">
      <div class="g-title">${TYPE_META[type]?.[0] || ''} ${TYPE_META[type]?.[1] || type}（${list.length}）</div>
      <div class="presets">${list.map(p => `
        <button class="preset" data-id="${p.id}" title="${esc(p.instruction)}" onclick="runPreset('${p.id}', this)">
          <span class="t">${TYPE_META[type]?.[0] || ''}</span>${esc(p.name)}
        </button>`).join('')}</div>
    </div>`).join('');
}

function updateLlmState(s) {
  llmOk = s.llm_available;
  const pt = $('presets-title');
  if (pt) pt.textContent = s.backend === 'medusa' ? '🎯 预设任务（真店快照 · 无需 API key）' : '🎯 预设任务（仿真数据 · 无需 API key）';
  $('task-input').disabled = !llmOk;
  $('btn-run').disabled = !llmOk;
  $('llm-state').innerHTML = llmOk
    ? `<span class="tag desc">已接入 ${esc(s.model || 'LLM')}</span>`
    : '<span class="tag low">未配置 key</span>';
  $('llm-hint').innerHTML = llmOk
    ? `模型：<code>${esc(s.model)}</code> · 任务会产生真实提案，仍需你在审批队列拍板`
    : `以 <code>LLM_API_KEY=xxx LLM_MODEL=yyy node server/store-server.js</code> 启动后，这里可以用自然语言派活（左侧预设任务无需 key，永远可用）`;
}

async function startJob(body) {
  const { ok, data } = await api('/agent/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!ok) { toast(data.error || '启动失败', 'bad'); return null; }
  return data.id;
}

function renderJob(job) {
  const box = $('job-area');
  const running = job.status === 'running';
  const steps = job.steps.map((s) => `
    <div class="step ${s.ok === false ? 'err' : ''}">
      <span class="t-icon">${s.ok === false ? '❌' : s.tool.startsWith('propose_') ? '✏️' : s.tool.includes('analytics') ? '📊' : s.tool.includes('orders') ? '🧾' : s.tool.includes('market') ? '💹' : '🔍'}</span>
      <span><code>${esc(s.tool)}(${esc(JSON.stringify(s.args)).slice(0, 110)})</code>${s.error ? ' → ' + esc(s.error).slice(0, 80) : ''}</span>
    </div>`).join('');
  box.innerHTML = `
    <div style="font-size:13px;margin-bottom:9px;line-height:1.6">🎯 ${esc(job.task_text)}<br>
      <span style="color:var(--text-3);font-size:11.5px">${job.id} · ${job.mode === 'llm' ? 'LLM ' + esc(job.model || '') : '脚本执行'} ${running ? '· <span style="color:var(--amber)">运行中…</span>' : ''}</span>
    </div>
    <div class="trace">${steps || '<div class="empty" style="padding:12px">思考中…</div>'}</div>
    ${job.answer != null ? `<div class="answer"><span class="who">🤖 Copilot${job.proposals ? ` · 产生 ${job.proposals} 条待审批提案<span class="goto-queue" onclick="switchView('queue')">去审批 →</span>` : ''}</span>${esc(job.answer)}</div>` : ''}
    ${job.status === 'error' ? `<div class="answer" style="border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.06)"><span class="who" style="color:var(--red)">⚠️ 失败</span>${esc(job.error || '')}</div>` : ''}
    ${job.usage ? `<div class="job-meta">${job.steps.length} 次工具调用 · ${job.usage.prompt_tokens + job.usage.completion_tokens} tokens</div>` : ''}`;
}

async function pollJob(id) {
  const { ok, data } = await api('/agent/run/' + id);
  if (!ok) return;
  renderJob(data);
  if (data.status === 'running') { jobTimer = setTimeout(() => pollJob(id), 1200); }
  else {
    currentJob = null;
    toast(data.status === 'done' ? `任务完成：${id}` : `任务失败：${data.error?.slice(0, 60)}`, data.status === 'done' ? 'ok' : 'bad');
    refresh(true);
  }
}

async function runPreset(taskId, btn) {
  if (currentJob) { toast('有任务在跑，稍等', 'bad'); return; }
  if (btn) btn.disabled = true;
  switchView('agent');
  const id = await startJob({ task_id: taskId });
  if (btn) setTimeout(() => btn.disabled = false, 1500);
  if (!id) return;
  currentJob = id;
  $('job-area').innerHTML = '<div class="empty">启动中…</div>';
  pollJob(id);
}

async function runFreeTask() {
  if (currentJob) { toast('有任务在跑，稍等', 'bad'); return; }
  const task = $('task-input').value.trim();
  if (!task) return;
  const id = await startJob({ task });
  if (!id) return;
  currentJob = id;
  $('task-input').value = '';
  $('job-area').innerHTML = '<div class="empty">启动中…</div>';
  pollJob(id);
}
$('task-input').addEventListener('keydown', e => { if (e.key === 'Enter') runFreeTask(); });

// ---------- 审计 ----------
function renderAudit(list) {
  $('audit').innerHTML = list.map(x => `
    <div>${x.ts.slice(5, 19)} [<span class="who">${esc(x.actor)}</span>] <span class="ev">${esc(x.event)}</span> ${esc(x.detail.change_id || x.detail.path || x.detail.note || JSON.stringify(x.detail).slice(0, 70))}</div>`).join('');
}

document.querySelectorAll('#queue-filters .chip').forEach(c => c.addEventListener('click', () => {
  document.querySelectorAll('#queue-filters .chip').forEach(x => x.classList.remove('on'));
  c.classList.add('on');
  state.queueFilter = c.dataset.f;
  renderQueue();
}));
['prod-search', 'prod-cat', 'prod-status'].forEach(id => {
  $(id).addEventListener('input', renderProducts);
  $(id).addEventListener('change', renderProducts);
});

// ---------- 重置 ----------
async function resetAll() {
  if (!confirm('重置会清空所有审批记录并恢复初始演示数据，确定？')) return;
  const { ok, data } = await api('/admin/reset', { method: 'POST' });
  toast(ok ? `已重置：${data.products} 商品 / ${data.orders} 订单` : '重置失败', ok ? 'ok' : 'bad');
  refresh(true);
}

// ---------- 轮询 ----------
let refreshing = false;
async function refresh(force) {
  if (refreshing) return;
  refreshing = true;
  try {
    const tasks = [api('/admin/analytics/summary?days=30'), api('/admin/revenue-trend?days=30'), api('/admin/staged-changes'), api('/admin/products'), api('/admin/insights'), api('/admin/market/report')];
    if ($('view-audit').classList.contains('on')) tasks.push(api('/admin/audit'));
    const [ana, tr, st, pr, ins, mkt, au] = await Promise.all(tasks);
    if (!ana.ok) throw new Error('server 不可达');
    $('foot').classList.remove('down'); $('live-text').textContent = sseOk ? '实时推送' : '已连接';

    const newTrend = tr.data.trend || [];
    const changed = !trend.length || JSON.stringify(newTrend) !== JSON.stringify(trend);
    trend = newTrend;
    state.analytics = ana.data;
    const stagedChanged = JSON.stringify(st.data.staged_changes) !== JSON.stringify(state.staged);
    state.staged = st.data.staged_changes;
    const prodChanged = JSON.stringify(pr.data.products) !== JSON.stringify(state.products);
    state.products = pr.data.products;

    renderKpis(ana.data);
    if (changed || force) drawChart(stagedChanged || force);
    renderQuality(ana.data.data_quality);
    if (stagedChanged || force) renderQueue();
    if (prodChanged || force) { fillCatFilter(); renderProducts(); }
    if (ins.ok) {
      if (ins.data.sim_on !== simOn) { simOn = ins.data.sim_on; updateSimBtn(); }
      const nowMedusa = ins.data.backend === 'medusa';
      if (nowMedusa !== medusaMode) { medusaMode = nowMedusa; updateSimBtn(); const line = $('backend-line'); if (line) line.textContent = medusaMode ? '数据源 · 真店 Medusa' : '数据源 · 本地仿真'; }
      const newList = ins.data.insights || [];
      const insChanged = JSON.stringify(newList) !== JSON.stringify(insights);
      if (insChanged || force) {
        insights = newList;
        for (const c of insights) insTasks[c.id] = c.task;
        renderInsights();
      }
    }
    if (mkt.ok) {
      const mktChanged = JSON.stringify(mkt.data) !== JSON.stringify(market);
      if (mktChanged || force) {
        market = mkt.data;
        if ($('view-market').classList.contains('on')) { renderMarket(); if (mktSel) selectProduct(mktSel); }
      }
    }
    if (au && au.ok) renderAudit(au.data.audit);
  } catch (e) {
    $('foot').classList.add('down'); $('live-text').textContent = '连接断开，重试中…';
  }
  refreshing = false;
}

function fillCatFilter() {
  const sel = $('prod-cat');
  const cats = [...new Set(state.products.map(p => p.category))];
  const cur = sel.value;
  if (sel.options.length === cats.length + 1 && [...sel.options].every((o, i) => i === 0 || o.value === cats[i - 1])) return;
  sel.innerHTML = '<option value="">全部类目</option>' + cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
  sel.value = cur;
}

let visible = true;
document.addEventListener('visibilitychange', () => {
  visible = !document.hidden;
  if (visible) refresh(true);
});

// SSE 实时推送：服务端状态变化立刻通知，轮询只做降级兜底
let sseOk = false;
function connectSSE() {
  try {
    const es = new EventSource('/events');
    es.addEventListener('refresh', () => { if (visible) refresh(false); });
    es.onopen = () => { if (!sseOk) { sseOk = true; $('live-text').textContent = '实时推送'; } };
    es.onerror = () => { sseOk = false; $('live-text').textContent = '已连接（轮询）'; };
  } catch { sseOk = false; }
}
connectSSE();

// 键盘快捷键：1-6 切换视图（Linear 风格）
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.metaKey || e.ctrlKey) return;
  const map = { '1': 'overview', '2': 'queue', '3': 'products', '4': 'market', '5': 'agent', '6': 'audit' };
  if (map[e.key]) switchView(map[e.key]);
});

(async function init() {
  await loadSimState();
  await refresh(true);
  const sp = document.getElementById('splash');
  if (sp) setTimeout(() => sp.classList.add('hide'), 250);
  setInterval(() => { if (visible && !sseOk) refresh(false); }, 4000);
  const [st, ps] = await Promise.all([api('/agent/status'), api('/agent/presets')]);
  if (st.ok) updateLlmState(st.data);
  if (ps.ok) { presets = ps.data.presets; renderPresets(); }
  renderInsights();
  const hash = location.hash.slice(1);
  if (hash && VIEW_META[hash]) switchView(hash);
})();
