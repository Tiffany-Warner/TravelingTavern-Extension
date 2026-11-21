# Session Lease — Spec Outline

Plan for the two specs that replace the save guard. Source of truth for requirements: `context/decisions/session-lease-spike.md` (requirements 1–44; 12, 13, 20 and 23 are split into 31–39, 40–44 were added at outline review). Every requirement is owned by exactly one section of one spec; the other spec links to it.

## The Two Specs

| Spec | Repo | Replaces | Owns |
|---|---|---|---|
| `ext-0.2-session-lease-spec.md` | TravelingTavern-Extension | `ext-0.1-save-guard-spec.md` (superseded) | The lease itself: file formats, claim / release / park rules, the request wrapper, the web overlay, desktop behavior, the contract with the app |
| `session-lease-app-spec.md` | TravelingTavern | `fix-stale-page-overwrites-spec.md` (superseded) | Everything native: parked screen, Kotlin lease check and release, foreground / background rules, the reply foreground service, the `leaseTest` build, extension install / update |

Shared definitions (lease and release files, messages, hooks, version numbers) are written **once**, in the extension spec. The app spec references them and never restates them.

## Extension Spec: `ext-0.2-session-lease-spec.md`

1. **Purpose and rule.** One active page per SillyTavern user; nothing is overwritten without a confirmed dialog. Link the decision docs
2. **Lease and release files** *(shared contract)*: `tt-session-lease.json` (holder id, epoch, `busy`, `active` chat, `format`) and the separate release marker `tt-session-release.json` (holder, epoch, `format`), written only by the releasing holder. Who writes what, uncached reads, size. `format` number: a page that sees a format it doesn't know parks
3. **Lease writes.** One write in flight at a time (epoch-bump gap). Bounded retry: re-read; stay holder if holder and epoch are still ours; ~100–200 ms between attempts; park only if the claim changed or the lease can't be read (Windows `EPERM`). Skip unchanged writes. A failed `busy: true` write is not just metadata
4. **Claim and takeover.** Use here; grace period (1 s); waiting for `busy` (replace the polling loop or name a bounded exception); simultaneous claims (exactly one holder); reopening the same chat (startup's empty `CHAT_CHANGED` doesn't erase it); an automatic claim after a release also reopens the chat
5. **Release (desktop).** On `pagehide` only, with a `keepalive` fetch (not `sendBeacon`: the upload needs the CSRF header); marker names the exact claim and never touches the lease; a released claim's stale `busy` is ignored; refreshed holder bumps its epoch; a page restored from bfcache parks and reloads; a missing release (crash) falls back to Use here. The app's release is in app spec A5
6. **Request wrapper.** `fetch` and `XHR.send`; **exempts nothing**; requests made before the start decision wait for it; every write re-reads the lease first; reads may trust a read up to 2 s old; an allowlist of read-only endpoints (each confirmed in ST's source) skips the check **in the holder only**, a parked page still holds them; held, never refused (refusing broke startup); fail closed; WebSockets: to check
7. **Parking and reloads.** A page becomes writable only through a fresh load that holds the lease; a page that lost it never re-claims by itself. Held requests stay pending; before a reload, abort only held chat saves (clears `isChatSaving`); held reads are never aborted, so no extension sees a failed read
8. **`busy`.** Set on generation start, cleared on end; ignores dry runs; never sticks after an early generation failure. (Stale `busy` of a released claim: E5)
9. **Web overlay (desktop).** Overlay only, no toast. A `<dialog>` above ST's modal popups and loader; re-raised when a popup opens; Escape can't close it; "Finishing a reply…" while waiting; skipped inside the app
10. **Model connection after a takeover reload.** Restored in the page, or the user is told how; doesn't rely on ST's auto-connect (desktop and app; the app's native notice is A7)
11. **App contract** *(shared)*: names (table below); `leaseState` messages incl. waiting for a reply; `leaseInfo` with both versions; `useHere()` / `onForeground()` hooks; one lease instance per page (in the app's page the bundled copy runs, an installed extension stands down); CSRF: the page never passes the token, Kotlin fetches its own (A5)
12. **Version check.** `TESTED_ST_VERSIONS`, untested-server notice; re-check the allowlist on every ST release
13. **Known limits.** Accepted risks with what would close each (server plugin); Memory Books writes default files in the holder on a failed read; measured switch cost (desktop 3.3 s, phone 6.6 s, of which about 1.8 s is the lease)
14. **Tests.** Unit (pure lease logic with fake `fetch`); manual checklist on the **separate test install** only, incl. the two-page and bfcache tests

## App Spec: `session-lease-app-spec.md`

1. **Purpose.** Link the extension spec; list what the app owns
2. **Injection.** Bundled `session-lease.js` at document start (submodule, pinned tag); whether first requests are held at document start (open); the app's page always runs the current extension code, never a cached copy, and reports the running lease version (**safety**). Stand-down rule: E11
3. **Native parked state.** On every screen; full-screen scrim incl. the tab bar; closes the keyboard and clears focus; "In use on another device" + Use here; "Taking over…" / waiting for a reply on the other device
4. **Kotlin lease check.** Before every bridge command (rate-limited); refused up front while parked, never left on a held request; only truly visual commands exempt (`revealMessage`, `endReveal`); `setAppState` is checked
5. **Foreground / background.** Foreground: take over automatically only if the lease was released, else parked. Background: Kotlin writes the release over HTTP (works with JavaScript paused), with a CSRF token it fetched itself (E11), kept in memory only, never logged or stored; deferred while a reply generates (A6)
6. **Reply in the background** (decided): `shortService` foreground service while a reply generates; if Android's limit ends it first, interrupt, release, tell the user on return. A takeover never waits out the 60 s limit for a reply that can't finish. Confirm the freeze cause during implementation
7. **No model connection after a takeover:** native notice when the page reports it (mechanism: E10)
8. **Extension install / update** from the app, and the outdated-extension prompt from `leaseInfo` (carried over from the old spec, adjusted)
9. **Builds.** A dedicated `leaseTest` build type: separate application id, refuses servers other than the test install's port. Debug and release unchanged
10. **Tests.** Kotlin unit tests; manual checklist with the spike's app checks, on the test install

## Requirement Map

| # | Section | # | Section | # | Section |
|---|---|---|---|---|---|
| 1 | E6 | 15 | E5 | 29 | A3 |
| 2 | E6 | 16 | E5 | 30 | E4 |
| 3 | E7 | 17 | E5 | 31 | E6 |
| 4 | E7 | 18 | E6 | 32 | E13 |
| 5 | E6 | 19 | E8 | 33 | A2 |
| 6 | E4 | 20 | split → 36, 37 | 34 | Docs: `coding-standards.md` |
| 7 | E3 | 21 | E6 | 35 | E4 |
| 8 | E8 | 22 | E13 (done; measured cost) | 36 | E10 |
| 9 | E9 | 23 | split → 38, 39 | 37 | A7 |
| 10 | E4 | 24 | E3 | 38 | A3 |
| 11 | E6 | 25 | A6 | 39 | A4 |
| 12 | split → 31–33 | 26 | A2 | 40 | E11 |
| 13 | split → 34, 35 | 27 | A4 | 41 | E2 |
| 14 | E14 | 28 | A3 | 42 | E11 |
|  |  |  |  | 43 | A5 |
|  |  |  |  | 44 | A5 |

A10 links 14; A5 links 15 and 42; A2 links 40.

## Names (E11)

No app code uses the old names yet, so everything moves to lease vocabulary.

| Old (spec / slice only) | New |
|---|---|
| `window.__ttSaveGuard` | `window.__ttLease` (frozen, no off switch): `version`, `source`, `useHere()`, `onForeground()` |
| `.checkFresh()`, `.checkChat()`, `.pendingSaves()` | removed |
| `window.__ttGuardSource` | `window.__ttLeaseSource` |
| `window.__ttExtension { version, guardVersion }` | `window.__ttExtension { version, leaseVersion }` |
| `tt-extension-ready` | kept |
| `tt-save-guard` | `tt-lease` |
| `saveBlocked`, `staleSettings`, `staleLorebooks`, `chatSaveRefused` | removed |
| `guardInfo` | `leaseInfo { leaseVersion, extensionVersion, extensionLeaseVersion, stVersion, untestedServer }` |
| (spike) `leaseState` | kept; adds a waiting-for-reply field; no CSRF token |
| `__ttRev`, `__ttUser` | removed |
| `GUARD_VERSION` | `LEASE_VERSION` (integer the app compares) |
| `save-guard.js` | `session-lease.js` |
| `TESTED_ST_VERSIONS`, `tt-session-lease.json`, `tt-session-release.json`, `TravelingTavern-Extension`, the app's `TravelingTavern` listener and `window.__ttBridge` | kept |

## Decisions

1. Full rename to lease vocabulary (table above)
2. `LEASE_VERSION`: an integer the app compares
3. Extension `v0.2.0`. App `0.1.20` (never released: `main` is at 0.1.15)
4. `feature/save-guard` kept until the lease implementation starts; deleting it is decided then
5. Desktop parked tabs: overlay only, no toast
6. CSRF: Kotlin fetches its own token (requirement 42)

## Order of Writing

1. Extension spec sections 2 and 11 (the shared contract) first, reviewed before anything else
2. Rest of the extension spec
3. App spec
4. Cross-check against the requirement map

## Docs to Update With the Specs

- `coding-standards.md`: one-off bounded delays allowed (retry, grace), polling still not; held-not-refused rule; no exemptions in the wrapper
- `project-schema.md` and `CLAUDE.md` (extension): description, architecture, phases rewritten for the lease. Hard Rules: the names in E11
- App repo `CLAUDE.md` and `project-schema.md`: the invariant becomes "one active page per user"
- `current-feature.md` in both repos
