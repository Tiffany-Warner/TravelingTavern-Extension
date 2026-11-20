# Current Feature

## Project Setup

**Status:** In progress
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
