import { Rpc } from "@opencode/plugin";
import { Plugin } from "@opencode/plugin/tui";
import type { JSX } from "@opentui/solid";
import { createElement, insert, spread } from "@opentui/solid";
import { createComponent, createEffect, createSignal, onCleanup } from "solid-js";
import { REVIEW_RPC, type ReviewStatus } from "./review-contract.js";
import {
  createReviewStore,
  createReviewStoreRegistry,
  FINISHED_LABEL,
  IDLE_REVIEW_STATE,
  isLocalReviewEnvelope,
  REVIEWING_LABEL,
  type ReviewStore,
  type ReviewStoreHandle,
  type ReviewStoreRegistry,
  type ReviewTransport,
  type ReviewViewState,
} from "./tui-controller.js";

type TuiContext = Plugin.Context;
type FooterInput = { readonly sessionID?: string };
type ComposerInput = { readonly sessionID: string };

export const TUI_PLUGIN_ID = "capybearista.opencode-auto-advisor-tui";
const ADVICE_PANEL_MAX_HEIGHT = 10;

type NodeProps = Record<string, unknown | (() => unknown)>;

function renderableProps(props: NodeProps): Record<string, unknown> {
  const reactive: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    Object.defineProperty(reactive, key, {
      enumerable: true,
      get: () => (typeof value === "function" ? (value as () => unknown)() : value),
    });
  }
  return reactive;
}

function textNode(props: NodeProps, content: string | (() => string | null)): JSX.Element {
  const node = createElement("text");
  spread(node, renderableProps(props), true);
  insert(node, content);
  return node as unknown as JSX.Element;
}

function boxNode(tag: string, props: NodeProps, children: unknown[]): JSX.Element {
  const node = createElement(tag);
  spread(node, renderableProps(props), true);
  insert(node, children);
  return node as unknown as JSX.Element;
}

function mutedTone(context: TuiContext): unknown {
  return (context.theme as { readonly text: { readonly muted: unknown } }).text.muted;
}

export function resolveDirectory(context: TuiContext, sessionID?: string): string {
  if (sessionID) {
    try {
      const directory = context.data.session.get(sessionID)?.location?.directory;
      if (typeof directory === "string" && directory.length > 0) return directory;
    } catch {
      undefined;
    }
  }
  const current = context.location?.directory;
  if (typeof current === "string" && current.length > 0) return current;
  return context.data.location.default().directory;
}

type RpcStatusCaller = (
  input: { readonly sessionID: string },
  opts: { readonly location: { readonly directory: string }; readonly signal: AbortSignal },
) => Promise<ReviewStatus>;

type RpcEventHandler = (event: {
  readonly location?: { readonly directory?: string };
  readonly data?: ReviewStatus;
}) => void;

interface RpcEventSource {
  readonly on: (name: string, handler: RpcEventHandler) => () => void;
}

interface ReviewRpcClient {
  readonly status: RpcStatusCaller;
  readonly events: RpcEventSource;
}

export function createReviewTransport(
  client: TuiContext["client"],
  sessionID: string,
  directory: string,
): ReviewTransport {
  const definition = Rpc.define(REVIEW_RPC);
  const rpcClient = (client.rpc as unknown as (def: typeof definition) => ReviewRpcClient)(
    definition,
  );
  return {
    query: (input, opts) =>
      rpcClient.status(input, { location: { directory }, signal: opts.signal }),
    subscribe: (name, handler) => {
      try {
        return rpcClient.events.on(name, (envelope) => {
          const location = envelope.location;
          const data = envelope.data;
          if (!location || !data) return;
          if (
            !isLocalReviewEnvelope(
              {
                location: { directory: location.directory ?? "" },
                data: { sessionID: data.sessionID },
              },
              sessionID,
              directory,
            )
          ) {
            return;
          }
          handler();
        });
      } catch {
        return () => undefined;
      }
    },
  };
}

export interface BindingKey {
  readonly sessionID: string;
  readonly directory: string;
}

export function readBindingKey(
  sessionID: string | undefined,
  directory: string,
): BindingKey | undefined {
  if (!sessionID || sessionID.trim().length === 0) return undefined;
  if (!directory || directory.length === 0) return undefined;
  return { sessionID, directory };
}

export function sameBindingKey(
  left: BindingKey | undefined,
  right: BindingKey | undefined,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.sessionID === right.sessionID && left.directory === right.directory;
}

export interface BindingScopeOptions {
  readonly getSessionID: () => string | undefined;
  readonly getDirectory: () => string;
  readonly clear: () => void;
  readonly bind: (key: BindingKey) => { readonly dispose: () => void } | undefined;
}

export interface BindingScope {
  readonly sync: () => void;
  readonly dispose: () => void;
  readonly key: () => BindingKey | undefined;
}

export function createBindingScope(options: BindingScopeOptions): BindingScope {
  let current: BindingKey | undefined;
  let handle: { readonly dispose: () => void } | undefined;
  const disposeHandle = (): void => {
    if (!handle) return;
    const next = handle;
    handle = undefined;
    try {
      next.dispose();
    } catch {
      undefined;
    }
  };
  return {
    key: () => current,
    sync: () => {
      let directory: string;
      try {
        directory = options.getDirectory();
      } catch {
        disposeHandle();
        current = undefined;
        options.clear();
        return;
      }
      const next = readBindingKey(options.getSessionID(), directory);
      if (sameBindingKey(next, current)) return;
      disposeHandle();
      current = next;
      options.clear();
      if (!next) return;
      try {
        handle = options.bind(next);
      } catch {
        handle = undefined;
      }
    },
    dispose: () => {
      disposeHandle();
      current = undefined;
    },
  };
}

