import { execFile, spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import { access, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

/**
 * The guard is a fail-closed preflight around one locked Changesets publish.
 * Check mode only reads workspace and public registry state; publish mode requires the
 * main CI toolchain gates, chooses one homogeneous tag, and delegates exactly once.
 * npm publication can partially succeed, so recovery remains an explicit operator concern.
 */
export const PUBLIC_REGISTRY = "https://registry.npmjs.org/";
const CHANGESETS_VERSION = "2.31.0";
const REGISTRY_TIMEOUT_MS = 10_000;
const MAX_PACKUMENT_BYTES = 2_000_000;
const NPM_CONFIG_TIMEOUT_MS = 10_000;
const MAX_NPM_OUTPUT_BYTES = 8 * 1024;
const execFileAsync = promisify(execFile);
const APPROVED_POLICY: Record<string, PolicyEntry> = {
  "@capybearista/opencode-agents-loader": {
    releaseClass: "frozen-v1-v2",
    frozenLatest: "1.0.0",
    channel: "opencode2",
  },
  "@capybearista/opencode-double-tap-timeline": {
    releaseClass: "frozen-v1-v2",
    frozenLatest: "1.0.1",
    channel: "opencode2",
  },
  "@capybearista/opencode-agent-prompt-inheritance": {
    releaseClass: "v1",
    channel: "latest",
  },
  "@capybearista/opencode-output-styles": {
    releaseClass: "v1",
    channel: "latest",
  },
  "@capybearista/opencode-ram-monitor": {
    releaseClass: "v1",
    channel: "latest",
  },
  "@capybearista/opencode-adversarial-review": {
    releaseClass: "v1",
    channel: "latest",
  },
};

type ReleaseClass = "v1" | "frozen-v1-v2";
type ReleaseChannel = "noop" | "latest" | "opencode2";

type PolicyEntry = {
  releaseClass: ReleaseClass;
  frozenLatest?: string;
  channel: Exclude<ReleaseChannel, "noop">;
};

type ReleasePolicy = {
  registry: string;
  packages: Record<string, PolicyEntry>;
};

export type RegistrySnapshot = {
  versions: Record<string, unknown>;
  distTags: Record<string, string>;
};

export type RegistryClient = (name: string) => Promise<RegistrySnapshot>;

export type ReleasePackage = {
  name: string;
  version: string;
  releaseClass: "v1" | "v2";
  published: boolean;
};

export type ReleasePlan = {
  channel: ReleaseChannel;
  packages: ReleasePackage[];
  unpublished: ReleasePackage[];
};

export type ChangesetsRunner = (
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
) => Promise<number>;

/** One Changesets invocation environment plus the cleanup for its owned files. */
export type ChangesetsEnvironment = {
  env: NodeJS.ProcessEnv;
  dispose: () => Promise<void>;
};

export type ChangesetsFilesystem = {
  writeFile: (file: string, data: string) => Promise<void>;
  removeDirectory: (directory: string) => Promise<void>;
};

export type ChangesetsEnvironmentOptions = {
  env?: NodeJS.ProcessEnv;
  /** Registry the child npm must use; production always passes the public registry. */
  registry?: string;
  /** Receives sanitized cleanup warnings; defaults to stderr. */
  warn?: (line: string) => void;
  /** Only tests may set this to inject filesystem failures. */
  testOnlyFilesystem?: Partial<ChangesetsFilesystem>;
};

export type BuildPlanOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  registryClient?: RegistryClient;
  registryTimeoutMs?: number;
};

export type ReleaseGuardOptions = BuildPlanOptions & {
  mode: "check" | "publish";
  output?: (line: string) => void;
  runChangesets?: ChangesetsRunner;
  /** Only tests may set this; production always keeps Changesets' git tagging. */
  testOnlyNoGitTag?: boolean;
  /** Only tests may set this; production always publishes to the public npm registry. */
  testOnlyRegistry?: string;
  /** Only tests may set this to inject filesystem failures. */
  testOnlyFilesystem?: Partial<ChangesetsFilesystem>;
  /** Receives sanitized cleanup warnings; defaults to stderr. */
  warn?: (line: string) => void;
};

export class ReleaseGuardError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode = 1) {
    super(message);
    this.name = "ReleaseGuardError";
    this.exitCode = exitCode;
  }
}

