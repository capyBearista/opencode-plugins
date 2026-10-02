import { describe, expect, test } from "bun:test";
import {
  ADVISOR_CONTEXT_MARKER,
  ADVISOR_INSTRUCTIONS,
  ADVISOR_TOOL_DESCRIPTION,
  buildAdvisorPrompt,
  EXECUTOR_ADVISOR_GUIDANCE,
} from "./advisor-prompts.js";
import { buildAdvisorPrompt as serviceBuildAdvisorPrompt } from "./advisor-service.js";

describe("advisor prompt layers", () => {
  test("buildAdvisorPrompt frames the transcript with the instructions and context marker", () => {
    const prompt = buildAdvisorPrompt('{"role":"user"}');
    expect(prompt).toContain(ADVISOR_INSTRUCTIONS);
    expect(prompt).toContain(ADVISOR_CONTEXT_MARKER);
    expect(prompt.endsWith('{"role":"user"}')).toBe(true);
  });

  test("advisor-service keeps the buildAdvisorPrompt seam for the projection budget", () => {
    expect(serviceBuildAdvisorPrompt("TRANSCRIPT")).toBe(buildAdvisorPrompt("TRANSCRIPT"));
  });

  test("EXECUTOR_ADVISOR_GUIDANCE covers access, timing, authority, and reconciliation", () => {
    expect(EXECUTOR_ADVISOR_GUIDANCE).toContain("advisor()");
    expect(EXECUTOR_ADVISOR_GUIDANCE).toContain("no arguments");
    expect(EXECUTOR_ADVISOR_GUIDANCE).toContain("serious weight");
    expect(EXECUTOR_ADVISOR_GUIDANCE).toContain("user");
    expect(EXECUTOR_ADVISOR_GUIDANCE).toContain("reconcile");
  });

  test("EXECUTOR_ADVISOR_GUIDANCE avoids commits, model names, and follow-up questions", () => {
    expect(EXECUTOR_ADVISOR_GUIDANCE).not.toContain("git commit");
    expect(EXECUTOR_ADVISOR_GUIDANCE).not.toMatch(/jev|claude|gpt/i);
    expect(EXECUTOR_ADVISOR_GUIDANCE).not.toContain("?");
  });

  test("ADVISOR_TOOL_DESCRIPTION stays concise and argument-free", () => {
    expect(ADVISOR_TOOL_DESCRIPTION).toContain("Advisor");
    expect(ADVISOR_TOOL_DESCRIPTION).toContain("no arguments");
    expect(ADVISOR_TOOL_DESCRIPTION.length).toBeLessThan(200);
  });

  test("ADVISOR_INSTRUCTIONS defines an independent reviewer, not the Executor", () => {
    expect(ADVISOR_INSTRUCTIONS).toContain("not the Executor");
    expect(ADVISOR_INSTRUCTIONS).toContain("evidence");
    expect(ADVISOR_INSTRUCTIONS).toContain("inFlight");
    expect(ADVISOR_INSTRUCTIONS).toContain("pending work");
    expect(ADVISOR_INSTRUCTIONS).toContain("context-omitted");
    expect(ADVISOR_INSTRUCTIONS).toContain("not inspected");
    expect(ADVISOR_INSTRUCTIONS).not.toContain("FULL transcript");
  });

  test("ADVISOR_INSTRUCTIONS adapts to starting, stuck, completed, and candidate states", () => {
    expect(ADVISOR_INSTRUCTIONS).toContain("Starting out");
    expect(ADVISOR_INSTRUCTIONS).toContain("Stuck");
    expect(ADVISOR_INSTRUCTIONS).toContain("Reviewing completed work");
    expect(ADVISOR_INSTRUCTIONS).toContain("Choosing between candidates");
    expect(ADVISOR_INSTRUCTIONS).toContain("blind spots");
    expect(ADVISOR_INSTRUCTIONS).toContain("stale prior advice");
  });

  test("ADVISOR_INSTRUCTIONS forbids scores, questions, tools, delegation, and recursion", () => {
    expect(ADVISOR_INSTRUCTIONS).toContain("scores");
    expect(ADVISOR_INSTRUCTIONS).toContain("confidence");
    expect(ADVISOR_INSTRUCTIONS).toContain("Do not ask questions");
    expect(ADVISOR_INSTRUCTIONS).toContain("tools");
    expect(ADVISOR_INSTRUCTIONS).toContain("delegate");
    expect(ADVISOR_INSTRUCTIONS).toContain("recurse");
  });
});
