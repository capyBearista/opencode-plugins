import { createHash, randomUUID } from "node:crypto";
import type { Dirent } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { validateAgentContent } from "./agent-source.js";

const manifestVersion = 1 as const;
const manifestDirectoryName = ".agents-loader";
const defaultPollIntervalMs = 500;
const defaultLockAttempts = 20;
const defaultLockDelayMs = 25;
type BridgeDestination = "commands" | "agents";

interface BridgeDomain {
  readonly destination: BridgeDestination;
  readonly manifestFileName: string;
  readonly lockFileName: string;
  readonly sourceDirectories: readonly string[];
  readonly nativeDirectories: readonly string[];
  readonly configNames: readonly string[];
  readonly validateSource?: (
    source: string,
    content: Buffer,
    home: string,
  ) => string | undefined | Promise<string | undefined>;
}

const commandDomain: BridgeDomain = {
  destination: "commands",
  manifestFileName: "commands-manifest.json",
  lockFileName: "commands.lock",
  sourceDirectories: ["command", "commands"],
  nativeDirectories: ["command", "commands"],
  configNames: ["commands", "command"],
};

const agentDomain: BridgeDomain = {
  destination: "agents",
  manifestFileName: "agents-manifest.json",
  lockFileName: "agents.lock",
  sourceDirectories: ["agent", "agents"],
  nativeDirectories: ["agent", "agents", "mode", "modes"],
  configNames: ["agents", "agent", "mode"],
  validateSource: validateAgentContent,
};

export interface CommandBridgeLocation {
  readonly directory: string;
  readonly project: {
    readonly directory: string;
  };
}

export interface CommandBridgeContext {
  readonly location: CommandBridgeLocation;
  readonly command: {
    readonly reload: () => Promise<void>;
  };
}

export interface AgentBridgeContext {
  readonly location: CommandBridgeLocation;
  readonly agent: {
    readonly reload: () => Promise<void>;
  };
}

export interface CommandBridgeScheduler {
  readonly setInterval: (callback: () => void | Promise<void>, delay: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
}

export interface CommandBridgeOptions {
  readonly home?: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly pollIntervalMs?: number;
  readonly scheduler?: CommandBridgeScheduler;
  readonly diagnostics?: (message: string) => void;
  readonly lockAttempts?: number;
  readonly lockDelayMs?: number;
}

export interface CommandBridgeScopeResult {
  readonly scope: string;
  readonly safe: boolean;
  readonly changed: boolean;
  readonly fingerprint: string;
}

export interface CommandBridgeSyncResult {
  readonly safe: boolean;
  readonly changed: boolean;
  readonly fingerprint: string;
  readonly scopes: readonly CommandBridgeScopeResult[];
}

export interface CommandBridgeHandle {
  readonly sync: () => Promise<CommandBridgeSyncResult>;
  readonly dispose: () => Promise<void>;
}

export type AgentBridgeOptions = CommandBridgeOptions;
export type AgentBridgeHandle = CommandBridgeHandle;
export type AgentBridgeScopeResult = CommandBridgeScopeResult;
export type AgentBridgeSyncResult = CommandBridgeSyncResult;

interface ScopeSpec {
  readonly id: string;
  readonly kind: "project" | "global";
  readonly scope: string;
  readonly sourceRoot: string;
  readonly destinationParent: string;
}

interface SourceCandidate {
  readonly name: string;
  readonly source: string;
  readonly fingerprint: string;
}

interface ManifestEntry {
  readonly destination: string;
  readonly source: string;
  readonly target: string;
}

interface CommandManifest {
  readonly version: typeof manifestVersion;
  readonly destination: BridgeDestination;
  readonly links: readonly ManifestEntry[];
}

interface SourceScan {
  readonly files: ReadonlyMap<string, SourceCandidate>;
  readonly invalid: ReadonlyMap<string, SourceCandidate>;
}

interface ManifestState {
  readonly manifest: CommandManifest;
  readonly present: boolean;
}

interface ScopeSnapshot {
  readonly source: SourceScan;
  readonly nativeNames: ReadonlySet<string>;
  readonly links: readonly ManifestEntry[];
}

interface ScopeReconcileResult extends CommandBridgeScopeResult {
  readonly snapshot: ScopeSnapshot;
}

class UnsafeScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeScopeError";
  }
}

