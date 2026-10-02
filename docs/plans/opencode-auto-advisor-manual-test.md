# Auto-Advisor focused manual test

**Status: draft — automated gates and final code review must finish before use.**

This is a focused acceptance pass, not full dogfooding. Do not merge or publish
as part of it. Use OpenCode **2.0.21** and the built workspace package **2.0.0**.

## Isolated setup

From the repository:

```bash
opencode --version
(cd /home/arjun/opencode-plugins/packages/opencode-auto-advisor && bun run build)
```

Create a private profile and disposable workspace. These commands do not modify
your normal configuration or provider database. The environment file contains a
local server password; do not commit or share it.

```bash
umask 077
PROFILE=$(mktemp -d /tmp/opencode/auto-advisor-manual.XXXXXX)
mkdir -p "$PROFILE"/{config,data,cache,state,work}
PW=$(bun -e 'console.log(crypto.randomUUID())')
printf 'export PROFILE=%q\nexport DIR=%q\nexport PORT=%q\nexport OPENCODE_CONFIG_DIR=%q\nexport XDG_DATA_HOME=%q\nexport XDG_CACHE_HOME=%q\nexport XDG_STATE_HOME=%q\nexport OPENCODE_PASSWORD=%q\n' \
  "$PROFILE" "$PROFILE/work" 53121 "$PROFILE/config" \
  "$PROFILE/data" "$PROFILE/cache" "$PROFILE/state" "$PW" > "$PROFILE/env.sh"
source "$PROFILE/env.sh"
printf 'Private profile: %s\n' "$PROFILE"

cat > "$OPENCODE_CONFIG_DIR/opencode.json" <<'JSON'
{
  "plugins": ["/home/arjun/opencode-plugins/packages/opencode-auto-advisor"],
  "default_agent": "manual_executor",
  "agents": {
    "manual_executor": {
      "mode": "primary",
      "permissions": [
        {"action":"advisor","resource":"*","effect":"allow"},
        {"action":"subagent","resource":"*","effect":"allow"}
      ]
    },
    "manual_child": {
      "mode": "subagent",
      "permissions": [{"action":"advisor","resource":"*","effect":"allow"}]
    }
  }
}
JSON

cat > "$OPENCODE_CONFIG_DIR/auto-advisor.json" <<'JSON'
{
  "advisor": {"timeoutMs":300000},
  "routing": {
    "mode":"off",
    "models":["jev-1.13-free"],
    "advisorWouldHelpThreshold":0,
    "consequenceThreshold":0,
    "maxConsultationsPerTurn":1
  }
}
JSON
```

The zero thresholds are temporary test settings, not recommended production
defaults. They do not bypass a Jev failure. The free-only chain avoids deliberately
testing paid fallback before the final optional check.

Use one explicitly started host so the TUI and inspection commands target the
same profile. Choose another port if `53121` is occupied; never connect to an
unidentified existing process.

**Terminal A**, after sourcing the environment file:

```bash
opencode serve --hostname 127.0.0.1 --port "$PORT"
```

**Terminal B**:

```bash
source "/tmp/opencode/auto-advisor-manual.<your-suffix>/env.sh"
opencode --server "http://127.0.0.1:$PORT" "$DIR"
```

Connect a provider through the test TUI's normal connection flow and choose a
working Executor model. This isolated data directory does not inherit your
normal provider credentials. Keep credentials out of the disposable task files.

For a TUI-only check, `OPENCODE_CONFIG_DIR="$PROFILE/config" opencode --standalone
"$DIR"` is supported, but its private endpoint/password are not exposed for this
inspection recipe. Bare `opencode`, `service status`, or `api` without `--server`
can target the managed main-profile service instead. `api --standalone` starts a
different host and cannot inspect the TUI's standalone host.

## Inspection

In a third terminal, source the same environment file. After an automatic turn,
copy its `sessionID` from the telemetry response. Record the last sequence/cursor
before each check so old events are not mistaken for new activity.

```bash
opencode api --server "http://127.0.0.1:$PORT" \
  --param "location.directory=$DIR" rpc.call \
  --data '{"rpcID":"experimental.auto-advisor","method":"telemetry.query","input":{"limit":20}}'

SESSION_ID='<copy the test sessionID>'
opencode api --server "http://127.0.0.1:$PORT" \
  --param "location.directory=$DIR" rpc.call \
  --data "{\"rpcID\":\"experimental.auto-advisor.review\",\"method\":\"status\",\"input\":{\"sessionID\":\"$SESSION_ID\"}}"
```

`auto-advisor.json` is reread on the next context/tool call. For changes to
`opencode.json` or `cli.json`, stop and restart this private host/TUI for a
predictable test. Preserve the profile between retention checks.

## Checklist

Mark each item pass/fail/not exercised, with a short observation. A skipped
provider or visual case is not a pass.

