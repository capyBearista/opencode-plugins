# Decisions

This ledger records durable repository and product decisions. Small decisions live here directly; larger architectural decisions link to standalone ADRs under [`docs/decisions/`](./decisions/).

## D-001 — Auto Advisor uses a dual-path architecture

**Status:** Accepted  
**Scope:** `@capybearista/opencode-auto-advisor`  
**ADR:** [ADR-0001](./decisions/0001-dual-path-auto-advisor.md)

Explicit Executor-triggered consultation and experimental automatic routing converge on one fresh, stateless Advisor service that receives the actual relevant Executor context.

---

## D-002 — Automatic routing is experimental in v1

**Status:** Accepted  
**Scope:** Auto Advisor automatic routing  
**ADR:** [ADR-0002](./decisions/0002-experimental-automatic-routing.md)

Automatic routing ships behind `off | observe | active` modes. `off` is the default; `observe` requires telemetry; `active` remains experimental.

---

## D-003 — Automatic advice uses system-role context in v1

**Status:** Accepted  
**Scope:** Auto Advisor advice delivery  
**ADR:** [ADR-0003](./decisions/0003-automatic-advice-delivery.md)

Explicit consultation returns a genuine tool result. Automatic consultation uses system-role context through `session.context`, with plugin-managed same-turn lifetime, until OpenCode exposes a suitable native durable instruction API to plugins.

---

## D-004 — The explicit Advisor tool accepts no arguments

**Status:** Accepted  
**Scope:** Auto Advisor public tool API

The Executor invokes `advisor()` with an empty object input. The plugin owns context collection; the Executor does not pass a question or context summary.

---

## D-005 — An Advisor model must be configured

**Status:** Accepted  
**Scope:** Auto Advisor configuration

The plugin requires an Advisor model configuration and does not silently fall back to the Executor model. The configured model need not be described as objectively stronger.

---

## D-006 — Use native V2 plugin options

**Status:** Accepted  
**Scope:** Auto Advisor configuration

Configuration uses OpenCode V2 `plugins[].options`. No plugin-specific sidecar configuration file is introduced.

---

## D-007 — v1 Advisor consultations are fresh and tool-free

**Status:** Accepted  
**Scope:** Advisor behavior

Every consultation is stateless, returns plain-text advice, and has no independent repository or network tools.

---

## D-008 — v1 Jev providers are TypeSafe AI and OpenCode Zen

**Status:** Accepted  
**Scope:** Experimental automatic routing

v1 supports direct TypeSafe AI and OpenCode Zen only. Provider-specific Evaluation details remain isolated behind the Jev adapter.

---

## D-009 — Automatic consultation budget is configurable

**Status:** Accepted  
**Scope:** Automatic routing policy

The initial default is one automatic consultation per user turn. Explicit `advisor()` calls do not consume the automatic budget.

---

## D-010 — Telemetry is opt-in except in observe mode

**Status:** Accepted  
**Scope:** Routing telemetry

Telemetry is disabled by default. `observe` requires durable telemetry because its purpose is to collect routing evidence without changing Executor behavior.

---

## D-011 — Auto Advisor is V2-only and publishes on npm latest

**Status:** Accepted  
**Scope:** Package compatibility and release policy

`@capybearista/opencode-auto-advisor` is an OpenCode V2-only package with no V1 line. Its npm distribution channel is `latest`, not `opencode` or `opencode2`. Release tooling must preserve host-version separation independently of dist-tag choice.
