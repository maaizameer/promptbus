import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { loadConfig } from "../rules_engine/rules_engine.js";

function getDataDir(): string {
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg) return path.join(xdg, "promptbus");
  const home = os.homedir();
  if (os.platform() === "darwin") {
    return path.join(home, "Library", "Application Support", "promptbus");
  }
  if (os.platform() === "win32") {
    return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "promptbus");
  }
  return path.join(home, ".local", "share", "promptbus");
}

const DB_PATH = path.join(getDataDir(), "promptbus.db");

let db: Database.Database | null = null;
let initAttempted = false;

export interface LogEntry {
  timestamp: string;
  model_requested: string;
  task_type: string;
  model_used: string;
  effort: string | null;
  stream: boolean;
  estimated_input_tokens: number;
  estimated_output_tokens: number | null;
  estimated_cost_saved: number;
  latency_ms: number;
  upstream_status: number;
  downgraded: boolean;
  reason: string;
  request_body?: string | null;
}

export interface LogRow extends LogEntry {
  id: number;
}

function setupSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      model_requested TEXT NOT NULL,
      task_type TEXT NOT NULL,
      model_used TEXT NOT NULL,
      effort TEXT,
      stream INTEGER NOT NULL DEFAULT 0,
      estimated_input_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_output_tokens INTEGER,
      estimated_cost_saved REAL NOT NULL DEFAULT 0,
      latency_ms INTEGER NOT NULL DEFAULT 0,
      upstream_status INTEGER NOT NULL DEFAULT 0,
      downgraded INTEGER NOT NULL DEFAULT 0,
      reason TEXT NOT NULL DEFAULT ''
    )
  `);

  try {
    const tableInfo = db.prepare("PRAGMA table_info(requests)").all() as any[];
    const hasRequestBody = tableInfo.some((col) => col.name === "request_body");
    if (!hasRequestBody) {
      db.exec("ALTER TABLE requests ADD COLUMN request_body TEXT");
    }
  } catch (err) {
    console.error(`[logger] Migration failed: ${err}`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pricing (
      model TEXT PRIMARY KEY,
      input_per_mtok REAL NOT NULL DEFAULT 0,
      output_per_mtok REAL NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  syncPricing();
  pruneOldLogs();
}

function openDb(): boolean {
  if (db) return true;
  if (initAttempted) return false;
  initAttempted = true;

  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    setupSchema(db);
    return true;
  } catch (err) {
    console.error(`[logger] DB open failed: ${err}`);
    // corrupt file — delete and retry once
    try {
      if (db) { db.close(); db = null; }
      if (fs.existsSync(DB_PATH)) fs.unlinkSync(DB_PATH);
      db = new Database(DB_PATH);
      db.pragma("journal_mode = WAL");
      setupSchema(db);
      console.error("[logger] DB recovered after deleting corrupt file");
      return true;
    } catch (err2) {
      console.error(`[logger] DB recovery failed: ${err2}`);
      db = null;
      return false;
    }
  }
}

export function initDb(): void {
  initAttempted = false;
  openDb();
}

function pruneOldLogs(): void {
  if (!db) return;
  try {
    let retentionDays = 90;
    try {
      const config = loadConfig();
      if (typeof config.log_retention_days === "number") {
        retentionDays = config.log_retention_days;
      }
    } catch {}
    const cutoff = new Date(Date.now() - retentionDays * 86400000).toISOString();
    const info = db.prepare("DELETE FROM requests WHERE timestamp < ?").run(cutoff);
    if (info.changes > 0) {
      db.pragma("wal_checkpoint(TRUNCATE)");
    }
  } catch (err) {
    console.error(`[logger] Failed to prune old logs: ${err}`);
  }
}

function syncPricing(): void {
  try {
    const config = loadConfig();
    const upsert = db!.prepare(`
      INSERT INTO pricing (model, input_per_mtok, output_per_mtok, updated_at)
      VALUES (@model, @input, @output, datetime('now'))
      ON CONFLICT(model) DO UPDATE SET
        input_per_mtok = @input,
        output_per_mtok = @output,
        updated_at = datetime('now')
    `);

    const txn = db!.transaction(() => {
      for (const [model, pricing] of Object.entries(config.pricing)) {
        upsert.run({
          model,
          input: pricing.input_per_mtok,
          output: pricing.output_per_mtok,
        });
      }
    });
    txn();
  } catch (err) {
    console.error(`[logger] Failed to sync pricing: ${err}`);
  }
}

export function insertLog(entry: LogEntry): void {
  if (!openDb()) {
    console.error("[logger] DB not available, dropping log entry");
    return;
  }
  try {
    db!.prepare(`
      INSERT INTO requests (timestamp, model_requested, task_type, model_used, effort, stream,
        estimated_input_tokens, estimated_output_tokens, estimated_cost_saved, latency_ms,
        upstream_status, downgraded, reason, request_body)
      VALUES (@timestamp, @model_requested, @task_type, @model_used, @effort, @stream,
        @estimated_input_tokens, @estimated_output_tokens, @estimated_cost_saved, @latency_ms,
        @upstream_status, @downgraded, @reason, @request_body)
    `).run({
      timestamp: entry.timestamp,
      model_requested: entry.model_requested,
      task_type: entry.task_type,
      model_used: entry.model_used,
      effort: entry.effort,
      stream: entry.stream ? 1 : 0,
      estimated_input_tokens: entry.estimated_input_tokens,
      estimated_output_tokens: entry.estimated_output_tokens,
      estimated_cost_saved: entry.estimated_cost_saved,
      latency_ms: entry.latency_ms,
      upstream_status: entry.upstream_status,
      downgraded: entry.downgraded ? 1 : 0,
      reason: entry.reason,
      request_body: entry.request_body ?? null,
    });
  } catch (err) {
    console.error(`[logger] Failed to insert log: ${err}`);
    // DB may have become stale — reset and try once more
    db = null;
    initAttempted = false;
    if (openDb()) {
      try {
        db!.prepare(`
          INSERT INTO requests (timestamp, model_requested, task_type, model_used, effort, stream,
            estimated_input_tokens, estimated_output_tokens, estimated_cost_saved, latency_ms,
            upstream_status, downgraded, reason, request_body)
          VALUES (@timestamp, @model_requested, @task_type, @model_used, @effort, @stream,
            @estimated_input_tokens, @estimated_output_tokens, @estimated_cost_saved, @latency_ms,
            @upstream_status, @downgraded, @reason, @request_body)
        `).run({
          timestamp: entry.timestamp,
          model_requested: entry.model_requested,
          task_type: entry.task_type,
          model_used: entry.model_used,
          effort: entry.effort,
          stream: entry.stream ? 1 : 0,
          estimated_input_tokens: entry.estimated_input_tokens,
          estimated_output_tokens: entry.estimated_output_tokens,
          estimated_cost_saved: entry.estimated_cost_saved,
          latency_ms: entry.latency_ms,
          upstream_status: entry.upstream_status,
          downgraded: entry.downgraded ? 1 : 0,
          reason: entry.reason,
          request_body: entry.request_body ?? null,
        });
      } catch (err2) {
        console.error(`[logger] Failed to insert log (retry): ${err2}`);
      }
    }
  }
}

export function getRecentLogs(limit = 50): LogRow[] {
  if (!openDb()) return [];
  try {
    return db!.prepare("SELECT * FROM requests ORDER BY id DESC LIMIT ?").all(limit) as LogRow[];
  } catch {
    return [];
  }
}

export function getLogById(id: number): LogRow | null {
  if (!openDb()) return null;
  try {
    const row = db!.prepare("SELECT * FROM requests WHERE id = ?").get(id) as LogRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export function getSummary(): { total: number; downgraded: number; costSaved: number } {
  if (!openDb()) return { total: 0, downgraded: 0, costSaved: 0 };
  try {
    const row = db!.prepare(`
      SELECT
        COUNT(*) as total,
        COALESCE(SUM(downgraded), 0) as downgraded,
        COALESCE(SUM(estimated_cost_saved), 0) as cost_saved
      FROM requests
    `).get() as { total: number; downgraded: number; cost_saved: number };
    return { total: row.total, downgraded: row.downgraded, costSaved: row.cost_saved };
  } catch {
    return { total: 0, downgraded: 0, costSaved: 0 };
  }
}

export function exportLogs(start?: string, end?: string): LogRow[] {
  if (!openDb()) return [];
  try {
    if (start && end) {
      return db!.prepare("SELECT * FROM requests WHERE timestamp BETWEEN ? AND ? ORDER BY id DESC").all(start, end) as LogRow[];
    }
    return db!.prepare("SELECT * FROM requests ORDER BY id DESC").all() as LogRow[];
  } catch {
    return [];
  }
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
  initAttempted = false;
}
