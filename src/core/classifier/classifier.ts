export type TaskType =
  | "read_explain"
  | "small_edit"
  | "multi_file_refactor"
  | "planning"
  | "debug_loop"
  | "test_generation"
  | "unknown";

export interface Signals {
  prompt_length_tokens: number;
  num_files_in_context: number;
  num_tool_calls_so_far_in_turn: number;
  contains_keywords: string[];
  is_followup_in_long_session: boolean;
  prior_turn_used_extended_thinking: boolean;
}

export interface TaskProfile {
  task_type: TaskType;
  signals: Signals;
  confidence: number;
}

const READ_KEYWORDS = [
  "explain", "what does", "summarize", "describe", "how does",
  "why does", "what is", "tell me about", "understand", "meaning",
];

const EDIT_KEYWORDS = [
  "fix", "change", "update", "modify", "edit", "add", "remove",
  "delete", "rename", "implement", "write", "create",
];

const REFACTOR_KEYWORDS = [
  "refactor", "architecture", "migrate", "across the codebase",
  "restructure", "redesign", "rewrite", "reorganize",
];

const PLANNING_KEYWORDS = [
  "plan", "design", "architecture", "strategy", "approach",
  "how should i", "what should i", "proposal",
];

const DEBUG_KEYWORDS = [
  "debug", "bug", "fix bug", "error", "crash", "not working",
  "issue", "problem", "broken", "fails", "failed",
];

const TEST_KEYWORDS = [
  "test", "unit test", "integration test", "spec", "testing",
  "coverage", "assert",
];

function extractMessages(body: string): Record<string, unknown>[] {
  try {
    const json = JSON.parse(body);
    return (Array.isArray(json.messages) ? json.messages : []) as Record<string, unknown>[];
  } catch {
    return [];
  }
}

function extractTextContent(msg: Record<string, unknown>): string {
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((c: Record<string, unknown>) => c.type === "text")
      .map((c: Record<string, unknown>) => c.text)
      .join(" ");
  }
  return "";
}

function countBlocks(messages: Record<string, unknown>[], role: string, blockType: string): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== role) continue;
    const content = msg.content;
    if (Array.isArray(content)) {
      count += content.filter((c: Record<string, unknown>) => c.type === blockType).length;
    }
  }
  return count;
}

function extractLastUserMessage(body: string): string {
  const messages = extractMessages(body);
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      return extractTextContent(messages[i]);
    }
  }
  return "";
}

function keywordMatch(text: string, keywords: string[]): string[] {
  const lower = text.toLowerCase();
  return keywords.filter((kw) => lower.includes(kw));
}

export function classify(body: string): TaskProfile {
  const messages = extractMessages(body);
  const text = extractLastUserMessage(body);
  const promptLengthTokens = Math.ceil(text.length / 4);
  const readKeywords = keywordMatch(text, READ_KEYWORDS);
  const editKeywords = keywordMatch(text, EDIT_KEYWORDS);
  const refactorKeywords = keywordMatch(text, REFACTOR_KEYWORDS);
  const planningKeywords = keywordMatch(text, PLANNING_KEYWORDS);
  const debugKeywords = keywordMatch(text, DEBUG_KEYWORDS);
  const testKeywords = keywordMatch(text, TEST_KEYWORDS);

  const allKeywords = [
    ...readKeywords,
    ...editKeywords,
    ...refactorKeywords,
    ...planningKeywords,
    ...debugKeywords,
    ...testKeywords,
  ];

  const userMessages = messages.filter((m) => m.role === "user");
  const hasFilesInContext = userMessages.some((m) => {
    const content = extractTextContent(m);
    return content.includes("<documents>") || content.includes("<document ") || /\n\/\/ File: /.test(content);
  });
  const numToolCalls = countBlocks(messages, "assistant", "tool_use");
  const hasThinking = countBlocks(messages, "assistant", "thinking") > 0;

  const signals: Signals = {
    prompt_length_tokens: promptLengthTokens,
    num_files_in_context: hasFilesInContext ? userMessages.length : 0,
    num_tool_calls_so_far_in_turn: numToolCalls,
    contains_keywords: allKeywords,
    is_followup_in_long_session: userMessages.length > 1,
    prior_turn_used_extended_thinking: hasThinking,
  };

  // Brief + read-only keywords + no edit keywords => read_explain
  if (promptLengthTokens < 100 && readKeywords.length >= 1 && editKeywords.length === 0) {
    return { task_type: "read_explain", signals, confidence: 0.8 };
  }

  // Refactor keywords strongly suggest multi-file work
  if (refactorKeywords.length >= 1) {
    const confidence = promptLengthTokens > 50 ? 0.8 : 0.6;
    return { task_type: "multi_file_refactor", signals, confidence };
  }

  // Planning keywords
  if (planningKeywords.length >= 1) {
    return { task_type: "planning", signals, confidence: 0.7 };
  }

  // Debug keywords
  if (debugKeywords.length >= 1) {
    return { task_type: "debug_loop", signals, confidence: 0.7 };
  }

  // Test keywords
  if (testKeywords.length >= 1) {
    return { task_type: "test_generation", signals, confidence: 0.6 };
  }

  // Short-ish prompt with edit keywords → small_edit
  if (editKeywords.length >= 1 && promptLengthTokens < 200) {
    return { task_type: "small_edit", signals, confidence: 0.6 };
  }

  // Fallback: unknown
  return { task_type: "unknown", signals, confidence: 0.3 };
}
