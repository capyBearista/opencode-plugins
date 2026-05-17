# OpenCode 1.15.x Plugin System Architecture

**Target Audience:** Internal Team & External Contributors

The OpenCode 1.15.x release line introduces a massive architectural shift in how the plugin and extension system operates internally. While the external `@opencode-ai/plugin` SDK interface remains largely stable, the internal plumbing has been completely overhauled to embrace a pure **Effect-native architecture**.

This document provides an architectural deep dive into these changes, complete with before/after examples to illustrate the new paradigms.

## 1. Effect-Native Core Event System (`EventV2`)

### Architectural Deep Dive
Previously, events were dispatched through a legacy `EventProjector` system that relied on stringly-typed event types, manual version management, and a separate synchronization layer. The event projector lookup used unversioned type keys, making it fragile across version boundaries.

The new `EventV2` system is a fully typed, Effect-native event bus. It leverages Effect Schema for strict payload validation, versioned definitions, and per-type PubSub channels. A global event registry (`EventV2.registry`) maps type strings to definitions, enabling robust runtime discovery and centralized sync handlers.

### Before/After Example

**Before (Legacy EventProjector):**
```typescript
// Stringly-typed, manual validation
bus.publish("my.custom.event", { someData: 123 });

bus.subscribe("my.custom.event", (payload) => {
  // No guarantee payload matches expected shape
  console.log(payload.someData);
});
```

**After (EventV2):**
```typescript
import { EventV2 } from "@opencode-ai/core";
import { Schema } from "@effect/schema";

// 1. Define a strongly-typed, versioned event
const MyCustomEvent = EventV2.define({
  type: "my.custom.event",
  version: 1,
  data: Schema.Struct({
    someData: Schema.Number,
  }),
});

// 2. Publish with type safety
yield* EventV2.Service.publish(MyCustomEvent, { someData: 123 });

// 3. Subscribe with guaranteed payload shapes
const stream = yield* EventV2.Service.subscribe(MyCustomEvent);
// stream yields payloads where data.someData is guaranteed to be a number
```

## 2. Custom Tool Zod Metadata Bridge

### Architectural Deep Dive
In older versions, when a plugin defined a custom tool using Zod, metadata such as `.describe("...")` annotations were lost during the conversion to JSON Schema for the LLM. The schema only captured structural types, depriving the LLM of crucial context.

In 1.15.x, a `zodMetadataRegistry` intercepts the schema conversion process. It recursively collects Zod metadata and descriptions, ensuring they are preserved in the final JSON Schema. This allows plugin developers to build highly descriptive, self-documenting tools that the LLM can understand accurately.

### Before/After Example

**Before (Descriptions Lost):**
```typescript
import { z } from "zod";

const MyToolArgs = z.object({
  targetPath: z.string().describe("The absolute path to the target directory"),
});
// The LLM would only see { "targetPath": "string" }
```

**After (Descriptions Preserved):**
```typescript
import { z } from "zod";

const MyToolArgs = z.object({
  targetPath: z.string().describe("The absolute path to the target directory"),
});
// The LLM now sees { "targetPath": "string", "description": "The absolute path to the target directory" }
```

## 3. Removal of `WithInstance` Adapter

### Architectural Deep Dive
The legacy `WithInstance.provide()` wrapper was used as a bridge to call Effect services from non-Effect (callback/async) code, specifically to access project state. This pattern was clunky and broke the pure Effect paradigm.

In 1.15.x, `WithInstance` has been completely removed. It is replaced by direct `InstanceRuntime.load()` and `InstanceStore.Service.use()`. This reduces mental model complexity, eliminates unnecessary adapter layers, and encourages developers to write pure Effect code.

### Before/After Example

**Before (WithInstance Adapter):**
```typescript
import { WithInstance } from "@opencode-ai/core";

await WithInstance.provide({
  directory: input.directory,
  fn: async (ctx) => {
    await doSomethingWithContext(ctx);
  },
});
```

**After (Direct Effect Services):**
```typescript
import { InstanceRuntime } from "@opencode-ai/core";

// Load the instance directly
await InstanceRuntime.load({ directory: input.directory });
await doSomethingWithContext();
```