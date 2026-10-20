import { describe, expect, test } from "bun:test";
import type { ContextMessage, SessionID } from "./context.js";
import { captureSessionHistory, serializeAdvisorContext, stableStringify } from "./context.js";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const input = { sessionID: "ses_1" as SessionID, messageID: "msg-current" };

const session = (messages: readonly ContextMessage[]) => ({ context: async () => messages });

const system = (text: string): ContextMessage => ({
  id: "msg-system",
  time: { created: 1 },
  type: "system",
  text,
  description: "base",
});

const user = (text: string, files?: unknown[], id = "msg-user"): ContextMessage => ({
  id,
  time: { created: 2 },
  type: "user",
  text,
  ...(files ? { files: files as never } : {}),
});

describe("captureSessionHistory", () => {
  test("preserves chronological roles, assistant text before the call, reasoning, tool calls and results", async () => {
    const messages: ContextMessage[] = [
      system("System rules"),
      user("Fix the bug", [
        { data: PNG_1X1, mime: "image/png", source: { type: "inline" }, name: "bug.png" },
      ]),
      {
        id: "msg-assistant-1",
        time: { created: 3, completed: 4 },
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode", id: "jev-1.13" },
        content: [
          { type: "reasoning", text: "trace the failure" },
          { type: "text", text: "Looking at it" },
          {
            type: "tool",
            id: "call_1",
            name: "read",
            state: {
              status: "completed",
              input: { path: "src/a.ts" },
              content: [{ type: "text", text: "file body" }],
            },
            time: { created: 3, completed: 4 },
          },
        ],
      },
      {
        id: "msg-compaction",
        time: { created: 5 },
        type: "compaction",
        status: "completed",
        reason: "auto",
        summary: "earlier work",
        recent: "recent messages",
        providerContext: {
          version: 1,
          provenance: {
            providerID: "opencode",
            provider: "OpenCode",
            modelID: "jev-1.13",
            route: "zen",
            protocol: "openai",
            endpoint: "https://opencode.ai/zen",
          },
          messages: [{ role: "user", content: "SECRET-NATIVE-BLOB" }],
        },
      },
      {
        id: "msg-current",
        time: { created: 6 },
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode", id: "jev-1.14" },
        content: [
          { type: "text", text: "Second opinion please" },
          {
            type: "tool",
            id: "call_2",
            name: "advisor",
            state: { status: "running", input: {}, metadata: {} },
            time: { created: 6 },
          },
        ],
      },
    ];

    const captured = await captureSessionHistory(session(messages), input);

    expect(captured.executorModel).toEqual({ providerID: "opencode", id: "jev-1.14" });
    expect(captured.lastUserMessageID).toBe("msg-user");
    expect(captured.messageIDs).toEqual([
      "msg-system",
      "msg-user",
      "msg-assistant-1",
      "msg-compaction",
      "msg-current",
    ]);
    expect(captured.entries).toEqual([
      { role: "system", text: "System rules", description: "base" },
      {
        role: "user",
        text: "Fix the bug",
        media: [
          {
            kind: "image",
            mime: "image/png",
            name: "bug.png",
            dimensions: { width: 1, height: 1 },
            source: { type: "inline" },
            inspected: false,
          },
        ],
      },
      {
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.13",
        inFlight: false,
        blocks: [
          { type: "reasoning", text: "trace the failure" },
          { type: "text", text: "Looking at it" },
          {
            type: "tool-call",
            id: "call_1",
            name: "read",
            status: "completed",
            input: { path: "src/a.ts" },
          },
          { type: "tool-result", id: "call_1", name: "read", text: "file body" },
        ],
      },
      {
        role: "compaction",
        status: "completed",
        reason: "auto",
        summary: "earlier work",
        recent: "recent messages",
        checkpoint: {
          providerID: "opencode",
          provider: "OpenCode",
          modelID: "jev-1.13",
          route: "zen",
          protocol: "openai",
          endpoint: "https://opencode.ai/zen",
        },
      },
      {
        role: "assistant",
        agent: "build",
        model: "opencode/jev-1.14",
        inFlight: true,
        blocks: [
          { type: "text", text: "Second opinion please" },
          { type: "tool-call", id: "call_2", name: "advisor", status: "running", input: {} },
        ],
      },
    ]);

    const transcript = serializeAdvisorContext(captured.entries);
    expect(transcript).not.toContain(PNG_1X1);
    expect(transcript).not.toContain("SECRET-NATIVE-BLOB");
  });

  test("represents tool failures and uri-backed tool media as metadata", async () => {
    const messages: ContextMessage[] = [
      {
        id: "msg-assistant",
        time: { created: 1 },
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode", id: "jev-1.13" },
        content: [
          {
            type: "tool",
            id: "call_shot",
            name: "screenshot",
            state: {
              status: "completed",
              input: {},
              content: [
                { type: "file", uri: "file:///tmp/shot.png", mime: "image/png", name: "shot.png" },
              ],
            },
            time: { created: 1 },
          },
          {
            type: "tool",
            id: "call_bad",
            name: "grep",
            state: {
              status: "error",
              input: { pattern: "x" },
              error: { type: "tool.error", message: "pattern rejected" },
            },
            time: { created: 1 },
          },
        ],
      },
    ];

    const captured = await captureSessionHistory(session(messages), input);

    expect(captured.entries[0]).toEqual({
      role: "assistant",
      agent: "build",
      model: "opencode/jev-1.13",
      inFlight: false,
      blocks: [
        { type: "tool-call", id: "call_shot", name: "screenshot", status: "completed", input: {} },
        {
          type: "tool-result",
          id: "call_shot",
          name: "screenshot",
          media: [
            {
              kind: "image",
              mime: "image/png",
              name: "shot.png",
              source: { type: "uri", uri: "shot.png" },
              inspected: false,
            },
          ],
        },
        {
          type: "tool-call",
          id: "call_bad",
          name: "grep",
          status: "error",
          input: { pattern: "x" },
        },
        {
          type: "tool-error",
          id: "call_bad",
          name: "grep",
          error: { type: "tool.error", message: "pattern rejected" },
        },
      ],
    });
  });

  test("captures state markers with detail", async () => {
    const messages: ContextMessage[] = [
      {
        id: "m1",
        time: { created: 1 },
        type: "synthetic",
        text: "continue after incomplete stream",
      },
      {
        id: "m2",
        time: { created: 2 },
        type: "skill",
        skill: "tdd",
        name: "TDD",
        text: "write tests first",
      },
      {
        id: "m3",
        time: { created: 3 },
        type: "shell",
        shellID: "sh_1",
        command: "bun test",
        status: "exited",
        exit: 0,
        output: { output: "1 pass", cursor: 0, size: 6, truncated: false },
      },
      { id: "m4", time: { created: 4 }, type: "idle", outcome: "succeeded" },
      {
        id: "m5",
        time: { created: 5 },
        type: "model-switched",
        model: { providerID: "opencode", id: "jev-1.14" },
        previous: { providerID: "opencode", id: "jev-1.13" },
      },
      { id: "m6", time: { created: 6 }, type: "agent-switched", agent: "plan", previous: "build" },
      {
        id: "m7",
        time: { created: 7 },
        type: "location-switched",
        location: { directory: "/tmp" },
        subpath: "src",
      },
    ];

    const captured = await captureSessionHistory(session(messages), input);

    expect(captured.entries.map((entry) => ({ ...entry }))).toEqual([
      { role: "marker", type: "synthetic", detail: "continue after incomplete stream" },
      { role: "marker", type: "skill", detail: "write tests first" },
      { role: "marker", type: "shell", detail: "bun test [exited exit=0]\n1 pass" },
      { role: "marker", type: "idle", detail: "succeeded" },
      { role: "marker", type: "model-switched", detail: "opencode/jev-1.13 -> opencode/jev-1.14" },
      { role: "marker", type: "agent-switched", detail: "build -> plan" },
      { role: "marker", type: "location-switched", detail: "src" },
    ]);
    expect(captured.executorModel).toBeUndefined();
  });

  test("represents running and failed compactions", async () => {
    const messages: ContextMessage[] = [
      {
        id: "c1",
        time: { created: 1 },
        type: "compaction",
        status: "running",
        reason: "auto",
        summary: "s",
        recent: "r",
      },
      {
        id: "c2",
        time: { created: 2 },
        type: "compaction",
        status: "failed",
        reason: "manual",
        error: { type: "compaction.failed", message: "boom" },
      },
    ];

    const captured = await captureSessionHistory(session(messages), input);

    expect(captured.entries).toEqual([
      { role: "compaction", status: "running", reason: "auto", summary: "s", recent: "r" },
      {
        role: "compaction",
        status: "failed",
        reason: "manual",
        error: { type: "compaction.failed", message: "boom" },
      },
    ]);
  });

  test("resolves the last user message identity for turn-scoped routing", async () => {
    const messages: ContextMessage[] = [
      user("first", undefined, "msg-user-a"),
      {
        id: "msg-assistant-a",
        time: { created: 3 },
        type: "assistant",
        agent: "build",
        model: { providerID: "opencode", id: "jev-1.13" },
        content: [{ type: "text", text: "working" }],
      },
      user("second", undefined, "msg-user-b"),
    ];

    const captured = await captureSessionHistory(session(messages), input);

    expect(captured.lastUserMessageID).toBe("msg-user-b");
  });

  test("omits the last user message identity when no user message exists", async () => {
    const captured = await captureSessionHistory(session([system("rules")]), input);

    expect(captured.lastUserMessageID).toBeUndefined();
  });

  test("propagates session read failures instead of swallowing them", async () => {
    const failing = {
      context: async () => {
        throw new Error("session read failed");
      },
    };
    await expect(captureSessionHistory(failing, input)).rejects.toThrow("session read failed");
  });
});

describe("serializeAdvisorContext", () => {
  test("is pure, repeatable and stable under key insertion order", () => {
    const first = { beta: 1, alpha: { delta: [4, 3], gamma: true } };
    const second = { alpha: { gamma: true, delta: [4, 3] }, beta: 1 };
    expect(stableStringify(first)).toBe('{"alpha":{"delta":[4,3],"gamma":true},"beta":1}');
    expect(stableStringify(second)).toBe(stableStringify(first));
    const entries = [{ role: "marker", type: "idle", detail: "succeeded" }] as Parameters<
      typeof serializeAdvisorContext
    >[0];
    expect(serializeAdvisorContext(entries)).toBe(serializeAdvisorContext(entries));
  });
});