const defaultScheduler: CommandBridgeScheduler = {
  setInterval: (callback, delay) => setInterval(callback, delay),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export async function startCommandBridge(
  context: CommandBridgeContext,
  options: CommandBridgeOptions = {},
): Promise<CommandBridgeHandle> {
  return startNativeBridge(
    { location: context.location, reload: context.command.reload },
    commandDomain,
    options,
  );
}

export async function startAgentBridge(
  context: AgentBridgeContext,
  options: AgentBridgeOptions = {},
): Promise<AgentBridgeHandle> {
  return startNativeBridge(
    { location: context.location, reload: context.agent.reload },
    agentDomain,
    options,
  );
}

async function startNativeBridge(
  context: { readonly location: CommandBridgeLocation; readonly reload: () => Promise<void> },
  domain: BridgeDomain,
  options: CommandBridgeOptions,
): Promise<CommandBridgeHandle> {
  const diagnostics = dedupeConsecutiveDiagnostics(options.diagnostics);
  let disposed = false;
  let polling = false;
  let activePoll: Promise<void> | undefined;
  let lastFingerprint: string | undefined;

  const initial = await syncNativeLinks(context.location, domain, { ...options, diagnostics });
  let lastResult = initial;
  if (initial.safe) {
    lastFingerprint = initial.fingerprint;
  }

  const poll = async () => {
    if (disposed || polling) return;
    polling = true;
    const operation = (async () => {
      try {
        const next = await syncNativeLinks(context.location, domain, { ...options, diagnostics });
        lastResult = next;
        if (!next.safe) return;
        const changed = lastFingerprint === undefined || lastFingerprint !== next.fingerprint;
        lastFingerprint = next.fingerprint;
        if (changed) await context.reload();
      } catch (error) {
        diagnostics(`${domain.destination} bridge polling failed: ${formatError(error)}`);
      } finally {
        polling = false;
      }
    })();
    activePoll = operation;
    await operation;
    activePoll = undefined;
  };

  const scheduler = options.scheduler ?? defaultScheduler;
  const interval = scheduler.setInterval(
    () => poll(),
    normalizePollInterval(options.pollIntervalMs),
  );
  const possibleTimer = interval as { unref?: () => void };
  if (possibleTimer !== null && possibleTimer !== undefined) possibleTimer.unref?.();

  return {
    sync: async () => {
      await poll();
      return lastResult;
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      scheduler.clearInterval(interval);
      await activePoll;
    },
  };
}

export async function syncCommandLinks(
  location: CommandBridgeLocation,
  options: CommandBridgeOptions = {},
): Promise<CommandBridgeSyncResult> {
  return syncNativeLinks(location, commandDomain, options);
}

export async function syncAgentLinks(
  location: CommandBridgeLocation,
  options: AgentBridgeOptions = {},
): Promise<AgentBridgeSyncResult> {
  return syncNativeLinks(location, agentDomain, options);
}

async function syncNativeLinks(
  location: CommandBridgeLocation,
  domain: BridgeDomain,
  options: CommandBridgeOptions,
): Promise<CommandBridgeSyncResult> {
  const home = path.resolve(options.home ?? os.homedir());
  const environment = options.environment ?? process.env;
  const diagnostics = dedupeConsecutiveDiagnostics(options.diagnostics);
  const projectRoot = path.resolve(location.project.directory);
  const currentDirectory = path.resolve(location.directory);
  if (!isWithin(projectRoot, currentDirectory)) {
    diagnostics(
      `project cwd ${currentDirectory} is outside project root ${projectRoot}; ${domain.destination} bridge stopped safely`,
    );
    const scope = `project:${projectRoot}`;
    return {
      safe: false,
      changed: false,
      fingerprint: "unsafe",
      scopes: [{ scope, safe: false, changed: false, fingerprint: "unsafe" }],
    };
  }
  const scopes = projectScopes(projectRoot, currentDirectory);
  const specs: ScopeSpec[] = scopes.map((scope) => ({
    id: `project:${scope}`,
    kind: "project",
    scope,
    sourceRoot: path.join(scope, ".agents"),
    destinationParent: path.join(scope, ".opencode"),
  }));
  const globalConfigDirectory = path.resolve(
    environment.OPENCODE_CONFIG_DIR ?? path.join(home, ".config", "opencode"),
  );
  specs.push({
    id: `global:${globalConfigDirectory}`,
    kind: "global",
    scope: home,
    sourceRoot: path.join(home, ".agents"),
    destinationParent: globalConfigDirectory,
  });

  const results: ScopeReconcileResult[] = [];
  for (const spec of specs) {
    results.push(
      await reconcileScope(spec, {
        domain,
        home,
        environment,
        currentDirectory,
        diagnostics,
        lockAttempts: options.lockAttempts,
        lockDelayMs: options.lockDelayMs,
      }),
    );
  }

  const safe = results.every((result) => result.safe);
  const fingerprint = safe
    ? fingerprintValue(
        results.map((result) => ({
          scope: result.scope,
          snapshot: snapshotValue(result.snapshot),
        })),
      )
    : "unsafe";
  return {
    safe,
    changed: results.some((result) => result.changed),
    fingerprint,
    scopes: results.map(({ scope, safe: resultSafe, changed, fingerprint: resultFingerprint }) => ({
      scope,
      safe: resultSafe,
      changed,
      fingerprint: resultFingerprint,
    })),
  };
}

interface ReconcileOptions {
  readonly domain: BridgeDomain;
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly currentDirectory: string;
  readonly diagnostics: (message: string) => void;
  readonly lockAttempts?: number;
  readonly lockDelayMs?: number;
}

async function reconcileScope(
  spec: ScopeSpec,
  options: ReconcileOptions,
): Promise<ScopeReconcileResult> {
  let source: SourceScan;
  try {
    source = await scanSources(spec.sourceRoot, options.domain, options.home, options.diagnostics);
  } catch (error) {
    options.diagnostics(`${spec.id}: source census stopped safely: ${formatError(error)}`);
    return emptyUnsafeResult(spec);
  }

  const manifestDirectory = path.join(spec.destinationParent, manifestDirectoryName);
  const destinationRoot = path.join(spec.destinationParent, options.domain.destination);
  let manifestState: ManifestState;
  try {
    manifestState = await readManifest(
      manifestDirectory,
      destinationRoot,
      spec.sourceRoot,
      options.domain,
    );
  } catch (error) {
    options.diagnostics(`${spec.id}: manifest validation stopped safely: ${formatError(error)}`);
    return emptyUnsafeResult(spec);
  }

  if (source.files.size === 0 && manifestState.manifest.links.length === 0) {
    return {
      scope: spec.id,
      safe: true,
      changed: false,
      fingerprint: fingerprintValue({ source: sourceValue(source), native: [], links: [] }),
      snapshot: { source, nativeNames: new Set(), links: [] },
    };
  }

  try {
    await ensureDirectoryPath(destinationRoot);
    await ensureDirectoryPath(manifestDirectory);
  } catch (error) {
    options.diagnostics(`${spec.id}: destination path stopped safely: ${formatError(error)}`);
    return emptyUnsafeResult(spec);
  }

  let result: ScopeReconcileResult;
  try {
    result = await withScopeLock(
      manifestDirectory,
      options.domain.lockFileName,
      options.lockAttempts ?? defaultLockAttempts,
      options.lockDelayMs ?? defaultLockDelayMs,
      async () => reconcileLocked(spec, options),
    );
  } catch (error) {
    options.diagnostics(`${spec.id}: reconciliation stopped safely: ${formatError(error)}`);
    return emptyUnsafeResult(spec);
  }
  return result;
}

async function reconcileLocked(
  spec: ScopeSpec,
  options: ReconcileOptions,
): Promise<ScopeReconcileResult> {
  const manifestDirectory = path.join(spec.destinationParent, manifestDirectoryName);
  const destinationRoot = path.join(spec.destinationParent, options.domain.destination);
  const source = await scanSources(
    spec.sourceRoot,
    options.domain,
    options.home,
    options.diagnostics,
  );
  const manifestState = await readManifest(
    manifestDirectory,
    destinationRoot,
    spec.sourceRoot,
    options.domain,
  );
  const nativeNames = await scanNativeNames(spec, destinationRoot, manifestState.manifest, options);
  const candidates = new Map<string, SourceCandidate>();
  for (const [name, candidate] of source.files) {
    if (!nativeNames.has(name)) candidates.set(name, candidate);
  }

  const oldLinks = [...manifestState.manifest.links].toSorted((left, right) =>
    left.destination.localeCompare(right.destination),
  );
  const desiredLinks = new Map<string, ManifestEntry>();
  for (const candidate of [...candidates.values()].toSorted((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const destination = `${candidate.name}.md`;
    const destinationPath = path.join(destinationRoot, ...destination.split("/"));
    const target = path.relative(path.dirname(destinationPath), candidate.source);
    if (
      !isRelativeTarget(target) ||
      path.resolve(path.dirname(destinationPath), target) !== candidate.source
    ) {
      options.diagnostics(`${spec.id}: rejected unsafe source target for ${destination}`);
      continue;
    }
    desiredLinks.set(destination, { destination, source: candidate.source, target });
  }

  await validateDestinationParents(destinationRoot, [...oldLinks, ...desiredLinks.values()]);
  const retained = new Map<string, ManifestEntry>();
  let changed = false;

  for (const oldLink of oldLinks) {
    const destinationPath = destinationPathFor(destinationRoot, oldLink.destination);
    const actual = await readDestination(destinationPath);
    const desired = desiredLinks.get(oldLink.destination);
    const ownsActual =
      actual?.kind === "symlink" && (await readlink(destinationPath, "utf8")) === oldLink.target;
    if (
      desired &&
      desired.source === oldLink.source &&
      desired.target === oldLink.target &&
      ownsActual
    ) {
      retained.set(oldLink.destination, oldLink);
      continue;
    }

    if (ownsActual) {
      try {
        await unlink(destinationPath);
        changed = true;
      } catch (error) {
        options.diagnostics(
          `${spec.id}: could not remove owned stale link ${oldLink.destination}: ${formatError(error)}`,
        );
      }
    } else if (actual !== undefined) {
      options.diagnostics(`${spec.id}: preserved user-owned destination ${oldLink.destination}`);
    } else {
      changed = true;
    }
  }

  for (const desired of desiredLinks.values()) {
    if (retained.has(desired.destination)) continue;
    const destinationPath = destinationPathFor(destinationRoot, desired.destination);
    const actual = await readDestination(destinationPath);
    if (actual !== undefined) {
      options.diagnostics(`${spec.id}: preserved existing destination ${desired.destination}`);
      continue;
    }
    await ensureDirectoryPath(path.dirname(destinationPath));
    try {
      await symlink(desired.target, destinationPath);
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        options.diagnostics(
          `${spec.id}: destination appeared during link creation; skipped ${desired.destination}`,
        );
        continue;
      }
      throw error;
    }
    if (
      (await readDestination(destinationPath))?.kind !== "symlink" ||
      (await readlink(destinationPath, "utf8")) !== desired.target
    ) {
      options.diagnostics(
        `${spec.id}: link verification failed; ownership was not recorded for ${desired.destination}`,
      );
      continue;
    }
    retained.set(desired.destination, desired);
    changed = true;
  }

  const links = [...retained.values()].toSorted((left, right) =>
    left.destination.localeCompare(right.destination),
  );
  const manifest: CommandManifest = {
    version: manifestVersion,
    destination: options.domain.destination,
    links,
  };
  if (!sameLinks(oldLinks, links) || (!manifestState.present && source.files.size > 0)) {
    await writeManifest(manifestDirectory, manifest, options.domain);
    changed = true;
  }

  const snapshot: ScopeSnapshot = { source, nativeNames, links };
  return {
    scope: spec.id,
    safe: true,
    changed,
    fingerprint: fingerprintValue(snapshotValue(snapshot)),
    snapshot,
  };
}

async function scanSources(
  sourceRoot: string,
  domain: BridgeDomain,
  home: string,
  diagnostics: (message: string) => void,
): Promise<SourceScan> {
  const files = new Map<string, SourceCandidate>();
  const invalid = new Map<string, SourceCandidate>();
  const rootState = await existingState(sourceRoot);
  if (rootState === "missing") return { files, invalid };
  if (rootState !== "directory")
    throw new UnsafeScopeError(`${sourceRoot} is not a regular directory`);
  await assertNoSymlinkParents(sourceRoot);

  for (const sourceDirectory of domain.sourceDirectories) {
    const directory = path.join(sourceRoot, sourceDirectory);
    const state = await existingState(directory);
    if (state === "missing") continue;
    if (state !== "directory")
      throw new UnsafeScopeError(`${directory} is not a regular directory`);
    await visitSourceDirectory(directory, directory, files, invalid, domain, home, diagnostics);
  }
  return { files, invalid };
}

async function visitSourceDirectory(
  directory: string,
  root: string,
  files: Map<string, SourceCandidate>,
  invalid: Map<string, SourceCandidate>,
  domain: BridgeDomain,
  home: string,
  diagnostics: (message: string) => void,
): Promise<void> {
  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    throw new UnsafeScopeError(`cannot read ${directory}: ${formatError(error)}`);
  }

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visitSourceDirectory(filePath, root, files, invalid, domain, home, diagnostics);
      continue;
    }
    if (entry.isSymbolicLink())
      throw new UnsafeScopeError(`source symlink is not allowed: ${filePath}`);
    if (!entry.isFile() || !filePath.endsWith(".md")) continue;

    let content: Buffer;
    try {
      content = await readFile(filePath);
    } catch (error) {
      throw new UnsafeScopeError(`cannot read ${filePath}: ${formatError(error)}`);
    }
    const relative = path.relative(root, filePath).replaceAll(path.sep, "/");
    const name = relative.slice(0, -3);
    if (!isSafeRelative(name)) throw new UnsafeScopeError(`unsafe source name: ${relative}`);
    if (domain.validateSource) {
      let validation: string | undefined;
      try {
        validation = await domain.validateSource(filePath, content, home);
      } catch (error) {
        validation = `validation failed: ${formatError(error)}`;
      }
      if (validation !== undefined) {
        diagnostics(`skipped invalid native source ${filePath}: ${validation}`);
        invalid.set(name, {
          name,
          source: path.resolve(filePath),
          fingerprint: createHash("sha256").update(content).digest("hex"),
        });
        continue;
      }
    }
    files.set(name, {
      name,
      source: path.resolve(filePath),
      fingerprint: createHash("sha256").update(content).digest("hex"),
    });
  }
}

