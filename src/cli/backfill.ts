/**
 * Full backfill: wipe the DB and rescan every trajectory file from
 * offset 0. Useful when the pricing table changes or when the schema
 * evolves.
 */
import { loadConfig } from '../config';
import { openDb } from '../db';
import { scanAll } from '../scanner/trajectory-scanner';

async function main() {
  const cfg = loadConfig();
  const db = openDb(cfg.dataDir);
  console.log('[backfill] clearing existing tables...');
  db.exec(`DELETE FROM model_calls; DELETE FROM file_offsets; DELETE FROM channel_labels;`);
  console.log('[backfill] scanning...');
  const r = await scanAll(db, cfg.openclawRoot);
  console.log(`[backfill] ${r.filesScanned} files, ${r.callsInserted} calls, ${r.errors} errors, ${r.durationMs}ms`);
  db.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
