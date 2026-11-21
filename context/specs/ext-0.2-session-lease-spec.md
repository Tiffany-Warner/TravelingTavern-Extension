# TravelingTavern Extension `v0.2.0` — Session Lease

> **Reviewed** (2026-11-20). Items marked **(verify)** must be confirmed in SillyTavern's source before they're built on.

Replaces `ext-0.1-save-guard-spec.md` (superseded). Requirements: `context/decisions/session-lease-spike.md` (cited as **R1–R44**). Requirement map: `session-lease-spike.md` → Requirement Map (final). App side: the TravelingTavern repo's `session-lease-app-spec.md`, which references this spec for every shared definition and never restates it.

## 1. Purpose and Rule

**Rule:** nothing TravelingTavern runs may delete or overwrite SillyTavern (ST) data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

**Problem:** an ST page reads data once and later saves whole files from its own copy. A page left open on one device erases what another device saved since (seen for chats, settings, lorebooks, personas and extension files).

**Design: one active page per ST user.** A small lease file names the page that may write. Every other page is **parked**: it shows an overlay with **Use here**, and its requests to the server are held, never sent. Use here claims the lease and reloads the page, so it starts from fresh data. The lease needs no knowledge of which endpoints save what; the per-save guard it replaces did (`ext-0.1-save-guard-spec.md`, superseded; why: `context/decisions/direction-change.md` and `architecture-assessment.md`; evidence: `session-lease-spike.md`).

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

- `POST /api/files/upload`, ST's request headers (incl. its CSRF header), body `{ "name": "<file name>", "data": "<base64 of the UTF-8 JSON>" }`. ST writes the file atomically (temp file + rename)
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
- A missing `format` is an unknown format. (Only the spike wrote files without it, and only on the test install; delete them there before testing.)
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
- One-off delays (this retry, the grace wait in E4) are bounded and allowed; no repeating timers (`coding-standards.md`, R34)

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

**Reopen the chat** (R10, R30): after a reload that follows any claim (Use here or automatic), once ST fires `APP_READY` and the page is holder, read `active` and open it with ST's context functions: group → `openGroupChat(groupId, chatFile)` **(verify)**; character → `selectCharacterById(index of avatar)` **(verify)**, then `openCharacterChat(chatFile)` **(verify)** if that chat isn't already open. A character or group that no longer exists → stay on ST's start screen (logged). While the reopen flag is set, ST's startup `CHAT_CHANGED` with no chat doesn't overwrite `active`.

**Recording the open chat:** on `CHAT_CHANGED` the holder writes `active` (E3; skipped when unchanged).

## 5. Release (desktop)

Best effort, so closing the holder doesn't cost the next page a click (R15). The app releases differently: app spec A5.

- On **`pagehide` only** (not `beforeunload`, which fires before a "Leave site?" prompt the user may cancel). Only a holder releases; a parked page reloading after a claim never does
- Sent with `fetch(..., { keepalive: true })` through the original `fetch` with ST's request headers (not `sendBeacon`: the upload needs the CSRF header). Body: the release marker (E2) naming this page's exact pair. Never touches the lease
- **A refreshed holder** finds its own marker matching; the always-bump at start (E4) makes it stop counting (R16)
- **Back/forward cache** (R17): `pagehide` also fires when a page enters the cache, so a holder restored from it (`pageshow` with `persisted`) has released its claim. It parks at once (holds everything) and reloads; the fresh load decides as in E4
- **No marker** (browser crash, killed tab, power loss): the next page parks and offers Use here

## 6. Request Wrapper

Wraps `window.fetch` and `XMLHttpRequest.prototype.open` / `send`. Nothing else in ST is patched.

**Server data** = a path under `/api/` or `/user/`, or any method other than `GET`. Everything else (scripts, styles, templates, images, `/csrf-token`, `/version`) passes untouched.