async function scanNativeNames(
  spec: ScopeSpec,
  destinationRoot: string,
  manifest: CommandManifest,
  options: ReconcileOptions,
): Promise<Set<string>> {
  const names = new Set<string>();
  const owned = new Map(manifest.links.map((link) => [link.destination, link]));
  for (const sourceDirectory of options.domain.nativeDirectories) {
    await visitNativeDirectory(
      path.join(spec.destinationParent, sourceDirectory),
      sourceDirectory,
      options.domain,
      destinationRoot,
      owned,
      names,
      options.diagnostics,
    );
  }

  const configFiles = new Set<string>();
  if (spec.kind === "project") {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      configFiles.add(path.join(spec.scope, name));
      configFiles.add(path.join(spec.destinationParent, name));
    }
  } else {
    for (const name of ["opencode.json", "opencode.jsonc"])
      configFiles.add(path.join(spec.destinationParent, name));
  }

  const explicit = options.environment.OPENCODE_CONFIG;
  if (explicit) configFiles.add(path.resolve(options.currentDirectory, explicit));
  for (const file of configFiles)
    await collectConfigNames(file, names, options.domain.configNames, options.diagnostics);

  const content = options.environment.OPENCODE_CONFIG_CONTENT;
  if (content)
    collectConfigNamesFromText(
      content,
      "OPENCODE_CONFIG_CONTENT",
      names,
      options.domain.configNames,
      options.diagnostics,
    );
  return names;
}

