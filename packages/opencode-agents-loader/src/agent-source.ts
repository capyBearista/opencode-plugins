import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Agent as AgentSchema } from "@opencode/plugin";
import { Model } from "@opencode/plugin";
import matter from "gray-matter";

export interface MarkdownEntry {
  readonly data: Record<string, unknown>;
  readonly content: string;
}

type AgentModel = NonNullable<AgentSchema.Info["model"]>;
type AgentPermission = AgentSchema.Info["permissions"][number];

export interface AgentPatch {
  readonly system: string;
  readonly model?: AgentModel;
  readonly request?: {
    readonly headers?: Record<string, string>;
    readonly body?: Record<string, unknown>;
  };
  readonly description?: string;
  readonly mode?: AgentSchema.Info["mode"];
  readonly hidden?: boolean;
  readonly color?: NonNullable<AgentSchema.Info["color"]>;
  readonly steps?: NonNullable<AgentSchema.Info["steps"]>;
  readonly disabled?: boolean;
  readonly permissions: AgentPermission[];
}

const agentKeys = new Set([
  "variant",
  "model",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
]);

const legacyAgentKeys = new Set([
  "name",
  "model",
  "variant",
  "temperature",
  "top_p",
  "prompt",
  "tools",
  "disable",
  "description",
  "mode",
  "hidden",
  "options",
  "color",
  "steps",
  "maxSteps",
  "permission",
  "permissions",
]);

const permissionEffects = new Set(["allow", "deny", "ask"] as const);
const agentModes = new Set(["subagent", "primary", "all"] as const);
const pathPermissionActions = new Set(["external_directory", "read", "edit"]);
const hexColor = /^#[0-9a-fA-F]{6}$/;
const invalid = Symbol("invalid");

export function fallbackSanitization(content: string): string {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return content;

  const frontmatter = match[1];
  const lines = frontmatter.split(/\r?\n/);
  const result: string[] = [];

  for (const line of lines) {
    if (line.trim().startsWith("#") || line.trim() === "") {
      result.push(line);
      continue;
    }
    if (/^\s+/.test(line)) {
      result.push(line);
      continue;
    }
    const kvMatch = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*:\s*(.*)$/);
    if (!kvMatch) {
      result.push(line);
      continue;
    }
    const key = kvMatch[1];
    const value = kvMatch[2].trim();
    if (
      value === "" ||
      value === ">" ||
      value === "|" ||
      value.startsWith('"') ||
      value.startsWith("'")
    ) {
      result.push(line);
      continue;
    }
    if (value.includes(":")) {
      result.push(`${key}: |-`);
      result.push(`  ${value}`);
      continue;
    }
    result.push(line);
  }

  const processed = result.join("\n");
  return content.replace(match[0], () => `---\n${processed}\n---`);
}

export async function parseMarkdown(filePath: string): Promise<MarkdownEntry> {
  return parseMarkdownContent(await readFile(filePath, "utf8"), filePath);
}

