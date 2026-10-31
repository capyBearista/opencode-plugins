import { describe, expect, test } from "bun:test";
import {
  advisorTranscript,
  COMPACTED,
  compactContext,
  decisionInput,
  type Message,
  OMISSION_MARKER,
  renderMessage,
} from "./transcript.js";

const user = (id: string, text: string): Message => ({
  role: "user",
  id,
  content: [{ type: "text", text }],
});
const call = (id: string, name: string, input: unknown): Message => ({
  role: "assistant",
  id,
  content: [{ type: "tool-call", id: `c-${id}`, name, input }],
});
const result = (name: string, value: unknown, error = false): Message => ({
  role: "tool",
  content: [
    { type: "tool-result", id: "x", name, result: { type: error ? "error" : "text", value } },
  ],
});

// Shapes captured from a real 2.2.0 `context` hook in the spike.
const turn: Message[] = [
  user("u1", "Fix the failing login test"),
  call("a1", "bash", { command: "bun test" }),
  result("bash", "1 fail: AssertionError token expired", true),
  call("a2", "edit", { file: "auth.ts" }),
  result("bash", "ok"),
  { role: "system", id: "s1", content: [{ type: "text", text: "<context>entry</context>" }] },
];

describe("renderMessage", () => {
  test("renders text, tool calls, results, media and drops reasoning", () => {
    const lines = renderMessage({
      role: "assistant",
      content: [
        { type: "reasoning", text: "secret thoughts" },
        { type: "text", text: "Running tests" },
        { type: "tool-call", id: "1", name: "bash", input: { command: "ls" } },
        { type: "media", filename: "shot.png" },
      ],
    });
    expect(lines).toEqual([
      "ASSISTANT: Running tests",
      'TOOL CALL bash: {"command":"ls"}',
      "[media attachment shot.png: contents not inspected]",
    ]);
  });

  test("marks tool errors and system updates", () => {
    expect(renderMessage(turn[2])).toEqual([
      "TOOL RESULT bash (error): 1 fail: AssertionError token expired",
    ]);
    expect(renderMessage(turn[5])).toEqual(["SYSTEM UPDATE: <context>entry</context>"]);
  });
});

const requests = (ids: string[], more: { requests?: number; requestMaxChars?: number } = {}) => ({
  prompts: new Set(ids),
  requests: 3,
  requestMaxChars: -1,
  ...more,
});

