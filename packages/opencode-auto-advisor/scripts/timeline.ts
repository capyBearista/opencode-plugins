/**
 * One session's routing decisions next to what the agent did, as a self-contained HTML page.
 * Joins `telemetry.jsonl` (each line's `message` id) with the session's stored messages, read
 * from the running OpenCode service.
 *
 *   bun run timeline <sessionID> [--out file.html]
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolveTelemetryPath, type TelemetryRecord } from "../src/telemetry.js";

/** Lines written before `message`/`input` existed lack them. */
type Line = Omit<TelemetryRecord, "input" | "inputChars"> &
  Partial<Pick<TelemetryRecord, "input" | "inputChars">>;

interface StoredPart {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly state?: { readonly status?: string; readonly input?: unknown };
}

/** The fields of `Session.Message.Info` (OpenCode 2.2.0) the page shows. */
interface StoredMessage {
  readonly id: string;
  readonly type: string;
  readonly text?: string;
  readonly command?: string;
  readonly content?: readonly StoredPart[];
}

export interface Row {
  readonly record: Line;
  /** The messages since the previous step, up to the one this step's request ended with. */
  readonly messages: readonly StoredMessage[];
}

export function timelineRows(
  sessionID: string,
  records: readonly Line[],
  messages: readonly StoredMessage[],
): Row[] {
  const index = new Map(messages.map((message, i) => [message.id, i]));
  let from = 0;
  return records
    .filter((record) => record.session === sessionID)
    .toSorted((a, b) => a.ts.localeCompare(b.ts))
    .map((record) => {
      const at = record.message === undefined ? undefined : index.get(record.message);
      if (at === undefined) return { record, messages: [] };
      const since = messages.slice(from, at + 1);
      from = Math.max(from, at + 1);
      return { record, messages: since };
    });
}

const html = (text: string) =>
  text.replace(/[&<>"]/g, (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[char]};`);

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max)}… [${text.length - max} chars]`;

function messageText(message: StoredMessage): string {
  if (message.type === "shell") return `$ ${message.command ?? ""}`;
  if (message.content) {
    return message.content
      .flatMap((part) => {
        if (part.type === "text") return [part.text ?? ""];
        if (part.type === "tool")
          return [
            `→ ${part.name} ${clip(JSON.stringify(part.state?.input ?? {}), 500)} [${part.state?.status}]`,
          ];
        return [];
      })
      .join("\n");
  }
  return message.text ?? "";
}

const VERDICT_CLASS: Record<string, string> = {
  consult: "consult",
  blocked: "blocked",
  "no-decision": "failed",
};

function rowHtml({ record, messages }: Row): string {
  const time = new Date(record.ts).toLocaleTimeString();
  const moment = Object.entries(record.moment ?? {})
    .map(([name, p]) => `${name} ${p.toFixed(2)}`)
    .join(" · ");
  const advisor = record.advisor
    ? `Advisor ${record.advisor.outcome} · ${record.advisor.model} · ${(record.advisor.ms / 1000).toFixed(1)} s`
    : "";
  const facts = [
    moment,
    record.consequence === undefined ? "" : `consequence ${record.consequence.toFixed(2)}`,
    record.blocked ? `blocked: ${record.blocked}` : "",
    advisor,
    record.model ?? "",
  ].filter(Boolean);
  const list = messages
    .map(
      (message) =>
        `<div class="msg"><span class="type">${html(message.type)}</span><pre>${html(messageText(message))}</pre></div>`,
    )
    .join("");
  return `<details><summary><span class="time">${html(time)}</span><span class="step">#${record.step}</span><span class="verdict ${VERDICT_CLASS[record.verdict] ?? ""}">${html(record.verdict)}</span><span class="facts">${html(facts.join(" · "))}</span></summary>