| Page state | Server-data request |
|---|---|
| Before the start decision (R18) | Waits for it, then as below |
| Holder, non-`GET`, not allowlisted | Re-reads the lease first (pair check); sent only if still holder, else the page parks and holds it |
| Holder, `GET` or allowlisted | Sent if the last lease read is at most 2 s old; otherwise re-read first, as above (R5, R21) |
| Parked | **Held** (R2): never sent, never refused |

- **Exempts nothing** (R1): no request passes by URL while parked. The lease's own reads and writes use the original `fetch` captured at install, so they never pass through the wrapper
- **Held** fetches return a promise that stays pending; only their path and reject function are kept, never the request, so no code path can send one later. Held XHRs are never sent and never complete. Refusing instead broke ST's startup in the spike
- **`navigator.sendBeacon`** while parked returns `false` without sending
- **Fail closed** (R11): a lease read that fails parks the page and holds the request
- **Allowlist** (R21): read-only `POST` endpoints, each confirmed read-only in ST's source for every tested ST version, kept in a named constant. Candidates seen in the spike, all **(verify)**: `/api/settings/get`, `/api/characters/all`, `/api/characters/get`, `/api/groups/all`, `/api/chats/get`, `/api/chats/group/get`, `/api/chats/recent`, `/api/worldinfo/get`, `/api/avatars/get`, `/api/backgrounds/all`, `/api/backgrounds/folders`, `/api/image-metadata/all`, `/api/secrets/read`, `/api/stats/get`, `/api/sd/comfy/workflows`, `/api/tokenizers/*/encode`, `/api/tokenizers/*/count`. Anything not listed is checked. Allowlisted requests are still held while parked. On an untested ST version the allowlist is off (E12)
- **Before the extension loads** (desktop) ST sends only reads (`/csrf-token`, `/version`, `/api/secrets/read`, `/api/settings/get`, `/api/extensions/discover`; seen on 1.19.0 and 1.19.1). In the app the bundled copy is installed at document start, before any of them
- **WebSockets: to check** (R31): whether ST or an extension sends server data over a WebSocket, which the wrapper doesn't see. A known limit until checked (E13)

## 7. Parking and Reloads

