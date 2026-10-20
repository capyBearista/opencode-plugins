import { describe, expect, test } from "bun:test";
import {
  ADVISOR_OMISSION_MARKER,
  type AdvisorProjection,
  buildAdvisorProjection,
  estimateTokens,
} from "./advisor-projection.js";
import { buildAdvisorPrompt } from "./advisor-service.js";
import { computeInputBudget } from "./model-limits.js";
import { type SerializedEntry, serializeAdvisorContext } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";

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

const markerEntry: SerializedEntry = {
  role: "marker",
  type: "context-omitted",
  detail: ADVISOR_OMISSION_MARKER,
};

const promptTokens = (selected: readonly SerializedEntry[]) =>
  estimateTokens(buildAdvisorPrompt(serializeAdvisorContext(selected)));

const markerTokens = () => promptTokens([markerEntry]);

function expectWithinBudget(projection: AdvisorProjection, budget: number): void {
  const finalTokens = estimateTokens(buildAdvisorPrompt(projection.transcript));
  expect(finalTokens).toBeLessThanOrEqual(budget);
  expect(projection.diagnostics?.estimatedTokens).toBe(finalTokens);
}

function tryBuild(
  candidate: readonly SerializedEntry[],
  budget: number,
): AdvisorProjection | undefined {
  try {
    return buildAdvisorProjection(candidate, { inputBudget: budget });
  } catch (error) {
    expect(error).toBeInstanceOf(RangeError);
    return undefined;
  }
}

const reasoning = (text: string): AssistantBlock => ({ type: "reasoning", text });

