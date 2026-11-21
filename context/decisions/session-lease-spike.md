# Session-Lease Spike: Results

2026-11-20. Spike from `direction-change.md`, part 1 (desktop) only. Run against SillyTavern 1.19.0 in desktop Chrome, two to four tabs. Spike code lives on the local branch `spike/session-lease` (throwaway, not pushed, never merges): v1 `9673a60` refuse while parked · v2 `e2e692c` hold requests, modal overlay, ignore dry runs, 3 s grace · v3 `b12a3de` abort held requests, check every write, 1 s grace, re-raise overlay, reopen chat · v3.1 `a1aa3ba` log why a lease check fails · v4 `dda4e79` exempt nothing, abort only held chat saves, bounded lease-write retry · v4.1 `2943387` release marker on tab close, wait for the start decision · v4.2 `a3d6189` park and reload a holder restored from the back/forward cache. v4 onwards was tested only on a separate test install (SillyTavern 1.19.1, fresh data, Memory Books installed).

## Incident: the spike wrote to real user data

The spike ran on the SillyTavern install in daily use, with throwaway persona / lorebook / character / chat. That was not enough: user files are shared by the whole install.

- **Cause:** the spike's `fetch` wrapper exempted every `POST /api/files/upload` as a "lease request" (matched by path only). Before a takeover reload the page aborted its held requests; Memory Books treated its failed reads as missing files and uploaded default documents, which passed the exemption from a parked tab
- **Overwrite 1, 16:00:09: `user/files/stmb-side-prompts.json`.** A parked tab, about to reload after a takeover, aborted its held requests; Memory Books treated the failed read as a missing file and uploaded its default document, which passed the upload exemption
- **Overwrite 2, 16:17:45: `user/files/stmb-context-settings.json`** (now an empty "clean document"). Same hole: a held read of the file was aborted during a takeover and Memory Books uploaded a clean document. **The cleanup itself caused this one:** it took the lease with spike code to remove the test data through a page, running lease code against real data again
- SillyTavern keeps no backups of user files; no earlier copies were found in `user/files/`, the backups folder or the settings backups (side prompts are not kept in `extension_settings`)
- **Also changed and not reverted:** `settings.json` `active_character` (now `null`), `QuickReplies/Default.json` rewritten by the holder's save on page load, `stats.json` counters
- **Rule from now on:** every manual test, spike and cleanup runs on a separate SillyTavern install. No unreleased guard or lease code is ever installed in the SillyTavern in daily use (`ai-guidelines.md`, Investigating SillyTavern)

## Results (part 1)

