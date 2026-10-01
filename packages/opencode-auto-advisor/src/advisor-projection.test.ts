import { describe, expect, test } from "bun:test";
import {
  ADVISOR_OMISSION_MARKER,
  buildAdvisorProjection,
  estimateTokens,
} from "./advisor-projection.js";
import { buildAdvisorPrompt } from "./advisor-service.js";
import { computeInputBudget } from "./model-limits.js";
import { type SerializedEntry, serializeAdvisorContext } from "./serialize.js";

const entries: readonly SerializedEntry[] = [
  { role: "system", text: "HOOK-ONLY-SYSTEM" },
  { role: "user", text: "HOOK-USER" },
  {
    role: "assistant",
    agent: "build",
    model: "opencode/jev-1.13",
    inFlight: true,
    blocks: [
      { type: "text", text: "CURRENT-DELTA" },
      { type: "tool-call", id: "call_advisor", name: "advisor", status: "running", input: {} },
    ],
  },
];

describe("buildAdvisorProjection", () => {
  test("projects the full canonical transcript for the Advisor consultation", () => {
    expect(buildAdvisorProjection(entries).transcript).toBe(serializeAdvisorContext(entries));
  });

  test("keeps the transcript deterministic for identical canonical state", () => {
    expect(buildAdvisorProjection(entries).transcript).toBe(
      buildAdvisorProjection([...entries]).transcript,
    );
  });

  test("builds no diagnostics without a budget (explicit path stays unbounded)", () => {
    expect(buildAdvisorProjection(entries).diagnostics).toBeUndefined();
  });
});

const system = (text: string): SerializedEntry => ({ role: "system", text });
const user = (text: string): SerializedEntry => ({ role: "user", text });
const assistantWith = (text: string, inFlight: boolean): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight,
  blocks: [{ type: "text", text }],
});
const history = (index: number): SerializedEntry =>
  user(`OLD-HISTORY-${index}-${"x".repeat(2000)}`);
const compaction: SerializedEntry = {
  role: "compaction",
  status: "completed",
  reason: "auto",
  summary: "COMPACTION-SUMMARY",
};

const systemEntry = system("SYSTEM-CONSTRAINTS");
const currentUser = user("CURRENT-TASK");
const currentAssistant: SerializedEntry = {
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight: true,
  blocks: [
    { type: "text", text: "CURRENT-DELTA" },
    {
      type: "tool-result",
      id: "call_read",
      name: "read",
      text: `TOOL-DATA-${"y".repeat(200)}-END`,
    },
  ],
};
const state: readonly SerializedEntry[] = [
  systemEntry,
  history(0),
  history(1),
  compaction,
  history(2),
  currentUser,
  currentAssistant,
];

const promptTokens = (selected: readonly SerializedEntry[]) =>
  estimateTokens(buildAdvisorPrompt(serializeAdvisorContext(selected)));

