import http from "node:http";
import https from "node:https";
import { exit } from "node:process";
import { handleRequest, type ParsedRequest } from "./handler.js";
import type { RoutingDecision } from "../rules_engine/rules_engine.js";
import { loadConfig } from "../rules_engine/rules_engine.js";
import type { PricingEntry } from "../rules_engine/rules_engine.js";
import { insertLog, closeDb } from "../logger/logger.js";

const ANTHROPIC_HOST = "api.anthropic.com";
const HOST = "127.0.0.1";

function getPricing(): Record<string, PricingEntry> {
  try {
    return loadConfig().pricing;
  } catch {
    return {};
  }
}

function calcCostSaved(originalModel: string, routedModel: string, inputTokens: number): number {
  const pricing = getPricing();
  const origPrice = pricing[originalModel];
  const routePrice = pricing[routedModel];
  if (!origPrice || !routePrice) return 0;
  const origCost = (inputTokens / 1_000_000) * origPrice.input_per_mtok;
  const routeCost = (inputTokens / 1_000_000) * routePrice.input_per_mtok;
  return Math.max(0, origCost - routeCost);
}

export function createProxyHandler() {
  return (
    clientReq: http.IncomingMessage,
    _clientRes: http.ServerResponse,
    parsed: ParsedRequest | null,
    taskType: string,
    confidence: number,
    status: number,
    latencyMs: number,
    decision?: RoutingDecision,
    bodyToForward?: string,
    outputTokens?: number,
  ) => {
    const model = parsed?.model ?? "(unknown)";
    const action = decision?.downgraded ? `DOWNGRADE->${decision.model}` : "pass-through";

    console.error(
      `[request] ${clientReq.method} ${clientReq.url} -> ${status} | model=${model} stream=${parsed?.stream ?? false} msgs=${parsed?.messageCount ?? "?"} tools=${parsed?.hasTools ?? "?"} tok=${parsed?.estimatedTokens ?? "?"} class=${taskType} conf=${confidence}% ${action} ${latencyMs}ms`,
    );

    const modelUsed = decision?.model ?? model;
    const downgraded = decision?.downgraded ?? false;
    const tokens = parsed?.estimatedTokens ?? 0;
    const costSaved = downgraded ? calcCostSaved(model, modelUsed, tokens) : 0;
    const isStream = parsed?.stream ?? false;
    const reason = decision?.reason ?? "";

    let loggedBody: string | null = null;
    try {
      const config = loadConfig();
      if (config.log_request_bodies && bodyToForward) {
        loggedBody = bodyToForward;
      }
    } catch {}

    insertLog({
      timestamp: new Date().toISOString(),
      model_requested: model,
      task_type: taskType,
      model_used: modelUsed,
      effort: decision?.effort ?? null,
      stream: isStream,
      estimated_input_tokens: tokens,
      estimated_output_tokens: outputTokens ?? null,
      estimated_cost_saved: costSaved,
      latency_ms: latencyMs,
      upstream_status: status,
      downgraded,
      reason,
      request_body: loggedBody,
    });
  };
}

export function startProxy(port = 4701): void {
  const handler = createProxyHandler();
  const server = http.createServer();

  server.on("request", (clientReq, clientRes) => {
    handleRequest(clientReq, clientRes, (parsed, taskType, confidence, status, latencyMs, decision, bodyToForward, outputTokens) => {
      handler(clientReq, clientRes, parsed, taskType, confidence, status, latencyMs, decision, bodyToForward, outputTokens);
    });
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[proxy] Port ${port} is already in use. Is PromptBus already running?`);
    } else {
      console.error(`[proxy error] ${err.message}`);
    }
  });

  server.on("listening", () => {
    console.error(`[proxy] listening on http://${HOST}:${port}`);
    console.error(`[proxy] upstream: https://${ANTHROPIC_HOST}`);

    const req = https.get(`https://${ANTHROPIC_HOST}/`, (res) => {
      console.error(`[proxy] upstream check: ${ANTHROPIC_HOST} responded ${res.statusCode}`);
      res.resume();
    });
    req.on("error", (err: Error) => {
      console.error(`[proxy] upstream unreachable: ${err.message}`);
    });
    req.end();
  });

  server.listen(port, HOST);

  process.on("SIGINT", () => {
    console.error("\n[proxy] shutting down...");
    closeDb();
    exit(0);
  });
  process.on("SIGTERM", () => {
    console.error("\n[proxy] shutting down...");
    closeDb();
    exit(0);
  });
}