<h3>Messages since the previous step</h3>${list || "<p>(not found in the session)</p>"}
<h3>Decision input${record.inputChars ? ` (${record.inputChars} chars; last ${record.input?.length ?? 0} logged)` : ""}</h3><pre class="input">${html(record.input ?? "(not logged)")}</pre></details>`;
}

export function renderTimeline(sessionID: string, rows: readonly Row[]): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Auto-Advisor timeline</title>
<style>
:root { --bg: #fff; --fg: #1c1c1c; --muted: #6b6b6b; --line: #e3e3e3; --consult: #1a7f37; --blocked: #9a6700; --failed: #cf222e; --code: #f6f8fa; }
@media (prefers-color-scheme: dark) { :root { --bg: #111; --fg: #e6e6e6; --muted: #9a9a9a; --line: #2a2a2a; --consult: #3fb950; --blocked: #d29922; --failed: #f85149; --code: #1a1a1a; } }
body { background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; margin: 0 auto; max-width: 1100px; padding: 16px; }
h1 { font-size: 18px; } h3 { font-size: 13px; color: var(--muted); margin: 12px 0 4px; }
details { border-bottom: 1px solid var(--line); padding: 6px 0; }
summary { cursor: pointer; display: flex; gap: 10px; flex-wrap: wrap; align-items: baseline; }
.time, .step, .facts { color: var(--muted); font-variant-numeric: tabular-nums; }
.verdict { font-weight: 600; } .consult { color: var(--consult); } .blocked { color: var(--blocked); } .failed { color: var(--failed); }
pre { background: var(--code); margin: 0; padding: 8px; white-space: pre-wrap; word-break: break-word; max-height: 360px; overflow: auto; }
.msg { margin: 6px 0; } .type { font-size: 12px; color: var(--muted); }
</style></head><body>
<h1>Auto-Advisor timeline · ${html(sessionID)}</h1>
<p>${rows.length} routing decisions. Expand a step to see what happened since the previous one and what the Decision model read.</p>
${rows.map(rowHtml).join("\n")}
</body></html>
`;
}

async function readTelemetry(path: string): Promise<Line[]> {
  // The rotated file holds the older lines.
  const texts = await Promise.all(
    [`${path}.1`, path].map((file) => readFile(file, "utf8").catch(() => "")),
  );
  return texts.flatMap((text) =>
    text.split("\n").flatMap((line) => {
      try {
        return line.trim() ? [JSON.parse(line) as Line] : [];
      } catch {
        return [];
      }
    }),
  );
}

/** Pages through `GET /api/session/:id/message` with the CLI, which finds the running service. */
function fetchMessages(sessionID: string): StoredMessage[] {
  const base = `/api/session/${encodeURIComponent(sessionID)}/message?limit=200`;
  const all: StoredMessage[] = [];
  let path = `${base}&order=asc`;
  for (;;) {
    const result = Bun.spawnSync(["opencode", "api", "get", path]);
    if (result.exitCode !== 0) {
      throw new Error(`opencode api get ${path} failed: ${result.stderr.toString().trim()}`);
    }
    const page = JSON.parse(result.stdout.toString()) as {
      data: StoredMessage[];
      cursor?: { next?: string };
    };
    all.push(...page.data);
    if (page.data.length === 0 || !page.cursor?.next) return all;
    path = `${base}&cursor=${encodeURIComponent(page.cursor.next)}`;
  }
}

if (import.meta.main) {
  const [sessionID, flag, out] = process.argv.slice(2);
  if (!sessionID || (flag !== undefined && (flag !== "--out" || !out))) {
    console.error("usage: bun run timeline <sessionID> [--out file.html]");
    process.exit(2);
  }
  const rows = timelineRows(
    sessionID,
    await readTelemetry(resolveTelemetryPath()),
    fetchMessages(sessionID),
  );
  const file = out ?? `timeline-${sessionID}.html`;
  await writeFile(file, renderTimeline(sessionID, rows));
  console.log(`${rows.length} steps → ${file}`);
}