- **A page becomes writable only through a fresh load that holds the lease** (R4): the start decision (E4) is the only place a page unparks. A page that lost the lease never re-claims by itself; it offers Use here, which claims and reloads
- Parking is immediate: from that moment every new server-data request is held
- **Before any reload, abort only held chat saves** (R3): held `/api/chats/save` and `/api/chats/group/save` are rejected with an `AbortError`, so ST's `isChatSaving` clears and its `beforeunload` doesn't block the reload with "Leave site?". These paths are a named constant **(verify per ST version)**
- **Held reads are never aborted:** an extension that sees a failed read may write a default file (Memory Books did, through the spike's exemption). They stay pending until the page unloads
- No held request is ever sent, before or after a reload

## 8. `busy`

`busy` tells claimers the holder is generating a reply (R8, R19).

- **Tied to the generation request itself,** not to ST's `GENERATION_STARTED` event, which also fires for dry runs and, when a generation fails before it starts, has no end event. The wrapper holds a request to a generation endpoint until `busy: true` is written and confirmed (E3), then sends it; it writes `busy: false` only when that response is over: the body fully read or the stream closed, an error, or the read cancelled (Stop). **Never when the headers arrive:** a streaming reply continues long after them. Dry runs and generations that fail before sending never set it
- Generation endpoints, a named constant **(verify per ST version)**: any `/api/backends/*/generate` (so a new backend still sets `busy`; today `chat-completions`, `text-completions`, `kobold`), plus `/api/novelai/generate` and `/api/horde/generate-text`
- If `busy: true` can't be written after the retries, the request isn't sent (E3)
- Several generation requests at once (e.g. an extension's background summary during a reply): `busy` stays `true` until the last one finishes
- Written through the lease-write queue (E3); a failed `busy: true` → E3
- A released claim's `busy` is ignored (E5). The wait itself is bounded at 60 s (E4)

## 9. Web Overlay (desktop)

Shown by `index.js` from `tt-lease` events of type `leaseState` (E11). **Overlay only, no toast** for parked tabs. Never shown in the app's page.

**Behavior**

- A `<dialog>` opened with `showModal()`, covering the window, so it sits above ST's loader and popups and everything under it is inert. Whenever another dialog opens while parked (ST popups are modal), the overlay is closed and re-opened so it is the top modal again and **Use here** stays clickable. Escape can't close it
- **Use here** calls `window.__ttLease.useHere()`

**Design**

- A modern **centered card** on a **dimmed, blurred backdrop** (`::backdrop` with a translucent dark tint and `backdrop-filter: blur(var(--blurStrength))`)
- Card: rounded corners (about 16 px), soft shadow, comfortable padding, max width about 360 px, full width minus margins on narrow windows
- Content, top to bottom: a clear **title**, **one line** of text, then a **large, full-width, rounded "Use here" button**
- While claiming (`claiming`, `waitingForReply`): a **spinner** replaces the button. Under `prefers-reduced-motion: reduce` the spinner doesn't rotate (a static indicator instead)
- **Colors from ST's theme variables** (confirmed in ST 1.19.1 `public/style.css`), so it matches the user's theme: card background `--SmartThemeBlurTintColor`, text `--SmartThemeBodyColor`, border `--SmartThemeBorderColor`, shadow `--SmartThemeShadowColor`, spinner accent `--SmartThemeQuoteColor`, font size `--mainFontSize`, transitions `--animation-duration`
- The button **builds on ST's `menu_button` class** (theme colors and border) with overrides only for size: full width, larger padding, larger radius, larger text (`menu_button` defaults to `width: min-content` and `border-radius: 5px`)
- **Static markup built with DOM methods** (`createElement`, `textContent`); no HTML strings, no data in markup, no external fonts or assets. Styles in one `<style>` element the extension adds once, every rule scoped to the overlay's own class prefix
- No other change to ST's look

**Texts by `reason`**

| `reason` | Title | Line | Control |
|---|---|---|---|
| `held`, `lost` | In use on another device | Use SillyTavern here instead? | Use here |
| `claiming` | Taking over… | Loading your chat on this device. | spinner |
| `waitingForReply` | Finishing a reply… | Your other device is still writing a reply. | spinner |
| `lostRace` | Another device took over | It claimed SillyTavern first. | Use here |
| `unreadable` | Can't reach SillyTavern | Nothing is saved from this page. | Use here |
| `unknownFormat` | Update needed | Update the TravelingTavern extension to use SillyTavern here. | none |

## 10. Model Connection After a Takeover Reload

ST connects to the model at startup only when its **Auto-connect** option is on (`power_user.auto_connect`, off by default). After a takeover reload the user would otherwise land in their chat unable to generate (R36; seen on desktop and in the app).

- After a reload that follows **Use here** or the app's `onForeground()` claim (not the automatic claim at start: that page was never connected in this session, and ST's own Auto-connect decides), once `APP_READY` has fired and the page is holder: if ST's `onlineStatus` is `no_connection`, the page presses ST's own connect button for the selected API, once: the same buttons ST's auto-connect presses (`#api_button`, `#api_button_novel`, `#api_button_textgenerationwebui`, `#api_button_openai`, chosen by `main_api`) **(verify)**
- Still not connected after ST's own attempt: the page reports `leaseNotice` `notConnected` (E11). Desktop shows one toast, "Not connected to a model. Connect in API Connections."; the app shows its native notice (A7) until `leaseState.connected` turns `true`
- Never changes ST's settings (doesn't turn Auto-connect on)

## 11. App Contract *(shared)*

Everything the app and the extension rely on from each other. Changing any of it is raised with the owner first and bumps `LEASE_VERSION`.

### Files

| File | Where | Role |
|---|---|---|
| `session-lease.js` | extension repo root | The lease core: a classic script, one IIFE, no `import` / `export`. The only copy; the app bundles it through its submodule (pinned tag) and injects it at document start (A2) |
| `index.js` | extension repo root | Desktop only: loads `session-lease.js`, shows the web overlay (E9), announces the extension |

