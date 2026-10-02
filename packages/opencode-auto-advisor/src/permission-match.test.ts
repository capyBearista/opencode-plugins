import { describe, expect, test } from "bun:test";
import { evaluatePermission, type PermissionRule, wildcardMatch } from "./permission-match.js";

const rule = (
  action: string,
  resource: string,
  effect: PermissionRule["effect"],
): PermissionRule => ({
  action,
  resource,
  effect,
});

describe("wildcardMatch", () => {
  test("matches native wildcard action and resource patterns", () => {
    expect(wildcardMatch("advisor", "advisor")).toBe(true);
    expect(wildcardMatch("advisor", "*")).toBe(true);
    expect(wildcardMatch("adviser", "adv?ser")).toBe(true);
    expect(wildcardMatch("advisor", "adv?ser")).toBe(false);
    expect(wildcardMatch("advisor", "edit")).toBe(false);
    expect(wildcardMatch("src/a.ts", "src/*")).toBe(true);
    expect(wildcardMatch("*", "src/*")).toBe(false);
  });

  test("normalizes backslashes and trailing space wildcards like the host", () => {
    expect(wildcardMatch("src\\a.ts", "src/a.ts")).toBe(true);
    expect(wildcardMatch("git commit", "git *")).toBe(true);
    expect(wildcardMatch("git", "git *")).toBe(true);
  });

  test("keeps native platform case sensitivity", () => {
    expect(wildcardMatch("advisor", "ADVISOR")).toBe(process.platform === "win32");
  });
});

describe("evaluatePermission", () => {
  test("returns the last matching rule effect and defaults to ask", () => {
    expect(evaluatePermission("advisor", "*", [])).toBe("ask");
    expect(evaluatePermission("advisor", "*", [rule("edit", "*", "deny")])).toBe("ask");
    expect(
      evaluatePermission("advisor", "*", [
        rule("advisor", "*", "deny"),
        rule("advisor", "*", "allow"),
      ]),
    ).toBe("allow");
    expect(
      evaluatePermission("advisor", "*", [
        rule("advisor", "*", "allow"),
        rule("advisor", "*", "deny"),
      ]),
    ).toBe("deny");
  });

  test("denies the whole-session resource under a broad advisor deny", () => {
    expect(evaluatePermission("advisor", "*", [rule("advisor", "*", "deny")])).toBe("deny");
  });

  test("denies resource '*' when a broad deny precedes a scoped allow", () => {
    const rules = [rule("advisor", "*", "deny"), rule("advisor", "src/*", "allow")];
    expect(evaluatePermission("advisor", "*", rules)).toBe("deny");
    expect(evaluatePermission("advisor", "src/a.ts", rules)).toBe("allow");
  });

  test("never treats ask or allow as a configured denial", () => {
    expect(evaluatePermission("advisor", "*", [rule("advisor", "*", "ask")])).toBe("ask");
    expect(evaluatePermission("advisor", "*", [rule("advisor", "*", "allow")])).toBe("allow");
  });
});
