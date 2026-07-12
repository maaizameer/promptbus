import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as yaml from "js-yaml";
import type { TaskProfile, TaskType } from "../classifier/classifier.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = path.resolve(__dirname, "../../../config");
const RULES_PATH = path.join(CONFIG_DIR, "rules.yaml");

export interface UseOverride {
  model?: string;
  effort?: string;
}

export interface RouteRule {
  when: {
    task_type: TaskType;
    min_confidence?: number;
  };
  use?: UseOverride;
  never_downgrade?: boolean;
}

export interface PricingEntry {
  input_per_mtok: number;
  output_per_mtok: number;
}

export interface RulesConfig {
  version: number;
  enabled: boolean;
  default_model: string;
  routes: RouteRule[];
  confidence_floor_for_any_downgrade: number;
  pricing: Record<string, PricingEntry>;
  log_retention_days?: number;
  log_request_bodies?: boolean;
}

export interface RoutingDecision {
  model: string;
  effort: string | undefined;
  downgraded: boolean;
  reason: string;
  matched_rule: string;
}

let cachedConfig: RulesConfig | null = null;

export function loadConfig(): RulesConfig {
  if (cachedConfig) return cachedConfig;
  const raw = fs.readFileSync(RULES_PATH, "utf-8");
  cachedConfig = yaml.load(raw) as RulesConfig;
  return cachedConfig;
}

export function invalidateCache(): void {
  cachedConfig = null;
}

export function route(task: TaskProfile, originalModel: string): RoutingDecision {
  const config = loadConfig();

  if (!config.enabled) {
    return {
      model: originalModel,
      effort: undefined,
      downgraded: false,
      reason: "PromptBus is disabled in config",
      matched_rule: "disabled",
    };
  }

  // Global confidence floor: never downgrade below this confidence
  if (task.confidence < config.confidence_floor_for_any_downgrade) {
    return {
      model: originalModel,
      effort: undefined,
      downgraded: false,
      reason: `Confidence ${Math.round(task.confidence * 100)}% < floor ${Math.round(config.confidence_floor_for_any_downgrade * 100)}%`,
      matched_rule: "confidence_floor",
    };
  }

  // Find matching route
  const route = config.routes.find((r) => {
    if (r.when.task_type !== task.task_type) return false;
    if (r.when.min_confidence !== undefined && task.confidence < r.when.min_confidence) return false;
    return true;
  });

  if (!route) {
    return {
      model: originalModel,
      effort: undefined,
      downgraded: false,
      reason: `No matching route for ${task.task_type}`,
      matched_rule: "none",
    };
  }

  // never_downgrade always wins
  if (route.never_downgrade) {
    return {
      model: originalModel,
      effort: undefined,
      downgraded: false,
      reason: `Rule for ${task.task_type} has never_downgrade: true`,
      matched_rule: `${task.task_type}__never_downgrade`,
    };
  }

  if (route.use) {
    const decision: RoutingDecision = {
      model: route.use.model ?? originalModel,
      effort: route.use.effort,
      downgraded: true,
      reason: `Routed ${task.task_type} -> ${route.use.model}${route.use.effort ? ` effort=${route.use.effort}` : ""}`,
      matched_rule: `${task.task_type}__use`,
    };

    // If the target model happens to be the same as original, mark as not downgraded
    if (decision.model === originalModel && !decision.effort) {
      decision.downgraded = false;
    }

    return decision;
  }

  // Route matched but has no use and no never_downgrade
  return {
    model: originalModel,
    effort: undefined,
    downgraded: false,
    reason: `Route matched ${task.task_type} but no action defined`,
    matched_rule: `${task.task_type}__noop`,
  };
}