async function visitNativeDirectory(
  directory: string,
  sourceDirectory: string,
  domain: BridgeDomain,
  destinationRoot: string,
  owned: ReadonlyMap<string, ManifestEntry>,
  names: Set<string>,
  diagnostics: (message: string) => void,
  visited = new Set<string>(),
): Promise<void> {
  let state: "missing" | "directory" | "file" | "symlink";
  try {
    state = await existingState(directory);
  } catch (error) {
    throw new UnsafeScopeError(`cannot inspect ${directory}: ${formatError(error)}`);
  }
  if (state === "missing") return;
  if (state === "file") throw new UnsafeScopeError(`${directory} is not a directory`);
  let identity: string;
  try {
    identity = await realpath(directory);
  } catch (error) {
    throw new UnsafeScopeError(
      `cannot resolve native directory ${directory}: ${formatError(error)}`,
    );
  }
  if (visited.has(identity)) return;
  visited.add(identity);

  let entries: Dirent<string>[];
  try {
    entries = await readdir(directory, { encoding: "utf8", withFileTypes: true });
  } catch (error) {
    throw new UnsafeScopeError(`cannot read native directory ${directory}: ${formatError(error)}`);
  }

  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await visitNativeDirectory(
        filePath,
        sourceDirectory,
        domain,
        destinationRoot,
        owned,
        names,
        diagnostics,
        visited,
      );
      continue;
    }
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    if (!filePath.endsWith(".md")) continue;
    const relative = path
      .relative(path.join(path.dirname(destinationRoot), sourceDirectory), filePath)
      .replaceAll(path.sep, "/");
    const name = relative.slice(0, -3);
    if (!isSafeRelative(name)) continue;
    if (
      sourceDirectory === domain.destination &&
      path.resolve(path.dirname(destinationRoot), sourceDirectory, ...relative.split("/")) ===
        path.resolve(destinationRoot, relative)
    ) {
      const ownedEntry = owned.get(relative);
      const actual = await readDestination(filePath);
      if (actual?.kind === "symlink") {
        const target = await readlink(filePath, "utf8");
        if (ownedEntry && target === ownedEntry.target) continue;
        diagnostics(`preserved unowned native symlink ${filePath}`);
      }
    }
    names.add(name);
  }
}

