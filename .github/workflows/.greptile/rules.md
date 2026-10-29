# Workflow review

These workflows own different responsibilities: `ci.yml` validates code, `changesets.yml` validates release intent, `release.yml` publishes from authorized mainline events, and `sync-opencode-prompts.yml` updates generated V1 prompt fixtures via a reviewable PR.

Read path filters in context. Docs, assets, and changeset-only changes intentionally skip some CI jobs; missing a build job in CI is not itself a regression because the documented full build gate runs locally. The Changesets check should still cover relevant release metadata changes.

Review job permissions, trust of pull-request code, token exposure, registry publishing, pinned tools and approval gates using the actual trigger and dependency graph. Do not suggest broad write permissions to make an automation simpler.
