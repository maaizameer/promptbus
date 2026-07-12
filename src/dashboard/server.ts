import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getRecentLogs, getLogById, getSummary, exportLogs } from "../core/logger/logger.js";

import * as yaml from "js-yaml";
import { loadConfig, invalidateCache } from "../core/rules_engine/rules_engine.js";
import type { RulesConfig, PricingEntry } from "../core/rules_engine/rules_engine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "public");
const CONFIG_DIR = path.resolve(__dirname, "../../config");
const RULES_PATH = path.join(CONFIG_DIR, "rules.yaml");

export function createApp(): express.Application {
  const app = express();
  app.use(express.json());

  // Serve static files
  app.use(express.static(PUBLIC_DIR));

  // API: summary stats
  app.get("/api/summary", (_req, res) => {
    const summary = getSummary();
    res.json(summary);
  });

  // API: recent logs
  app.get("/api/logs", (req, res) => {
    const raw = parseInt(req.query.limit as string, 10);
    const limit = !isNaN(raw) && raw > 0 ? raw : 50;
    const logs = getRecentLogs(Math.min(limit, 1000));
    res.json(logs);
  });

  // API: export logs as CSV
  app.get("/api/logs/export", (req, res) => {
    try {
      const start = req.query.start ? String(req.query.start) : undefined;
      const end = req.query.end ? String(req.query.end) : undefined;
      const logs = exportLogs(start, end);
      
      let csv = "ID,Timestamp,Model Requested,Task Type,Model Used,Effort,Stream,Estimated Input Tokens,Estimated Cost Saved,Latency MS,Upstream Status,Downgraded,Reason\n";
      for (const log of logs) {
        const row = [
          log.id,
          log.timestamp,
          log.model_requested,
          log.task_type,
          log.model_used,
          log.effort || "",
          log.stream ? "1" : "0",
          log.estimated_input_tokens,
          log.estimated_cost_saved.toFixed(6),
          log.latency_ms,
          log.upstream_status,
          log.downgraded ? "1" : "0",
          `"${(log.reason || "").replace(/"/g, '""')}"`
        ];
        csv += row.join(",") + "\n";
      }
      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", "attachment; filename=promptbus-logs.csv");
      res.status(200).send(csv);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // API: single log detail
  app.get("/api/log/:id", (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) return res.status(400).json({ error: "Invalid id" });
    const log = getLogById(id);
    if (!log) return res.status(404).json({ error: "Log not found" });
    res.json(log);
  });

  // API: get rules config
  app.get("/api/rules", (_req, res) => {
    try {
      const config = loadConfig();
      res.json(config);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // API: update rules config
  app.put("/api/rules", (req, res) => {
    try {
      const raw = req.body;
      if (!raw || typeof raw !== "object") {
        return res.status(400).json({ error: "Invalid rules config" });
      }
      if (!Array.isArray(raw.routes)) {
        return res.status(400).json({ error: "routes must be an array" });
      }
      if (raw.confidence_floor_for_any_downgrade !== undefined && typeof raw.confidence_floor_for_any_downgrade !== "number") {
        return res.status(400).json({ error: "confidence_floor_for_any_downgrade must be a number" });
      }
      if (raw.log_retention_days !== undefined && typeof raw.log_retention_days !== "number") {
        return res.status(400).json({ error: "log_retention_days must be a number" });
      }
      if (raw.log_request_bodies !== undefined && typeof raw.log_request_bodies !== "boolean") {
        return res.status(400).json({ error: "log_request_bodies must be a boolean" });
      }
      for (const route of raw.routes) {
        if (!route.when || typeof route.when.task_type !== "string") {
          return res.status(400).json({ error: "Each route must have a when.task_type string" });
        }
        if (route.use) {
          if (route.use.model && typeof route.use.model !== "string") {
            return res.status(400).json({ error: "use.model must be a string" });
          }
          if (route.use.effort && typeof route.use.effort !== "string") {
            return res.status(400).json({ error: "use.effort must be a string" });
          }
        }
        if (route.never_downgrade !== undefined && typeof route.never_downgrade !== "boolean") {
          return res.status(400).json({ error: "never_downgrade must be a boolean" });
        }
      }
      const yamlStr = serializeRulesYaml(raw);
      fs.writeFileSync(RULES_PATH, yamlStr, "utf-8");
      invalidateCache();
      res.json({ ok: true, message: "Rules saved. Restart Claude Code session for changes to take effect." });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // API: proxy status
  app.get("/api/status", (_req, res) => {
    const config = loadConfig();
    res.json({
      running: true,
      port: parseInt(process.env.PROMPTBUS_PORT ?? "4701", 10),
      enabled: config.enabled,
      default_model: config.default_model,
      confidence_floor: config.confidence_floor_for_any_downgrade,
      log_retention_days: config.log_retention_days ?? 90,
      log_request_bodies: config.log_request_bodies ?? false,
    });
  });

  // API: toggle enabled/disabled
  app.put("/api/config", (req, res) => {
    try {
      if (typeof req.body !== "object" || req.body === null) {
        return res.status(400).json({ error: "Request body must be an object" });
      }
      const { enabled } = req.body;
      if (enabled !== undefined && typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled must be a boolean" });
      }
      const config = loadConfig();
      config.enabled = enabled ?? config.enabled;
      const yamlStr = serializeRulesYaml(config);
      fs.writeFileSync(RULES_PATH, yamlStr, "utf-8");
      invalidateCache();
      res.json({ ok: true, message: "Config saved. Restart Claude Code session for changes to take effect." });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return app;
}

function serializeRulesYaml(config: RulesConfig): string {
  const obj: Record<string, unknown> = {
    version: config.version,
    enabled: config.enabled ?? true,
    default_model: config.default_model,
    routes: config.routes.map((r) => {
      const entry: Record<string, unknown> = {};
      if (r.when) {
        entry.when = { task_type: r.when.task_type };
        if (r.when.min_confidence !== undefined) {
          (entry.when as Record<string, unknown>).min_confidence = r.when.min_confidence;
        }
      }
      if (r.never_downgrade) {
        entry.never_downgrade = true;
      } else if (r.use) {
        entry.use = {};
        if (r.use.model) (entry.use as Record<string, unknown>).model = r.use.model;
        if (r.use.effort) (entry.use as Record<string, unknown>).effort = r.use.effort;
      }
      return entry;
    }),
    confidence_floor_for_any_downgrade: config.confidence_floor_for_any_downgrade,
    log_retention_days: config.log_retention_days ?? 90,
    log_request_bodies: config.log_request_bodies ?? false,
    pricing: {} as Record<string, { input_per_mtok: number; output_per_mtok: number }>,
  };
  for (const [model, pricing] of Object.entries(config.pricing) as [string, PricingEntry][]) {
    (obj.pricing as Record<string, { input_per_mtok: number; output_per_mtok: number }>)[model] = {
      input_per_mtok: pricing.input_per_mtok,
      output_per_mtok: pricing.output_per_mtok,
    };
  }
  return yaml.dump(obj, { lineWidth: 120, noRefs: true });
}

export function startDashboard(port = 4702): void {
  const app = createApp();
  const server = app.listen(port, "127.0.0.1");
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[dashboard] Port ${port} is already in use. Is PromptBus already running?`);
    } else {
      console.error(`[dashboard error] ${err.message}`);
    }
  });
  server.on("listening", () => {
    console.error(`[dashboard] listening on http://127.0.0.1:${port}`);
  });
}