export async function buildReleasePlan(options: BuildPlanOptions = {}): Promise<ReleasePlan> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const policy = await readPolicy(cwd);
  validatePolicy(policy);
  await validateRegistryConfiguration(cwd, env, policy.registry);
  if (await fileExists(path.join(cwd, ".changeset", "pre.json"))) {
    throw new ReleaseGuardError("Changesets pre mode is not allowed");
  }
  const workspace = await readWorkspace(cwd, policy);
  const registryClient = options.registryClient ?? createPublicRegistryClient(policy.registry);
  const timeoutMs = options.registryTimeoutMs ?? REGISTRY_TIMEOUT_MS;
  const packages: ReleasePackage[] = [];

  for (const item of workspace) {
    const snapshot = await withTimeout(
      registryClient(item.name),
      timeoutMs,
      `registry metadata query timed out for ${item.name}`,
    );
    validateRegistrySnapshot(item.name, snapshot);
    const policyEntry = policy.packages[item.name];
    if (policyEntry.releaseClass === "frozen-v1-v2") {
      if (snapshot.distTags.latest !== policyEntry.frozenLatest) {
        throw new ReleaseGuardError(
          `${item.name} frozen latest tag must remain ${policyEntry.frozenLatest}`,
        );
      }
      if (!hasVersion(snapshot, policyEntry.frozenLatest)) {
        throw new ReleaseGuardError(
          `${item.name} frozen latest version ${policyEntry.frozenLatest} is absent from the registry`,
        );
      }
    }

    packages.push({
      name: item.name,
      version: item.version,
      releaseClass:
        policyEntry.releaseClass === "v1"
          ? "v1"
          : item.version === policyEntry.frozenLatest
            ? "v1"
            : "v2",
      published: hasVersion(snapshot, item.version),
    });
  }

  const unpublished = packages.filter((item) => !item.published);
  const releaseClasses = new Set(unpublished.map((item) => item.releaseClass));
  if (releaseClasses.size > 1) {
    throw new ReleaseGuardError("mixed unpublished release classes cannot be published together");
  }
  const channel =
    unpublished.length === 0
      ? "noop"
      : unpublished[0].releaseClass === "v2"
        ? "opencode2"
        : "latest";
  return { channel, packages, unpublished };
}

export async function runReleaseGuard(options: ReleaseGuardOptions): Promise<ReleasePlan> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  if (options.mode === "publish") validatePublishGates(env);
  const plan = await buildReleasePlan(options);
  const output = options.output ?? ((line: string) => console.log(line));
  printPlan(plan, output);
  if (options.mode === "check" || plan.channel === "noop") return plan;

  const args = ["publish", "--tag", plan.channel];
  if (options.testOnlyNoGitTag) args.push("--no-git-tag");
  const runner = options.runChangesets ?? runChangesets;
  const warn = options.warn ?? warnToStderr;
  const changesetsEnvironment = await createChangesetsEnvironment({
    env,
    registry: options.testOnlyRegistry,
    warn,
    testOnlyFilesystem: options.testOnlyFilesystem,
  });
  try {
    const exitCode = await runner(args, changesetsEnvironment.env, cwd);
    if (exitCode !== 0) {
      throw new ReleaseGuardError(`Changesets publish exited with status ${exitCode}`, exitCode);
    }
  } finally {
    try {
      await changesetsEnvironment.dispose();
    } catch {
      warn("release-channel-guard: could not remove the private npm configuration directory");
    }
  }
  return plan;
}

function printPlan(plan: ReleasePlan, output: (line: string) => void) {
  output(`release channel: ${plan.channel}`);
  if (plan.unpublished.length === 0) {
    output("no unpublished workspace versions");
    return;
  }
  for (const item of plan.packages) {
    output(
      `${item.name}@${item.version} ${item.published ? "published" : `unpublished -> ${plan.channel}`}`,
    );
  }
}