async function collectConfigNames(
  file: string,
  names: Set<string>,
  configNames: readonly string[],
  diagnostics: (message: string) => void,
): Promise<void> {
  let content: string;
  try {
    content = await readFile(file, "utf8");
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return;
    diagnostics(`native config census skipped unreadable ${file}: ${formatError(error)}`);
    return;
  }
  collectConfigNamesFromText(content, file, names, configNames, diagnostics);
}

function collectConfigNamesFromText(
  content: string,
  source: string,
  names: Set<string>,
  configNames: readonly string[],
  diagnostics: (message: string) => void,
): void {
  try {
    const value = parseJsonc(content);
    if (!isRecord(value)) return;
    for (const key of configNames) collectMapNames(value[key], names);
  } catch (error) {
    diagnostics(`native config census skipped malformed ${source}: ${formatError(error)}`);
  }
}

async function readManifest(
  manifestDirectory: string,
  destinationRoot: string,
  sourceRoot: string,
  domain: BridgeDomain,
): Promise<ManifestState> {
  const directoryState = await existingState(manifestDirectory);
  if (directoryState === "missing") return { manifest: emptyManifest(domain), present: false };
  if (directoryState !== "directory")
    throw new UnsafeScopeError(`${manifestDirectory} is not a regular directory`);
  await assertNoSymlinkParents(manifestDirectory);
  const manifestPath = path.join(manifestDirectory, domain.manifestFileName);
  let state: "missing" | "directory" | "file" | "symlink";
  try {
    state = await existingState(manifestPath);
  } catch (error) {
    throw new UnsafeScopeError(`cannot inspect ${manifestPath}: ${formatError(error)}`);
  }
  if (state === "missing") return { manifest: emptyManifest(domain), present: false };
  if (state !== "file")
    throw new UnsafeScopeError(`${manifestPath} is not a regular manifest file`);

  let value: unknown;
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    throw new UnsafeScopeError(`cannot parse ${manifestPath}: ${formatError(error)}`);
  }
  if (
    !isRecord(value) ||
    value.version !== manifestVersion ||
    value.destination !== domain.destination ||
    !Array.isArray(value.links)
  ) {
    throw new UnsafeScopeError(`invalid ${manifestPath} shape`);
  }

  const links: ManifestEntry[] = [];
  const destinations = new Set<string>();
  for (const raw of value.links) {
    if (
      !isRecord(raw) ||
      typeof raw.destination !== "string" ||
      typeof raw.source !== "string" ||
      typeof raw.target !== "string"
    ) {
      throw new UnsafeScopeError(`invalid link entry in ${manifestPath}`);
    }
    if (
      !isSafeRelative(raw.destination) ||
      !raw.destination.endsWith(".md") ||
      destinations.has(raw.destination)
    ) {
      throw new UnsafeScopeError(`invalid destination in ${manifestPath}: ${raw.destination}`);
    }
    if (
      !path.isAbsolute(raw.source) ||
      !isWithin(sourceRoot, raw.source) ||
      !raw.source.endsWith(".md")
    ) {
      throw new UnsafeScopeError(`invalid source in ${manifestPath}: ${raw.source}`);
    }
    if (sourceName(sourceRoot, raw.source, domain.sourceDirectories) !== raw.destination) {
      throw new UnsafeScopeError(
        `source and destination disagree in ${manifestPath}: ${raw.destination}`,
      );
    }
    const destinationPath = destinationPathFor(destinationRoot, raw.destination);
    if (
      !isRelativeTarget(raw.target) ||
      path.resolve(path.dirname(destinationPath), raw.target) !== path.resolve(raw.source)
    ) {
      throw new UnsafeScopeError(`invalid target in ${manifestPath}: ${raw.target}`);
    }
    destinations.add(raw.destination);
    links.push({
      destination: raw.destination,
      source: path.resolve(raw.source),
      target: raw.target,
    });
  }
  return {
    manifest: { version: manifestVersion, destination: domain.destination, links },
    present: true,
  };
}

