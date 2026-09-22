import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  buildReleasePlan,
  type ChangesetsRunner,
  createChangesetsEnvironment,
  PUBLIC_REGISTRY,
  type RegistryClient,
  type RegistrySnapshot,
  runChangesets,
  runReleaseGuard,
} from "./release-channel-guard.js";

const packageNames = {
  agents: "@capybearista/opencode-agents-loader",
  timeline: "@capybearista/opencode-double-tap-timeline",
  inheritance: "@capybearista/opencode-agent-prompt-inheritance",
  styles: "@capybearista/opencode-output-styles",
  ram: "@capybearista/opencode-ram-monitor",
  review: "@capybearista/opencode-adversarial-review",
} as const;

type PackageName = (typeof packageNames)[keyof typeof packageNames];
type VersionMap = Record<PackageName, string>;

const baselineVersions: VersionMap = {
  [packageNames.agents]: "1.0.0",
  [packageNames.timeline]: "1.0.1",
  [packageNames.inheritance]: "1.0.0",
  [packageNames.styles]: "1.0.1",
  [packageNames.ram]: "1.1.0",
  [packageNames.review]: "1.0.0",
};

const registryVersions: VersionMap = { ...baselineVersions };
const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures.splice(0).map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

function snapshot(
  versions: string[],
  latest: string | undefined,
  extraTags: Record<string, string> = {},
): RegistrySnapshot {
  return {
    versions: Object.fromEntries(versions.map((version) => [version, {}])),
    distTags: latest === undefined ? extraTags : { latest, ...extraTags },
  };
}

function createRegistryClient(
  overrides: Partial<Record<PackageName, RegistrySnapshot | Error>> = {},
): RegistryClient {
  return async (name) => {
    const override = overrides[name as PackageName];
    if (override instanceof Error) throw override;
    if (override) return override;
    const version = registryVersions[name as PackageName];
    return snapshot([version], version);
  };
}

function publishEnvironment(): NodeJS.ProcessEnv {
  return {
    CI: "true",
    GITHUB_REF: "refs/heads/main",
    GITHUB_REF_NAME: "main",
    RELEASE_BUN_VERSION: "1.3.12",
    RELEASE_NODE_VERSION: "24.11.1",
    RELEASE_NPM_VERSION: "11.19.0",
  };
}

async function createFixture(
  versions: Partial<VersionMap> = {},
  options: {
    extraPackage?: { name: string; version?: string; private?: boolean };
    omit?: PackageName;
    config?: Record<string, unknown>;
  } = {},
) {
  const root = await mkdtemp(path.join(os.tmpdir(), "release-channel-guard-"));
  fixtures.push(root);
  await writeJson(path.join(root, "package.json"), {
    name: "release-channel-fixture",
    private: true,
    type: "module",
    workspaces: ["packages/*"],
  });
  await writeJson(path.join(root, "tools", "release-channels.json"), {
    registry: PUBLIC_REGISTRY,
    packages: {
      [packageNames.agents]: {
        releaseClass: "frozen-v1-v2",
        frozenLatest: "1.0.0",
        channel: "opencode2",
      },
      [packageNames.timeline]: {
        releaseClass: "frozen-v1-v2",
        frozenLatest: "1.0.1",
        channel: "opencode2",
      },
      [packageNames.inheritance]: { releaseClass: "v1", channel: "latest" },
      [packageNames.styles]: { releaseClass: "v1", channel: "latest" },
      [packageNames.ram]: { releaseClass: "v1", channel: "latest" },
      [packageNames.review]: { releaseClass: "v1", channel: "latest" },
    },
  });
  await mkdir(path.join(root, ".changeset"), { recursive: true });
  await writeJson(path.join(root, ".changeset", "config.json"), {
    $schema: "https://unpkg.com/@changesets/config@3.0.0/schema.json",
    changelog: "@changesets/cli/changelog",
    commit: false,
    fixed: [],
    linked: [],
    access: "public",
    baseBranch: "main",
    updateInternalDependencies: "patch",
    ignore: [],
    ...options.config,
  });

  for (const [, name] of Object.entries(packageNames) as Array<[string, PackageName]>) {
    if (name === options.omit) continue;
    await writePackage(root, name, versions[name] ?? baselineVersions[name]);
  }
  if (options.extraPackage) {
    await writePackage(
      root,
      options.extraPackage.name,
      options.extraPackage.version ?? "1.0.0",
      options.extraPackage.private,
    );
  }
  return root;
}

async function writePackage(
  root: string,
  name: string,
  version: string,
  privatePackage = false,
  extra: Record<string, unknown> = {},
) {
  const directory = name.slice(name.indexOf("/") + 1);
  const packageRoot = path.join(root, "packages", directory);
  await mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await writeJson(path.join(packageRoot, "package.json"), {
    name,
    version,
    private: privatePackage,
    type: "module",
    files: ["dist", "README.md", "LICENSE.txt"],
    ...extra,
  });
  await writeFile(path.join(packageRoot, "README.md"), `# ${name}\n`);
  await writeFile(path.join(packageRoot, "LICENSE.txt"), "fixture license\n");
  await writeFile(path.join(packageRoot, "dist", "index.js"), "export default {};\n");
}

