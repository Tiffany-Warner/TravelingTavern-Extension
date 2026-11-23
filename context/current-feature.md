# Current Feature

## Session Lease `v0.2.0`

**Status:** `fix/never-stuck` (way out of every parked state, prerender fix) built and tested on the test install; to be tagged `v0.2.0-rc.5`, then the app re-pins it and adds the buttons to its scrim
**Spec:** `context/specs/ext-0.2-session-lease-spec.md` (E1–E15). App side: TravelingTavern's `session-lease-app-spec.md` (A1–A10)
**Requirements and evidence:** `context/decisions/session-lease-spike.md` (R1–R44)

### Order

1. [x] Slices 1–6, each merged into `dev`
2. [x] Tag **`v0.2.0-rc.1`** on `dev`, push the tag; fixes from the app's testing tagged `v0.2.0-rc.2`, `v0.2.0-rc.3`, `v0.2.0-rc.4`
3. [ ] **In progress. `fix/never-stuck` → `v0.2.0-rc.5`**: every parked state has a way out (Refresh, Take over anyway, Turn off protection), prerender fix; E14 re-runs on it (`TravelingTavern-docs/release-0.2.0-e14-results.md`)
4. [ ] App: its feature branch re-pins `v0.2.0-rc.5`, adds the new actions to its scrim, re-tests A10 item 7 and decides D30; `0.1.20` implemented and tested against it (app spec checklist)
5. [ ] `chore/release-0.2.0` resumes at Part 2 (its E14 run completes with the rc.5 re-runs); `manifest.json` → `0.2.0`; README; history entry
6. [ ] Release PR `dev` → `main` (`Release 0.2.0`); owner merges; tag **`v0.2.0`**
7. [ ] App re-pins its submodule to `v0.2.0` before its merge
8. [ ] Owner reinstalls the extension on the real server from `main` (removed from it 2026-11-20, while `dev` carries lease code)

### Archives and cleanup (ask before each delete)

- `feature/save-guard`: tagged `archive/save-guard` (pushed); branch deleted after slice 3 (helpers ported or not needed)
- `spike/session-lease` (both repos, local): after the release, privacy check, tag `archive/spike-session-lease`, push the tag, delete the branches

### Notes

- **Per-save guard stopped** 2026-11-20 (owner decision); its spec and code are kept in the `archive/save-guard` tag
- Desktop notices: `tt-lease` carries `{ type, ...fields }` (`leaseState`, `leaseInfo`, `leaseNotice`); the app gets `leaseNotice` too (E11, A7)

## History

### 2026-11-23 — Never stuck: a way out of every parked state (for `v0.2.0-rc.5`)
- A corrupt lease file, writes that keep failing, a lease-code error and `unknownFormat` parked with no working way out, and "Finishing a reply…" had no skip. Now every error state has **Refresh**, plus **Take over anyway** (a forced claim over whatever the file holds: new holder id, marker repaired, grace and verify) and **Turn off protection** (this tab only, a `sessionStorage` flag, the lease stands down after a reload; banner with Turn protection back on). Take over anyway also joins "Finishing a reply…" after 10 s. Always a tap after an in-card warning
- New reasons `damaged` (2xx but invalid, vs `unreadable` = can't reach ST) and `error` (claim / bump writes exhausted, lease-code errors); `leaseState.actions` and `state: 'off'`; `__ttLease.takeOverAnyway / turnOffProtection / turnProtectionOn / refresh` (owner-approved E11). A prerendered page never decides and reloads when shown (same-tab prerender could have held with stale data). `__ttLease` is defined before the wrapper. Every lease read / write is aborted after 10 s and counts as "can't reach" (owner decision), so no state waits on a hung server
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install with the mock model: each new card and button, the warning steps, a forced claim on damaged / unknown-format / busy leases, off mode across a refresh and back on, the E14 re-runs (incl. a background holder and a duplicated tab by hand). A forced claim with ST down first showed `error`; fixed to stay `unreadable`. Review: the one-load `window.name` off mark counts only on a reload without working storage (another site can name a window it opens)
- Unverified: a real Chrome prerender (Chrome didn't prerender under automation or in two typed tries); the app (needs its scrim buttons). `LEASE_VERSION` 1 (owner's pre-release exception)

### 2026-11-22 — Relicense to AGPL-3.0-only
- `LICENSE` is now the unmodified GNU AGPL v3 text, `package.json` says `AGPL-3.0-only`, README and `coding-standards.md` got a License section; same license as SillyTavern. `manifest.json` unchanged (ST manifests have no license field)
- Commits before this one, including the `v0.2.0-rc.*` tags, stay Apache 2.0. `main` and GitHub's sidebar show Apache 2.0 until the `v0.2.0` release PR; the app picks it up when it re-pins to `v0.2.0`
- No code changed: no version bump, `LEASE_VERSION` 1

### 2026-11-22 — `busy` until the chat save after a reply (for `v0.2.0-rc.4`)
- The app's slice 10 lost a finished reply: `busy: false` went out when the response ended, the claim landed 205 ms later, and ST's chat save (0.2–1.1 s after the end, later on a hidden page) hit the new pair and was held
- Fix: after the last reply ends, `busy` stays true until a chat save that started after that end has completed (any status), at most 3 s (then a warning). Not when no longer holder; the headers fallback is unchanged. E15: impersonate saves; errors and `quiet` don't; ST's save wait has no immediate check and can skip the save on a hidden page (E13)
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install with the mock model: three takeovers during a reply, each reply on disk 8–20 ms before `busy: false`, the claim 0.4–0.7 s after it; Stop (saved, then cleared); a failed generation (cleared at 3 s, one warning)
- Unverified: a hidden holder tab (Claude in Chrome kept its tabs `visible` even while minimized), the app (A10 item 7 after the re-pin). `LEASE_VERSION` 1 (owner's pre-release exception, decided again at `v0.2.0`)

Older entries: `context/history.md`
