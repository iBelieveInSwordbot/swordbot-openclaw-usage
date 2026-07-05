/* ================================================================
 * OpenClaw Usage — frontend
 * MD3 dashboard reading /api/* from Fastify. Bespoke canvas charts.
 * ================================================================ */

// -------------------------------- formatting helpers
const fmtUsd = (n) => n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtUsdMicro = (n) => n == null ? '—' : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 })}`;
const fmtNum = (n) => n == null ? '—' : Number(n).toLocaleString();
const fmtNumShort = (n) => {
  if (n == null) return '—';
  const v = Number(n);
  if (v >= 1_000_000_000) return `${(v / 1_000_000_000).toFixed(1)}B`;
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
};
const fmtTimeShort = (ms) => {
  if (!ms) return '—';
  const d = new Date(ms);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const fmtRelTime = (ms) => {
  const dt = Date.now() - ms;
  if (dt < 0) return 'just now';
  if (dt < 60_000) return `${Math.floor(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.floor(dt / 60_000)}m ago`;
  if (dt < 86_400_000) return `${Math.floor(dt / 3_600_000)}h ago`;
  return `${Math.floor(dt / 86_400_000)}d ago`;
};

// -------------------------------- color palette
const PROVIDER_COLORS = {
  anthropic: '#D97757',
  openai:    '#10A37F',
  google:    '#4285F4',
  ollama:    '#8B5CF6',
  openclaw:  '#EAB308',
  unknown:   '#6B7280',
};
const AGENT_COLORS = ['#D97757', '#10A37F', '#4285F4', '#8B5CF6', '#EAB308', '#EC4899', '#22D3EE', '#F97316'];

function providerColor(p) { return PROVIDER_COLORS[p] || PROVIDER_COLORS.unknown; }

// -------------------------------- state
const state = {
  window: '7d',
  // When customFrom/customTo are set, they override window in the API call.
  // Values are YYYY-MM-DD strings (local dates from <input type="date">).
  customFrom: null,
  customTo: null,
  // OpenClaw install date, filled in from /api/health on load. Used for
  // the 'All' range so we anchor at true install date rather than a
  // rolling window.
  installDateIso: null,
  overview: null,
  spend: null,     // by-provider spend for window
  series: null,    // hourly stacked-by-provider series
  agentSeries: null,
  models: [],
  agents: [],
  channels: [],
};

/**
 * Format a range label for the hero KPI. Reads from server response
 * (sinceMs / endMs) so it's always accurate, including custom ranges.
 */
function describeCurrentRange(ov) {
  if (!ov || !ov.sinceMs) return '—';
  const since = new Date(ov.sinceMs);
  const end = new Date(ov.endMs || Date.now());
  const fmt = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: (d.getFullYear() !== new Date().getFullYear()) ? 'numeric' : undefined });
  const label = state.customFrom || state.customTo
    ? 'Custom'
    : (state.window || '');
  return `${label} · ${fmt(since)} → ${fmt(end)}`;
}

/** Build the querystring for time-range parameters based on current state. */
function rangeQuery() {
  if (state.customFrom || state.customTo) {
    const parts = [];
    if (state.customFrom) parts.push(`from=${encodeURIComponent(state.customFrom)}`);
    if (state.customTo)   parts.push(`to=${encodeURIComponent(state.customTo)}`);
    return parts.join('&');
  }
  // 'All' means everything since OpenClaw was installed — anchor at
  // that absolute date rather than a rolling window.
  if (state.window === 'all') {
    if (state.installDateIso) {
      // Slice YYYY-MM-DD out of the ISO datetime.
      const day = state.installDateIso.slice(0, 10);
      return `from=${encodeURIComponent(day)}`;
    }
    // Fallback until /api/health returns.
    return 'window=365d';
  }
  return `window=${encodeURIComponent(state.window)}`;
}

// -------------------------------- data fetchers
async function j(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} → ${r.status}`);
  return r.json();
}

async function refreshAll() {
  const r = rangeQuery();
  const [overview, byProvider, series, byModel, byAgent, byChannel, agentSeries] = await Promise.all([
    j(`/api/overview?${r}`),
    j(`/api/spend?${r}&groupBy=provider`),
    j(`/api/series?${r}&bucket=hour&groupBy=provider`),
    j(`/api/spend?${r}&groupBy=model`),
    j(`/api/spend?${r}&groupBy=agent`),
    j(`/api/spend?${r}&groupBy=channel`),
    j(`/api/series?${r}&bucket=hour&groupBy=agent`),
  ]);
  state.overview = overview;
  state.spend = byProvider;
  state.series = series;
  state.models = byModel.rows;
  state.agents = byAgent.rows;
  state.channels = byChannel.rows;
  state.agentSeries = agentSeries;

  renderOverview();
  renderModels();
  renderAgents();
  renderChannels();
  renderAgentTimeline();
  refreshLive();

  document.getElementById('last-updated').textContent = `Updated ${fmtRelTime(Date.now())}`;
}

