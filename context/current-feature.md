# Current Feature

## Project Setup

**Status:** Complete
**Branch:** `chore/project-setup`

### Goals

- `CLAUDE.md` and context files (`ai-guidelines.md`, `coding-standards.md`, `current-feature.md`, `project-schema.md`)
- `context/specs/ext-0.1-save-guard-spec.md`
- `manifest.json`, an empty `index.js` that loads in SillyTavern, `package.json` (test script only), `LICENSE`, `README.md`
- `test/` with one passing placeholder test, so `node --test` runs

### Notes

- `manifest.json` `loading_order` is a placeholder: the spec's "(verify) loads before Memory Books" is checked when the guard is built (Phase 1)
- Manual checks (user): the extension installs and loads in SillyTavern with no console errors; two-tab check on a throwaway chat that an old copy of a chat really saves over newer messages

## History

<!-- One entry per completed feature / fix, 3–5 lines max: what changed, cause/key decisions, gotchas, what's unverified, version. No verification logs or test counts. Nothing private. -->

### 2026-11-20 — Project setup
- Added `CLAUDE.md`, context files, the v0.1 save guard spec, `manifest.json` (`0.0.1`), a placeholder `index.js`, `package.json` (test script only) and a placeholder test
- The app's spec stays in the app repo only, not here
- Two-tab check confirmed: an old copy of a chat saves over newer messages, so the chat guard is needed
- Unverified: whether `loading_order: 1` loads before Memory Books (Phase 1)
