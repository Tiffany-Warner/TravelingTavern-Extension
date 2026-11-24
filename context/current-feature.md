# Current Feature

## Session Lease `v0.2.0`

**Status:** `chore/release-0.2.0`: E14 complete (rc.4, rc.5 re-runs), README, version `0.2.0`; next the release PR `dev` → `main` and the `v0.2.0` tag
**Spec:** `context/specs/ext-0.2-session-lease-spec.md` (E1–E15). App side: TravelingTavern's `session-lease-app-spec.md` (A1–A10)
**Requirements and evidence:** `context/decisions/session-lease-spike.md` (R1–R44)

### Order

1. [x] Slices 1–6, each merged into `dev`
2. [x] Tag **`v0.2.0-rc.1`** on `dev`, push the tag; fixes from the app's testing tagged `v0.2.0-rc.2`, `v0.2.0-rc.3`, `v0.2.0-rc.4`
3. [x] `fix/never-stuck` → `v0.2.0-rc.5`: every parked state has a way out (Refresh, Take over anyway, Turn off protection), prerender fix; E14 re-runs on it (`TravelingTavern-docs/release-0.2.0-e14-results.md`)
4. [x] App: its feature branch re-pins `v0.2.0-rc.5`, adds the new actions to its scrim, re-tests A10 item 7 and decides D30; `0.1.20` implemented and tested against it (app spec checklist). D30 decided at the app's rc.4 re-pin (app spec D44); rc.5 scrim actions built and tested (app `831568f`)
5. [x] `chore/release-0.2.0`: E14 complete (on rc.4, rc.5 re-runs); README; `manifest.json` and `EXTENSION_VERSION` → `0.2.0`, `LEASE_VERSION` kept at 1 (owner: first release); history entry
6. [ ] **Next.** Release PR `dev` → `main` (`Release 0.2.0`: `manifest.json` + `EXTENSION_VERSION` `0.2.0`, `LEASE_VERSION` 1, AGPL-3.0-only from this release); owner merges with a merge commit; tag **`v0.2.0`**
7. [ ] App re-pins its submodule to `v0.2.0` before its merge
8. [ ] Owner reinstalls the extension on the real server from `main` (removed from it 2026-11-20, while `dev` carries lease code)

### Archives and cleanup (ask before each delete)

- `feature/save-guard`: tagged `archive/save-guard` (pushed); branch deleted after slice 3 (helpers ported or not needed)
- `spike/session-lease` (both repos, local): after the release, privacy check, tag `archive/spike-session-lease`, push the tag, delete the branches

### Notes

- **Per-save guard stopped** 2026-11-20 (owner decision); its spec and code are kept in the `archive/save-guard` tag
- Desktop notices: `tt-lease` carries `{ type, ...fields }` (`leaseState`, `leaseInfo`, `leaseNotice`); the app gets `leaseNotice` too (E11, A7)

## History

### 2026-11-23 — Release 0.2.0: E14 complete, README, version
- E14 run on `v0.2.0-rc.4`; the items rc.5 touched (2, 3, 4 incl. a background holder, 6, 7, 8, 13–18) and its new checks (damaged, unknown format, failing writes, Take over anyway during a reply, Turn off protection, unreachable and hung server) re-run on `v0.2.0-rc.5`; the rest carried over (wrapper and file handling unchanged). Results outside the repo. The app: A10 against rc.4, its scrim actions against rc.5
- README rewritten: what it does and why, install (per ST user on the server), the overlay and the ways out with three screenshots from the test install, toasts, the app, limits in plain words, bug reports, technical details. E13 gained two rows found in the run (a tab closed mid-claim leaves no marker; closing a parked tab with a held chat save shows ST's "Leave site?")
- `manifest.json` and `EXTENSION_VERSION` `0.2.0`; `LEASE_VERSION` 1, `format` 1 (owner: first release). No code change
- Unverified: a real Chrome prerender (never reproduced; unit-tested); Chrome's proactive discards (E13)

### 2026-11-23 — Never stuck: a way out of every parked state (for `v0.2.0-rc.5`)
- A corrupt lease file, writes that keep failing, a lease-code error and `unknownFormat` parked with no working way out, and "Finishing a reply…" had no skip. Now every error state has **Refresh**, plus **Take over anyway** (a forced claim over whatever the file holds: new holder id, marker repaired, grace and verify) and **Turn off protection** (this tab only, a `sessionStorage` flag, the lease stands down after a reload; banner with Turn protection back on). Take over anyway also joins "Finishing a reply…" after 10 s. Always a tap after an in-card warning
- New reasons `damaged` (2xx but invalid, vs `unreadable` = can't reach ST) and `error` (claim / bump writes exhausted, lease-code errors); `leaseState.actions` and `state: 'off'`; `__ttLease.takeOverAnyway / turnOffProtection / turnProtectionOn / refresh` (owner-approved E11). A prerendered page never decides and reloads when shown (same-tab prerender could have held with stale data). `__ttLease` is defined before the wrapper. Every lease read / write is aborted after 10 s and counts as "can't reach" (owner decision), so no state waits on a hung server
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install with the mock model: each new card and button, the warning steps, a forced claim on damaged / unknown-format / busy leases, off mode across a refresh and back on, the E14 re-runs (incl. a background holder and a duplicated tab by hand). A forced claim with ST down first showed `error`; fixed to stay `unreadable`. Review: the one-load `window.name` off mark counts only on a reload without working storage (another site can name a window it opens)
- Unverified: a real Chrome prerender (Chrome didn't prerender under automation or in two typed tries); the app (needs its scrim buttons). `LEASE_VERSION` 1 (owner's pre-release exception)

### 2026-11-22 — Relicense to AGPL-3.0-only
- `LICENSE` is now the unmodified GNU AGPL v3 text, `package.json` says `AGPL-3.0-only`, README and `coding-standards.md` got a License section; same license as SillyTavern. `manifest.json` unchanged (ST manifests have no license field)
- Commits before this one, including the `v0.2.0-rc.*` tags, stay Apache 2.0. `main` and GitHub's sidebar show Apache 2.0 until the `v0.2.0` release PR; the app picks it up when it re-pins to `v0.2.0`
- No code changed: no version bump, `LEASE_VERSION` 1

Older entries: `context/history.md`