async function refreshLive() {
  try {
    const r = await j('/api/recent?limit=40');
    renderLive(r.rows);
  } catch {}
}

// ==================================================================
// OVERVIEW
// ==================================================================
function renderOverview() {
  const ov = state.overview;
  const windowTotals = ov?.totals || {};
  document.getElementById('kpi-window-spend').textContent = fmtUsd(windowTotals.cost_usd || 0);
  document.getElementById('kpi-window-meta').textContent =
    `${fmtNum(windowTotals.calls || 0)} calls · ${fmtNumShort(windowTotals.tokens || 0)} tokens`;
  document.getElementById('kpi-window-range').textContent = describeCurrentRange(ov);
  document.getElementById('kpi-today').textContent   = fmtUsd(ov?.today?.cost_usd   || 0);
  document.getElementById('kpi-today-calls').textContent   = `${fmtNum(ov?.today?.calls || 0)} calls`;
  document.getElementById('kpi-week').textContent    = fmtUsd(ov?.week?.cost_usd    || 0);
  document.getElementById('kpi-week-calls').textContent    = `${fmtNum(ov?.week?.calls || 0)} calls`;
  document.getElementById('kpi-month').textContent   = fmtUsd(ov?.month?.cost_usd   || 0);
  document.getElementById('kpi-month-calls').textContent   = `${fmtNum(ov?.month?.calls || 0)} calls`;
  document.getElementById('kpi-alltime').textContent = fmtUsd(ov?.alltime?.cost_usd || 0);
  document.getElementById('kpi-alltime-calls').textContent = `${fmtNum(ov?.alltime?.calls || 0)} calls`;

  drawSpendTimeline();
  drawProviderDonut();
  renderRanking('top-models',   state.models.slice(0, 8),   'model');
  renderRanking('top-channels', state.channels.slice(0, 8), 'channel');
}

function renderRanking(elId, rows, keyLabel) {
  const el = document.getElementById(elId);
  if (!rows.length) {
    el.innerHTML = `<div class="empty">No data in this window.</div>`;
    return;
  }
  const max = Math.max(...rows.map((r) => Number(r.cost_usd) || 0), 0.0001);
  el.innerHTML = rows.map((r) => {
    const pct = ((Number(r.cost_usd) || 0) / max) * 100;
    return `
      <div class="rank-row">
        <div class="rank-head">
          <div class="rank-key" title="${r.key}">${escapeHtml(r.key || '—')}</div>
          <div class="rank-cost">${fmtUsd(r.cost_usd || 0)}</div>
        </div>
        <div class="rank-bar"><div class="rank-fill" style="width:${pct.toFixed(1)}%"></div></div>
        <div class="rank-meta">${fmtNum(r.calls || 0)} calls · ${fmtNumShort(r.input_tokens + r.output_tokens)} tokens</div>
      </div>
    `;
  }).join('');
}

