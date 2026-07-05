/**
 * Trajectory scanner: reads OpenClaw agent session trajectory JSONL logs
 * incrementally and extracts model-call cost / usage records.
 *
 * Each trajectory JSONL is append-only during a session's life, so we
 * track byte offsets in SQLite. On rescan we open the file, seek to the
 * saved offset, and parse forward. If a file's inode changes (rename)
 * or shrinks (rotated) we start from 0.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  ModelCall,
  getOffset,
  insertModelCalls,
  upsertOffset,
  upsertChannelLabel,
  resolveChannelLabel,
} from '../db';
import { lookupPrice, estimateCost } from '../pricing';

export interface ScanResult {
  filesScanned: number;
  newBytes: number;
  callsInserted: number;
  errors: number;
  durationMs: number;
}

/** Recursively walk `agents/<agent>/sessions/` and return matching trajectory files. */
async function findTrajectoryFiles(openclawRoot: string): Promise<Array<{ path: string; agent: string }>> {
  const results: Array<{ path: string; agent: string }> = [];
  const agentsDir = path.join(openclawRoot, 'agents');
  let agents: string[] = [];
  try {
    agents = await fsp.readdir(agentsDir);
  } catch { return results; }
  for (const agent of agents) {
    const sessionsDir = path.join(agentsDir, agent, 'sessions');
    let entries: string[] = [];
    try { entries = await fsp.readdir(sessionsDir); } catch { continue; }
    for (const name of entries) {
      // Accept both `.trajectory.jsonl` (main/trajectory format) and plain
      // `.jsonl` (some agents write session .jsonl directly). Skip the
      // `.trajectory-path.json` sidecars and anything renamed `.deleted.*`.
      if (name.endsWith('.deleted') || name.includes('.deleted.') || name.includes('.failed.') || name.includes('.reset.')) continue;
      if (name.endsWith('.trajectory-path.json')) continue;
      if (!name.endsWith('.jsonl')) continue;
      results.push({ path: path.join(sessionsDir, name), agent });
    }
  }
  return results;
}

