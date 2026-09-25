import { Plugin } from "@opencode/plugin";
import type { Context as PluginContext } from "@opencode/plugin/promise/plugin";
import { collectGitContext } from "./git-context.js";
import { buildReviewMessage, REVIEWER_SYSTEM_PROMPT } from "./prompt.js";
import reviewOutputSchema from "./schemas/review-output.schema.json" with { type: "json" };

const PLUGIN_ID = "capybearista.opencode-adversarial-review";
const REVIEWER_AGENT_ID = "adversarial-reviewer";
const COMMAND_NAME = "adversarial-review";
const REVIEW_TEMPERATURE = 0.1;
const REVIEW_SESSION_TITLE = "Adversarial review";
const SYNTHETIC_DESCRIPTION = "Adversarial review";
const REVIEWER_DESCRIPTION =
  "Do not invoke adversarial-reviewer directly. Run /adversarial-review instead; it is the only supported path and supplies a fresh review session with collected Git context.";
// Hex is required; plugin-defined agents do not resolve theme color names.
const REVIEWER_COLOR = "#f59e0b";
const COMMAND_DESCRIPTION =
  "Run an adversarial code review that challenges the implementation. Args: [--base <ref>] [--scope auto|working-tree|branch] [focus ...]";
const REVIEW_OUTPUT_SCHEMA: unknown = reviewOutputSchema;

type PermissionEffect = "allow" | "deny" | "ask";
type PermissionRule = { action: string; resource: string; effect: PermissionEffect };
type AgentEditor = Parameters<Parameters<PluginContext["agent"]["transform"]>[0]>[0];
type AgentInfo = NonNullable<ReturnType<AgentEditor["get"]>>;
type SessionContextMessage = Awaited<ReturnType<PluginContext["session"]["context"]>>[number];
type ReviewModel = { providerID: string; id: string; variant?: string };
type ReviewFailureCode = "empty-output" | "invalid-json" | "schema-violation" | "session-failed";

// Ordered for the host's last-match-wins evaluation: defaults denied first,
// read-only allows next, and the sensitive-read denies after the read allow.
const REVIEWER_PERMISSIONS: readonly PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "subagent", resource: "*", effect: "deny" },
  { action: "edit", resource: "*", effect: "deny" },
  { action: "write", resource: "*", effect: "deny" },
  { action: "patch", resource: "*", effect: "deny" },
  { action: "webfetch", resource: "*", effect: "deny" },
  { action: "websearch", resource: "*", effect: "deny" },
  { action: "question", resource: "*", effect: "deny" },
  { action: "external_directory", resource: "*", effect: "deny" },
  { action: "shell", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "shell", resource: "git blame*", effect: "allow" },
  { action: "shell", resource: "git branch", effect: "allow" },
  { action: "shell", resource: "git diff*", effect: "allow" },
  { action: "shell", resource: "git log*", effect: "allow" },
  { action: "shell", resource: "git ls-files*", effect: "allow" },
  { action: "shell", resource: "git merge-base*", effect: "allow" },
  { action: "shell", resource: "git rev-list*", effect: "allow" },
  { action: "shell", resource: "git rev-parse*", effect: "allow" },
  { action: "shell", resource: "git show*", effect: "allow" },
  { action: "shell", resource: "git stash list*", effect: "allow" },
  { action: "shell", resource: "git stash show*", effect: "allow" },
  { action: "shell", resource: "git status*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
];

function hasRule(rules: readonly PermissionRule[], rule: PermissionRule): boolean {
  return rules.some(
    (existing) =>
      existing.action === rule.action &&
      existing.resource === rule.resource &&
      existing.effect === rule.effect,
  );
}

// Rules are merged additively: host-defined rules are preserved, exact duplicates
// are skipped, and conflicting entries keep the host's evaluation precedence
// instead of being rewritten by the plugin.
function applyRules(agent: AgentInfo, rules: readonly PermissionRule[]): void {
  for (const rule of rules) {
    if (!hasRule(agent.permissions, rule)) agent.permissions.push(rule);
  }
}