async function readPolicy(cwd: string): Promise<ReleasePolicy> {
  const file = path.join(cwd, "tools", "release-channels.json");
  try {
    return JSON.parse(await readFile(file, "utf8")) as ReleasePolicy;
  } catch {
    throw new ReleaseGuardError("release channel policy is missing or invalid");
  }
}

function validatePolicy(policy: ReleasePolicy) {
  if (
    !isPlainObject(policy) ||
    !isPlainObject(policy.packages) ||
    typeof policy.registry !== "string"
  ) {
    throw new ReleaseGuardError("release channel policy is malformed");
  }
  if (normalizeRegistry(policy.registry) !== normalizeRegistry(PUBLIC_REGISTRY)) {
    throw new ReleaseGuardError("release channel policy must use the public npm registry");
  }
  const entries = Object.entries(policy.packages);
  const approvedNames = Object.keys(APPROVED_POLICY).sort();
  if (
    entries.length !== approvedNames.length ||
    entries
      .map(([name]) => name)
      .sort()
      .some((name, index) => name !== approvedNames[index])
  ) {
    throw new ReleaseGuardError(
      "release channel policy must contain exactly six approved packages",
    );
  }
  for (const [name, rawEntry] of entries) {
    if (!isPlainObject(rawEntry)) throw new ReleaseGuardError(`invalid policy entry for ${name}`);
    const expected = APPROVED_POLICY[name];
    if (
      rawEntry.releaseClass !== expected.releaseClass ||
      rawEntry.channel !== expected.channel ||
      rawEntry.frozenLatest !== expected.frozenLatest
    ) {
      throw new ReleaseGuardError(
        `policy entry for ${name} does not match the approved release class`,
      );
    }
  }
}

type WorkspacePackage = {
  name: string;
  version: string;
  manifest: Record<string, unknown>;
};

async function readWorkspace(cwd: string, policy: ReleasePolicy): Promise<WorkspacePackage[]> {
  const root = await readJson(path.join(cwd, "package.json"), "root package manifest");
  if (
    !Array.isArray(root.workspaces) ||
    root.workspaces.length !== 1 ||
    root.workspaces[0] !== "packages/*" ||
    root.private !== true
  ) {
    throw new ReleaseGuardError(
      "workspace configuration is not the approved packages/* private root",
    );
  }

  const packageDirectory = path.join(cwd, "packages");
  let entries: Dirent<string>[];
  try {
    entries = await readdir(packageDirectory, { encoding: "utf8", withFileTypes: true });
  } catch {
    throw new ReleaseGuardError("workspace packages directory is missing");
  }
  const manifests = new Map<string, WorkspacePackage>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(packageDirectory, entry.name, "package.json");
    const manifest = await readJson(file, `${entry.name} package manifest`);
    if (typeof manifest.name !== "string") {
      throw new ReleaseGuardError(`workspace manifest ${entry.name} has no package name`);
    }
    if (manifests.has(manifest.name))
      throw new ReleaseGuardError(`duplicate workspace package ${manifest.name}`);
    manifests.set(manifest.name, {
      name: manifest.name,
      version: typeof manifest.version === "string" ? manifest.version : "",
      manifest,
    });
  }

  const expected = Object.keys(policy.packages);
  const actual = [...manifests.keys()].sort();
  if (
    actual.length !== expected.length ||
    actual.some((name, index) => name !== [...expected].sort()[index])
  ) {
    throw new ReleaseGuardError(
      "workspace policy mismatch: expected exactly the six approved packages",
    );
  }

  return expected.map((name) => {
    const item = manifests.get(name);
    if (!item) throw new ReleaseGuardError(`workspace package ${name} is missing`);
    validateManifest(item, policy.packages[name]);
    return item;
  });
}

