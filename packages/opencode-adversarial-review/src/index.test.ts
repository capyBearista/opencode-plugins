import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import plugin from "./index.js";

type TestPermission = { action: string; resource: string; effect: string };

type TestAgent = {
  id: string;
  mode?: string;
  hidden?: boolean;
  description?: string;
  system?: string;
  color?: string;
  permissions?: TestPermission[];
};

type HookEvent = { sessionID: string; agent?: string; options: { temperature?: number } };

type TestLogEntry = { service: string; level: string; message: string };

type TestHostLog = (input: Record<string, unknown>) => unknown;

const PLUGIN_ID = "capybearista.opencode-adversarial-review";
const PACKAGE_NAME = "@capybearista/opencode-adversarial-review";
const REVIEWER_AGENT_ID = "adversarial-reviewer";
const COMMAND_FILE_NAME = "adversarial-review.md";
const COMMAND_ASSET_PATH = join(import.meta.dirname, "..", "commands", COMMAND_FILE_NAME);
const REVIEW_AGENT_ID = "reviewer";
const REVIEW_COMMAND_FILE_NAME = "review.md";
const REVIEW_COMMAND_ASSET_PATH = join(
  import.meta.dirname,
  "..",
  "commands",
  REVIEW_COMMAND_FILE_NAME,
);
const PACKAGE_ROOT = resolve(import.meta.dirname, "..");
const JSON_VERBATIM_RULE =
  "Return only valid JSON, verbatim. Do not wrap the JSON in markdown fences or add commentary outside the JSON object.";
const MARKDOWN_VERBATIM_RULE =
  "Return only the Markdown report, verbatim. Do not wrap the report in markdown fences or add commentary outside the report.";
const DO_NOT_INVOKE_DESCRIPTION =
  "Do not invoke this agent directly. It is invocable only by the user.";

// The shared deterministic resolver block is byte-identical across both
// prompts, both prompt references, and both command templates. Only the
// remainder sentence (focus area vs. ignored) differs by reviewer.
const RESOLVER_HEAD = `Target selection:
- A pull request URL always wins: when an argument is a PR URL, that URL selects the PR, no matter where it appears or what other target tokens are present.
- Otherwise, the first bare token decides: an all-decimal number is a PR number, and a hex string of 7 or more characters containing at least one letter a-f, or any full-length 40-character SHA, is a commit. A pure-decimal string is never a commit, so \`1234567\` is PR #1234567.
- A first bare token that matches neither class (including non-hex non-decimal tokens) is reported plainly as unresolvable and never scope-reviewed; hex matching is case-insensitive (A-F accepted), a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule, and multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed.
- An explicit target (PR URL, PR number, or commit SHA) beats \`--scope\` and \`--base\`: when one is present, those flags are ignored.`;

const RESOLVER_REMAINDER_ADVERSARIAL =
  "- The first target token wins; any remaining trailing text is the focus area.";

const RESOLVER_REMAINDER_REVIEW =
  "- The first target token wins. Other trailing non-flag text is ignored; focus areas are not supported, so review the whole change the selected target covers.";

const RESOLVER_TAIL = `- Before resolving a bare PR number, verify the current repository with \`git remote -v\`; a bare number is resolved in the current repository only, and any \`user:token@\` credentials in the remote output are redacted before you reason about it.
- Resolve PR URLs against the current repository only: if a URL points at another repository, stop and warn explicitly unless the user asked for a cross-repo review.
- A commit target is reviewed with \`git show <sha>\` yourself, and files at that revision are read with \`git show <sha>:<file>\` instead of their working-tree copies.
- A pull request target is reviewed with \`gh pr view <pr-or-url>\` and \`gh pr diff <pr-or-url>\` yourself. If \`gh\` is missing or unauthenticated, report that plainly instead of guessing at the change; when \`gh\` fails, report its stderr verbatim.
- For a commit or pull request target, prefer the evidence you collect yourself over the working-tree snapshot blocks: they describe the current checkout, not the selected target.
- Otherwise, select the review scope with the flags below.`;

function expectDeterministicResolver(text: string, remainder: string): void {
  expect(text).toInclude(`${RESOLVER_HEAD}\n${remainder}\n${RESOLVER_TAIL}\n`);
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function isolatedConfigDirectory(): Promise<string> {
  const directory = await temporaryDirectory("adversarial-review-config-");
  await mkdir(join(directory, "commands"), { recursive: true });
  return directory;
}

async function walkFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const full = join(directory, entry.name);
      if (entry.isDirectory()) await visit(full);
      else files.push(relative(root, full));
    }
  }
  await visit(root);
  return files.sort();
}

function frontmatterOf(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match?.[1]) throw new Error("command asset has no frontmatter block");
  const entries: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const separator = line.indexOf(":");
    if (separator > 0) entries[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return entries;
}

type TestContextInput = {
  agents?: TestAgent[];
  hostLog?: TestHostLog;
};

function createTestContext(input: TestContextInput = {}) {
  const agents = new Map<string, TestAgent>(
    (input.agents ?? []).map((agent) => [
      agent.id,
      { permissions: [{ action: "*", resource: "*", effect: "allow" }], ...agent },
    ]),
  );
  const hooks = new Map<string, (event: HookEvent) => void>();
  const disposers: string[] = [];
  const commandTransforms: number[] = [];
  const logs: TestLogEntry[] = [];
  const hostLog =
    input.hostLog ??
    ((entry: Record<string, unknown>) => {
      logs.push(entry as TestLogEntry);
    });

  const editor = {
    list: () => [...agents.values()],
    get: (id: string) => agents.get(id),
    update: (id: string, update: (agent: TestAgent) => void) => {
      let agent = agents.get(id);
      if (!agent) {
        agent = { id, permissions: [{ action: "*", resource: "*", effect: "allow" }] };
        agents.set(id, agent);
      }
      update(agent);
    },
    remove: (id: string) => agents.delete(id),
    default: () => {},
  };

  const ctx = {
    app: {
      name: "opencode",
      version: "test",
      channel: "test",
      log: hostLog,
    },
    agent: {
      transform: async (callback: (value: typeof editor) => void) => {
        callback(editor);
        return {
          dispose: async () => {
            disposers.push("agent");
          },
        };
      },
    },
    session: {
      hook: async (name: string, callback: (event: HookEvent) => void) => {
        hooks.set(name, callback);
        return {
          dispose: async () => {
            disposers.push(`hook:${name}`);
          },
        };
      },
    },
    command: {
      transform: async () => {
        commandTransforms.push(1);
        return {
          dispose: async () => {
            disposers.push("command");
          },
        };
      },
    },
  };

  return { ctx, agents, hooks, disposers, commandTransforms, logs, configDir: "" };
}

