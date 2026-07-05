import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface ModelCall {
  id?: number;
  agent: string;         // e.g. "main", "wozbot", "alvy"
  session_id: string;    // trajectory file base name
  provider: string;      // e.g. "anthropic", "openai", "google", "ollama"
  model: string;         // e.g. "claude-opus-4-7", "gpt-5.3-codex"
  api: string | null;    // e.g. "anthropic", "openai", "ollama"
  chat_id: string | null; // e.g. "channel:C0AJU4X0DG9" (from finalPromptText/message metadata)
  channel: string | null; // resolved friendly label (e.g. "#wozbot") when available
  ts_ms: number;         // model call timestamp
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  cache_write: number;
  cost_input_usd: number;
  cost_output_usd: number;
  cost_cache_read_usd: number;
  cost_cache_write_usd: number;
  cost_total_usd: number;
  cost_source: string;   // "logged" (from OpenClaw's own usage.cost.total) | "estimated" (local pricing table, no logged cost) | "recomputed" (local pricing table, ignored logged cost as unreliable) | "unpriced"
  stop_reason: string | null;
}

export interface FileOffset {
  path: string;
  inode: number;
  size: number;
  offset: number;
  last_scanned_ms: number;
}

export function openDb(dataDir: string): Database.Database {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'usage.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS model_calls (
      id                    INTEGER PRIMARY KEY AUTOINCREMENT,
      agent                 TEXT NOT NULL,
      session_id            TEXT NOT NULL,
      provider              TEXT NOT NULL,
      model                 TEXT NOT NULL,
      api                   TEXT,
      chat_id               TEXT,
      channel               TEXT,
      ts_ms                 INTEGER NOT NULL,
      input_tokens          INTEGER NOT NULL DEFAULT 0,
      output_tokens         INTEGER NOT NULL DEFAULT 0,
      cache_read            INTEGER NOT NULL DEFAULT 0,
      cache_write           INTEGER NOT NULL DEFAULT 0,
      cost_input_usd        REAL NOT NULL DEFAULT 0,
      cost_output_usd       REAL NOT NULL DEFAULT 0,
      cost_cache_read_usd   REAL NOT NULL DEFAULT 0,
      cost_cache_write_usd  REAL NOT NULL DEFAULT 0,
      cost_total_usd        REAL NOT NULL DEFAULT 0,
      cost_source           TEXT NOT NULL DEFAULT 'unpriced',
      stop_reason           TEXT,
      -- de-dup: (session, ts, model, input, output) is unique enough in practice
      UNIQUE(session_id, ts_ms, model, input_tokens, output_tokens)
    );

    CREATE INDEX IF NOT EXISTS idx_model_calls_ts       ON model_calls(ts_ms);
    CREATE INDEX IF NOT EXISTS idx_model_calls_agent    ON model_calls(agent, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_model_calls_provider ON model_calls(provider, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_model_calls_model    ON model_calls(model, ts_ms);
    CREATE INDEX IF NOT EXISTS idx_model_calls_chat     ON model_calls(chat_id, ts_ms);

    CREATE TABLE IF NOT EXISTS file_offsets (
      path            TEXT PRIMARY KEY,
      inode           INTEGER NOT NULL,
      size            INTEGER NOT NULL,
      offset          INTEGER NOT NULL,
      last_scanned_ms INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channel_labels (
      chat_id TEXT PRIMARY KEY,
      label   TEXT NOT NULL,
      updated_ms INTEGER NOT NULL
    );
  `);

  return db;
}

const INSERT_CALL_SQL = `
  INSERT OR IGNORE INTO model_calls (
    agent, session_id, provider, model, api, chat_id, channel, ts_ms,
    input_tokens, output_tokens, cache_read, cache_write,
    cost_input_usd, cost_output_usd, cost_cache_read_usd, cost_cache_write_usd,
    cost_total_usd, cost_source, stop_reason
  ) VALUES (
    @agent, @session_id, @provider, @model, @api, @chat_id, @channel, @ts_ms,
    @input_tokens, @output_tokens, @cache_read, @cache_write,
    @cost_input_usd, @cost_output_usd, @cost_cache_read_usd, @cost_cache_write_usd,
    @cost_total_usd, @cost_source, @stop_reason
  )
`;

export function insertModelCalls(db: Database.Database, calls: ModelCall[]): number {
  if (calls.length === 0) return 0;
  const stmt = db.prepare(INSERT_CALL_SQL);
  const tx = db.transaction((batch: ModelCall[]) => {
    let inserted = 0;
    for (const c of batch) {
      const result = stmt.run(c as any);
      if (result.changes > 0) inserted++;
    }
    return inserted;
  });
  return tx(calls);
}

export function upsertOffset(db: Database.Database, o: FileOffset): void {
  db.prepare(`
    INSERT INTO file_offsets(path, inode, size, offset, last_scanned_ms)
    VALUES(@path, @inode, @size, @offset, @last_scanned_ms)
    ON CONFLICT(path) DO UPDATE SET
      inode = excluded.inode,
      size = excluded.size,
      offset = excluded.offset,
      last_scanned_ms = excluded.last_scanned_ms
  `).run(o);
}

export function getOffset(db: Database.Database, filePath: string): FileOffset | undefined {
  return db.prepare(`SELECT * FROM file_offsets WHERE path = ?`).get(filePath) as FileOffset | undefined;
}

export function upsertChannelLabel(db: Database.Database, chatId: string, label: string): void {
  db.prepare(`
    INSERT INTO channel_labels(chat_id, label, updated_ms) VALUES(?, ?, ?)
    ON CONFLICT(chat_id) DO UPDATE SET label = excluded.label, updated_ms = excluded.updated_ms
  `).run(chatId, label, Date.now());
}

export function resolveChannelLabel(db: Database.Database, chatId: string): string | null {
  const row = db.prepare(`SELECT label FROM channel_labels WHERE chat_id = ?`).get(chatId) as { label: string } | undefined;
  return row?.label ?? null;
}