function validateManifest(item: WorkspacePackage, policy: PolicyEntry) {
  if (item.manifest.private === true) throw new ReleaseGuardError(`${item.name} is private`);
  if (!isStableVersion(item.version)) {
    throw new ReleaseGuardError(`${item.name} must use a stable semver version`);
  }
  const major = majorVersion(item.version);
  if (policy.releaseClass === "v1" && major !== 1) {
    throw new ReleaseGuardError(`${item.name} must remain on V1 major 1`);
  }
  if (
    policy.releaseClass === "frozen-v1-v2" &&
    item.version !== policy.frozenLatest &&
    (major === undefined || major < 2)
  ) {
    throw new ReleaseGuardError(
      `${item.name} may only use its frozen V1 baseline or a stable package version >=2.0.0 for OpenCode 2`,
    );
  }
  if (item.manifest.publishConfig !== undefined) {
    if (!isPlainObject(item.manifest.publishConfig)) {
      throw new ReleaseGuardError(`${item.name} has invalid publishConfig`);
    }
    for (const key of Object.keys(item.manifest.publishConfig)) {
      if (key.toLowerCase() === "directory")
        throw new ReleaseGuardError(`${item.name} uses publishConfig.directory`);
      if (key.toLowerCase().includes("registry")) {
        throw new ReleaseGuardError(`${item.name} uses a custom registry`);
      }
    }
  }
}

async function validateRegistryConfiguration(
  cwd: string,
  env: NodeJS.ProcessEnv,
  registry: string,
) {
  if (normalizeRegistry(registry) !== normalizeRegistry(PUBLIC_REGISTRY)) {
    throw new ReleaseGuardError("custom registry is not allowed");
  }
  const npmConfigFiles = new Set<string>([
    path.join(cwd, ".npmrc"),
    path.join(env.HOME ?? "", ".npmrc"),
  ]);
  const explicitNpmConfigFiles = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    const lower = key.toLowerCase();
    if (lower === "npm_config_registry") {
      if (value && normalizeRegistry(value) !== normalizeRegistry(PUBLIC_REGISTRY)) {
        throw new ReleaseGuardError("custom registry in npm environment is not allowed");
      }
    } else if (lower.endsWith(":registry") && lower.startsWith("npm_config_")) {
      throw new ReleaseGuardError("custom scope registry in npm environment is not allowed");
    } else if (
      (lower === "npm_config_userconfig" || lower === "npm_config_globalconfig") &&
      value &&
      value !== "/dev/null"
    ) {
      npmConfigFiles.add(value);
      explicitNpmConfigFiles.add(value);
    }
  }

  const changesetConfig = await readOptionalJson(path.join(cwd, ".changeset", "config.json"));
  if (
    changesetConfig &&
    Object.keys(changesetConfig).some((key) => key.toLowerCase().includes("registry"))
  ) {
    throw new ReleaseGuardError("custom registry in Changesets configuration is not allowed");
  }
  for (const npmrc of npmConfigFiles) {
    if (!npmrc || !(await fileExists(npmrc))) {
      if (explicitNpmConfigFiles.has(npmrc)) {
        throw new ReleaseGuardError("configured npm file is missing");
      }
      continue;
    }
    const content = await readFile(npmrc, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const uncommented = line.replace(/\s+#.*$/, "").trim();
      const separator = uncommented.indexOf("=");
      if (separator < 0) continue;
      const key = uncommented.slice(0, separator).trim().toLowerCase();
      const value = uncommented.slice(separator + 1).trim();
      if (key === "registry" && normalizeRegistry(value) !== normalizeRegistry(PUBLIC_REGISTRY)) {
        throw new ReleaseGuardError("custom registry in .npmrc is not allowed");
      }
      if (key.endsWith(":registry")) {
        throw new ReleaseGuardError("custom scope registry in .npmrc is not allowed");
      }
    }
  }
}