// ==================================================================
// MODELS / AGENTS / CHANNELS tables
// ==================================================================
function renderTable(elId, rows, keyHeader) {
  const el = document.getElementById(elId);
  if (!rows.length) { el.innerHTML = `<div class="empty">No data.</div>`; return; }
  el.innerHTML = `
    <div class="tbl">
      <div class="tbl-row tbl-head">
        <div>${keyHeader}</div>
        <div class="num">Cost</div>
        <div class="num">Calls</div>
        <div class="num">Input</div>
        <div class="num">Output</div>
      </div>
      ${rows.map((r) => `
        <div class="tbl-row">
          <div class="ellip" title="${escapeHtml(String(r.key || ''))}">${escapeHtml(String(r.key || '—'))}</div>
          <div class="num">${fmtUsd(r.cost_usd || 0)}</div>
          <div class="num">${fmtNum(r.calls || 0)}</div>
          <div class="num">${fmtNumShort(r.input_tokens || 0)}</div>
          <div class="num">${fmtNumShort(r.output_tokens || 0)}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderModels() { renderTable('models-table', state.models, 'Model'); }
function renderAgents() { renderTable('agents-table', state.agents, 'Agent'); }
function renderChannels() { renderTable('channels-table', state.channels, 'Channel'); }

// ==================================================================
// LIVE TAIL
// ==================================================================
function renderLive(rows) {
  const el = document.getElementById('live-tail');
  if (!rows.length) { el.innerHTML = `<div class="empty">No calls logged yet.</div>`; return; }
  el.innerHTML = rows.map((r) => `
    <div class="live-row">
      <div class="live-time">${fmtTimeShort(r.ts_ms)} <span class="dim">· ${fmtRelTime(r.ts_ms)}</span></div>
      <div class="live-provider" style="background:${providerColor(r.provider)}22;color:${providerColor(r.provider)}">${escapeHtml(r.provider)}</div>
      <div class="live-model">${escapeHtml(r.model)}</div>
      <div class="live-agent">${escapeHtml(r.agent)}</div>
      <div class="live-channel dim">${escapeHtml(r.channel || r.chat_id || '')}</div>
      <div class="live-tokens dim">${fmtNumShort(r.input_tokens)}→${fmtNumShort(r.output_tokens)}</div>
      <div class="live-cost">${r.cost_total_usd < 0.01 ? fmtUsdMicro(r.cost_total_usd) : fmtUsd(r.cost_total_usd)}</div>
    </div>
  `).join('');
}

// ==================================================================
// CHARTS (canvas, no libs)
// ==================================================================
function pixelRatio() { return window.devicePixelRatio || 1; }
function setupCanvas(c, w, h) {
  const dpr = pixelRatio();
  c.width = Math.floor(w * dpr);
  c.height = Math.floor(h * dpr);
  c.style.width = `${w}px`;
  c.style.height = `${h}px`;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/** Build a matrix of { bucket -> series -> cost } from /api/series points. */
function pivotSeries(points) {
  const buckets = [];
  const bucketMap = new Map();
  const seriesSet = new Set();
  for (const p of points) {
    if (!bucketMap.has(p.bucket)) {
      bucketMap.set(p.bucket, {});
      buckets.push(p.bucket);
    }
    bucketMap.get(p.bucket)[p.series] = Number(p.cost_usd) || 0;
    seriesSet.add(p.series);
  }
  buckets.sort();
  return { buckets, seriesList: [...seriesSet], data: bucketMap };
}

function drawSpendTimeline() {
  const canvas = document.getElementById('spend-timeline');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 640, h = 220;
  const ctx = setupCanvas(canvas, w, h);

  ctx.clearRect(0, 0, w, h);
  const pts = state.series?.points || [];
  if (!pts.length) { drawEmpty(ctx, w, h, 'No calls in this window'); return; }

  const pad = { l: 44, r: 12, t: 16, b: 26 };
  const { buckets, seriesList, data } = pivotSeries(pts);
  // Sort series by total cost so the biggest is at the bottom of the stack.
  const totals = new Map(seriesList.map((s) => [s, 0]));
  for (const b of buckets) for (const s of seriesList) totals.set(s, totals.get(s) + (data.get(b)?.[s] || 0));
  seriesList.sort((a, b) => totals.get(b) - totals.get(a));

  const perBucketTotal = buckets.map((b) => seriesList.reduce((s, sName) => s + (data.get(b)?.[sName] || 0), 0));
  const maxY = Math.max(...perBucketTotal, 0.0001);
  const stepX = (w - pad.l - pad.r) / Math.max(1, buckets.length - 1);
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / maxY);
  const x = (i) => pad.l + i * stepX;

  // Gridlines
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.font = '11px Roboto Mono, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i <= 4; i++) {
    const yv = maxY * (i / 4);
    const yy = y(yv);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillText(fmtUsd(yv), 4, yy + 4);
  }

  // Stacked areas
  const cumTop = new Array(buckets.length).fill(0);
  for (const s of seriesList) {
    const col = providerColor(s);
    const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, col + 'CC');
    grad.addColorStop(1, col + '22');
    ctx.beginPath();
    // Top of this layer
    for (let i = 0; i < buckets.length; i++) {
      const v = (data.get(buckets[i])?.[s] || 0) + cumTop[i];
      if (i === 0) ctx.moveTo(x(i), y(v));
      else ctx.lineTo(x(i), y(v));
    }
    // Back along the previous top (or baseline)
    for (let i = buckets.length - 1; i >= 0; i--) {
      ctx.lineTo(x(i), y(cumTop[i]));
    }
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    for (let i = 0; i < buckets.length; i++) {
      cumTop[i] += (data.get(buckets[i])?.[s] || 0);
    }
  }

  // X labels (sparse)
  const nLabels = Math.min(6, buckets.length);
  for (let i = 0; i < nLabels; i++) {
    const idx = Math.floor(i * (buckets.length - 1) / Math.max(1, nLabels - 1));
    const label = buckets[idx].slice(5, 13); // MM-DD HH:00 -> HH:00
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.fillText(label, x(idx) - 20, h - 6);
  }
}

