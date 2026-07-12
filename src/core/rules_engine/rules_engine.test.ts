import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, invalidateCache, route } from "./rules_engine.js";
import type { TaskProfile } from "../classifier/classifier.js";

beforeEach(() => {
  invalidateCache();
});

function profile(overrides: Partial<TaskProfile> & { task_type: TaskProfile["task_type"] }): TaskProfile {
  return {
    confidence: 0.8,
    signals: {
      prompt_length_tokens: 50,
      num_files_in_context: 0,
      num_tool_calls_so_far_in_turn: 0,
      contains_keywords: [],
      is_followup_in_long_session: false,
      prior_turn_used_extended_thinking: false,
    },
    ...overrides,
  };
}

describe("loadConfig", () => {
  it("loads and caches the config", () => {
    const config = loadConfig();
    expect(config.version).toBe(1);
    expect(config.enabled).toBe(true);
    expect(config.default_model).toBeTruthy();
    expect(Array.isArray(config.routes)).toBe(true);
    expect(config.pricing).toBeTruthy();
  });

  it("returns cached config on subsequent calls", () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it("reloads after invalidateCache", () => {
    const a = loadConfig();
    invalidateCache();
    const b = loadConfig();
    expect(a).not.toBe(b);
  });
});

describe("route", () => {
  it("respects confidence floor (confidence too low)", () => {
    const result = route(profile({ task_type: "small_edit", confidence: 0.1 }), "claude-sonnet-5");
    expect(result.matched_rule).toBe("confidence_floor");
    expect(result.downgraded).toBe(false);
    expect(result.model).toBe("claude-sonnet-5");
  });

  it("routes read_explain to haiku with low effort", () => {
    const result = route(profile({ task_type: "read_explain" }), "claude-sonnet-5");
    expect(result.downgraded).toBe(true);
    expect(result.model).toBe("claude-haiku-4-5");
    expect(result.effort).toBe("low");
  });

  it("respects never_downgrade for multi_file_refactor", () => {
    const result = route(profile({ task_type: "multi_file_refactor" }), "claude-sonnet-5");
    expect(result.downgraded).toBe(false);
    expect(result.matched_rule).toContain("never_downgrade");
  });

  it("respects never_downgrade for planning", () => {
    const result = route(profile({ task_type: "planning" }), "claude-sonnet-5");
    expect(result.downgraded).toBe(false);
    expect(result.matched_rule).toContain("never_downgrade");
  });

  it("respects never_downgrade for debug_loop", () => {
    const result = route(profile({ task_type: "debug_loop" }), "claude-sonnet-5");
    expect(result.downgraded).toBe(false);
    expect(result.matched_rule).toContain("never_downgrade");
  });

  it("routes test_generation to sonnet with medium effort", () => {
    const result = route(profile({ task_type: "test_generation" }), "claude-sonnet-5");
    expect(result.model).toBe("claude-sonnet-5");
    expect(result.effort).toBe("medium");
  });

  it("returns never_downgrade for unknown task type", () => {
    const result = route(profile({ task_type: "unknown" }), "claude-sonnet-5");
    expect(result.matched_rule).toContain("never_downgrade");
  });

  it("fills reason field on routing decision", () => {
    const result = route(profile({ task_type: "read_explain" }), "claude-sonnet-5");
    expect(result.reason).toBeTruthy();
    expect(result.reason).toContain("read_explain");
  });
});
