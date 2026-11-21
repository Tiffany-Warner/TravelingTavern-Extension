# TravelingTavern Extension `v0.2.0` — Session Lease

> **Draft.** Sections 2 and 11 (the shared contract) are written for review; the other sections follow the outline (`session-lease-outline.md`) once these are settled.

Replaces `ext-0.1-save-guard-spec.md` (superseded). Requirements: `context/decisions/session-lease-spike.md` (cited as **R1–R44**). Plan and requirement map: `session-lease-outline.md`. App side: the TravelingTavern repo's `session-lease-app-spec.md`, which references this spec for every shared definition and never restates it.

## 1. Purpose and Rule

*(to be written)*

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
| `holder` | string | Page id of the holder: one per tab (per page in the app), kept in `sessionStorage` for that origin, so a refresh keeps it; random, no personal data |
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

*(to be written)*

## 4. Claim and Takeover

*(to be written)*

## 5. Release (desktop)

*(to be written)*

## 6. Request Wrapper

*(to be written)*

## 7. Parking and Reloads

*(to be written)*

## 8. `busy`

*(to be written)*

## 9. Web Overlay (desktop)

*(to be written)*

## 10. Model Connection After a Takeover Reload

*(to be written)*

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
- Where reports go: if the app's `TravelingTavern` listener exists, to the app (messages below); otherwise a `tt-lease` `CustomEvent` on `window` with the same payload as `leaseState` in `detail`, for `index.js`'s overlay

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
| `pageId` | string | This page's `holder` id |
| `epoch` | integer or `null` | The epoch this page holds; `null` if it never held the lease in this load |
| `busy` | boolean | This page is generating a reply |
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

### `window.__ttExtension`

Set by `index.js` before it loads (or stands down for) `session-lease.js`: `{ version: "<manifest version>", leaseVersion: <integer> }`, frozen. Then it fires `tt-extension-ready` on `window`.

### CSRF token for the app's release (R42)

The page never sends ST's CSRF token in a message. For the background release (A5), Kotlin fetches its own token from `GET /csrf-token` with the WebView's cookies; ST returns the session's existing token (`csrf-sync`, no overwrite), so the page's token keeps working. Kotlin keeps it in memory only, fetches it again after a `403`, and never logs or stores it.

### Versions

- **`LEASE_VERSION`** (integer, in `session-lease.js`): bumped on every change to lease behavior or to this contract. The app compares it; it never parses `manifest.json`'s version
- **`format`** (E2): bumped only when the files change incompatibly
- **`manifest.json` version** (`MAJOR.MINOR.PATCH`): the release shown to users; this spec ships as `0.2.0`

### Names

| Kept | Removed (save-guard design, never used by app code) |
|---|---|
| `window.__ttLease`, `window.__ttLeaseSource`, `window.__ttExtension`, `tt-extension-ready`, `tt-lease`, `leaseState`, `leaseInfo`, `LEASE_VERSION`, `TESTED_ST_VERSIONS`, `session-lease.js`, `tt-session-lease.json`, `tt-session-release.json`, the `TravelingTavern-Extension` folder, the app's `TravelingTavern` listener | `__ttSaveGuard` (`checkFresh`, `checkChat`, `pendingSaves`), `__ttGuardSource`, `tt-save-guard`, `saveBlocked`, `staleSettings`, `staleLorebooks`, `chatSaveRefused`, `guardInfo`, `__ttRev`, `__ttUser`, `GUARD_VERSION`, `save-guard.js` |

The app's own `window.__ttBridge` is not part of this contract.

### What the contract never does

- Pass ST data, the CSRF token or anything from chats, cards, lorebooks or settings to the app. Messages carry only the fields above
- Offer a way to turn the lease off, skip the wrapper, or make a parked page writable without a claim and a fresh load
- Log content: logs carry the kind of event, the reason, endpoint paths and counts only

## 12. Version Check

*(to be written)*

## 13. Known Limits

*(to be written)*

## 14. Tests

*(to be written)*