async function writeJson(file: string, value: unknown) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function updateManifest(root: string, name: PackageName, patch: Record<string, unknown>) {
  const directory = name.slice(name.indexOf("/") + 1);
  const file = path.join(root, "packages", directory, "package.json");
  const current = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeJson(file, { ...current, ...patch });
}

async function expectGuardRejects(promise: Promise<unknown>, message: string) {
  await expect(promise).rejects.toThrow(message);
}

async function createScratch(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

async function pathExists(target: string) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function runtimeEnvironment(root: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: path.join(root, "home"),
    npm_config_cache: path.join(root, "npm-cache"),
    NPM_CONFIG_CACHE: path.join(root, "npm-cache"),
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    HTTP_PROXY: "",
    HTTPS_PROXY: "",
    ALL_PROXY: "",
    http_proxy: "",
    https_proxy: "",
    all_proxy: "",
    npm_config_provenance: "false",
    NPM_CONFIG_PROVENANCE: "false",
    ...overrides,
  };
}

function runCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) =>
      resolve({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      }),
    );
  });
}

async function createNpmStub(root: string, name: string, script: string) {
  const directory = path.join(root, name);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, "npm");
  await writeFile(file, script);
  await chmod(file, 0o755);
  return directory;
}

async function installChangesetsMarker(root: string, marker: string) {
  const cli = path.join(root, "node_modules", "@changesets", "cli");
  await mkdir(cli, { recursive: true });
  await writeJson(path.join(cli, "package.json"), {
    name: "@changesets/cli",
    version: "2.31.0",
    bin: "bin.js",
  });
  await writeFile(
    path.join(cli, "bin.js"),
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(marker)}, "invoked\\n");\n`,
  );
}

async function linkChangesetsCli(fixture: string) {
  const nodeModules = path.join(fixture, "node_modules");
  await mkdir(nodeModules, { recursive: true });
  await symlink(
    path.resolve("node_modules", "@changesets"),
    path.join(nodeModules, "@changesets"),
    "dir",
  );
}

describe("release-channel-guard policy matrix", () => {
  test("R1 all published versions produce a no-op without a Changesets subprocess", async () => {
    const cwd = await createFixture();
    let invocations = 0;

    const plan = await runReleaseGuard({
      cwd,
      mode: "check",
      registryClient: createRegistryClient(),
      runChangesets: async () => {
        invocations++;
        return 0;
      },
    });

    expect(plan.channel).toBe("noop");
    expect(plan.unpublished).toHaveLength(0);
    expect(invocations).toBe(0);
  });

  test("R2 two unpublished V2 releases select opencode2 in one invocation", async () => {
    const cwd = await createFixture({
      [packageNames.agents]: "2.0.0",
      [packageNames.timeline]: "2.0.0",
    });
    let invocation: readonly string[] | undefined;

    const plan = await runReleaseGuard({
      cwd,
      mode: "publish",
      env: publishEnvironment(),
      registryClient: createRegistryClient(),
      testOnlyNoGitTag: true,
      runChangesets: async (args) => {
        invocation = args;
        return 0;
      },
    });

    expect(plan.channel).toBe("opencode2");
    expect(plan.unpublished.map((pkg) => pkg.name)).toEqual([
      packageNames.agents,
      packageNames.timeline,
    ]);
    expect(invocation).toEqual(["publish", "--tag", "opencode2", "--no-git-tag"]);
  });

  test("R15 accepts a future stable 3.0 package version on OpenCode 2", async () => {
    const cwd = await createFixture({ [packageNames.agents]: "3.0.0" });

    const plan = await buildReleasePlan({ cwd, registryClient: createRegistryClient() });

    expect(plan.channel).toBe("opencode2");
    expect(plan.unpublished).toEqual([
      expect.objectContaining({
        name: packageNames.agents,
        version: "3.0.0",
        releaseClass: "v2",
      }),
    ]);
  });

  test("R3 a remaining unpublished V2 package keeps opencode2 after partial publication", async () => {
    const cwd = await createFixture({
      [packageNames.agents]: "2.0.0",
      [packageNames.timeline]: "2.0.1",
    });
    const registry = createRegistryClient({
      [packageNames.agents]: snapshot(["1.0.0", "2.0.0"], "1.0.0", { opencode2: "2.0.0" }),
    });

    const plan = await buildReleasePlan({ cwd, registryClient: registry });

    expect(plan.channel).toBe("opencode2");
    expect(plan.unpublished.map((pkg) => pkg.name)).toEqual([packageNames.timeline]);
  });

  test("R4 one ordinary V1 update selects latest", async () => {
    const cwd = await createFixture({ [packageNames.styles]: "1.0.2" });

    const plan = await buildReleasePlan({ cwd, registryClient: createRegistryClient() });

    expect(plan.channel).toBe("latest");
    expect(plan.unpublished).toEqual([
      expect.objectContaining({ name: packageNames.styles, version: "1.0.2", releaseClass: "v1" }),
    ]);
  });

  test("R5 several ordinary V1 updates remain one latest publication", async () => {
    const cwd = await createFixture({
      [packageNames.styles]: "1.0.2",
      [packageNames.ram]: "1.1.1",
    });

    const plan = await buildReleasePlan({ cwd, registryClient: createRegistryClient() });

    expect(plan.channel).toBe("latest");
    expect(plan.unpublished.map((pkg) => pkg.name)).toEqual([
      packageNames.styles,
      packageNames.ram,
    ]);
  });

  test("R6 mixed unpublished V1 and V2 releases reject before any publish invocation", async () => {
    const cwd = await createFixture({
      [packageNames.agents]: "2.0.0",
      [packageNames.styles]: "1.0.2",
    });
    let invocations = 0;

    await expectGuardRejects(
      runReleaseGuard({
        cwd,
        mode: "publish",
        env: publishEnvironment(),
        registryClient: createRegistryClient(),
        runChangesets: async () => {
          invocations++;
          return 0;
        },
      }),
      "mixed unpublished release classes",
    );
    expect(invocations).toBe(0);
  });

  test("R7 frozen V1 packages cannot continue with an unpublished V1 version", async () => {
    const cwd = await createFixture({ [packageNames.agents]: "1.0.1" });

    await expectGuardRejects(
      buildReleasePlan({ cwd, registryClient: createRegistryClient() }),
      "frozen V1 baseline",
    );
  });

  test("R8 unknown workspace package rejects exact policy mismatch", async () => {
    const cwd = await createFixture({}, { extraPackage: { name: "@capybearista/unknown-plugin" } });

    await expectGuardRejects(
      buildReleasePlan({ cwd, registryClient: createRegistryClient() }),
      "workspace policy mismatch",
    );
  });

  test("R8 missing workspace package rejects exact policy mismatch", async () => {
    const cwd = await createFixture({}, { omit: packageNames.review });

    await expectGuardRejects(
      buildReleasePlan({ cwd, registryClient: createRegistryClient() }),
      "workspace policy mismatch",
    );
  });

  test("R8 private workspace package rejects before registry queries", async () => {
    const cwd = await createFixture();
    await updateManifest(cwd, packageNames.styles, { private: true });
    let queries = 0;

    await expectGuardRejects(
      buildReleasePlan({
        cwd,
        registryClient: async (name) => {
          queries++;
          return createRegistryClient()(name);
        },
      }),
      "private",
    );
    expect(queries).toBe(0);
  });

  test("R8 wrong major and prerelease versions reject stable policy", async () => {
    const wrongMajor = await createFixture({ [packageNames.styles]: "2.0.0" });
    await expectGuardRejects(
      buildReleasePlan({ cwd: wrongMajor, registryClient: createRegistryClient() }),
      "V1 major",
    );

    const prerelease = await createFixture({ [packageNames.agents]: "2.0.0-beta.1" });
    await expectGuardRejects(
      buildReleasePlan({ cwd: prerelease, registryClient: createRegistryClient() }),
      "stable",
    );
  });

  test("R8 explains the OpenCode 2 stable version threshold", async () => {
    const cwd = await createFixture({ [packageNames.agents]: "1.0.1" });

    await expectGuardRejects(
      buildReleasePlan({ cwd, registryClient: createRegistryClient() }),
      "stable package version >=2.0.0 for OpenCode 2",
    );
  });

  test("R8 invalid versions reject before querying the registry", async () => {
    const cwd = await createFixture({ [packageNames.styles]: "not-semver" });
    let queries = 0;

    await expectGuardRejects(
      buildReleasePlan({
        cwd,
        registryClient: async (name) => {
          queries++;
          return createRegistryClient()(name);
        },
      }),
      "stable semver",
    );
    expect(queries).toBe(0);
  });

  test("R8 custom package registry and publish directory reject", async () => {
    const customRegistry = await createFixture();
    await updateManifest(customRegistry, packageNames.styles, {
      publishConfig: { "@capybearista:registry": "https://evil.example/" },
    });
    await expectGuardRejects(
      buildReleasePlan({ cwd: customRegistry, registryClient: createRegistryClient() }),
      "custom registry",
    );

    const customDirectory = await createFixture();
    await updateManifest(customDirectory, packageNames.styles, {
      publishConfig: { directory: "dist" },
    });
    await expectGuardRejects(
      buildReleasePlan({ cwd: customDirectory, registryClient: createRegistryClient() }),
      "publishConfig.directory",
    );
  });

  test("R8 custom changesets registry config rejects", async () => {
    const cwd = await createFixture({}, { config: { registry: "https://evil.example/" } });

    await expectGuardRejects(
      buildReleasePlan({ cwd, registryClient: createRegistryClient() }),
      "custom registry",
    );
  });

  test("R8 custom registry environment and project npmrc reject", async () => {
    const environmentFixture = await createFixture();
    await expectGuardRejects(
      buildReleasePlan({
        cwd: environmentFixture,
        env: { ...process.env, NPM_CONFIG_REGISTRY: "https://evil.example/" },
        registryClient: createRegistryClient(),
      }),
      "custom registry",
    );

    const npmrcFixture = await createFixture();
    await writeFile(
      path.join(npmrcFixture, ".npmrc"),
      "@capybearista:registry=https://evil.example/\n",
    );
    await expectGuardRejects(
      buildReleasePlan({ cwd: npmrcFixture, registryClient: createRegistryClient() }),
      "custom scope registry",
    );
  });

  test("R8 Changesets pre mode is rejected", async () => {
    const cwd = await createFixture();
    await writeJson(path.join(cwd, ".changeset", "pre.json"), {
      mode: "pre",
      tag: "next",
      initialVersions: baselineVersions,
      changesets: [],
    });

    await expectGuardRejects(
      buildReleasePlan({ cwd, registryClient: createRegistryClient() }),
      "pre mode",
    );
  });

  test("R9 frozen latest tag missing or moved rejects", async () => {
    const missing = await createFixture();
    await expectGuardRejects(
      buildReleasePlan({
        cwd: missing,
        registryClient: createRegistryClient({
          [packageNames.agents]: snapshot(["1.0.0"], undefined),
        }),
      }),
      "latest",
    );

    const moved = await createFixture();
    await expectGuardRejects(
      buildReleasePlan({
        cwd: moved,
        registryClient: createRegistryClient({
          [packageNames.timeline]: snapshot(["1.0.1", "1.0.2"], "1.0.2"),
        }),
      }),
      "frozen latest",
    );
  });

  test("R9 registry auth, server, malformed, empty, and timeout failures reject before publish", async () => {
    const failures: Array<{ label: string; registry: RegistryClient; message: string }> = [
      {
        label: "auth",
        registry: createRegistryClient({ [packageNames.agents]: new Error("HTTP 401") }),
        message: "HTTP 401",
      },
      {
        label: "server",
        registry: createRegistryClient({ [packageNames.agents]: new Error("HTTP 503") }),
        message: "HTTP 503",
      },
      {
        label: "malformed",
        registry: createRegistryClient({
          [packageNames.agents]: { versions: {} } as RegistrySnapshot,
        }),
        message: "malformed",
      },
      {
        label: "empty",
        registry: createRegistryClient({ [packageNames.agents]: {} as RegistrySnapshot }),
        message: "malformed",
      },
      {
        label: "timeout",
        registry: async () => new Promise<RegistrySnapshot>(() => {}),
        message: "timed out",
      },
    ];

    for (const failure of failures) {
      const cwd = await createFixture();
      await expectGuardRejects(
        buildReleasePlan({ cwd, registryClient: failure.registry, registryTimeoutMs: 10 }),
        failure.message,
      );
    }
  });

  test("R10 check mode prints a plan and never invokes Changesets", async () => {
    const cwd = await createFixture({ [packageNames.agents]: "2.0.0" });
    const output: string[] = [];
    let invocations = 0;

    const plan = await runReleaseGuard({
      cwd,
      mode: "check",
      registryClient: createRegistryClient(),
      output: (line) => output.push(line),
      runChangesets: async () => {
        invocations++;
        return 0;
      },
    });

    expect(plan.channel).toBe("opencode2");
    expect(invocations).toBe(0);
    expect(output.join("\n")).toContain("opencode2");
  });

  test("publish requires CI, main, and all pinned toolchain gates", async () => {
    const cwd = await createFixture({ [packageNames.agents]: "2.0.0" });
    const missingGate = publishEnvironment();
    delete missingGate.RELEASE_NPM_VERSION;

    await expectGuardRejects(
      runReleaseGuard({
        cwd,
        mode: "publish",
        env: missingGate,
        registryClient: createRegistryClient(),
        runChangesets: async () => 0,
      }),
      "pinned toolchain",
    );

    const wrongBranch = { ...publishEnvironment(), GITHUB_REF_NAME: "release" };
    await expectGuardRejects(
      runReleaseGuard({
        cwd,
        mode: "publish",
        env: wrongBranch,
        registryClient: createRegistryClient(),
        runChangesets: async () => 0,
      }),
      "main",
    );
  });

  test("production invocation preserves normal Changesets git tagging", async () => {
    const cwd = await createFixture({ [packageNames.styles]: "1.0.2" });
    let invocation: readonly string[] | undefined;

    await runReleaseGuard({
      cwd,
      mode: "publish",
      env: publishEnvironment(),
      registryClient: createRegistryClient(),
      runChangesets: async (args) => {
        invocation = args;
        return 0;
      },
    });

    expect(invocation).toEqual(["publish", "--tag", "latest"]);
    expect(invocation).not.toContain("--no-git-tag");
  });
});

describe("R12 isolated npm configuration", () => {
  test("R12 builds distinct empty private npm configs and preserves OIDC and host environment", async () => {
    const root = await createScratch("release-channel-guard-");
    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    await writeFile(path.join(hostHome, ".npmrc"), "registry=https://evil.example/\n");

    const built = await createChangesetsEnvironment({
      env: {
        ...runtimeEnvironment(root),
        HOME: hostHome,
        ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
        ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret",
      },
    });
    const userConfig = built.env.npm_config_userconfig;
    const globalConfig = built.env.npm_config_globalconfig;
    if (!userConfig || !globalConfig) {
      throw new Error("environment builder omitted npm config paths");
    }

    try {
      expect(built.env.NPM_CONFIG_USERCONFIG).toBe(userConfig);
      expect(built.env.NPM_CONFIG_GLOBALCONFIG).toBe(globalConfig);
      expect(built.env.NPM_CONFIG_REGISTRY).toBe(PUBLIC_REGISTRY);
      expect(built.env.npm_config_registry).toBe(PUBLIC_REGISTRY);
      expect(userConfig).not.toBe(globalConfig);
      expect(path.dirname(userConfig)).toBe(path.dirname(globalConfig));
      expect(path.dirname(userConfig)).not.toBe(hostHome);
      expect((await stat(userConfig)).size).toBe(0);
      expect((await stat(globalConfig)).size).toBe(0);
      expect(built.env.HOME).toBe(hostHome);
      expect(built.env.ACTIONS_ID_TOKEN_REQUEST_URL).toBe("https://oidc.example/request");
      expect(built.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe("oidc-request-secret");
      expect(await readFile(path.join(hostHome, ".npmrc"), "utf8")).toBe(
        "registry=https://evil.example/\n",
      );
    } finally {
      await built.dispose();
    }

    expect(await Bun.file(userConfig).exists()).toBe(false);
    expect(await pathExists(path.dirname(userConfig))).toBe(false);
  });

  test("R12 real npm rejects a shared /dev/null config and resolves the expected registry from the isolated environment", async () => {
    const root = await createScratch("release-channel-guard-");
    const hostHome = path.join(root, "host-home");
    await mkdir(hostHome, { recursive: true });
    await writeFile(path.join(hostHome, ".npmrc"), "registry=https://evil.example/\n");
    const baseEnv = { ...runtimeEnvironment(root), HOME: hostHome };

    const legacy = await runCommand(
      "npm",
      ["config", "get", "registry"],
      {
        ...baseEnv,
        NPM_CONFIG_REGISTRY: PUBLIC_REGISTRY,
        npm_config_registry: PUBLIC_REGISTRY,
        NPM_CONFIG_USERCONFIG: "/dev/null",
        npm_config_userconfig: "/dev/null",
        NPM_CONFIG_GLOBALCONFIG: "/dev/null",
        npm_config_globalconfig: "/dev/null",
      },
      root,
    );
    expect(legacy.exitCode).not.toBe(0);
    expect(`${legacy.stdout}\n${legacy.stderr}`).toContain("double-loading config");

    const built = await createChangesetsEnvironment({ env: baseEnv });
    const userConfig = built.env.npm_config_userconfig;
    const globalConfig = built.env.npm_config_globalconfig;
    if (!userConfig || !globalConfig) {
      throw new Error("environment builder omitted npm config paths");
    }
    try {
      const resolvedRegistry = await runCommand(
        "npm",
        ["config", "get", "registry"],
        built.env,
        root,
      );
      expect(resolvedRegistry.exitCode).toBe(0);
      expect(resolvedRegistry.stdout.trim()).toBe(PUBLIC_REGISTRY);

      const resolvedUser = await runCommand(
        "npm",
        ["config", "get", "userconfig"],
        built.env,
        root,
      );
      const resolvedGlobal = await runCommand(
        "npm",
        ["config", "get", "globalconfig"],
        built.env,
        root,
      );
      expect(resolvedUser.stdout.trim()).toBe(userConfig);
      expect(resolvedGlobal.stdout.trim()).toBe(globalConfig);
      expect(await readFile(path.join(hostHome, ".npmrc"), "utf8")).toBe(
        "registry=https://evil.example/\n",
      );
    } finally {
      await built.dispose();
    }
  }, 30_000);

  test("R12 publish lifecycle removes the owned environment on success and failure", async () => {
    const oidc = {
      ACTIONS_ID_TOKEN_REQUEST_URL: "https://oidc.example/request",
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: "oidc-request-secret",
    };
    const successFixture = await createFixture({ [packageNames.styles]: "1.0.2" });
    let successConfig: string | undefined;
    let successEnv: NodeJS.ProcessEnv | undefined;
    await runReleaseGuard({
      cwd: successFixture,
      mode: "publish",
      env: { ...publishEnvironment(), ...oidc },
      registryClient: createRegistryClient(),
      runChangesets: async (_args, env) => {
        successEnv = env;
        successConfig = env.npm_config_userconfig;
        return 0;
      },
    });
    if (!successConfig) throw new Error("runner did not receive npm_config_userconfig");
    expect(successEnv?.ACTIONS_ID_TOKEN_REQUEST_URL).toBe(oidc.ACTIONS_ID_TOKEN_REQUEST_URL);
    expect(successEnv?.ACTIONS_ID_TOKEN_REQUEST_TOKEN).toBe(oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN);
    expect(await Bun.file(successConfig).exists()).toBe(false);
    expect(await pathExists(path.dirname(successConfig))).toBe(false);

    const failureFixture = await createFixture({ [packageNames.styles]: "1.0.2" });
    let failureConfig: string | undefined;
    await expectGuardRejects(
      runReleaseGuard({
        cwd: failureFixture,
        mode: "publish",
        env: publishEnvironment(),
        registryClient: createRegistryClient(),
        runChangesets: async (_args, env) => {
          failureConfig = env.npm_config_userconfig;
          throw new Error("runner exploded");
        },
      }),
      "runner exploded",
    );
    if (!failureConfig) throw new Error("runner did not receive npm_config_userconfig");
    expect(await Bun.file(failureConfig).exists()).toBe(false);
    expect(await pathExists(path.dirname(failureConfig))).toBe(false);
  });

  test("R12 config check failure or mismatch blocks Changesets without leaking secrets", async () => {
    const secret = "oidc-request-token-secret";
    const cases = [
      {
        label: "nonzero",
        script: `#!/bin/sh\necho "raw failure ${secret}" >&2\nexit 9\n`,
        env: {},
        message: "npm configuration check failed with status 9",
      },
      {
        label: "mismatch",
        script: `#!/bin/sh\necho "https://evil.example/"\n`,
        env: {},
        message: "npm configuration check resolved an unexpected registry",
      },
    ];

    for (const failure of cases) {
      const fixture = await createFixture({
        [packageNames.agents]: "2.0.0",
        [packageNames.timeline]: "2.0.0",
      });
      const marker = path.join(fixture, "changesets-invoked");
      await installChangesetsMarker(fixture, marker);
      const stub = await createNpmStub(fixture, `npm-${failure.label}`, failure.script);
      let caught: unknown;
      try {
        await runReleaseGuard({
          cwd: fixture,
          mode: "publish",
          env: {
            ...publishEnvironment(),
            PATH: `${stub}:${process.env.PATH}`,
            ACTIONS_ID_TOKEN_REQUEST_TOKEN: secret,
            ...failure.env,
          },
          registryClient: createRegistryClient(),
          testOnlyNoGitTag: true,
        });
      } catch (error) {
        caught = error;
      }
      expect(String(caught)).toContain(failure.message);
      expect(String(caught)).not.toContain(secret);
      expect(String(caught)).not.toContain("raw failure");
      expect(await Bun.file(marker).exists()).toBe(false);
    }
  });

  test("R12 inconsistent npm registry overrides fail before any Changesets invocation", async () => {
    const fixture = await createFixture({
      [packageNames.agents]: "2.0.0",
      [packageNames.timeline]: "2.0.0",
    });
    const marker = path.join(fixture, "changesets-invoked");
    await installChangesetsMarker(fixture, marker);
    const built = await createChangesetsEnvironment({ env: publishEnvironment() });
    try {
      built.env.npm_config_registry = "https://evil.example/";
      await expectGuardRejects(
        runChangesets(["publish", "--tag", "opencode2"], built.env, fixture),
        "npm configuration check requires one consistent registry",
      );
      expect(await Bun.file(marker).exists()).toBe(false);
    } finally {
      await built.dispose();
    }
  });
});