function assistantBlockTypes(transcript: string): readonly string[] {
  const parsed = JSON.parse(transcript) as readonly SerializedEntry[];
  const entry = parsed.find((candidate) => candidate.role === "assistant");
  if (entry === undefined || !("blocks" in entry)) throw new Error("assistant entry missing");
  return entry.blocks.map((block) => block.type);
}

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
    expectWithinBudget(projection, budget);
  });

  test("omits entries and stays within the budget one token below the full fit", () => {
    const budget = promptTokens(state) - 1;
    const projection = buildAdvisorProjection(state, { inputBudget: budget });

    expect(projection.diagnostics?.complete).toBe(false);
    expect(projection.diagnostics?.omittedEntries).toBeGreaterThan(0);
    expectWithinBudget(projection, budget);
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
      estimatedTokens: promptTokens([markerEntry, ...kept]),
      inputBudget: budget,
    });
    expectWithinBudget(projection, budget);
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
    const budget = promptTokens([markerEntry, ...kept]);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const transcript = projection.transcript;

    expect(transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(transcript).toContain("CURRENT-TASK");
    expect(transcript).toContain("CURRENT-DELTA");
    expect(transcript).not.toContain("COMPACTION-SUMMARY");
    expect(transcript).not.toContain("OLD-HISTORY");
    expect(projection.diagnostics?.omittedEntries).toBe(state.length - kept.length);
    expectWithinBudget(projection, budget);
  });

  test("drops the current assistant state before the current user turn", () => {
    const kept: readonly SerializedEntry[] = [systemEntry, currentUser];
    const budget = promptTokens([markerEntry, ...kept]);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const transcript = projection.transcript;

    expect(transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(transcript).toContain("CURRENT-TASK");
    expect(transcript).not.toContain("CURRENT-DELTA");
    expect(transcript).not.toContain("COMPACTION-SUMMARY");
    expect(transcript).not.toContain("OLD-HISTORY");
    expect(projection.diagnostics?.omittedEntries).toBe(state.length - kept.length);
    expectWithinBudget(projection, budget);
  });

  test("prioritizes the tail assistant state when the turn has no user entry", () => {
    const tail = assistantWith("CURRENT-ASSISTANT-STATE", true);
    const older = assistantWith(`OLD-ASSISTANT-${"x".repeat(2000)}`, false);
    const budget = promptTokens([markerEntry, tail]);
    const projection = buildAdvisorProjection([older, tail], { inputBudget: budget });

    expect(projection.transcript).toContain("CURRENT-ASSISTANT-STATE");
    expect(projection.transcript).not.toContain("OLD-ASSISTANT");
    expect(projection.diagnostics?.omittedEntries).toBe(1);
    expectWithinBudget(projection, budget);
  });

  test("keeps the marker alone when nothing else fits", () => {
    const budget = markerTokens();
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const parsed = JSON.parse(projection.transcript) as readonly SerializedEntry[];

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual(markerEntry);
    expect(projection.diagnostics?.complete).toBe(false);
    expect(projection.diagnostics?.omittedEntries).toBe(state.length);
    expectWithinBudget(projection, budget);
  });

  test("adds the omission marker only when entries are dropped", () => {
    const full = buildAdvisorProjection(state, { inputBudget: promptTokens(state) });
    expect(full.transcript).not.toContain(ADVISOR_OMISSION_MARKER);

    const fitted = buildAdvisorProjection(state, { inputBudget: promptTokens(state) - 1 });
    expect(fitted.transcript).toContain(ADVISOR_OMISSION_MARKER);
  });

  test("budgets the omission marker before selecting entries", () => {
    const budget = promptTokens([markerEntry, systemEntry]);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });
    const parsed = JSON.parse(projection.transcript) as readonly SerializedEntry[];

    expect(parsed[0]).toEqual(markerEntry);
    expect(projection.transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(projection.transcript).not.toContain("CURRENT-TASK");
    expect(projection.diagnostics?.includedEntries).toBe(1);
    expectWithinBudget(projection, budget);
  });

  test("uses neutral omission wording that does not claim a priority order", () => {
    expect(ADVISOR_OMISSION_MARKER).not.toMatch(/earlier|lower-priority/i);
  });

  test("throws a RangeError when the required omission marker cannot fit", () => {
    const budget = markerTokens() - 1;

    expect(() => buildAdvisorProjection(state, { inputBudget: budget })).toThrow(RangeError);
    expect(() => buildAdvisorProjection(state, { inputBudget: budget })).toThrow(
      /omission marker/i,
    );
  });

  test("throws a RangeError when even the empty framing cannot fit", () => {
    const budget = promptTokens([]) - 1;

    expect(() => buildAdvisorProjection([], { inputBudget: budget })).toThrow(RangeError);
    expect(() => buildAdvisorProjection([], { inputBudget: budget })).toThrow(/framing/i);
  });

  test("rejects a nonfinite or nonpositive budget", () => {
    for (const budget of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(() => buildAdvisorProjection(state, { inputBudget: budget })).toThrow(RangeError);
    }
  });

  test("accepts a finite fractional budget", () => {
    const budget = markerTokens() + 0.25;
    const projection = buildAdvisorProjection(state, { inputBudget: budget });

    expect(projection.diagnostics?.complete).toBe(false);
    expect(projection.diagnostics?.omittedEntries).toBe(state.length);
    expectWithinBudget(projection, budget);
  });

  test("omits an oversized high-priority entry and keeps lower-priority entries that fit", () => {
    const hugeSystem = system(`HUGE-SYSTEM-${"s".repeat(20_000)}`);
    const smallSystem = system("SMALL-SYSTEM");
    const budget = promptTokens([markerEntry, smallSystem, currentUser, currentAssistant]);
    const projection = buildAdvisorProjection(
      [hugeSystem, smallSystem, currentUser, currentAssistant],
      { inputBudget: budget },
    );
    const transcript = projection.transcript;

    expect(transcript).toContain("SMALL-SYSTEM");
    expect(transcript).toContain("CURRENT-TASK");
    expect(transcript).toContain("TOOL-DATA");
    expect(transcript).not.toContain("HUGE-SYSTEM");
    expect(projection.diagnostics?.omittedEntries).toBe(1);
    expect(projection.diagnostics?.includedEntries).toBe(3);
    expectWithinBudget(projection, budget);
  });

  test("a huge current user entry does not starve the current assistant tool state", () => {
    const hugeUser = user(`HUGE-USER-${"u".repeat(20_000)}`);
    const budget = promptTokens([markerEntry, systemEntry, currentAssistant]);
    const projection = buildAdvisorProjection([systemEntry, hugeUser, currentAssistant], {
      inputBudget: budget,
    });
    const transcript = projection.transcript;

    expect(transcript).toContain("SYSTEM-CONSTRAINTS");
    expect(transcript).toContain("TOOL-DATA");
    expect(transcript).not.toContain("HUGE-USER");
    expect(projection.diagnostics?.omittedEntries).toBe(1);
    expectWithinBudget(projection, budget);
  });

  test("offers older history when the newest history entry is oversized", () => {
    const keptHistory = user(`OLD-HISTORY-KEEP-${"k".repeat(50)}`);
    const hugeHistory = user(`OLD-HISTORY-HUGE-${"h".repeat(20_000)}`);
    const budget = promptTokens([markerEntry, keptHistory, currentUser, currentAssistant]);
    const projection = buildAdvisorProjection(
      [keptHistory, hugeHistory, currentUser, currentAssistant],
      { inputBudget: budget },
    );
    const transcript = projection.transcript;

    expect(transcript).toContain("OLD-HISTORY-KEEP");
    expect(transcript).not.toContain("OLD-HISTORY-HUGE");
    expect(transcript.indexOf("OLD-HISTORY-KEEP")).toBeLessThan(transcript.indexOf("CURRENT-TASK"));
    expect(projection.diagnostics?.omittedEntries).toBe(1);
    expectWithinBudget(projection, budget);
  });

  test("stays within the budget across representative states and budgets", () => {
    const candidates: readonly (readonly SerializedEntry[])[] = [
      state,
      [systemEntry, currentUser, currentAssistant],
      [currentUser],
      [currentAssistant],
      [],
    ];
    for (const candidate of candidates) {
      const full = promptTokens(candidate);
      const budgets = [
        markerTokens(),
        markerTokens() + 1,
        (full + markerTokens()) / 2,
        full - 1,
        full,
        full + 1,
      ];
      for (const budget of budgets) {
        const projection = tryBuild(candidate, budget);
        if (projection === undefined) continue;
        expectWithinBudget(projection, budget);
        if (projection.diagnostics?.complete) {
          expect(projection.diagnostics.omittedEntries).toBe(0);
          expect(projection.diagnostics.includedEntries).toBe(candidate.length);
          expect(projection.transcript).toBe(serializeAdvisorContext(candidate));
        } else {
          expect(projection.diagnostics?.omittedEntries).toBeGreaterThan(0);
          expect(projection.transcript).toContain(ADVISOR_OMISSION_MARKER);
        }
      }
    }
  });

  test("fits a small-context Advisor with a reduced transcript instead of rejecting", () => {
    const budget = computeInputBudget({ context: 2000, output: 1500 });
    expect(budget).toBe(500);
    const projection = buildAdvisorProjection(state, { inputBudget: budget });

    expect(projection.diagnostics?.complete).toBe(false);
    expect(projection.diagnostics?.omittedEntries).toBeGreaterThan(0);
    expect(projection.transcript).toContain("CURRENT-TASK");
    expect(projection.transcript).not.toContain("OLD-HISTORY");
    expectWithinBudget(projection, budget);
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

describe("buildAdvisorProjection reasoning eligibility", () => {
  test("drops structured reasoning blocks from the unbudgeted projection", () => {
    const source: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [reasoning("HIDDEN-REASONING-SENTINEL"), { type: "text", text: "VISIBLE-DELTA" }],
    };

    const transcript = buildAdvisorProjection([source]).transcript;

    expect(transcript).not.toContain("HIDDEN-REASONING-SENTINEL");
    expect(transcript).not.toMatch(/"type":"reasoning"/);
    expect(transcript).toContain("VISIBLE-DELTA");
  });

  test("drops structured reasoning blocks from the budgeted projection", () => {
    const source: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [reasoning("HIDDEN-REASONING-SENTINEL"), { type: "text", text: "VISIBLE-DELTA" }],
    };
    const eligible: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [{ type: "text", text: "VISIBLE-DELTA" }],
    };
    const budget = promptTokens([eligible]);

    const projection = buildAdvisorProjection([source], { inputBudget: budget });

    expect(projection.diagnostics?.complete).toBe(true);
    expect(projection.transcript).not.toContain("HIDDEN-REASONING-SENTINEL");
    expect(projection.transcript).toContain("VISIBLE-DELTA");
    expectWithinBudget(projection, budget);
  });

  test("keeps mixed visible text and raw tool evidence verbatim while removing reasoning", () => {
    const rawToolText = `RAW-TOOL-${"z".repeat(100)}-END`;
    const mixed: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [
        reasoning("HIDDEN-ONE"),
        { type: "text", text: "VISIBLE-DELTA" },
        {
          type: "tool-call",
          id: "call_read",
          name: "read",
          status: "completed",
          input: { path: "src/a.ts" },
        },
        { type: "tool-result", id: "call_read", name: "read", text: rawToolText },
        reasoning("HIDDEN-TWO"),
      ],
    };
    const eligible: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [
        { type: "text", text: "VISIBLE-DELTA" },
        {
          type: "tool-call",
          id: "call_read",
          name: "read",
          status: "completed",
          input: { path: "src/a.ts" },
        },
        { type: "tool-result", id: "call_read", name: "read", text: rawToolText },
      ],
    };
    const canonical: readonly SerializedEntry[] = [systemEntry, currentUser, mixed];
    const before = JSON.stringify(canonical);
    const budget = promptTokens([systemEntry, currentUser, eligible]);

    const projection = buildAdvisorProjection(canonical, { inputBudget: budget });
    const parsed = JSON.parse(projection.transcript) as readonly SerializedEntry[];

    expect(parsed.map((entry) => entry.role)).toEqual(["system", "user", "assistant"]);
    expect(assistantBlockTypes(projection.transcript)).toEqual([
      "text",
      "tool-call",
      "tool-result",
    ]);
    expect(projection.transcript).toContain(rawToolText);
    expect(projection.transcript).toContain('"input":{"path":"src/a.ts"}');
    expect(projection.transcript).not.toContain("HIDDEN-ONE");
    expect(projection.transcript).not.toContain("HIDDEN-TWO");
    expect(JSON.stringify(canonical)).toBe(before);
    expectWithinBudget(projection, budget);
  });

  test("keeps reasoning-only assistant metadata with empty blocks", () => {
    const source: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [reasoning("HIDDEN-ONLY")],
    };

    for (const projection of [
      buildAdvisorProjection([source]),
      buildAdvisorProjection([source], { inputBudget: 150_000 }),
    ]) {
      const parsed = JSON.parse(projection.transcript) as readonly SerializedEntry[];
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toMatchObject({
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.13",
        inFlight: true,
        blocks: [],
      });
      expect(projection.transcript).not.toContain("HIDDEN-ONLY");
    }
  });

  test("excluded reasoning does not consume budget or starve useful state", () => {
    const hugeReasoning = reasoning(`HIDDEN-${"r".repeat(20_000)}`);
    const visible: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [
        hugeReasoning,
        { type: "text", text: "CURRENT-DELTA" },
        { type: "tool-result", id: "call_read", name: "read", text: "RAW-EVIDENCE" },
      ],
    };
    const eligible: SerializedEntry = {
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: true,
      blocks: [
        { type: "text", text: "CURRENT-DELTA" },
        { type: "tool-result", id: "call_read", name: "read", text: "RAW-EVIDENCE" },
      ],
    };
    const budget = promptTokens([systemEntry, currentUser, eligible]);

    const projection = buildAdvisorProjection([systemEntry, currentUser, visible], {
      inputBudget: budget,
    });

    expect(projection.diagnostics?.complete).toBe(true);
    expect(projection.transcript).toContain("CURRENT-DELTA");
    expect(projection.transcript).toContain("RAW-EVIDENCE");
    expect(projection.transcript).not.toContain("HIDDEN-");
    expectWithinBudget(projection, budget);
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