type TestContext = ReturnType<typeof createTestContext>;

async function setupPlugin(context: TestContext, configDir?: string) {
  context.configDir = configDir ?? (await isolatedConfigDirectory());
  const previous = process.env.OPENCODE_CONFIG_DIR;
  process.env.OPENCODE_CONFIG_DIR = context.configDir;
  try {
    return await plugin.setup(context.ctx as never);
  } finally {
    if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = previous;
  }
}

type SubprocessSetup = {
  ok: boolean;
  error?: string;
  agents: Array<{
    id: string;
    mode?: string;
    hidden?: boolean;
    description?: string;
    color?: string;
  }>;
  hooks: string[];
  commandTransforms: number;
  logs: TestLogEntry[];
};

function childEnvironment(overrides: Record<string, string>): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "OPENCODE_CONFIG_DIR") environment[key] = value;
  }
  return { ...environment, ...overrides };
}

function fsErrorMock(
  method: "readFile" | "writeFile",
  error: { code: string; message: string; onlyFor?: string } | undefined,
): string {
  if (error === undefined) return "";
  const real = method === "readFile" ? "realReadFile" : "realWriteFile";
  const guard =
    error.onlyFor === undefined
      ? ""
      : `if (!String(path).endsWith(${JSON.stringify(`/${error.onlyFor}`)})) {
          return ${real}(path, ...args);
        }
        `;
  return `
    const { mock } = await import("bun:test");
    const fs = await import("node:fs/promises");
    const ${real} = fs.${method}.bind(fs);
    mock.module("node:fs/promises", () => ({
      ...fs,
      ${method}: async (path, ...args) => {
        ${guard}const error = new Error(${JSON.stringify(error.message)});
        error.code = ${JSON.stringify(error.code)};
        throw error;
      },
    }));
  `;
}

async function runSetupInSubprocess(configuration: {
  home: string;
  opencodeConfigDir?: string;
  readFileError?: { code: string; message: string; onlyFor?: string };
  writeFileError?: { code: string; message: string; onlyFor?: string };
}): Promise<SubprocessSetup> {
  const pluginURL = pathToFileURL(join(PACKAGE_ROOT, "src", "index.ts")).href;
  const writeFileMock = fsErrorMock("writeFile", configuration.writeFileError);
  const readFileMock = fsErrorMock("readFile", configuration.readFileError);
  const script = `
    ${writeFileMock}
    ${readFileMock}
    const { default: plugin } = await import(${JSON.stringify(pluginURL)});
    const agents = [];
    const hooks = [];
    const logs = [];
    let commandTransforms = 0;
    const ctx = {
      app: {
        name: "test",
        version: "test",
        channel: "test",
        log: (entry) => { logs.push(entry); },
      },
      agent: {
        transform: async (callback) => {
          callback({
            list: () => [],
            get: () => undefined,
            update: (id, update) => {
              const agent = { id, permissions: [] };
              update(agent);
              agents.push({
                id: agent.id,
                mode: agent.mode,
                hidden: agent.hidden,
                description: agent.description,
                color: agent.color,
              });
            },
            remove: () => {},
            default: () => {},
          });
          return { dispose: async () => {} };
        },
      },
      session: {
        hook: async (name) => {
          hooks.push(name);
          return { dispose: async () => {} };
        },
      },
      command: {
        transform: async () => {
          commandTransforms += 1;
          return { dispose: async () => {} };
        },
      },
    };
    let error;
    try {
      const cleanup = await plugin.setup(ctx);
      if (typeof cleanup === "function") await cleanup();
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    console.log(JSON.stringify({ ok: error === undefined, error, agents, hooks, commandTransforms, logs }));
  `;
  const child = Bun.spawnSync({
    cmd: ["bun", "-e", script],
    cwd: PACKAGE_ROOT,
    env: childEnvironment({
      HOME: configuration.home,
      ...(configuration.opencodeConfigDir === undefined
        ? {}
        : { OPENCODE_CONFIG_DIR: configuration.opencodeConfigDir }),
    }),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (child.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(child.stderr));
  }
  const stdout = new TextDecoder().decode(child.stdout).trim();
  const payload = stdout.split("\n").at(-1) ?? "";
  return JSON.parse(payload) as SubprocessSetup;
}

// Local approximation of host enforcement, mirroring `Wildcard.match` from
// @opencode/core (`*` -> `.*`, `?` -> `.`, trailing `" .*"` accepts an optional
// space-suffixed argument) plus `Permission.evaluate`'s last-match-wins scan.
// The host is authoritative at runtime; keep this matcher minimal and do not
// extend it beyond the semantics the reviewer rule set relies on.
function wildcardMatch(input: string, pattern: string): boolean {
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, "s").test(input.replaceAll("\\", "/"));
}

function effectiveEffect(
  permissions: readonly TestPermission[],
  action: string,
  resource: string,
): string {
  for (let index = permissions.length - 1; index >= 0; index -= 1) {
    const rule = permissions[index];
    if (rule && wildcardMatch(action, rule.action) && wildcardMatch(resource, rule.resource)) {
      return rule.effect;
    }
  }
  return "ask";
}