function configureReviewerAgent(editor: AgentEditor): void {
  const existing = editor.get(REVIEWER_AGENT_ID);
  editor.update(REVIEWER_AGENT_ID, (agent) => {
    agent.mode = "subagent";
    agent.hidden = true;
    agent.description = REVIEWER_DESCRIPTION;
    agent.system = existing?.system ?? REVIEWER_SYSTEM_PROMPT;
    agent.color = existing?.color ?? REVIEWER_COLOR;
    // The reviewer runs unattended, so inherited ask rules are dropped instead of
    // stalling on a user prompt; the explicit rules below keep it sandboxed.
    const inherited = Array.isArray(agent.permissions) ? agent.permissions : [];
    agent.permissions = inherited.filter((rule) => rule.effect !== "ask");
    applyRules(agent, REVIEWER_PERMISSIONS);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type HostLogSink = (input: { service: string; level: "error"; message: string }) => unknown;

// @opencode/plugin 2.0.2 exposes no logging domain on the plugin context, so
// console.error is the fallback. Hosts that add an `app.log` sink receive the same
// messages as structured entries; wording never changes between the two paths.
function createErrorLogger(ctx: PluginContext): (message: string) => void {
  const sink = (ctx.app as unknown as { log?: unknown } | undefined)?.log;
  if (typeof sink !== "function") {
    return (message) => console.error(message);
  }
  const hostLog = sink as HostLogSink;
  return (message) => {
    try {
      void Promise.resolve(
        hostLog.call(ctx.app, { service: PLUGIN_ID, level: "error", message }),
      ).catch(() => console.error(message));
    } catch {
      console.error(message);
    }
  };
}

function resolveWorkingDirectory(location: PluginContext["location"]): string {
  return location.directory.length > 0 ? location.directory : location.project.directory;
}

function invalidModelOption(value: unknown): Error {
  return new Error(
    `Invalid model option ${JSON.stringify(value)}; expected "provider/id" with an optional "#variant". Fix or remove it to inherit the invoking session's model.`,
  );
}

function parseModelOption(raw: unknown): ReviewModel {
  if (typeof raw !== "string") throw invalidModelOption(raw);
  const value = raw.trim();
  const providerSeparator = value.indexOf("/");
  if (providerSeparator <= 0) throw invalidModelOption(value);
  const providerID = value.slice(0, providerSeparator);
  const variantSeparator = value.indexOf("#", providerSeparator + 1);
  const id = value.slice(
    providerSeparator + 1,
    variantSeparator === -1 ? undefined : variantSeparator,
  );
  const variant = variantSeparator === -1 ? undefined : value.slice(variantSeparator + 1);
  if (
    id.length === 0 ||
    providerID.includes("#") ||
    (variant !== undefined && (variant.length === 0 || variant.includes("#")))
  ) {
    throw invalidModelOption(value);
  }
  return variant === undefined ? { providerID, id } : { providerID, id, variant };
}

async function resolveReviewModel(
  ctx: PluginContext,
  invocationSessionID: string,
): Promise<ReviewModel> {
  if (ctx.options.model !== undefined) return parseModelOption(ctx.options.model);
  let caller: { model?: ReviewModel };
  try {
    caller = (await ctx.session.get({ sessionID: invocationSessionID })) as {
      model?: ReviewModel;
    };
  } catch (error) {
    throw new Error(
      `Unable to read the invoking session "${invocationSessionID}": ${errorMessage(error)}. Select a model there or configure options.model.`,
      { cause: error },
    );
  }
  if (caller.model === undefined) {
    throw new Error(
      `The invoking session "${invocationSessionID}" has no model. Select a model there or configure options.model.`,
    );
  }
  return caller.model;
}

type SchemaNode = Record<string, unknown>;

function isRecord(value: unknown): value is SchemaNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
  switch (expected) {
    case "object":
      return isRecord(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function schemaPath(path: string, key: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

// Hand-rolled validator for the review-output schema, which uses only the
// keywords below.
function validateSchemaNode(schema: unknown, value: unknown, path: string): string | undefined {
  if (!isRecord(schema)) return undefined;
  if (typeof schema.type === "string" && !matchesType(schema.type, value)) {
    const article = /^[aeiou]/.test(schema.type) ? "an" : "a";
    return `${path} must be ${article} ${schema.type}, got ${describeType(value)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => Object.is(allowed, value))) {
    return `${path} must be one of ${schema.enum.map((allowed) => JSON.stringify(allowed)).join(", ")}, got ${JSON.stringify(value)}`;
  }
  if (
    typeof value === "string" &&
    typeof schema.minLength === "number" &&
    value.length < schema.minLength
  ) {
    return `${path} must be at least ${schema.minLength} character(s)`;
  }
  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      return `${path} must be >= ${schema.minimum}`;
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      return `${path} must be <= ${schema.maximum}`;
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    for (let index = 0; index < value.length; index += 1) {
      const issue = validateSchemaNode(schema.items, value[index], `${path}[${index}]`);
      if (issue !== undefined) return issue;
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) return `${path} has unexpected key "${key}"`;
      }
    }
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (typeof key === "string" && !(key in value)) {
          return `${path} is missing required key "${key}"`;
        }
      }
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in value)) continue;
      const issue = validateSchemaNode(childSchema, value[key], schemaPath(path, key));
      if (issue !== undefined) return issue;
    }
  }
  return undefined;
}

function reviewFailure(code: ReviewFailureCode, detail: string, cause?: unknown): Error {
  const message = `Adversarial review failed [${code}]: ${detail}`;
  return cause === undefined ? new Error(message) : new Error(message, { cause });
}

type AssistantMessage = Extract<SessionContextMessage, { type: "assistant" }>;

function latestAssistantMessage(
  messages: readonly SessionContextMessage[],
): AssistantMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.type === "assistant") return message;
  }
  return undefined;
}

function formatSessionError(error: unknown): string {
  if (isRecord(error)) {
    const label = typeof error.type === "string" ? error.type : "error";
    const detail = typeof error.message === "string" ? error.message : errorMessage(error);
    return typeof error.status === "number"
      ? `${label} (${error.status}): ${detail}`
      : `${label}: ${detail}`;
  }
  return errorMessage(error);
}

type AssistantTextPart = { type: "text"; text: string };

function isAssistantTextPart(part: unknown): part is AssistantTextPart {
  return (
    typeof part === "object" &&
    part !== null &&
    (part as { type?: unknown }).type === "text" &&
    typeof (part as { text?: unknown }).text === "string"
  );
}

function extractReviewText(
  messages: readonly SessionContextMessage[],
  reviewSessionID: string,
): string {
  const message = latestAssistantMessage(messages);
  if (message === undefined) {
    throw reviewFailure(
      "empty-output",
      `review session ${reviewSessionID} produced no assistant message`,
    );
  }
  if (message.error !== undefined) {
    throw reviewFailure(
      "session-failed",
      `review session ${reviewSessionID} failed: ${formatSessionError(message.error)}`,
      message.error,
    );
  }
  if (!Array.isArray(message.content)) {
    throw reviewFailure(
      "session-failed",
      `review session ${reviewSessionID} returned a malformed assistant message: content is missing or not an array`,
    );
  }
  const text = message.content
    .filter(isAssistantTextPart)
    .map((part) => part.text)
    .join("");
  if (text.trim().length === 0) {
    throw reviewFailure(
      "empty-output",
      `review session ${reviewSessionID} produced no assistant text output`,
    );
  }
  return text;
}

function validateReviewOutput(text: string, reviewSessionID: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw reviewFailure(
      "invalid-json",
      `review session ${reviewSessionID} returned invalid JSON: ${errorMessage(error)}`,
      error,
    );
  }
  const diagnostic = validateSchemaNode(REVIEW_OUTPUT_SCHEMA, parsed, "$");
  if (diagnostic !== undefined) {
    throw reviewFailure(
      "schema-violation",
      `review session ${reviewSessionID} returned JSON that violates the review output schema: ${diagnostic}`,
    );
  }
  const summary = isRecord(parsed) ? parsed.summary : undefined;
  if (typeof summary === "string" && summary.trim().length === 0) {
    throw reviewFailure(
      "schema-violation",
      `review session ${reviewSessionID} returned JSON that violates the review output schema: $.summary must not be blank`,
    );
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const activeReviewSessions = new Set<string>();
    const disposers: Array<() => Promise<void> | void> = [];
    const logError = createErrorLogger(ctx);

    const pinReviewTemperature = (event: {
      sessionID: string;
      options: { temperature?: number };
    }) => {
      if (activeReviewSessions.has(event.sessionID)) event.options.temperature = REVIEW_TEMPERATURE;
    };

    if (typeof ctx.agent?.transform === "function") {
      const registration = await ctx.agent.transform((editor) => {
        configureReviewerAgent(editor);
      });
      disposers.push(() => registration.dispose());
    } else {
      logError(
        `[${PLUGIN_ID}] agent.transform is unavailable; ${REVIEWER_AGENT_ID} was not registered`,
      );
    }

    if (typeof ctx.session?.hook === "function") {
      const contextHook = await ctx.session.hook("context", pinReviewTemperature);
      const generateHook = await ctx.session.hook("generate", pinReviewTemperature);
      disposers.push(
        () => contextHook.dispose(),
        () => generateHook.dispose(),
      );
    } else {
      logError(`[${PLUGIN_ID}] session.hook is unavailable; review temperature was not pinned`);
    }

    if (typeof ctx.command?.transform === "function") {
      const registration = await ctx.command.transform((editor) => {
        editor.add({
          name: COMMAND_NAME,
          description: COMMAND_DESCRIPTION,
          execute: async (invocation) => {
            const workingDirectory = resolveWorkingDirectory(ctx.location);
            const model = await resolveReviewModel(ctx, invocation.sessionID);
            const gitContext = await collectGitContext(workingDirectory);
            const rawArgs = invocation.prompt.text;

            let created: Awaited<ReturnType<PluginContext["session"]["create"]>>;
            try {
              // session.create is the supported spawn path for /adversarial-review;
              // the root review session is intentionally retained as the audit trail.
              created = await ctx.session.create({
                agent: REVIEWER_AGENT_ID,
                title: REVIEW_SESSION_TITLE,
                location: { directory: workingDirectory },
                model,
              });
            } catch (error) {
              throw reviewFailure(
                "session-failed",
                `review session was not created: ${errorMessage(error)}`,
                error,
              );
            }

            const reviewSessionID = created.id;
            activeReviewSessions.add(reviewSessionID);
            try {
              const stage = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
                try {
                  return await run();
                } catch (error) {
                  throw reviewFailure(
                    "session-failed",
                    `review session ${reviewSessionID} ${name} failed: ${errorMessage(error)}`,
                    error,
                  );
                }
              };

              await stage("prompt", () =>
                ctx.session.prompt({
                  sessionID: reviewSessionID,
                  text: buildReviewMessage(rawArgs, gitContext),
                }),
              );
              await stage("wait", () => ctx.session.wait({ sessionID: reviewSessionID }));
              const messages = await stage("context", () =>
                ctx.session.context({ sessionID: reviewSessionID }),
              );
              const reviewText = extractReviewText(messages, reviewSessionID);
              validateReviewOutput(reviewText, reviewSessionID);
              await stage("delivery", () =>
                ctx.session.synthetic({
                  sessionID: invocation.sessionID,
                  text: reviewText,
                  description: SYNTHETIC_DESCRIPTION,
                  metadata: { source: PLUGIN_ID, sessionID: reviewSessionID },
                  delivery: invocation.delivery,
                  resume: false,
                }),
              );
            } finally {
              activeReviewSessions.delete(reviewSessionID);
            }
          },
        });
      });
      disposers.push(() => registration.dispose());
    } else {
      logError(
        `[${PLUGIN_ID}] command.transform is unavailable; /${COMMAND_NAME} was not registered`,
      );
    }

    return async () => {
      for (const dispose of disposers) await dispose();
    };
  },
});
