const OPENCODE_BINARIES = new Set(["opencode", "opencode.exe", ".opencode", ".opencode.exe"]);
const PTY_BINARIES = new Set(["opencode-pty", "opencode-pty.exe"]);
const INTERPRETERS = new Set([
  "node",
  "node.exe",
  "bun",
  "bun.exe",
  "sh",
  "bash",
  "python",
  "python3",
]);
const RUNNERS = new Set(["npm", "npx", "uv", "uvx"]);
const RUNNER_SUBCOMMANDS = new Set(["exec", "run", "tool", "toolx"]);

export function splitCommandTokens(commandLine: string): string[] {
  const matches = commandLine.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map((token) => token.replace(/^['"]|['"]$/g, ""));
}

export function getTokenBaseName(token: string): string {
  const parts = token
    .toLowerCase()
    .split(/[\\/]+/)
    .filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : "";
}

function isOpencodeBinary(token: string | undefined): boolean {
  return token !== undefined && OPENCODE_BINARIES.has(getTokenBaseName(token));
}

export function isServerCommand(commandLine: string): boolean {
  const tokens = splitCommandTokens(commandLine);
  return isOpencodeBinary(tokens[0]) && tokens[1] === "serve";
}

export function readPtyDaemonRuntimeDir(commandLine: string): string | null {
  const tokens = splitCommandTokens(commandLine);
  if (!tokens[0] || !PTY_BINARIES.has(getTokenBaseName(tokens[0]))) return null;
  if (tokens[1] !== "daemon") return null;
  const flagIndex = tokens.indexOf("--runtime-dir");
  return flagIndex === -1 ? null : (tokens[flagIndex + 1] ?? null);
}

export function getProcessDisplayLabel(commandLine: string): string {
  const tokens = splitCommandTokens(commandLine);
  if (tokens.length === 0) return commandLine;

  const first = getTokenBaseName(tokens[0]);
  if (isServerCommand(commandLine)) return "opencode serve";
  if (OPENCODE_BINARIES.has(first)) return "opencode";
  if (PTY_BINARIES.has(first)) return "opencode-pty";
  if (INTERPRETERS.has(first)) return first;

  if (RUNNERS.has(first)) {
    const second = tokens[1] ? getTokenBaseName(tokens[1]) : "";
    const third = tokens[2] ? getTokenBaseName(tokens[2]) : "";
    if (RUNNER_SUBCOMMANDS.has(second)) return [first, second, third].filter(Boolean).join(" ");
    return [first, second].filter(Boolean).join(" ");
  }

  return first;
}
