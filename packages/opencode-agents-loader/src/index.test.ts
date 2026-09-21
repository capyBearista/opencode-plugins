import { afterEach, describe, expect, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import plugin, {
  convertAgent,
  parseMarkdown,
  registerPlugin,
  startAgentBridge,
  startCommandBridge,
  syncAgentLinks,
  syncCommandLinks,
} from "./index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "opencode-agents-loader-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function markdown(
  directory: string,
  relativePath: string,
  data: Record<string, unknown>,
  content: string,
) {
  const file = path.join(directory, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `---\n${yaml(data)}---\n${content}\n`);
}

function yaml(data: Record<string, unknown>) {
  return Object.entries(data)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === "string" ? JSON.stringify(value) : JSON.stringify(value)}\n`,
    )
    .join("");
}

function location(directory: string, projectDirectory = directory) {
  return {
    directory,
    project: { id: "project", directory: projectDirectory, canonical: projectDirectory },
  };
}

async function expectPathMissing(filePath: string) {
  await expect(lstat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("@capybearista/opencode-agents-loader", () => {
  test("exports a V2 setup definition", () => {
    expect(plugin.id).toBe("capybearista.opencode-agents-loader");
    expect(plugin.setup).toBeFunction();
    expect("server" in plugin).toBe(false);
  });

  test("real V2 host resolves the package root server wrapper and preserves named package mapping", () => {
    const packageRoot = path.resolve(import.meta.dir, "..");
    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `
          import * as Host from "@opencode/plugin/host";
          const root = ${JSON.stringify(packageRoot)};
          const local = Host.resolve({ directory: root });
          const named = Host.resolve({ directory: root, name: "@capybearista/opencode-agents-loader" });
          process.stdout.write(JSON.stringify({
            local: { server: local.server ?? null, tui: local.tui ?? null, rpc: local.rpc ?? null },
            named: { server: named.server ?? null, tui: named.tui ?? null, rpc: named.rpc ?? null },
          }));
        `,
      ],
      cwd: packageRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }

    expect(JSON.parse(new TextDecoder().decode(child.stdout))).toEqual({
      local: {
        server: pathToFileURL(path.join(packageRoot, "server.js")).href,
        tui: null,
        rpc: null,
      },
      named: {
        server: pathToFileURL(path.join(packageRoot, "dist", "index.js")).href,
        tui: null,
        rpc: null,
      },
    });
  });

  test("root server wrapper preserves the compiled default and stays inert on import", async () => {
    const packageRoot = path.resolve(import.meta.dir, "..");
    const wrapper = await import("../server.js");
    const compiled = await import("../dist/index.js");

    expect(Object.keys(wrapper)).toEqual(["default"]);
    expect(wrapper.default).toBe(compiled.default);
    expect(wrapper.default.id).toBe("capybearista.opencode-agents-loader");

    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const config = path.join(root, "config");
    const cwd = path.join(root, "cwd");
    await mkdir(cwd, { recursive: true });

    const child = Bun.spawnSync({
      cmd: [
        "node",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(path.join(packageRoot, "server.js"))});`,
      ],
      cwd,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: config,
        OPENCODE_CONFIG_DIR: config,
        PATH: process.env.PATH ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }
    await expectPathMissing(home);
    await expectPathMissing(config);
    await expectPathMissing(path.join(cwd, ".opencode"));
  });

  test("B1 module import is filesystem-inert in an isolated child", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const config = path.join(root, "config");
    const cwd = path.join(root, "cwd");
    await mkdir(cwd, { recursive: true });

    const modulePath = path.join(import.meta.dir, "index.ts");
    const child = Bun.spawnSync({
      cmd: [process.execPath, "-e", `await import(${JSON.stringify(modulePath)});`],
      cwd,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: config,
        OPENCODE_CONFIG_DIR: config,
        PATH: process.env.PATH ?? "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });

    if (child.exitCode !== 0) {
      throw new Error(new TextDecoder().decode(child.stderr));
    }
    expect(await readdir(home)).toEqual([".bun"]);
    await expectPathMissing(config);
    await expectPathMissing(path.join(cwd, ".opencode"));
  });

  test("B1 setup materializes project commands without a command transform", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "commands", "review.md");
    await markdown(path.join(project, ".agents"), "commands/review.md", {}, "Run !`printf native`");

    let commandTransforms = 0;
    const context = {
      location: location(project),
      agent: { transform: async () => ({ dispose: async () => {} }) },
      command: {
        transform: async () => {
          commandTransforms++;
          return { dispose: async () => {} };
        },
        reload: async () => {},
      },
    } as never;

    const cleanup = await registerPlugin(context, { home, environment: {} });

    expect(commandTransforms).toBe(0);
    expect(await readlink(path.join(project, ".opencode", "commands", "review.md"))).toBe(
      path.relative(path.join(project, ".opencode", "commands"), source),
    );
    expect(
      (await lstat(path.join(project, ".opencode", "commands", "review.md"))).isSymbolicLink(),
    ).toBe(true);
    await cleanup();
  });

  test("B8 agent baseline keeps the frontmatter fallback sanitizer", async () => {
    const root = await temporaryDirectory();
    const file = path.join(root, "agent.md");
    await writeFile(file, "---\ndescription: provider: model\n---\nBody\n");

    const parsed = await parseMarkdown(file);

    expect(parsed.data.description).toBe("provider: model");
    expect(parsed.content).toBe("Body");
  });

  test("B8 agent baseline converts metadata without widening permissions", () => {
    const direct = convertAgent("reviewer", {
      data: {
        model: "anthropic/claude#fast",
        description: "Reviews changes",
        mode: "subagent",
        request: {
          headers: { "x-review": "enabled" },
          body: { effort: "high" },
        },
        permissions: [{ action: "shell", resource: "git *", effect: "deny" }],
      },
      content: "Review this carefully",
    });

    expect(direct).toMatchObject({
      system: "Review this carefully",
      model: { providerID: "anthropic", id: "claude", variant: "fast" },
      description: "Reviews changes",
      mode: "subagent",
      request: {
        headers: { "x-review": "enabled" },
        body: { effort: "high" },
      },
      permissions: [{ action: "shell", resource: "git *", effect: "deny" }],
    });
    expect(
      convertAgent(
        "paths",
        {
          data: { permissions: [{ action: "read", resource: "~/private/**", effect: "deny" }] },
          content: "Paths",
        },
        "/tmp/isolated-home",
      )?.permissions,
    ).toEqual([{ action: "read", resource: "/tmp/isolated-home/private/**", effect: "deny" }]);
    expect(
      convertAgent("settings", {
        data: { request: { settings: { temperature: 0.3 } } },
        content: "Unsupported settings",
      }),
    ).toBeUndefined();

    const legacy = convertAgent("legacy", {
      data: {
        model: "openai/gpt-4",
        variant: "fast",
        tools: { read: true, bash: false },
        permission: { edit: "deny" },
        temperature: 0.2,
        maxSteps: 3,
      },
      content: "Legacy instructions",
    });

    expect(legacy).toMatchObject({
      system: "Legacy instructions",
      model: { providerID: "openai", id: "gpt-4", variant: "fast" },
      request: { body: { temperature: 0.2 } },
      steps: 3,
    });
    expect(legacy?.permissions).toEqual([
      { action: "read", resource: "*", effect: "allow" },
      { action: "shell", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ]);
    expect(
      convertAgent("mixed-permissions", {
        data: {
          tools: { read: true },
          permissions: [{ action: "shell", resource: "*", effect: "deny" }],
        },
        content: "Mixed permission dialects",
      }),
    ).toBeUndefined();
    expect(
      convertAgent("empty-variant", {
        data: { model: "openai/gpt-4", variant: "", tools: {} },
        content: "Legacy instructions",
      })?.model,
    ).toEqual({ providerID: "openai", id: "gpt-4" });
    expect(
      convertAgent("bad-legacy-model", {
        data: { model: { providerID: "openai", model: "gpt-4" }, tools: {} },
        content: "Invalid model",
      }),
    ).toBeUndefined();
    expect(
      convertAgent("bad-permission", {
        data: { permission: { shell: "not-a-permission" } },
        content: "unsafe fallback",
      }),
    ).toBeUndefined();
    expect(
      convertAgent("unknown-permission", {
        data: { "allowed-tools": ["shell"] },
        content: "unsafe fallback",
      }),
    ).toBeUndefined();
    expect(
      convertAgent("camel-case-permission", {
        data: { allowedTools: ["shell"] },
        content: "unsafe fallback",
      }),
    ).toBeUndefined();
    expect(
      convertAgent("disabled", { data: { disabled: true }, content: "not loaded" }),
    ).toMatchObject({ disabled: true });
  });

  test("B8 agent baseline does not field-merge lower-priority agents", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await markdown(
      path.join(project, ".agents"),
      "agents/same.md",
      { permissions: [{ action: "*", resource: "*", effect: "deny" }] },
      "lower",
    );
    await markdown(
      path.join(project, ".opencode"),
      "agents/same.md",
      { description: "native" },
      "native",
    );

    let agentTransform: ((editor: Record<string, unknown>) => void) | undefined;
    const context = {
      location: location(project),
      agent: {
        transform: async (callback: (editor: Record<string, unknown>) => void) => {
          agentTransform = callback;
          return { dispose: async () => {} };
        },
      },
      command: {
        reload: async () => {},
      },
    } as never;

    const cleanup = await registerPlugin(context, { home, environment: {} });
    let updates = 0;
    agentTransform?.({
      update: () => void updates++,
      get: () => undefined,
      list: () => [],
      remove: () => {},
      default: () => {},
    });

    expect(updates).toBe(0);
    await cleanup();
  });

  test("B3 materializes command bytes for native execution", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "commands", "nested", "shell.md");
    const content = "---\nsubagent: true\n---\nRun !`printf native` with $ARGUMENTS\n";
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, content);

    let commandTransforms = 0;
    const context = {
      location: location(project),
      agent: { transform: async () => ({ dispose: async () => {} }) },
      command: {
        transform: async () => {
          commandTransforms++;
          return { dispose: async () => {} };
        },
        reload: async () => {},
      },
    } as never;

    const cleanup = await registerPlugin(context, { home, environment: {} });
    const destination = path.join(project, ".opencode", "commands", "nested", "shell.md");
    expect(commandTransforms).toBe(0);
    expect(await readFile(destination, "utf8")).toBe(content);
    expect(await readlink(destination)).toBe(path.relative(path.dirname(destination), source));
    await cleanup();
  });

  test("B2 applies nearest-scope and native precedence without flattening scopes", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const nested = path.join(project, "packages", "demo");
    const globalConfig = path.join(home, "custom-config");

    await markdown(path.join(home, ".agents"), "commands/global.md", {}, "global");
    await markdown(
      path.join(home, ".agents"),
      "commands/global-native.md",
      {},
      "global native source",
    );
    await markdown(path.join(project, ".agents"), "command/alias.md", {}, "singular");
    await markdown(path.join(project, ".agents"), "commands/alias.md", {}, "plural");
    await markdown(path.join(project, ".agents"), "commands/near.md", {}, "ancestor agent");
    await markdown(
      path.join(project, ".agents"),
      "commands/global-native.md",
      {},
      "project beats global native",
    );
    await markdown(
      path.join(project, ".agents"),
      "commands/json-reserved.md",
      {},
      "reserved by config",
    );
    await markdown(
      path.join(project, ".agents"),
      "commands/singular-json-reserved.md",
      {},
      "reserved by singular config",
    );
    await markdown(
      path.join(project, ".agents"),
      "commands/disabled-json-reserved.md",
      {},
      "reserved by disabled config",
    );
    await markdown(
      path.join(project, ".agents"),
      "commands/malformed-json-reserved.md",
      {},
      "reserved by malformed config",
    );
    await markdown(path.join(nested, ".agents"), "commands/near.md", {}, "nearer agent");
    await markdown(path.join(nested, ".agents"), "commands/nested/name.md", {}, "nested name");
    await markdown(path.join(nested, ".agents"), "commands/same-scope-native.md", {}, "suppressed");
    await mkdir(path.join(project, ".opencode", "commands"), { recursive: true });
    await mkdir(path.join(project, ".opencode", "command"), { recursive: true });
    await writeFile(path.join(project, ".opencode", "command", "near.md"), "native ancestor");
    await mkdir(path.join(nested, ".opencode", "command"), { recursive: true });
    await writeFile(path.join(nested, ".opencode", "command", "same-scope-native.md"), "native");
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify({
        commands: {
          "json-reserved": {},
          "disabled-json-reserved": { disabled: true },
          "malformed-json-reserved": null,
        },
        command: { "singular-json-reserved": {} },
      }),
    );
    await mkdir(path.join(globalConfig, "commands"), { recursive: true });
    await writeFile(path.join(globalConfig, "commands", "global-native.md"), "global native");

    const result = await syncCommandLinks(location(nested, project), {
      home,
      environment: { OPENCODE_CONFIG_DIR: globalConfig },
    });

    expect(result.safe).toBe(true);
    expect(await readFile(path.join(project, ".opencode", "commands", "alias.md"), "utf8")).toBe(
      await readFile(path.join(project, ".agents", "commands", "alias.md"), "utf8"),
    );
    expect(await readlink(path.join(nested, ".opencode", "commands", "near.md"))).toBe(
      path.relative(
        path.join(nested, ".opencode", "commands"),
        path.join(nested, ".agents", "commands", "near.md"),
      ),
    );
    expect(
      await readlink(path.join(nested, ".opencode", "commands", "nested", "name.md")),
    ).toContain(".agents");
    await expectPathMissing(path.join(project, ".opencode", "commands", "near.md"));
    await expectPathMissing(path.join(project, ".opencode", "commands", "json-reserved.md"));
    await expectPathMissing(
      path.join(project, ".opencode", "commands", "singular-json-reserved.md"),
    );
    await expectPathMissing(
      path.join(project, ".opencode", "commands", "disabled-json-reserved.md"),
    );
    await expectPathMissing(
      path.join(project, ".opencode", "commands", "malformed-json-reserved.md"),
    );
    await expectPathMissing(path.join(nested, ".opencode", "commands", "same-scope-native.md"));
    expect(
      await readlink(path.join(project, ".opencode", "commands", "global-native.md")),
    ).toContain(".agents");
    expect(await readlink(path.join(globalConfig, "commands", "global.md"))).toContain(".agents");
    expect(await readFile(path.join(globalConfig, "commands", "global-native.md"), "utf8")).toBe(
      "global native",
    );
  });

  test("B4 records only created links and preserves unowned collisions and originals", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const destinationRoot = path.join(project, ".opencode", "commands");
    const unownedSource = path.join(project, ".agents", "commands", "unowned.md");
    await markdown(path.join(project, ".agents"), "commands/unowned.md", {}, "unowned source");
    await markdown(path.join(project, ".agents"), "commands/native.md", {}, "agent source");
    await mkdir(destinationRoot, { recursive: true });
    await symlink(
      path.relative(destinationRoot, unownedSource),
      path.join(destinationRoot, "unowned.md"),
    );
    await mkdir(path.join(project, ".opencode", "command"), { recursive: true });
    const nativePath = path.join(project, ".opencode", "command", "native.md");
    await writeFile(nativePath, "native original");

    const result = await syncCommandLinks(location(project), { home, environment: {} });

    expect(result.safe).toBe(true);
    expect(await readlink(path.join(destinationRoot, "unowned.md"))).toBe(
      path.relative(destinationRoot, unownedSource),
    );
    expect(await readFile(nativePath, "utf8")).toBe("native original");
    const manifest = JSON.parse(
      await readFile(path.join(project, ".opencode", ".agents-loader", "commands-manifest.json")),
    );
    expect(manifest.links).toEqual([]);
  });

  test("B5 cleans owned stale links but fails closed for malformed manifests and unsafe paths", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await markdown(path.join(project, ".agents"), "commands/stale.md", {}, "stale");
    await syncCommandLinks(location(project), { home, environment: {} });
    const destination = path.join(project, ".opencode", "commands", "stale.md");
    await unlink(path.join(project, ".agents", "commands", "stale.md"));
    await syncCommandLinks(location(project), { home, environment: {} });
    await expectPathMissing(destination);

    await markdown(path.join(project, ".agents"), "commands/replaced.md", {}, "source");
    await syncCommandLinks(location(project), { home, environment: {} });
    const replaced = path.join(project, ".opencode", "commands", "replaced.md");
    await unlink(replaced);
    await writeFile(replaced, "user file");
    await unlink(path.join(project, ".agents", "commands", "replaced.md"));
    await syncCommandLinks(location(project), { home, environment: {} });
    expect(await readFile(replaced, "utf8")).toBe("user file");

    await writeFile(
      path.join(project, ".opencode", ".agents-loader", "commands-manifest.json"),
      "not json",
    );
    await markdown(path.join(project, ".agents"), "commands/protected.md", {}, "protected");
    const unsafe = await syncCommandLinks(location(project), { home, environment: {} });
    expect(unsafe.safe).toBe(false);
    expect(await readFile(path.join(project, ".opencode", "commands", "replaced.md"), "utf8")).toBe(
      "user file",
    );

    const escapeManifest = JSON.stringify({
      version: 1,
      destination: "commands",
      links: [
        {
          destination: "../escape.md",
          source: path.join(project, ".agents", "commands", "gone.md"),
          target: "../../.agents/commands/gone.md",
        },
      ],
    });
    await writeFile(
      path.join(project, ".opencode", ".agents-loader", "commands-manifest.json"),
      escapeManifest,
    );
    const traversal = await syncCommandLinks(location(project), { home, environment: {} });
    expect(traversal.safe).toBe(false);

    const escapedProject = path.join(root, "escaped-project");
    const outside = path.join(root, "outside");
    await markdown(path.join(escapedProject, ".agents"), "commands/outside.md", {}, "outside");
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(escapedProject, ".opencode"));
    const escaped = await syncCommandLinks(location(escapedProject), { home, environment: {} });
    expect(escaped.safe).toBe(false);
    await expectPathMissing(path.join(outside, "commands", "outside.md"));

    const unreadableProject = path.join(root, "unreadable-project");
    await markdown(path.join(unreadableProject, ".agents"), "commands/keep.md", {}, "keep");
    await syncCommandLinks(location(unreadableProject), { home, environment: {} });
    const keptLink = path.join(unreadableProject, ".opencode", "commands", "keep.md");
    await rm(path.join(unreadableProject, ".agents", "commands"), { recursive: true, force: true });
    await symlink(outside, path.join(unreadableProject, ".agents", "commands"));
    const unreadable = await syncCommandLinks(location(unreadableProject), {
      home,
      environment: {},
    });
    expect(unreadable.safe).toBe(false);
    expect((await lstat(keptLink)).isSymbolicLink()).toBe(true);

    const symlinkFileProject = path.join(root, "symlink-file-project");
    const symlinkFile = path.join(symlinkFileProject, ".agents", "commands", "keep.md");
    await markdown(path.join(symlinkFileProject, ".agents"), "commands/keep.md", {}, "keep");
    await syncCommandLinks(location(symlinkFileProject), { home, environment: {} });
    const symlinkFileDestination = path.join(
      symlinkFileProject,
      ".opencode",
      "commands",
      "keep.md",
    );
    const linkedSource = path.join(outside, "linked-source.md");
    await writeFile(linkedSource, "outside source");
    await unlink(symlinkFile);
    await symlink(linkedSource, symlinkFile);
    const sourceDiagnostics: string[] = [];
    const sourceSymlink = await syncCommandLinks(location(symlinkFileProject), {
      home,
      environment: {},
      diagnostics: (message) => sourceDiagnostics.push(message),
    });
    expect(sourceSymlink.safe).toBe(false);
    expect((await lstat(symlinkFileDestination)).isSymbolicLink()).toBe(true);
    expect(
      sourceDiagnostics.some((message) => message.includes("source symlink is not allowed")),
    ).toBe(true);
  });

  test("follow-up rejects nested destination parent escapes before stale cleanup", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const outside = path.join(root, "outside");
    const source = path.join(project, ".agents", "commands", "nested", "stale.md");
    const destinationRoot = path.join(project, ".opencode", "commands");
    const nestedDestination = path.join(destinationRoot, "nested");
    const outsideLink = path.join(outside, "stale.md");

    await markdown(path.join(project, ".agents"), "commands/nested/stale.md", {}, "stale");
    await syncCommandLinks(location(project), { home, environment: {} });
    const manifest = JSON.parse(
      await readFile(path.join(project, ".opencode", ".agents-loader", "commands-manifest.json")),
    );
    const recorded = manifest.links.find(
      (link: { destination: string }) => link.destination === "nested/stale.md",
    );
    expect(recorded).toBeDefined();

    await unlink(source);
    await rm(nestedDestination, { recursive: true, force: true });
    await mkdir(outside, { recursive: true });
    await symlink(recorded.target, outsideLink);
    await symlink(outside, nestedDestination);

    const result = await syncCommandLinks(location(project), { home, environment: {} });

    expect(result.safe).toBe(false);
    expect(await readlink(outsideLink)).toBe(recorded.target);
  });

  test("follow-up fails closed on a preexisting lock without changing scope state", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "commands", "stale.md");
    await markdown(path.join(project, ".agents"), "commands/stale.md", {}, "stale");
    await syncCommandLinks(location(project), { home, environment: {} });

    const destination = path.join(project, ".opencode", "commands", "stale.md");
    const manifestPath = path.join(
      project,
      ".opencode",
      ".agents-loader",
      "commands-manifest.json",
    );
    const manifestBefore = await readFile(manifestPath, "utf8");
    const lockPath = path.join(project, ".opencode", ".agents-loader", "commands.lock");
    await unlink(source);
    await writeFile(lockPath, "held-by-crashed-instance");

    const diagnostics: string[] = [];
    const result = await syncCommandLinks(location(project), {
      home,
      environment: {},
      diagnostics: (message) => diagnostics.push(message),
      lockAttempts: 1,
      lockDelayMs: 0,
    });

    expect(result.safe).toBe(false);
    expect(result.changed).toBe(false);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(await readlink(destination)).toContain(".agents");
    expect(await readFile(lockPath, "utf8")).toBe("held-by-crashed-instance");
    expect(diagnostics.some((message) => message.includes(lockPath))).toBe(true);
    expect(
      diagnostics.some((message) =>
        message.includes("only after all affected OpenCode instances are stopped"),
      ),
    ).toBe(true);
  });

  test("follow-up serializes overlapping ancestor and nested cooperating syncs", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const nested = path.join(project, "packages", "demo");
    await markdown(path.join(project, ".agents"), "commands/root.md", {}, "root");
    await markdown(path.join(nested, ".agents"), "commands/nested.md", {}, "nested");

    const [nestedResult, rootResult] = await Promise.all([
      syncCommandLinks(location(nested, project), { home, environment: {} }),
      syncCommandLinks(location(project), { home, environment: {} }),
    ]);

    expect(nestedResult.safe).toBe(true);
    expect(rootResult.safe).toBe(true);
    expect(await readlink(path.join(project, ".opencode", "commands", "root.md"))).toContain(
      ".agents",
    );
    expect(await readlink(path.join(nested, ".opencode", "commands", "nested.md"))).toContain(
      ".agents",
    );
  });

  test("follow-up rejects a cwd outside the project root without writing roots", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const outside = path.join(root, "outside-cwd");
    const globalConfig = path.join(root, "global-config");
    await markdown(path.join(project, ".agents"), "commands/root.md", {}, "root");
    await mkdir(outside, { recursive: true });
    const diagnostics: string[] = [];

    const result = await syncCommandLinks(location(outside, project), {
      home,
      environment: { OPENCODE_CONFIG_DIR: globalConfig },
      diagnostics: (message) => diagnostics.push(message),
    });

    expect(result.safe).toBe(false);
    expect(result.changed).toBe(false);
    await expectPathMissing(path.join(project, ".opencode"));
    await expectPathMissing(globalConfig);
    expect(diagnostics.some((message) => message.includes("outside project root"))).toBe(true);
  });

  test("follow-up suppresses consecutive duplicate unsafe scheduler diagnostics", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    await markdown(path.join(project, ".agents"), "commands/blocked.md", {}, "blocked");
    const manifestDirectory = path.join(project, ".opencode", ".agents-loader");
    const lockPath = path.join(manifestDirectory, "commands.lock");
    await mkdir(manifestDirectory, { recursive: true });
    await writeFile(lockPath, "held");

    let scheduledCallback: (() => void | Promise<void>) | undefined;
    const scheduler = {
      setInterval: (callback: () => void | Promise<void>) => {
        scheduledCallback = callback;
        return "timer";
      },
      clearInterval: () => {},
    };
    const diagnostics: string[] = [];
    const context = {
      location: location(project),
      command: { reload: async () => {} },
    } as never;
    const bridge = await startCommandBridge(context, {
      home,
      environment: {},
      scheduler,
      diagnostics: (message) => diagnostics.push(message),
      lockAttempts: 1,
      lockDelayMs: 0,
    });

    await scheduledCallback?.();
    await scheduledCallback?.();
    await bridge.dispose();

    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain(lockPath);
  });

  test("B6 is idempotent, isolates global and project roots, and serializes cooperating syncs", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const globalConfig = path.join(root, "global-config");
    await markdown(path.join(home, ".agents"), "commands/global.md", {}, "global");
    await markdown(path.join(project, ".agents"), "commands/project.md", {}, "project");
    const options = { home, environment: { OPENCODE_CONFIG_DIR: globalConfig } };

    const first = await syncCommandLinks(location(project), options);
    const manifestPath = path.join(
      project,
      ".opencode",
      ".agents-loader",
      "commands-manifest.json",
    );
    const before = await readFile(manifestPath, "utf8");
    const second = await syncCommandLinks(location(project), options);
    const after = await readFile(manifestPath, "utf8");
    const concurrent = await Promise.all([
      syncCommandLinks(location(project), options),
      syncCommandLinks(location(project), options),
    ]);

    expect(first.safe).toBe(true);
    expect(second.changed).toBe(false);
    expect(after).toBe(before);
    expect(concurrent.every((item) => item.safe)).toBe(true);
    expect(await readlink(path.join(globalConfig, "commands", "global.md"))).toContain(".agents");
    expect(await readlink(path.join(project, ".opencode", "commands", "project.md"))).toContain(
      ".agents",
    );
  });

  test("B7 source-syncs bounded changes and disposes its timer", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "commands", "reload.md");
    await markdown(path.join(project, ".agents"), "commands/reload.md", {}, "first");
    let reloads = 0;
    let timerCleared = false;
    let scheduledCallback: (() => void | Promise<void>) | undefined;
    const scheduler = {
      setInterval: (callback: () => void | Promise<void>) => {
        scheduledCallback = callback;
        return "timer";
      },
      clearInterval: (handle: unknown) => {
        timerCleared = handle === "timer";
      },
    };
    const context = {
      location: location(project),
      command: { reload: async () => void reloads++ },
    } as never;

    const bridge = await startCommandBridge(context, { home, environment: {}, scheduler });
    expect(scheduledCallback).toBeDefined();
    await scheduledCallback?.();
    expect(reloads).toBe(0);
    await writeFile(source, "---\n---\nsecond\n");
    await scheduledCallback?.();
    expect(reloads).toBe(1);
    await scheduledCallback?.();
    expect(reloads).toBe(1);
    await unlink(source);
    await scheduledCallback?.();
    expect(reloads).toBe(2);
    await writeFile(source, "---\n---\ncreated\n");
    await scheduledCallback?.();
    expect(reloads).toBe(3);
    const renamed = path.join(project, ".agents", "commands", "renamed.md");
    await rename(source, renamed);
    await scheduledCallback?.();
    expect(reloads).toBe(4);
    await expectPathMissing(path.join(project, ".opencode", "commands", "reload.md"));
    expect(await readlink(path.join(project, ".opencode", "commands", "renamed.md"))).toContain(
      ".agents",
    );
    const nativeCollision = path.join(project, ".opencode", "command", "renamed.md");
    await mkdir(path.dirname(nativeCollision), { recursive: true });
    await writeFile(nativeCollision, "native");
    await scheduledCallback?.();
    expect(reloads).toBe(5);
    await expectPathMissing(path.join(project, ".opencode", "commands", "renamed.md"));
    await unlink(nativeCollision);
    await scheduledCallback?.();
    expect(reloads).toBe(6);
    expect(await readlink(path.join(project, ".opencode", "commands", "renamed.md"))).toContain(
      ".agents",
    );
    await bridge.dispose();
    expect(timerCleared).toBe(true);
    await scheduledCallback?.();
    expect(reloads).toBe(6);
  });

  test("B9 setup materializes native agent bytes without an agent transform", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "agents", "reviewer.md");
    const content =
      '---\nmodel: anthropic/claude#fast\nrequest:\n  headers:\n    x-agent: native\n  body:\n    effort: high\npermissions:\n  - action: edit\n    resource: "*"\n    effect: deny\nmode: subagent\n---\nKeep this prompt byte-identical.\n';
    await mkdir(path.dirname(source), { recursive: true });
    await writeFile(source, content);

    let agentTransforms = 0;
    const context = {
      location: location(project),
      agent: {
        transform: async () => {
          agentTransforms++;
          return { dispose: async () => {} };
        },
        reload: async () => {},
      },
      command: { reload: async () => {} },
    } as never;

    const cleanup = await registerPlugin(context, { home, environment: {} });
    const destination = path.join(project, ".opencode", "agents", "reviewer.md");

    expect(agentTransforms).toBe(0);
    expect(await readlink(destination)).toBe(path.relative(path.dirname(destination), source));
    expect(await readFile(destination, "utf8")).toBe(content);
    await cleanup();
  });

  test("B10 materializes every agent scope and leaves native precedence to OpenCode", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const nested = path.join(project, "packages", "demo");
    const globalConfig = path.join(root, "global-config");

    await markdown(path.join(home, ".agents"), "agents/shared.md", {}, "global shared");
    await markdown(path.join(home, ".agents"), "agents/global-only.md", {}, "global only");
    await markdown(path.join(home, ".agents"), "agents/global-native.md", {}, "global source");
    await markdown(path.join(project, ".agents"), "agents/shared.md", {}, "project shared");
    await markdown(path.join(project, ".agents"), "agents/project-only.md", {}, "project only");
    await markdown(
      path.join(project, ".agents"),
      "agents/json-project-reserved.md",
      {},
      "suppressed",
    );
    await markdown(
      path.join(project, ".agents"),
      "agents/singular-agent-json-reserved.md",
      {},
      "suppressed",
    );
    await markdown(
      path.join(project, ".agents"),
      "agents/disabled-agent-json-reserved.md",
      {},
      "suppressed",
    );
    await markdown(
      path.join(project, ".agents"),
      "agents/malformed-agent-json-reserved.md",
      {},
      "suppressed",
    );
    await markdown(path.join(project, ".agents"), "agents/mode-json-reserved.md", {}, "suppressed");
    await markdown(
      path.join(project, ".agents"),
      "agents/global-native.md",
      {},
      "project beats global native",
    );
    await markdown(path.join(nested, ".agents"), "agents/shared.md", {}, "nested shared");
    await markdown(path.join(nested, ".agents"), "agents/native.md", {}, "suppressed");
    await markdown(path.join(nested, ".agents"), "agents/json-reserved.md", {}, "suppressed");
    await markdown(path.join(nested, ".agents"), "agents/mode-reserved.md", {}, "suppressed");
    await markdown(path.join(nested, ".agents"), "modes/not-a-source.md", {}, "not an agent");

    await mkdir(path.join(globalConfig, "agents"), { recursive: true });
    await writeFile(path.join(globalConfig, "agents", "global-native.md"), "native original");
    await markdown(path.join(nested, ".opencode"), "agent/native.md", {}, "native");
    await markdown(path.join(nested, ".opencode"), "mode/mode-reserved.md", {}, "native mode");
    await writeFile(
      path.join(project, "opencode.json"),
      JSON.stringify({
        agents: {
          "json-reserved": {},
          "json-project-reserved": {},
          "disabled-agent-json-reserved": { disabled: true },
          "malformed-agent-json-reserved": null,
        },
        agent: { "singular-agent-json-reserved": {} },
        mode: { "mode-json-reserved": {} },
      }),
    );

    const result = await syncAgentLinks(location(nested, project), {
      home,
      environment: { OPENCODE_CONFIG_DIR: globalConfig },
    });

    expect(result.safe).toBe(true);
    expect(await readlink(path.join(globalConfig, "agents", "shared.md"))).toContain(
      path.join(".agents", "agents", "shared.md"),
    );
    expect(await readlink(path.join(globalConfig, "agents", "global-only.md"))).toContain(
      path.join(".agents", "agents", "global-only.md"),
    );
    expect(await readFile(path.join(globalConfig, "agents", "global-native.md"), "utf8")).toBe(
      "native original",
    );

    expect(await readFile(path.join(project, ".opencode", "agents", "shared.md"), "utf8")).toBe(
      await readFile(path.join(project, ".agents", "agents", "shared.md"), "utf8"),
    );
    expect(
      await readFile(path.join(project, ".opencode", "agents", "global-native.md"), "utf8"),
    ).toBe(await readFile(path.join(project, ".agents", "agents", "global-native.md"), "utf8"));
    await expectPathMissing(path.join(project, ".opencode", "agents", "json-project-reserved.md"));
    await expectPathMissing(
      path.join(project, ".opencode", "agents", "singular-agent-json-reserved.md"),
    );
    await expectPathMissing(
      path.join(project, ".opencode", "agents", "disabled-agent-json-reserved.md"),
    );
    await expectPathMissing(
      path.join(project, ".opencode", "agents", "malformed-agent-json-reserved.md"),
    );
    await expectPathMissing(path.join(project, ".opencode", "agents", "mode-json-reserved.md"));
    expect(await readlink(path.join(nested, ".opencode", "agents", "shared.md"))).toContain(
      path.join(".agents", "agents", "shared.md"),
    );
    await expectPathMissing(path.join(nested, ".opencode", "agents", "native.md"));
    expect(await readlink(path.join(nested, ".opencode", "agents", "json-reserved.md"))).toContain(
      path.join(".agents", "agents", "json-reserved.md"),
    );
    await expectPathMissing(path.join(nested, ".opencode", "agents", "mode-reserved.md"));
    await expectPathMissing(path.join(nested, ".opencode", "agents", "not-a-source.md"));
  });

  test("B11 validates native V1 and V2 bodies before linking and removes invalid stale links", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const legacy = path.join(project, ".agents", "agent", "legacy.md");
    const modern = path.join(project, ".agents", "agents", "modern.md");
    const legacyContent = `---
model: openai/gpt-4
variant: fast
tools:
  read: true
permission:
  edit: deny
options:
  effort: high
temperature: 0.2
disable: false
---
Legacy prompt with exact bytes.
`;
    const modernContent = `---
model:
  providerID: anthropic
  model: claude
  variant: fast
request:
  headers:
    x-agent: native
  body:
    effort: high
permissions:
  - action: read
    resource: "*"
    effect: deny
mode: subagent
---
Modern prompt with exact bytes.
`;
    await mkdir(path.dirname(legacy), { recursive: true });
    await mkdir(path.dirname(modern), { recursive: true });
    await writeFile(legacy, legacyContent);
    await writeFile(modern, modernContent);

    const diagnostics: string[] = [];
    const first = await syncAgentLinks(location(project), {
      home,
      environment: {},
      diagnostics: (message) => diagnostics.push(message),
    });

    expect(first.safe).toBe(true);
    expect(await readFile(path.join(project, ".opencode", "agents", "legacy.md"), "utf8")).toBe(
      legacyContent,
    );
    expect(await readFile(path.join(project, ".opencode", "agents", "modern.md"), "utf8")).toBe(
      modernContent,
    );

    const invalidContent = `---
request:
  settings:
    temperature: 0.9
---
Unsafe settings.
`;
    await writeFile(modern, invalidContent);
    const invalidResult = await syncAgentLinks(location(project), {
      home,
      environment: {},
      diagnostics: (message) => diagnostics.push(message),
    });

    expect(invalidResult.safe).toBe(true);
    await expectPathMissing(path.join(project, ".opencode", "agents", "modern.md"));
    expect(await readFile(modern, "utf8")).toBe(invalidContent);
    expect(diagnostics.some((message) => message.includes("request.settings"))).toBe(true);

    await writeFile(modern, modernContent);
    const restored = await syncAgentLinks(location(project), {
      home,
      environment: {},
      diagnostics: (message) => diagnostics.push(message),
    });
    expect(restored.safe).toBe(true);
    expect(await readFile(path.join(project, ".opencode", "agents", "modern.md"), "utf8")).toBe(
      modernContent,
    );

    const mixedContent = `---
tools:
  read: true
permissions:
  - action: shell
    resource: "*"
    effect: deny
---
Mixed permission dialects.
`;
    await writeFile(modern, mixedContent);
    const mixedResult = await syncAgentLinks(location(project), {
      home,
      environment: {},
      diagnostics: (message) => diagnostics.push(message),
    });

    expect(mixedResult.safe).toBe(true);
    await expectPathMissing(path.join(project, ".opencode", "agents", "modern.md"));
    expect(await readFile(modern, "utf8")).toBe(mixedContent);
    expect(diagnostics.some((message) => message.includes("mixed legacy and V2 permissions"))).toBe(
      true,
    );
  });

  test("B12 agent ownership is isolated from command ownership and agent reload disposes", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "agents", "reload.md");
    const commandSource = path.join(project, ".agents", "commands", "reload.md");
    await markdown(path.join(project, ".agents"), "agents/reload.md", {}, "agent one");
    await markdown(path.join(project, ".agents"), "commands/reload.md", {}, "command one");

    let scheduledCallback: (() => void | Promise<void>) | undefined;
    let timerCleared = false;
    let reloads = 0;
    const scheduler = {
      setInterval: (callback: () => void | Promise<void>) => {
        scheduledCallback = callback;
        return "agent-timer";
      },
      clearInterval: (handle: unknown) => {
        timerCleared = handle === "agent-timer";
      },
    };

    const bridge = await startAgentBridge(
      { location: location(project), agent: { reload: async () => void reloads++ } },
      { home, environment: {}, scheduler },
    );
    await syncCommandLinks(location(project), { home, environment: {} });
    expect(await readlink(path.join(project, ".opencode", "commands", "reload.md"))).toContain(
      "commands",
    );
    expect(await readlink(path.join(project, ".opencode", "agents", "reload.md"))).toContain(
      "agents",
    );

    await writeFile(source, "---\n---\nagent two\n");
    await writeFile(commandSource, "---\n---\ncommand two\n");
    await scheduledCallback?.();
    expect(reloads).toBe(1);
    await bridge.dispose();
    expect(timerCleared).toBe(true);
    await scheduledCallback?.();
    expect(reloads).toBe(1);
    expect(await readFile(path.join(project, ".opencode", "commands", "reload.md"), "utf8")).toBe(
      "---\n---\ncommand two\n",
    );
  });

  test("agent bridge fails closed for held locks and malformed manifests", async () => {
    const root = await temporaryDirectory();
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    const source = path.join(project, ".agents", "agents", "stale.md");
    const destination = path.join(project, ".opencode", "agents", "stale.md");
    const manifest = path.join(project, ".opencode", ".agents-loader", "agents-manifest.json");
    const lock = path.join(project, ".opencode", ".agents-loader", "agents.lock");

    await markdown(path.join(project, ".agents"), "agents/stale.md", {}, "stale");
    await syncAgentLinks(location(project), { home, environment: {} });
    const manifestBefore = await readFile(manifest, "utf8");
    await unlink(source);
    await writeFile(lock, "held-by-crashed-instance");

    const held = await syncAgentLinks(location(project), {
      home,
      environment: {},
      lockAttempts: 1,
      lockDelayMs: 0,
    });

    expect(held.safe).toBe(false);
    expect(held.changed).toBe(false);
    expect(await readFile(manifest, "utf8")).toBe(manifestBefore);
    expect(await readlink(destination)).toContain(".agents");

    await unlink(lock);
    await writeFile(manifest, "not json");
    const malformed = await syncAgentLinks(location(project), { home, environment: {} });

    expect(malformed.safe).toBe(false);
    expect(malformed.changed).toBe(false);
    expect(await readlink(destination)).toContain(".agents");
  });
});
