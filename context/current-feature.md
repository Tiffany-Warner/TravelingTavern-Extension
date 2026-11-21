# Current Feature

## Session Lease `v0.2.0`

**Status:** Slices 1–4 and the `freeze` release fix merged into `dev`; slice 5 (`feature/lease-busy`) pushed for review
**Spec:** `context/specs/ext-0.2-session-lease-spec.md` (E1–E14). App side: TravelingTavern's `session-lease-app-spec.md` (A1–A10)
**Requirements and evidence:** `context/decisions/session-lease-spike.md` (R1–R44)

### Goals

Build the lease from the spec in slices, each branched from `dev` with its own unit tests and manual checks on the **separate test install**. Tag `v0.2.0-rc.1` for the app, then release `v0.2.0` once both checklists pass.

### Before slice 3 merges

- [x] **Owner: remove the extension from the SillyTavern in daily use** (done 2026-11-20) (it's on `dev`). From slice 3 on, `dev` carries lease code, and `dev` must never reach that install. Reinstall from `main` after `v0.2.0`

### Slices

Each slice: `node --test` passes; manual checks run on the test install only. `LEASE_VERSION` stays `1` until the release.

| # | Branch | Spec | Scope | Unit tests | Manual checks (test install) |
|---|---|---|---|---|---|
| 1 | `feature/lease-core` | E2, E3 | `session-lease.js` skeleton (IIFE, constants, `LEASE_VERSION`, Node export); `createSessionLease`; reading the files (404 vs unreadable, fields, `format`), released check, pair rule; write queue (one in flight), bounded retry, skip unchanged, pending `busy: false` | `files`, `pair-rule`, `writes` | None |
| 2 | `feature/lease-claim` | E4 (claim, start decision), E5 (decisions) | Claim (busy wait ≤ 60 s, grace, verify, `lostRace`); start decision (own id → epoch bump, automatic claim once per tab); reopen flag; release marker; back/forward-cache decision | `claim`, `start-decision`, `release` | None |
| 3 | `feature/lease-wrapper` | E6, E7, E11, E5 wiring | `install()`: `fetch`, XHR and `sendBeacon` wrappers; held requests; wait for the start decision; 2 s read window; allowlist; abort only held chat saves; frozen `window.__ttLease`, one instance per page; `leaseState` / `leaseInfo` / `leaseNotice` and `tt-lease` with `type`; `pagehide` / `pageshow`; `onForeground`; `TESTED_ST_VERSIONS` and the `/version` read (allowlist on/off, `leaseInfo`). Minimal `index.js` (`__ttLeaseSource`, `__ttExtension`, `tt-extension-ready`, loads the lease with a `<script>` element). Helpers copied from `archive/save-guard`. **Research first:** allowlist and chat-save paths in ST 1.19.0 / 1.19.1; WebSockets (R31); where lease writes get ST's CSRF header before ST's context exists (app, document start): check first whether the page can fetch `/csrf-token` itself through the original `fetch`, as Kotlin does (ST returns the session's existing token) | `wrapper`, `messages`, `instance` | Two-page test (stale chat, persona, card, lorebook, settings saves never arrive); Use here and two at once (from the console); holder refresh and duplicated tab; close the holder / an old tab; back/forward cache; no "Leave site?"; Memory Books' held reads; server unreachable; `EPERM` retry; unknown `format` |
| 4 | `feature/lease-overlay` | E9, E12 | Overlay and its styles in `index.js`, re-raised over ST popups; toasts from `leaseInfo` (untested ST version) and `leaseNotice` | version check (in `wrapper`) | Overlay design, light and dark theme; reduced motion; popup before / after parking; two simultaneous Use here with the buttons; untested-version toast (list narrowed locally, uncommitted) |
| 5 | `feature/lease-busy` | E8 | Generation requests held until `busy: true` is confirmed; `AbortError` + `leaseNotice` `replyNotStarted` on failure; `busy: false` only when the response is over; overlapping generations. **Research first:** generation endpoints in ST's source | `busy` | Takeover while generating; no model connected: no stuck `busy`; Stop mid-stream clears `busy`; save queued just before a takeover |
| 6 | `feature/lease-reopen` | E4 (reopen, `active`), E10 | `active` on `CHAT_CHANGED`; reopen after `APP_READY`; reconnect once after Use here only; `connected`; `leaseNotice` `notConnected`. All through `SillyTavern.getContext()`, no module imports (classic script). **Research first:** confirm the context functions and connect buttons (the (verify) items) in ST 1.19.0 / 1.19.1 | `reopen`, `connect` | Use here reopens the same chat (character and group), switch time recorded; deleted character → start screen; reconnect after Use here, not after the automatic claim |

### Fix before slice 5: release on `freeze` (`fix/lease-freeze-release`)

An idle background holder tab closed without a release marker, twice (likely Chrome freezing, then discarding it: a discarded tab never fires `pagehide`). E5: a holder also releases on the Page Lifecycle `freeze`; on `resume` it runs the app's foreground holder check (unchanged pair → bump the epoch, verify, holder again without a reload; changed → `lost`; unreadable → `unreadable`; requests wait for it). E7 notes this one exception to "writable only through a fresh load". The back/forward cache keeps park-and-reload. Desktop only. E13 row updated. Unit tests in `release` and `instance`; manual check with `chrome://discards` (freeze, then discard, the holder).

### Order

1. [ ] Slices 1–6, each merged into `dev` (1–4 done)
2. [ ] Tag **`v0.2.0-rc.1`** on `dev`, push the tag
3. [ ] App: its feature branch pins `v0.2.0-rc.1`; `0.1.20` implemented and tested against it (app spec checklist)
4. [ ] `chore/release-0.2.0`: full E14 checklist on the test install against the rc; `manifest.json` → `0.2.0`; README; history entry
5. [ ] Release PR `dev` → `main` (`Release 0.2.0`); owner merges; tag **`v0.2.0`**
6. [ ] App re-pins its submodule to `v0.2.0` before its merge
7. [ ] Owner reinstalls the extension in daily use from `main`

### Archives and cleanup (ask before each delete)

- `feature/save-guard`: tagged `archive/save-guard` (pushed); branch deleted after slice 3 (helpers ported or not needed)
- `spike/session-lease` (both repos, local): after the release, privacy check, tag `archive/spike-session-lease`, push the tag, delete the branches

### Notes

- **Per-save guard stopped** 2026-11-20 (owner decision). `ext-0.1-save-guard-spec.md` is marked superseded and kept for its source findings
- Desktop notices: `tt-lease` carries `{ type, ...fields }` (`leaseState`, `leaseInfo`, `leaseNotice`); the app gets `leaseNotice` too (E11, A7)
- The TravelingTavern app is blocked on `v0.2.0-rc.1`

## History

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
- Incident: an upload exemption let a parked tab, and later the cleanup, overwrite two real Memory Books files. Testing now only on a separate install
- Unverified: part 2 (app), WebSockets, per-request check cost from the phone

### 2026-11-20 — Project setup
- Added `CLAUDE.md`, context files, the v0.1 save guard spec, `manifest.json` (`0.0.1`), a placeholder `index.js`, `package.json` (test script only) and a placeholder test
- The app's spec stays in the app repo only, not here
- Two-tab check confirmed: an old copy of a chat saves over newer messages, so the chat guard is needed
- Unverified: whether `loading_order: 1` loads before Memory Books (Phase 1)
