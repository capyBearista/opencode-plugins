/**
 * The sandbox's model provider: an OpenAI-compatible chat endpoint that streams fixed answers and
 * appends every request body to `requests.jsonl` next to this sandbox's state.
 *
 * A request with tools (the agent) gets a `read` of `notes.txt` for its first two steps, then
 * text. A request without tools (the Advisor, a title) gets text.
 *
 *   bun mock.ts <port-file> <log-file>
 */
import { appendFileSync, writeFileSync } from "node:fs";

const [portFile, logFile] = process.argv.slice(2);
if (!portFile || !logFile) throw new Error("usage: bun mock.ts <port-file> <log-file>");

interface Body {
  readonly model?: string;
  readonly messages?: readonly { readonly role: string }[];
  readonly tools?: readonly unknown[];
}

const encoder = new TextEncoder();
const stream = (model: string, deltas: readonly object[], finish: string) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const chunk = (delta: object, finish_reason: string | null) =>
          `data: ${JSON.stringify({ id: "mock", object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
        for (const delta of deltas) controller.enqueue(encoder.encode(chunk(delta, null)));
        controller.enqueue(encoder.encode(chunk({}, finish)));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(request) {
    const body = (await request.json().catch(() => ({}))) as Body;
    appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), body })}\n`);
    const model = String(body.model);
    const steps = (body.messages ?? []).filter((message) => message.role === "assistant").length;
    if (body.tools?.length && steps < 2) {
      const call = {
        index: 0,
        id: `call_${Date.now()}`,
        type: "function",
        function: { name: "read", arguments: JSON.stringify({ path: "notes.txt" }) },
      };
      return stream(model, [{ role: "assistant", tool_calls: [call] }], "tool_calls");
    }
    const text = body.tools?.length ? "Done." : "**Mock advice.** Check the plan before editing.";
    return stream(model, [{ role: "assistant", content: text }], "stop");
  },
});
writeFileSync(portFile, String(server.port));