### One lease instance per page (R40)

- `session-lease.js` installs once per page, in the main frame only. It defines `window.__ttLease` as non-writable and non-configurable; a second copy that finds it already defined **stands down completely** (no wrapper, no lease reads, no messages)
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
| `reason` | string or `null` | `null` when holder. Parked: `"held"` (another page holds the lease), `"lost"` (this page lost it), `"claiming"`, `"waitingForReply"` (claiming, waiting for the other page's `busy` to clear: R29), `"lostRace"` (another page claimed first), `"unreadable"`, `"unknownFormat"` (a lease file in a newer format: this page's own copy is outdated, so in the app's page the app needs an update: E2) |
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
- **Release candidate:** `v0.2.0-rc.1` is tagged on `dev` once the lease is complete. The app implements and tests against that tag; after both checklists pass, `v0.2.0` is released to `main` and the app re-pins to it before its own merge

### Names

| Kept | Removed (save-guard design, never used by app code) |
|---|---|
| `window.__ttLease`, `window.__ttLeaseSource`, `window.__ttExtension`, `tt-extension-ready`, `tt-lease` (and its `type` field), `leaseState`, `leaseInfo`, `leaseNotice`, `LEASE_VERSION`, `TESTED_ST_VERSIONS`, `session-lease.js`, `tt-session-lease.json`, `tt-session-release.json`, the `TravelingTavern-Extension` folder, the app's `TravelingTavern` listener | `__ttSaveGuard` (`checkFresh`, `checkChat`, `pendingSaves`), `__ttGuardSource`, `tt-save-guard`, `saveBlocked`, `staleSettings`, `staleLorebooks`, `chatSaveRefused`, `guardInfo`, `__ttRev`, `__ttUser`, `GUARD_VERSION`, `save-guard.js` |

The app's own `window.__ttBridge` is not part of this contract.

### What the contract never does

- Pass ST data, the CSRF token or anything from chats, cards, lorebooks or settings to the app. Messages carry only the fields above
- Offer a way to turn the lease off, skip the wrapper, or make a parked page writable without a claim and a fresh load
- Log content: logs carry the kind of event, the reason, endpoint paths and counts only

## 12. Version Check

- `TESTED_ST_VERSIONS` in `session-lease.js`: the ST versions this lease was tested against, starting with **1.19.0 and 1.19.1** (the spike). Read from ST's `/version` at start
- The lease depends on ST's endpoint names in only three places: the allowlist (E6), the chat-save paths aborted before a reload (E7) and the generation endpoints (E8). Everything else is held or checked whatever its name
- **Untested ST version:** the allowlist is turned off (every request is checked: slower, never less safe); `leaseInfo.untestedServer` is `true`; desktop (`index.js`, from the `leaseInfo` event) shows one toast per ST version: "TravelingTavern hasn't been tested with this SillyTavern version." Chat-save and generation paths stay as they are: if ST renamed them, a reload may show "Leave site?" or a takeover may not wait for a reply, and the checklist (E14) catches both before the version is added
- On every ST release: re-check the three lists in ST's source, run the checklist on the test install, then add the version

## 13. Known Limits

| Limit | Effect | What would close it |
|---|---|---|
| Pages without the lease code (a desktop browser without the extension, the extension disabled, other ST clients, scripts) | They write freely | A server plugin that enforces the lease on the server |
| A write slower than the grace period plus the new holder's reload | It could land after the new holder loaded (not seen in the spike, incl. a 3 MB save) | Server plugin: refuse writes from a page that isn't the holder |
| Release is best effort | A crash leaves the lease held; the next page needs Use here | — (by design) |
| WebSockets not checked (R31) | Unknown | Check, then wrap or rule out |
| Memory Books writes default files in the holder when a read fails transiently (R32) | A transient server error can reset that extension's files | Outside the lease; report to Memory Books |
| Switch cost (R22, measured) | Desktop about 3.3 s, phone about 6.6 s from Use here to the reopened chat; about 1.8 s of the phone's is the lease (grace and checks), the rest is ST reloading. The allowlist removes most of the check time | Server plugin (no reload needed) |
| A reply can't move to another device | A takeover waits for the reply (up to 60 s), then reloads | — |
| A failed `busy: false` on a holder that then goes idle (no further lease write or check to carry it) | One claimer can wait the full 60 s cap | Server plugin, or the holder retrying on its next activity (already the rule, E3) |

## 14. Tests

**Unit** (`node --test`, no dependencies, fake `fetch`, one file per topic under `test/`). The lease's decisions are pure functions inside `createSessionLease({ fetch, post, now, sleep, storage, log })`; the browser wrapper stays thin.

- Files: 404 vs unreadable; malformed JSON, missing fields; unknown fields ignored; unknown or missing `format` → park; released only on an exact pair match with known formats; a stale marker means nothing
- Pair rule: claim verify; epoch-bump verify; a bump and a claim writing the same epoch
- Claim: busy wait bounded at 60 s and skipped when released; during the wait a changed pair → `lostRace`, a release → the wait ends and the claim continues; grace; lost race; reopen flag; automatic claim at most once per tab
- Start decision: own id → bump with `busy: false` (even if the file said `busy: true`); requests wait for the decision; duplicated tab (same id) → the older page parks on its next check
- Writes: one in flight; re-read before each; 3 attempts 100–200 ms apart; park at once on a pair change or unknown format; an unreadable or missing re-read retried like a failed write, parking only after the last attempt; unchanged writes skipped
- Failed writes after all retries: claim or epoch bump → parks; `active` → stays holder; `busy: false` → stays holder, written with the next lease write or check, and the file ends `busy: false`
- Wrapper: what counts as server data; holder vs parked; 2 s read window; allowlist on and off (untested ST); held promises never settle; only chat saves aborted before a reload; `sendBeacon` refused while parked
- `busy`: the generation request is sent only after `busy: true` is confirmed; a failed `busy: true` → request rejected with `AbortError`, never sent, toast; any `/api/backends/*/generate` matches; cleared only when the body is fully read or the stream closes, on error and on cancel, never when the headers arrive; dry runs never set it; overlapping generations
- Messages: `leaseState`, `leaseInfo` and `leaseNotice` payloads, to the app and as `tt-lease` with `type`; no CSRF token or ST data in any message

**Manual checklist, on the separate test install only** (never the install in daily use: `ai-guidelines.md`). Throwaway persona, lorebook, character and chat; Memory Books installed. Delete any lease files the spike left before starting.

- [ ] Two pages: the second parks; a stale page's chat, persona, card, lorebook and settings saves never reach the server
- [ ] Use here: same chat reopened; switch time recorded
- [ ] Two simultaneous Use here: exactly one holder
- [ ] Takeover while generating: claimer waits, reply saved before it loads. No model connected: no stuck `busy`
- [ ] Save queued just before a takeover: held, or saved and visible in the new holder
- [ ] Holder refresh: stays holder, epoch bumped. Duplicated tab: the older copy parks
- [ ] Close the holder: the next tab claims without a click. Close an old tab after a takeover: the lease is untouched
- [ ] Back/forward cache: a restored holder parks and reloads; a write at restore never reaches disk
- [ ] Held chat save before a reload: no "Leave site?"
- [ ] Parked tab with Memory Books: held reads stay pending, no default files written
- [ ] ST popup open before and after parking: overlay on top, Use here works
- [ ] Overlay design: card, blurred backdrop, theme colors in a light and a dark ST theme; spinner static under reduced motion
- [ ] Server unreachable: pages park, nothing sent after the restart
- [ ] Lease write `EPERM` (Windows): retried, no false park
- [ ] Unknown `format` in the lease file: page parks with the update message, writes nothing
- [ ] Untested ST version: toast once, every request checked
- [ ] Model connection restored after a Use here reload; not pressed after an automatic claim at start
- [ ] The app's checks: app spec checklist
