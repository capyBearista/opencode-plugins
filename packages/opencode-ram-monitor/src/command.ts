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

// Only guards against trusting a pid reported by a remote server, so any
// launcher shape (binary, node/bun wrapper, leading flags) is accepted.
export function isServerCommand(commandLine: string): boolean {
  const tokens = splitCommandTokens(commandLine);
  const serveIndex = tokens.indexOf("serve", 1);
  return (
    serveIndex > 0 &&
    tokens.slice(0, serveIndex).some((token) => token.toLowerCase().includes("opencode"))
  );
}

// ps prints the executable and arguments unquoted, so a path with spaces cannot be
// tokenized: match the executable on the raw line, and read the runtime dir up to the
// next known flag.
const PTY_DAEMON = /^["']?(?:[^"']*[\\/])?opencode-pty(?:\.exe)?["']?\s+daemon(?=\s|$)/i;

function isPtyDaemonCommand(commandLine: string): boolean {
  return PTY_DAEMON.test(commandLine.trimStart());
}

export function readPtyDaemonRuntimeDir(commandLine: string): string | null {
  if (!isPtyDaemonCommand(commandLine)) return null;
  const match = commandLine.match(/\s--runtime-dir(?:=|\s+)(.+?)(?=\s+--name\b|\s*$)/);
  return match ? match[1].trim().replace(/^['"]|['"]$/g, "") : null;
}

export function getProcessDisplayLabel(commandLine: string): string {
  const tokens = splitCommandTokens(commandLine);
  if (tokens.length === 0) return commandLine;

  const first = getTokenBaseName(tokens[0]);
  if (isServerCommand(commandLine)) return "opencode serve";
  if (isPtyDaemonCommand(commandLine)) return "opencode-pty";
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