describe("buildAdvisorProjection budget fitting", () => {
  test("keeps the full transcript when everything fits the budget", () => {
    const budget = promptTokens(state);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });

    expect(projection.transcript).toBe(serializeAdvisorContext(state));
    expect(projection.transcript).not.toContain(ADVISOR_OMISSION_MARKER);
    expect(projection.diagnostics).toEqual({
      complete: true,
      omittedEntries: 0,
      includedEntries: state.length,
      estimatedTokens: budget,
      inputBudget: budget,
    });
  });

  test("drops the oldest history first and keeps the current turn", () => {
    const kept: readonly SerializedEntry[] = [
      systemEntry,
      compaction,
      currentUser,
      currentAssistant,
    ];
    const budget = promptTokens(kept) + 200;
    expect(budget).toBeLessThan(promptTokens(state));

    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const transcript = projection.transcript;

    expect(transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(transcript).toContain("COMPACTION-SUMMARY");
    expect(transcript).toContain("CURRENT-TASK");
    expect(transcript).toContain("CURRENT-DELTA");
    expect(transcript).not.toContain("OLD-HISTORY");
    expect(transcript).toContain(ADVISOR_OMISSION_MARKER);
    expect(projection.diagnostics).toEqual({
      complete: false,
      omittedEntries: 3,
      includedEntries: kept.length,
      estimatedTokens: promptTokens([
        { role: "marker", type: "context-omitted", detail: ADVISOR_OMISSION_MARKER },
        ...kept,
      ]),
      inputBudget: budget,
    });
  });

  test("keeps every included entry complete and structured", () => {
    const budget = promptTokens(state) - 300;
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const parsed = JSON.parse(projection.transcript) as readonly SerializedEntry[];

    expect(Array.isArray(parsed)).toBe(true);
    for (const entry of parsed) {
      expect(entry).toBeObject();
      expect(typeof entry.role).toBe("string");
    }
    const toolEntry = parsed.find(
      (entry) => entry.role === "assistant" && JSON.stringify(entry).includes("TOOL-DATA"),
    );
    expect(toolEntry).toBeDefined();
    expect(JSON.stringify(toolEntry)).toContain(`TOOL-DATA-${"y".repeat(200)}-END`);
  });

  test("drops lower-priority entries before the current user turn", () => {
    const kept: readonly SerializedEntry[] = [systemEntry, currentUser, currentAssistant];
    const budget = promptTokens(kept);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const transcript = projection.transcript;

    expect(transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(transcript).toContain("CURRENT-TASK");
    expect(transcript).toContain("CURRENT-DELTA");
    expect(transcript).not.toContain("COMPACTION-SUMMARY");
    expect(transcript).not.toContain("OLD-HISTORY");
  });

  test("drops the current assistant state before the current user turn", () => {
    const kept: readonly SerializedEntry[] = [systemEntry, currentUser];
    const budget = promptTokens(kept);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const transcript = projection.transcript;

    expect(transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(transcript).toContain("CURRENT-TASK");
    expect(transcript).not.toContain("CURRENT-DELTA");
    expect(transcript).not.toContain("COMPACTION-SUMMARY");
    expect(transcript).not.toContain("OLD-HISTORY");
    expect(projection.diagnostics?.omittedEntries).toBe(state.length - kept.length);
  });

  test("prioritizes the tail assistant state when the turn has no user entry", () => {
    const tail = assistantWith("CURRENT-ASSISTANT-STATE", true);
    const older = assistantWith(`OLD-ASSISTANT-${"x".repeat(2000)}`, false);
    const budget = promptTokens([tail]);
    const projection = buildAdvisorProjection([older, tail], { inputBudget: budget });

    expect(projection.transcript).toContain("CURRENT-ASSISTANT-STATE");
    expect(projection.transcript).not.toContain("OLD-ASSISTANT");
    expect(projection.diagnostics?.omittedEntries).toBe(1);
  });

  test("keeps the marker alone when nothing else fits", () => {
    const projection = buildAdvisorProjection(state, { inputBudget: 1 });
    const parsed = JSON.parse(projection.transcript) as readonly SerializedEntry[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({
      role: "marker",
      type: "context-omitted",
      detail: ADVISOR_OMISSION_MARKER,
    });
    expect(projection.diagnostics?.complete).toBe(false);
    expect(projection.diagnostics?.omittedEntries).toBe(state.length);
  });

  test("fits a small-context Advisor with a reduced transcript instead of rejecting", () => {
    const budget = computeInputBudget({ context: 2000, output: 1500 });
    expect(budget).toBe(500);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });

    expect(projection.diagnostics?.complete).toBe(false);
    expect(projection.diagnostics?.omittedEntries).toBeGreaterThan(0);
    expect(projection.transcript).toContain("CURRENT-TASK");
    expect(projection.transcript).not.toContain("OLD-HISTORY");
  });

  test("handles an empty state under a budget", () => {
    const projection = buildAdvisorProjection([], { inputBudget: 150_000 });

    expect(projection.transcript).toBe("[]");
    expect(projection.diagnostics).toEqual({
      complete: true,
      omittedEntries: 0,
      includedEntries: 0,
      estimatedTokens: promptTokens([]),
      inputBudget: 150_000,
    });
  });
});

describe("estimateTokens", () => {
  test("pins the deterministic character-per-token heuristic", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("a")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(1);
    expect(estimateTokens("abcdef")).toBe(2);
    expect(estimateTokens("x".repeat(400))).toBe(100);
  });
});
