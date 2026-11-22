# Current Feature

## Session Lease `v0.2.0`

**Status:** `v0.2.0-rc.4` tagged (`3fab15b`: `busy` until the chat save after a reply); the app re-pins it to re-test A10 item 7 and decide D30
**Spec:** `context/specs/ext-0.2-session-lease-spec.md` (E1–E15). App side: TravelingTavern's `session-lease-app-spec.md` (A1–A10)
**Requirements and evidence:** `context/decisions/session-lease-spike.md` (R1–R44)

### Order

1. [x] Slices 1–6, each merged into `dev`
2. [x] Tag **`v0.2.0-rc.1`** on `dev`, push the tag; fixes from the app's testing tagged `v0.2.0-rc.2`, `v0.2.0-rc.3`, `v0.2.0-rc.4`
3. [ ] **In progress.** App: its feature branch pins the latest rc (`v0.2.0-rc.4`), re-tests A10 item 7 and decides D30; `0.1.20` implemented and tested against it (app spec checklist)
4. [ ] `chore/release-0.2.0`: full E14 checklist on the test install against the rc; `manifest.json` → `0.2.0`; README; history entry
5. [ ] Release PR `dev` → `main` (`Release 0.2.0`); owner merges; tag **`v0.2.0`**
6. [ ] App re-pins its submodule to `v0.2.0` before its merge
7. [ ] Owner reinstalls the extension on the real server from `main` (removed from it 2026-11-20, while `dev` carries lease code)

### Archives and cleanup (ask before each delete)

- `feature/save-guard`: tagged `archive/save-guard` (pushed); branch deleted after slice 3 (helpers ported or not needed)
- `spike/session-lease` (both repos, local): after the release, privacy check, tag `archive/spike-session-lease`, push the tag, delete the branches

### Notes

- **Per-save guard stopped** 2026-11-20 (owner decision); its spec and code are kept in the `archive/save-guard` tag
- Desktop notices: `tt-lease` carries `{ type, ...fields }` (`leaseState`, `leaseInfo`, `leaseNotice`); the app gets `leaseNotice` too (E11, A7)

## History

### 2026-11-22 — `busy` until the chat save after a reply (for `v0.2.0-rc.4`)
- The app's slice 10 lost a finished reply: `busy: false` went out when the response ended, the claim landed 205 ms later, and ST's chat save (0.2–1.1 s after the end, later on a hidden page) hit the new pair and was held
- Fix: after the last reply ends, `busy` stays true until a chat save that started after that end has completed (any status), at most 3 s (then a warning). Not when no longer holder; the headers fallback is unchanged. E15: impersonate saves; errors and `quiet` don't; ST's save wait has no immediate check and can skip the save on a hidden page (E13)
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install with the mock model: three takeovers during a reply, each reply on disk 8–20 ms before `busy: false`, the claim 0.4–0.7 s after it; Stop (saved, then cleared); a failed generation (cleared at 3 s, one warning)
- Unverified: a hidden holder tab (Claude in Chrome kept its tabs `visible` even while minimized), the app (A10 item 7 after the re-pin). `LEASE_VERSION` 1 (owner's pre-release exception, decided again at `v0.2.0`)

### 2026-11-21 — `onForeground` always reports `leaseState` (for `v0.2.0-rc.3`)
- The app's Kotlin pre-check (A4) parks its own scrim on an unreadable or mismatched read and calls `onForeground()` for the page to confirm; a page still holder with an unchanged lease posted nothing (`report()` skips repeats), so the scrim stayed up until a Use here tap timed out
- Fix: `onForeground` re-posts the current `leaseState` when the call itself posted nothing (holder and parked alike; not when a claim's reload follows), so a bump or a park still posts exactly once. E11 states it
- Unverified: the app (needs a rebuild with this code). `LEASE_VERSION` 1 (owner decision: stays until the release)

### 2026-11-21 — ST hooks attach in the app's page (for `v0.2.0-rc.2`)
- In the app's page the lease's `load` listener ran before `script.js` resumed from its `load` wait, so `getContext()` threw a `ReferenceError` (temporal dead zone) and the hooks never attached: no `connected`, no reopen / reconnect after a takeover, no `active` from `CHAT_CHANGED`. Lease safety unaffected; desktop unaffected (the extension loads later)
- Fix: a `load` attach that can't read the context retries once, one task later (`setTimeout(0)`), then warns as before. Added to the bounded delays (spec E2, E10, `coding-standards.md`); E10, E11 and E15 now state the timing (confirmed in 1.19.1's `script.js`: one top-level `await`)
- Found by the app's slice 3; unverified: the app (needs a rebuild with this code). `LEASE_VERSION` 1

Older entries: `context/history.md`
