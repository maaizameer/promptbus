import { describe, it, expect } from "vitest";
import { classify } from "./classifier.js";

function makeRequest(text: string, extra?: Record<string, unknown>): string {
  return JSON.stringify({
    model: "claude-sonnet-5",
    messages: [{ role: "user", content: text }],
    ...extra,
  });
}

function makeMultiTurnRequest(turns: { role: string; content: unknown }[]): string {
  return JSON.stringify({
    model: "claude-sonnet-5",
    messages: turns,
  });
}

describe("classify", () => {
  describe("task type detection", () => {
    it("classifies read_explain for brief read-only queries", () => {
      const result = classify(makeRequest("explain what this function does"));
      expect(result.task_type).toBe("read_explain");
      expect(result.confidence).toBeGreaterThanOrEqual(0.7);
    });

    it("classifies multi_file_refactor for refactor keywords", () => {
      const result = classify(makeRequest("refactor the authentication module across the codebase"));
      expect(result.task_type).toBe("multi_file_refactor");
    });

    it("classifies planning for planning keywords", () => {
      const result = classify(makeRequest("what should i do to design the new payment system"));
      expect(result.task_type).toBe("planning");
    });

    it("classifies debug_loop for debug keywords", () => {
      const result = classify(makeRequest("fix this bug in the login handler"));
      expect(result.task_type).toBe("debug_loop");
    });

    it("classifies test_generation for test keywords", () => {
      const result = classify(makeRequest("write unit tests for the API routes"));
      expect(result.task_type).toBe("test_generation");
    });

    it("classifies small_edit for short edit prompts", () => {
      const result = classify(makeRequest("add input validation to the form"));
      expect(result.task_type).toBe("small_edit");
    });

    it("falls back to unknown for ambiguous prompts", () => {
      const result = classify(makeRequest("hello world"));
      expect(result.task_type).toBe("unknown");
      expect(result.confidence).toBe(0.3);
    });
  });

  describe("signals", () => {
    it("populates num_tool_calls_so_far_in_turn", () => {
      const body = makeMultiTurnRequest([
        { role: "user", content: "write a test" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Let me check the code" },
            { type: "tool_use", name: "grep", input: { pattern: "test" } },
            { type: "tool_use", name: "read", input: { path: "file.ts" } },
          ],
        },
        { role: "user", content: "fix this bug" },
      ]);
      const result = classify(body);
      expect(result.signals.num_tool_calls_so_far_in_turn).toBe(2);
    });

    it("populates is_followup_in_long_session when multiple user messages exist", () => {
      const body = makeMultiTurnRequest([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
        { role: "user", content: "explain this code" },
      ]);
      const result = classify(body);
      expect(result.signals.is_followup_in_long_session).toBe(true);
    });

    it("sets is_followup_in_long_session false for single turn", () => {
      const result = classify(makeRequest("explain this code"));
      expect(result.signals.is_followup_in_long_session).toBe(false);
    });

    it("populates prior_turn_used_extended_thinking when assistant used thinking", () => {
      const body = makeMultiTurnRequest([
        { role: "user", content: "solve this problem" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Let me reason step by step..." },
            { type: "text", text: "Here is the solution" },
          ],
        },
        { role: "user", content: "explain it more" },
      ]);
      const result = classify(body);
      expect(result.signals.prior_turn_used_extended_thinking).toBe(true);
    });

    it("populates num_files_in_context when documents tag present", () => {
      const body = makeRequest("update this code <documents>some code</documents>");
      const result = classify(body);
      expect(result.signals.num_files_in_context).toBeGreaterThan(0);
    });

    it("extracts prompt_length_tokens from user text", () => {
      const result = classify(makeRequest("hello world"));
      expect(result.signals.prompt_length_tokens).toBeGreaterThan(0);
    });

    it("populates contains_keywords with matched keywords", () => {
      const result = classify(makeRequest("fix this bug and explain the error"));
      expect(result.signals.contains_keywords.length).toBeGreaterThan(0);
      expect(result.signals.contains_keywords).toContain("fix");
      expect(result.signals.contains_keywords).toContain("bug");
    });
  });

  describe("edge cases", () => {
    it("handles empty body", () => {
      const result = classify("");
      expect(result.task_type).toBe("unknown");
    });

    it("handles non-JSON body", () => {
      const result = classify("not json");
      expect(result.task_type).toBe("unknown");
    });

    it("handles null body", () => {
      const result = classify("null");
      expect(result.task_type).toBe("unknown");
    });

    it("handles messages with array content format", () => {
      const body = JSON.stringify({
        model: "claude-sonnet-5",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "explain what a closure is" }],
          },
        ],
      });
      const result = classify(body);
      expect(result.task_type).toBe("read_explain");
    });

    it("handles confidence for refactor with short prompt", () => {
      const result = classify(makeRequest("refactor this"));
      expect(result.task_type).toBe("multi_file_refactor");
      expect(result.confidence).toBe(0.6);
    });

    it("handles confidence for refactor with long prompt", () => {
      const result = classify(makeRequest("refactor the entire authentication module " + "x".repeat(200)));
      expect(result.task_type).toBe("multi_file_refactor");
      expect(result.confidence).toBe(0.8);
    });
  });
});
