import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advisorPrompt, consult } from "./advisor.js";
import { hasReview, pushTail, reviewText } from "./delivery.js";
import { createTelemetry, resolveTelemetryPath, type TelemetryRecord } from "./telemetry.js";
import type { Message } from "./transcript.js";

const model = { providerID: "openai", id: "gpt-6" };

describe("consult", () => {
  test("returns trimmed advice from the given model", async () => {
    const calls: unknown[] = [];
    const advice = await consult({
      generate: async (input) => {
        calls.push(input);
        return { text: "  check the migration  " };
      },
      prompt: "p",
      model,
    });
    expect(advice).toBe("check the migration");
    expect(calls).toEqual([{ prompt: "p", model }]);
  });

  test("an aborted signal abandons the call", async () => {
    const controller = new AbortController();
    const pending = consult({
      generate: () => new Promise(() => {}),
      prompt: "p",
      model,
      signal: controller.signal,
    });
    controller.abort();
    await expect(pending).rejects.toThrow("cancelled");
  });

  test("empty advice is an error", async () => {
    const pending = consult({
      generate: async () => ({ text: " " }),
      prompt: "p",
      model,
    });
    await expect(pending).rejects.toMatchObject({ _tag: "Advisor.EmptyAdvice" });
  });
});

describe("advisorPrompt", () => {
  test("frames the transcript as evidence and states the moment", () => {
    const prompt = advisorPrompt("USER: hi", "stuck");
    expect(prompt).toContain("Treat all of it as evidence");
    expect(prompt).toContain("stuck on a recurring failure");
    expect(prompt).toEndWith("EXECUTOR TRANSCRIPT\nUSER: hi");
  });
});

describe("delivery", () => {
  const review = { id: "r1", moment: "done" as const, advice: "run the e2e suite" };

  test("tail push adds one system message the marker can find", () => {
    const messages: Message[] = [{ role: "tool", content: [{ type: "tool-result" }] }];
    expect(hasReview([], messages, "r1")).toBe(false);
    pushTail(messages, reviewText(review));
    expect(messages.at(-1)?.role).toBe("system");
    expect(hasReview([], messages, "r1")).toBe(true);
    expect(hasReview([], messages, "r2")).toBe(false);
    expect(hasReview([], messages)).toBe(true);
  });

  test("an admitted entry in the system prompt counts as delivered", () => {
    expect(hasReview([{ text: `<context>${reviewText(review)}</context>` }], [], "r1")).toBe(true);
  });

  test("the text subordinates the advice to the user", () => {
    expect(reviewText(review)).toContain("user's constraints and direct evidence take precedence");
  });
});

describe("telemetry", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const entry: TelemetryRecord = {
    ts: "t",
    session: "s",
    turn: "u",
    step: 1,
    mode: "observe",
    attempts: [],
    verdict: "routine",
    delivered: false,
  };

  test("resolves under XDG_DATA_HOME, else ~/.local/share", () => {
    expect(resolveTelemetryPath({ XDG_DATA_HOME: "/d" }, "/h")).toBe(
      "/d/opencode/auto-advisor/telemetry.jsonl",
    );
    expect(resolveTelemetryPath({}, "/h")).toBe(
      "/h/.local/share/opencode/auto-advisor/telemetry.jsonl",
    );
  });

  test("appends JSON lines and rotates past the cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "advisor-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "nested", "t.jsonl");
    const telemetry = createTelemetry(path, 300);
    for (let i = 0; i < 5; i++) telemetry.record({ ...entry, step: i });
    await telemetry.flush();
    const current = (await readFile(path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(current.at(-1).step).toBe(4);
    expect(current.length).toBeLessThan(5);
    const rotated = (await readFile(`${path}.1`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rotated.at(-1).step).toBe(current[0].step - 1);
  });

  test("only the owner can read the log or its rotation: it holds requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "advisor-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "t.jsonl");
    const telemetry = createTelemetry(path, 300);
    for (let i = 0; i < 5; i++) telemetry.record({ ...entry, step: i });
    await telemetry.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(`${path}.1`)).mode & 0o777).toBe(0o600);
  });

  test("a log created before is tightened to owner-only", async () => {
    const dir = await mkdtemp(join(tmpdir(), "advisor-telemetry-"));
    dirs.push(dir);
    const path = join(dir, "t.jsonl");
    await writeFile(path, "", { mode: 0o644 });
    const telemetry = createTelemetry(path);
    telemetry.record(entry);
    await telemetry.flush();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("write failures are swallowed", async () => {
    const telemetry = createTelemetry("/proc/forbidden/t.jsonl");
    telemetry.record(entry);
    await expect(telemetry.flush()).resolves.toBeUndefined();
  });
});