function createPublicRegistryClient(registry: string): RegistryClient {
  return async (name) => {
    const url = `${registry}${encodeURIComponent(name)}`;
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
      });
    } catch {
      throw new ReleaseGuardError(`registry metadata request failed for ${name}`);
    }
    if (!response.ok)
      throw new ReleaseGuardError(
        `registry metadata request for ${name} returned HTTP ${response.status}`,
      );
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ReleaseGuardError(`registry metadata for ${name} is unreadable`);
    }
    if (!text.trim() || Buffer.byteLength(text) > MAX_PACKUMENT_BYTES) {
      throw new ReleaseGuardError(`registry metadata for ${name} is empty or too large`);
    }
    try {
      const packument = JSON.parse(text) as {
        versions?: Record<string, unknown>;
        "dist-tags"?: Record<string, string>;
      };
      return {
        versions: packument.versions ?? {},
        distTags: packument["dist-tags"] ?? {},
      };
    } catch {
      throw new ReleaseGuardError(`registry metadata for ${name} is malformed`);
    }
  };
}

function validateRegistrySnapshot(name: string, snapshot: RegistrySnapshot) {
  if (
    !isPlainObject(snapshot) ||
    !isPlainObject(snapshot.versions) ||
    !isPlainObject(snapshot.distTags)
  ) {
    throw new ReleaseGuardError(`registry metadata for ${name} is malformed`);
  }
  const versions = Object.keys(snapshot.versions);
  if (versions.length === 0 || versions.some((version) => !isVersion(version))) {
    throw new ReleaseGuardError(`registry metadata for ${name} is malformed`);
  }
  if (Object.keys(snapshot.distTags).length === 0 || typeof snapshot.distTags.latest !== "string") {
    throw new ReleaseGuardError(`registry metadata for ${name} is malformed or missing latest`);
  }
  if (Object.values(snapshot.distTags).some((version) => !isVersion(version))) {
    throw new ReleaseGuardError(`registry metadata for ${name} has malformed dist-tags`);
  }
  if (!isVersion(snapshot.distTags.latest) || !hasVersion(snapshot, snapshot.distTags.latest)) {
    throw new ReleaseGuardError(`registry metadata for ${name} has an invalid latest tag`);
  }
}

function hasVersion(snapshot: RegistrySnapshot, version: string | undefined): boolean {
  return version !== undefined && Object.hasOwn(snapshot.versions, version);
}

function validatePublishGates(env: NodeJS.ProcessEnv) {
  if (env.CI !== "true") throw new ReleaseGuardError("--publish requires CI=true");
  if (env.GITHUB_REF !== "refs/heads/main" || env.GITHUB_REF_NAME !== "main") {
    throw new ReleaseGuardError("--publish requires the main branch");
  }
  if (
    env.RELEASE_BUN_VERSION !== "1.3.12" ||
    env.RELEASE_NODE_VERSION !== "24.11.1" ||
    env.RELEASE_NPM_VERSION !== "11.19.0"
  ) {
    throw new ReleaseGuardError("--publish requires the pinned toolchain versions");
  }
}

function warnToStderr(line: string) {
  console.error(line);
}

const defaultChangesetsFilesystem: ChangesetsFilesystem = {
  writeFile: async (file, data) => {
    await writeFile(file, data);
  },
  removeDirectory: async (directory) => {
    await rm(directory, { recursive: true, force: true });
  },
};

/**
 * Builds the child environment for one Changesets publish. npm rejects the same
 * file as both "user" and "global" config ("double-loading config"), and
 * Changesets reads the resulting empty `npm info` output as E404 for every
 * package. The two config files therefore live in one privately owned tempdir
 * as distinct, empty files, and dispose() removes only that directory. dispose()
 * stays retryable after a removal failure, and a failed setup cleans up the
 * partially created directory while preserving the original setup error.
 */
