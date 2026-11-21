# TravelingTavern Extension `v0.2.0` — Session Lease

Requirements: `context/decisions/session-lease-spike.md` (cited as **R1–R44**). Requirement map: `session-lease-spike.md` → Requirement Map (final). App side: the TravelingTavern repo's `session-lease-app-spec.md`, which references this spec for every shared definition and never restates it.

## 1. Purpose and Rule

**Rule:** nothing TravelingTavern runs may delete or overwrite SillyTavern (ST) data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

**Problem:** an ST page reads data once and later saves whole files from its own copy. A page left open on one device erases what another device saved since (seen for chats, settings, lorebooks, personas and extension files).

**Design: one active page per ST user.** A small lease file names the page that may write. Every other page is **parked**: it shows an overlay with **Use here**, and its requests to the server are held, never sent. Use here claims the lease and reloads the page, so it starts from fresh data. The lease needs no knowledge of which endpoints save what; the per-save guard it replaces did (why, and the evidence: `context/decisions/session-lease-spike.md`).

**Scope:** every page that runs `session-lease.js`: desktop tabs with this extension installed, and the TravelingTavern app's page (bundled copy, app spec). Pages without it are not protected (E13).

## 2. Lease and Release Files *(shared contract)*

Two small JSON files in the SillyTavern (ST) user's files. They belong to one ST user (each user has their own files), so the lease is **one active page per ST user**.

| | Lease | Release marker |
|---|---|---|
| Name | `tt-session-lease.json` | `tt-session-release.json` |
| Read | `GET /user/files/<name>` | same |
| Written by | the page that claims; then only the holder (E3) | only the holder that is releasing (E5, app: A5) |
| Means | who may write to SillyTavern now | "this exact claim was given up" |

### Reading

- Uncached every time: page `fetch(url, { cache: 'no-store' })`; Kotlin sends `Cache-Control: no-cache`
- **404 = the file doesn't exist.** Any other non-2xx, a network error, a body that isn't a JSON object, or a missing or mistyped required field = **unreadable**. Unreadable is never "missing" and never "free": the page parks (R11)
- The lease is read through the original `fetch`, never through the wrapper (R1)

### Writing