| Check | Result |
|---|---|
| Lease read never served from cache | Pass |
| Parked tab: no error storm, nothing reaches the server | v1 fail (refusing requests breaks ST startup; overlay buried under ST's loader). v2+ pass with held requests, except the hole above |
| **Use here** lands on a usable page, same chat | Pass (v3 reopens the chat from the lease's `active` in 42–71 ms) |
| Persona, chat messages, character card survive a stale tab | Pass |
| Memory Books in the holder works; a parked tab's Memory Books writes nothing | Holder pass. Parked: its chat save was held, but see the incident: aborted reads led to default-file uploads through the exemption |
| Takeover while generating waits for `busy` | Pass after ignoring dry runs |
| Save queued just before a takeover | Pass: held by the pre-write check, or sent before the claim and then visible in the new holder; never applied after the new holder loaded (4 rounds incl. a 3 MB save) |
| Two tabs click **Use here** at once | Pass: exactly one holder |
| Server unreachable | Pass: holder and parked tab park, saves held, nothing sent after restart, no automatic re-claim |
| Popup open before parking / opened after parking | Pass: overlay re-raised, **Use here** clickable |

- **Switch time** (1 s grace, click to reopened chat): 3.3–3.9 s. With a 3 s grace: 5.4–5.6 s
- **Pre-write lease check** (same PC, through Tailscale): 2–8 ms, 49 ms worst. SillyTavern uses POST for most reads, so nearly every request is checked
- **Before the extension parks a fresh desktop tab**, ST sends only reads: `/csrf-token`, `/version`, `/api/secrets/read`, `/api/settings/get`, `/api/extensions/discover`. Built-in translate, connection-manager and regex load before the extension
- **Requests outside `fetch`:** XHR `POST /api/tokenizers/openai/count` (caught by the XHR wrapper); templates via XHR are static GETs. No `sendBeacon`. WebSockets not checked

## Re-check on the test install (v4–v4.2)

| Check | Result |
|---|---|
| Lease-write retry | Pass: the `EPERM` 500 recurred after a takeover; retry succeeded on attempt 2, no false park; six takeovers in a row clean |
| No exemptions, held reads stay pending | Pass: parked tabs held Memory Books' reads of both files six times; takeovers didn't abort them; no default files written |
| Only held chat saves aborted before a reload | Pass: reload went through with no "Leave site?"; the held message never reached disk |
| Release on tab close | Pass: a new tab claimed without a click |
| Holder refresh (F5) | Pass: stays holder, no extra reload; epoch bumped so its own marker stops counting |
| Old tab closed after a takeover | Pass: its marker names its old claim; the new holder's lease untouched; a new tab parks |
| Back/forward cache | v4.1 fail: a restored holder stayed unparked and its save reached disk. v4.2 pass: restored holder parks and reloads; a write at the moment of restore was held and never reached disk |
| Takeover while generating | Pass (model connected): the new tab waited for `busy`, the reply was saved before it loaded |

- Switch time (1 s grace, click to reopened chat): 3.2–3.3 s
- **Release timing:** the marker is written on `pagehide`, not `beforeunload`. `pagehide` fires only when the page really leaves (after a "Leave site?" prompt is accepted; a cancelled prompt releases nothing). It also fires when the page enters the back/forward cache, hence the v4.2 fix

## Part 2, stage 1: the app with no app changes

TravelingTavern app (debug build) on the Pixel 8, pointed at the test install over Tailscale; the extension's spike code (v4.2) runs inside the app's WebView.

| Check | Result |
|---|---|
| App's WebView runs the lease | Pass: claimed a released lease without a click; reopened the chat after a takeover |
| Desktop takes over → app parks | Pass for data safety: the app parks on its next request; held requests never reached the server |
| App shows it is parked | Fail: native screens keep their last data with no sign; the bridge's refresh is held silently. The overlay appears only inside the chat screen |
| Overlay in the app's chat screen | Partial: **Use here** works, but a Memory Books popup underneath shows through the backdrop |
| **Use here** from the phone | Pass, but 5.7 s to ready and 6.0 s to the reopened chat (desktop 3.3 s) |

- **Pre-request lease check from the Pixel over Tailscale:** 11–49 ms, one 123 ms; about 27 checks on page load
- Not run in stage 1: native writes while parked, takeover while generating between app and desktop (need app code: stage 2)

## Part 2, stage 2: app spike code

Extension v5 (app hooks: state reports, native Use here, foreground check) and an app spike on a local branch in the app repo, built as a separate app (`.spike` applicationId, refuses any server not on the test install's port). The page reports its lease state to Kotlin; Kotlin shows a native scrim, checks the lease before every bridge command, writes the background release itself (OkHttp), and asks the page to check on return.

| Check | Result |
|---|---|
| Starts parked while the desktop holds the lease | Pass: native "In use on another device" + Use here on every tab |
| Native actions (+, send) blocked up front | Pass: scrim swallows taps; bridge commands refused by the Kotlin pre-check, never left on a held request |
| Requests at page load before the extension decides | Pass: reads only (`/csrf-token`, `/version`, `/api/secrets/read`, `/api/settings/get`, `/api/extensions/discover`, lease reads); ST's `settings/save` held; nothing from `bridge.js` or clean mode |
| "Visual" bridge commands while parked | Pass for data, but `setAppState` isn't visual: on return it runs the persona sync, whose request the page's wrapper held |
| Background release with JavaScript paused | Pass: page JS paused in the debugger, app sent to background; Kotlin wrote the marker for the exact claim |
| Desktop after a background release / app returning after it | Pass: desktop claimed without a click; the returning app parked |
| Foreground takeover only when released | Pass: stayed parked while the desktop held the lease |
| Killed app | Pass: no marker; desktop shows Use here |
| Takeover while generating, both directions | Pass: the claimer waited for `busy`; the reply was saved before the claim and shown after the switch |
| Reply generating while the app goes to the background | **Fail:** the reply stalls until the app returns (see Findings) |

- **Phone switch** (Use here → reopened chat): 6.6 s = claim 0.09 s, grace 1.0 s, verify + reload to the new page's first request 0.9 s, ST startup reads until "holder" 1.6 s, holder → `APP_READY` 2.6 s (about 25 serial lease checks, 20–40 ms each), reopen 0.4 s. The lease's share is about 1.8 s

## Findings

- **False park of the real holder:** `/api/files/upload` answered 500 on a lease metadata write right after a takeover reload (seen 4 times, reproduced). Server error: `EPERM: operation not permitted, rename 'tt-session-lease.json.<n>' -> 'tt-session-lease.json'` from `write-file-atomic` (`renameSync`, no retry). Windows refuses to rename over a file another handle has open (a concurrent lease read, or a virus scanner on the fresh file). Transient
- **Memory Books creates default files when a read fails** (`stmb-side-prompts.json`, and a "clean document" for context settings). In a parked tab this must stay impossible; in the holder a transient read failure can still overwrite user files, outside our control
- `GENERATION_STARTED` also fires for dry runs (prompt assembly only) with no end event
- A held chat save keeps ST's `isChatSaving` set; ST's `beforeunload` then blocks the reload ("Leave site?")
- ST popups are modal dialogs: anything outside them is inert, including an overlay opened earlier
- The holder sends `POST /api/quick-replies/save` on every page load (whole-file save at load)
- After updating the extension, one tab kept running cached code until closed
- **`busy` sticks when a generation fails before it starts:** with no model connection ST fires `GENERATION_STARTED` and returns early with no end event; the next takeover waited the full 60 s timeout
- After a takeover reload ST does not reconnect to the model unless its auto-connect option is on
- **A reply stalls while the app is in the background.** The app never pauses its WebView (no `onPause()`, `pauseTimers()` or removal on stop). **Likely cause:** about 20 s after Home, Android's cached-app freezer freezes the WebView's renderer process (seen: `isFrozen=true` and the page stopped answering; a page heartbeat to confirm it didn't run, so the implementation must confirm the cause). The reply resumed only after the app returned; meanwhile the release stayed deferred and `busy` stayed `true`, so a desktop takeover would wait out the 60 s limit and the app's late reply would then be held and discarded
- **The app's first load ran older cached extension code** after the extension was updated, until a reload. A page running stale lease code is a safety gap, not just an inconvenience
- A release can be written late, as a frozen app thaws. Harmless by design: the marker names the old claim and the returning page bumps its epoch
- Closing a tab doesn't release the lease by itself: without the release marker every desktop switch after closing the holder costs a **Use here** click. The marker is best effort (a crash or killed browser skips it), so **Use here** stays the fallback

## Verdict

The session lease protects every data type tested with one rule and no knowledge of ST's save endpoints. Parking is tolerable with held requests: ST stays quiet behind the overlay, and a switch costs about 3.5 s. It is **not safe as spiked**: one exemption let a parked tab overwrite real user files, and a transient Windows error parks the real holder. Both have clear fixes (below). Proceed to a spec with the requirements below, then run part 2 (the app) on a separate install before building the release.

**Update after the re-check (v4–v4.2):** both fixes, release on tab close and the back/forward-cache handling pass on the test install.

**Final (after part 2):** the spike is complete. The lease works between desktop tabs and the app in every case tested, including takeovers during a reply, a background release with JavaScript paused and a killed app; nothing reached the server from a parked page. The app needs native support (parked state, up-front blocking, release from Kotlin), and a reply in the background is an open decision. **Next step: the spec**, built from the requirements below. Still unchecked: WebSockets.

## Requirements for the spec

1. **The wrapper exempts nothing.** Lease reads and writes use the original `fetch`; no request is let through by URL while parked
2. **Parked = hold.** Server-data requests (`/api/…`, `/user/…`, any non-GET) are held, never refused; static files load
3. **Before a reload, abort only held chat saves** (so `isChatSaving` clears and `beforeunload` doesn't block). Leave held reads pending, so no extension sees a failed read and writes a default file. No held request is ever sent
4. **A page becomes writable only through a fresh load that holds the lease.** A page that lost the lease never re-claims by itself
5. **Re-read the lease before every write.** Reads may trust a read up to 2 s old (see 21 for read-only endpoints)
6. **Claim:** wait for `busy` to clear (with timeout), write `epoch + 1`, wait the grace period (1 s), re-read, require holder **and** epoch to be ours, reload
7. **Lease writes retry on failure:** re-read; if holder and epoch are still ours, stay holder and retry a bounded number of times, ~100–200 ms apart; park only if the claim changed or the lease can't be read. Write the lease less often (skip an unchanged `active`). A failed `busy: true` write is not metadata: don't start the generation, or tell the user
8. **`busy` ignores dry runs**
9. **Overlay** is a `<dialog>` opened with `showModal()`, re-raised whenever another dialog opens while parked; Escape can't close it
10. **Reopen the chat after a takeover** from the lease's `active` (avatar or group id + chat file); don't let startup's empty `CHAT_CHANGED` erase it
11. **Fail closed:** lease unreadable → park
12. **Open:** WebSockets; Memory Books' default-file behavior in the holder; whether the app holds first requests at document start (not built in the spike: everything before the extension decides was a read) **Split into 31–33 (outline review).**
13. **`coding-standards.md` must be updated** before building: the bounded retry delay and the grace wait are one-off delays. Allow one-off delays; keep the ban on polling and repeating timers. The spike's wait for `busy` re-reads the lease every second, which is polling: the spec must replace it or name it as a bounded exception **Split into 34–35 (outline review).**
14. **Testing:** every manual test, spike and cleanup on a separate SillyTavern install; no unreleased guard or lease code in the install in daily use
15. **Release on tab close, best effort:** on `pagehide` the holder writes a separate release marker naming its exact claim (`holder` + `epoch`) with `fetch(..., { keepalive: true })` (not `sendBeacon`: the upload needs the CSRF header). It never writes the lease itself, so a later claim can't be undone. A new page treats the lease as free only if the marker matches the lease's holder and epoch; a released claim's `busy` is stale and not waited for. **Use here** stays the fallback when no marker was written
16. **A refreshed holder bumps its epoch before unparking**, so its own release marker stops counting
17. **Back/forward cache:** `pagehide` also fires on entering the cache, so a holder restored from it (`pageshow` with `persisted`) parks at once and reloads; the fresh load re-checks the lease
18. **Requests made before the start decision wait for it:** sent if the page turns out to be holder, held if parked (never held for good in a holder page)
19. **`busy` must not stick after a generation that fails before it starts** (no end event): decide how the holder clears it, or how a claimer recognizes a stale `busy` without polling. The 60 s limit caps it until then
20. **After a takeover reload, the model connection must be restored or the user told how.** On the phone every takeover is a reload; without a connection the user takes over a chat and can't generate a reply. The spec decides which (e.g. reconnect after a takeover reload, or require ST's auto-connect and say so); don't rely on auto-connect being on. Seen again in part 2: the app's page had no model connection after every takeover reload **Split into 36–37 (outline review).**
21. **Allowlist of read-only endpoints** that skip the pre-request check in the holder (still held while parked). From the Pixel each check costs 11–49 ms and ST sends about 27 POST requests on load, most of them reads. Every listed endpoint is confirmed read-only in ST's source; anything not listed is checked
22. **Phone switch time needs a timing breakdown before the spec:** **Use here** in the app takes about 6 s to the reopened chat (desktop 3.3 s). Measure claim, grace, reload, ST startup and chat reopen separately
23. **The app shows the parked state natively on every screen** and blocks native actions (+, send) up front while parked, never leaving them on a held request. Found in stage 1: the native screens keep stale data with no sign while the WebView is parked **Split into 38–39 (outline review).**
24. **Only one lease write in flight at a time** (one queue for claims, epoch bumps and `busy` / `active` updates). Otherwise an update that read the lease before a returning holder's epoch bump can write the old epoch back, and the holder's release marker counts again (found while building stage 2; worst case another page takes over without a click)
25. **A reply while the app goes to the background (owner's decision):** the app runs a `shortService` foreground service while a reply generates, so Android doesn't freeze the WebView. If Android's time limit ends the service first, the app interrupts the reply, releases the lease, and tells the user when it returns. A takeover never waits out the 60 s `busy` limit for a reply that can't finish. Likely cause of the stall: Android's cached-app freezer freezes the WebView's renderer about 20 s after Home (the app never pauses the WebView itself); the implementation must confirm it
26. **Safety: after an extension update the app loads the current extension code, never a cached copy, and reports the guard version it is running.** A page on stale lease code may not hold the lease (the app's first load after an update ran older code)
27. **Only truly visual bridge commands skip the Kotlin pre-check** (`revealMessage`, `endReveal`: DOM only). `setAppState` loses its exemption: on return it runs the persona sync, which reads and can save. Anything not confirmed visual is checked
28. **The native parked scrim covers the whole screen,** including the bottom tab bar, and closes the keyboard and clears text focus when it appears
29. **The native parked screen shows when it is waiting for a reply on the other device** (the page reports the claim's `busy` wait), not just "Taking over…"
30. **An automatic claim (after a release) reopens the chat** from the lease's `active`, as Use here does
31. **WebSockets: to check** whether ST or an extension sends server data over a WebSocket, which the wrapper doesn't see (from 12)
32. **Memory Books writes default files in the holder** when a read fails (transient error): outside the lease's control; a known limit (from 12)
33. **Whether the app holds first requests at document start:** not built in the spike; everything sent before the extension decided was a read (from 12)
34. **`coding-standards.md`:** allow one-off bounded delays (lease-write retry, grace wait); keep the ban on polling and repeating timers (from 13)
35. **The wait for `busy` re-reads the lease every second (polling):** replace it, or name it as a bounded exception (from 13)
36. **In the page (desktop and app):** after a takeover reload, restore the model connection or tell the user how; don't rely on ST's auto-connect (from 20)
37. **In the app:** a native notice when the page reports no model connection after a takeover (from 20)
38. **Native parked state on every screen** in the app (from 23)
39. **Native actions blocked up front while parked,** never left on a held request (from 23)
40. **One lease instance per page:** in the app's page the bundled copy runs and an installed extension stands down; `leaseInfo` reports both versions so the app can prompt for an update (added at outline review)
41. **`format` number in the lease and release files.** A page that sees a format it doesn't know parks (fail closed), so different lease versions on desktop and phone share the files safely (added at outline review)
42. **CSRF token for the app's background release:** Kotlin fetches its own token from `/csrf-token` with the WebView's cookies (ST's `csrf-sync` returns the session's existing token, so the page's token is untouched); it never travels through a page message. Kept in memory only, never logged or stored (added at outline review)
43. **Foreground (app):** the app takes over automatically only when the lease was released; otherwise it shows the native parked state (owner's stage 2 decision)
44. **Background release (app):** Kotlin writes the release marker over HTTP, so it works with the page's JavaScript paused or frozen; deferred while a reply generates (see 25); a killed app writes nothing and the desktop falls back to Use here
