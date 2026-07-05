import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import path from 'node:path';
import { loadConfig } from './config';
import { openDb } from './db';
import { scanAll, watchTrajectories } from './scanner/trajectory-scanner';

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dataDir);
  const app = Fastify({ logger: false });

  // Kick off an initial scan; log summary.
  console.log(`[scan] initial scan starting from ${cfg.openclawRoot}...`);
  const initial = await scanAll(db, cfg.openclawRoot);
  console.log(`[scan] initial: ${initial.filesScanned} files, ${initial.callsInserted} new calls, ${initial.errors} errors, ${initial.durationMs}ms`);

  // Interval + watcher based rescans.
  let lastScanSummary = initial;
  setInterval(async () => {
    try {
      lastScanSummary = await scanAll(db, cfg.openclawRoot);
      if (lastScanSummary.callsInserted > 0) {
        console.log(`[scan] +${lastScanSummary.callsInserted} calls (${lastScanSummary.durationMs}ms)`);
      }
    } catch (e) { /* swallow */ }
  }, cfg.scanIntervalMs);
  watchTrajectories(db, cfg.openclawRoot, (r) => { lastScanSummary = r; });

  // ==============================================================
  // API
  // ==============================================================

  app.get('/api/health', async () => ({
    ok: true,
    port: cfg.port,
    openclawRoot: cfg.openclawRoot,
    lastScan: lastScanSummary,
    now: new Date().toISOString(),
  }));

  /** Aggregate spend for a time window, grouped by whatever dimension you ask. */
  app.get('/api/spend', async (req) => {
    const q = req.query as { window?: string; groupBy?: string };
    const windowMs = parseWindow(q.window ?? '30d');
    const sinceMs = Date.now() - windowMs;
    const groupBy = (q.groupBy ?? 'model') as string;
    const groupCol = ({
      agent: 'agent',
      provider: 'provider',
      model: 'model',
      channel: `COALESCE(channel, chat_id, '(direct)')`,
      chat: `COALESCE(channel, chat_id, '(direct)')`,
      day: `date(ts_ms / 1000, 'unixepoch', 'localtime')`,
      hour: `strftime('%Y-%m-%d %H:00', ts_ms / 1000, 'unixepoch', 'localtime')`,
    } as Record<string, string>)[groupBy] ?? 'model';

    const rows = db.prepare(`
      SELECT
        ${groupCol} AS key,
        COUNT(*) AS calls,
        SUM(input_tokens)  AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read)    AS cache_read,
        SUM(cache_write)   AS cache_write,
        SUM(cost_total_usd) AS cost_usd
      FROM model_calls
      WHERE ts_ms >= ?
      GROUP BY key
      ORDER BY cost_usd DESC, calls DESC
    `).all(sinceMs) as any[];

    return {
      window: q.window ?? '30d',
      sinceMs,
      groupBy,
      rows,
      totalCostUsd: rows.reduce((s, r) => s + (r.cost_usd || 0), 0),
      totalCalls:   rows.reduce((s, r) => s + (r.calls   || 0), 0),
    };
  });

  /** Time-series of spend, bucketed by hour, optionally filtered. */
  app.get('/api/series', async (req) => {
    const q = req.query as { window?: string; bucket?: string; agent?: string; model?: string; provider?: string; groupBy?: string };
    const windowMs = parseWindow(q.window ?? '7d');
    const sinceMs = Date.now() - windowMs;
    const bucketExpr = q.bucket === 'day'
      ? `strftime('%Y-%m-%d 00:00', ts_ms / 1000, 'unixepoch', 'localtime')`
      : `strftime('%Y-%m-%d %H:00', ts_ms / 1000, 'unixepoch', 'localtime')`;

    const filters: string[] = ['ts_ms >= ?'];
    const params: any[] = [sinceMs];
    if (q.agent)    { filters.push('agent = ?'); params.push(q.agent); }
    if (q.provider) { filters.push('provider = ?'); params.push(q.provider); }
    if (q.model)    { filters.push('model = ?'); params.push(q.model); }

    // Group by bucket and optionally an additional dimension for stacked series.
    const groupBy = q.groupBy;
    let seriesCol = "'total'";
    if (groupBy === 'provider') seriesCol = 'provider';
    else if (groupBy === 'model') seriesCol = 'model';
    else if (groupBy === 'agent') seriesCol = 'agent';

    const rows = db.prepare(`
      SELECT
        ${bucketExpr} AS bucket,
        ${seriesCol} AS series,
        SUM(cost_total_usd) AS cost_usd,
        SUM(input_tokens + output_tokens) AS tokens,
        COUNT(*) AS calls
      FROM model_calls
      WHERE ${filters.join(' AND ')}
      GROUP BY bucket, series
      ORDER BY bucket ASC
    `).all(...params) as any[];

    return { window: q.window ?? '7d', bucket: q.bucket ?? 'hour', groupBy: groupBy ?? null, points: rows };
  });

  /** Live tail — most recent model calls. */
  app.get('/api/recent', async (req) => {
    const q = req.query as { limit?: string; agent?: string };
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '30', 10)));
    const filters: string[] = [];
    const params: any[] = [];
    if (q.agent) { filters.push('agent = ?'); params.push(q.agent); }
    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT id, agent, provider, model, chat_id, channel, ts_ms,
             input_tokens, output_tokens, cache_read, cache_write,
             cost_total_usd, cost_source, stop_reason, session_id
      FROM model_calls
      ${where}
      ORDER BY ts_ms DESC
      LIMIT ?
    `).all(...params, limit) as any[];
    return { rows };
  });

  /** Overview: KPIs for a window. */
  app.get('/api/overview', async (req) => {
    const q = req.query as { window?: string };
    const windowMs = parseWindow(q.window ?? '30d');
    const sinceMs = Date.now() - windowMs;

    const totals = db.prepare(`
      SELECT
        COUNT(*) AS calls,
        SUM(input_tokens + output_tokens) AS tokens,
        SUM(input_tokens) AS input_tokens,
        SUM(output_tokens) AS output_tokens,
        SUM(cache_read) AS cache_read,
        SUM(cache_write) AS cache_write,
        SUM(cost_total_usd) AS cost_usd,
        MAX(ts_ms) AS last_call_ts
      FROM model_calls
      WHERE ts_ms >= ?
    `).get(sinceMs) as any;

    const today0 = new Date(); today0.setHours(0, 0, 0, 0);
    const today = db.prepare(`SELECT SUM(cost_total_usd) AS cost_usd, COUNT(*) AS calls FROM model_calls WHERE ts_ms >= ?`).get(today0.getTime()) as any;
    const week0 = new Date(); week0.setDate(week0.getDate() - 7);
    const week = db.prepare(`SELECT SUM(cost_total_usd) AS cost_usd, COUNT(*) AS calls FROM model_calls WHERE ts_ms >= ?`).get(week0.getTime()) as any;
    const month0 = new Date(); month0.setDate(1); month0.setHours(0, 0, 0, 0);
    const month = db.prepare(`SELECT SUM(cost_total_usd) AS cost_usd, COUNT(*) AS calls FROM model_calls WHERE ts_ms >= ?`).get(month0.getTime()) as any;
    const alltime = db.prepare(`SELECT SUM(cost_total_usd) AS cost_usd, COUNT(*) AS calls, MIN(ts_ms) AS first_ts FROM model_calls`).get() as any;

    return { window: q.window ?? '30d', sinceMs, totals, today, week, month, alltime };
  });

  /** List of known dimensions for UI filters. */
  app.get('/api/dimensions', async () => {
    const agents    = db.prepare(`SELECT DISTINCT agent    FROM model_calls ORDER BY agent`).all() as any[];
    const providers = db.prepare(`SELECT DISTINCT provider FROM model_calls ORDER BY provider`).all() as any[];
    const models    = db.prepare(`SELECT DISTINCT model    FROM model_calls ORDER BY model`).all() as any[];
    const channels  = db.prepare(`SELECT DISTINCT COALESCE(channel, chat_id) AS channel FROM model_calls WHERE COALESCE(channel, chat_id) IS NOT NULL ORDER BY channel`).all() as any[];
    return {
      agents:    agents.map((r: any) => r.agent),
      providers: providers.map((r: any) => r.provider),
      models:    models.map((r: any) => r.model),
      channels:  channels.map((r: any) => r.channel),
    };
  });

  /** Force a rescan on demand. */
  app.post('/api/rescan', async () => {
    const r = await scanAll(db, cfg.openclawRoot);
    lastScanSummary = r;
    return r;
  });

  // ==============================================================
  // Static frontend
  // ==============================================================
  const publicDir = path.join(__dirname, '..', 'public');
  await app.register(fastifyStatic, { root: publicDir, prefix: '/' });

  await app.listen({ port: cfg.port, host: '0.0.0.0' });
  console.log(`[server] http://localhost:${cfg.port} — dashboard ready`);
}

function parseWindow(s: string): number {
  const m = /^(\d+)([hdwm])$/.exec(s);
  if (!m) return 30 * 24 * 60 * 60 * 1000;
  const n = parseInt(m[1], 10);
  switch (m[2]) {
    case 'h': return n * 60 * 60 * 1000;
    case 'd': return n * 24 * 60 * 60 * 1000;
    case 'w': return n * 7 * 24 * 60 * 60 * 1000;
    case 'm': return n * 30 * 24 * 60 * 60 * 1000;
    default: return 30 * 24 * 60 * 60 * 1000;
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
