# TravelingTavern Extension `v0.2.0` — Session Lease

Requirements: `context/decisions/session-lease-spike.md` (cited as **R1–R44**). Requirement map: `session-lease-spike.md` → Requirement Map (final). App side: the TravelingTavern repo's `session-lease-app-spec.md`, which references this spec for every shared definition and never restates it.

## 1. Purpose and Rule

**Rule:** nothing TravelingTavern runs may delete or overwrite SillyTavern (ST) data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

**Problem:** an ST page reads data once and later saves whole files from its own copy. A page left open on one device erases what another device saved since (chats, settings, lorebooks, personas, extension files).

**Design: one active page per ST user.** A small lease file names the page that may write. Every other page is **parked**: it shows an overlay with **Use here**, and its requests to the server are held, never sent. Use here claims the lease and reloads the page, so it starts from fresh data. **Never stuck:** every parked or waiting state offers a way back in, and going ahead at the user's own risk (Take over anyway, Turn off protection: E4) is always a tap after a warning. The lease needs no knowledge of which endpoints save what; the per-save guard it replaces did (why, and the evidence: `context/decisions/session-lease-spike.md`).

**Scope:** every page that runs `session-lease.js`: desktop tabs with this extension installed, and the TravelingTavern app's page (bundled copy, app spec). Pages without it are not protected (E13).

## 2. Lease and Release Files *(shared contract)*

Two small JSON files in the ST user's files. Each ST user has their own, so the lease is **one active page per ST user**.

| | Lease | Release marker |
|---|---|---|
| Name | `tt-session-lease.json` | `tt-session-release.json` |
| Read | `GET /user/files/<name>` | same |
| Written by | the page that claims; then only the holder (E3) | only the holder that is releasing (E5, app: A5) |
| Means | who may write to SillyTavern now | "this exact claim was given up" |

### Reading