function drawProviderDonut() {
  const canvas = document.getElementById('provider-donut');
  if (!canvas) return;
  const size = 200;
  const ctx = setupCanvas(canvas, size, size);
  ctx.clearRect(0, 0, size, size);
  const rows = state.spend?.rows || [];
  const total = rows.reduce((s, r) => s + Number(r.cost_usd || 0), 0);
  document.getElementById('donut-total').textContent = fmtUsd(total);
  if (total <= 0) { drawEmpty(ctx, size, size, 'No spend'); document.getElementById('provider-legend').innerHTML = ''; return; }
  const cx = size / 2, cy = size / 2, ro = size * 0.42, ri = size * 0.28;
  let a0 = -Math.PI / 2;
  for (const r of rows) {
    const frac = (Number(r.cost_usd) || 0) / total;
    if (frac <= 0) continue;
    const a1 = a0 + frac * 2 * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, ro, a0, a1);
    ctx.arc(cx, cy, ri, a1, a0, true);
    ctx.closePath();
    ctx.fillStyle = providerColor(r.key);
    ctx.fill();
    a0 = a1;
  }
  // Legend
  document.getElementById('provider-legend').innerHTML = rows
    .filter((r) => Number(r.cost_usd) > 0)
    .map((r) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${providerColor(r.key)}"></span>
        <span class="legend-key">${escapeHtml(r.key)}</span>
        <span class="legend-val">${fmtUsd(r.cost_usd || 0)}</span>
      </div>
    `).join('');
}

function renderAgentTimeline() {
  const canvas = document.getElementById('agent-timeline');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const w = rect.width || 640, h = 240;
  const ctx = setupCanvas(canvas, w, h);
  ctx.clearRect(0, 0, w, h);
  const pts = state.agentSeries?.points || [];
  if (!pts.length) { drawEmpty(ctx, w, h, 'No calls in this window'); return; }
  const pad = { l: 44, r: 12, t: 16, b: 26 };
  const { buckets, seriesList, data } = pivotSeries(pts);
  const totals = new Map(seriesList.map((s) => [s, 0]));
  for (const b of buckets) for (const s of seriesList) totals.set(s, totals.get(s) + (data.get(b)?.[s] || 0));
  seriesList.sort((a, b) => totals.get(b) - totals.get(a));
  const colorFor = (name) => AGENT_COLORS[Math.abs(hash(name)) % AGENT_COLORS.length];

  const perBucketTotal = buckets.map((b) => seriesList.reduce((s, sName) => s + (data.get(b)?.[sName] || 0), 0));
  const maxY = Math.max(...perBucketTotal, 0.0001);
  const stepX = (w - pad.l - pad.r) / Math.max(1, buckets.length - 1);
  const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / maxY);
  const x = (i) => pad.l + i * stepX;

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.font = '11px Roboto Mono, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  for (let i = 0; i <= 4; i++) {
    const yv = maxY * (i / 4);
    const yy = y(yv);
    ctx.beginPath(); ctx.moveTo(pad.l, yy); ctx.lineTo(w - pad.r, yy); ctx.stroke();
    ctx.fillText(fmtUsd(yv), 4, yy + 4);
  }
  const cumTop = new Array(buckets.length).fill(0);
  for (const s of seriesList) {
    const col = colorFor(s);
    const grad = ctx.createLinearGradient(0, pad.t, 0, h - pad.b);
    grad.addColorStop(0, col + 'CC');
    grad.addColorStop(1, col + '22');
    ctx.beginPath();
    for (let i = 0; i < buckets.length; i++) {
      const v = (data.get(buckets[i])?.[s] || 0) + cumTop[i];
      if (i === 0) ctx.moveTo(x(i), y(v));
      else ctx.lineTo(x(i), y(v));
    }
    for (let i = buckets.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(cumTop[i]));
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    for (let i = 0; i < buckets.length; i++) cumTop[i] += (data.get(buckets[i])?.[s] || 0);
  }
  // legend chip at top-right
  ctx.font = '12px Roboto, sans-serif';
  let lx = w - pad.r;
  seriesList.slice(0, 5).forEach((s) => {
    const lbl = `${s} ${fmtUsd(totals.get(s))}`;
    ctx.textAlign = 'right';
    const width = ctx.measureText(lbl).width + 18;
    lx -= width + 6;
    ctx.fillStyle = colorFor(s);
    ctx.fillRect(lx, pad.t - 2, 10, 10);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'left';
    ctx.fillText(lbl, lx + 14, pad.t + 8);
  });
}

function drawEmpty(ctx, w, h, msg) {
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.textAlign = 'center';
  ctx.font = '14px Roboto, sans-serif';
  ctx.fillText(msg, w / 2, h / 2);
  ctx.textAlign = 'left';
}

// -------------------------------- utils
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function hash(s) {
  let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return h;
}

// -------------------------------- routing
function activate(section) {
  document.querySelectorAll('.rail-item').forEach((b) => b.classList.toggle('active', b.dataset.section === section));
  document.querySelectorAll('.content').forEach((s) => s.classList.toggle('active', s.id === section));
  // Redraw canvases when a section becomes visible (canvases have zero
  // clientWidth while hidden with display:none).
  requestAnimationFrame(() => {
    if (section === 'overview') { drawSpendTimeline(); drawProviderDonut(); }
    if (section === 'agents')   { renderAgentTimeline(); }
  });
}

document.querySelectorAll('.rail-item[data-section]').forEach((b) => {
  b.addEventListener('click', () => activate(b.dataset.section));
});

document.getElementById('range-toggle').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-range]');
  if (!btn) return;
  const value = btn.dataset.range;

  // Custom button: open the date-range popover, don't refresh yet.
  if (value === 'custom') {
    const pop = document.getElementById('range-custom-popover');
    const fromInput = document.getElementById('range-from');
    const toInput = document.getElementById('range-to');
    // Seed with existing values or sensible defaults (last 30 days).
    if (!fromInput.value && !toInput.value) {
      const today = new Date();
      const start = new Date(today);
      start.setDate(today.getDate() - 30);
      fromInput.value = state.customFrom || toISODate(start);
      toInput.value   = state.customTo   || toISODate(today);
    }
    pop.hidden = !pop.hidden;
    return;
  }

  // Normal range button: clear any custom state, activate this button.
  state.customFrom = null;
  state.customTo = null;
  document.getElementById('range-custom-popover').hidden = true;
  document.querySelectorAll('#range-toggle button').forEach((b) => b.classList.toggle('active', b === btn));
  state.window = value;
  refreshAll();
});

// Custom range apply / cancel handlers.
function toISODate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
document.getElementById('range-custom-apply').addEventListener('click', () => {
  const from = document.getElementById('range-from').value || null;
  const to = document.getElementById('range-to').value || null;
  if (!from && !to) return;
  state.customFrom = from;
  state.customTo = to;
  document.getElementById('range-custom-popover').hidden = true;
  document.querySelectorAll('#range-toggle button').forEach((b) => b.classList.toggle('active', b.dataset.range === 'custom'));
  refreshAll();
});
document.getElementById('range-custom-cancel').addEventListener('click', () => {
  document.getElementById('range-custom-popover').hidden = true;
});
// Close popover on outside click.
document.addEventListener('click', (e) => {
  const pop = document.getElementById('range-custom-popover');
  if (pop.hidden) return;
  if (pop.contains(e.target)) return;
  if (e.target.closest('#range-custom-btn')) return;
  pop.hidden = true;
});

document.getElementById('rescan-btn').addEventListener('click', async () => {
  const btn = document.getElementById('rescan-btn');
  btn.disabled = true;
  try { await fetch('/api/rescan', { method: 'POST' }); await refreshAll(); }
  finally { btn.disabled = false; }
});

// Fetch install date once at startup so 'All' anchors correctly.
j('/api/health').then((h) => {
  state.installDateIso = h.installDateIso || null;
  // If the user landed on 'All' before health came back, re-fetch.
  if (state.window === 'all') refreshAll();
}).catch(() => { /* keep the 365d fallback */ });

document.getElementById('theme-toggle').addEventListener('click', () => {
  const light = document.body.classList.toggle('theme-light');
  document.body.classList.toggle('theme-dark', !light);
  document.getElementById('theme-icon').textContent = light ? 'dark_mode' : 'light_mode';
  localStorage.setItem('ocu-theme', light ? 'light' : 'dark');
});
if (localStorage.getItem('ocu-theme') === 'light') {
  document.body.classList.remove('theme-dark');
  document.body.classList.add('theme-light');
  document.getElementById('theme-icon').textContent = 'dark_mode';
}

window.addEventListener('resize', () => {
  drawSpendTimeline();
  drawProviderDonut();
  renderAgentTimeline();
});

refreshAll();
setInterval(refreshAll, 30_000); // full refresh every 30s
setInterval(refreshLive, 5_000); // live tail every 5s
