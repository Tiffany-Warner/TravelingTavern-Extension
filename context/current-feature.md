# Current Feature

## Session Lease `v0.2.0`

**Status:** `v0.2.0-rc.3` tagged (rc.2: ST hooks in the app's page; rc.3: `onForeground` always reports); the app builds against it (slice 10). Next: `v0.2.0-rc.4` (`busy` until the chat save after a reply, `fix/busy-until-chat-save`) for the app's re-pin
**Spec:** `context/specs/ext-0.2-session-lease-spec.md` (E1–E15). App side: TravelingTavern's `session-lease-app-spec.md` (A1–A10)
**Requirements and evidence:** `context/decisions/session-lease-spike.md` (R1–R44)

### Order

1. [x] Slices 1–6, each merged into `dev`
2. [x] Tag **`v0.2.0-rc.1`** on `dev`, push the tag (fixes from the app's testing: `v0.2.0-rc.2`, `v0.2.0-rc.3`; `v0.2.0-rc.4` pending: `busy` until the chat save)
3. [ ] App: its feature branch pins the latest rc (`v0.2.0-rc.3`, then `v0.2.0-rc.4` and re-tests A10 item 7, decides D30); `0.1.20` implemented and tested against it (app spec checklist); in progress, at slice 10
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
- The TravelingTavern app re-pinned to `v0.2.0-rc.3` before its slice 8; rc.2 and rc.3 can only be verified there (the ST hooks attach; Kotlin's scrim clears when `onForeground()` re-posts `leaseState`)

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

### 2026-11-21 — Session lease slice 6: reopen and reconnect after a takeover
- After a claim's reload the holder reopens the lease's character chat through `SillyTavern.getContext()` (select, then open the chat only if the selection happened); `CHAT_CHANGED` records `active`, not while a reopen is pending. After Use here / onForeground only, a page with `no_connection` presses ST's connect button once (not while ST is already connecting), then `notConnected` after `ONLINE_STATUS_CHANGED` or a 10 s wait; `leaseState.connected` tracks ST
- Groups stay on the start screen (owner decision: ST's context can't select a group; the app reopens groups by its `chatFile` route). E13: Auto-load can win the race, a chat deleted outside ST is started again empty, the Custom source bypasses its status check
- Gotchas: Claude in Chrome's console log repeats a page's lines when it switches back to that tab (no second load); a Text Completion type on the test install held a real saved key, removed
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install (character reopen, group and deleted character → start screen, automatic claim, Auto-load on, reconnect, `notConnected` toast); switch time about 4–5 s (rough, whole-second timestamps); unverified: Auto-load with a different chat, the app. `LEASE_VERSION` 1

### 2026-11-21 — Session lease slice 5: `busy` from generation requests
- Generation requests (`/api/backends/*/generate`, NovelAI, Horde text) are sent only after `busy: true` is confirmed; overlapping replies share it; `busy: false` once the last response is over (body read, closed, error or Stop, never at the headers). A `busy: true` that can't be written rejects the request with `AbortError` and `leaseNotice` `replyNotStarted`. Endpoints and ST's full body reads confirmed in 1.19.0 / 1.19.1
- Review fixes: a `busy` write queued behind the page's own epoch bump parked the holder as `lost`; it now retries once with the newer pair. Bumps on resume and in the app's foreground write `busy` from the page's own replies (a stale `busy: true` survived a freeze)
- Horde replies are asynchronous (submit, then polls), so `busy` covers only the submit: an E13 known limit
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install with a local mock model (streamed reply, Stop, no model, takeover while generating, save queued before a takeover); unverified: real backends (incl. NovelAI, Kobold, Horde), the `Response` rebuild fallback, the app. `LEASE_VERSION` 1

### 2026-11-21 — Lease release on `freeze`; resume checks the pair
- A desktop holder also releases on the Page Lifecycle `freeze` (a frozen tab may be discarded, which fires no `pagehide`). On `resume` it runs the app's foreground holder check: unchanged pair → bump, verify, holder again without a reload; changed → `lost`; unreadable → `unreadable`; requests wait for it. Back/forward cache keeps park-and-reload
- Cause: an idle background holder tab closed without a marker, twice. A reload on every resume was rejected (Chrome freezes background tabs routinely; unsent text would be lost); E7 notes the one exception to "writable only through a fresh load"
- Gotchas: `chrome://discards` greyed out Proactive Discard for the frozen tab, only Urgent Discard worked; a page's own `fetch` is held once it released (use the files on disk to check)
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install (freeze, resume, freeze + urgent discard, next tab claims, the `lost` case); unverified: proactive discards (may skip `freeze`, E13). `LEASE_VERSION` 1

### 2026-11-21 — Session lease slice 4: overlay and toasts
- `index.js`: modal `<dialog>` card from `leaseState` (texts per reason, Use here / Reload / spinner), ST theme variables, re-raised over ST popups, Escape can't close it; toasts from `leaseInfo` (untested ST version, once per version via `localStorage`, holder only) and `leaseNotice`, no title
- Button: accent fill and border from `--SmartThemeQuoteColor`; outranks ST's own `menu_button` focus fill; the card takes the focus after `showModal()` (Chrome ignores `autofocus` on the dialog). Spinner also stops under ST's Reduced Motion
- Gotchas: an idle background holder tab closed without a release marker, twice (likely frozen, then discarded: no `pagehide`); fix next on `fix/lease-freeze-release`
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install (dark and light theme, reduced motion, popups before / after parking, two simultaneous Use here, untested-version toast); unverified: hover by mouse, `prefers-reduced-motion` from the OS. `LEASE_VERSION` 1

### 2026-11-20 — Session lease slice 3: request wrapper and app contract
- `install()`: `fetch` / XHR / `sendBeacon` wrappers (held, never refused; held fetches reject on their own abort), allowlist confirmed in ST source minus `backgrounds/all`, own CSRF token with ST's `/csrf-token` ordered after it, `window.__ttLease` + `onForeground`, `leaseState` / `leaseInfo`, `tt-lease` with `type`, no install on `/login`; minimal `index.js` loader. Slices 1–2 (files, writes, claim, start decision, release) merged before it
- Fixed after the test-install run: the takeover reload waits one task after aborting chat saves (`beforeunload` cancelled it on a clicked page), `reloadPending` if it still doesn't happen; lease checks read through the write queue
- Gotchas: a stale holder's `pagehide` marker can overwrite the real holder's (E13, costs a click); ST's quick-reply hook times out in parked pages; `EPERM` retried as designed
- Verified against SillyTavern 1.19.1 in Chrome on the separate test install (full slice 3 checklist incl. forced `EPERM`); unverified: a write at the exact back/forward-cache restore, Chrome's real Duplicate (simulated), the app. `LEASE_VERSION` 1

<!-- One entry per completed feature / fix, 3–5 lines max: what changed, cause/key decisions, gotchas, what's unverified, version. No verification logs or test counts. Nothing private. -->

### 2026-11-20 — Session-lease spike, part 2 (app)
- App spike as a separate `.spike` app on the Pixel 8 over Tailscale, against the separate test install: the page reports its lease state; Kotlin shows a native parked screen, checks the lease before each bridge command and writes the background release itself
- Lease holds between the app and desktop in every case tested, incl. takeovers during a reply, a release with JavaScript paused and a killed app. Phone switch 6.6 s, about 1.8 s of it the lease
- Gotchas: a reply stalls in the background, likely because Android freezes the WebView's renderer about 20 s after Home (to confirm; fix decided: `shortService` foreground service); the first load after an extension update ran cached code; `setAppState` isn't visual
- Unverified: WebSockets; document-start holding not built

### 2026-11-20 — Session-lease spike, part 1 (desktop)
- Per-save guard stopped for a session lease ("Use here"); spike against SillyTavern 1.19.0 in Chrome. Lease protects every data type tested; held (not refused) requests keep a parked tab quiet; switch to the reopened chat takes about 3.5 s with a 1 s grace
- Gotchas: ST popups are modal (re-raise the overlay); dry runs fire `GENERATION_STARTED`; held chat saves block reloads via `beforeunload`; Windows `EPERM` on lease writes falsely parks the holder
- Incident: an upload exemption let a parked tab, and later the cleanup, overwrite two real Memory Books files. Testing now only on the test install
- Unverified: part 2 (app), WebSockets, per-request check cost from the phone

### 2026-11-20 — Project setup
- Added `CLAUDE.md`, context files, the v0.1 save guard spec, `manifest.json` (`0.0.1`), a placeholder `index.js`, `package.json` (test script only) and a placeholder test
- The app's spec stays in the app repo only, not here
- Two-tab check confirmed: an old copy of a chat saves over newer messages, so the chat guard is needed
- Unverified: whether `loading_order: 1` loads before Memory Books (Phase 1)