describe("decisionInput", () => {
  test("summarizes only the current turn with counts", () => {
    const text = decisionInput(
      [user("u0", "old request"), result("bash", "old"), ...turn],
      requests(["u0", "u1"], { requests: 1 }),
    );
    expect(text).toContain(
      "User requests (oldest first; the last is the latest):\nUSER: Fix the failing login test",
    );
    expect(text).not.toContain("old request");
    expect(text).toContain(
      "Steps this turn: 2. Failed tool calls this turn: 1. Latest tool result: ok.",
    );
    expect(text).toContain("TOOL RESULT bash (error)");
  });

  test("shows the last N real requests, oldest first", () => {
    const messages = [
      user("u0", "zero"),
      ...turn.slice(1, 3),
      user("u1", "one"),
      user("u2", "two"),
      result("bash", "ok"),
      user("u3", "three"),
      call("a9", "read", { file: "x" }),
    ];
    const text = decisionInput(messages, requests(["u0", "u1", "u2", "u3"]));
    expect(text).toContain(
      "User requests (oldest first; the last is the latest):\nUSER: one\n\nUSER: two\n\nUSER: three\n\nRecent steps",
    );
    expect(text).not.toContain("zero");
    // The turn starts at the latest request.
    expect(text).toContain("Steps this turn: 1.");
  });

  test("a long plan followed by a short correction keeps the plan, uncapped with -1", () => {
    const plan = `PLAN START ${"step ".repeat(6_000)}PLAN END`;
    const messages = [
      user("u1", plan),
      ...turn.slice(1, 5),
      user("u2", "Leave .slim/deepwork/ unignored."),
      call("a5", "task_message", { message: "go" }),
      user("syn-1", '<subagent sessionID="ses_1" state="completed">\nDone.\n</subagent>'),
    ];
    const text = decisionInput(messages, requests(["u1", "u2"]));
    expect(text).toContain("PLAN START");
    expect(text).toContain("PLAN END");
    expect(text).toContain("USER: Leave .slim/deepwork/ unignored.");
    expect(text).toContain('SUBAGENT: <subagent sessionID="ses_1" state="completed">');
    expect(text).not.toContain("USER: <subagent");
  });

  test("requestMaxChars caps each request and keeps its start", () => {
    const text = decisionInput(
      [user("u1", `BEGIN ${"x".repeat(5_000)} FINISH`)],
      requests(["u1"], { requestMaxChars: 200 }),
    );
    expect(text).toContain("USER: BEGIN");
    expect(text).not.toContain("FINISH");
    expect(text).toMatch(/chars truncated\]/);
  });

  test("other user-role messages in the turn are notices, not the user", () => {
    const text = decisionInput(
      [...turn, user("sk-1", "Skill instructions: be careful"), user("sh-1", "Plan mode ended")],
      requests(["u1"]),
    );
    expect(text).toContain("NOTICE: Skill instructions: be careful");
    expect(text).toContain("NOTICE: Plan mode ended");
    expect(text).not.toContain("USER: Skill");
  });

  test("a prompt admitted but not delivered yet does not start the turn", () => {
    const text = decisionInput(turn, requests(["u1", "u9"]));
    expect(text).toContain("USER: Fix the failing login test");
    expect(text).toContain("Steps this turn: 2.");
  });

  test("leaves out system updates, including an earlier review", () => {
    const review = {
      role: "system",
      content: [
        { type: "text", text: "[auto-advisor review r1] Automatic review (moment: done)." },
      ],
    };
    const text = decisionInput([...turn, review], requests(["u1"]));
    expect(text).not.toContain("SYSTEM UPDATE");
    expect(text).not.toContain("auto-advisor review");
  });

  test("a non-zero shell exit counts as a failure even when the tool completed", () => {
    const log = `${"ok line\n".repeat(400)}24 passed, 1 failed\n\nExited with code 1`;
    const text = decisionInput(
      [user("u1", "Make the tests pass"), result("shell", log)],
      requests(["u1"]),
    );
    expect(text).toContain("Failed tool calls this turn: 1. Latest tool result: failed.");
    // Truncation keeps the end of a tool result, where the outcome is.
    expect(text).toContain("Exited with code 1");
  });

  test("without a real prompt in the window it says so instead of guessing", () => {
    const text = decisionInput(
      [user("syn-1", '<subagent state="completed">'), result("bash", "ok")],
      requests(["u-old"]),
    );
    expect(text).toContain(
      "User requests (oldest first; the last is the latest):\n(not in context)",
    );
    expect(text).toContain("SUBAGENT: <subagent state=");
  });

  test("a huge request never pushes out the steps or the counts", () => {
    const big = Array.from({ length: 20 }, (_, i) => result("read", "x".repeat(5_000 + i)));
    const text = decisionInput([user("u1", "y".repeat(100_000)), ...big], requests(["u1"]));
    expect(text).toContain("y".repeat(100_000));
    expect(text).toEndWith("Latest tool result: ok.");
  });
});

