import { describe, expect, test } from "bun:test";
import { type JSX, testRender } from "@opentui/solid";
import { createSignal } from "solid-js";
import type { Status } from "./rpc.js";
import tui, { footerText, PANEL, panelSummary, sidebarStatus } from "./tui.js";

// biome-ignore lint/suspicious/noExplicitAny: loosely typed fake TUI context
type Any = any;

const at = new Date(2026, 9, 29, 13, 8).toISOString();
const latest = {
  id: "r1",
  moment: "stuck",
  advice: "Check the **clock skew** first.",
  details: { at, model: "openrouter/meta/muse#xhigh", ms: 45_800 },
};

const status = (overrides: Partial<Status> = {}): Status => ({
  sessionID: "s",
  mode: "active",
  sidebar: true,
  configError: null,
  reviewing: false,
  failed: false,
  latest,
  ...overrides,
});

describe("text", () => {
  test("footer reflects the review lifecycle", () => {
    expect(footerText("idle", null)).toBe("");
    expect(footerText("reviewing", null)).toBe("Advisor reviewing…");
    expect(footerText("finished", latest)).toBe("✓ Advisor reviewed (stuck)");
    expect(footerText("failed", null)).toBe("Advisor unavailable");
  });

  test("sidebar status is short and says when a review is old", () => {
    expect(sidebarStatus("reviewing", latest, "active")).toBe("reviewing…");
    expect(sidebarStatus("failed", latest, "active")).toBe("unavailable");
    expect(sidebarStatus("idle", latest, "active")).toBe("✓ stuck 13:08");
    expect(sidebarStatus("idle", { ...latest, details: null }, "active")).toBe("✓ stuck");
    expect(sidebarStatus("idle", null, "active")).toBe("no review yet");
    expect(sidebarStatus("idle", null, "observe")).toBe("observe");
  });

  test("panel summary carries model, duration and time, or why they are missing", () => {
    expect(panelSummary(latest)).toBe(
      "Moment: stuck · openrouter/meta/muse#xhigh · 45.8 s · 13:08",
    );
    expect(panelSummary({ ...latest, details: null })).toBe(
      "Moment: stuck · delivered before OpenCode restarted",
    );
    expect(panelSummary(null)).toBe("No automatic review in this session yet.");
  });
});

function harness(answer: Status = status()) {
  const slots: Record<string, Any> = {};
  const layers: Any[] = [];
  const handlers: Record<string, Any> = {};
  const calls: string[] = [];
  let current: { name: string; sessionID: string } | undefined;
  let unsubscribed = 0;
  const context: Any = {
    theme: {
      text: {
        base: "white",
        muted: "gray",
        feedback: { error: { base: "red" }, success: { base: "green" } },
      },
      markdown: {
        text: "white",
        heading: "cyan",
        strong: "yellow",
        emphasis: "magenta",
        code: "green",
        blockQuote: "gray",
        listItem: "white",
        link: "blue",
        linkText: "blue",
      },
    },
    client: {
      rpc: () => ({
        status: async () => answer,
        events: {
          on: (name: string, handler: Any) => {
            handlers[name] = handler;
            return () => unsubscribed++;
          },
        },
      }),
    },
    keymap: { layer: (factory: Any) => layers.push(factory) },
    ui: {
      slot: (claim: Any) => {
        slots[claim.append] = claim;
        return () => delete slots[claim.append];
      },
      panel: {
        open: (name: string) => {
          calls.push(`open:${name}`);
          current = { name, sessionID: "s" };
          return true;
        },
        close: () => {
          calls.push("close");
          current = undefined;
        },
        current: () => current,
      },
      toast: { show: () => calls.push("toast") },
    },
  };
  const cleanup = tui.setup(context) as () => void;
  const mount = async (render: () => unknown, width = 40, height = 12) => {
    // The host has a renderer before any slot renders: mount once it exists.
    const [ready, setReady] = createSignal(false);
    const setup = await testRender(() => (() => (ready() ? render() : null)) as JSX.Element, {
      width,
      height,
    });
    context.renderer = setup.renderer;
    setReady(true);
    const frame = async () => {
      for (let i = 0; i < 20; i++) {
        await Bun.sleep(25);
        await setup.renderOnce();
      }
      return setup.captureCharFrame();
    };
    return { setup, frame };
  };
  return {
    context,
    slots,
    layers,
    handlers,
    calls,
    mount,
    cleanup,
    unsubscribed: () => unsubscribed,
  };
}