/** Parse a trajectory record and extract any assistant messages with usage. */
function extractCallsFromRecord(
  rec: any,
  ctx: { agent: string; sessionId: string; filePath: string },
): { calls: ModelCall[]; channelLabel?: { chatId: string; label: string } } {
  const calls: ModelCall[] = [];
  let channelLabel: { chatId: string; label: string } | undefined;

  // The messages array can live at rec.data.messages, rec.data.data.messages,
  // or at the top level. Handle all shapes.
  const candidateArrays: any[] = [];
  const visit = (o: any, depth = 0) => {
    if (depth > 6 || !o || typeof o !== 'object') return;
    if (Array.isArray(o)) {
      // Only care about arrays whose entries look like messages with usage
      if (o.length && typeof o[0] === 'object' && o[0] !== null && ('usage' in o[0] || 'role' in o[0])) {
        candidateArrays.push(o);
      }
      for (const v of o) visit(v, depth + 1);
      return;
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(rec);

  const seen = new Set<string>();
  for (const arr of candidateArrays) {
    for (const m of arr) {
      if (!m || typeof m !== 'object') continue;
      if (m.role && m.role !== 'assistant') continue;
      const u = m.usage;
      if (!u || typeof u !== 'object') continue;
      const provider: string = m.provider || m.api || 'unknown';
      const model: string = m.model || 'unknown';
      const tsMs: number = Number(m.timestamp) || Date.now();
      const inp = Number(u.input) || Number(u.input_tokens) || 0;
      const out = Number(u.output) || Number(u.output_tokens) || 0;
      const cRead = Number(u.cacheRead) || Number(u.cache_read_input_tokens) || 0;
      const cWrite = Number(u.cacheWrite) || Number(u.cache_creation_input_tokens) || 0;

      // De-dup within this record (same message can appear in multiple embeddings).
      const dedupKey = `${tsMs}|${model}|${inp}|${out}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      const loggedCost = u.cost && typeof u.cost === 'object' ? u.cost : null;
      let costInput = Number(loggedCost?.input) || 0;
      let costOutput = Number(loggedCost?.output) || 0;
      let costCacheRead = Number(loggedCost?.cacheRead) || 0;
      let costCacheWrite = Number(loggedCost?.cacheWrite) || 0;
      let costTotal = Number(loggedCost?.total) || 0;
      let costSource: 'logged' | 'estimated' | 'unpriced' = 'unpriced';

      if (costTotal > 0) {
        costSource = 'logged';
      } else {
        const price = lookupPrice(provider, model);
        if (price) {
          const est = estimateCost(price, { input: inp, output: out, cacheRead: cRead, cacheWrite: cWrite });
          costInput = est.input;
          costOutput = est.output;
          costCacheRead = est.cacheRead;
          costCacheWrite = est.cacheWrite;
          costTotal = est.total;
          costSource = est.total > 0 ? 'estimated' : 'unpriced';
        }
      }

      calls.push({
        agent: ctx.agent,
        session_id: ctx.sessionId,
        provider,
        model,
        api: m.api || null,
        chat_id: null, // filled in below if we found it in the record
        channel: null,
        ts_ms: tsMs,
        input_tokens: inp,
        output_tokens: out,
        cache_read: cRead,
        cache_write: cWrite,
        cost_input_usd: costInput,
        cost_output_usd: costOutput,
        cost_cache_read_usd: costCacheRead,
        cost_cache_write_usd: costCacheWrite,
        cost_total_usd: costTotal,
        cost_source: costSource,
        stop_reason: m.stopReason || null,
      });
    }
  }

  // Look for a chat_id / conversation_label anywhere in the record's
  // finalPromptText (used by Slack channels, WhatsApp, etc).
  const findChatMeta = (o: any, depth = 0): void => {
    if (depth > 5 || !o) return;
    if (typeof o === 'string') {
      // Regex to pull "chat_id": "channel:XYZ" and "conversation_label": "#name"
      const cid = /"chat_id"\s*:\s*"([^"]+)"/.exec(o);
      const clbl = /"conversation_label"\s*:\s*"([^"]+)"/.exec(o);
      if (cid && clbl) channelLabel = { chatId: cid[1], label: clbl[1] };
      return;
    }
    if (typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) findChatMeta(v, depth + 1); return; }
    for (const v of Object.values(o)) findChatMeta(v, depth + 1);
  };
  findChatMeta(rec);
  if (channelLabel) {
    for (const c of calls) c.chat_id = channelLabel.chatId;
  }

  return { calls, channelLabel };
}

async function scanFile(
  db: Database.Database,
  filePath: string,
  agent: string,
): Promise<{ newBytes: number; inserted: number; errors: number }> {
  const stat = await fsp.stat(filePath);
  const inode = stat.ino;
  const size = stat.size;
  const prev = getOffset(db, filePath);

  // Decide where to start reading.
  let startOffset = 0;
  if (prev && prev.inode === inode && prev.size <= size) {
    startOffset = prev.offset;
  }
  if (startOffset >= size) {
    upsertOffset(db, { path: filePath, inode, size, offset: startOffset, last_scanned_ms: Date.now() });
    return { newBytes: 0, inserted: 0, errors: 0 };
  }

  // Read only the new bytes.
  const fh = await fsp.open(filePath, 'r');
  const buf = Buffer.alloc(size - startOffset);
  await fh.read(buf, 0, buf.length, startOffset);
  await fh.close();
  const text = buf.toString('utf8');

  // Find last newline; only parse up to there, keep the rest for next scan.
  const lastNl = text.lastIndexOf('\n');
  let parseable: string;
  let consumed: number;
  if (lastNl === -1) {
    // No full line yet. Bail; try again later.
    upsertOffset(db, { path: filePath, inode, size, offset: startOffset, last_scanned_ms: Date.now() });
    return { newBytes: size - startOffset, inserted: 0, errors: 0 };
  } else {
    parseable = text.slice(0, lastNl);
    consumed = lastNl + 1;
  }

  const sessionId = path.basename(filePath).replace(/\.trajectory\.jsonl$|\.jsonl$/, '');
  const lines = parseable.split('\n');
  const allCalls: ModelCall[] = [];
  let errors = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); }
    catch { errors++; continue; }
    try {
      const { calls, channelLabel } = extractCallsFromRecord(rec, { agent, sessionId, filePath });
      if (channelLabel) upsertChannelLabel(db, channelLabel.chatId, channelLabel.label);
      // Resolve channel labels we've already learned about.
      for (const c of calls) {
        if (c.chat_id && !c.channel) {
          c.channel = resolveChannelLabel(db, c.chat_id);
        }
      }
      allCalls.push(...calls);
    } catch { errors++; }
  }

  const inserted = insertModelCalls(db, allCalls);
  upsertOffset(db, { path: filePath, inode, size, offset: startOffset + consumed, last_scanned_ms: Date.now() });
  return { newBytes: size - startOffset, inserted, errors };
}

export async function scanAll(db: Database.Database, openclawRoot: string): Promise<ScanResult> {
  const started = Date.now();
  const files = await findTrajectoryFiles(openclawRoot);
  let filesScanned = 0;
  let newBytes = 0;
  let callsInserted = 0;
  let errors = 0;
  for (const { path: p, agent } of files) {
    try {
      const r = await scanFile(db, p, agent);
      filesScanned++;
      newBytes += r.newBytes;
      callsInserted += r.inserted;
      errors += r.errors;
    } catch (e) {
      errors++;
    }
  }
  return { filesScanned, newBytes, callsInserted, errors, durationMs: Date.now() - started };
}

/**
 * Set up an fs.watch on the agents directory so we can react to new
 * trajectory writes in near-realtime. Falls back gracefully if watch
 * isn't supported. Debounces scans so we don't rescan on every byte.
 */
export function watchTrajectories(
  db: Database.Database,
  openclawRoot: string,
  onScan: (r: ScanResult) => void,
  debounceMs = 2000,
): () => void {
  const agentsDir = path.join(openclawRoot, 'agents');
  let timer: NodeJS.Timeout | null = null;
  let closed = false;
  let watcher: fs.FSWatcher | null = null;

  const doScan = () => {
    if (closed) return;
    scanAll(db, openclawRoot).then(onScan).catch(() => { /* swallow */ });
  };

  try {
    watcher = fs.watch(agentsDir, { recursive: true }, (_event, filename) => {
      if (closed) return;
      if (!filename) return;
      if (!filename.endsWith('.jsonl')) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(doScan, debounceMs);
    });
  } catch {
    // fs.watch { recursive: true } is not supported on all platforms.
    // Silent fallback -- interval scan will still catch changes.
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (watcher) { try { watcher.close(); } catch {} }
  };
}