describe("@capybearista/opencode-adversarial-review", () => {
  test("exports a V2 plugin definition with the package id", () => {
    expect(plugin).toBeObject();
    expect(plugin.id).toBe(PLUGIN_ID);
    expect(plugin.setup).toBeFunction();
    expect("server" in plugin).toBe(false);
    expect("tui" in plugin).toBe(false);
  });

  test("package.json targets the V2 package root, ships the command, and has no TUI metadata", async () => {
    const manifest = await Bun.file(join(PACKAGE_ROOT, "package.json")).json();
    expect(manifest.main).toBe("./dist/index.js");
    expect(manifest.description).toInclude("adversarial reviewer");
    expect(manifest.description).toInclude("constructive reviewer");
    expect(manifest.exports["."].default).toBe("./dist/index.js");
    expect(manifest.files).toContain("server.js");
    expect(manifest.files).toContain("commands");
    expect(manifest.scripts.build).not.toInclude("check-schema-asset");
    expect(manifest.peerDependencies["@opencode/plugin"]).toBeString();
    expect(manifest.devDependencies["@opencode/plugin"]).toBeString();
    expect("oc-plugin" in manifest).toBe(false);
  });

  test("real V2 host resolves the package root server wrapper to the built entry", () => {
    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `
          import * as Host from "@opencode/plugin/host";
          const root = ${JSON.stringify(PACKAGE_ROOT)};
          const local = Host.resolve({ directory: root });
          const named = Host.resolve({ directory: root, name: ${JSON.stringify(PACKAGE_NAME)} });
          process.stdout.write(JSON.stringify({
            local: { server: local.server ?? null, tui: local.tui ?? null, rpc: local.rpc ?? null },
            named: { server: named.server ?? null, tui: named.tui ?? null, rpc: named.rpc ?? null },
          }));
        `,
      ],
      cwd: PACKAGE_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }

    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
      local: {
        server: pathToFileURL(join(PACKAGE_ROOT, "server.js")).href,
        tui: null,
        rpc: null,
      },
      named: {
        server: pathToFileURL(join(PACKAGE_ROOT, "dist", "index.js")).href,
        tui: null,
        rpc: null,
      },
    });
  });

  test("setup registers the reviewer agent without registering a host command", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.commandTransforms).toHaveLength(0);
    await cleanup?.();
  });

  test("reviewer agent runs as a hidden subagent", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const agent = context.agents.get(REVIEWER_AGENT_ID);
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("both reviewers run as hidden subagents with do-not-invoke descriptions", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    for (const agentId of [REVIEWER_AGENT_ID, REVIEW_AGENT_ID]) {
      const agent = context.agents.get(agentId);
      expect(agent?.mode).toBe("subagent");
      expect(agent?.hidden).toBe(true);
      expect(agent?.description).toBe(DO_NOT_INVOKE_DESCRIPTION);
    }
  });

  test("reviewer description is the static do-not-invoke text", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(REVIEWER_AGENT_ID)?.description).toBe(DO_NOT_INVOKE_DESCRIPTION);
  });

  test("existing reviewer configuration keeps system and color but not its description", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEWER_AGENT_ID,
          mode: "primary",
          description: "custom description",
          system: "custom system",
          color: "#123456",
        },
      ],
    });
    await setupPlugin(context);

    const agent = context.agents.get(REVIEWER_AGENT_ID);
    expect(agent?.description).not.toBe("custom description");
    expect(agent?.description).toBe(DO_NOT_INVOKE_DESCRIPTION);
    expect(agent?.system).toBe("custom system");
    expect(agent?.color).toBe("#123456");
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("existing review agent configuration keeps system and color but not its description", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEW_AGENT_ID,
          mode: "primary",
          description: "custom description",
          system: "custom system",
          color: "#654321",
        },
      ],
    });
    await setupPlugin(context);

    const agent = context.agents.get(REVIEW_AGENT_ID);
    expect(agent?.description).not.toBe("custom description");
    expect(agent?.description).toBe(DO_NOT_INVOKE_DESCRIPTION);
    expect(agent?.system).toBe("custom system");
    expect(agent?.color).toBe("#654321");
    expect(agent?.mode).toBe("subagent");
    expect(agent?.hidden).toBe(true);
  });

  test("reviewer agent keeps the evidence-first system prompt and the verbatim JSON rule", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const reference = await Bun.file(
      join(import.meta.dirname, "prompts", "adversarial-review.md"),
    ).text();
    const system = context.agents.get(REVIEWER_AGENT_ID)?.system ?? "";

    expect(system).toBe(`${reference.trimEnd()}\n\n${JSON_VERBATIM_RULE}`);
    expect(system).toInclude("Collect your own evidence with the read-only tools");
    expect(system).toInclude("never use `echo`");
    expect(system).toInclude("Treat that snapshot as a starting point, not as a complete record");
    expect(system).toInclude("<attack_surface>");
    expect(system).toInclude("<finding_bar>");
    expect(system).toInclude("<structured_output_contract>");
    expect(system).toInclude("If `--scope auto` (the default)");
    expect(system).toInclude("review the working tree when it has staged or unstaged changes");
    expectDeterministicResolver(system, RESOLVER_REMAINDER_ADVERSARIAL);
    expect(system).toInclude("A pull request URL always wins");
    expect(system).toInclude("an all-decimal number is a PR number");
    expect(system).toInclude(
      "A pure-decimal string is never a commit, so `1234567` is PR #1234567",
    );
    expect(system).toInclude("reported plainly as unresolvable and never scope-reviewed");
    expect(system).toInclude("hex matching is case-insensitive (A-F accepted)");
    expect(system).toInclude(
      "a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule",
    );
    expect(system).toInclude(
      "multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed",
    );
    expect(system).toInclude("beats `--scope` and `--base`");
    expect(system).toInclude("verify the current repository with `git remote -v`");
    expect(system).toInclude(
      "any `user:token@` credentials in the remote output are redacted before you reason about it",
    );
    expect(system).toInclude(
      "stop and warn explicitly unless the user asked for a cross-repo review",
    );
    expect(system).toInclude("when `gh` fails, report its stderr verbatim");
    expect(system).toInclude("Gate evidence collection on the selected target");
    expect(system).toInclude(
      "Commit target: use only `git show <sha>` and `git show <sha>:<file>` for versioned files",
    );
    expect(system).toInclude("Do not read, grep, or glob working-tree copies");
    expect(system).toInclude(
      "if the commit is not available locally, report that plainly instead of guessing",
    );
    expect(system).toInclude("Pull request target: collect `gh` evidence first");
    expect(system).toInclude("verifying it matches the PR head revision");
    expect(system).toInclude("resolve the PR head with `gh pr view <pr-or-url> --json headRefOid`");
    expect(system).toInclude("compare it with `git rev-parse HEAD`");
    expect(system).toInclude(
      "when either value is unavailable, report that plainly and fall back to `gh` evidence",
    );
    expect(system).toInclude(
      "prefer the evidence you collect yourself over the working-tree snapshot blocks",
    );
    expect(system).toInclude("`git merge-base`, `git remote -v`, `git rev-list`");
    expect(system).toInclude(
      "and the read-only `gh pr view` / `gh pr diff` for a pull request target plus the `gh auth status` diagnostic",
    );
    expect(system).not.toInclude(
      "A bare commit SHA (full 40-character or short form) selects that commit",
    );
    expect(system).not.toInclude(
      "A bare all-decimal number is a PR number, a bare hex string of 7 or more characters",
    );
    expect(system).not.toInclude("The first bare SHA, PR-number, or URL token selects the target");
    expect(system).not.toInclude("The inline Git context is primary evidence");
    expect(system).not.toInclude("full text bodies of unignored untracked files");
  });

  test("the review agent keeps the constructive review prompt and the verbatim markdown rule", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const reference = await Bun.file(join(import.meta.dirname, "prompts", "review.md")).text();
    const system = context.agents.get(REVIEW_AGENT_ID)?.system ?? "";

    expect(system).toBe(`${reference.trimEnd()}\n\n${MARKDOWN_VERBATIM_RULE}`);
    expect(system).toInclude("Review only: do not modify the repository");
    expect(system).toInclude("Other trailing non-flag text is ignored");
    expect(system).toInclude("state `None` when the change is sound");
    expect(system).toInclude(
      "each tagged `must` when it warrants action or should block, or `consider` when it is optional",
    );
    expect(system).not.toInclude("acknowledged");
    expect(system).toInclude("Collect your own evidence with the read-only tools");
    expect(system).toInclude("never use `echo`");
    expect(system).toInclude("If `--scope auto` (the default)");
    expect(system).toInclude("review the working tree when it has staged or unstaged changes");
    expect(system).toInclude("<report_contract>");
    expect(system).toInclude(
      "the first line must be exactly `Verdict: approve` or `Verdict: needs-attention`",
    );
    expectDeterministicResolver(system, RESOLVER_REMAINDER_REVIEW);
    expect(system).toInclude("A pull request URL always wins");
    expect(system).toInclude("an all-decimal number is a PR number");
    expect(system).toInclude(
      "A pure-decimal string is never a commit, so `1234567` is PR #1234567",
    );
    expect(system).toInclude("reported plainly as unresolvable and never scope-reviewed");
    expect(system).toInclude("hex matching is case-insensitive (A-F accepted)");
    expect(system).toInclude(
      "a 40-character all-decimal token is read as a commit SHA because the length rule wins over the decimal rule",
    );
    expect(system).toInclude(
      "multiple PR URLs resolve first-URL-wins with the remainder reported, not reviewed",
    );
    expect(system).toInclude("beats `--scope` and `--base`");
    expect(system).toInclude("verify the current repository with `git remote -v`");
    expect(system).toInclude(
      "any `user:token@` credentials in the remote output are redacted before you reason about it",
    );
    expect(system).toInclude(
      "stop and warn explicitly unless the user asked for a cross-repo review",
    );
    expect(system).toInclude("when `gh` fails, report its stderr verbatim");
    expect(system).toInclude("Gate evidence collection on the selected target");
    expect(system).toInclude(
      "Commit target: gather evidence only with `git show <sha>` and `git show <sha>:<file>` for versioned files",
    );
    expect(system).toInclude("Do not read, grep, or glob working-tree copies");
    expect(system).toInclude(
      "if the commit is not available locally, report that plainly instead of guessing",
    );
    expect(system).toInclude("Pull request target: gather `gh` evidence first");
    expect(system).toInclude("verifying it matches the PR head revision");
    expect(system).toInclude("resolve the PR head with `gh pr view <pr-or-url> --json headRefOid`");
    expect(system).toInclude("compare it with `git rev-parse HEAD`");
    expect(system).toInclude(
      "when either value is unavailable, report that plainly and fall back to `gh` evidence",
    );
    expect(system).toInclude(
      "prefer the evidence you collect yourself over the working-tree snapshot blocks",
    );
    expect(system).toInclude("`git merge-base`, `git remote -v`, `git rev-list`");
    expect(system).toInclude(
      "and the read-only `gh pr view` / `gh pr diff` for a pull request target plus the `gh auth status` diagnostic",
    );
    expect(system).not.toInclude(
      "A bare commit SHA (full 40-character or short form) selects that commit",
    );
    expect(system).not.toInclude("A pull request URL or bare PR number selects that pull request");
    expect(system).not.toInclude(
      "A bare all-decimal number is a PR number, a bare hex string of 7 or more characters",
    );
    expect(system).not.toInclude("The target is selected only by a bare commit SHA");
    expect(system).not.toInclude("break confidence");
    expect(system).not.toInclude("Output valid JSON matching this schema");
  });

  test("reviewer agents use a hex color instead of a theme name", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    expect(context.agents.get(REVIEWER_AGENT_ID)?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
    expect(context.agents.get(REVIEW_AGENT_ID)?.color).toMatch(/^#[0-9a-fA-F]{6}$/);
  });

  test("setup leaves every other agent's permissions untouched", async () => {
    const context = createTestContext({
      agents: [
        { id: "build", mode: "primary" },
        {
          id: "orchestrator",
          mode: "subagent",
          permissions: [
            { action: "subagent", resource: REVIEWER_AGENT_ID, effect: "deny" },
            { action: "skill", resource: "*", effect: "ask" },
          ],
        },
      ],
    });
    const buildBefore = structuredClone(context.agents.get("build")?.permissions);
    const orchestratorBefore = structuredClone(context.agents.get("orchestrator")?.permissions);

    await setupPlugin(context);

    expect(context.agents.get("build")?.permissions).toEqual(buildBefore);
    expect(context.agents.get("orchestrator")?.permissions).toEqual(orchestratorBefore);
    const reviewerDenies = context.agents
      .get("orchestrator")
      ?.permissions.filter(
        (rule) => rule.action === "subagent" && rule.resource === REVIEWER_AGENT_ID,
      );
    expect(reviewerDenies).toHaveLength(1);
  });

  test("a pre-existing host deny outranks the plugin allow for the same resource", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEWER_AGENT_ID,
          permissions: [
            { action: "shell", resource: "git diff*", effect: "deny" },
            { action: "read", resource: "secrets/**", effect: "deny" },
            { action: "read", resource: "docs/**", effect: "allow" },
          ],
        },
      ],
    });
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(effectiveEffect(permissions, "shell", "git diff HEAD")).toBe("deny");
    expect(effectiveEffect(permissions, "read", "secrets/token")).toBe("deny");
    expect(effectiveEffect(permissions, "shell", "git status --short")).toBe("allow");
    expect(effectiveEffect(permissions, "read", "docs/guide.md")).toBe("allow");
    expect(effectiveEffect(permissions, "read", "src/index.ts")).toBe("allow");
  });

  test("reviewer permissions store no asks and evaluate to explicit allow or deny", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);

    const allowed: Array<[string, string]> = [
      ["read", "src/index.ts"],
      ["read", ".env.example"],
      ["glob", "**/*.ts"],
      ["glob", ".env.example"],
      ["grep", "src"],
      ["grep", ".env.example"],
      ["shell", "git blame src/index.ts"],
      ["shell", "git branch --show-current"],
      ["shell", "git diff HEAD"],
      ["shell", "git log -3"],
      ["shell", "git ls-files"],
      ["shell", "git merge-base HEAD main"],
      ["shell", "git rev-list HEAD"],
      ["shell", "git rev-parse HEAD"],
      ["shell", "git show HEAD"],
      ["shell", "git stash list"],
      ["shell", "git stash show"],
      ["shell", "git status --short"],
      ["shell", "gh pr view 123"],
      ["shell", "gh pr view https://github.com/capyBearista/opencode-plugins/pull/7"],
      ["shell", "gh pr diff 123"],
      ["shell", "gh pr diff https://github.com/capyBearista/opencode-plugins/pull/7"],
      ["shell", "gh auth status"],
      ["shell", "git remote -v"],
    ];
    for (const [action, resource] of allowed) {
      expect(effectiveEffect(permissions, action, resource)).toBe("allow");
    }

    const denied: Array<[string, string]> = [
      ["read", ".env"],
      ["read", "secrets/.env.production"],
      ["grep", "*.env"],
      ["grep", "secrets/.env.production"],
      ["glob", "**/.env"],
      ["glob", "**/.env.production"],
      ["shell", "git branch -D topic"],
      ["shell", "git branch -m renamed"],
      ["shell", "git branch --delete topic"],
      ["shell", "git branch --move old new"],
      ["shell", "rm -rf /"],
      ["shell", "git push origin main"],
      ["shell", "git remote add origin https://example.com/repo.git"],
      ["shell", "git remote remove origin"],
      ["shell", "gh"],
      ["shell", "gh issue list"],
      ["shell", "gh auth login"],
      ["shell", "gh auth logout"],
      ["shell", "gh auth status --show-token"],
      ["shell", "gh auth status -t"],
      ["shell", "gh repo view capyBearista/opencode-plugins"],
      ["shell", "gh pr checkout 123"],
      ["shell", "gh pr create --fill"],
      ["shell", "gh pr merge 123"],
      ["shell", "gh api /repos/owner/repo"],
      ["edit", "src/index.ts"],
      ["write", "src/index.ts"],
      ["patch", "src/index.ts"],
      ["webfetch", "https://example.com"],
      ["websearch", "anything"],
      ["subagent", "*"],
      ["question", "*"],
      ["external_directory", "/tmp/elsewhere"],
      ["skill", "*"],
      ["*", "*"],
    ];
    for (const [action, resource] of denied) {
      expect(effectiveEffect(permissions, action, resource)).toBe("deny");
    }
    expect(permissions).toContainEqual({ action: "skill", resource: "*", effect: "deny" });
  });

  test("the review agent reuses the reviewer permission set verbatim", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const adversarial = context.agents.get(REVIEWER_AGENT_ID);
    const review = context.agents.get(REVIEW_AGENT_ID);
    expect(review?.permissions).toEqual(adversarial?.permissions);

    const permissions = review?.permissions ?? [];
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);
    expect(effectiveEffect(permissions, "read", "src/index.ts")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "git diff HEAD")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "git branch --show-current")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "git branch -D topic")).toBe("deny");
    expect(effectiveEffect(permissions, "shell", "git diff HEAD --output=/tmp/review.diff")).toBe(
      "deny",
    );
    expect(effectiveEffect(permissions, "edit", "src/index.ts")).toBe("deny");
    expect(effectiveEffect(permissions, "skill", "*")).toBe("deny");
    expect(effectiveEffect(permissions, "read", ".env")).toBe("deny");
    expect(effectiveEffect(permissions, "read", ".env.example")).toBe("allow");
    expect(effectiveEffect(permissions, "*", "*")).toBe("deny");
  });

  // Local approximation of host enforcement: wildcard patterns mirror the
  // host's `Wildcard.match` (opaque string resource, backslash normalization),
  // so a quoted flag such as `--ext"-"diff` can still evade a pattern match.
  // The host shell parser splits compound commands before matching, but this
  // matcher treats the resource as one string. Safe template invocations must
  // allow; branch mutations and diff-engine flags must deny.
  test("the reviewer may run every shell block in the installed command template verbatim", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    const templateCommands = [
      "git branch --show-current",
      "git status --short --untracked-files=all",
      "git log --oneline -3",
      "git diff HEAD",
      "git ls-files --others --exclude-standard",
    ];
    expect(templateCommands).toHaveLength(5);
    for (const command of templateCommands) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const branchMutations = [
      "git branch -D topic",
      "git branch -m renamed",
      "git branch --delete topic",
      "git branch --move old new",
    ];
    for (const command of branchMutations) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  test("dangerous git diff-engine flags are denied after the git allows", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    const safe = [
      "git diff HEAD",
      "git diff --stat",
      "git show HEAD",
      "git log --oneline -3",
      "git stash show",
    ];
    for (const command of safe) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const dangerous = [
      "git diff --ext-diff",
      "git diff HEAD --textconv",
      "git diff HEAD --output=/tmp/review.diff",
      "git show HEAD --ext-diff",
      "git show --textconv HEAD",
      "git show HEAD --output /tmp/review.diff",
      "git log -p --ext-diff -1",
      "git log --textconv -1",
      "git log -1 --output=/tmp/review.log",
      "git stash show -p --ext-diff",
      "git stash show --textconv",
      "git stash show --output=/tmp/stash.diff",
    ];
    for (const command of dangerous) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  test("gh is allowlisted to the read-only PR surface only", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh pr view*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh pr diff*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*--show-token*",
      effect: "deny",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*-t*",
      effect: "deny",
    });
    expect(permissions).toContainEqual({ action: "shell", resource: "gh *", effect: "deny" });

    const allowed = [
      "gh pr view 123",
      "gh pr view https://github.com/capyBearista/opencode-plugins/pull/7",
      "gh pr diff 123",
      "gh pr diff https://github.com/capyBearista/opencode-plugins/pull/7",
      "gh auth status",
    ];
    for (const command of allowed) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("allow");
    }

    const denied = [
      "gh",
      "gh issue list",
      "gh auth login",
      "gh auth logout",
      "gh auth token",
      "gh auth status --show-token",
      "gh auth status -t",
      "gh repo view capyBearista/opencode-plugins",
      "gh pr checkout 123",
      "gh pr create --fill",
      "gh pr merge 123",
      "gh api /repos/owner/repo",
      "gh repo clone owner/repo",
    ];
    for (const command of denied) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  // The host evaluates permissions with a last-match-wins scan, so rule order
  // is load-bearing: the `gh *` catch-all must precede the specific allows, and
  // the specific allows must be ordered most-specific-last.
  test("gh deny and allow rules are ordered most-specific-last", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    const indexOf = (effect: string, resource: string) =>
      permissions.findIndex(
        (rule) => rule.action === "shell" && rule.resource === resource && rule.effect === effect,
      );
    const catchAllIndex = indexOf("deny", "gh *");
    const prViewIndex = indexOf("allow", "gh pr view*");
    const prDiffIndex = indexOf("allow", "gh pr diff*");
    const authStatusIndex = indexOf("allow", "gh auth status*");
    const showTokenIndex = indexOf("deny", "gh auth status*--show-token*");
    const shortTokenIndex = indexOf("deny", "gh auth status*-t*");

    expect(catchAllIndex).toBeGreaterThanOrEqual(0);
    expect(prViewIndex).toBeGreaterThan(catchAllIndex);
    expect(prDiffIndex).toBeGreaterThan(prViewIndex);
    expect(authStatusIndex).toBeGreaterThan(prDiffIndex);
    expect(showTokenIndex).toBeGreaterThan(authStatusIndex);
    expect(shortTokenIndex).toBeGreaterThan(authStatusIndex);
  });

  test("git remote and gh auth diagnostics are allowlisted only in their read-only forms", async () => {
    const context = createTestContext();
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "git remote -v*",
      effect: "allow",
    });
    expect(permissions).toContainEqual({
      action: "shell",
      resource: "gh auth status*",
      effect: "allow",
    });
    expect(permissions).not.toContainEqual({
      action: "shell",
      resource: "git remote *",
      effect: "allow",
    });
    expect(permissions).not.toContainEqual({
      action: "shell",
      resource: "gh repo view*",
      effect: "allow",
    });

    expect(effectiveEffect(permissions, "shell", "git remote -v")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "gh auth status")).toBe("allow");
    expect(effectiveEffect(permissions, "shell", "gh auth status --hostname github.com")).toBe(
      "allow",
    );

    const denied = [
      "git remote add origin https://example.com/repo.git",
      "git remote remove origin",
      "git remote set-url origin https://example.com/other.git",
      "git remote prune origin",
      "git remote show origin",
      "git remote --verbose",
      "gh repo view capyBearista/opencode-plugins",
      "gh auth login",
      "gh auth logout",
      "gh auth token",
      "gh auth status --show-token",
      "gh auth status -t",
      "gh auth status --show-token --hostname github.com",
    ];
    for (const command of denied) {
      expect(effectiveEffect(permissions, "shell", command)).toBe("deny");
    }
  });

  test("setup treats a missing permissions array as empty when configuring the reviewer", async () => {
    const context = createTestContext({
      agents: [
        {
          id: REVIEWER_AGENT_ID,
          permissions: undefined as unknown as TestPermission[],
        },
      ],
    });
    await setupPlugin(context);

    const permissions = context.agents.get(REVIEWER_AGENT_ID)?.permissions ?? [];
    expect(Array.isArray(permissions)).toBe(true);
    expect(permissions.some((rule) => rule.effect === "ask")).toBe(false);
    expect(effectiveEffect(permissions, "read", "src/index.ts")).toBe("allow");
    expect(effectiveEffect(permissions, "edit", "src/index.ts")).toBe("deny");
    expect(effectiveEffect(permissions, "question", "*")).toBe("deny");
  });

  test("missing agent.transform aborts setup before the command file is written", async () => {
    const context = createTestContext();
    (context.ctx.agent as { transform?: unknown }).transform = undefined;

    await expect(setupPlugin(context)).rejects.toThrow(/agent\.transform is unavailable/);
    await expect(stat(join(context.configDir, "commands", COMMAND_FILE_NAME))).rejects.toThrow();
    await expect(
      stat(join(context.configDir, "commands", REVIEW_COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });

  test("setup registers no session hooks so reviewers inherit the parent temperature", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    expect(context.hooks.size).toBe(0);
    expect(context.logs).toHaveLength(0);
    await cleanup?.();
  });

  test("setup succeeds without a session domain", async () => {
    const context = createTestContext();
    (context.ctx as { session?: unknown }).session = undefined;

    const cleanup = await setupPlugin(context);

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.agents.has(REVIEW_AGENT_ID)).toBe(true);
    expect(context.hooks.size).toBe(0);
    await cleanup?.();
  });

  test("setup diagnostics prefer a host structured log sink", async () => {
    const entries: Array<Record<string, unknown>> = [];
    const context = createTestContext({
      hostLog: (input) => {
        entries.push(input);
      },
    });
    const configDir = await isolatedConfigDirectory();
    await writeFile(join(configDir, "commands", COMMAND_FILE_NAME), "existing\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin(context, configDir);

    expect(entries).toContainEqual({
      service: PLUGIN_ID,
      level: "warn",
      message: `[${PLUGIN_ID}] ${join(configDir, "commands", COMMAND_FILE_NAME)} already exists; leaving it untouched. It may be stale or customized: edit it in place, delete it to reinstall the bundled template, or delete it after removing the plugin to uninstall.`,
    });
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
    await cleanup?.();
  });

  test("a failing host structured log sink falls back to console.warn", async () => {
    const context = createTestContext({
      hostLog: () => {
        throw new Error("sink unavailable");
      },
    });
    const configDir = await isolatedConfigDirectory();
    await writeFile(join(configDir, "commands", COMMAND_FILE_NAME), "existing\n");
    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});

    const cleanup = await setupPlugin(context, configDir);

    expect(warnSpy).toHaveBeenCalledWith(
      `[${PLUGIN_ID}] ${join(configDir, "commands", COMMAND_FILE_NAME)} already exists; leaving it untouched. It may be stale or customized: edit it in place, delete it to reinstall the bundled template, or delete it after removing the plugin to uninstall.`,
    );
    warnSpy.mockRestore();
    await cleanup?.();
  });

  test("cleanup disposes both agent registrations and registers no hooks", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(context.agents.has(REVIEWER_AGENT_ID)).toBe(true);
    expect(context.agents.has(REVIEW_AGENT_ID)).toBe(true);
    expect(context.hooks.size).toBe(0);
    expect(context.disposers.sort()).toEqual(["agent", "agent"]);
  });

  test("setup installs both command files under HOME and writes no agent file", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(result.agents.map((agent) => agent.id).sort()).toEqual(
      [REVIEWER_AGENT_ID, REVIEW_AGENT_ID].sort(),
    );
    expect(result.hooks).toEqual([]);
    expect(result.commandTransforms).toBe(0);

    const adversarialAsset = await readFile(COMMAND_ASSET_PATH, "utf8");
    expect(
      await readFile(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME), "utf8"),
    ).toBe(adversarialAsset);
    const adversarialFrontmatter = frontmatterOf(adversarialAsset);
    expect(adversarialFrontmatter.description).toBeString();
    expect(adversarialFrontmatter.description).toInclude("adversarial");
    expect(adversarialFrontmatter.description).toInclude(
      "Args: [<sha|pr-url|pr-number>] [--base <ref>] [--scope auto|working-tree|branch] [focus ...]",
    );
    expect(adversarialFrontmatter.agent).toBe(REVIEWER_AGENT_ID);
    expect(adversarialFrontmatter.subagent).toBe("true");
    expect("model" in adversarialFrontmatter).toBe(false);

    const reviewAsset = await readFile(REVIEW_COMMAND_ASSET_PATH, "utf8");
    expect(
      await readFile(
        join(home, ".config", "opencode", "commands", REVIEW_COMMAND_FILE_NAME),
        "utf8",
      ),
    ).toBe(reviewAsset);
    const reviewFrontmatter = frontmatterOf(reviewAsset);
    expect(reviewFrontmatter.description).toBeString();
    expect(reviewFrontmatter.description).toInclude("code review");
    expect(reviewFrontmatter.description).toInclude(
      "Args: [<sha|pr-url|pr-number>] [--base <ref>] [--scope auto|working-tree|branch]",
    );
    expect(reviewFrontmatter.agent).toBe(REVIEW_AGENT_ID);
    expect(reviewFrontmatter.subagent).toBe("true");
    expect("model" in reviewFrontmatter).toBe(false);
    expect(reviewAsset).toInclude("Review only: do not modify the repository");
    expect(reviewAsset).toInclude("tracking branch of HEAD, or `origin/main`, or `main`");
    expect(reviewAsset).toInclude("git merge-base HEAD <upstream>");
    expect(reviewAsset).not.toInclude("acknowledged");

    for (const asset of [adversarialAsset, reviewAsset]) {
      expect(asset).toInclude("$ARGUMENTS");
      expect(asset.match(/!`[^`]+`/g) ?? []).toHaveLength(5);
      expect(asset.match(/!`[^`]*2>&1 \|\| true`/g) ?? []).toHaveLength(5);
      for (const command of [
        "git branch --show-current",
        "git status --short",
        "git log --oneline -3",
        "git diff HEAD",
        "git ls-files --others",
      ]) {
        expect(asset).toInclude(command);
      }
      expect(asset).toInclude("GNU/Linux");
    }

    expectDeterministicResolver(adversarialAsset, RESOLVER_REMAINDER_ADVERSARIAL);
    expectDeterministicResolver(reviewAsset, RESOLVER_REMAINDER_REVIEW);

    const bunCachePrefix = join(".bun", "");
    expect((await walkFiles(home)).filter((file) => !file.startsWith(bunCachePrefix))).toEqual([
      join(".config", "opencode", "commands", COMMAND_FILE_NAME),
      join(".config", "opencode", "commands", REVIEW_COMMAND_FILE_NAME),
    ]);
  });

  test("both installed command files persist on disk after dispose", async () => {
    const context = createTestContext();
    const cleanup = await setupPlugin(context);

    await cleanup?.();

    expect(await readFile(join(context.configDir, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    expect(
      await readFile(join(context.configDir, "commands", REVIEW_COMMAND_FILE_NAME), "utf8"),
    ).toBe(await readFile(REVIEW_COMMAND_ASSET_PATH, "utf8"));
  });

  test("a second setup preserves hand-edited bytes and warns about the existing file", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });
    await runSetupInSubprocess({ home });

    const installed = join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME);
    const edited = `---\ndescription: custom review\nagent: ${REVIEWER_AGENT_ID}\nsubagent: true\n---\n\ncustom body\n`;
    await writeFile(installed, edited);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(edited);
    const diagnostics = result.logs.filter(
      (entry) =>
        entry.message.includes("leaving it untouched") && entry.message.includes(installed),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.message).toInclude("stale or customized");
    expect(diagnostics[0]?.message).toInclude("delete it");
    expect(diagnostics[0]?.message).toInclude("uninstall");
  });

  test("a pre-existing review command file keeps its bytes and warns without naming the wrong path", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    await mkdir(join(home, ".config", "opencode", "commands"), { recursive: true });
    const installed = join(home, ".config", "opencode", "commands", REVIEW_COMMAND_FILE_NAME);
    const edited = `---\ndescription: custom review\nagent: ${REVIEW_AGENT_ID}\nsubagent: true\n---\n\ncustom body\n`;
    await writeFile(installed, edited);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect(await readFile(installed, "utf8")).toBe(edited);
    const diagnostics = result.logs.filter((entry) =>
      entry.message.includes("leaving it untouched"),
    );
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.level).toBe("warn");
    expect(diagnostics[0]?.message).toInclude(installed);
    expect(diagnostics[0]?.message).toInclude("stale or customized");
    expect(
      await readFile(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME), "utf8"),
    ).toBe(await readFile(COMMAND_ASSET_PATH, "utf8"));
  });

  test("setup does not follow or replace a symlinked command path", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const decoy = join(home, "decoy.md");
    await writeFile(decoy, "decoy bytes\n");
    const installed = join(commands, COMMAND_FILE_NAME);
    await symlink(decoy, installed);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(decoy);
    expect(await readFile(decoy, "utf8")).toBe("decoy bytes\n");
  });

  test("setup does not follow or replace a symlinked review command path", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const commands = join(home, ".config", "opencode", "commands");
    await mkdir(commands, { recursive: true });
    const decoy = join(home, "review-decoy.md");
    await writeFile(decoy, "decoy bytes\n");
    const installed = join(commands, REVIEW_COMMAND_FILE_NAME);
    await symlink(decoy, installed);

    const result = await runSetupInSubprocess({ home });

    expect(result.ok).toBe(true);
    expect((await lstat(installed)).isSymbolicLink()).toBe(true);
    expect(await readlink(installed)).toBe(decoy);
    expect(await readFile(decoy, "utf8")).toBe("decoy bytes\n");
    expect(await readFile(join(commands, COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
  });

  test("OPENCODE_CONFIG_DIR targets only the override directory", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const override = await isolatedConfigDirectory();

    const result = await runSetupInSubprocess({ home, opencodeConfigDir: override });

    expect(result.ok).toBe(true);
    expect(await readFile(join(override, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    expect(await readFile(join(override, "commands", REVIEW_COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(REVIEW_COMMAND_ASSET_PATH, "utf8"),
    );
    await expect(
      stat(join(home, ".config", "opencode", "commands", COMMAND_FILE_NAME)),
    ).rejects.toThrow();
    await expect(
      stat(join(home, ".config", "opencode", "commands", REVIEW_COMMAND_FILE_NAME)),
    ).rejects.toThrow();
  });

  test("a missing commands parent fails setup with a path-bearing error and no agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const broken = join(home, "missing-config");

    const result = await runSetupInSubprocess({ home, opencodeConfigDir: broken });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(join(broken, "commands", COMMAND_FILE_NAME));
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(broken)).rejects.toThrow();
  });

  test("a writeFile permission failure fails setup loudly without registering an agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const commandPath = join(configDir, "commands", COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      writeFileError: {
        code: "EACCES",
        message: `EACCES: permission denied, open '${commandPath}'`,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(commandPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(commandPath)).rejects.toThrow();
  });

  test("a read-only filesystem review install failure registers neither agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const reviewPath = join(configDir, "commands", REVIEW_COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      writeFileError: {
        code: "EROFS",
        message: `EROFS: read-only file system, open '${reviewPath}'`,
        onlyFor: REVIEW_COMMAND_FILE_NAME,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(reviewPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(reviewPath)).rejects.toThrow();
    expect(await readFile(join(configDir, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
  });

  test("a missing packaged command template fails setup with a path-bearing error and no agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const assetPath = join(PACKAGE_ROOT, "commands", COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      readFileError: {
        code: "ENOENT",
        message: `ENOENT: no such file or directory, open '${assetPath}'`,
        onlyFor: COMMAND_FILE_NAME,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(assetPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    await expect(stat(join(configDir, "commands", COMMAND_FILE_NAME))).rejects.toThrow();
    await expect(stat(join(configDir, "commands", REVIEW_COMMAND_FILE_NAME))).rejects.toThrow();
  });

  test("an unreadable packaged review template leaves the first command on disk but registers neither agent", async () => {
    const home = await temporaryDirectory("adversarial-review-home-");
    const configDir = await isolatedConfigDirectory();
    const assetPath = join(PACKAGE_ROOT, "commands", REVIEW_COMMAND_FILE_NAME);

    const result = await runSetupInSubprocess({
      home,
      opencodeConfigDir: configDir,
      readFileError: {
        code: "EACCES",
        message: `EACCES: permission denied, open '${assetPath}'`,
        onlyFor: REVIEW_COMMAND_FILE_NAME,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.error).toInclude(assetPath);
    expect(result.error).toInclude("Neither reviewer agent was registered");
    expect(result.agents).toHaveLength(0);
    expect(await readFile(join(configDir, "commands", COMMAND_FILE_NAME), "utf8")).toBe(
      await readFile(COMMAND_ASSET_PATH, "utf8"),
    );
    await expect(stat(join(configDir, "commands", REVIEW_COMMAND_FILE_NAME))).rejects.toThrow();
  });
});