async function writeManifest(
  manifestDirectory: string,
  manifest: CommandManifest,
  domain: BridgeDomain,
): Promise<void> {
  const manifestPath = path.join(manifestDirectory, domain.manifestFileName);
  const temporaryPath = path.join(
    manifestDirectory,
    `.${domain.manifestFileName}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, manifestPath);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // A leftover temp file is never a valid manifest and is ignored on the next run.
    }
  }
}

async function withScopeLock<T>(
  manifestDirectory: string,
  lockFileName: string,
  attempts: number,
  delayMs: number,
  callback: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(manifestDirectory, lockFileName);
  const token = randomUUID();
  for (let attempt = 0; attempt < Math.max(1, attempts); attempt++) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(token, "utf8");
      try {
        return await callback();
      } finally {
        await handle.close();
        await releaseLock(lockPath, token);
      }
    } catch (error) {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The handle is already unusable; the ownership check below remains conservative.
        }
        await releaseLock(lockPath, token);
      }
      if (!isErrorCode(error, "EEXIST")) throw error;
      if (attempt + 1 >= Math.max(1, attempts)) throw lockTimeoutError(lockPath);
      await sleep(delayMs);
    }
  }
  throw lockTimeoutError(lockPath);
}

function lockTimeoutError(lockPath: string): UnsafeScopeError {
  return new UnsafeScopeError(
    `cooperating lock timed out at ${lockPath}; manually remove ${lockPath} only after all affected OpenCode instances are stopped`,
  );
}

async function releaseLock(lockPath: string, token: string): Promise<void> {
  try {
    if ((await readFile(lockPath, "utf8")) !== token) return;
    await unlink(lockPath);
  } catch {
    // Never guess at stale ownership. A later instance will fail closed on this lock.
  }
}

async function validateDestinationParents(
  destinationRoot: string,
  links: readonly ManifestEntry[],
): Promise<void> {
  for (const link of links) {
    const destinationPath = destinationPathFor(destinationRoot, link.destination);
    await assertNoSymlinkParents(path.dirname(destinationPath), destinationRoot);
  }
}

async function ensureDirectoryPath(directory: string): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  const relative = path.relative(root, absolute);
  let current = root;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    let state: "missing" | "directory" | "file" | "symlink";
    try {
      state = await existingState(current);
    } catch (error) {
      throw new UnsafeScopeError(`cannot inspect directory ${current}: ${formatError(error)}`);
    }
    if (state === "missing") {
      try {
        await mkdir(current);
      } catch (error) {
        if (!isErrorCode(error, "EEXIST")) throw error;
      }
      state = await existingState(current);
    }
    if (state !== "directory")
      throw new UnsafeScopeError(`directory path escapes through ${current}`);
  }
}

async function assertNoSymlinkParents(directory: string, allowedRootPath?: string): Promise<void> {
  const absolute = path.resolve(directory);
  const allowedRoot = path.resolve(allowedRootPath ?? path.parse(absolute).root);
  if (!isWithin(allowedRoot, absolute))
    throw new UnsafeScopeError(`path escapes allowed root: ${absolute}`);
  const rootState = await existingState(allowedRoot);
  if (rootState === "symlink")
    throw new UnsafeScopeError(`symlink parent rejected: ${allowedRoot}`);
  if (rootState === "file") throw new UnsafeScopeError(`file parent rejected: ${allowedRoot}`);
  const relative = path.relative(allowedRoot, absolute);
  let current = allowedRoot;
  for (const part of relative ? relative.split(path.sep) : []) {
    current = path.join(current, part);
    let state: "missing" | "directory" | "file" | "symlink";
    try {
      state = await existingState(current);
    } catch (error) {
      throw new UnsafeScopeError(`cannot inspect path ${current}: ${formatError(error)}`);
    }
    if (state === "symlink") throw new UnsafeScopeError(`symlink parent rejected: ${current}`);
    if (state === "file") throw new UnsafeScopeError(`file parent rejected: ${current}`);
  }
}

async function readDestination(
  filePath: string,
): Promise<{ readonly kind: "symlink" | "file" | "directory" } | undefined> {
  let state: "missing" | "directory" | "file" | "symlink";
  try {
    state = await existingState(filePath);
  } catch (error) {
    throw new UnsafeScopeError(`cannot inspect destination ${filePath}: ${formatError(error)}`);
  }
  if (state === "missing") return undefined;
  return { kind: state };
}

async function existingState(
  filePath: string,
): Promise<"missing" | "directory" | "file" | "symlink"> {
  try {
    const info = await lstat(filePath);
    if (info.isSymbolicLink()) return "symlink";
    if (info.isDirectory()) return "directory";
    if (info.isFile()) return "file";
    return "file";
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return "missing";
    throw error;
  }
}

function destinationPathFor(destinationRoot: string, relative: string): string {
  if (!isSafeRelative(relative)) throw new UnsafeScopeError(`unsafe destination path: ${relative}`);
  const destination = path.resolve(destinationRoot, ...relative.split("/"));
  if (!isWithin(destinationRoot, destination))
    throw new UnsafeScopeError(`destination escapes root: ${relative}`);
  return destination;
}

function projectScopes(projectRoot: string, currentDirectory: string): string[] {
  const result: string[] = [];
  let current = currentDirectory;
  while (isWithin(projectRoot, current)) {
    result.unshift(current);
    if (current === projectRoot) break;
    current = path.dirname(current);
  }
  return result;
}

function snapshotValue(snapshot: ScopeSnapshot) {
  return {
    source: sourceValue(snapshot.source),
    native: [...snapshot.nativeNames].toSorted(),
    links: snapshot.links,
  };
}

function sourceValue(source: SourceScan) {
  return [...source.files.values(), ...source.invalid.values()]
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map(({ name, source: sourcePath, fingerprint }) => ({
      name,
      source: sourcePath,
      fingerprint,
    }));
}

function fingerprintValue(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function emptyManifest(domain: BridgeDomain): CommandManifest {
  return { version: manifestVersion, destination: domain.destination, links: [] };
}

function emptyUnsafeResult(spec: ScopeSpec): ScopeReconcileResult {
  const snapshot: ScopeSnapshot = {
    source: { files: new Map(), invalid: new Map() },
    nativeNames: new Set(),
    links: [],
  };
  return {
    scope: spec.id,
    safe: false,
    changed: false,
    fingerprint: "unsafe",
    snapshot,
  };
}

function sameLinks(left: readonly ManifestEntry[], right: readonly ManifestEntry[]): boolean {
  if (left.length !== right.length) return false;
  return left.every(
    (entry, index) =>
      entry.destination === right[index]?.destination &&
      entry.source === right[index]?.source &&
      entry.target === right[index]?.target,
  );
}

function isSafeRelative(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value))
    return false;
  const normalized = path.posix.normalize(value);
  return (
    normalized === value &&
    normalized !== "." &&
    !normalized.startsWith("../") &&
    normalized !== ".."
  );
}

function sourceName(
  sourceRoot: string,
  source: string,
  sourceDirectories: readonly string[],
): string | undefined {
  const relative = path
    .relative(path.resolve(sourceRoot), path.resolve(source))
    .replaceAll(path.sep, "/");
  for (const directory of sourceDirectories) {
    const prefix = `${directory}/`;
    if (!relative.startsWith(prefix)) continue;
    const name = relative.slice(prefix.length);
    if (isSafeRelative(name) && name.endsWith(".md")) return name;
  }
  return undefined;
}

function isRelativeTarget(value: string): boolean {
  return Boolean(value) && !path.isAbsolute(value) && !value.includes("\0");
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function isErrorCode(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizePollInterval(value: number | undefined): number {
  return value === undefined || !Number.isFinite(value)
    ? defaultPollIntervalMs
    : Math.max(1, Math.floor(value));
}

function dedupeConsecutiveDiagnostics(
  diagnostics: ((message: string) => void) | undefined,
): (message: string) => void {
  const sink =
    diagnostics ??
    ((message: string) => console.error(`[capybearista.opencode-agents-loader] ${message}`));
  let previous: string | undefined;
  return (message) => {
    if (message === previous) return;
    previous = message;
    sink(message);
  };
}

async function sleep(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, Math.max(0, milliseconds)));
}

function parseJsonc(content: string): unknown {
  let withoutComments = "";
  let string = false;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    const next = content[index + 1];
    if (lineComment) {
      if (character === "\n") {
        lineComment = false;
        withoutComments += character;
      }
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index++;
      } else if (character === "\n") {
        withoutComments += character;
      }
      continue;
    }
    if (!string && character === "/" && next === "/") {
      lineComment = true;
      index++;
      continue;
    }
    if (!string && character === "/" && next === "*") {
      blockComment = true;
      index++;
      continue;
    }
    withoutComments += character;
    if (character === '"' && !escaped) string = !string;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }

  let withoutTrailingCommas = "";
  string = false;
  escaped = false;
  for (let index = 0; index < withoutComments.length; index++) {
    const character = withoutComments[index];
    if (character === '"' && !escaped) string = !string;
    if (!string && character === ",") {
      let next = index + 1;
      while (/\s/.test(withoutComments[next] ?? "")) next++;
      if (withoutComments[next] === "}" || withoutComments[next] === "]") continue;
    }
    withoutTrailingCommas += character;
    escaped = character === "\\" && !escaped;
    if (character !== "\\") escaped = false;
  }
  return JSON.parse(withoutTrailingCommas);
}

function collectMapNames(value: unknown, names: Set<string>): void {
  if (!isRecord(value)) return;
  for (const name of Object.keys(value)) names.add(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