describe("setup", () => {
  test("registers the footer, sidebar and panel slots, not the composer, and cleans up", () => {
    const host = harness();
    expect(Object.keys(host.slots).sort()).toEqual([
      "prompt.footer.status",
      "session.panel",
      "sidebar.footer",
    ]);
    expect(Object.keys(host.handlers).sort()).toEqual(["review.finished", "review.started"]);
    host.cleanup();
    expect(Object.keys(host.slots)).toEqual([]);
    expect(host.unsubscribed()).toBe(2);
  });

  test("the palette command toggles the review panel", () => {
    const host = harness();
    const [command] = host.layers[0]().commands;
    expect(command).toMatchObject({ palette: true, slash: { name: "advisor-review" } });
    command.run();
    command.run();
    expect(host.calls).toEqual([`open:${PANEL}`, "close"]);
  });
});

describe("sidebar widget", () => {
  test("shows the stored review after a restart and opens the panel on click", async () => {
    const host = harness();
    const { setup, frame } = await host.mount(() =>
      host.slots["sidebar.footer"].render({ sessionID: "s" }),
    );
    const text = await frame();
    expect(text).toContain("Advisor");
    expect(text).toContain("✓ stuck 13:08");
    // One line: the status only.
    expect(text).not.toContain("View review");
    expect(text.trim().split("\n")).toHaveLength(1);
    expect(text).not.toContain("clock skew");
    await setup.mockMouse.click(2, 0);
    expect(host.calls).toEqual([`open:${PANEL}`]);
    setup.renderer.destroy();
  });

  test("follows review events", async () => {
    const host = harness(status({ latest: null }));
    const { setup, frame } = await host.mount(() =>
      host.slots["sidebar.footer"].render({ sessionID: "s" }),
    );
    expect(await frame()).toContain("no review yet");
    host.handlers["review.started"]({ data: status({ latest: null, reviewing: true }) });
    expect(await frame()).toContain("reviewing…");
    host.handlers["review.finished"]({ data: status() });
    expect(await frame()).toContain("✓ stuck");
    setup.renderer.destroy();
  });

  test("tui.sidebar false hides it", async () => {
    const host = harness(status({ sidebar: false }));
    const { setup, frame } = await host.mount(() =>
      host.slots["sidebar.footer"].render({ sessionID: "s" }),
    );
    expect((await frame()).trim()).toBe("");
    setup.renderer.destroy();
  });
});

describe("review panel", () => {
  const panel = (name: string) => ({
    name,
    sessionID: "s",
    focused: true,
    close: () => {},
    toggleFullscreen: () => {},
  });

  test("renders the whole review as markdown, with its details", async () => {
    const host = harness();
    const input = panel(PANEL);
    let closed = 0;
    input.close = () => closed++;
    const { setup, frame } = await host.mount(
      () => host.slots["session.panel"].render(input),
      80,
      12,
    );
    const text = await frame();
    expect(text).toContain("Advisor review");
    expect(text).toContain("Moment: stuck · openrouter/meta/muse#xhigh · 45.8 s · 13:08");
    expect(text).toContain("Check the clock skew first.");
    expect(text).not.toContain("**");
    const lines = text.split("\n");
    const hint = lines.findIndex((line) => line.includes("esc close"));
    await setup.mockMouse.click(lines[hint].indexOf("esc"), hint);
    expect(closed).toBe(1);
    setup.renderer.destroy();
  });

  test("renders nothing for another plugin's panel", async () => {
    const host = harness();
    const { setup, frame } = await host.mount(() =>
      host.slots["session.panel"].render(panel("diff")),
    );
    expect((await frame()).trim()).toBe("");
    setup.renderer.destroy();
  });
});
