/**
 * Print a quick console summary of what's in the DB.
 */
import { loadConfig } from '../config';
import { openDb } from '../db';

function fmtUsd(n: number) { return `$${n.toFixed(2)}`; }
function fmtNum(n: number) { return n.toLocaleString(); }

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dataDir);

  const totals = db.prepare(`
    SELECT COUNT(*) AS calls, SUM(cost_total_usd) AS cost, MIN(ts_ms) AS first, MAX(ts_ms) AS last
    FROM model_calls
  `).get() as any;

  console.log('\n=== Overall ===');
  console.log(`calls: ${fmtNum(totals.calls)}    cost: ${fmtUsd(totals.cost || 0)}`);
  console.log(`first: ${totals.first ? new Date(totals.first).toISOString() : '—'}`);
  console.log(`last:  ${totals.last ? new Date(totals.last).toISOString() : '—'}`);

  const byModel = db.prepare(`
    SELECT model, COUNT(*) AS calls, SUM(cost_total_usd) AS cost,
           SUM(input_tokens) AS input_tok, SUM(output_tokens) AS output_tok,
           GROUP_CONCAT(DISTINCT cost_source) AS sources
    FROM model_calls
    GROUP BY model
    ORDER BY cost DESC, calls DESC
  `).all() as any[];

  console.log('\n=== By model ===');
  console.log('model'.padEnd(35), 'calls'.padStart(8), 'cost'.padStart(10), 'in-tok'.padStart(14), 'out-tok'.padStart(12), 'source');
  for (const r of byModel) {
    console.log(
      (r.model || '').padEnd(35),
      fmtNum(r.calls).padStart(8),
      fmtUsd(r.cost || 0).padStart(10),
      fmtNum(r.input_tok || 0).padStart(14),
      fmtNum(r.output_tok || 0).padStart(12),
      r.sources || '',
    );
  }

  const byAgent = db.prepare(`
    SELECT agent, COUNT(*) AS calls, SUM(cost_total_usd) AS cost
    FROM model_calls GROUP BY agent ORDER BY cost DESC, calls DESC
  `).all() as any[];
  console.log('\n=== By agent ===');
  for (const r of byAgent) {
    console.log((r.agent || '').padEnd(20), fmtNum(r.calls).padStart(8), fmtUsd(r.cost || 0).padStart(10));
  }

  const byChannel = db.prepare(`
    SELECT COALESCE(channel, chat_id) AS channel, COUNT(*) AS calls, SUM(cost_total_usd) AS cost
    FROM model_calls
    WHERE COALESCE(channel, chat_id) IS NOT NULL
    GROUP BY channel ORDER BY cost DESC, calls DESC LIMIT 15
  `).all() as any[];
  console.log('\n=== Top channels ===');
  for (const r of byChannel) {
    console.log((r.channel || '').padEnd(45), fmtNum(r.calls).padStart(8), fmtUsd(r.cost || 0).padStart(10));
  }

  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
