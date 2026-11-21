# Current Feature

## Session-Lease Spike

**Status:** Part 1 (desktop) done; part 2 (app) next, on a separate test install
**Branch:** `spike/session-lease` (from `dev`; local, throwaway, never merges)
**Plan:** `context/decisions/direction-change.md` (Spike section). Background: `context/decisions/architecture-assessment.md`
**Results:** `context/decisions/session-lease-spike.md` (results, incident, verdict, requirements for the spec)

### Goals

Prove or disprove that one active SillyTavern page at a time ("Use here" session lease) is safe and tolerable in real ST. Report each checklist item pass / fail before any spec or app change.

### Next, in order

1. [ ] **Separate SillyTavern test install** (user is setting it up): own folder, data and port. Every manual test, spike and cleanup runs there; no unreleased guard or lease code in the install in daily use
2. [ ] **Three fixes on `spike/session-lease`:**
    - the wrapper exempts nothing (lease I/O uses the original `fetch`)
    - before a reload, abort only held chat saves; leave held reads pending
    - bounded lease-write retry, so the holder doesn't falsely park during part 2: on a failed write, re-read the lease; if holder and epoch are still ours, stay holder and retry after ~100–200 ms; park only if the claim changed or the lease can't be read

    Then re-run the affected part 1 checks on the test install
3. [ ] **Part 2 (the app) on the test install:** hold first requests at document start, foreground takeover, park while the desktop holds the lease, release in the background
4. [ ] **Spec** from the requirements in `session-lease-spike.md`, with `coding-standards.md` updated for one-off delays

### Notes

- **Per-save guard stopped** 2026-11-20 (owner decision). `ext-0.1-save-guard-spec.md` is marked superseded and kept for its source findings. Slice 1 (core + settings) is on `feature/save-guard` (`wip`, pushed, not merged), kept for the fallback
- The TravelingTavern app is blocked on the spike's result
- `project-schema.md` and `CLAUDE.md` still describe the per-save guard (only `CLAUDE.md`'s test hard rule and a pointer at its top changed); both revised with the spec

## History

<!-- One entry per completed feature / fix, 3–5 lines max: what changed, cause/key decisions, gotchas, what's unverified, version. No verification logs or test counts. Nothing private. -->

### 2026-11-20 — Session-lease spike, part 1 (desktop)
- Per-save guard stopped for a session lease ("Use here"); spike against SillyTavern 1.19.0 in Chrome. Lease protects every data type tested; held (not refused) requests keep a parked tab quiet; switch to the reopened chat takes about 3.5 s with a 1 s grace
- Gotchas: ST popups are modal (re-raise the overlay); dry runs fire `GENERATION_STARTED`; held chat saves block reloads via `beforeunload`; Windows `EPERM` on lease writes falsely parks the holder
- Incident: an upload exemption let a parked tab, and later the cleanup, overwrite two real Memory Books files. Testing now only on a separate install
- Unverified: part 2 (app), WebSockets, per-request check cost from the phone

### 2026-11-20 — Project setup
- Added `CLAUDE.md`, context files, the v0.1 save guard spec, `manifest.json` (`0.0.1`), a placeholder `index.js`, `package.json` (test script only) and a placeholder test
- The app's spec stays in the app repo only, not here
- Two-tab check confirmed: an old copy of a chat saves over newer messages, so the chat guard is needed
- Unverified: whether `loading_order: 1` loads before Memory Books (Phase 1)
