import http from "node:http";
import https from "node:https";
import { PassThrough } from "node:stream";
import { classify } from "../classifier/classifier.js";
import { route, invalidateCache, loadConfig } from "../rules_engine/rules_engine.js";
import type { RoutingDecision } from "../rules_engine/rules_engine.js";

const ANTHROPIC_HOST = "api.anthropic.com";

export interface ParsedRequest {
  model: string | null;
  hasTools: boolean;
  messageCount: number;
  stream: boolean;
  estimatedTokens: number;
  rawBody: string;
}

export type LogFn = (
  parsed: ParsedRequest | null,
  taskType: string,
  confidence: number,
  upstreamStatus: number,
  latencyMs: number,
  decision?: RoutingDecision,
  bodyToForward?: string,
  outputTokens?: number,
) => void;

export function handleRequest(
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  logCallback?: LogFn,
): void {
  const startTime = Date.now();
  const chunks: Buffer[] = [];

  clientReq.on("data", (chunk: Buffer) => chunks.push(chunk));
  clientReq.on("end", () => {
    const rawBody = Buffer.concat(chunks).toString("utf-8");
    const parsed = parseRequestBody(rawBody);

    let taskType = "unknown";
    let confidence = 0;
    let decision: RoutingDecision | undefined;
    let bodyToForward = rawBody;

    if (rawBody && rawBody !== "null" && rawBody !== "undefined") {
      try {
        const profile = classify(rawBody);
        taskType = profile.task_type;
        confidence = Math.round(profile.confidence * 100);

        decision = route(profile, parsed?.model ?? configDefaultModel());

        if (decision.downgraded) {
          bodyToForward = rewriteBody(rawBody, decision);
        }
      } catch (err) {
        console.error(`[safety] Routing error, forwarding unchanged: ${String(err)}`);
        bodyToForward = rawBody;
      }
    }

    const upstreamPath = clientReq.url ?? "/";
    const upstreamHeaders = { ...clientReq.headers };
    delete upstreamHeaders.host;

    // Log a redacted fingerprint of the auth header (last-4 chars only — never the full value)
    const rawAuth = upstreamHeaders["x-api-key"] ?? upstreamHeaders["authorization"];
    if (rawAuth) {
      const authStr = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
      const fingerprint = authStr.length > 4 ? `****${authStr.slice(-4)}` : "****";
      console.error(`[auth] credential fingerprint: ${fingerprint}`);
    }

    // Update content-length if body changed
    if (bodyToForward !== rawBody) {
      upstreamHeaders["content-length"] = String(Buffer.byteLength(bodyToForward));
    }

    const upstreamReq = https.request(
      {
        hostname: ANTHROPIC_HOST,
        path: upstreamPath,
        method: clientReq.method,
        headers: upstreamHeaders,
        port: 443,
        rejectUnauthorized: true,
      },
      (upstreamRes) => {
        const latencyMs = Date.now() - startTime;
        clientRes.writeHead(upstreamRes.statusCode ?? 500, upstreamRes.headers);

        const counter = new PassThrough();
        let responseBytes = 0;
        counter.on("data", (chunk: Buffer) => { responseBytes += chunk.length; });
        counter.on("end", () => {
          const outputTokens = Math.ceil(responseBytes / 4);
          logCallback?.(parsed, taskType, confidence, upstreamRes.statusCode ?? 500, latencyMs, decision, bodyToForward, outputTokens);
        });

        upstreamRes.pipe(counter).pipe(clientRes);
      },
    );

    upstreamReq.on("error", (err: Error) => {
      console.error(`[upstream error] ${err.message}`);
      if (!clientRes.headersSent) {
        clientRes.writeHead(502, { "content-type": "text/plain" });
        clientRes.end(`Bad Gateway: ${err.message}`);
      }
    });

    if (bodyToForward) {
      upstreamReq.write(bodyToForward);
    }
    upstreamReq.end();
  });

  clientReq.on("error", (err: Error) => {
    console.error(`[client error] ${err.message}`);
    if (!clientRes.headersSent) {
      clientRes.writeHead(400, { "content-type": "text/plain" });
      clientRes.end(`Bad Request: ${err.message}`);
    }
  });
}

function parseRequestBody(body: string): ParsedRequest | null {
  if (!body) return null;
  try {
    const json = JSON.parse(body);
    if (!json || typeof json !== "object") return null;

    const model: string | null = json.model ?? null;
    const hasTools = Array.isArray(json.tools) && json.tools.length > 0;
    const messages = Array.isArray(json.messages) ? json.messages : [];
    const messageCount = messages.length;
    const stream = json.stream === true;

    const estimatedTokens = Math.ceil(body.length / 4);

    return { model, hasTools, messageCount, stream, estimatedTokens, rawBody: body };
  } catch {
    return null;
  }
}

function rewriteBody(body: string, decision: RoutingDecision): string {
  try {
    const json = JSON.parse(body);
    json.model = decision.model;

    if (decision.effort) {
      if (!json.output_config) {
        json.output_config = {};
      }
      json.output_config.effort = decision.effort;
    }

    return JSON.stringify(json);
  } catch {
    return body;
  }
}

function configDefaultModel(): string {
  try {
    const cfg = loadConfig();
    return cfg.default_model;
  } catch (err) {
    console.error(`[config] Failed to load config for default model: ${err}`);
    return "claude-sonnet-5";
  }
}

export function reloadRules(): void {
  invalidateCache();
}