- Uncached every time: page `fetch(url, { cache: 'no-store' })`; Kotlin sends `Cache-Control: no-cache`
- **404 = the file doesn't exist.** Any other non-2xx, a network error, a body that isn't a JSON object, or a missing or mistyped required field = **unreadable**. Unreadable is never "missing" and never "free": the page parks (R11)
- **Bound: 10 s** (`LEASE_FETCH_TIMEOUT_MS`): every lease read (fetch and body) is aborted after 10 s and is unreadable ("can't reach"), so no state waits on a server that accepts the connection but never answers: the start decision, a claim, the wait for `busy`, Take over anyway, a holder's checks. The lease's own CSRF token fetch has the same bound
- Unreadable has two park reasons, so the user reads the right text (E9): a network error, the 10 s bound, or a status other than 2xx / 404 parks as **`unreadable`** (can't reach ST); a 2xx answer that isn't valid JSON or has a wrong field parks as **`damaged`** (the file is damaged). Both decide the same way; only the text and the ways out (E9) differ
- The lease is read through the original `fetch`, never through the wrapper (R1)

### Writing

- `POST /api/files/upload` with the CSRF token the lease fetched itself (E6), body `{ "name": "<file name>", "data": "<base64 of the UTF-8 JSON>" }`. ST writes the file atomically (temp file + rename)
- A write can fail transiently (Windows `EPERM` on the rename, answered as 500). Retry rules: E3
- Every lease write is bounded like a read (10 s, then aborted). The release marker's `keepalive` upload (E5) is not: nothing waits for it. A write aborted at the bound may still land later: the next re-read finds it (an own pair is verified, not written again; a page that already gave up stays parked, E7)
- Each file stays under 1 KB. No other files are written

### Lease fields

| Field | Type | Meaning |
|---|---|---|
| `format` | integer | File format, currently **`1`** (below) |
| `holder` | string | Page id of the holder: **`<tab id>.<load id>`**. The tab id is one per tab (per page in the app), kept in `sessionStorage` for that origin, so a refresh keeps it and a duplicated tab copies it; the load id is new on every page load. Both random, no personal data, no dot inside either. Pairs compare the whole holder; only the start decision looks at the tab part (E4) |
| `epoch` | integer ≥ 1 | Counts claims. Every claim writes `epoch + 1`; a holder that must invalidate its own release marker bumps it to `epoch + 1` with itself as holder (E5, A5). Never compared alone: see the pair rule |
| `claimedAt` | string (ISO 8601) | Informational only |
| `busy` | boolean | The holder is generating a reply (E8). Claimers wait for it to clear (E4) |
| `active` | object or `null` | The holder's open chat, for reopening after a takeover (E4): `{ "avatar", "chatFile" }` or `{ "groupId", "chatFile" }` |

A claim writes all fields (`busy: false`, `active` carried over from the previous lease). The holder afterwards changes only `busy`, `active` and, for an epoch bump, `epoch`, always after re-reading the lease and confirming `holder` and `epoch` are still its own (E3).

**Readers ignore fields they don't know.** A page that writes the lease keeps nothing it doesn't know about: it writes only the fields of its own format.

### The pair rule

Every lease decision compares the pair **(`holder`, `epoch`)**, never `epoch` alone: "still holder", "the marker matches", Kotlin's pre-check (A4).

- **After a claim** the page waits the grace period, re-reads, and continues only if the lease holds its own pair (E4)
- **After an epoch bump** the holder re-reads the same way and continues only if the lease holds `(itself, new epoch)`; otherwise it parks
- A bump and a claim at the same moment can both write the same epoch number (`n + 1`). Whichever write landed last is in the file; the other page's re-read finds a different `holder` for that epoch and parks. The pair, not the number, decides

### Release marker fields

| Field | Type | Meaning |
|---|---|---|
| `format` | integer | Same format numbers as the lease |
| `holder`, `epoch` | string, integer | The exact claim being given up |
| `releasedAt` | string (ISO 8601) | Informational only |

- **The lease is released** only when both files are readable, both formats are known, and the marker's `holder` **and** `epoch` equal the lease's. Anything else: not released
- The marker never changes the lease. A late or stale marker (a closed tab's old claim, a frozen app thawing) no longer matches and means nothing
- A released claim's `busy` is stale and is not waited for (R15, E5)
- The marker is overwritten by the next release, never deleted

### No lease yet

No lease file (404) = free: the page claims (E4). A missing marker with a lease present = not released.

### `format`

- Every page knows a set of formats it can read, and writes only the newest format it knows
- **A page that reads a format it doesn't know parks** (fail closed, R41): it doesn't claim, doesn't offer Use here, and never writes over the file by itself. Only the user's **Take over anyway** after a warning writes over it (E4), in this copy's format; a newer reader that still knows that format then works, an older one meanwhile parks as before. Its parked state names the outdated side, which is always its own copy: the extension on desktop (`source: 'extension'`), the app in the app's page (`source: 'app'`). See `leaseState` reason `unknownFormat` (E11)
- A missing `format` is an unknown format.
- **`format` changes only for a change that would make an older reader decide wrongly** (a field whose meaning changes, a new field that a decision depends on). Additive fields that older readers can safely ignore don't bump it
- Why so strict: the app's bundled copy lags the extension (app releases vs `git pull`), so the two regularly run different versions against one file; a bump locks the older side out until it updates
- `format` is separate from `LEASE_VERSION` (E11), which changes with any lease behavior

### Time

No decision uses a clock time from the files: devices' clocks differ. `claimedAt` and `releasedAt` are for people reading the files.

## 3. Lease Writes

- **One write in flight at a time** (R24): claims, epoch bumps and `busy` / `active` updates go through one queue in the page. Otherwise an update that read the lease before an epoch bump can write the old epoch back
- **Every update re-reads first** and writes only if the lease still holds this page's pair (E2). Pair changed → park (`lost`) at once; unknown format → park (`unknownFormat`) at once. An unreadable or missing (404) lease may be transient: it counts as a failed attempt (below)
- **Bounded retry** (R7): a failed write (e.g. Windows `EPERM`, answered as 500) is retried after a random 100–200 ms, at most 3 attempts in total, re-reading before each; an unreadable or missing re-read counts as a failed attempt. If the last attempt's re-read was unreadable or missing, the page parks (`unreadable` or `damaged`, or `lost` for a missing lease), whatever the write type. When all 3 attempts fail at the write:
    - **claim (incl. Take over anyway) or epoch bump** → the page isn't holder: it parks (`error`: the reads worked, the writes didn't; E9 offers Refresh, Take over anyway and Turn off protection). A claim or bump whose last write got no answer (network error, the 10 s bound) parks as `unreadable` (can't reach) instead, and so does Take over anyway whose own first read couldn't reach ST
    - **`active`** → the page stays holder; logged (only reopening the chat after a takeover is affected)
    - **`busy: true`** → see below; a `busy: false` stays pending as for `busy: false` (the failed write may still have landed)
    - **`busy: false`** → the page stays holder and keeps the pending `busy: false`: it goes with the holder's next lease write or check until it lands, so the file never stays `busy: true` after a reply
- **Skip unchanged writes:** no write when `busy` and `active` already have the values to be written
- **A failed `busy: true` is not just metadata:** claimers wouldn't wait for the reply. The generation request is sent only after `busy: true` is written and confirmed (E8). If that write fails after the retry above, the request is **not sent**: the wrapper rejects it with an `AbortError` (as ST's Stop would), so ST ends the generation, and the page reports `leaseNotice` `replyNotStarted` (E11): desktop shows one toast, "Couldn't reach SillyTavern to start the reply. Try again."; the app shows its native notice (A7)
- Bounded one-off delays only (`coding-standards.md` → Timers and Waiting, R34)

## 4. Claim and Takeover

**Claim** (Use here, an automatic claim at start, or the app's `useHere()` / `onForeground()`):

1. Read the lease and the marker. Unknown format → park (`unknownFormat`) and stop
2. **Wait for `busy`** (R6, R35) unless the lease is released (its `busy` is stale) or there is no lease: re-read once per second for at most 60 s while the lease is `busy`, reporting `waitingForReply`. A changed pair (another page claimed) parks this page (`lostRace`); a lease that becomes released ends the wait. After **10 s** of waiting, `leaseState.actions` offers **Take over anyway** (re-reported at the wait's next 1 s step); a tap ends the wait at the following step and continues as a forced claim (below). The one named polling exception (`coding-standards.md`). A `busy` that can never clear (R19) is prevented by E8, not waited out
3. Write `{ format, holder: own id, epoch: lease.epoch + 1 (1 if no lease), claimedAt, busy: false, active: carried over }`
4. **Grace:** wait 1 s, so a write the old holder already sent lands before this page loads
5. **Verify:** re-read; continue only if the lease holds this page's pair, else park (`lostRace`). Two pages claiming at once end with exactly one holder: the last write wins, the other's verify fails
6. Set the reopen flag (`sessionStorage`), abort held chat saves (E7), reload

**Start decision** (every page load; requests wait for it, E6):

- Lease's holder has this tab's id as its tab part (before the first dot): a refresh, or a duplicated tab. **Always bump the epoch** to `(this load's holder, epoch + 1)`, with `busy: false` (no reply can be running in a fresh load), and verify after the grace (pair rule, E2) before becoming holder. The newest load in that tab wins; an older page of the same tab fails its next pair check and parks. Each load has its own holder, so two loads of one tab never verify the same pair
- **A duplicated tab** therefore takes over from the original without a click (intended); the original parks at its next write
- On desktop, SillyTavern's first reads happen before the extension loads (E6), so the start bump's grace doesn't fully cover a save a duplicated tab's original still has in flight
- No lease, or the lease is released → **automatic claim** (steps 1–6, no click), at most once per tab between successful loads (a `sessionStorage` mark prevents a reload loop), cleared when a load becomes holder or the automatic claim ends without a reload
- Otherwise → parked (`held`). Lease or marker unreadable → parked (`unreadable`, or `damaged` for a 2xx answer that isn't valid: E2)
- **Prerendered page** (Chrome can load ST hidden while the address is typed, `document.prerendering`): the start decision **never runs** while hidden; requests wait for it (E6) and nothing is decided or written. On `prerenderingchange` the page **reloads** (E7's reload: held chat saves aborted, `reloadPending` fallback), and the fresh, shown load decides as usual. Not just starting on activation: a prerendered page's sessionStorage (its tab id) is swapped for the tab's at activation, and its ST data may predate the old page's last saves (a prerender of the address in the holder's own tab would bump and hold with that data). Costs one extra ST load, only when Chrome prerenders. Requests waiting for the start decision aren't in the held registry, so that reload can't abort a waiting chat save; ST doesn't save a chat while prerendered, and a page without user activation shows no "Leave site?". The app's WebView has no address bar and ST has no speculation rules, so it doesn't prerender

**Take over anyway (forced claim)**, offered on `unreadable`, `damaged`, `error`, `unknownFormat`, and on `waitingForReply` after 10 s (E9). Always a user tap after the warning "Anything unsaved on your other device may be lost." (the overlay's own card on desktop; the app's own dialog), never by itself:

1. Park `claiming` (requests held). During the wait for `busy`, the wait ends at its next step
2. Read both files once, only to choose what to write: a readable lease of a known format gives `epoch + 1` and its `active`; anything else gives epoch 1 and `active: null`. Nothing has to match, no wait for `busy`
3. A release marker that is damaged or in an unknown format is first replaced by one naming a fresh random holder (matches no lease), so other pages park as `held`, not `damaged` / `unknownFormat`. A marker that couldn't be fetched is left alone
4. Write the lease over whatever the file holds: `{ format, holder: <this tab id>.<new random load id>, epoch, claimedAt, busy: false, active }`. A new holder id, so no stale marker or older pair can match, and every other page parks at its next check by the pair rule (`lost`). Write queue and retry as E3; all attempts failed → `error` (`unreadable` when step 2's reads couldn't reach ST)
5. Grace, verify (`lostRace` if another write landed after it), reopen flag (`useHere`: reopen and reconnect), abort held chat saves, reload. The fresh load bumps from its own tab as usual. Protection stays on

**Turn off protection** (this tab only), offered on `unreadable`, `damaged`, `error` and `unknownFormat` (E9), the last resort for a problem that comes back on every load (writes that keep failing, a lease bug). Always a user tap after the warning "This page can save over newer changes from your other devices.":

1. Set `tt-lease-off` in this tab's `sessionStorage`, abort held chat saves, reload (E7). The flag is set before the reload, so if the user cancels it ("Leave site?" → Stay) the page parks `reloadPending` and its next load is already off: what the user confirmed. Held requests are dropped by the reload, never sent. **Never stands down in place:** the page that hit trouble may hold a stale copy, so it reloads from fresh server data before anything passes
2. A load that finds the flag stands down for this load: no wrapper, no lease reads or writes, no claim, no release. `window.__ttLease` is still defined (a second copy stands down) and reports `leaseState` `state: 'off'` (E11); desktop shows the banner (E9). ST then works as if the extension weren't installed
3. The flag survives refreshes of this tab, so the problem doesn't ask again on every load, until **Turn protection back on** (removes it and reloads; the fresh load decides as E4) or the tab is closed. Other tabs and devices stay protected. A duplicated tab copies `sessionStorage`, so it is off too (banner shown)
4. Storage blocked: the off mark goes on `window.name` (prefix `tt-lease-off-once:`) for the next load only, which removes it and restores the name (ST doesn't use `window.name`: E15). The prefix counts **only** when that load can't write `sessionStorage` and is a reload (Navigation Timing `type: 'reload'`); otherwise it is removed and ignored, because another site can name a window it opens (`window.open(url, name)`) and must never turn protection off

**Refresh**, offered on every error state (`unreadable`, `damaged`, `error`, `unknownFormat`, `reloadPending`): E7's reload (held chat saves aborted, so no "Leave site?"); the fresh load decides as E4

**Reopen the chat** (R10, R30): after a reload that follows any claim (Use here, automatic or onForeground), once ST fires `APP_READY` and the page is holder, open the `active` the lease held when this load became holder, with ST's context functions (`SillyTavern.getContext()`, read fresh each time: it returns a snapshot), the same steps as ST's own "open recent chat":

- **Character:** `selectCharacterById(index of avatar)`, then `openCharacterChat(chatFile)` if `chatId` isn't that chat, only if the character really is selected afterwards (ST skips the switch while a save or reply runs; the open would change the wrong character's chat)
- **Group → stays on ST's start screen** (logged): `openGroupChat` needs the group selected, and `openGroupById` isn't in ST's context (the lease imports no ST modules). The app reopens groups by its own `chatFile` route (E13)
- A character that no longer exists → start screen (logged)
- The reopen flag (`sessionStorage`) is read and removed when the page loads, so only the load right after the claim reopens; a load that ends up parked reopens nothing
- While the reopen is pending, `CHAT_CHANGED` doesn't write `active` (ST's startup chat changes would overwrite the chat to reopen). When it is over, the chat then open is recorded; without one `active` stays as it was

**Recording the open chat:** on `CHAT_CHANGED` the holder writes `active` (E3; skipped when unchanged): `{ avatar, chatFile }` for a character, `{ groupId, chatFile }` for a group, `null` without a chat.

## 5. Release (desktop)

Best effort, so closing the holder doesn't cost the next page a click (R15). The app releases differently: app spec A5.

- On **`pagehide`**, and on the Page Lifecycle **`freeze`** event (on `document`). Not on `beforeunload`, which fires before a "Leave site?" prompt the user may cancel. Only a holder releases; a parked page reloading after a claim never does
- **Why `freeze`:** Chrome may discard a frozen background tab, which never fires `pagehide`. The marker's request is sent synchronously from the handler (before any `await`); `keepalive` lets it finish while frozen
- Sent with `fetch(..., { keepalive: true })` through the original `fetch` with ST's request headers (not `sendBeacon`: the upload needs the CSRF header). Body: the release marker (E2) naming this page's exact pair. Never touches the lease
- **A refreshed holder** finds its own marker matching; the always-bump at start (E4) makes it stop counting (R16)
- **Back/forward cache** (R17): `pagehide` also fires when a page enters the cache, so a holder restored from it (`pageshow` with `persisted`) has released its claim. It parks at once (holds everything) and reloads; the fresh load decides as in E4
- **Resumed after a freeze** (`resume` on `document`): the app's foreground holder check (A5), **no reload** (a reload would cost unsent text). The page re-reads the lease and the marker:
    - Lease still holds its exact pair (no other page claimed): **bump the epoch** to `(itself, epoch + 1)`, invalidating its own marker, wait the grace, verify with the pair rule (E2), and hold again
    - Pair changed (another page claimed, incl. during the grace): park (`lost`, Use here). Lease unreadable: park (`unreadable`). Unknown format: park (`unknownFormat`). A failed bump: as E3
    - Requests wait for this check (like the start decision, E6): sent if the page holds again, held otherwise
    - A page released on `pagehide` ignores `resume`: a back/forward-cache restore fires `resume` and then `pageshow`, and keeps the reload above
- **Discarded after a freeze:** the marker was written on `freeze`, so the next page claims without a click. Reopening the discarded tab is a fresh load (E4)
- Desktop only: the app's page releases from Kotlin (app spec A5) and wires neither `pagehide` nor `freeze`
- **No marker** (browser crash, killed tab, power loss): the next page parks and offers Use here

## 6. Request Wrapper

Wraps `window.fetch`, `XMLHttpRequest.prototype.open` / `send` and `navigator.sendBeacon`. Nothing else in ST is patched.

**Server data** = a path under `/api/` or `/user/` (compared lower-case, trailing slashes ignored), or any method other than `GET`. Everything else (scripts, styles, templates, images, `/version`) passes untouched; `/csrf-token` passes after the ordering wait below. Every `GET` outside `/api/` and `/user/` only reads (E15).

| Page state | Server-data request |
|---|---|
| Before the start decision (R18), incl. a prerendered page (E4) | Waits for it, then as below |
| Holder, non-`GET`, not allowlisted | Re-reads the lease first (pair check); sent only if still holder, else the page parks and holds it |
| Holder, `GET` or allowlisted | Sent if the last lease read is at most 2 s old; otherwise re-read first, as above (R5, R21) |
| Parked | **Held** (R2): never sent, never refused |

- **Exempts nothing** (R1): no request passes by URL while parked. The lease's own reads and writes use the original `fetch` captured at install, so they never pass through the wrapper
- **Held** fetches stay pending; only their path and reject function are kept, never the request, so nothing can send one later. Held XHRs are never sent and never complete (refusing breaks ST's startup)
- **A held fetch whose own `AbortSignal` fires** (e.g. ST's Stop) is rejected with an `AbortError` and dropped at once, so it is never sent
- **`navigator.sendBeacon`** returns `false` without sending unless the page is holder (it can't wait for a lease check; ST doesn't use it)
- **CSRF token** (R42): the lease fetches its own once at install, `GET /csrf-token` through the original `fetch` (ST returns the session's existing token, E15). Kept in memory only, never logged, never in a message. A lease write answered `403` fetches the token again once and resends
- **CSRF ordering:** two token requests on a session without a token would each create one, and the later cookie wins. So ST's own `GET /csrf-token` waits until the lease's token fetch has finished, at most **2 s**, then is sent (never held), so ST's startup never stalls
- **Fail closed** (R11): a lease read that fails parks the page and holds the request
- **Allowlist** (R21): read-only `POST` endpoints, each confirmed read-only in ST's source for every tested ST version, kept in a named constant. Confirmed for 1.19.0 and 1.19.1 (E15): `/api/settings/get`, `/api/characters/all`, `/api/characters/get`, `/api/groups/all`, `/api/chats/get`, `/api/chats/group/get`, `/api/chats/recent`, `/api/worldinfo/get`, `/api/avatars/get`, `/api/backgrounds/folders`, `/api/image-metadata/all`, `/api/secrets/read`, `/api/stats/get`, `/api/sd/comfy/workflows`, `/api/tokenizers/*/encode`, `/api/tokenizers/*/count` (`*` is one path segment). **Not** `/api/backgrounds/all`: it rewrites `image-metadata.json`. Anything not listed is checked. Allowlisted requests are still held while parked. On an untested ST version the allowlist is off (E12)
- **Before the extension loads** (desktop) ST sends only reads (`/csrf-token`, `/version`, `/api/secrets/read`, `/api/settings/get`, `/api/extensions/discover`). In the app the bundled copy is installed at document start, before any of them
- **WebSockets** (R31, checked, E15): ST 1.19.0 / 1.19.1 has no WebSocket endpoint and opens none; streaming reads fetch bodies; no `sendBeacon`, workers or form posts. Third-party extensions and server plugins could still open one (E13)

## 7. Parking and Reloads

- **A page becomes writable only through a fresh load that holds the lease** (R4): the start decision (E4) is the only place a page unparks. A page that lost the lease never re-claims by itself; it offers Use here, which claims and reloads. **Second exception, the user's:** a tab with protection off (E4) writes without the lease, but only from a fresh load after the user's tap and warning
- **One exception: resume after a freeze** (E5): a page that released on `freeze` holds again without a fresh load when the lease still holds its exact pair (no other page claimed since, so its data is still the newest). It still bumps and verifies first; requests wait for that check
- Parking is immediate: from that moment every new server-data request is held
- **Before any reload, abort only held chat saves** (R3): held `/api/chats/save` and `/api/chats/group/save` are rejected with an `AbortError`, so ST's `isChatSaving` clears and its `beforeunload` doesn't block the reload with "Leave site?". These paths are a named constant (E15). **Then wait one task (`setTimeout(0)`) before reloading:** ST clears the flag in its save handlers, which run only after the rejection; reloading at once lets `beforeunload` cancel the reload
- **A reload that didn't happen** (cancelled by `beforeunload` or the user): a page still alive **2.5 s** later parks as `reloadPending` (E9), never stays in `claiming`; its **Refresh** button reloads again (E9). No new claim: the fresh load decides (E4)
- **Held reads are never aborted:** an extension that sees a failed read may write a default file (Memory Books does). They stay pending until the page unloads
- No held request is ever sent, before or after a reload

## 8. `busy`

`busy` tells claimers the holder is generating a reply, or hasn't saved it yet (R8, R19).

- **Tied to the generation request itself,** not to ST's `GENERATION_STARTED` event (it fires for dry runs too, and has no end event when a generation fails before it starts). The wrapper holds a request to a generation endpoint until `busy: true` is written and confirmed (E3), then sends it. The reply **ends** when that response is over: the body fully read or the stream closed, an error, or the read cancelled (Stop). **Never when the headers arrive:** a streaming reply continues long after them. Dry runs and generations that fail before sending never set it
- **Then the chat save:** ST saves the reply only after the response ends, up to about a second later, more on a hidden page (E15). A claim landing in between would hold that save and lose the finished reply. So after the last reply ends, `busy` stays `true` until a request to a chat-save path (E7, `CHAT_SAVE_PATHS`) that **started after that end** (reached the wrapper, before the lease check) has completed, whatever its status (a network error too); then `busy: false` is written. An earlier save (e.g. the user's message) doesn't count
- **Bound: 3 s** (a one-off delay, E3). No such save completed by then (nothing generated, an error, a quiet generation, no chat open, or ST skipped the save: E15) → `busy: false` at the bound and one warning with the generation's path and the reason (no chat data)
- **A new reply during the wait:** `busy` stays `true`; the wait starts again when that one ends. If that reply can't start (its `busy: true` write fails), the wait is gone and `busy: false` stays pending (E3); the next lease check, possibly the earlier reply's own save, writes it, so `busy` may clear just before that save (only when ST is barely reachable)
- A page that parks during the wait writes nothing; one that is no longer holder when the reply ends doesn't wait (its save is held). `leaseState.busy` (E11) stays `true` until the wait is over
- Generation endpoints, a named constant (checked per ST version, E15; confirmed for 1.19.0 and 1.19.1): any `/api/backends/*/generate` (so a new backend still sets `busy`; today `chat-completions`, `text-completions`, `kobold`), plus `/api/novelai/generate` and `/api/horde/generate-text`
- **Fallback:** the end of a response is seen by passing its body through a stream of the lease's own (a rebuilt `Response`). If the `Response` can't be rebuilt, `busy: false` is written at the headers instead, without the chat-save wait, and a warning is logged, so `busy` never sticks (the reply may still be streaming; a claimer could then not wait for it)
- `busy` written by an epoch bump (resume, the app's foreground bump) comes from this page's own generations or save wait, never copied from the lease (a reply that ended while released wrote no `busy: false`). A `busy` write that finds the lease at this page's own newer pair retries once with that pair
- Several generation requests at once (e.g. an extension's background summary during a reply): `busy` stays `true` until the last one finishes, then the chat-save wait above

## 9. Web Overlay (desktop)

Shown by `index.js` from `tt-lease` events of type `leaseState` (E11). **Overlay only, no toast** for parked tabs. Never shown in the app's page.

**Behavior**

- A `<dialog>` opened with `showModal()`, covering the window, so it sits above ST's loader and popups and everything under it is inert. Whenever another dialog opens while parked (ST popups are modal), the overlay is closed and re-opened so it is the top modal again and **Use here** stays clickable. Escape can't close it
- The buttons come from `leaseState.actions` (E11), in that order: **Use here**, **Refresh**, **Take over anyway**, **Turn off protection** call the `window.__ttLease` member of the same name (Refresh reloads directly if the lease doesn't offer it). A parked card whose `actions` has nothing known still shows Refresh, so no card is a dead end
- **Warning step** before Take over anyway and Turn off protection: the card's content is replaced, in the overlay's own DOM (no `window.confirm`, no ST popup), by a title, the warning line, the action's button and **Cancel** (back to the card). A new `leaseState` replaces it
- **Protection-off banner** (`state: 'off'`): a bar fixed under ST's top bar (`top: var(--topBarBlockSize)`, ST's own variable, E15; `z-index` below ST's top-bar drawers), centered at `--sheldWidth`, theme colors, accent border. Text: "Protection is off in this tab. If this keeps happening, please report it on GitHub with the steps that led to it, or uninstall the extension." ("GitHub" links to the repo's Issues page, new tab) and a **Turn protection back on** button. Stays visible while off; no overlay

**Design**

- A **centered card** (rounded, soft shadow, narrow, full width minus margins on small windows) on a **dimmed, blurred backdrop** (`::backdrop`, `backdrop-filter: blur(var(--SmartThemeBlurStrength))`)
- Content, top to bottom: a clear **title**, **one line** of text, then the buttons: the first (primary) **large, full-width, rounded**, the others smaller and plainer below it (transparent, border in `--SmartThemeBorderColor`), stacked
- While claiming (`claiming`, `waitingForReply`): a **spinner** instead of the primary button; any offered action (Take over anyway after 10 s) sits below it as a secondary button. Under `prefers-reduced-motion: reduce`, and under ST's own **Reduced Motion** setting (ST's `reduced-motion` class on `body`), the spinner doesn't rotate (a static indicator instead) and the card's fade-in is off
- **Colors from ST's theme variables** (confirmed in ST 1.19.1 `public/style.css`), so it matches the user's theme: card background `--SmartThemeBlurTintColor`, text `--SmartThemeBodyColor`, border `--SmartThemeBorderColor`, shadow `--SmartThemeShadowColor`, spinner accent `--SmartThemeQuoteColor`, font size `--mainFontSize`, transitions `--animation-duration`
- The button **builds on ST's `menu_button` class**, made full width and larger, with a **soft accent fill** (`--SmartThemeQuoteColor` mixed into `--SmartThemeBlurTintColor`), an accent border (`--SmartThemeQuoteColor`), text in `--SmartThemeBodyColor`, and a **stronger tint on hover and keyboard focus** that outranks ST's own `menu_button` focus fill
- **Focus:** the card takes the focus when the overlay opens (and when it's re-raised), not the button, so the button shows its focus tint only once tabbed to (Chrome ignores `autofocus` on the dialog)
- **Static markup built with DOM methods** (`createElement`, `textContent`); no HTML strings, no data in markup, no external fonts or assets. Styles in one `<style>` element the extension adds once, every rule scoped to the overlay's own class prefix
- No other change to ST's look

**Texts and buttons by `reason`** (buttons primary first, from `actionsFor`, E11)

| `reason` | Title | Line | Buttons |
|---|---|---|---|
| `held`, `lost` | In use on another device | Use SillyTavern here instead? | Use here |
| `claiming` | Taking over… | Loading your chat on this device. If your browser asks whether to leave the site, choose Leave. | spinner |
| `waitingForReply` | Finishing a reply… | Your other device is still writing a reply. After 10 s: "… If it has stopped responding, you can take over anyway." | spinner; after 10 s Take over anyway |
| `lostRace` | Another device took over | It claimed SillyTavern first. | Use here |
| `unreadable` | Can't reach SillyTavern | Nothing is saved from this page. Check that SillyTavern is running. | Use here, Refresh, Take over anyway, Turn off protection |
| `damaged` | The lease file is damaged | TravelingTavern can't read its lease file. Nothing is saved from this page. | Take over anyway, Refresh, Turn off protection |
| `error` | Something went wrong | TravelingTavern couldn't update its lease file. Nothing is saved from this page. | Refresh, Take over anyway, Turn off protection |
| `unknownFormat` | Update needed | Update the TravelingTavern extension to use SillyTavern here. | Refresh, Take over anyway, Turn off protection |
| `reloadPending` | Reload needed | Reload this page to finish taking over. | Refresh |

**Warning texts**

| Action | Title | Line | Confirm button |
|---|---|---|---|
| Take over anyway | Take over anyway? | Anything unsaved on your other device may be lost. | Take over anyway |
| Turn off protection | Turn off protection in this tab? | This page can save over newer changes from your other devices. | Turn off protection |

## 10. Model Connection After a Takeover Reload

ST connects to the model at startup only when its **Auto-connect** option is on (`power_user.auto_connect`, off by default). After a takeover reload the user would otherwise land in their chat unable to generate (R36).

- After a reload that follows **Use here** or the app's `onForeground()` claim (not the automatic claim: ST's own Auto-connect decides there), once `APP_READY` has fired and the page is holder: if `onlineStatus` is `no_connection`, the page presses ST's connect button for the selected API once (the buttons of ST's `RA_autoconnect`), by `main_api`: `kobold` → `#api_button`, `novel` → `#api_button_novel`, `textgenerationwebui` → `#api_button_textgenerationwebui`, `openai` → `#api_button_openai`. Any other API (e.g. `koboldhorde`) has none: nothing is pressed, the wait below still decides
- Already connected (e.g. ST's own Auto-connect got there first): nothing is pressed
- **Already connecting:** the selected API's button carries ST's `disabled` class (from `startStatusLoading()` until `stopStatusLoading()`, E15) → nothing is pressed (a press would start a second status check); the wait below still decides
- **End of ST's attempt:** `ONLINE_STATUS_CHANGED` to anything but `no_connection`, or else a bounded wait of **10 s** after the press, then `onlineStatus` decides (a failed attempt fires no event)
- Still not connected after ST's own attempt: the page reports `leaseNotice` `notConnected` (E11). Desktop shows one toast, "Not connected to a model. Connect in API Connections."; the app shows its native notice (A7) until `leaseState.connected` turns `true`
- `leaseState.connected` follows ST's `onlineStatus` (set at `APP_READY` and on every `ONLINE_STATUS_CHANGED`), on every page, not only after a takeover
- Reopening the chat (E4) doesn't wait for the connection
- **When the hooks attach** (reopen, reconnect, `connected`, `CHAT_CHANGED` → `active`): on desktop at once (the extension loads during ST's startup). In the app's page (injected at document start) on `load`; `getContext()` throws until ST's `script.js` resumes from its own `load` wait, which runs after the lease's listener (E15), so a context that can't be read on `load` is tried once more one task later (`setTimeout(0)`); still unreadable → a warning, no hooks (lease safety doesn't depend on them). `APP_READY` is auto-fired for late listeners, so nothing is missed
- Never changes ST's settings (doesn't turn Auto-connect on)

## 11. App Contract *(shared)*

Everything the app and the extension rely on from each other. Changing any of it is raised with the owner first and bumps `LEASE_VERSION`.

### Files

| File | Where | Role |
|---|---|---|
| `session-lease.js` | extension repo root | The lease core: a classic script, one IIFE, no `import` / `export`. The only copy; the app bundles it through its submodule (pinned tag) and injects it at document start (A2) |
| `index.js` | extension repo root | Desktop only: loads `session-lease.js`, shows the web overlay (E9), announces the extension |

### One lease instance per page (R40)

- `session-lease.js` installs once per page, in the main frame only, and **never on SillyTavern's login page** (URL pathname ending in `/login`, compared lower-case with trailing slashes ignored; the query string isn't part of the pathname). There the lease's files answer `403`, so it would park and hold the login request; the login page sends only ST's public `/api/users/*` requests. It defines `window.__ttLease` as non-writable and non-configurable; a second copy that finds it already defined **stands down completely** (no wrapper, no lease reads, no messages)
- **In the app's page** the bundled copy is injected at document start, so it is always first (and attaches its ST hooks on `load`, E10). An installed extension then stands down for the lease, but still announces itself (`window.__ttExtension`, `tt-extension-ready`) so `leaseInfo` can report its version
- **On desktop** `index.js` sets `window.__ttLeaseSource = 'extension'` and loads `session-lease.js`. A copy injected without that mark reports `source: 'app'`
- Where reports go: if the app's `TravelingTavern` listener exists, to the app (messages below); otherwise a `tt-lease` `CustomEvent` on `window`, for `index.js`. Its `detail` is `{ type, ...fields }`: `type` is the message type (`leaseState`, `leaseInfo` or `leaseNotice`) and the fields are that message's, below. `index.js` drives the overlay from `leaseState` and the toasts from `leaseInfo` (untested ST version, E12) and `leaseNotice`

### `window.__ttLease`

Frozen, defined once, before the wrapper is installed (an install error can't leave held requests behind dead buttons). Only the user can turn protection off, in one tab (`turnOffProtection`).

| Member | Meaning |
|---|---|
| `version` | `LEASE_VERSION`, an integer |
| `source` | `'app'` or `'extension'`: which copy runs in this page |
| `useHere()` | Use here: claims if parked and not already claiming (E4), then reloads. Returns a promise; outcome is reported through `leaseState` |
| `onForeground()` | The app returned to the foreground. Holder: confirm the lease is still its own, bump the epoch if its release marker matches (A5), else park. Parked: claim **only if the lease is released** (R43), else stay parked. Always reports `leaseState`, even when unchanged (unless a claim's reload follows; off: re-reports `state: 'off'`). Returns a promise |
| `takeOverAnyway()` | Take over anyway (E4), only while `leaseState.actions` lists it. The caller has shown the warning. Returns a promise (`ignored` when not offered; `forcing` during the wait for `busy`, whose claim then reloads); the outcome is reported through `leaseState` |
| `turnOffProtection()` | Turn off protection in this tab (E4), only while offered; the caller has shown the warning. Sets the flag and reloads. Returns `true` when it reloads, else `false` |
| `turnProtectionOn()` | Only while off: removes the flag and reloads protected. Returns `true` when it reloads, else `false` |
| `refresh()` | Refresh (E4, E7), only while offered: aborts held chat saves and reloads. Returns `true` when it reloads, else `false` |

Nothing else is exposed. No member takes arguments, and none can make a parked page writable without a claim and a fresh load (R4); turning protection off also goes through a fresh load.

### Messages to the app

Posted as JSON strings to the app's `TravelingTavern` listener, main frame only, in the app's envelope `{ "v": 1, "type": "...", ... }`. The app registers the listener for its saved server's origin only.

**`leaseState`**: sent once the start decision is made, on every change (holder ↔ parked, a new reason, `epoch`, `busy`, `actions`), and on every `onForeground()`, unchanged too (unless a claim's reload follows): the app's pre-check (A4) may have put up its own parked scrim and waits for the page to confirm. A load with protection off sends it once at install (`state: 'off'`).

| Field | Type | Meaning |
|---|---|---|
| `state` | `"holder"`, `"parked"` or `"off"` | `"off"`: protection is off in this tab (E4); the other fields are `null` / `false`, `actions` is `["turnProtectionOn"]` |
| `reason` | string or `null` | `null` when holder. Parked: `"held"` (another page holds the lease), `"lost"` (this page lost it), `"claiming"`, `"waitingForReply"` (claiming, waiting for the other page's `busy` to clear: R29), `"lostRace"` (another page claimed first), `"unreadable"` (a lease file couldn't be fetched: ST unreachable), `"damaged"` (a lease file answered 2xx but isn't valid: E2), `"error"` (lease writes kept failing while reads worked, or a lease-code error: E3), `"unknownFormat"` (a lease file in a newer format: this page's own copy is outdated, so in the app's page the app needs an update: E2), `"reloadPending"` (the reload after a claim didn't happen: E7) |
| `pageId` | string or `null` | This load's `holder` id (`<tab id>.<load id>`); `null` when off |
| `epoch` | integer or `null` | The epoch this page holds; `null` if it never held the lease in this load |
| `busy` | boolean | This page is generating a reply or waiting for its chat save (E8), with `busy: true` in the lease |
| `connected` | boolean | ST is connected to a model (`onlineStatus` isn't `no_connection`); the app shows its notice when a holder reports `false` after a takeover (E10, A7) |
| `actions` | array of strings | The ways out offered now, primary first: `"useHere"`, `"refresh"`, `"takeOverAnyway"`, `"turnOffProtection"`, or `"turnProtectionOn"` when off. Each calls the `window.__ttLease` member of the same name. Per reason: E9's table; `[]` for a holder and while `claiming`; `waitingForReply` gets `["takeOverAnyway"]` after 10 s. Readers ignore values they don't know |
| `origin` | string | `location.origin`, where Kotlin reads the lease files and sends its release |

**`leaseInfo`**: once per page load after the start decision, and again whenever `tt-extension-ready` fires.

| Field | Type | Meaning |
|---|---|---|
| `leaseVersion` | integer | `LEASE_VERSION` of the running copy |
| `extensionVersion` | string or `null` | Installed extension's `manifest.json` version (display only), from `window.__ttExtension` |
| `extensionLeaseVersion` | integer or `null` | Installed extension's `LEASE_VERSION` |
| `stVersion` | string or `null` | From ST's `/version`; `null` if it couldn't be read |
| `untestedServer` | boolean | `stVersion` outside `TESTED_ST_VERSIONS` (E12) |

The app compares the two versions in both directions (A8):

- `extensionLeaseVersion < leaseVersion`: the desktop extension is older than the app's copy → prompt to **update the extension**
- `extensionLeaseVersion > leaseVersion`: the extension is newer than the app's bundled copy → prompt to **update the app**
- `extensionLeaseVersion` `null`: no extension installed → offer to install it

It also uses `leaseVersion` to confirm its page runs the current code (R26, A2).

**`leaseNotice`**: a one-off event the user should hear about, sent once each time it happens.

| Field | Type | Meaning |
|---|---|---|
| `kind` | string | `"replyNotStarted"`: `busy: true` couldn't be written, so the generation request wasn't sent (E3, E8). `"notConnected"`: after a takeover reload ST is still not connected to a model after the page's connect attempt (E10) |

Readers ignore a `kind` they don't know. Desktop shows the toast for each kind (E3, E10); the app shows its native notices (A7).

### `window.__ttExtension`

Set by `index.js` before it loads (or stands down for) `session-lease.js`: `{ version: "<manifest version>", leaseVersion: <integer> }`, frozen. Then it fires `tt-extension-ready` on `window`.

### CSRF token for the app's release (R42)

The page never sends ST's CSRF token in a message. For the background release, Kotlin fetches its own from `GET /csrf-token`; ST returns the session's existing token, so the page's keeps working (app spec A5).

### Versions

- **`LEASE_VERSION`** (integer, in `session-lease.js`): bumped on every change to lease behavior or to this contract. The app compares it; it never parses `manifest.json`'s version
- **`format`** (E2): bumped only when the files change incompatibly
- **`manifest.json` version** (`MAJOR.MINOR.PATCH`): the release shown to users; this spec ships as `0.2.0`
- **Release candidates and tags:** see `CLAUDE.md` → Versioning

### Names

`window.__ttLease` (incl. `takeOverAnyway`, `turnOffProtection`, `turnProtectionOn`, `refresh`), `window.__ttLeaseSource`, `window.__ttExtension`, `tt-extension-ready`, `tt-lease` (and its `type` field), `leaseState`, `leaseInfo`, `leaseNotice`, `LEASE_VERSION`, `TESTED_ST_VERSIONS`, `session-lease.js`, `tt-session-lease.json`, `tt-session-release.json`, the `TravelingTavern-Extension` folder, the app's `TravelingTavern` listener.

The app's own `window.__ttBridge` is not part of this contract.

### What the contract never does

- Pass ST data, the CSRF token or anything from chats, cards, lorebooks or settings to the app. Messages carry only the fields above
- Turn the lease off, skip the wrapper, or make a parked page writable without a claim and a fresh load, except by the user's tap after a warning (Take over anyway: a claim and a reload; Turn off protection: this tab only, after a reload). The one internal exception is resume after a freeze (E7)
- Log content: logs carry the kind of event, the reason, endpoint paths and counts only

## 12. Version Check

- `TESTED_ST_VERSIONS` in `session-lease.js`: the ST versions this lease was tested against, starting with **1.19.0 and 1.19.1** (the spike). Read from ST's `/version` at start
- The lease depends on ST's names in four lists: the allowlist (E6), the chat-save paths (aborted before a reload, E7; ending the save wait, E8), the generation endpoints (E8) and the connect buttons (E10). Everything else is held or checked whatever its name
- **Untested ST version:** the allowlist is turned off (every request is checked: slower, never less safe); `leaseInfo.untestedServer` is `true`; desktop (`index.js`, from the `leaseInfo` event) shows one toast, without a title: "TravelingTavern hasn't been tested with this SillyTavern version." Only on a holder page (on a parked page it would sit behind the overlay), once per ST version per browser (the version shown is remembered in `localStorage`; if storage is blocked, it shows again on the next load). Chat-save and generation paths stay as they are: if ST renamed them, a reload may show "Leave site?", `busy` clears only at the 3 s bound after each reply, or a takeover may not wait for a reply; the checklist (E14) catches all three before the version is added
- On every ST release: re-check the four lists in ST's source (`ext-0.2-st-source-notes.md`), run the checklist on the test install, then add the version

## 13. Known Limits

| Limit | Effect | What would close it |
|---|---|---|
| Pages without the lease code (a desktop browser without the extension, the extension disabled, other ST clients, scripts) | They write freely | A server plugin that enforces the lease on the server |
| A write slower than the grace period plus the new holder's reload | It could land after the new holder loaded (not seen, incl. a 3 MB save) | Server plugin: refuse writes from a page that isn't the holder |
| Release is best effort | A crash leaves the lease held; the next page needs Use here | — (by design) |
| WebSockets from third-party extensions or server plugins (R31; ST itself has none, E15) | The wrapper doesn't see them | Server plugin, or wrap if one is found |
| A page that parked while a message was being edited | "Leave site?" on the takeover reload (`this_edit_mes_id >= 0`, not cleared by aborting chat saves); discarding the stale edit is correct. Desktop: the overlay says to choose Leave (E9). App: confirms `onJsBeforeUnload` itself, only during a takeover reload (A2) | — |
| Memory Books writes default files in the holder when a read fails transiently (R32) | A transient server error can reset that extension's files | Outside the lease; report to Memory Books |
| Switch cost (R22, measured) | Desktop about 3.3 s, phone about 6.6 s from Use here to the reopened chat; about 1.8 s of the phone's is the lease (grace and checks), the rest ST reloading | Server plugin (no reload needed) |
| A holder that doesn't yet know it lost the lease still releases on `pagehide` (it can't read the lease while leaving) | Its stale marker overwrites the real holder's, so the next page needs **Use here** (one click). Never data: a stale marker frees nothing | Server plugin |
| A holder that stops without `pagehide` or `freeze` (a crash, a killed process, a discard that skips freezing first; frozen-then-discarded tabs release on `freeze`, E5) | No marker: the next page needs **Use here** | — (release stays best effort) |
| Chrome's automatic (proactive) discards may skip the `freeze` event (untested: only an urgent discard could be triggered) | No marker: the next page needs **Use here** | Investigate if seen; release stays best effort |
| A reply can't move to another device | A takeover waits for the reply (up to 60 s), then reloads | — |
| Horde text replies are asynchronous: `/api/horde/generate-text` only submits the job, the reply comes from later `/api/horde/task-status` polls (E15) | A takeover doesn't wait for a Horde reply; its polls and save are held once the old page parks, and the reply is lost (never data) | Track Horde's polling, or a server plugin |
| Group chats aren't reopened after a takeover (ST's context has no function that selects a group; E4) | Desktop lands on ST's start screen; `active` keeps the group. The app reopens groups by its own `chatFile` route | A group-select function in ST's context, or a dynamic import of ST's `group-chats.js` (owner decision) |
| ST's Auto-load chat can win the startup race: its `active_character` / `active_group` setting comes from ST's settings file, and if the old holder's settings save didn't land, it may open a different chat while the reopen runs (neither is awaited) | The page may end on the auto-loaded chat, recorded as `active`. Never data | — |
| A chat file deleted outside ST's normal flow (on disk, or by another client), while the lease still names it | The reopen starts it again, empty (ST's `getChat` for a missing file) | — (accepted; no guard) |
| ST's Custom (OpenAI-compatible) chat completion source bypasses its status check (`onlineStatus` "Status check bypassed") | Counts as connected with the model down: no `notConnected` notice; the first reply fails in ST as usual | — (ST's own behavior) |
| ST doesn't save after every reply end (a failed or errored generation, a quiet generation; on a hidden page its save wait can time out and skip the save: E15), and a save can take longer than 3 s (slow extension handlers on `MESSAGE_RECEIVED`, a hidden page's slowed timers) | Up to 3 s of needless waiting when no save comes; a save later than 3 s can still lose the reply (never data); a skipped save leaves it unsaved whatever the lease does | Server plugin, or a longer bound if seen |
| A failed `busy: false` on a holder that then goes idle (no further lease write or check to carry it) | One claimer can wait the full 60 s cap | Server plugin, or the holder retrying on its next activity (already the rule, E3) |
| A damaged lease or release marker (a truncated write, a hand edit, a disk problem) | Every page parks (`damaged`); Use here can't build on it | **Take over anyway** (E4) writes a fresh claim (and a fresh marker if that one is damaged) |
| Take over anyway while the other device is still writing (a reply, a save in flight, or a holder that isn't really stuck) | That device's unsaved work is lost: its reply's save and later writes are held once it parks; a write already in flight may still land within the grace | — (the user's choice after the warning) |
| Take over anyway over an unknown (newer) `format` | The file is rewritten in this copy's format. Pages of the newer copy read it if they still know that format; the older copy keeps working until it updates | Update the outdated side (E2) |
| A tab with protection off (E4) | It writes like a page without the lease: it can save over newer changes from other devices, and no other page knows it is writing (it holds no lease and parks nobody). The banner stays visible and asks for a report | — (the user's last resort after the warning); a server plugin could refuse its writes |
| A duplicated tab copies `sessionStorage`, so a duplicate of a tab with protection off is off too | Two unprotected tabs; both show the banner | — (Turn protection back on in each) |
| A server that accepts the connection but never answers | Each lease read or write waits up to 10 s, then counts as "can't reach" (`unreadable`, with its ways out, E2). A claim whose three writes all hang can take about 30 s to show them; a write aborted at the bound can still land later (found by the next re-read) | — (the bound, E2) |

## 14. Tests

**Unit** (`node --test`, no dependencies, fake `fetch`, one file per topic under `test/`). The lease's decisions are pure functions inside `createSessionLease({ fetch, post, now, sleep, storage, log })`; the browser wrapper stays thin.

- `files`: reading both files (E2): 404 vs unreadable vs damaged, malformed JSON, missing and unknown fields, unknown or missing `format`, released only on an exact pair match
- `pair-rule`: every decision compares (`holder`, `epoch`), never the epoch alone (E2)
- `writes`: one write in flight, re-read first, 3 attempts 100–200 ms apart, unchanged writes skipped, outcomes per write type after all retries (E3)
- `claim`: busy wait (60 s cap, skipped when released, changed pair → `lostRace`), claim write, grace, verify, lost race, reopen flag (E4)
- `start-decision`: own tab → epoch bump with `busy: false`; free or released → automatic claim, once per tab; otherwise parked; refresh and duplicated tab (E4)
- `release`: marker on `pagehide` and `freeze`, back/forward cache, the check on `resume` after a `freeze` (E5)
- `actions`: `actionsFor` for every reason (primary first, every error state has Refresh), Take over anyway on `waitingForReply` from 10 s and the `leaseState` re-posted once then, nothing for a holder or a released page (E9, E11)
- `force-claim`: Take over anyway on a damaged lease, an unknown format, a busy lease (offered at 10 s, ends the wait), a new holder id of this tab, marker repair, the old holder parking by the pair rule, verify and a lost race after it, writes that keep failing (`error`), an unreachable server (`unreadable`), not offered → ignored (E4)
- `off-mode`: Turn off protection only when offered, the per-tab flag (survives a refresh, cleared by Turn protection back on), the one-load `window.name` fallback (only on a reload without working storage; another site's window name ignored), the stood-down page (no wrapper, no lease I/O, `state: 'off'`), `refresh()` (E4, E11)
- `wrapper`: what counts as server data, holder vs parked, 2 s read window, allowlist on and off, held requests never settle, only chat saves aborted, `sendBeacon` refused while parked, requests wait for the start decision (E6, E7)
- `reload`: held chat saves aborted and ST's handlers run before the reload; a reload that doesn't happen ends in `reloadPending` (E7)
- `busy`: generation requests sent only after `busy: true` is confirmed, `AbortError` and `replyNotStarted` when it can't be written, cleared only when the response is over and then a chat save started after that end has completed (any status) or at the 3 s bound, a new reply during the wait, parked during the wait, overlapping generations, the headers fallback, writes behind the page's own bump (E8)
- `claim` also: a claimer waiting on `busy` claims only after the holder's chat save (E8)
- `csrf`: the lease's own CSRF token, fetched again once on 403, a hung token fetch ended at the 10 s bound; ST's `/csrf-token` ordered after it (E6)
- `timeout`: the 10 s lease I/O bound: a hung read at start (`unreadable`, ways out), a hung write in a claim (`unreadable`, not `error`), a write that lands after its timeout (found by the re-read; after the page gave up it stays parked), a hung read in the wait for `busy`, Take over anyway with ST not answering (E2, E3)
- `foreground`: `onForeground` for a holder (bump that invalidates its own marker) and a parked page (claims only a released or missing lease); always one `leaseState`, unchanged too (E11, app A5)
- `instance`: one instance per page, main frame only, never on the login page, frozen `window.__ttLease` with the contract's members, defined before the wrapper (an install error leaves working buttons), desktop-only release wiring, a prerendered page never decides and reloads when shown, `index.js` versions match (E4, E11)
- `messages`: `leaseState`, `leaseInfo` and `leaseNotice` payloads, to the app and as `tt-lease` with `type`; no CSRF token or ST data (E11)
- `overlay`: what `index.js` shows for each report: overlay texts and buttons per reason (from `actions`), damaged vs unreachable, the 10 s line, the warning step, the banner, toasts (E9, E10, E12)
- `reopen`: the reopen flag, character reopen and its guards, group and deleted character → start screen, recording `active` (incl. behind the page's own bump) (E4)
- `connect`: connect press only after Use here / onForeground and only while not connected or connecting, button by `main_api`, `notConnected` after the 10 s wait, `connected` tracking, hooks on desktop and at document start, incl. a context that throws on `load` and works one task later (E10)
- `setup`: `manifest.json` points at `index.js`

**Manual checklist, on the separate test install only** (never the real server: `CLAUDE.md` Hard Rules). Throwaway persona, lorebook, character and chat; Memory Books installed.

- [ ] Two pages: the second parks; a stale page's chat, persona, card, lorebook and settings saves never reach the server
- [ ] Use here: same chat reopened; switch time recorded. A group and a deleted character: start screen, logged. With ST's Auto-load chat on: the reopened chat wins
- [ ] Two simultaneous Use here: exactly one holder
- [ ] Takeover while generating (holder tab in front and in the background): claimer waits, reply saved before its claim lands. No model connected, and Stop: no stuck `busy` (cleared after the save or at the 3 s bound)
- [ ] Save queued just before a takeover: held, or saved and visible in the new holder
- [ ] Holder refresh: stays holder, epoch bumped. Duplicated tab: the older copy parks
- [ ] Close the holder: the next tab claims without a click. Close an old tab after a takeover: the lease is untouched
- [ ] Back/forward cache: a restored holder parks and reloads; a write at restore never reaches disk
- [ ] Freeze, then discard, the holder (`chrome://discards`): a marker for its exact pair each time; the next tab claims without a click; a resumed tab with no claim since holds again at `epoch + 1` without a reload; a resumed tab after another page claimed parks (`lost`)
- [ ] Held chat save before a reload: no "Leave site?"
- [ ] Parked tab with Memory Books: held reads stay pending, no default files written
- [ ] ST popup open before and after parking: overlay on top, Use here works
- [ ] Overlay design: card, blurred backdrop, theme colors in a light and a dark ST theme; spinner static under reduced motion
- [ ] Server unreachable: pages park, nothing sent after the restart
- [ ] Lease write `EPERM` (Windows): retried, no false park
- [ ] Unknown `format` in the lease file: page parks with the update message, writes nothing
- [ ] Untested ST version: toast once, every request checked
- [ ] Damaged lease file: "The lease file is damaged"; Take over anyway (warning, Cancel, confirm) → holder, the other tab parks. Unknown format: Refresh, then Take over anyway → format 1, marker repaired, other tabs park as held. Writes that keep failing (lease file locked): "Something went wrong"; Refresh after the lock is gone parks normally
- [ ] Take over anyway during a reply: offered at 10 s, the claim lands right after the tap; the other device's reply is lost (its save held)
- [ ] Turn off protection: warning, banner, requests go through unwrapped, the lease files untouched; Refresh → still off; other tabs protected; Turn protection back on → protected, parks or claims normally
- [ ] Server unreachable: "Can't reach SillyTavern" (not the damaged text); Take over anyway while down stays `unreadable`. Server paused (accepts, never answers): "Can't reach SillyTavern" after about 10 s
- [ ] Prerender: after a release, a typed address that Chrome prerendered (`activationStart` above 0) reloads when shown and becomes holder with no click
- [ ] Model connection restored after a Use here reload; not pressed after an automatic claim at start. A backend that can't connect (not the Custom source, which bypasses its check): one `notConnected` toast within about 10 s
- [ ] The app's checks: app spec checklist

## 15. Verified in SillyTavern's source

Source findings per ST version: `ext-0.2-st-source-notes.md`. Re-check them on every ST release (E12).
