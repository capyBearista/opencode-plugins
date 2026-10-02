export interface PermissionRule {
  readonly action: string;
  readonly resource: string;
  readonly effect: "allow" | "deny" | "ask";
}

export const ADVISOR_PERMISSION_ACTION = "advisor";
export const WHOLE_SESSION_RESOURCE = "*";

// Mirrors opencode core permission evaluate + util/wildcard match at the 2.0.21 tag.
export function wildcardMatch(input: string, pattern: string): boolean {
  const normalized = input.replaceAll("\\", "/");
  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  if (escaped.endsWith(" .*")) escaped = `${escaped.slice(0, -3)}( .*)?`;
  return new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s").test(normalized);
}

export function evaluatePermission(
  action: string,
  resource: string,
  rules: readonly PermissionRule[],
): PermissionRule["effect"] {
  const rule = rules.findLast(
    (candidate) =>
      wildcardMatch(action, candidate.action) && wildcardMatch(resource, candidate.resource),
  );
  return rule?.effect ?? "ask";
}

export function deniesWholeSession(action: string, rules: readonly PermissionRule[]): boolean {
  return evaluatePermission(action, WHOLE_SESSION_RESOURCE, rules) === "deny";
}