describe("advisorTranscript", () => {
  const base = {
    system: [{ text: "Be careful." }],
    tools: ["bash", "edit"],
    prompts: new Set(["u1"]),
  };

  test("labels subagent results and other notices, never as the user", () => {
    const text = advisorTranscript({
      ...base,
      messages: [
        ...turn,
        user("syn-1", '<subagent sessionID="s" state="completed">\nDone.\n</subagent>'),
        user("sk-1", "Skill instructions"),
      ],
      budgetChars: 10_000,
    });
    expect(text).toContain("USER: Fix the failing login test");
    expect(text).toContain('SUBAGENT: <subagent sessionID="s"');
    expect(text).toContain("NOTICE: Skill instructions");
    expect(text).not.toContain("USER: <subagent");
  });

  test("over budget it keeps the first real request, not an earlier notice", () => {
    const messages = [
      user("syn-0", '<subagent sessionID="s" state="completed">old result</subagent>'),
      user("u1", "The real task"),
      ...Array.from({ length: 20 }, (_, i) => result("read", "z".repeat(1_000 + i))),
    ];
    const text = advisorTranscript({ ...base, messages, budgetChars: 4_000 });
    expect(text).toContain(OMISSION_MARKER);
    expect(text).toContain("USER: The real task");
    expect(text).not.toContain("old result");
  });

  test("includes system text, tools and every message when it fits", () => {
    const text = advisorTranscript({ ...base, messages: turn, budgetChars: 10_000 });
    expect(text).toStartWith("SYSTEM PROMPT:\nBe careful.\n\nAVAILABLE TOOLS: bash, edit");
    expect(text).toContain("USER: Fix the failing login test");
    expect(text).not.toContain(OMISSION_MARKER);
  });

  test("an oversized newest message is truncated, not dropped", () => {
    const messages = [
      user("u1", "task"),
      result("read", "small"),
      result("read", "q".repeat(50_000)),
    ];
    const text = advisorTranscript({ ...base, messages, budgetChars: 4_000 });
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toMatch(/TOOL RESULT read: \[\d+ chars truncated\] …qqq/);
  });

  test("an oversized system prompt and first request still fit the budget", () => {
    const text = advisorTranscript({
      system: [{ text: "s".repeat(20_000) }],
      prompts: new Set(["u1"]),
      tools: ["bash"],
      messages: [user("u1", "f".repeat(20_000)), result("bash", "latest step")],
      budgetChars: 4_000,
    });
    expect(text.length).toBeLessThanOrEqual(4_000);
    expect(text).toContain("latest step");
  });

  test("a newest message with several large parts is shortened, not dropped", () => {
    const parallel: Message = {
      role: "tool",
      content: ["a", "b", "c"].map((name) => ({
        type: "tool-result",
        id: name,
        name: "read",
        result: { type: "text", value: name.repeat(1_000) },
      })),
    };
    const text = advisorTranscript({
      system: [{ text: "s".repeat(1_000) }],
      prompts: new Set(["u1"]),
      tools: ["read"],
      messages: [user("u1", "f".repeat(1_000)), result("read", "older step"), parallel],
      budgetChars: 3_000,
    });
    expect(text.length).toBeLessThanOrEqual(3_000);
    expect(text).toMatch(/TOOL RESULT read: \[\d+ chars truncated\] …aaa/);
  });

  test("over budget keeps the first request and the newest messages", () => {
    const messages = [
      user("u1", "original task"),
      ...Array.from({ length: 50 }, (_, i) => result("read", `chunk-${i} ${"z".repeat(200)}`)),
    ];
    const text = advisorTranscript({ ...base, messages, budgetChars: 2_000 });
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text).toContain("USER: original task");
    expect(text).toContain(OMISSION_MARKER);
    expect(text).toContain("chunk-49");
    expect(text).not.toContain("chunk-0 ");
  });
});

