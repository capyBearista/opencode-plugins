import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distPath = join(__dirname, "..", "dist");

describe("built artifact smoke test", () => {
  test("dist directory exists after build", () => {
    if (!existsSync(distPath)) {
      console.warn("Skipping artifact tests: dist/ not built yet. Run `bun run build` first.");
      return;
    }
    expect(existsSync(distPath)).toBeTrue();
  });

  test("dist/prompt directory exists with prompt files", () => {
    if (!existsSync(distPath)) return;

    const promptDir = join(distPath, "prompt");
    expect(existsSync(promptDir)).toBeTrue();

    const files = [
      "anthropic.txt",
      "beast.txt",
      "codex.txt",
      "copilot-gpt-5.txt",
      "default.txt",
      "gemini.txt",
      "gpt.txt",
      "kimi.txt",
      "trinity.txt",
    ];
    for (const f of files) {
      expect(existsSync(join(promptDir, f))).toBeTrue();
    }
  });

  test("built provider-prompt.js resolves prompts correctly", async () => {
    if (!existsSync(distPath)) return;

    const { providerPromptForModel } = await import("../dist/provider-prompt.js");

    const codex = providerPromptForModel({ api: { id: "gpt-codex" } });
    expect(codex).toContain("## Editing constraints");

    const copilot = providerPromptForModel({ api: { id: "gpt-4o-copilot" } });
    expect(copilot).toContain("expert AI programming assistant");

    const gpt = providerPromptForModel({ api: { id: "gpt-3.5-turbo" } });
    expect(gpt).toContain("You are OpenCode");

    const unknown = providerPromptForModel({ api: { id: "unknown-model" } });
    expect(unknown).toContain("You are opencode, an interactive CLI tool");
  });
});
