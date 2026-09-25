import { spawn } from "node:child_process";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

type GitResult = { ok: true; output: string } | { ok: false; error: string };

const GIT_TIMEOUT_MS = 120_000;

function runGit(args: string[], cwd: string, timeoutMs: number): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, error: `git ${args[0]} timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish({ ok: true, output: stdout.trimEnd() });
        return;
      }
      if (code === null) {
        const detail = stderr.trim();
        const suffix = detail.length > 0 ? `: ${detail}` : "";
        finish({
          ok: false,
          error: `git ${args[0]} was terminated by ${signal ?? "an unknown signal"}${suffix}`,
        });
        return;
      }
      const message = stderr.trim();
      finish({
        ok: false,
        error: message.length > 0 ? message : `git ${args[0]} exited with code ${code}`,
      });
    });
  });
}

function text(result: GitResult): string {
  return result.ok ? result.output : result.error;
}

function nulDelimited(output: string): string[] {
  return output.split("\0").filter((entry) => entry.length > 0);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(resolve(root), resolve(candidate));
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
}

function unreadable(error: unknown): string {
  return `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
}

// A NUL byte marks binary content, matching git's own text/binary heuristic;
// text bodies are inlined whole and binaries are skipped.
async function readTextFile(filePath: string): Promise<string | undefined> {
  const handle = await open(filePath, "r");
  try {
    const buffer = await handle.readFile();
    return buffer.includes(0) ? undefined : buffer.toString("utf8");
  } finally {
    await handle.close();
  }
}

async function untrackedSection(cwd: string, untracked: GitResult): Promise<string> {
  if (!untracked.ok) return untracked.error;
  const realCwd = await realpath(cwd).catch(() => resolve(cwd));
  const parts: string[] = [];
  for (const file of nulDelimited(untracked.output)) {
    const candidate = resolve(cwd, file);
    if (!isWithin(cwd, candidate)) continue;
    let target: string;
    try {
      target = await realpath(candidate);
    } catch (error) {
      parts.push(`--- ${file} ---\n${unreadable(error)}`);
      continue;
    }
    if (!isWithin(realCwd, target)) continue;
    let content: string | undefined;
    try {
      content = await readTextFile(target);
    } catch (error) {
      parts.push(`--- ${file} ---\n${unreadable(error)}`);
      continue;
    }
    if (content === undefined) continue;
    parts.push(`--- ${file} ---\n${content}`);
  }
  return parts.join("\n");
}

export async function collectGitContext(cwd: string, timeoutMs = GIT_TIMEOUT_MS): Promise<string> {
  const branch = await runGit(["branch", "--show-current"], cwd, timeoutMs);
  const status = await runGit(["status", "--short", "--untracked-files=all"], cwd, timeoutMs);
  const commits = await runGit(["log", "--oneline", "-3"], cwd, timeoutMs);
  const diff = await runGit(["diff", "HEAD"], cwd, timeoutMs);
  const untracked = await runGit(
    ["ls-files", "-z", "--others", "--exclude-standard"],
    cwd,
    timeoutMs,
  );

  return [
    `=== Branch ===\n${text(branch)}`,
    `=== Status ===\n${text(status)}`,
    `=== Recent Commits ===\n${text(commits)}`,
    `=== Full Diff ===\n${text(diff)}`,
    `=== Untracked File Contents ===\n${await untrackedSection(cwd, untracked)}`,
  ].join("\n\n");
}
