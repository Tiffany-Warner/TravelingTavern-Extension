# Session-Lease Spike: Decision and Requirements

2026-11-20. Owner decision, validated by a spike (desktop tabs, then the TravelingTavern app) against SillyTavern 1.19.0 and 1.19.1. Spike code lives on the local branch `spike/session-lease` (throwaway, never merges).

## Decision

One SillyTavern (ST) page per ST user writes at a time: a **session lease** ("Use here"). Every other page is parked with its requests held, and taking over reloads the page from fresh data. **Accepted by the owner:** one device at a time, with a reload on every switch.

## Why

An ST page reads a file once and later saves the whole file from its own copy; ST has no awareness of other open pages. Settings, chats, character cards, lorebooks, presets, Quick Replies, themes and groups are all exposed.

- **Per-save guard, rejected:** per-file version checks need a different mechanism for each data type and depend on about a dozen ST endpoints and internals. The endpoint list is never complete, and a missed or renamed endpoint fails silently: the save goes through unguarded. Three design reviews in one day each found a new hole
- **A separate memory system, rejected as the fix:** moving memories out of lorebooks protects one data type of five, and Memory Books would need a fork
- **Session lease, accepted:** one rule covers every write and depends on almost nothing inside ST

## Incident

The first spike ran on the real server: an upload exemption let a parked tab, and later the cleanup, overwrite two real Memory Books files.
Since then every manual test, spike and cleanup runs on the separate test install.

## Verdict

The lease protects every data type tested, between desktop tabs and the app, including takeovers during a reply, a release with JavaScript paused and a killed app; nothing reached the server from a parked page. Parking is tolerable with held (not refused) requests. The fixes the spike found (no exemptions, lease-write retry, release marker, back/forward cache) are requirements below.

**Switch time** (Use here to the reopened chat): desktop ≈3.3–3.9 s, phone ≈6.6 s (about 1.8 s of the phone's time is the lease: grace and checks).

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

## Requirement Map (final)

Which spec section owns each requirement. **E** = `context/specs/ext-0.2-session-lease-spec.md` (this repo), **A** = `context/specs/session-lease-app-spec.md` (TravelingTavern repo). Every requirement has exactly one owner; the other spec links to it.

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
