import { Rpc } from "@opencode/plugin/rpc";

/** Style summary the TUI needs for the picker and sidebar. */
export interface StyleSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly source: "built-in" | "global" | "project";
}

export interface StateOutput {
  readonly styles: readonly StyleSummary[];
  /** Global default style id, or null when none is set. */
  readonly defaultStyle: string | null;
  /** Style id stored on the session, or null when the session follows the default. */
  readonly sessionStyle: string | null;
  /** Whether the TUI shows the sidebar line (server `sidebar` option, default true). */
  readonly sidebar: boolean;
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
        },
        required: ["styles", "defaultStyle", "sessionStyle", "sidebar"],
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
      errors: unknownStyle,
    },
    setDefaultStyle: {
      input: styleOnly,
      output: styleOnly,
      errors: unknownStyle,
    },
  },
  events: {},
});
