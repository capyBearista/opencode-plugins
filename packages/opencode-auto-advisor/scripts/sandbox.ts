/**
 * An isolated OpenCode with this package loaded from source and a mock model provider, for the
 * live checks in docs/auto-advisor/findings.md. Run `bun run build` first: OpenCode loads `dist/`.
 *
 *   bun run sandbox     start it in the foreground; Ctrl-C stops it
 *
 * Each run gets a new private (0700) directory: HOME and XDG directories, the project,
 * `requests.jsonl` (every request the mock received), `serve.log` and `env.sh`. It is kept after
 * the run for inspection. The server password stays in that directory (and the server's own
 * log), since the server runs tools as you. Inherited `OPENCODE_*` variables are dropped, so a
 * profile you have set (`OPENCODE_CONFIG_DIR` and the like) never replaces the sandbox's. The
 * CLI (`SANDBOX_OPENCODE_VERSION`, default 2.2.5) is installed once per version under
 * `$XDG_CACHE_HOME/opencode-auto-advisor/`.
 */
import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const PACKAGE = resolve(import.meta.dir, "..");
const VERSION = process.env.SANDBOX_OPENCODE_VERSION ?? "2.2.5";

/** POSIX single quotes: nothing inside is expanded when `env.sh` is sourced or a command pasted. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

function installCli(): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache");
  const prefix = join(cache, "opencode-auto-advisor", `cli-${VERSION}`);
  const bin = join(prefix, "node_modules", ".bin");
  if (!existsSync(join(bin, "opencode"))) {
    const install = spawnSync("npm", ["install", "--prefix", prefix, `@opencode/cli@${VERSION}`], {
      stdio: "inherit",
    });
    if (install.status !== 0) throw new Error("npm install @opencode/cli failed");
  }
  return bin;
}

const dir = mkdtempSync(join(tmpdir(), "auto-advisor-sandbox-"));
const home = join(dir, "home");
const env: Record<string, string> = {
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  XDG_DATA_HOME: join(home, ".local", "share"),
  XDG_STATE_HOME: join(home, ".local", "state"),
  XDG_CACHE_HOME: join(home, ".cache"),
  PATH: `${installCli()}:${process.env.PATH}`,
};
const inherited = Object.entries(process.env).filter(
  (entry): entry is [string, string] => !entry[0].startsWith("OPENCODE_") && entry[1] !== undefined,
);
const childEnv = { ...Object.fromEntries(inherited), ...env };
const config = join(env.XDG_CONFIG_HOME, "opencode");
const project = join(dir, "project");
for (const path of [config, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, project]) {
  mkdirSync(path, { recursive: true });
}

const children: Subprocess[] = [];
let stopping: Promise<never> | undefined;

function start(command: string[], cwd: string, log: string): Subprocess {
  // A signal during startup must not leave a child that shutdown never saw.
  if (stopping) throw new Error("stopping");
  const out = openSync(log, "w");
  const child = Bun.spawn(command, {
    cwd,
    env: childEnv,
    stdin: "ignore",
    stdout: out,
    stderr: out,
  });
  closeSync(out);
  children.push(child);
  return child;
}

async function waitFor<T>(what: string, child: Subprocess, read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = read();
    if (value !== undefined) return value;
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`${what} exited (${child.exitCode ?? child.signalCode})`);
    }
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Stops every child and waits for it (SIGKILL after 10 s), then exits. Runs once. */
function shutdown(code: number): Promise<never> {
  stopping ??= (async () => {
    for (const child of children) child.kill("SIGTERM");
    const exited = Promise.all(children.map((child) => child.exited));
    if (!(await Promise.race([exited.then(() => true), Bun.sleep(10_000).then(() => false)]))) {
      for (const child of children) child.kill("SIGKILL");
    }
    process.exit(code);
  })();
  return stopping;
}
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));

try {
  const portFile = join(dir, "mock.port");
  const mock = start(
    ["bun", join(import.meta.dir, "sandbox", "mock.ts"), portFile, join(dir, "requests.jsonl")],
    dir,
    join(dir, "mock.log"),
  );
  const mockPort = await waitFor("the mock", mock, () =>
    existsSync(portFile) ? readFileSync(portFile, "utf8").trim() || undefined : undefined,
  );

  const model = {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    limit: { context: 200_000, output: 4_096 },
  };
  writeFileSync(
    join(config, "opencode.json"),
    JSON.stringify(
      {
        plugins: [PACKAGE],
        model: "mock/exec",
        providers: {
          mock: {
            package: "@opencode/ai/providers/openai-compatible",
            settings: { baseURL: `http://127.0.0.1:${mockPort}/v1`, apiKey: "mock" },
            models: { exec: model },
          },
        },
      },
      null,
      1,
    ),
  );
  writeFileSync(
    join(config, "auto-advisor.json"),
    JSON.stringify({ advisor: { model: "mock/exec" } }, null, 1),
  );
  writeFileSync(join(project, "notes.txt"), "Sandbox notes.\n");

  const listener = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const port = listener.port;
  listener.stop(true);
  const serveLog = join(dir, "serve.log");
  const serve = start(["opencode", "serve", "--port", String(port)], project, serveLog);
  const password = await waitFor("opencode serve", serve, () =>
    existsSync(serveLog)
      ? /server password (\S+)/.exec(readFileSync(serveLog, "utf8"))?.[1]
      : undefined,
  );

  const url = `http://127.0.0.1:${port}`;
  const exports = { ...env, OPENCODE_PASSWORD: password };
  // Sourced into the caller's shell, so it also clears the caller's own OpenCode variables.
  writeFileSync(
    join(dir, "env.sh"),
    `unset $(env | sed -n 's/^\\(OPENCODE_[A-Za-z0-9_]*\\)=.*/\\1/p')\n${Object.entries(exports)
      .map(([name, value]) => `export ${name}=${quote(value)}`)
      .join("\n")}\n`,
  );

  console.log(`sandbox: ${dir}
server: ${url} (OpenCode ${VERSION}; user "opencode", password in env.sh)

In another terminal:
source ${quote(join(dir, "env.sh"))}
cd ${quote(project)}
opencode run --server ${url} "<prompt>" < /dev/null
  (without < /dev/null, run can wait on an open stdin)
opencode api get /api/session --server ${url} > sessions.json
  (read API output from a file: the CLI exits right after writing, so a large piped
   response is cut short)

Requests the mock received: ${join(dir, "requests.jsonl")}
Ctrl-C stops the sandbox; its directory is kept.`);

  const code = await Promise.race([mock.exited, serve.exited]);
  if (!stopping) console.error(`a sandbox process exited with code ${code}; stopping`);
  await shutdown(1);
} catch (error) {
  if (!stopping) console.error(error instanceof Error ? error.message : error);
  await shutdown(1);
}
