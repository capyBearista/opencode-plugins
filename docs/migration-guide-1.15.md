# OpenCode 1.15.x Plugin Migration Guide

**Target Audience:** Internal Team & External Contributors

This guide details the necessary steps to migrate legacy OpenCode plugins to the new 1.15.x Effect-native architecture.

## Monorepo Status: All Clear ✅
**Good news for internal maintainers:** An extensive audit of the `opencode-plugins` monorepo has confirmed that **none of our existing plugins require updates for the 1.15.x migration.** 

All plugins in this repository (e.g., `opencode-agents-loader`, `opencode-double-tap-timeline`, `opencode-output-styles`) already utilize the modern `Plugin` / `TuiPlugin` async function patterns, do not rely on legacy event buses, and do not use the deprecated `WithInstance` adapter.

## Step-by-Step Migration for Legacy Plugins

If you are maintaining an external plugin or updating an older codebase, follow these steps to ensure compatibility with OpenCode 1.15.x.

### Step 1: Migrate Event Subscriptions to `EventV2`
The legacy `EventProjector` and stringly-typed event buses have been replaced.

**Action Required:**
- Remove any usage of `bus.publish("string.type")` or `bus.subscribe("string.type")`.
- Define your events using `EventV2.define()` with an Effect Schema.
- Use `EventV2.Service.publish` and `EventV2.Service.subscribe` passing your defined event object.

### Step 2: Replace `WithInstance` with Direct Effect Services
The `WithInstance.provide()` wrapper has been completely removed from the core.

**Action Required:**
- Search your codebase for imports or usages of `WithInstance`.
- Replace them with direct calls to `InstanceRuntime.load({ directory })` or `InstanceStore.Service.use()`.
- If you have test fixtures relying on `WithInstance`, migrate them to use the new Effect-native fixture helpers (`Effect.fn()`).

### Step 3: Enrich Custom Tools with Zod `.describe()`
While not a breaking change, 1.15.x introduces the ability to pass Zod descriptions directly to the LLM.

**Action Required:**
- Review any custom tools defined using Zod schemas.
- Add `.describe("Detailed explanation of this parameter")` to your Zod object properties.
- This will significantly improve the LLM's ability to use your custom tools correctly, as the descriptions are now preserved in the generated JSON Schema.

### Step 4: Remove `.bind()` for Instance Context
The core system no longer relies on `.bind()` to maintain instance context across asynchronous boundaries.

**Action Required:**
- Remove any manual `.bind()` calls that were previously necessary to keep the `InstanceContext` intact. The new Effect-native architecture handles context propagation automatically via scoped resources.