export async function createChangesetsEnvironment(
  options: ChangesetsEnvironmentOptions = {},
): Promise<ChangesetsEnvironment> {
  const baseEnv = options.env ?? process.env;
  const registry = options.registry ?? PUBLIC_REGISTRY;
  const warn = options.warn ?? warnToStderr;
  const filesystem: ChangesetsFilesystem = {
    ...defaultChangesetsFilesystem,
    ...options.testOnlyFilesystem,
  };
  const directory = await mkdtemp(path.join(os.tmpdir(), "release-channel-guard-"));
  const userConfig = path.join(directory, "npm-user.npmrc");
  const globalConfig = path.join(directory, "npm-global.npmrc");
  try {
    await filesystem.writeFile(userConfig, "");
    await filesystem.writeFile(globalConfig, "");
  } catch (error) {
    try {
      await filesystem.removeDirectory(directory);
    } catch {
      warn(
        "release-channel-guard: could not clean up a partial private npm configuration directory",
      );
    }
    throw error;
  }
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    HUSKY: "0",
    NPM_CONFIG_REGISTRY: registry,
    npm_config_registry: registry,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig,
    NPM_CONFIG_GLOBALCONFIG: globalConfig,
    npm_config_globalconfig: globalConfig,
  };
  let disposed = false;
  return {
    env,
    dispose: async () => {
      if (disposed) return;
      await filesystem.removeDirectory(directory);
      disposed = true;
    },
  };
}

/** Fails closed when npm cannot resolve the registry the guard configured. */
async function validateNpmConfiguration(env: NodeJS.ProcessEnv, cwd: string) {
  const expected = env.NPM_CONFIG_REGISTRY;
  const configured = env.npm_config_registry;
  if (!expected || !configured || normalizeRegistry(expected) !== normalizeRegistry(configured)) {
    throw new ReleaseGuardError("npm configuration check requires one consistent registry");
  }
  let stdout: string;
  try {
    const result = await execFileAsync("npm", ["config", "get", "registry"], {
      cwd,
      env,
      encoding: "utf8",
      timeout: NPM_CONFIG_TIMEOUT_MS,
      maxBuffer: MAX_NPM_OUTPUT_BYTES,
    });
    stdout = result.stdout;
  } catch (error) {
    const exitCode = childExitCode(error);
    if (exitCode === undefined) {
      throw new ReleaseGuardError("npm configuration check could not complete");
    }
    throw new ReleaseGuardError(`npm configuration check failed with status ${exitCode}`);
  }
  if (normalizeRegistry(stdout.trim()) !== normalizeRegistry(expected)) {
    throw new ReleaseGuardError("npm configuration check resolved an unexpected registry");
  }
}

function childExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "number" ? error.code : undefined;
}

export const runChangesets: ChangesetsRunner = async (args, env, cwd) => {
  await validateNpmConfiguration(env, cwd);
  const cli = path.join(cwd, "node_modules", "@changesets", "cli", "bin.js");
  const packageJson = await readJson(
    path.join(cwd, "node_modules", "@changesets", "cli", "package.json"),
    "Changesets CLI manifest",
  );
  if (packageJson.version !== CHANGESETS_VERSION) {
    throw new ReleaseGuardError(`expected Changesets CLI ${CHANGESETS_VERSION}`);
  }
  return await new Promise<number>((resolve, reject) => {
    const child = spawn("node", [cli, ...args], { cwd, env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
};

async function readJson(file: string, label: string): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    throw new ReleaseGuardError(`${label} is missing or invalid`);
  }
}

async function readOptionalJson(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw new ReleaseGuardError("Changesets configuration is malformed");
  }
}

async function fileExists(file: string) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function isNotFound(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRegistry(value: string) {
  return value.replace(/\/+$/, "");
}

function isStableVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[0-9A-Za-z.-]+)?$/.test(value)
  );
}

function isVersion(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(
      value,
    )
  );
}

function majorVersion(value: string) {
  return isStableVersion(value) ? Number(value.slice(0, value.indexOf("."))) : undefined;
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ReleaseGuardError(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !["--check", "--publish"].includes(args[0])) {
    console.error("usage: bun tools/release-channel-guard.ts --check|--publish");
    process.exitCode = 2;
    return;
  }
  try {
    await runReleaseGuard({ mode: args[0] === "--check" ? "check" : "publish" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "release channel guard failed";
    console.error(`release-channel-guard: ${message}`);
    process.exitCode = error instanceof ReleaseGuardError ? error.exitCode : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main();
}
