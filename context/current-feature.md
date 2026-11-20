# Current Feature

## Session-Lease Spike

**Status:** Next
**Branch:** `spike/session-lease` (from `dev`; throwaway, never merges)
**Plan:** `context/decisions/direction-change.md` (Spike section). Background: `context/decisions/architecture-assessment.md`

### Goals

Prove or disprove that one active SillyTavern page at a time ("Use here" session lease) is safe and tolerable in real ST. Report each checklist item pass / fail before any spec or app change.

### Notes

- **Per-save guard stopped** 2026-11-20 (owner decision). `ext-0.1-save-guard-spec.md` is marked superseded and kept for its source findings. Slice 1 (core + settings) is on `feature/save-guard` (`wip`, pushed, not merged), kept for the fallback
- The TravelingTavern app is blocked on the spike's result
- `project-schema.md` and `CLAUDE.md` still describe the guard; revised after the spike

## History

<!-- One entry per completed feature / fix, 3–5 lines max: what changed, cause/key decisions, gotchas, what's unverified, version. No verification logs or test counts. Nothing private. -->

### 2026-11-20 — Project setup
- Added `CLAUDE.md`, context files, the v0.1 save guard spec, `manifest.json` (`0.0.1`), a placeholder `index.js`, `package.json` (test script only) and a placeholder test
- The app's spec stays in the app repo only, not here
- Two-tab check confirmed: an old copy of a chat saves over newer messages, so the chat guard is needed
- Unverified: whether `loading_order: 1` loads before Memory Books (Phase 1)
