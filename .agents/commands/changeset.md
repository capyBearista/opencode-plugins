---
description: Manage project versioning and changelogs using Changesets
agent: build
subtask: true
---

# Changeset Management

This command helps you manage versions and changelogs for this monorepo.

## Usage

- `/changeset` — Interactively create a new changeset
- `/changeset status` — View pending changesets
- `/changeset version` — Apply changesets to bump versions
- `/changeset <args>` — Pass arbitrary arguments to the changeset CLI

## Argument Contract
ARGUMENTS=$ARGUMENTS

If ARGUMENTS is empty, I will run `bun changeset`.
Otherwise, I will run `bun changeset $ARGUMENTS`.

## Steps
1. Execute `bun changeset $ARGUMENTS`
2. Follow interactive prompts if required
3. Verify the generated `.changeset/*.md` file