- `POST /api/files/upload` with the CSRF token the lease fetched itself (E6), body `{ "name": "<file name>", "data": "<base64 of the UTF-8 JSON>" }`. ST writes the file atomically (temp file + rename)
- A write can fail transiently (Windows refuses the rename while another handle has the file open: `EPERM`, answered as 500). Retry rules: E3
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
- The marker never changes the lease. A late or stale marker (a closed tab's old claim, a frozen app thawing) names an epoch that no longer matches and means nothing
- A released claim's `busy` is stale and is not waited for (R15, E5)
- The marker is overwritten by the next release, never deleted

### No lease yet

No lease file (404) = free: the page claims (E4). A missing marker with a lease present = not released.

### `format`

- Every page knows a set of formats it can read, and writes only the newest format it knows
- **A page that reads a format it doesn't know parks** (fail closed, R41): it doesn't claim, doesn't offer Use here, and never writes over the file. Its parked state names the outdated side, which is always its own copy: the extension on desktop (`source: 'extension'`), the app in the app's page (`source: 'app'`). See `leaseState` reason `unknownFormat` (E11)
- A missing `format` is an unknown format.
- **`format` changes only for a change that would make an older reader decide wrongly** (a field whose meaning changes, a new field that a decision depends on). Additive fields that older readers can safely ignore don't bump it
- Why so strict: the app's bundled copy lags the extension (it updates with app releases, the extension with `git pull`), so the two regularly run different versions against one file. A `format` bump locks the older side out until it updates
- `format` is separate from `LEASE_VERSION` (E11), which changes with any lease behavior

### Time

No decision uses a clock time from the files: devices' clocks differ (seconds apart in the spike). `claimedAt` and `releasedAt` are for people reading the files.

## 3. Lease Writes

- **One write in flight at a time** (R24): claims, epoch bumps and `busy` / `active` updates go through one queue in the page. Otherwise an update that read the lease before an epoch bump can write the old epoch back
- **Every update re-reads first** and writes only if the lease still holds this page's pair (E2). Pair changed → park (`lost`) at once; unknown format → park (`unknownFormat`) at once. An unreadable or missing (404) lease may be transient: it counts as a failed attempt (below)
- **Bounded retry** (R7): a failed write (e.g. Windows `EPERM`, answered as 500) is retried after a random 100–200 ms, at most 3 attempts in total, re-reading before each. An unreadable or missing re-read is a failed attempt too, retried the same way. The page parks at once only if the pair changed or the format is unknown. If the last attempt's re-read was unreadable or missing, the page parks (`unreadable`, or `lost` for a missing lease), whatever the write type. When all 3 attempts fail at the write:
    - **claim or epoch bump** → the page isn't holder: it parks (`unreadable`)
    - **`active`** → the page stays holder; logged (only reopening the chat after a takeover is affected)
    - **`busy: true`** → see below. A `busy: false` stays pending as for `busy: false`: the failed write may still have landed (an error answer after the write), and no reply was started
    - **`busy: false`** → the page stays holder and keeps the pending `busy: false`: it is written with the holder's next lease write or lease check, until it lands, so the file never stays `busy: true` after a reply
- **Skip unchanged writes:** no write when `busy` and `active` already have the values to be written
- **A failed `busy: true` is not just metadata:** claimers wouldn't wait for the reply. The generation request is sent only after `busy: true` is written and confirmed (E8). If that write fails after the retry above, the request is **not sent**: the wrapper rejects it with an `AbortError` (as ST's Stop would), so ST ends the generation, and the page reports `leaseNotice` `replyNotStarted` (E11): desktop shows one toast, "Couldn't reach SillyTavern to start the reply. Try again."; the app shows its native notice (A7)
- One-off delays (this retry, the grace wait in E4, the CSRF ordering wait in E6, the reload's one-task wait and 2.5 s fallback in E7, the 10 s connect wait in E10) are bounded and allowed; no repeating timers (`coding-standards.md`, R34)

## 4. Claim and Takeover

**Claim** (Use here, an automatic claim at start, or the app's `useHere()` / `onForeground()`):

1. Read the lease and the marker. Unknown format → park (`unknownFormat`) and stop
2. **Wait for `busy`** (R6, R35) unless the lease is released (its `busy` is stale) or there is no lease: re-read once per second for at most 60 s while the lease is `busy`, reporting `waitingForReply`. During the wait, a lease whose pair changed (another page claimed) parks this page (`lostRace`); a lease that becomes released ends the wait and the claim continues. This is the one named exception to "no polling" (`coding-standards.md`): bounded, only during a claim, ends at 60 s. A `busy` that can never clear (R19) is prevented by E8, not waited out
3. Write `{ format, holder: own id, epoch: lease.epoch + 1 (1 if no lease), claimedAt, busy: false, active: carried over }`
4. **Grace:** wait 1 s, so a write the old holder already sent lands before this page loads
5. **Verify:** re-read; continue only if the lease holds this page's pair, else park (`lostRace`). Two pages claiming at once end with exactly one holder: the last write wins, the other's verify fails
6. Set the reopen flag (`sessionStorage`), abort held chat saves (E7), reload

**Start decision** (every page load; requests wait for it, E6):

- Lease's holder has this tab's id as its tab part (everything before the first dot): a refresh, or a duplicated tab that copied `sessionStorage`. **Always bump the epoch** to `(this load's holder, epoch + 1)`, with `busy: false` (no reply can be running in a fresh load), and verify after the grace (pair rule, E2) before becoming holder. The newest load in that tab wins; an older page of the same tab fails its next pair check and parks. Because each load has its own holder, two loads of one tab can never write and verify the same pair (e.g. the original's Use here claim and the duplicate's bump, both at `epoch + 1`)
- **A duplicated tab** bumps the epoch like a refresh, so it takes over from the original without a click, and the original parks at its next write. This is intended
- On desktop, SillyTavern's first reads happen before the extension loads (E6), so the start bump's grace doesn't fully cover a save a duplicated tab's original still has in flight
- No lease, or the lease is released → **automatic claim** (steps 1–6, no click), at most once per tab between successful loads (a `sessionStorage` mark prevents a reload loop). The mark is cleared when a load becomes holder, and when the automatic claim ends without a reload (parked, lost race), so a later load in that tab can claim a free lease again
- Otherwise → parked (`held`). Lease or marker unreadable → parked (`unreadable`)

**Reopen the chat** (R10, R30): after a reload that follows any claim (Use here, automatic or onForeground), once ST fires `APP_READY` and the page is holder, open the `active` the lease held when this load became holder, with ST's context functions (`SillyTavern.getContext()`, read fresh each time: it returns a snapshot), the same steps as ST's own "open recent chat":

- **Character:** `selectCharacterById(index of avatar)`, then `openCharacterChat(chatFile)` if `chatId` isn't that chat. Only if the character really is selected afterwards: ST skips the switch while a save or a reply runs, and `openCharacterChat` would then change the wrong character's chat
- **Group → stays on ST's start screen** (logged). ST's `openGroupChat` needs the group already selected, and the function that selects it (`openGroupById`) isn't in ST's context; the lease imports no ST modules. The app reopens groups through its own `chatFile` route (E13)
- A character that no longer exists → start screen (logged)
- The reopen flag (`sessionStorage`) is read and removed when the page loads, so only the load right after the claim reopens; a load that ends up parked reopens nothing
- While the reopen is pending (from the load until it is over), `CHAT_CHANGED` doesn't write `active`: ST's startup chat changes (none, or ST's own Auto-load chat) would overwrite the chat still to be reopened. When it is over, the chat then open is recorded; without one (start screen) `active` stays as it was

**Recording the open chat:** on `CHAT_CHANGED` the holder writes `active` (E3; skipped when unchanged): `{ avatar, chatFile }` for a character, `{ groupId, chatFile }` for a group, `null` without a chat.

## 5. Release (desktop)

Best effort, so closing the holder doesn't cost the next page a click (R15). The app releases differently: app spec A5.

- On **`pagehide`**, and on the Page Lifecycle **`freeze`** event (on `document`). Not on `beforeunload`, which fires before a "Leave site?" prompt the user may cancel. Only a holder releases; a parked page reloading after a claim never does
- **Why `freeze`:** Chrome freezes idle background tabs and may then discard them (memory saver, low memory). A discarded tab never fires `pagehide`, so `freeze` is the last moment it runs code. The marker's request is sent synchronously from the handler (before any `await`); `keepalive` lets it finish while the page is frozen. Seen twice on the test install before this: an idle background holder closed later left no marker
- Sent with `fetch(..., { keepalive: true })` through the original `fetch` with ST's request headers (not `sendBeacon`: the upload needs the CSRF header). Body: the release marker (E2) naming this page's exact pair. Never touches the lease
- **A refreshed holder** finds its own marker matching; the always-bump at start (E4) makes it stop counting (R16)
- **Back/forward cache** (R17): `pagehide` also fires when a page enters the cache, so a holder restored from it (`pageshow` with `persisted`) has released its claim. It parks at once (holds everything) and reloads; the fresh load decides as in E4
- **Resumed after a freeze** (`resume` on `document`): the same check as the app's foreground holder path (`onForeground`, A5), **no reload** (Chrome freezes background tabs routinely; a reload would cost the user unsent text). The page that released on `freeze` re-reads the lease and the marker:
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
| Before the start decision (R18) | Waits for it, then as below |
| Holder, non-`GET`, not allowlisted | Re-reads the lease first (pair check); sent only if still holder, else the page parks and holds it |
| Holder, `GET` or allowlisted | Sent if the last lease read is at most 2 s old; otherwise re-read first, as above (R5, R21) |
| Parked | **Held** (R2): never sent, never refused |

- **Exempts nothing** (R1): no request passes by URL while parked. The lease's own reads and writes use the original `fetch` captured at install, so they never pass through the wrapper
- **Held** fetches return a promise that stays pending; only their path and reject function are kept, never the request, so no code path can send one later. Held XHRs are never sent and never complete. Refusing instead broke ST's startup in the spike
- **A held fetch whose own `AbortSignal` fires** (e.g. ST's Stop) is rejected with an `AbortError` and removed from the held set at once, so it can never be sent, even after the page holds the lease again
- **`navigator.sendBeacon`** returns `false` without sending unless the page is holder (it can't wait for a lease check; ST doesn't use it)
- **CSRF token** (R42): the lease fetches its own token once at install, `GET /csrf-token` through the original `fetch` (served before ST's login check; `csrf-sync` returns the session's existing token without overwriting it, E15). Kept in memory only, never logged, never in a message. A lease write answered `403` fetches the token again once and resends
- **CSRF ordering:** the session lives in a cookie, so two token requests on a session without a token yet would each create one and the later cookie wins. ST's own `GET /csrf-token` therefore waits until the lease's token fetch has finished, at most **2 s**, then is sent (never held), so ST's startup never stalls
- **Fail closed** (R11): a lease read that fails parks the page and holds the request
- **Allowlist** (R21): read-only `POST` endpoints, each confirmed read-only in ST's source for every tested ST version, kept in a named constant. Confirmed for 1.19.0 and 1.19.1 (E15): `/api/settings/get`, `/api/characters/all`, `/api/characters/get`, `/api/groups/all`, `/api/chats/get`, `/api/chats/group/get`, `/api/chats/recent`, `/api/worldinfo/get`, `/api/avatars/get`, `/api/backgrounds/folders`, `/api/image-metadata/all`, `/api/secrets/read`, `/api/stats/get`, `/api/sd/comfy/workflows`, `/api/tokenizers/*/encode`, `/api/tokenizers/*/count` (`*` is one path segment). **Not** `/api/backgrounds/all`: it rewrites `image-metadata.json`. Anything not listed is checked. Allowlisted requests are still held while parked. On an untested ST version the allowlist is off (E12)
- **Before the extension loads** (desktop) ST sends only reads (`/csrf-token`, `/version`, `/api/secrets/read`, `/api/settings/get`, `/api/extensions/discover`; seen on 1.19.0 and 1.19.1). In the app the bundled copy is installed at document start, before any of them
- **WebSockets** (R31, checked, E15): ST 1.19.0 / 1.19.1 has no WebSocket endpoint and opens none; streaming reads fetch bodies; no `sendBeacon`, workers or form posts. Third-party extensions and server plugins could still open one (E13)

## 7. Parking and Reloads

- **A page becomes writable only through a fresh load that holds the lease** (R4): the start decision (E4) is the only place a page unparks. A page that lost the lease never re-claims by itself; it offers Use here, which claims and reloads
- **One exception: resume after a freeze** (E5). A desktop page that released on `freeze` holds again without a fresh load when the lease still holds its exact pair. Safe for the same reason as the app's `onForeground` (A5): an unchanged pair means no other page claimed since, so its copy of the data is still the newest. It still bumps the epoch and verifies (pair rule) first, and requests wait for that check
- Parking is immediate: from that moment every new server-data request is held
- **Before any reload, abort only held chat saves** (R3): held `/api/chats/save` and `/api/chats/group/save` are rejected with an `AbortError`, so ST's `isChatSaving` clears and its `beforeunload` doesn't block the reload with "Leave site?". These paths are a named constant (E15). **Then wait one task (`setTimeout(0)`) before reloading:** ST clears the flag in its save handlers, which run only after the rejection; reloading in the same step let `beforeunload` cancel the reload on a page with a user click (seen on the test install, 1.19.1)
- **A reload that didn't happen** (cancelled by ST's `beforeunload` or the user): a page still alive **2.5 s** after asking for it parks as `reloadPending` (E9), whose **Reload** button calls `location.reload()` from the click. It never stays in `claiming`. No new claim: the fresh load decides (E4)
- **Held reads are never aborted:** an extension that sees a failed read may write a default file (Memory Books did, through the spike's exemption). They stay pending until the page unloads
- No held request is ever sent, before or after a reload

## 8. `busy`

`busy` tells claimers the holder is generating a reply (R8, R19).

- **Tied to the generation request itself,** not to ST's `GENERATION_STARTED` event, which also fires for dry runs and, when a generation fails before it starts, has no end event. The wrapper holds a request to a generation endpoint until `busy: true` is written and confirmed (E3), then sends it; it writes `busy: false` only when that response is over: the body fully read or the stream closed, an error, or the read cancelled (Stop). **Never when the headers arrive:** a streaming reply continues long after them. Dry runs and generations that fail before sending never set it
- Generation endpoints, a named constant (checked per ST version, E15; confirmed for 1.19.0 and 1.19.1): any `/api/backends/*/generate` (so a new backend still sets `busy`; today `chat-completions`, `text-completions`, `kobold`), plus `/api/novelai/generate` and `/api/horde/generate-text`
- If `busy: true` can't be written after the retries, the request isn't sent (E3)
- **Fallback:** the end of a response is seen by passing its body through a stream of the lease's own (a rebuilt `Response`). If the `Response` can't be rebuilt, `busy: false` is written at the headers instead and a warning is logged, so `busy` never sticks (the reply may still be streaming; a claimer could then not wait for it)
- `busy` written by an epoch bump (resume after a freeze, the app's foreground bump) comes from this page's own generations in flight, never copied from the lease: a reply that ended while the page was released wrote no `busy: false`. A `busy` write that finds the lease at this page's own newer pair (its bump landed first in the queue) retries once with that pair, as the request check does
- Several generation requests at once (e.g. an extension's background summary during a reply): `busy` stays `true` until the last one finishes
- Written through the lease-write queue (E3); a failed `busy: true` → E3
- A released claim's `busy` is ignored (E5). The wait itself is bounded at 60 s (E4)

## 9. Web Overlay (desktop)

Shown by `index.js` from `tt-lease` events of type `leaseState` (E11). **Overlay only, no toast** for parked tabs. Never shown in the app's page.

**Behavior**

- A `<dialog>` opened with `showModal()`, covering the window, so it sits above ST's loader and popups and everything under it is inert. Whenever another dialog opens while parked (ST popups are modal), the overlay is closed and re-opened so it is the top modal again and **Use here** stays clickable. Escape can't close it
- **Use here** calls `window.__ttLease.useHere()`

**Design**

- A modern **centered card** on a **dimmed, blurred backdrop** (`::backdrop` with a translucent dark tint and `backdrop-filter: blur(var(--SmartThemeBlurStrength))`, ST's `--blurStrength` in px)
- Card: rounded corners (about 16 px), soft shadow, comfortable padding, max width about 360 px, full width minus margins on narrow windows
- Content, top to bottom: a clear **title**, **one line** of text, then a **large, full-width, rounded "Use here" button**
- While claiming (`claiming`, `waitingForReply`): a **spinner** replaces the button. Under `prefers-reduced-motion: reduce`, and under ST's own **Reduced Motion** setting (ST's `reduced-motion` class on `body`), the spinner doesn't rotate (a static indicator instead) and the card's fade-in is off
- **Colors from ST's theme variables** (confirmed in ST 1.19.1 `public/style.css`), so it matches the user's theme: card background `--SmartThemeBlurTintColor`, text `--SmartThemeBodyColor`, border `--SmartThemeBorderColor`, shadow `--SmartThemeShadowColor`, spinner accent `--SmartThemeQuoteColor`, font size `--mainFontSize`, transitions `--animation-duration`
- The button **builds on ST's `menu_button` class** with overrides for size (full width, larger padding, larger radius, larger text; `menu_button` defaults to `width: min-content` and `border-radius: 5px`) and for contrast: a **soft accent fill** (`color-mix(in srgb, var(--SmartThemeQuoteColor) 25%, var(--SmartThemeBlurTintColor))`), an accent border (`--SmartThemeQuoteColor`), text in `--SmartThemeBodyColor`, and a **stronger tint on hover and keyboard focus** (40%), which outranks ST's own `menu_button` focus fill
- **Focus:** the card takes the focus when the overlay opens (and when it's re-raised), not the button, so the button shows its focus tint only once tabbed to (Chrome ignores `autofocus` on the dialog)
- **Static markup built with DOM methods** (`createElement`, `textContent`); no HTML strings, no data in markup, no external fonts or assets. Styles in one `<style>` element the extension adds once, every rule scoped to the overlay's own class prefix
- No other change to ST's look

**Texts by `reason`**

| `reason` | Title | Line | Control |
|---|---|---|---|
| `held`, `lost` | In use on another device | Use SillyTavern here instead? | Use here |
| `claiming` | Taking over… | Loading your chat on this device. If your browser asks whether to leave the site, choose Leave. | spinner |
| `waitingForReply` | Finishing a reply… | Your other device is still writing a reply. | spinner |
| `lostRace` | Another device took over | It claimed SillyTavern first. | Use here |
| `unreadable` | Can't reach SillyTavern | Nothing is saved from this page. | Use here |
| `unknownFormat` | Update needed | Update the TravelingTavern extension to use SillyTavern here. | none |
| `reloadPending` | Reload needed | Reload this page to finish taking over. | Reload (calls `location.reload()` from the click) |

## 10. Model Connection After a Takeover Reload

ST connects to the model at startup only when its **Auto-connect** option is on (`power_user.auto_connect`, off by default). After a takeover reload the user would otherwise land in their chat unable to generate (R36; seen on desktop and in the app).

- After a reload that follows **Use here** or the app's `onForeground()` claim (not the automatic claim at start: that page was never connected in this session, and ST's own Auto-connect decides), once `APP_READY` has fired and the page is holder: if ST's `onlineStatus` is `no_connection`, the page presses ST's own connect button for the selected API, once: the same buttons ST's auto-connect presses (`RA_autoconnect`), chosen by `main_api`: `kobold` → `#api_button`, `novel` → `#api_button_novel`, `textgenerationwebui` → `#api_button_textgenerationwebui`, `openai` → `#api_button_openai`. Any other API (e.g. `koboldhorde`) has none: nothing is pressed, the wait below still decides
- Already connected (e.g. ST's own Auto-connect got there first): nothing is pressed
- **Already connecting:** the selected API's button carries ST's `disabled` class (from `startStatusLoading()` until `stopStatusLoading()`, E15) → nothing is pressed (a press would start a second status check); the wait below still decides
- **End of ST's attempt:** ST's `ONLINE_STATUS_CHANGED` to anything but `no_connection` (connected), or else a bounded wait of **10 s** after the press, then ST's `onlineStatus` decides. ST fires no event when an attempt fails (the status stays `no_connection`), and some failures send no request at all, so the wait is the only end it has
- Still not connected after ST's own attempt: the page reports `leaseNotice` `notConnected` (E11). Desktop shows one toast, "Not connected to a model. Connect in API Connections."; the app shows its native notice (A7) until `leaseState.connected` turns `true`
- `leaseState.connected` follows ST's `onlineStatus` (set at `APP_READY` and on every `ONLINE_STATUS_CHANGED`), on every page, not only after a takeover
- Reopening the chat (E4) doesn't wait for the connection
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
- **In the app's page** the bundled copy is injected at document start, so it is always first. An installed extension then stands down for the lease, but still announces itself (`window.__ttExtension`, `tt-extension-ready`) so `leaseInfo` can report its version
- **On desktop** `index.js` sets `window.__ttLeaseSource = 'extension'` and loads `session-lease.js`. A copy injected without that mark reports `source: 'app'`
- Where reports go: if the app's `TravelingTavern` listener exists, to the app (messages below); otherwise a `tt-lease` `CustomEvent` on `window`, for `index.js`. Its `detail` is `{ type, ...fields }`: `type` is the message type (`leaseState`, `leaseInfo` or `leaseNotice`) and the fields are that message's, below. `index.js` drives the overlay from `leaseState` and the toasts from `leaseInfo` (untested ST version, E12) and `leaseNotice`

### `window.__ttLease`

Frozen, defined once, no off switch.

| Member | Meaning |
|---|---|
| `version` | `LEASE_VERSION`, an integer |
| `source` | `'app'` or `'extension'`: which copy runs in this page |
| `useHere()` | Use here: claims if parked and not already claiming (E4), then reloads. Returns a promise; outcome is reported through `leaseState` |
| `onForeground()` | The app returned to the foreground. Holder: confirm the lease is still its own, bump the epoch if its release marker matches (A5), else park. Parked: claim **only if the lease is released** (R43), else stay parked. Returns a promise |

Nothing else is exposed. Neither hook takes arguments, and neither can make a parked page writable without a claim and a fresh load (R4).

### Messages to the app

Posted as JSON strings to the app's `TravelingTavern` listener, main frame only, in the app's envelope `{ "v": 1, "type": "...", ... }`. The app registers the listener for its saved server's origin only.

**`leaseState`**: sent once the start decision is made and on every change (holder ↔ parked, a new reason, `epoch`, `busy`).

| Field | Type | Meaning |
|---|---|---|
| `state` | `"holder"` or `"parked"` | |
| `reason` | string or `null` | `null` when holder. Parked: `"held"` (another page holds the lease), `"lost"` (this page lost it), `"claiming"`, `"waitingForReply"` (claiming, waiting for the other page's `busy` to clear: R29), `"lostRace"` (another page claimed first), `"unreadable"`, `"unknownFormat"` (a lease file in a newer format: this page's own copy is outdated, so in the app's page the app needs an update: E2), `"reloadPending"` (the reload after a claim didn't happen: E7) |
| `pageId` | string | This load's `holder` id (`<tab id>.<load id>`) |
| `epoch` | integer or `null` | The epoch this page holds; `null` if it never held the lease in this load |
| `busy` | boolean | This page is generating a reply |
| `connected` | boolean | ST is connected to a model (`onlineStatus` isn't `no_connection`); the app shows its notice when a holder reports `false` after a takeover (E10, A7) |
| `origin` | string | `location.origin`, where Kotlin reads the lease files and sends its release |

Kotlin's pre-check (A4) compares the lease file's `holder` and `epoch` with the last `leaseState`'s `pageId` and `epoch`.

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

The page never sends ST's CSRF token in a message. For the background release (A5), Kotlin fetches its own token from `GET /csrf-token` with the WebView's cookies; ST returns the session's existing token (`csrf-sync`, no overwrite), so the page's token keeps working. Kotlin keeps it in memory only, fetches it again after a `403`, and never logs or stores it.

### Versions

- **`LEASE_VERSION`** (integer, in `session-lease.js`): bumped on every change to lease behavior or to this contract. The app compares it; it never parses `manifest.json`'s version
- **`format`** (E2): bumped only when the files change incompatibly
- **`manifest.json` version** (`MAJOR.MINOR.PATCH`): the release shown to users; this spec ships as `0.2.0`
- **Release candidates and tags:** see `CLAUDE.md` → Versioning

### Names

`window.__ttLease`, `window.__ttLeaseSource`, `window.__ttExtension`, `tt-extension-ready`, `tt-lease` (and its `type` field), `leaseState`, `leaseInfo`, `leaseNotice`, `LEASE_VERSION`, `TESTED_ST_VERSIONS`, `session-lease.js`, `tt-session-lease.json`, `tt-session-release.json`, the `TravelingTavern-Extension` folder, the app's `TravelingTavern` listener.

The app's own `window.__ttBridge` is not part of this contract.

### What the contract never does

- Pass ST data, the CSRF token or anything from chats, cards, lorebooks or settings to the app. Messages carry only the fields above
- Offer a way to turn the lease off, skip the wrapper, or make a parked page writable without a claim and a fresh load (the one internal exception is resume after a freeze, E7)
- Log content: logs carry the kind of event, the reason, endpoint paths and counts only

## 12. Version Check

- `TESTED_ST_VERSIONS` in `session-lease.js`: the ST versions this lease was tested against, starting with **1.19.0 and 1.19.1** (the spike). Read from ST's `/version` at start
- The lease depends on ST's endpoint names in only three places: the allowlist (E6), the chat-save paths aborted before a reload (E7) and the generation endpoints (E8). Everything else is held or checked whatever its name
- **Untested ST version:** the allowlist is turned off (every request is checked: slower, never less safe); `leaseInfo.untestedServer` is `true`; desktop (`index.js`, from the `leaseInfo` event) shows one toast, without a title: "TravelingTavern hasn't been tested with this SillyTavern version." Only on a holder page (on a parked page it would sit behind the overlay), once per ST version per browser (the version shown is remembered in `localStorage`; if storage is blocked, it shows again on the next load). Chat-save and generation paths stay as they are: if ST renamed them, a reload may show "Leave site?" or a takeover may not wait for a reply, and the checklist (E14) catches both before the version is added
- On every ST release: re-check the three lists in ST's source, run the checklist on the test install, then add the version

## 13. Known Limits

| Limit | Effect | What would close it |
|---|---|---|
| Pages without the lease code (a desktop browser without the extension, the extension disabled, other ST clients, scripts) | They write freely | A server plugin that enforces the lease on the server |
| A write slower than the grace period plus the new holder's reload | It could land after the new holder loaded (not seen in the spike, incl. a 3 MB save) | Server plugin: refuse writes from a page that isn't the holder |
| Release is best effort | A crash leaves the lease held; the next page needs Use here | — (by design) |
| WebSockets from third-party extensions or server plugins (R31; ST itself has none, E15) | The wrapper doesn't see them | Server plugin, or wrap if one is found |
| A page that parked while a message was being edited | ST's `beforeunload` asks "Leave site?" on the takeover reload (`this_edit_mes_id >= 0`; not cleared by aborting chat saves). Discarding the edit is correct: it is stale. Desktop: the overlay tells the user to choose Leave (E9). App: it confirms `onJsBeforeUnload` itself, only during a takeover reload (A2) | —
| Memory Books writes default files in the holder when a read fails transiently (R32) | A transient server error can reset that extension's files | Outside the lease; report to Memory Books |
| Switch cost (R22, measured) | Desktop about 3.3 s, phone about 6.6 s from Use here to the reopened chat; about 1.8 s of the phone's is the lease (grace and checks), the rest is ST reloading. The allowlist removes most of the check time | Server plugin (no reload needed) |
| A holder that doesn't yet know it lost the lease still releases on `pagehide` (it can't read the lease while leaving) | Its marker names its old pair and overwrites the real holder's release marker, so the next page needs **Use here** (one click). Never data: the lease itself is untouched and a stale marker frees nothing. Seen on the test install, 1.19.1 | Server plugin |
| A holder that stops without `pagehide` or `freeze` (a crash, a killed process, a discard that skips freezing first). Idle background tabs frozen and then discarded by Chrome release on `freeze` (E5; before that fix seen twice on the test install) | No marker: the next page needs **Use here** | — (release stays best effort) |
| Chrome's automatic (proactive) discards may skip the `freeze` event (not tested; the test install's `chrome://discards` allowed only an urgent discard after a manual freeze) | A tab discarded that way still leaves no marker: the next page needs **Use here** | Investigate if seen; release stays best effort |
| A reply can't move to another device | A takeover waits for the reply (up to 60 s), then reloads | — |
| Horde text replies are asynchronous: `/api/horde/generate-text` only submits the job, the reply comes from later `/api/horde/task-status` polls (E15) | `busy` covers only the submit, so a takeover doesn't wait for a Horde reply; the old page's polls and chat save are held once it parks, and the reply is lost on the old device (never data) | Track Horde's polling, or a server plugin |
| Group chats aren't reopened after a takeover (ST's context has no function that selects a group; E4) | The desktop page lands on ST's start screen; the lease keeps the group in `active`. The app reopens groups through its own `chatFile` route | A group-select function in ST's context, or a dynamic import of ST's `group-chats.js` (owner decision) |
| ST's Auto-load chat can win the startup race: its `active_character` / `active_group` setting comes from ST's settings file, and if the old holder's settings save didn't land, it may open a different chat while the reopen runs (neither is awaited) | The page may end on the auto-loaded chat, which is then recorded as `active`. Never data: only which chat is open | — |
| A chat file deleted outside ST's normal flow (on disk, or by another client), while the lease still names it | The reopen's `openCharacterChat` starts that chat again, empty (ST's `getChat` for a missing file) | — (accepted; no guard) |
| ST's Custom (OpenAI-compatible) chat completion source bypasses its status check (`onlineStatus` "Status check bypassed") | After a takeover the page counts as connected even with the model down: no `notConnected` notice; the first reply fails in ST as usual | — (ST's own behavior) |
| A failed `busy: false` on a holder that then goes idle (no further lease write or check to carry it) | One claimer can wait the full 60 s cap | Server plugin, or the holder retrying on its next activity (already the rule, E3) |

## 14. Tests

**Unit** (`node --test`, no dependencies, fake `fetch`, one file per topic under `test/`). The lease's decisions are pure functions inside `createSessionLease({ fetch, post, now, sleep, storage, log })`; the browser wrapper stays thin.

- `files`: reading both files (E2): 404 vs unreadable, malformed JSON, missing and unknown fields, unknown or missing `format`, released only on an exact pair match
- `pair-rule`: every decision compares (`holder`, `epoch`), never the epoch alone (E2)
- `writes`: one write in flight, re-read first, 3 attempts 100–200 ms apart, unchanged writes skipped, outcomes per write type after all retries (E3)
- `claim`: busy wait (60 s cap, skipped when released, changed pair → `lostRace`), claim write, grace, verify, lost race, reopen flag (E4)
- `start-decision`: own tab → epoch bump with `busy: false`; free or released → automatic claim, once per tab; otherwise parked; refresh and duplicated tab (E4)
- `release`: marker on `pagehide` and `freeze`, back/forward cache, the check on `resume` after a `freeze` (E5)
- `wrapper`: what counts as server data, holder vs parked, 2 s read window, allowlist on and off, held requests never settle, only chat saves aborted, `sendBeacon` refused while parked, requests wait for the start decision (E6, E7)
- `reload`: held chat saves aborted and ST's handlers run before the reload; a reload that doesn't happen ends in `reloadPending` (E7)
- `busy`: generation requests sent only after `busy: true` is confirmed, `AbortError` and `replyNotStarted` when it can't be written, cleared only when the response is over, overlapping generations, writes behind the page's own bump (E8)
- `csrf`: the lease's own CSRF token, fetched again once on 403; ST's `/csrf-token` ordered after it (E6)
- `foreground`: `onForeground` for a holder (bump that invalidates its own marker) and a parked page (claims only a released or missing lease) (E11, app A5)
- `instance`: one instance per page, main frame only, never on the login page, frozen `window.__ttLease`, desktop-only release wiring, `index.js` versions match (E11)
- `messages`: `leaseState`, `leaseInfo` and `leaseNotice` payloads, to the app and as `tt-lease` with `type`; no CSRF token or ST data (E11)
- `overlay`: what `index.js` shows for each report: overlay texts, toasts (E9, E10, E12)
- `reopen`: the reopen flag, character reopen and its guards, group and deleted character → start screen, recording `active` (incl. behind the page's own bump) (E4)
- `connect`: connect press only after Use here / onForeground and only while not connected or connecting, button by `main_api`, `notConnected` after the 10 s wait, `connected` tracking, hooks on desktop and at document start (E10)
- `setup`: `manifest.json` points at `index.js`

**Manual checklist, on the separate test install only** (never the real server: `CLAUDE.md` Hard Rules). Throwaway persona, lorebook, character and chat; Memory Books installed.

- [ ] Two pages: the second parks; a stale page's chat, persona, card, lorebook and settings saves never reach the server
- [ ] Use here: same chat reopened; switch time recorded. A group and a deleted character: start screen, logged. With ST's Auto-load chat on: the reopened chat wins
- [ ] Two simultaneous Use here: exactly one holder
- [ ] Takeover while generating: claimer waits, reply saved before it loads. No model connected: no stuck `busy`
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
- [ ] Model connection restored after a Use here reload; not pressed after an automatic claim at start. A backend that can't connect (not the Custom source, which bypasses its check): one `notConnected` toast within about 10 s
- [ ] The app's checks: app spec checklist

## 15. Verified in SillyTavern's source

Checked against the tags **1.19.0 and 1.19.1** (2026-11-20). Between them only `characters.js` (character import), `charx.js`, `users-admin.js`, `users-private.js` and a CSS fix in `public/scripts/chats.js` changed, none of it below.

- **Allowlist (E6):** each handler read. Read-only for user data, with these side effects that never overwrite anything: `characters/all`, `characters/get` fill ST's character cache; `groups/all` and `chats/get` create an empty folder if missing; `secrets/read` creates an empty `secrets.json` only if none exists; tokenizers may download models into the global `_cache`. `stats/get` reads memory. **Excluded:** `backgrounds/all` (`getOrGenerateMetadataBatch` reads `image-metadata.json`, adds metadata and writes the whole index back, folder assignments included)
- **Chat saves (E7):** `POST /api/chats/save`, `POST /api/chats/group/save` (`src/endpoints/chats.js`). `saveChatConditional` sets `isChatSaving` and clears it in `finally`; the group save returns on a failed fetch. ST's `beforeunload` prompts while `isChatSaving` or `this_edit_mes_id >= 0`
- **CSRF (E6):** `src/server-main.js` registers `GET /csrf-token` before `requireLoginMiddleware`; `csrf-sync` 4.2.1 `generateToken(req)` returns the session's token unless `overwrite`; sessions are `cookie-session`. ST's page fetches its token in `firstLoadInit`
- **Lease files:** `/user/files/*` answers 404 for a missing file, 403 when not logged in. `POST /api/files/upload` validates the name and writes with `writeFileSyncAtomic`
- **Login page:** `GET /login` serves `login.html`; it requests `/csrf-token` and `/api/users/list`, `/login`, `/recover-step1`, `/recover-step2` only
- **WebSockets and other channels (R31):** no WebSocket server in `src` (the `ws` dependency isn't imported), no `new WebSocket`, `EventSource`, `sendBeacon`, workers or service worker in `public` outside `public/lib`; streaming uses `EventSourceStream` over fetch bodies; `<form method="post">` elements use `action="javascript:void(null)"`. Memory Books and TopInfoBar on the test install: none either
- **`GET /version`** answers `{ agent, pkgVersion, gitRevision, gitBranch, commitDate, isLatest }` (behind the login check)
- **Generation endpoints (E8):** `src/server-startup.js` mounts `/api/backends/text-completions`, `/api/backends/kobold`, `/api/backends/chat-completions`, `/api/novelai` and `/api/horde` (same lines in 1.19.0 and 1.19.1); each has `POST /generate` (Horde: `/generate-text`). Other `/generate` routes are images, voice or video (`/api/sd/*`, `/api/novelai/generate-image`, `/api/azure/generate` is Azure TTS, `/api/speech/*`) and stay off the list. Every caller in `public/scripts` (`script.js` `sendGenerationRequest`, `openai.js`, `textgen-settings.js`, `kai-settings.js`, `nai-settings.js`, `custom-request.js`, `horde.js`) reads the response body to the end (`json()`, `text()` on errors, or `pipeThrough` of the stream), so `busy: false` follows; Stop aborts the fetch, which errors the stream
- **Reopen (E4)** (2026-11-21; `script.js`, `group-chats.js`, `st-context.js`, `welcome-screen.js` identical in 1.19.0 and 1.19.1): `getContext()` exposes `selectCharacterById`, `openCharacterChat`, `openGroupChat`, `getCurrentChatId`, `characters`, `groups`, `characterId`, `groupId`, `chatId`, `onlineStatus`, `mainApi`, `eventSource`, `eventTypes`; it builds a new object on every call. `selectCharacterById(id)` returns without switching while `isChatSaving` or a reply runs; ST's own recent-chat code (`welcome-screen.js`) passes no options (default `switchMenu: true`), and so does the lease. `openCharacterChat(file)` sets `characters[this_chid].chat` and saves the card (as when the user picks a chat). `openGroupChat(groupId, chatId)` doesn't select the group; ST's own callers (`openRecentGroupChat`, `/go`, auto-load) call `openGroupById` first, which isn't in the context. `globalThis.SillyTavern` is set before `script.js` waits for `load`; `APP_READY` and `APP_INITIALIZED` are auto-fired for late listeners. Events: `APP_READY` `app_ready`, `CHAT_CHANGED` `chat_id_changed`, `ONLINE_STATUS_CHANGED` `online_status_changed` (emitted only when the status changes)
- **Connect buttons (E10)** (2026-11-21; `RossAscends-mods.js`, `index.html` identical in 1.19.0 and 1.19.1): `RA_autoconnect` presses `#api_button` (kobold), `#api_button_novel`, `#api_button_textgenerationwebui`, `#api_button_openai`; no case for `koboldhorde`. All four are `<div>`s with jQuery click handlers, which run even while the button looks disabled. An attempt in progress: each handler calls `startStatusLoading()` (adds `disabled` to every `.api_button`, shows `.api_loading`) before its status check, and every return path of the checks (`getStatusOpen`, `getStatusTextgen`, `getStatusKobold`, `getStatusNovel`) ends in `resultCheckStatus()` → `stopStatusLoading()`. A failed attempt sets `no_connection` again (no event); some failures send no request (e.g. no endpoint). ST's auto-load and auto-connect start in `initRossMods` before `APP_READY` and aren't awaited. The Custom chat completion source sets "Status check bypassed" before its request
- **Horde is asynchronous:** `/api/horde/generate-text` only submits the job and answers its id; the reply comes from repeated `POST /api/horde/task-status` polls (`horde.js`), so `busy` covers only the submit
