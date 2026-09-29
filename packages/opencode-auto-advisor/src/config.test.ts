import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_FILE_NAME, ConfigError, loadConfig, resolveConfigPath } from "./config.js";

async function fixture(contents: string | undefined, run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "auto-advisor-config-"));
  const path = join(dir, CONFIG_FILE_NAME);
  if (contents !== undefined) await writeFile(path, contents);
  try {
    await run(path);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function configError(contents: string, key: string) {
  await fixture(contents, async (path) => {
    const error = await loadConfig({ path }).catch((cause: unknown) => cause);
    if (!(error instanceof ConfigError))
      throw new Error(`expected ConfigError, received ${String(error)}`);
    expect(error.message).toContain(key);
  });
}

const DEFAULTS = {
  advisor: {},
  routing: {
    mode: "off",
    models: ["jev-1.13-free", "jev-1.13"],
    advisorWouldHelpThreshold: 0.7,
    consequenceThreshold: 3,
    maxConsultationsPerTurn: 1,
  },
};

describe("loadConfig", () => {
  test("missing file yields all defaults", async () => {
    await fixture(undefined, async (path) => {
      expect(await loadConfig({ path })).toEqual(DEFAULTS);
    });
  });

  test("partial file merges per key", async () => {
    await fixture(
      JSON.stringify({ routing: { mode: "observe", maxConsultationsPerTurn: 4 } }),
      async (path) => {
        const config = await loadConfig({ path });
        expect(config.routing.mode).toBe("observe");
        expect(config.routing.maxConsultationsPerTurn).toBe(4);
        expect(config.routing.models).toEqual(["jev-1.13-free", "jev-1.13"]);
        expect(config.routing.advisorWouldHelpThreshold).toBe(0.7);
        expect(config.advisor.model).toBeUndefined();
      },
    );
  });

  test("complete valid file wins over defaults", async () => {
    await fixture(
      JSON.stringify({
        advisor: { model: "anthropic/claude-sonnet-4" },
        routing: {
          mode: "active",
          models: ["jev-1.13"],
          advisorWouldHelpThreshold: 0.5,
          consequenceThreshold: 2.5,
          maxConsultationsPerTurn: 3,
        },
      }),
      async (path) => {
        const config = await loadConfig({ path });
        expect(config.advisor.model).toEqual({ providerID: "anthropic", id: "claude-sonnet-4" });
        expect(config.routing).toEqual({
          mode: "active",
          models: ["jev-1.13"],
          advisorWouldHelpThreshold: 0.5,
          consequenceThreshold: 2.5,
          maxConsultationsPerTurn: 3,
        });
      },
    );
  });

  test("advisor.model inherit and model variants are honored", async () => {
    await fixture(JSON.stringify({ advisor: { model: "inherit" } }), async (path) => {
      expect((await loadConfig({ path })).advisor.model).toBeUndefined();
    });
    await fixture(
      JSON.stringify({ advisor: { model: "opencode/jev-1.13#high" } }),
      async (path) => {
        expect((await loadConfig({ path })).advisor.model).toEqual({
          providerID: "opencode",
          id: "jev-1.13",
          variant: "high",
        });
      },
    );
  });

  test("malformed JSON names the config file", async () => {
    await configError("{ not json", CONFIG_FILE_NAME);
  });

  test("unknown keys are rejected at every level", async () => {
    await configError(JSON.stringify({ telemetry: true }), "telemetry");
    await configError(JSON.stringify({ advisor: { fallback: "x" } }), "advisor.fallback");
    await configError(JSON.stringify({ routing: { retries: 2 } }), "routing.retries");
    await configError(JSON.stringify({ apiKey: "secret" }), "apiKey");
  });

  test("invalid shapes name the offending key", async () => {
    await configError(JSON.stringify([]), "root");
    await configError(JSON.stringify({ routing: null }), "routing");
    await configError(JSON.stringify({ advisor: [] }), "advisor");
    await configError(JSON.stringify({ routing: { mode: "always" } }), "routing.mode");
  });

  test("invalid thresholds name the key and never fall back", async () => {
    await configError(
      JSON.stringify({ routing: { advisorWouldHelpThreshold: "high" } }),
      "routing.advisorWouldHelpThreshold",
    );
    await configError(
      JSON.stringify({ routing: { advisorWouldHelpThreshold: 1.5 } }),
      "routing.advisorWouldHelpThreshold",
    );
    await configError(
      JSON.stringify({ routing: { advisorWouldHelpThreshold: -0.1 } }),
      "routing.advisorWouldHelpThreshold",
    );
    await configError(
      JSON.stringify({ routing: { consequenceThreshold: 5 } }),
      "routing.consequenceThreshold",
    );
    await configError(
      JSON.stringify({ routing: { consequenceThreshold: -1 } }),
      "routing.consequenceThreshold",
    );
    await configError(
      JSON.stringify({ routing: { consequenceThreshold: Number.NaN } }),
      "routing.consequenceThreshold",
    );
  });

  test("model chain must be a non-empty list of model ids", async () => {
    await configError(JSON.stringify({ routing: { models: [] } }), "routing.models");
    await configError(JSON.stringify({ routing: { models: "jev-1.13" } }), "routing.models");
    await configError(JSON.stringify({ routing: { models: [""] } }), "routing.models[0]");
    await configError(
      JSON.stringify({ routing: { models: ["jev-1.13", 7] } }),
      "routing.models[1]",
    );
  });

  test("consultation budget must be a positive integer", async () => {
    await configError(
      JSON.stringify({ routing: { maxConsultationsPerTurn: 0 } }),
      "routing.maxConsultationsPerTurn",
    );
    await configError(
      JSON.stringify({ routing: { maxConsultationsPerTurn: -2 } }),
      "routing.maxConsultationsPerTurn",
    );
    await configError(
      JSON.stringify({ routing: { maxConsultationsPerTurn: 1.5 } }),
      "routing.maxConsultationsPerTurn",
    );
    await configError(
      JSON.stringify({ routing: { maxConsultationsPerTurn: "1" } }),
      "routing.maxConsultationsPerTurn",
    );
  });

  test("advisor.model rejects values that are not a model reference", async () => {
    await configError(JSON.stringify({ advisor: { model: "" } }), "advisor.model");
    await configError(JSON.stringify({ advisor: { model: "claude-sonnet" } }), "advisor.model");
    await configError(JSON.stringify({ advisor: { model: 42 } }), "advisor.model");
  });

  test("config loads without touching the real home directory", () => {
    expect(resolveConfigPath({ XDG_CONFIG_HOME: join(tmpdir(), "xdg") }, "/home/unused")).toBe(
      join(tmpdir(), "xdg", "opencode", CONFIG_FILE_NAME),
    );
  });
});

describe("resolveConfigPath", () => {
  test("honors OPENCODE_CONFIG_DIR, then XDG_CONFIG_HOME, then the home fallback", () => {
    expect(
      resolveConfigPath({ OPENCODE_CONFIG_DIR: "/custom", XDG_CONFIG_HOME: "/xdg" }, "/home/u"),
    ).toBe(join("/custom", CONFIG_FILE_NAME));
    expect(resolveConfigPath({ XDG_CONFIG_HOME: "/xdg" }, "/home/u")).toBe(
      join("/xdg", "opencode", CONFIG_FILE_NAME),
    );
    expect(resolveConfigPath({}, "/home/u")).toBe(
      join("/home/u", ".config", "opencode", CONFIG_FILE_NAME),
    );
  });

  test("fails with a configuration error when no config root is resolvable", () => {
    const error = (() => {
      try {
        resolveConfigPath({}, "");
        return undefined;
      } catch (cause) {
        return cause;
      }
    })();
    if (!(error instanceof ConfigError))
      throw new Error(`expected ConfigError, received ${String(error)}`);
    expect(error.message).toContain("XDG_CONFIG_HOME");
  });
});