/** Shaped like OpenCode 2.2.0's renderers: codemode/, mcp/ and skill/instructions.ts. */
const CODE_MODE = [
  "# Code Mode",
  "",
  "Use the `execute` tool to call the tools listed below. They cannot be called directly, and neither can `search`. Both only work inside code you pass to `execute`.",
  "",
  "The catalog is partial. Inside `execute`, use `search(...)` to find a tool.",
  "",
  "- search({\n  query?: string,\n}): { items: Array<string> }",
  "",
  "## Available tools",
  "",
  "- deepwiki (3 tools)",
  "  - tools.deepwiki.ask({\n  /** Repo. */\n  repoName: string,\n}): Promise<unknown> // Ask a question",
].join("\n");
const CODE_MODE_UPDATE = `The Code Mode tool catalog has changed. This catalog supersedes the previous Code Mode tool catalog.\n\n${CODE_MODE}`;
const MCP = [
  "<mcp_instructions>",
  '  <server name="greptile">',
  "    Use tools from this server through `execute`.",
  "",
  "    Call get_me first.",
  "  </server>",
  "</mcp_instructions>",
].join("\n");
const SKILLS = [
  "Skills provide specialized instructions and workflows for specific tasks.",
  "Use the skill tool to load a skill when a task matches its description.",
  "<available_skills>",
  "  <skill>",
  "    <id>git</id>",
  "    <name>git</name>",
  "    <description>Git help.</description>",
  "  </skill>",
  "</available_skills>",
].join("\n");
const AGENTS = "Instructions from: AGENTS.md\n<agents-md>NEVER PUSH.</agents-md>";
const DCP =
  "You operate in a context-constrained environment.\n<dcp-system-reminder>keep</dcp-system-reminder>";

describe("compactContext", () => {
  test("replaces each host catalog with a marker and keeps everything else", () => {
    const text = ["Role prompt.", CODE_MODE, MCP, SKILLS, AGENTS, DCP].join("\n\n");
    expect(compactContext(text)).toBe(
      ["Role prompt.", COMPACTED.codeMode, COMPACTED.mcp, COMPACTED.skills, AGENTS, DCP].join(
        "\n\n",
      ),
    );
  });

  test("replaces a catalog update, notice included, and every copy", () => {
    const text = [CODE_MODE, MCP, CODE_MODE_UPDATE].join("\n\n");
    expect(compactContext(text)).toBe(
      [COMPACTED.codeMode, COMPACTED.mcp, COMPACTED.codeMode].join("\n\n"),
    );
  });

  test("leaves a block without its end untouched", () => {
    const text = [
      "<mcp_instructions>\n  half",
      CODE_MODE.replace("## Available tools", "## Tools"),
      SKILLS.replace("</available_skills>", ""),
    ].join("\n\n");
    expect(compactContext(text)).toBe(text);
  });
  test("a block without its end does not stop later blocks", () => {
    const broken = CODE_MODE.replace("## Available tools", "## Tools");
    expect(compactContext(`${broken}\n\n${CODE_MODE}`)).toBe(`${broken}\n\n${COMPACTED.codeMode}`);
  });

  test("a block without its end never borrows the next copy's end", () => {
    const text = `<mcp_instructions>\n  half\n\n${AGENTS}\n\n${MCP}`;
    expect(compactContext(text)).toBe(
      `<mcp_instructions>\n  half\n\n${AGENTS}\n\n${COMPACTED.mcp}`,
    );
  });
});

describe("advisorTranscript compaction", () => {
  const messages: Message[] = [
    user("u1", `Explain this:\n${MCP}`),
    { role: "system", content: [{ type: "text", text: CODE_MODE_UPDATE }] },
    result("read", SKILLS),
  ];
  const input = {
    system: [{ text: `Role prompt.\n\n${CODE_MODE}` }, { text: `${SKILLS}\n\n${AGENTS}` }],
    prompts: new Set(["u1"]),
    tools: ["execute"],
    messages,
    budgetChars: 100_000,
  };

  test("compacts system text and system updates, never user or tool content", () => {
    const text = advisorTranscript({ ...input, compact: true });
    expect(text).toContain(
      `SYSTEM PROMPT:\nRole prompt.\n\n${COMPACTED.codeMode}\n\n${COMPACTED.skills}`,
    );
    expect(text).toContain(AGENTS);
    expect(text).toContain(`SYSTEM UPDATE: ${COMPACTED.codeMode}`);
    expect(text).toContain(`USER: Explain this:\n${MCP}`);
    expect(text).toContain("<available_skills>");
    expect(text).not.toContain("## Available tools");
  });

  test("without compact the text is unchanged", () => {
    const text = advisorTranscript({ ...input, compact: false });
    expect(text).toContain(CODE_MODE);
    expect(text).toContain(CODE_MODE_UPDATE);
    expect(text).not.toContain("[context-omitted:");
  });
});
