import { Rpc } from "@opencode/plugin/rpc";

/** Style id meaning "no style" (Claude Code's `default`). */
export const DEFAULT_STYLE_ID = "default";
/** Session metadata key holding the session's own style id. */
export const METADATA_KEY = "outputStyle";

/** Style summary the TUI needs for the picker and sidebar. */
export interface StyleSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "built-in" | "global" | "project";
}

export interface StateOutput {
  readonly styles: readonly StyleSummary[];
  /** Global default style id, or null when none is set or it doesn't resolve in this project. */
  readonly defaultStyle: string | null;
  /**
   * Style id stored on the session (`"default"` = explicitly none), or null when the session
   * follows the global default. A stored id that doesn't resolve here means no style is applied.
   */
  readonly sessionStyle: string | null;
  /** Whether the TUI shows the sidebar line (server `sidebar` option, default true). */
  readonly sidebar: boolean;
  /** True when the given session is a subagent session, which never gets a style. */
  readonly subagent: boolean;
}

const string = { type: "string" } as const;
const nullableString = { type: ["string", "null"] } as const;
const styleOnly = {
  type: "object",
  properties: { style: string },
  required: ["style"],
  additionalProperties: false,
} as const;
const unknownStyle = {
  unknown_style: {
    type: "object",
    properties: { style: string },
    required: ["style"],
    additionalProperties: false,
  },
} as const;
const sessionOnly = {
  type: "object",
  properties: { sessionID: string },
  required: ["sessionID"],
  additionalProperties: false,
} as const;
// Subagent sessions inherit metadata but never get a style, so writing one there is refused.
const subagentSession = {
  subagent_session: {
    type: "object",
    properties: { sessionID: string },
    required: ["sessionID"],
    additionalProperties: false,
  },
} as const;

// Every input is an object: the host rejects a missing input with `rpc.invalid_input`.
export const OutputStylesRpc = Rpc.define({
  id: "output-styles",
  methods: {
    state: {
      input: {
        type: "object",
        properties: { sessionID: string },
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          styles: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: string,
                name: string,
                description: string,
                source: { enum: ["built-in", "global", "project"] },
              },
              required: ["id", "name", "description", "source"],
            },
          },
          defaultStyle: nullableString,
          sessionStyle: nullableString,
          sidebar: { type: "boolean" },
          subagent: { type: "boolean" },
        },
        required: ["styles", "defaultStyle", "sessionStyle", "sidebar", "subagent"],
      },
    },
    setSessionStyle: {
      input: {
        type: "object",
        properties: { sessionID: string, style: string },
        required: ["sessionID", "style"],
        additionalProperties: false,
      },
      output: styleOnly,
      errors: { ...unknownStyle, ...subagentSession },
    },
    clearSessionStyle: {
      input: sessionOnly,
      output: sessionOnly,
      errors: subagentSession,
    },
    setDefaultStyle: {
      input: styleOnly,
      output: styleOnly,
      errors: unknownStyle,
    },
  },
  events: {},
});
