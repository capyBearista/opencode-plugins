/**
 * Stands in for `opencode api get <path>` in tests. Like OpenCode's CLI (2.2.5,
 * `packages/cli/src/index.ts`), it writes the response and exits at once, which cuts a large
 * response short when stdout is a pipe. Two pages; like the server, it rejects a cursor combined
 * with `order`.
 */
const path = process.argv.at(-1) ?? "";
const query = new URL(path, "http://x").searchParams;
const message = (id: string) => ({ id, type: "user", text: `${id} ${"x".repeat(1_000_000)}` });
let page: object;
if (query.has("cursor") && query.has("order")) {
  process.stderr.write("Cursor cannot be combined with order\n");
  process.exit(1);
} else if (query.get("cursor") === "page2") {
  page = { data: [message("m4"), message("m5"), message("m6")] };
} else if (query.get("order") === "asc") {
  page = { data: [message("m1"), message("m2"), message("m3")], cursor: { next: "page2" } };
} else {
  process.stderr.write(`unexpected request: ${path}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(page)}\n`);
process.exit(0);
