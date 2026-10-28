import { describe, expect, test } from "bun:test";
import tui, { footerText, panelText } from "./tui.js";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed fake TUI context
type Any = any;

const latest = { id: "r1", moment: "stuck", advice: "Check the clock skew." };

describe("text", () => {
  test("footer reflects the review lifecycle", () => {
    expect(footerText("idle", null)).toBe("");
    expect(footerText("reviewing", null)).toBe("Advisor reviewing…");
    expect(footerText("finished", latest)).toBe("✓ Advisor reviewed (stuck)");
    expect(footerText("failed", null)).toBe("Advisor unavailable");
  });

  test("panel shows the latest review, capped", () => {
    expect(panelText(null)).toBe("");
    expect(panelText(latest)).toBe("Advisor review (stuck)\nCheck the clock skew.");
    const long = panelText({
      ...latest,
      advice: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n"),
    });
    expect(long.split("\n")).toHaveLength(10);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("setup", () => {
  test("registers footer and composer slots, listens to review events and cleans up", () => {
    const slots: string[] = [];
    const handlers: Record<string, Any> = {};
    let unsubscribed = 0;
    const context: Any = {
      theme: { text: { base: "white", muted: "gray" } },
      client: {
        rpc: () => ({
          events: {
            on: (name: string, handler: Any) => {
              handlers[name] = handler;
              return () => unsubscribed++;
            },
          },
        }),
      },
      ui: {
        slot: ({ append }: Any) => {
          slots.push(append);
          return () => slots.splice(slots.indexOf(append), 1);
        },
      },
    };
    const cleanup = tui.setup(context) as () => void;
    expect(slots).toEqual(["prompt.footer.status", "session.composer.top"]);
    expect(Object.keys(handlers).sort()).toEqual(["review.finished", "review.started"]);
    handlers["review.started"]({ data: { sessionID: "s" } });
    handlers["review.finished"]({ data: { sessionID: "s", failed: false, latest } });
    cleanup();
    expect(slots).toEqual([]);
    expect(unsubscribed).toBe(2);
  });
});
