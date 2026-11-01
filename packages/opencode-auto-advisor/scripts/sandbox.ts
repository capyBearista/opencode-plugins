/**
 * An isolated OpenCode with this package loaded from source and a mock model provider, for the
 * live checks in docs/auto-advisor/findings.md.
 *
 *   bun run sandbox start [dir]   install OpenCode (OPENCODE_VERSION, default 2.2.5), start it
 *   bun run sandbox stop <dir>    stop its processes
 *
 * Everything lives in `dir` (a new temporary directory by default): HOME and XDG directories,
 * the CLI, the project, `requests.jsonl` (every request the mock received) and `serve.log`.
 * Run `bun run build` first: OpenCode loads `dist/`.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PACKAGE = resolve(import.meta.dir, "..");

interface State {
  readonly pids: readonly number[];
  readonly url: string;
  readonly password: string;
}

function environment(dir: string): Record<string, string> {
  const home = join(dir, "home");
  return {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    PATH: `${join(dir, "cli", "node_modules", ".bin")}:${process.env.PATH}`,
  };
}

/** Starts a process in its own group, so `stop` can end it and its children by pid. */
function background(
  command: string[],
  options: { cwd: string; env: Record<string, string>; log: string },
) {
  const out = openSync(options.log, "a");
  const child = spawn(command[0], command.slice(1), {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    detached: true,
    stdio: ["ignore", out, out],
  });
  closeSync(out);
  child.unref();
  if (child.pid === undefined) throw new Error(`could not start ${command[0]}`);
  return child.pid;
}

async function waitFor<T>(what: string, read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = read();
    if (value !== undefined) return value;
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function start(dir: string) {
  const version = process.env.OPENCODE_VERSION ?? "2.2.5";
  const env = environment(dir);
  const config = join(env.XDG_CONFIG_HOME, "opencode");
  const project = join(dir, "project");
  for (const path of [config, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_CACHE_HOME, project]) {
    mkdirSync(path, { recursive: true });
  }

  if (!existsSync(join(dir, "cli", "node_modules", ".bin", "opencode"))) {
    const install = spawnSync(
      "npm",
      ["install", "--prefix", join(dir, "cli"), `@opencode/cli@${version}`],
      {
        stdio: "inherit",
      },
    );
    if (install.status !== 0) throw new Error("npm install @opencode/cli failed");
  }

  const portFile = join(dir, "mock.port");
  const mock = background(
    ["bun", join(import.meta.dir, "sandbox", "mock.ts"), portFile, join(dir, "requests.jsonl")],
    {
      cwd: dir,
      env,
      log: join(dir, "mock.log"),
    },
  );
  const mockPort = await waitFor("the mock", () =>
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
  const serve = background(["opencode", "serve", "--port", String(port)], {
    cwd: project,
    env,
    log: serveLog,
  });
  const password = await waitFor("opencode serve", () =>
    existsSync(serveLog)
      ? /server password (\S+)/.exec(readFileSync(serveLog, "utf8"))?.[1]
      : undefined,
  );

  const state: State = { pids: [serve, mock], url: `http://127.0.0.1:${port}`, password };
  writeFileSync(join(dir, "sandbox.json"), JSON.stringify(state, null, 1));
  const exports = { ...env, OPENCODE_PASSWORD: password };
  writeFileSync(
    join(dir, "env.sh"),
    `${Object.entries(exports)
      .map(([name, value]) => `export ${name}=${JSON.stringify(value)}`)
      .join("\n")}\n`,
  );

  console.log(`sandbox: ${dir}
server: ${state.url} (OpenCode ${version}, basic auth opencode:${password})

source ${join(dir, "env.sh")}
cd ${project}
opencode run --server ${state.url} "<prompt>" < /dev/null
  (without < /dev/null, run can wait on an open stdin)
opencode api get /api/session --server ${state.url} > sessions.json
  (read API output from a file: the CLI exits right after writing, so a large piped
   response is cut short)

Requests the mock received: ${join(dir, "requests.jsonl")}
Stop: bun run sandbox stop ${dir}`);
}

function stop(dir: string) {
  const state = JSON.parse(readFileSync(join(dir, "sandbox.json"), "utf8")) as State;
  for (const pid of state.pids) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  console.log(`stopped ${state.pids.join(", ")}`);
}

const [command, dir] = process.argv.slice(2);
if (command === "start")
  await start(resolve(dir ?? mkdtempSync(join(tmpdir(), "auto-advisor-sandbox-"))));
else if (command === "stop" && dir) stop(resolve(dir));
else {
  console.error("usage: bun run sandbox start [dir] | bun run sandbox stop <dir>");
  process.exit(2);
}