export function parseMarkdownContent(template: string, source: string): MarkdownEntry {
  try {
    const parsed = matter(template);
    return { data: parsed.data as Record<string, unknown>, content: parsed.content.trim() };
  } catch {
    try {
      const parsed = matter(fallbackSanitization(template));
      return { data: parsed.data as Record<string, unknown>, content: parsed.content.trim() };
    } catch (error) {
      throw new Error(
        `${source}: Failed to parse YAML frontmatter: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function validateAgentContent(
  source: string,
  content: Buffer,
  home = os.homedir(),
): string | undefined {
  if (content.length === 0) return "empty agent source";

  let entry: MarkdownEntry;
  try {
    entry = parseMarkdownContent(content.toString("utf8"), source);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  const result = convertAgentResult(entry, home);
  return result.error;
}

export function convertAgent(
  _name: string,
  entry: MarkdownEntry,
  home = os.homedir(),
): AgentPatch | undefined {
  return convertAgentResult(entry, home).patch;
}

function convertAgentResult(
  entry: MarkdownEntry,
  home: string,
): { readonly patch?: AgentPatch; readonly error?: string } {
  const data = entry.data;
  const legacy = Object.keys(data).some((key) => !agentKeys.has(key));
  if (legacy && data.permissions !== undefined) {
    return invalidResult("mixed legacy and V2 permissions are unsupported; use one dialect");
  }
  return legacy ? convertLegacyAgent(entry, home) : convertV2Agent(entry, home);
}

function convertV2Agent(
  entry: MarkdownEntry,
  home: string,
): { readonly patch?: AgentPatch; readonly error?: string } {
  const { data } = entry;
  const disabled = readBoolean(data.disabled);
  if (disabled === invalid) return invalidResult("disabled must be a boolean");
  if (data.system !== undefined && typeof data.system !== "string")
    return invalidResult("system must be a string when present");

  const model = parseModel(data.model, data.variant, true);
  if (model.invalid) return invalidResult("model or variant is not a valid V2 model selection");
  const common = readAgentFields(data, false);
  if (common === undefined) return invalidResult("agent metadata has an invalid field");
  const request = readRequest(data.request);
  if (request === invalid) return invalidResult(requestError(data.request));
  const permissions = readV2Permissions(data.permissions, home);
  if (permissions === invalid) return invalidResult("permissions must be an array of valid rules");

  return {
    patch: {
      system: entry.content,
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(request === undefined ? {} : { request }),
      ...common,
      ...(disabled === undefined ? {} : { disabled }),
      permissions: permissions ?? [],
    },
  };
}

function convertLegacyAgent(
  entry: MarkdownEntry,
  home: string,
): { readonly patch?: AgentPatch; readonly error?: string } {
  const { data } = entry;
  if (data.prompt !== undefined && typeof data.prompt !== "string")
    return invalidResult("prompt must be a string when present");
  const disable = readBoolean(data.disable);
  if (disable === invalid) return invalidResult("disable must be a boolean");
  if (Object.keys(data).some((key) => !legacyAgentKeys.has(key) && looksLikePermissionField(key))) {
    const key = Object.keys(data).find(
      (candidate) => !legacyAgentKeys.has(candidate) && looksLikePermissionField(candidate),
    );
    return invalidResult(
      `unsupported permission alias${key === undefined ? "" : ` '${key}'`}; use tools or permission`,
    );
  }

  const variant = data.variant;
  if (variant !== undefined && typeof variant !== "string")
    return invalidResult("variant must be a string");
  const model = parseModel(data.model, variant, false);
  if (model.invalid) return invalidResult("legacy model or variant is malformed");
  const common = readAgentFields(data, true);
  if (common === undefined) return invalidResult("legacy agent metadata has an invalid field");

  const options = data.options;
  if (options !== undefined && !isJsonRecord(options))
    return invalidResult("options must be a JSON object");
  const body: Record<string, unknown> = isJsonRecord(options) ? { ...options } : {};
  for (const [key, value] of Object.entries(data)) {
    if (!legacyAgentKeys.has(key)) body[key] = value;
  }
  for (const key of ["temperature", "top_p"]) {
    const value = data[key];
    if (value !== undefined) {
      if (typeof value !== "number" || !Number.isFinite(value))
        return invalidResult(`${key} must be a finite number`);
      body[key] = value;
    }
  }

  const permissions = readLegacyPermissions(data.tools, data.permission, home);
  if (permissions === invalid) return invalidResult("tools or permission contains an invalid rule");
  const directPermissions = readV2Permissions(data.permissions, home);
  if (directPermissions === invalid)
    return invalidResult("permissions must be an array of valid rules");
  const steps = readSteps(data.steps, data.maxSteps);
  if (steps === invalid) return invalidResult("steps or maxSteps must be a positive integer");

  return {
    patch: {
      system: entry.content,
      ...(model.model === undefined ? {} : { model: model.model }),
      ...(Object.keys(body).length === 0 ? {} : { request: { body } }),
      ...common,
      ...(steps === undefined ? {} : { steps }),
      ...(disable === true ? { disabled: true } : {}),
      permissions: [...(permissions ?? []), ...(directPermissions ?? [])],
    },
  };
}

function readAgentFields(data: Record<string, unknown>, legacy: boolean) {
  const fields: {
    description?: AgentPatch["description"];
    mode?: AgentPatch["mode"];
    hidden?: AgentPatch["hidden"];
    color?: AgentPatch["color"];
    steps?: AgentPatch["steps"];
  } = {};
  if (data.description !== undefined) {
    if (typeof data.description !== "string") return undefined;
    fields.description = data.description;
  }
  if (data.mode !== undefined) {
    if (typeof data.mode !== "string" || !agentModes.has(data.mode as AgentSchema.Info["mode"]))
      return undefined;
    fields.mode = data.mode as AgentSchema.Info["mode"];
  }
  if (data.hidden !== undefined) {
    if (typeof data.hidden !== "boolean") return undefined;
    fields.hidden = data.hidden;
  }
  if (data.color !== undefined) {
    if (typeof data.color !== "string") return undefined;
    if (legacy) {
      fields.color = hexColor.test(data.color) ? data.color : "#aaaaaa";
    } else {
      if (!hexColor.test(data.color)) return undefined;
      fields.color = data.color;
    }
  }
  if (!legacy) {
    const steps = readSteps(data.steps);
    if (steps === invalid) return undefined;
    if (steps !== undefined) fields.steps = steps;
  }
  return fields;
}

function readSteps(
  steps: unknown,
  maxSteps?: unknown,
): AgentPatch["steps"] | typeof invalid | undefined {
  if (
    steps !== undefined &&
    (!isPositiveInteger(steps) || (maxSteps !== undefined && !isPositiveInteger(maxSteps)))
  ) {
    return invalid;
  }
  if (steps === undefined && maxSteps !== undefined && !isPositiveInteger(maxSteps)) return invalid;
  return (steps ?? maxSteps) as AgentPatch["steps"] | undefined;
}

function parseModel(
  value: unknown,
  variant: unknown,
  strict: boolean,
): { model?: AgentModel; invalid: boolean } {
  if (variant !== undefined && typeof variant !== "string") return { invalid: true };
  if (value === undefined) return { invalid: false };
  if (typeof value === "string") {
    const pattern = strict ? /^[^/#]+\/[^#]+(?:#[^#]+)?$/ : /^[^/#]+\/[^#]+$/;
    if (!pattern.test(value)) return strict ? { invalid: true } : { invalid: false };
    const reference = `${value}${
      typeof variant === "string" &&
      variant.length > 0 &&
      !variant.includes("#") &&
      !value.includes("#")
        ? `#${variant}`
        : ""
    }`;
    try {
      return { model: Model.Ref.parse(reference), invalid: false };
    } catch {
      return { invalid: strict };
    }
  }
  if (!strict) return { invalid: true };
  if (!isJsonRecord(value)) return { invalid: true };
  if (Object.keys(value).some((key) => !["providerID", "model", "variant"].includes(key)))
    return { invalid: true };
  if (value.variant !== undefined && typeof value.variant !== "string") return { invalid: true };
  if (
    typeof value.providerID !== "string" ||
    typeof value.model !== "string" ||
    value.providerID.includes("/") ||
    value.providerID.includes("#") ||
    value.model.includes("#") ||
    (typeof value.variant === "string" && value.variant.includes("#"))
  ) {
    return { invalid: true };
  }

  const reference = `${value.providerID}/${value.model}${
    typeof value.variant === "string" ? `#${value.variant}` : ""
  }`;
  try {
    return { model: Model.Ref.parse(reference), invalid: false };
  } catch {
    return { invalid: true };
  }
}

function readRequest(value: unknown): AgentPatch["request"] | typeof invalid | undefined {
  if (value === undefined) return undefined;
  if (!isJsonRecord(value)) return invalid;
  if (Object.hasOwn(value, "settings")) return invalid;
  if (Object.keys(value).some((key) => key !== "headers" && key !== "body")) return invalid;
  const headers = value.headers;
  const body = value.body;
  if (
    headers !== undefined &&
    (!isJsonRecord(headers) || Object.values(headers).some((item) => typeof item !== "string"))
  ) {
    return invalid;
  }
  if (body !== undefined && !isJsonRecord(body)) return invalid;
  return {
    ...(headers === undefined ? {} : { headers: headers as Record<string, string> }),
    ...(body === undefined ? {} : { body }),
  };
}

function requestError(value: unknown): string {
  if (isJsonRecord(value) && Object.hasOwn(value, "settings")) {
    return "request.settings is unsupported by V2 agents; use request.headers or request.body";
  }
  return "request must contain only JSON headers and body fields";
}

function readV2Permissions(
  value: unknown,
  home: string,
): AgentPermission[] | typeof invalid | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return invalid;
  const result: AgentPermission[] = [];
  for (const rule of value) {
    if (
      !isJsonRecord(rule) ||
      Object.keys(rule).some((key) => !["action", "resource", "effect"].includes(key)) ||
      typeof rule.action !== "string" ||
      typeof rule.resource !== "string" ||
      !isEffect(rule.effect)
    ) {
      return invalid;
    }
    result.push(
      expandPermission({ action: rule.action, resource: rule.resource, effect: rule.effect }, home),
    );
  }
  return result;
}

function readLegacyPermissions(
  tools: unknown,
  permission: unknown,
  home: string,
): AgentPermission[] | typeof invalid | undefined {
  const rules: AgentPermission[] = [];
  if (tools !== undefined) {
    if (!isJsonRecord(tools)) return invalid;
    for (const [action, enabled] of Object.entries(tools)) {
      if (typeof enabled !== "boolean") return invalid;
      rules.push(
        expandPermission(
          { action: normalizeAction(action), resource: "*", effect: enabled ? "allow" : "deny" },
          home,
        ),
      );
    }
  }
  if (permission !== undefined) {
    if (!isJsonRecord(permission)) return invalid;
    for (const [action, value] of Object.entries(permission)) {
      if (typeof value === "string") {
        if (!isEffect(value)) return invalid;
        rules.push(
          expandPermission({ action: normalizeAction(action), resource: "*", effect: value }, home),
        );
        continue;
      }
      if (!isJsonRecord(value)) return invalid;
      for (const [resource, effect] of Object.entries(value)) {
        if (!isEffect(effect)) return invalid;
        rules.push(expandPermission({ action: normalizeAction(action), resource, effect }, home));
      }
    }
  }
  return rules.length ? rules : undefined;
}

function normalizeAction(action: string) {
  if (action === "write" || action === "patch") return "edit";
  if (action === "task") return "subagent";
  if (action === "bash") return "shell";
  return action;
}

function expandPermission(rule: AgentPermission, home: string): AgentPermission {
  if (!pathPermissionActions.has(rule.action)) return rule;
  if (rule.resource === "~" || rule.resource === "$HOME") return { ...rule, resource: home };
  const relative = rule.resource.startsWith("~/")
    ? rule.resource.slice(2)
    : rule.resource.startsWith("$HOME/") || rule.resource.startsWith("$HOME\\")
      ? rule.resource.slice(6)
      : undefined;
  return relative === undefined
    ? rule
    : {
        ...rule,
        resource: (path.posix.isAbsolute(home) ? path.posix : path.win32).join(home, relative),
      };
}

function looksLikePermissionField(key: string) {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return /(^|[-_])(allow|allowed|deny|permission|permissions|tool|tools)([-_]|$)/.test(normalized);
}

function isEffect(value: unknown): value is AgentPermission["effect"] {
  return typeof value === "string" && permissionEffects.has(value as AgentPermission["effect"]);
}

function isPositiveInteger(value: unknown): value is NonNullable<AgentSchema.Info["steps"]> {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBoolean(value: unknown): boolean | typeof invalid | undefined {
  if (value === undefined) return undefined;
  return typeof value === "boolean" ? value : invalid;
}

function invalidResult(error: string): { readonly error: string } {
  return { error };
}
