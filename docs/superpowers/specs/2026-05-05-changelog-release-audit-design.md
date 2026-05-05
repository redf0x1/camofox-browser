# Changelog Release Audit Design

## Problem

The current `CHANGELOG.md` records the `2.4.0` and `2.4.1` releases, but it does not communicate the full release story clearly enough for readers arriving from `v2.3.0`. A large amount of shipped work landed across Wave 2: security hardening, session-scoped proxy and geo identity, lifecycle cleanup and exit policy, fingerprint environment controls, structured extraction, OpenAPI/docs, and the `2.4.1` release-lane hotfix. The changelog should reflect that shipped scope without blurring version boundaries or mixing in unshipped work.

## Goals

1. Make the `v2.3.0 -> v2.4.1` evolution easy to understand at a glance.
2. Keep the file professional and semver-readable by preserving per-version entries.
3. Distinguish feature delivery, hardening, documentation sync, and release-distribution fixes.
4. Ensure every statement is backed by shipped commits and published releases only.

## Non-Goals

- Rewriting the entire historical changelog before `v2.3.0`
- Converting the project to a different changelog format or release taxonomy
- Adding roadmap or future-looking statements

## Options Considered

### Option 1: Expand per-version entries only

Keep the file strictly version-by-version and enrich `2.4.0` and `2.4.1`.

- Pros: semver-pure, low structural change
- Cons: readers still have to mentally reconstruct the release narrative

### Option 2: Add an audit summary only

Add a single release-audit block near the top and leave version entries mostly unchanged.

- Pros: fast to read
- Cons: weakens version-level precision and leaves release entries under-detailed

### Option 3: Combined audit + enriched version entries

Add a concise audit block at the top and also improve `2.4.0` and `2.4.1`.

- Pros: best reader experience, strong release traceability, keeps semver structure intact
- Cons: requires careful editing to avoid duplication

## Chosen Approach

Use **Option 3**.

## Proposed Structure

### 1. New top-level release audit block

Add a short section immediately below `## [Unreleased]` summarizing the shipped changes from `v2.3.0` to `v2.4.1` in a professional audit style.

Suggested categories:

- Security hardening
- Proxy and geo session identity
- Lifecycle and cleanup behavior
- Fingerprint environment controls
- Structured extraction
- OpenAPI and docs surface
- Release-lane hardening

This block should describe the arc of the release line, not replace versioned entries.

### 2. Expand `2.4.0`

Keep `2.4.0` as the main Wave 2 delivery release and make the entry more complete.

Target structure:

- `Upgrade Notes`
- `Added`
- `Changed`
- `Fixed`
- `Security`
- `Docs`
- `Tests`

The `Fixed` section should capture important shipped correctness work that currently gets buried inside the commit history, especially where the final Wave 2 surface depended on hardening after the first feature commit.

### 3. Tighten `2.4.1`

Keep `2.4.1` as a narrow patch release, but clarify that it is:

- a release-distribution hotfix
- fully inheriting the Wave 2 surface from `2.4.0`
- specifically addressing Docker/GHCR publication resilience during optional `camoufox-js fetch`

### 4. Source-of-truth rules

The changelog refresh must be derived from:

- shipped commits in `v2.3.0..v2.4.1`
- published GitHub releases
- current `RELEASE_NOTES.md`
- audited repository behavior already merged to `main`

It must not include:

- unmerged PR work
- future plans
- speculative claims

## Editing Rules

1. Prefer grouped capability language over commit-by-commit narration.
2. Mention documentation work only where it shipped user-visible behavior or clarified a release contract.
3. Avoid repeating identical bullets in both the audit block and version entries; the audit block is summary, the version entry is authoritative.
4. Preserve the existing changelog style unless clarity requires a small structural extension.

## Acceptance Criteria

1. A reader scanning only the top of `CHANGELOG.md` can understand what changed between `v2.3.0` and `v2.4.1`.
2. A reader inspecting `2.4.0` can distinguish major features from hardening and security changes.
3. `2.4.1` reads as a real patch release, not an isolated one-line fix without context.
4. The updated changelog remains consistent with `RELEASE_NOTES.md` and published release tags.
