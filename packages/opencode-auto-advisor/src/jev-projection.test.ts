import { describe, expect, test } from "bun:test";
import { routingFingerprint } from "./fingerprint.js";
import {
  buildJevRoutingProjection,
  JEV_MAX_ASSISTANT_TEXT_BLOCKS,
  JEV_MAX_ASSISTANT_TEXT_CHARS,
  JEV_MAX_HISTORY_ASSISTANT_CHARS,
  JEV_MAX_HISTORY_USER_CHARS,
  JEV_MAX_OBJECTIVE_CHARS,
  JEV_MAX_OBJECTIVE_MEDIA,
  JEV_MAX_RECENT_TURNS,
  JEV_MAX_TOOL_ACTIVITY,
  JEV_MAX_TOOL_DETAIL_CHARS,
} from "./jev-projection.js";
import type { MediaPlaceholder } from "./media.js";
import type { SerializedEntry } from "./serialize.js";
import type { AssistantBlock } from "./serialize-assistant.js";
import { stableStringify } from "./stable.js";

const user = (text: string): SerializedEntry => ({ role: "user", text });

const userWithMedia = (text: string, media: readonly MediaPlaceholder[]): SerializedEntry => ({
  role: "user",
  text,
  media,
});

const assistant = (blocks: readonly AssistantBlock[]): SerializedEntry => ({
  role: "assistant",
  agent: "build",
  model: "opencode/jev-1.13",
  inFlight: false,
  blocks,
});

const toolEntry = (blocks: readonly AssistantBlock[]): SerializedEntry => ({
  role: "tool",
  blocks,
});

const textBlock = (value: string): AssistantBlock => ({ type: "text", text: value });

const callBlock = (name: string, input: unknown = {}): AssistantBlock => ({
  type: "tool-call",
  id: `call_${name}`,
  name,
  status: "running",
  input,
});

const resultBlock = (name: string, text: string): AssistantBlock => ({
  type: "tool-result",
  id: `call_${name}`,
  name,
  text,
});

function largeHistory(turns: number): SerializedEntry[] {
  const entries: SerializedEntry[] = [
    { role: "system", text: `SYSTEM-PROMPT ${"s".repeat(4000)}` },
  ];
  for (let index = 0; index < turns; index += 1) {
    entries.push(user(`OLD-USER-${index} ${"u".repeat(500)}`));
    entries.push(assistant([textBlock(`OLD-ASSISTANT-${index} ${"a".repeat(500)}`)]));
  }
  entries.push(user("CURRENT-REQUEST unique marker"));
  entries.push(assistant([textBlock("CURRENT-ASSISTANT-TEXT")]));
  entries.push(
    assistant([callBlock("write", { path: "src/target.ts", content: "x".repeat(1000) })]),
  );
  entries.push(toolEntry([resultBlock("write", "wrote src/target.ts")]));
  return entries;
}

describe("buildJevRoutingProjection bounds", () => {
  test("keeps a large canonical history within the internal projection caps", () => {
    const entries = largeHistory(20);
    const projection = buildJevRoutingProjection(entries);

    expect(projection.recentHistory.length).toBeLessThanOrEqual(JEV_MAX_RECENT_TURNS);
    expect(projection.currentTurn.assistantText.length).toBeLessThanOrEqual(
      JEV_MAX_ASSISTANT_TEXT_BLOCKS,
    );
    expect(projection.currentTurn.toolActivity.length).toBeLessThanOrEqual(JEV_MAX_TOOL_ACTIVITY);
    for (const text of projection.currentTurn.assistantText) {
      expect(text.length).toBeLessThanOrEqual(JEV_MAX_ASSISTANT_TEXT_CHARS);
    }
    for (const activity of projection.currentTurn.toolActivity) {
      expect((activity.detail ?? "").length).toBeLessThanOrEqual(JEV_MAX_TOOL_DETAIL_CHARS);
    }
    expect(projection.objective?.text.length).toBeLessThanOrEqual(JEV_MAX_OBJECTIVE_CHARS);
    for (const turn of projection.recentHistory) {
      expect(turn.userText.length).toBeLessThanOrEqual(JEV_MAX_HISTORY_USER_CHARS);
      expect((turn.assistantText ?? "").length).toBeLessThanOrEqual(
        JEV_MAX_HISTORY_ASSISTANT_CHARS,
      );
    }
    expect(projection.recentHistory.length).toBeLessThan(20);
    expect(stableStringify(projection).length).toBeLessThan(stableStringify(entries).length);
  });

  test("caps objective media hints", () => {
    const media: MediaPlaceholder[] = Array.from(
      { length: JEV_MAX_OBJECTIVE_MEDIA + 2 },
      (_, i) => ({
        kind: "image",
        mime: "image/png",
        name: `shot-${i}.png`,
        source: { type: "inline" },
        inspected: false,
      }),
    );
    const projection = buildJevRoutingProjection([userWithMedia("see attached", media)]);

    expect(projection.objective?.media).toHaveLength(JEV_MAX_OBJECTIVE_MEDIA);
  });
});