describe("R13 cleanup failure handling", () => {
  const removalWarning =
    "release-channel-guard: could not remove the private npm configuration directory";
  const partialWarning =
    "release-channel-guard: could not clean up a partial private npm configuration directory";

  test("R13 cleanup failure after a successful publish keeps the plan and warns off stdout", async () => {
    const fixture = await createFixture({
      [packageNames.agents]: "2.0.0",
      [packageNames.timeline]: "2.0.0",
    });
    const warnings: string[] = [];
    const printed: string[] = [];
    let invocations = 0;
    let environmentDirectory = "";
    const plan = await runReleaseGuard({
      cwd: fixture,
      mode: "publish",
      env: publishEnvironment(),
      registryClient: createRegistryClient(),
      output: (line) => printed.push(line),
      runChangesets: async (_args, env) => {
        invocations++;
        environmentDirectory = path.dirname(env.npm_config_userconfig ?? "");
        return 0;
      },
      testOnlyNoGitTag: true,
      warn: (line) => warnings.push(line),
      testOnlyFilesystem: {
        removeDirectory: async () => {
          throw new Error("simulated EBUSY with private-token");
        },
      },
    });
    try {
      expect(plan.channel).toBe("opencode2");
      expect(invocations).toBe(1);
      expect(warnings).toEqual([removalWarning]);
      expect(printed.join("\n")).toContain("opencode2");
      expect(printed.join("\n")).not.toContain("could not remove");
      expect(await pathExists(environmentDirectory)).toBe(true);
    } finally {
      await rm(environmentDirectory, { recursive: true, force: true });
    }
  });

  test("R13 cleanup failure preserves the primary runner status and error", async () => {
    const modes = [
      {
        label: "throw",
        run: async () => {
          throw new Error("runner exploded");
        },
        message: "runner exploded",
      },
      { label: "status", run: async () => 7, message: "Changesets publish exited with status 7" },
    ];

    for (const mode of modes) {
      const fixture = await createFixture({ [packageNames.styles]: "1.0.2" });
      const warnings: string[] = [];
      let environmentDirectory = "";
      let caught: unknown;
      try {
        await runReleaseGuard({
          cwd: fixture,
          mode: "publish",
          env: publishEnvironment(),
          registryClient: createRegistryClient(),
          runChangesets: async (_args, env) => {
            environmentDirectory = path.dirname(env.npm_config_userconfig ?? "");
            return mode.run();
          },
          warn: (line) => warnings.push(line),
          testOnlyFilesystem: {
            removeDirectory: async () => {
              throw new Error("simulated cleanup failure");
            },
          },
        });
      } catch (error) {
        caught = error;
      } finally {
        await rm(environmentDirectory, { recursive: true, force: true });
      }
      expect(String(caught)).toContain(mode.message);
      expect(warnings).toEqual([removalWarning]);
    }
  });

  test("R13 failed dispose stays retryable and removes the directory on retry", async () => {
    let attempts = 0;
    const built = await createChangesetsEnvironment({
      env: publishEnvironment(),
      testOnlyFilesystem: {
        removeDirectory: async (directory) => {
          attempts++;
          if (attempts === 1) throw new Error("simulated EBUSY");
          await rm(directory, { recursive: true, force: true });
        },
      },
    });
    const directory = path.dirname(built.env.npm_config_userconfig ?? "");
    try {
      await expect(built.dispose()).rejects.toThrow("simulated EBUSY");
      expect(await pathExists(directory)).toBe(true);

      await built.dispose();
      expect(attempts).toBe(2);
      expect(await pathExists(directory)).toBe(false);

      await built.dispose();
      expect(attempts).toBe(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("R13 partial environment creation removes the owned directory and preserves the creation error", async () => {
    const warnings: string[] = [];
    let createdDirectory = "";
    let writeCalls = 0;
    let caught: unknown;
    try {
      await createChangesetsEnvironment({
        env: publishEnvironment(),
        warn: (line) => warnings.push(line),
        testOnlyFilesystem: {
          writeFile: async (file) => {
            writeCalls++;
            createdDirectory = path.dirname(file);
            if (writeCalls === 2) throw new Error("simulated write failure");
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain("simulated write failure");
    expect(writeCalls).toBe(2);
    expect(warnings).toEqual([]);
    expect(createdDirectory).not.toBe("");
    expect(await pathExists(createdDirectory)).toBe(false);
  });

  test("R13 cleanup failure during partial environment creation preserves the creation error", async () => {
    const warnings: string[] = [];
    let createdDirectory = "";
    let caught: unknown;
    try {
      await createChangesetsEnvironment({
        env: publishEnvironment(),
        warn: (line) => warnings.push(line),
        testOnlyFilesystem: {
          writeFile: async (file) => {
            createdDirectory = path.dirname(file);
            throw new Error("simulated creation failure with hidden-token");
          },
          removeDirectory: async () => {
            throw new Error("simulated cleanup failure with hidden-token");
          },
        },
      });
    } catch (error) {
      caught = error;
    } finally {
      if (createdDirectory) await rm(createdDirectory, { recursive: true, force: true });
    }
    expect(String(caught)).toContain("simulated creation failure");
    expect(String(caught)).not.toContain("cleanup failure");
    expect(warnings).toEqual([partialWarning]);
    expect(warnings.join("\n")).not.toContain("hidden-token");
  });
});

type PublishedPackage = {
  versions: Set<string>;
  distTags: Record<string, string>;
};

class LoopbackRegistry {
  readonly packages = new Map<PackageName, PublishedPackage>();
  readonly publishes: Array<{ name: string; version: string; tag: string }> = [];
  readonly requests: Array<{ method: string; pathname: string }> = [];
  private server: Server | undefined;
  private address = "";

  constructor() {
    for (const [name, version] of Object.entries(registryVersions) as Array<
      [PackageName, string]
    >) {
      this.packages.set(name, {
        versions: new Set([version]),
        distTags: { latest: version },
      });
    }
  }

  async start() {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, "127.0.0.1", () => {
        const address = this.server?.address();
        if (!address || typeof address === "string")
          throw new Error("loopback registry did not bind");
        this.address = `http://127.0.0.1:${address.port}`;
        resolve();
      });
    });
    return this.address;
  }

  async close() {
    await new Promise<void>((resolve, reject) => {
      if (!this.server) return resolve();
      this.server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  client(): RegistryClient {
    return async (name) => {
      const response = await fetch(`${this.address}/${encodeURIComponent(name)}`);
      if (!response.ok) throw new Error(`loopback metadata ${response.status}`);
      const packument = (await response.json()) as {
        versions: Record<string, unknown>;
        "dist-tags": Record<string, string>;
      };
      return { versions: packument.versions, distTags: packument["dist-tags"] };
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse) {
    const pathname = new URL(request.url ?? "/", this.address || "http://127.0.0.1").pathname;
    this.requests.push({ method: request.method ?? "", pathname });
    if (pathname.startsWith("/-/")) {
      this.respondJson(response, 200, { tfa: { mode: "auth-and-writes" }, username: "loopback" });
      return;
    }
    if (request.method === "GET") {
      this.respondJson(response, 200, this.readPackument(pathname));
      return;
    }
    if (request.method === "PUT") {
      const body = await readRequestBody(request);
      this.recordPublish(pathname, body);
      this.respondJson(response, 201, { ok: true });
      return;
    }
    this.respondJson(response, 404, { error: "not found" });
  }

  private readPackument(pathname: string) {
    const name = decodeURIComponent(pathname.slice(1)) as PackageName;
    const packageState = this.packages.get(name);
    if (!packageState) return { error: "E404" };
    return {
      name,
      "dist-tags": packageState.distTags,
      versions: Object.fromEntries(
        [...packageState.versions].map((version) => [version, { name, version }]),
      ),
    };
  }

  private recordPublish(pathname: string, rawBody: string) {
    const name = decodeURIComponent(pathname.slice(1));
    const body = JSON.parse(rawBody) as {
      versions?: Record<string, unknown>;
      "dist-tags"?: Record<string, string>;
    };
    const versions = Object.keys(body.versions ?? {});
    const version = versions.at(-1);
    if (!version) throw new Error(`loopback publish omitted version for ${name}`);
    const tag = Object.keys(body["dist-tags"] ?? {})[0] ?? "latest";
    const packageState = this.packages.get(name as PackageName);
    if (!packageState) throw new Error(`loopback publish unknown package ${name}`);
    packageState.versions.add(version);
    if (body["dist-tags"]) Object.assign(packageState.distTags, body["dist-tags"]);
    this.publishes.push({ name, version, tag });
  }

  private respondJson(response: ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
    response.end(payload);
  }
}

function readRequestBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

function runRealChangesets(registryUrl: string): ChangesetsRunner {
  return async (args, env, cwd) => {
    const userConfig = env.npm_config_userconfig;
    if (!userConfig) {
      throw new Error("production npm environment is missing npm_config_userconfig");
    }
    await appendFile(
      userConfig,
      `//127.0.0.1:${new URL(registryUrl).port}/:_auth=${Buffer.from("loopback:loopback").toString("base64")}\n`,
    );
    return runChangesets(args, env, cwd);
  };
}

function publishedPackageNames(registry: LoopbackRegistry) {
  return registry.requests
    .filter((request) => request.method === "PUT")
    .map((request) => decodeURIComponent(request.pathname.slice(1)))
    .sort();
}

describe("R11 disposable real Changesets publication", () => {
  test("publishes V2 under opencode2, preserves frozen latest, then publishes V1 under latest", async () => {
    const registry = new LoopbackRegistry();
    const registryUrl = await registry.start();
    const fixture = await createFixture({
      [packageNames.agents]: "2.0.0",
      [packageNames.timeline]: "2.0.0",
    });
    await linkChangesetsCli(fixture);
    const evidenceRoot = await createScratch("release-channel-registry-");
    await mkdir(path.join(evidenceRoot, "home"), { recursive: true });
    await mkdir(path.join(evidenceRoot, "npm-cache"), { recursive: true });
    const runner = runRealChangesets(registryUrl);
    const env = { ...publishEnvironment(), ...runtimeEnvironment(evidenceRoot) };

    try {
      const first = await runReleaseGuard({
        cwd: fixture,
        mode: "publish",
        env,
        registryClient: registry.client(),
        runChangesets: runner,
        testOnlyRegistry: registryUrl,
        testOnlyNoGitTag: true,
      });
      expect(first.channel).toBe("opencode2");
      expect(
        registry.publishes
          .map(({ name, version, tag }) => ({ name, version, tag }))
          .sort((left, right) => left.name.localeCompare(right.name)),
      ).toEqual(
        [
          { name: packageNames.agents, version: "2.0.0", tag: "opencode2" },
          { name: packageNames.timeline, version: "2.0.0", tag: "opencode2" },
        ].sort((left, right) => left.name.localeCompare(right.name)),
      );
      expect(publishedPackageNames(registry)).toEqual(
        [packageNames.agents, packageNames.timeline].sort(),
      );
      expect(registry.packages.get(packageNames.agents)?.distTags.latest).toBe("1.0.0");
      expect(registry.packages.get(packageNames.timeline)?.distTags.latest).toBe("1.0.1");
      expect(registry.packages.get(packageNames.agents)?.distTags.opencode2).toBe("2.0.0");
      expect(registry.packages.get(packageNames.timeline)?.distTags.opencode2).toBe("2.0.0");

      await updateManifest(fixture, packageNames.styles, { version: "1.0.2" });
      const second = await runReleaseGuard({
        cwd: fixture,
        mode: "publish",
        env,
        registryClient: registry.client(),
        runChangesets: runner,
        testOnlyRegistry: registryUrl,
        testOnlyNoGitTag: true,
      });
      expect(second.channel).toBe("latest");
      expect(registry.publishes.at(-1)).toEqual({
        name: packageNames.styles,
        version: "1.0.2",
        tag: "latest",
      });
      expect(publishedPackageNames(registry)).toEqual(
        [packageNames.agents, packageNames.timeline, packageNames.styles].sort(),
      );
      expect(registry.packages.get(packageNames.agents)?.distTags.latest).toBe("1.0.0");
      expect(registry.packages.get(packageNames.timeline)?.distTags.latest).toBe("1.0.1");
      expect(registry.packages.get(packageNames.inheritance)?.distTags.latest).toBe("1.0.0");
      expect(registry.requests.some((request) => request.method === "PUT")).toBe(true);
      expect(await Bun.file(path.join(fixture, ".git", "refs")).exists()).toBe(false);
    } finally {
      await registry.close();
    }
  }, 20_000);
});

test("the policy points at the public npm registry", () => {
  expect(PUBLIC_REGISTRY).toBe("https://registry.npmjs.org/");
});