function createStore(context: TuiContext, key: BindingKey): ReviewStore | undefined {
  let transport: ReviewTransport;
  try {
    transport = createReviewTransport(context.client, key.sessionID, key.directory);
  } catch {
    return undefined;
  }
  return createReviewStore({
    sessionID: key.sessionID,
    transport,
    onConnected: (listener) => context.data.on("server.connected", listener),
  });
}

interface ReviewBindingOptions {
  readonly registry: ReviewStoreRegistry;
  readonly getSessionID: () => string | undefined;
  readonly getDirectory: () => string;
}

interface ReviewBinding {
  readonly state: () => ReviewViewState;
  readonly sync: () => void;
  readonly dispose: () => void;
}

function createReviewBinding(options: ReviewBindingOptions): ReviewBinding {
  const [state, setState] = createSignal<ReviewViewState>(IDLE_REVIEW_STATE);
  let release: (() => void) | undefined;
  let unsubscribe: (() => void) | undefined;

  const teardown = (): void => {
    const off = unsubscribe;
    unsubscribe = undefined;
    try {
      off?.();
    } catch {
      undefined;
    }
    const free = release;
    release = undefined;
    try {
      free?.();
    } catch {
      undefined;
    }
  };

  const scope = createBindingScope({
    getSessionID: options.getSessionID,
    getDirectory: options.getDirectory,
    clear: () => {
      setState(IDLE_REVIEW_STATE);
    },
    bind: (key) => {
      let handle: ReviewStoreHandle | undefined;
      try {
        handle = options.registry.acquire(key);
        if (!handle) return undefined;
        const store = handle.store;
        unsubscribe = store.subscribe(() => setState(store.getState()));
        release = handle.release;
        setState(store.getState());
      } catch {
        handle?.release();
        unsubscribe = undefined;
        release = undefined;
        return undefined;
      }
      return { dispose: teardown };
    },
  });

  return {
    state,
    sync: scope.sync,
    dispose: () => {
      scope.dispose();
      teardown();
    },
  };
}

function FooterStatus(props: {
  context: TuiContext;
  registry: ReviewStoreRegistry;
  input: FooterInput;
}): JSX.Element {
  const binding = createReviewBinding({
    registry: props.registry,
    getSessionID: () => props.input.sessionID,
    getDirectory: () => resolveDirectory(props.context, props.input.sessionID),
  });

  binding.sync();

  createEffect(() => {
    binding.sync();
  });

  onCleanup(() => {
    binding.dispose();
  });

  return boxNode("box", { flexDirection: "row", gap: 1, flexShrink: 0 }, [
    () =>
      binding.state().running
        ? textNode(
            { fg: () => mutedTone(props.context), wrapMode: "none", truncate: true },
            () => REVIEWING_LABEL,
          )
        : null,
    () =>
      !binding.state().running && binding.state().finished
        ? textNode(
            { fg: () => mutedTone(props.context), wrapMode: "none", truncate: true },
            () => FINISHED_LABEL,
          )
        : null,
  ]);
}

function ComposerAdvice(props: {
  context: TuiContext;
  registry: ReviewStoreRegistry;
  input: ComposerInput;
}): JSX.Element {
  const binding = createReviewBinding({
    registry: props.registry,
    getSessionID: () => props.input.sessionID,
    getDirectory: () => resolveDirectory(props.context, props.input.sessionID),
  });

  binding.sync();

  createEffect(() => {
    binding.sync();
  });

  onCleanup(() => {
    binding.dispose();
  });

  return boxNode("box", { flexDirection: "column", flexGrow: 1, flexShrink: 1, minWidth: 0 }, [
    () => {
      const text = binding.state().advice;
      if (!text || text.trim().length === 0) return null;
      return boxNode(
        "box",
        {
          border: true,
          borderStyle: "rounded",
          borderColor: () => mutedTone(props.context),
          flexDirection: "column",
          gap: 0,
          paddingLeft: 1,
          paddingRight: 1,
          flexGrow: 1,
          flexShrink: 1,
          minWidth: 0,
        },
        [
          textNode(
            { fg: () => mutedTone(props.context), wrapMode: "none", truncate: true },
            () => "Auto-Advisor",
          ),
          boxNode(
            "scrollbox",
            {
              maxHeight: ADVICE_PANEL_MAX_HEIGHT,
              scrollY: true,
              contentOptions: { minHeight: 0 },
              scrollbarOptions: { visible: false },
            },
            [
              textNode(
                { fg: () => mutedTone(props.context), flexGrow: 1, flexShrink: 1, minWidth: 0 },
                () => text,
              ),
            ],
          ),
        ],
      );
    },
  ]);
}

const plugin = Plugin.define({
  id: TUI_PLUGIN_ID,
  setup(context) {
    const registry = createReviewStoreRegistry((key) => createStore(context, key));
    const unregisterFooter = context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => createComponent(FooterStatus, { context, registry, input }),
    });
    const unregisterComposer = context.ui.slot({
      append: "session.composer.top",
      render: (input) => createComponent(ComposerAdvice, { context, registry, input }),
    });
    let disposed = false;
    return () => {
      if (disposed) return;
      disposed = true;
      try {
        unregisterFooter();
      } catch {
        undefined;
      }
      try {
        unregisterComposer();
      } catch {
        undefined;
      }
      registry.dispose();
    };
  },
});

export default plugin;