describe("buildJevRoutingProjection evidence", () => {
  test("preserves the current request and current-turn evidence", () => {
    const projection = buildJevRoutingProjection(largeHistory(5));

    expect(projection.objective?.text).toContain("CURRENT-REQUEST");
    expect(projection.currentTurn.assistantText).toContain("CURRENT-ASSISTANT-TEXT");
    const pending = projection.currentTurn.toolActivity.find(
      (activity) => activity.kind === "call" && activity.name === "write",
    );
    expect(pending?.detail).toContain("src/target.ts");
    expect(
      projection.currentTurn.toolActivity.some(
        (activity) => activity.kind === "result" && activity.name === "write",
      ),
    ).toBe(true);
    expect(projection.executor).toEqual({ agent: "build", model: "opencode/jev-1.13" });
  });

  test("keeps sanitized media hints on the objective", () => {
    const projection = buildJevRoutingProjection([
      userWithMedia("see attached", [
        {
          kind: "image",
          mime: "image/png",
          name: "signed.png",
          source: { type: "uri", uri: "https://cdn.example.com/a/signed.png" },
          inspected: false,
        },
      ]),
    ]);

    expect(projection.objective?.media).toEqual([
      { kind: "image", mime: "image/png", name: "signed.png" },
    ]);
  });

  test("excludes advisor-origin activity from the projection", () => {
    const projection = buildJevRoutingProjection([
      user("current"),
      assistant([callBlock("advisor"), resultBlock("advisor", "previous advice")]),
      assistant([callBlock("read", { path: "a.ts" })]),
    ]);

    expect(projection.currentTurn.toolActivity.map((activity) => activity.name)).toEqual(["read"]);
  });
});

describe("buildJevRoutingProjection history reduction", () => {
  test("omits older settled turns and keeps the most recent ones", () => {
    const projection = buildJevRoutingProjection(largeHistory(5));
    const serialized = stableStringify(projection);

    expect(projection.omittedHistoryTurns).toBe(5 - JEV_MAX_RECENT_TURNS);
    expect(serialized).not.toContain("OLD-USER-0");
    expect(serialized).toContain(`OLD-USER-${5 - JEV_MAX_RECENT_TURNS}`);
    expect(serialized).toContain(`OLD-USER-${5 - 1}`);
  });

  test("excerpts long settled text to the history caps", () => {
    const projection = buildJevRoutingProjection([
      user("x".repeat(900)),
      assistant([textBlock("y".repeat(900))]),
      user("current"),
    ]);

    expect(projection.recentHistory).toHaveLength(1);
    expect(projection.recentHistory[0]?.userText.length).toBe(JEV_MAX_HISTORY_USER_CHARS);
    expect(projection.recentHistory[0]?.userText.endsWith("…")).toBe(true);
    expect(projection.recentHistory[0]?.assistantText?.length).toBe(
      JEV_MAX_HISTORY_ASSISTANT_CHARS,
    );
  });
});

describe("buildJevRoutingProjection independence", () => {
  test("a material change outside the projection still changes the fingerprint", () => {
    const before = largeHistory(5);
    const after = largeHistory(5);
    after[1] = user("OLD-USER-0 changed materially");

    expect(stableStringify(buildJevRoutingProjection(after))).toBe(
      stableStringify(buildJevRoutingProjection(before)),
    );
    expect(routingFingerprint(after)).not.toBe(routingFingerprint(before));
  });
});
