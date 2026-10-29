# Release guard review

The release guard is a fail-closed gate around independently published plugin packages. It validates package major versions against their approved OpenCode release classes and invokes the authorized Changesets publication path.

Read `release-channels.json` together with the guard's `APPROVED_POLICY`, and check the package manifests before calling a policy mismatch. Class-major changes are intentional only when the policy, guard, and approved major changeset move together.

Publication is not atomic: some versions may reach npm before a failure. Inspect retry and recovery changes for unintended tags, duplicate publishing, or unsupported success claims. Registry/auth failures should not turn into authorization bypasses.

The test suite deliberately exercises the real Changesets CLI and Bun workspace requirements. Validate negative cases rather than requiring superficial fixture updates.
