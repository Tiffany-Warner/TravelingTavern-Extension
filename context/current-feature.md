# Current Feature

## Phase 1 — Save Guard (`v0.1.0`)

**Status:** In progress
**Branch:** `feature/save-guard`
**Spec:** `context/specs/ext-0.1-save-guard-spec.md`

### Goals

No SillyTavern page can save a stale copy of settings, a lorebook, a chat or a character card over newer data. Built in slices, each tested before the next:

1. [x] Guard core + settings (unit-tested; checked in ST once `index.js` loads it): `fetch` / XHR wrappers, queue, `conditionalWrite`, canonical JSON + pure-JS hash, gzip bodies, reporting, frozen API; settings fingerprint, no-change saves not sent, `hadChanges`, rate-limited freshness check
2. [ ] Lorebooks: revision stamp, add-only re-apply, rename protection, `__ttUser`
3. [ ] Chats: quick check, stale-chat freeze (generation + lorebook saves refused), `force`, `integrity`
4. [ ] Characters: chat-only saves → `merge-attributes`, stale card edits blocked
5. [ ] `checkFresh` / `checkChat`, late-start seeding, ST version check, `guardInfo`
6. [ ] `index.js`: desktop toasts, focus checks, panel line, `tt-extension-ready`
7. [ ] Manual checklist incl. two-page tests

### Notes

- Verified in ST 1.19.0 source: compressed request bodies carry `Content-Encoding: gzip` (`request-compression.js`, used for settings and chat saves). `/api/settings/save` answers `{ result: 'ok' }`, but on a write error still answers 200 with the error object, so success = `result === 'ok'`. ST's requests carry `X-CSRF-Token`; the guard's own reads reuse it
- App channel: `window.TravelingTavern.postMessage(JSON.stringify({ v, type, ... }))`, same as `bridge.js`
- `NOISY_SETTINGS_PATHS` starts empty (fill on the emulator)
- A save body the guard can't read (bad gzip, stream, invalid JSON) and a guard error are blocked and reported as `reason: "unreachable"`, so the message vocabulary doesn't change
- Endpoints match by path suffix, lower-cased, trailing slash ignored (Express routes the same way); the prefix is reused for the guard's own reads, so ST behind a subpath still works
- XHR `send` to a save URL throws `NetworkError`

## History

<!-- One entry per completed feature / fix, 3–5 lines max: what changed, cause/key decisions, gotchas, what's unverified, version. No verification logs or test counts. Nothing private. -->

### 2026-11-20 — Project setup
- Added `CLAUDE.md`, context files, the v0.1 save guard spec, `manifest.json` (`0.0.1`), a placeholder `index.js`, `package.json` (test script only) and a placeholder test
- The app's spec stays in the app repo only, not here
- Two-tab check confirmed: an old copy of a chat saves over newer messages, so the chat guard is needed
- Unverified: whether `loading_order: 1` loads before Memory Books (Phase 1)
