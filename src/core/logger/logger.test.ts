import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const testDir = path.join(os.tmpdir(), `promptbus-test-${Date.now()}`);

beforeEach(() => {
  process.env.XDG_DATA_HOME = testDir;
  fs.mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
});

async function getFreshLogger() {
  return await import("./logger.js");
}

describe("logger", () => {
  afterEach(async () => {
    // Clean up between tests to prevent state leakage
    const logger = await getFreshLogger();
    logger.closeDb();
    const dbPath = path.join(testDir, "promptbus", "promptbus.db");
    try { fs.unlinkSync(dbPath); } catch {}
  });

  describe("initDb", () => {
    it("creates the database file", async () => {
      const logger = await getFreshLogger();
      logger.initDb();
      const dbPath = path.join(testDir, "promptbus", "promptbus.db");
      expect(fs.existsSync(dbPath)).toBe(true);
    });

    it("does not crash on corrupt database", async () => {
      const dbDir = path.join(testDir, "promptbus");
      fs.mkdirSync(dbDir, { recursive: true });
      fs.writeFileSync(path.join(dbDir, "promptbus.db"), "not a valid sqlite db");

      const logger = await getFreshLogger();
      expect(() => logger.initDb()).not.toThrow();
    });

    it("recovers from corrupt database by recreating it", async () => {
      const dbDir = path.join(testDir, "promptbus");
      fs.mkdirSync(dbDir, { recursive: true });
      fs.writeFileSync(path.join(dbDir, "promptbus.db"), "corrupt data");

      const logger = await getFreshLogger();
      logger.initDb();
      const logs = logger.getRecentLogs(10);
      expect(Array.isArray(logs)).toBe(true);
    });
  });

  describe("insertLog and query", () => {
    it("inserts a log entry and retrieves it", async () => {
      const logger = await getFreshLogger();
      logger.initDb();

      logger.insertLog({
        timestamp: new Date().toISOString(),
        model_requested: "claude-sonnet-5",
        task_type: "read_explain",
        model_used: "claude-haiku-4-5",
        effort: "low",
        stream: false,
        estimated_input_tokens: 100,
        estimated_output_tokens: 50,
        estimated_cost_saved: 0.002,
        latency_ms: 1500,
        upstream_status: 200,
        downgraded: true,
        reason: "Routing read_explain -> claude-haiku-4-5",
        request_body: null,
      });

      const logs = logger.getRecentLogs(10);
      expect(logs.length).toBe(1);
      expect(logs[0].task_type).toBe("read_explain");
      expect(logs[0].model_used).toBe("claude-haiku-4-5");
    });

    it("retrieves log by id", async () => {
      const logger = await getFreshLogger();
      logger.initDb();

      logger.insertLog({
        timestamp: new Date().toISOString(),
        model_requested: "claude-sonnet-5",
        task_type: "small_edit",
        model_used: "claude-sonnet-5",
        effort: "medium",
        stream: false,
        estimated_input_tokens: 200,
        estimated_output_tokens: null,
        estimated_cost_saved: 0,
        latency_ms: 3000,
        upstream_status: 200,
        downgraded: false,
        reason: "Pass-through",
        request_body: null,
      });

      const logs = logger.getRecentLogs(10);
      const byId = logger.getLogById(logs[0].id);
      expect(byId).not.toBeNull();
      expect(byId!.task_type).toBe("small_edit");
    });

    it("returns null for non-existent log id", async () => {
      const logger = await getFreshLogger();
      logger.initDb();
      const result = logger.getLogById(9999);
      expect(result).toBeNull();
    });
  });

  describe("getSummary", () => {
    it("returns zeros when there are no logs", async () => {
      const logger = await getFreshLogger();
      logger.initDb();
      const summary = logger.getSummary();
      expect(summary.total).toBe(0);
      expect(summary.downgraded).toBe(0);
      expect(summary.costSaved).toBe(0);
    });

    it("aggregates multiple log entries", async () => {
      const logger = await getFreshLogger();
      logger.initDb();

      logger.insertLog({
        timestamp: new Date().toISOString(),
        model_requested: "claude-sonnet-5",
        task_type: "read_explain",
        model_used: "claude-haiku-4-5",
        effort: "low",
        stream: false,
        estimated_input_tokens: 100,
        estimated_output_tokens: null,
        estimated_cost_saved: 0.001,
        latency_ms: 1000,
        upstream_status: 200,
        downgraded: true,
        reason: "downgraded",
        request_body: null,
      });

      logger.insertLog({
        timestamp: new Date().toISOString(),
        model_requested: "claude-sonnet-5",
        task_type: "multi_file_refactor",
        model_used: "claude-sonnet-5",
        effort: null,
        stream: false,
        estimated_input_tokens: 500,
        estimated_output_tokens: null,
        estimated_cost_saved: 0,
        latency_ms: 5000,
        upstream_status: 200,
        downgraded: false,
        reason: "never_downgrade",
        request_body: null,
      });

      const summary = logger.getSummary();
      expect(summary.total).toBe(2);
      expect(summary.downgraded).toBe(1);
      expect(summary.costSaved).toBeCloseTo(0.001, 5);
    });
  });

  describe("exportLogs", () => {
    it("exports all logs", async () => {
      const logger = await getFreshLogger();
      logger.initDb();

      logger.insertLog({
        timestamp: "2026-01-01T00:00:00.000Z",
        model_requested: "claude-sonnet-5",
        task_type: "test_generation",
        model_used: "claude-sonnet-5",
        effort: "medium",
        stream: false,
        estimated_input_tokens: 150,
        estimated_output_tokens: null,
        estimated_cost_saved: 0,
        latency_ms: 2000,
        upstream_status: 200,
        downgraded: false,
        reason: "test",
        request_body: null,
      });

      const exported = logger.exportLogs();
      expect(exported.length).toBe(1);
      expect(exported[0].task_type).toBe("test_generation");
    });

    it("filters by date range", async () => {
      const logger = await getFreshLogger();
      logger.initDb();

      logger.insertLog({
        timestamp: "2026-01-01T00:00:00.000Z",
        model_requested: "claude-sonnet-5",
        task_type: "small_edit",
        model_used: "claude-sonnet-5",
        effort: null,
        stream: false,
        estimated_input_tokens: 50,
        estimated_output_tokens: null,
        estimated_cost_saved: 0,
        latency_ms: 500,
        upstream_status: 200,
        downgraded: false,
        reason: "",
        request_body: null,
      });

      const filtered = logger.exportLogs("2026-01-02T00:00:00.000Z", "2026-12-31T00:00:00.000Z");
      expect(filtered.length).toBe(0);
    });
  });

  describe("self-healing", () => {
    it("insertLog does not throw when DB not initialized", async () => {
      const logger = await getFreshLogger();
      expect(() => {
        logger.insertLog({
          timestamp: new Date().toISOString(),
          model_requested: "test",
          task_type: "unknown",
          model_used: "test",
          effort: null,
          stream: false,
          estimated_input_tokens: 0,
          estimated_output_tokens: null,
          estimated_cost_saved: 0,
          latency_ms: 0,
          upstream_status: 200,
          downgraded: false,
          reason: "",
          request_body: null,
        });
      }).not.toThrow();
    });

    it("initDb can be called multiple times safely", async () => {
      const logger = await getFreshLogger();
      expect(() => {
        logger.initDb();
        logger.initDb();
        logger.initDb();
      }).not.toThrow();
    });
  });
});