| # | Procedure | Expected observation |
|---|---|---|
| 1 | Keep `off`. Ask the root Executor: “Call `advisor()` now to review this proposed approach before replying.” Supply a small approach with constraints. | A real zero-argument tool call returns concise qualitative review. No Jev call, automatic quota use, confidence field, or automatic footer event. |
| 2 | Set `advisor.model` to `unknown-provider/no-such-model`; repeat explicit invocation, then remove the override. | Clear tool failure naming the problem; no silent model substitution. Executor can continue. |
| 3 | Set `routing.mode` to `active`. Ask for a short, constraint-heavy plan, such as crash-safe replacement of a disposable file. | An accepted routing boundary pauses the pending Executor request while Advisor runs. Confirm accepted/delivered telemetry; a Jev rejection/failure does not satisfy this test. |
| 4 | During that actual inference, watch the prompt footer. If the model is too fast, use a slower available model and one new turn. | Native running presentation plus `Auto-Advisor reviewing`; not a custom transcript/tool row. |
| 5 | Watch completion while Executor activity continues. | `✓ Auto-Advisor finished` appears for about 2–3 seconds, then disappears. |
| 6 | Inspect the latest reviewer panel and Executor continuation. | Final advice appears above the composer, with no input, hidden reasoning, probability, or telemetry. The advice reaches the Executor as privileged system guidance, not a fabricated `advisor()` call or user message. Automated wire tests establish the encoding; UI appearance alone does not. |
| 7 | Ask the Executor to state the concrete adjustment/check it made after reviewing advice, or explain a conflict with direct evidence. | Visible action or reconciliation, not unsupported obedience. User constraints and primary evidence still prevail. |
| 8 | Set `observe`; issue another substantive request and inspect new telemetry. | Jev evaluates, but there is no actual Advisor call, new advice, or reviewing/finished lifecycle. |
| 9 | Set `off`; request a normal reply, then explicitly call `advisor()`. | No automatic routing. Explicit review still works. |
| 10 | Keep `off`; ask the root to delegate a tiny read-only check to `manual_child`, requesting Advisor only if available. Then repeat with `active` and inspect the real child trace. | A genuinely parented child has no `advisor` tool and no automatic Advisor/Jev activity. Root activity is separate. Do not substitute a forked root session or a denied child. |
| 11 | Change the root's native `advisor` rule from `allow` to `deny`, restart, and test explicit plus `active`. Restore and restart afterward. | Tool absent; no automatic consultation. An unavailable-tool response is acceptable; no Advisor generation occurs. |
| 12 | Remove `advisor.model` and review explicitly; then use a valid, different `provider/model` override. | Inheritance first, configured model second. Confirm the actual provider/model, not just stylistic differences in text. |
| 13 | In `off`, temporarily set `advisor.timeoutMs` to `1` and call explicitly. Then test `active` on a new accepted opportunity. Restore `300000`. | Explicit timeout is clear. Automatic timeout clears running quietly and lets Executor continue; no new completed advice. Underlying generation may continue: avoid repeated calls while it finishes. |
| 14 | In `active`, explicitly consult, then let that Executor turn continue without new material; inspect routing telemetry. Add a meaningful new user/tool result afterward. | Immediate same-state automatic duplicate is suppressed. New material can re-enable evaluation. Explicit review did not consume automatic quota. |
| 15 | Complete an automatic review, then start another user turn in the same session and ask the Executor to apply the earlier constraint. | Retained advice remains available without multiplying on each continuation. The TUI shows the latest completed review only, not a separate history UI. |
| 16 | Trigger normal compaction if practical and continue the same task. | Important review survives in context. Only exact proven absorption retires plugin records; paraphrased/unproven or failed compaction preserves them. Do not deliberately break a real provider to force failure. |
| 17 | Set `$OPENCODE_CONFIG_DIR/cli.json` to `{"plugins":["-capybearista.opencode-auto-advisor-tui"]}`, restart, and repeat explicit/active checks. Also use `opencode run --server "http://127.0.0.1:$PORT" --model provider/model 'Call advisor() to review this small plan before replying.'` from `$DIR`. | Core tool, routing, persistence, and telemetry work without the companion or in non-TUI use. Only visual surfaces disappear. |
| 18 | If safe/available, restore the intended Jev chain `["jev-1.13-free","jev-1.13"]` and inspect free success or naturally occurring fallback/auth behavior. | Free success works; paid public-credential rejection stays terminal and may be cached. Do not consume quota deliberately, break credentials, or claim forced paths were exercised. Controlled native probes cover these classes automatically. |

Also check a narrow terminal and a long review: the panel should remain readable
and scrollable without trapping input focus. Reconnect to the same host during a
review if practical. **Restart the TUI after endpoint/port/auth replacement**:
SDK 2.0.21 captures its setup client, so seamless replacement is not supported.

## Stop conditions and report

Stop on incorrect role/authority, subagent exposure, silent Advisor fallback,
lost advice, duplicate automatic review, or an input/reasoning leak. Report the
case, model, mode, observed lifecycle, and sanitized telemetry; do not share the
environment file, provider credentials, or raw private prompts.

Record limitations honestly: soft timeout has no cancellation; token estimates
are approximate; native visual behavior and model-quality reactions require this
manual pass; paid/free service access may prevent particular live checks.

After this checklist succeeds, stop. Full dogfooding, merging, and the first
`2.0.0` publication/bootstrap are separate next phases. Stop only the private
host with Ctrl-C; do not stop the normal managed service.
