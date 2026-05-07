import "@opentui/solid/preload";
import { describe, expect, test } from "bun:test";
import { classifyOpencodeProcess } from "./memory.js";
import serverModule from "./server.js";
import { getErrorMessage, normalizeRefreshIntervalMs } from "./sidebar-config.js";

describe("@capybearista/opencode-ram-monitor", () => {
  test("has an id", () => {
    expect(serverModule.id).toBeString();
    expect(serverModule.id).toBe("capybearista.opencode-ram-monitor");
  });

  test("exports a default object", () => {
    expect(serverModule).toBeObject();
  });

  test("exports server hooks", () => {
    expect(serverModule.server).toBeFunction();
  });

  test("classifies direct core and launcher commands", () => {
    expect(classifyOpencodeProcess("/usr/local/bin/.opencode -c")).toBe("core");
    expect(classifyOpencodeProcess("/usr/local/bin/opencode -c")).toBe("launcher");
  });

  test("classifies node-wrapped opencode commands with flags", () => {
    expect(
      classifyOpencodeProcess('node --require /tmp/bootstrap.js "/opt/opencode/bin/.opencode" -c'),
    ).toBe("core");
    expect(
      classifyOpencodeProcess("node --loader ts-node/esm /opt/opencode/bin/opencode --foo"),
    ).toBe("launcher");
  });

  test("does not misclassify non-script opencode args", () => {
    expect(classifyOpencodeProcess("node /srv/app.js --name opencode")).toBeNull();
    expect(classifyOpencodeProcess("node --require opencode /srv/app.js")).toBeNull();
  });

  test("ignores non-opencode commands", () => {
    expect(classifyOpencodeProcess("node /usr/bin/tsserver --stdio")).toBeNull();
    expect(classifyOpencodeProcess("/bin/sh -c 'echo hello'")).toBeNull();
  });

  test("normalizes refresh interval to safe bounds", () => {
    expect(normalizeRefreshIntervalMs("200")).toBe(1000);
    expect(normalizeRefreshIntervalMs(0)).toBe(1000);
    expect(normalizeRefreshIntervalMs(1500)).toBe(1500);
    expect(normalizeRefreshIntervalMs(999999)).toBe(60_000);
    expect(normalizeRefreshIntervalMs("bad")).toBe(5000);
  });

  test("derives stable error messages from unknown throws", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage("failure")).toBe("failure");
    expect(getErrorMessage({ reason: "unknown" })).toBe("RAM error");
  });
});
