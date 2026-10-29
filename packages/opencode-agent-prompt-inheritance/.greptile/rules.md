# V1 prompt inheritance

This package is intentionally OpenCode V1-only. Review its `experimental.chat.system.transform` usage against the V1 prompt-assembly reference, not V2 Promise API assumptions.

The configured inheritance mode controls whether the provider prompt precedes or follows the custom agent prompt. A missing session or unsupported provider intentionally leaves the existing prompt usable; verify any proposed change preserves that behavior.

`src/prompt/*.txt` are synced upstream fixtures. Evaluate mapping, synchronization, and built-artifact correctness together. Avoid reporting stylistic findings in upstream prompt text or asking for a V2 port as part of an unrelated PR.
