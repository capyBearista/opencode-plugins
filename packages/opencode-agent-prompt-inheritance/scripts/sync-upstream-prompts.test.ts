import { describe, expect, mock, test } from "bun:test";
import { ALLOWED_FILES, buildUpstreamUrl } from "../scripts/sync-upstream-prompts.js";

describe("sync-upstream-prompts", () => {
  test("builds correct upstream URL", () => {
    const url = buildUpstreamUrl("anomalyco", "opencode", "dev", "anthropic.txt");
    expect(url).toBe(
      "https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/opencode/src/session/prompt/anthropic.txt",
    );
  });

  test("builds URL with custom upstream config", () => {
    const url = buildUpstreamUrl("myorg", "myrepo", "main", "beast.txt");
    expect(url).toBe(
      "https://raw.githubusercontent.com/myorg/myrepo/main/packages/opencode/src/session/prompt/beast.txt",
    );
  });

  test("allowed files list matches expected prompts", () => {
    expect(ALLOWED_FILES).toHaveLength(9);
    expect(ALLOWED_FILES).toContain("anthropic.txt");
    expect(ALLOWED_FILES).toContain("copilot-gpt-5.txt");
    expect(ALLOWED_FILES).toContain("default.txt");
  });

  test("throws on non-OK fetch response", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
    })) as never;

    try {
      const { syncPrompts } = await import("../scripts/sync-upstream-prompts.js");
      await expect(
        syncPrompts("/tmp/test-sync", ["test.txt"], "https://example.com"),
      ).rejects.toThrow("Failed to fetch test.txt: 404 Not Found");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
