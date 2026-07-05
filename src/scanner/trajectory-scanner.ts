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
import { lookupPrice, estimateCost, lookupImagePrice } from '../pricing';

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

/**
 * Extract image_generate tool successes from a record. Each image_generate
 * task appears in 3 trajectory events per session (context.compiled,
 * prompt.submitted, model.completed) all sharing the same runId
 * `image_generate:<uuid>:ok`. We dedupe by runId within one scan pass;
 * the model_calls UNIQUE(session_id, ts_ms, model, input_tokens, output_tokens)
 * constraint handles idempotency across scans.
 *
 * The "child result" text embedded in the record's finalPromptText /
 * prompt / messages contains lines like:
 *   "Generated N image with google/gemini-3.1-flash-image-preview."
 * That is the sole signal we use to attribute cost to a specific model.
 */
function extractImageGenerationsFromRecord(
  rec: any,
  ctx: { agent: string; sessionId: string; seenRunIds: Set<string> },
): ModelCall[] {
  const runId: string = typeof rec?.runId === 'string' ? rec.runId : '';
  if (!runId.startsWith('image_generate:') || !runId.endsWith(':ok')) return [];
  if (ctx.seenRunIds.has(runId)) return [];

  // Scan the whole record as JSON text for the "Generated N image with <p>/<m>" line.
  const blob = JSON.stringify(rec);
  // Provider is a simple slug; model may include dots/hyphens (e.g.
  // "gemini-3.1-flash-image-preview"). Strip a trailing period if the sentence
  // ended right after the model name.
  const m = /Generated\s+(\d+)\s+image[s]?\s+with\s+([a-z0-9_-]+)\/([a-z0-9][a-z0-9._-]*[a-z0-9])/i.exec(blob);
  if (!m) return [];

  const count = Number(m[1]) || 1;
  const provider = m[2].toLowerCase();
  const model = m[3].toLowerCase();
  const tsMs = Date.parse(rec.ts || '') || Date.now();
  const price = lookupImagePrice(provider, model);
  const perImage = price ? price.perImage : 0;
  const total = perImage * count;

  ctx.seenRunIds.add(runId);

  return [{
    agent: ctx.agent,
    session_id: ctx.sessionId,
    provider,
    model,
    api: 'image_generate',
    chat_id: null,
    channel: null,
    ts_ms: tsMs,
    // Encode image count in output_tokens so we get a natural per-call quantity
    // in the dashboard, without adding a new column. cost_source disambiguates.
    input_tokens: 0,
    output_tokens: count,
    cache_read: 0,
    cache_write: 0,
    cost_input_usd: 0,
    cost_output_usd: total,
    cost_cache_read_usd: 0,
    cost_cache_write_usd: 0,
    cost_total_usd: total,
    cost_source: price ? 'image_per_call' : 'image_unpriced',
    stop_reason: null,
  }];
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
  const singletonMessages: any[] = [];
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
    // Legacy session .jsonl format writes messages as record.message = { role, usage, provider, model, ... }
    // These are single objects, not arrays. If we see an assistant message with a usage block
    // and provider/model info, treat it as a standalone message.
    if (o.role === 'assistant' && o.usage && typeof o.usage === 'object' &&
        (o.provider || o.api || o.model)) {
      singletonMessages.push(o);
    }
    for (const v of Object.values(o)) visit(v, depth + 1);
  };
  visit(rec);
  if (singletonMessages.length > 0) {
    // Present them the same shape as candidateArrays entries.
    candidateArrays.push(singletonMessages);
  }

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
      let costSource: 'logged' | 'estimated' | 'recomputed' | 'unpriced' = 'unpriced';

      // OpenClaw's logged cost is unreliable for Anthropic (as of 2026-07-05):
      // uses wrong output rate for Opus 4.7 (~$25/M vs actual $75/M), and
      // does not cost cache reads or cache writes at all. Force recompute
      // from tokens using our local pricing table. Other providers' logged
      // costs match token-based estimates within a few percent, so trust them.
      const providerIsAnthropic = provider === 'anthropic' || model.startsWith('claude-');
      const price = lookupPrice(provider, model);

      if (providerIsAnthropic && price) {
        const est = estimateCost(price, { input: inp, output: out, cacheRead: cRead, cacheWrite: cWrite });
        costInput = est.input;
        costOutput = est.output;
        costCacheRead = est.cacheRead;
        costCacheWrite = est.cacheWrite;
        costTotal = est.total;
        costSource = est.total > 0 ? 'recomputed' : 'unpriced';
      } else if (costTotal > 0) {
        costSource = 'logged';
      } else if (price) {
        const est = estimateCost(price, { input: inp, output: out, cacheRead: cRead, cacheWrite: cWrite });
        costInput = est.input;
        costOutput = est.output;
        costCacheRead = est.cacheRead;
        costCacheWrite = est.cacheWrite;
        costTotal = est.total;
        costSource = est.total > 0 ? 'estimated' : 'unpriced';
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

  // Only trust chat_id / conversation_label extraction from real
  // trajectory records (schema=openclaw-trajectory). Legacy `.jsonl`
  // files (Claude Code / TUI-native format) don't carry canonical chat
  // metadata; any chat_id substrings inside them are from embedded
  // context references to other sessions/channels and misattribute
  // spend when trusted. TUI sessions have no chat channel.
  //
  // Usage extraction from those files is still valid — we just skip the
  // chat_id lookup by returning early below when this flag is false.
  const isTrajectory = rec?.traceSchema === 'openclaw-trajectory';

  // Look for a chat_id / conversation_label anywhere in the record's
  // finalPromptText (used by Slack channels, WhatsApp, etc).
  const findChatMeta = (o: any, depth = 0): void => {
    if (depth > 5 || !o) return;
    if (typeof o === 'string') {
      // Regex to pull "chat_id": "channel:XYZ" and "conversation_label": "#name".
      // These fields appear in two forms in the trajectory:
      //   1. As real JSON fields at some object level: "chat_id": "..."
      //   2. Embedded inside a finalPromptText/prompt STRING blob that has
      //      the chat metadata JSON-serialized inside it. When JSON re-
      //      serialized (visitor walk hits a string), the inner quotes get
      //      re-escaped as \\" and this regex needs to accept both forms.
      const cid = /\\?"chat_id\\?"\s*:\s*\\?"([^"\\]+)\\?"/.exec(o);
      const clbl = /\\?"conversation_label\\?"\s*:\s*\\?"([^"\\]+)\\?"/.exec(o);
      if (cid && clbl) {
        // Sanity-check chat_id shape before accepting. Real values look
        // like "channel:C0AJU4X0DG9", "bluebubbles:chat_guid:...", or
        // "whatsapp:+14155551212". Reject bare placeholders like "XYZ"
        // (leftover from doc/regex test strings that sometimes end up
        // pasted into session context blobs).
        const chatId = cid[1];
        const looksReal = /^[a-z]+:[A-Za-z0-9_+\-:.@]+$/i.test(chatId) && chatId.length >= 10;
        if (looksReal) channelLabel = { chatId, label: clbl[1] };
      }
      return;
    }
    if (typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const v of o) findChatMeta(v, depth + 1); return; }
    for (const v of Object.values(o)) findChatMeta(v, depth + 1);
  };
  if (isTrajectory) {
    findChatMeta(rec);
    if (channelLabel) {
      for (const c of calls) c.chat_id = channelLabel.chatId;
    }
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
  const seenImageRunIds = new Set<string>();
  // Session-level chat metadata: the trajectory embeds chat_id/label in
  // event types that don't have usage (context.compiled, prompt.submitted),
  // so we harvest it separately and apply to ALL calls in the file at the
  // end. A session belongs to exactly one chat_id.
  let fileChannelLabel: { chatId: string; label: string } | undefined;
  let errors = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: any;
    try { rec = JSON.parse(trimmed); }
    catch { errors++; continue; }
    try {
      const { calls, channelLabel } = extractCallsFromRecord(rec, { agent, sessionId, filePath });
      if (channelLabel) {
        upsertChannelLabel(db, channelLabel.chatId, channelLabel.label);
        // First hit wins for file-level attribution; a session should never
        // switch chat_ids mid-life, but if it does we prefer the earliest.
        if (!fileChannelLabel) fileChannelLabel = channelLabel;
      }
      // Resolve channel labels we've already learned about.
      for (const c of calls) {
        if (c.chat_id && !c.channel) {
          c.channel = resolveChannelLabel(db, c.chat_id);
        }
      }
      allCalls.push(...calls);
      // Image generation tool calls (bypass the trajectory usage pipeline).
      const imgCalls = extractImageGenerationsFromRecord(rec, { agent, sessionId, seenRunIds: seenImageRunIds });
      allCalls.push(...imgCalls);
    } catch { errors++; }
  }

  // Apply file-level chat metadata to any calls that didn't get it from
  // their own record. This is the common case: `model.completed` events
  // rarely embed chat_id, but the session's `context.compiled` events do.
  if (fileChannelLabel) {
    for (const c of allCalls) {
      if (!c.chat_id) c.chat_id = fileChannelLabel.chatId;
      if (!c.channel) c.channel = fileChannelLabel.label;
    }
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
