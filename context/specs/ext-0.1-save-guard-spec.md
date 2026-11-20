# TravelingTavern Extension `v0.1.0` — Save Guard

New public repo `TravelingTavern-Extension`. Built **before** the app's `0.1.20` (`fix-stale-page-overwrites-spec.md`), which includes it as a submodule. All decisions: user + design reviews, 2026-11-20.

## Purpose

**Rule:** nothing TravelingTavern runs may delete or overwrite SillyTavern (ST) data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

**Bug:** an ST page reads data once and later saves the **whole file** from its copy, erasing changes other pages made since. The app can guard only its own WebView; a desktop tab erases the phone's changes the same way. An extension is the only way to load the guard into desktop tabs.

- `save-guard.js` is the single source of truth: loaded by the extension (desktop tabs), bundled by the app (submodule, injected at document start), injected by Playwright (Phase 8 headless page)
- Stale saves are **blocked, not merged** (merge = next version), with three lossless exceptions (Decision table)
- Desktop impact: toasts + one Extensions-panel line. No change to ST's code, look or behavior

## Repo

```
manifest.json   display name "TravelingTavern", js: "index.js", version, author, early loading_order (verify it loads before Memory Books)
index.js        ES module: loads the guard, desktop UI
save-guard.js   plain script, no imports, no Android/app assumptions
test/*.test.cjs node:test
package.json    test script only, no runtime deps
README.md
```

- Extension at repo **root** (ST clones the repo). License as the app repo. Repo **public** (ST and the app's CI clone without login)
- Tags `vX.Y.Z`; the app's submodule pins a tag. Users install from the default branch **`main`** (always = newest tag; changed only by a release PR from `dev`): ST's update is `git pull` on the checked-out branch, so a tag install can't update. `dev` = work in progress

## `save-guard.js`

### Shape

- One IIFE installing frozen `window.__ttSaveGuard = { version, source, checkFresh(), checkChat(), pendingSaves() }`. `version` = integer `GUARD_VERSION` (bump on every behavior change). `source` = `"app" | "extension" | "headless"`, read **once at install** from `window.__ttGuardSource` (set by the loader before the script runs; default `"app"`), since the object is frozen. Nothing can turn the guard off
- Installs once (no-op if `__ttSaveGuard` exists). Main frame only (`window.top === window`)
- Logic in pure functions inside `createSaveGuard({ fetch, post, now, log })`; `if (typeof module !== 'undefined') module.exports = …` for Node tests. Thin browser wrapper
- Wraps `window.fetch`. Also wraps `XMLHttpRequest.send` and **refuses** guarded URLs there (core never uses XHR for these; closes the hole for third-party extensions)
- Event-driven only: no timers, no polling
- **No secure-context APIs.** The app loads ST over plain `http://` on the tailnet, where `crypto.subtle` doesn't exist. Hashes (`rev`) are pure JS (cyrb53 or FNV-1a) over canonical JSON (sorted keys); they only need to tell versions apart. `structuredClone` and `DecompressionStream` work on http; feature-detect `DecompressionStream`, and if a compressed body can't be read, block (fail closed)
- **The compare-and-save step is one function, `conditionalWrite(kind, key, base, payload)`.** v0.1.0: read server → compare → send. Later, when the optional server plugin is installed, the same function calls the plugin's atomic endpoint; nothing else changes
- ST modules via dynamic import by absolute URL (`import(new URL('/scripts/world-info.js', location.href).href)` → `worldInfoCache`, `reloadEditor`). Paths are constants here; no dependency on the app's `st-selectors.js`
- Reporting: `post(type, payload)` → `TravelingTavern` listener if present (the app); else `CustomEvent('tt-save-guard')` on `window` (extension UI)
- One guarded save at a time (queue)
- Request bodies may be gzip (`request-compression.js`, off by default): decompress with `DecompressionStream` **(verify how ST marks them)**

### Guarded requests (all `POST`; everything else passes through)

| Request | Role | Key |
|---|---|---|
| `/api/settings/get` | settings read | — |
| `/api/settings/save` | settings save | — |
| `/api/worldinfo/get` | lorebook read | body `name` |
| `/api/worldinfo/edit` | lorebook save | body `name` |
| `/api/chats/get`, `/api/chats/group/get` | chat read | avatar or group id + chat file |
| `/api/chats/save`, `/api/chats/group/save` | chat save | same |
| `/api/characters/all`, `/api/characters/get` | character read | `avatar` |
| `/api/characters/edit` (multipart) | character save | `avatar_url` |
| generate endpoints (Chats) | refused while a chat is stale | — |

### Base version

The base of a save = the version **the saving copy came from**. Parsed, compared deep-equal (key order/whitespace ignored).

- **Settings:** page fingerprint = parsed `settings` string of each `/api/settings/get` response
- **After the page's own successful save:** fingerprint = **sent payload**, never a read-back (a read-back could include another device's change the page doesn't hold; the next save would erase it). Valid because the server stores bodies unchanged (Verified)
- **First settings save after load:** ST adds defaults while loading, so the first payload can differ from the file with no user change. If that save is blocked → `hadChanges: null`. Exact after one successful save. A late-started guard (extension, app fallback injection) seeds from the page's own state instead of a read-back (see `index.js`), so it is in the same position, not a worse one
- **Lorebooks: revision stamp.** `worldInfoCache` clones on every `get` (`cloneOnGet: true`, `cloneOnSet: false`), so one page holds copies of different ages (open World Info editor, an extension across an `await`); a per-page fingerprint would let an old copy pass after the page re-read a newer one
    - on each `/api/worldinfo/get` response add top-level `__ttRev: { name, rev }` (`rev` = pure-JS hash of the server content, see Shape). Plain property (survives `structuredClone`)
    - on `/api/worldinfo/edit`: read the stamp, **strip it before sending**, use its `rev` as base
    - after own successful save: write the new `rev` into the cache's own object (`Map.prototype.get.call(worldInfoCache, name)`)
    - **no stamp:** file absent on server → send (new lorebook). Present → fall back to the page fingerprint for that name (log it; weaker). No fingerprint either → block `unseen`
    - **stamp with another `name`** (rename / duplicate save old data under a new name; rename then deletes the old file): send only if the *source* lorebook on the server is still at the stamp's `rev`; else block
    - never stored: a stamp found in a file from the server is ignored and replaced
    - **(verify)** the editor and Memory Books save the object they loaded; no ST code chokes on the extra key
- **Characters, chats:** own sections

### Decision table (settings, lorebooks)

Server's current file read through the original `fetch` (`/api/settings/get`, `/api/worldinfo/get`).

| Situation | Action | `reason` |
|---|---|---|
| payload deep-equals its base (settings: ignoring `NOISY_SETTINGS_PATHS`) | **don't send, silent.** If server ≠ base, report `staleSettings` / `staleLorebooks` | — |
| server deep-equals base (settings: ignoring noisy paths) | **send**; fingerprint = sent payload | — |
| lorebook, server ≠ base, payload only **adds** entries (base entries unchanged, no deletions, no other field changed), no new `uid` exists on server | **send server's version + new entries**; put result in `worldInfoCache`; fingerprint and stamp = result | — |
| same, but a new `uid` exists on server | **block** (no renumbering) | `changed` |
| server ≠ base, anything else | **block** | `changed` |
| no base, file exists on server | **block** | `unseen` |
| no base, no file | **send** | — |
| server unreadable | **block** (fail closed) | `unreachable` |
| lorebook save while this page's chat is stale (Chats) | **block** | `chatStale` |

- **On block:** don't send; return the synthetic answer; lorebook → delete the name from `worldInfoCache`; compute `hadChanges` (payload vs base, ignoring noisy paths; `false` = nothing lost); report `saveBlocked { kind: "settings"|"lorebook"|"character", name?, reason: "changed"|"unseen"|"unreachable"|"chatStale", hadChanges: true|false|null }`
- **Why "no change → not sent":** ST saves settings after ordinary actions (opening a chat). This removes most stale saves and stops devices making each other stale. (The 1.9 persona bug was such a save)
- **Why noisy paths:** otherwise a phone in use keeps every desktop tab permanently stale and vice versa. `NOISY_SETTINGS_PATHS` = fields that change on their own on every device (last opened character, UI state…). Starts empty; fill on the emulator (save with no user change, diff vs fingerprint); one comment per path; keep short. Reused by the merge version
- **Why add-only re-apply, and its limit:** ST's `_save` ignores the response, so Memory Books can't tell a save failed and has already marked messages as done. No renumbering: Memory Books' entries reference each other by uid (`disabledBySummaryId`, rollback). So when **both** devices added an entry the uids collide almost always (each numbers from its old copy) → blocked + reported. The rule helps when the other device edited/deleted. Memory Books' plain memory add is add-only (`addlore.js`: `createWorldInfoEntry` + save); its consolidation / arc saves also edit older entries (`disabledBySummaryId`), so those are not add-only and block when stale. Memories are protected mainly by freshness and the stale-chat freeze

### Synthetic answers (status 200, JSON)

| Request | Answer | ST then |
|---|---|---|
| `/api/settings/save` | `{ "result": "ok" }` | checks `ok` only; sets `settings = payload` |
| `/api/worldinfo/edit` | `{ "ok": true }` | ignores it; emits `WORLDINFO_UPDATED` |
| `/api/characters/edit` | `{}` **(verify)** | calls `getOneCharacter` → re-reads the server's card |
| `/api/chats/save`, `/api/chats/group/save` | `{ "result": "ok" }` **(verify)** | treats chat as saved; guard marks it stale |

### Chats

**ST's integrity check doesn't stop stale saves.** `chat_metadata.integrity` is a uuid set once (when missing, in `getChat`; new one only for branches/checkpoints). The server refuses only when the file holds a *different* chat. An old copy of the same chat saves over newer messages. Also configurable off (`backups.chat.checkIntegrity`) and skipped for files without an id. **Confirm with two tabs + a throwaway chat before building.**

- **Never merged**
- **Fingerprint = message count + last message `send_date`** (from the chat as read, or as sent). Constant cost: chats of 1000+ messages expected; the chat is never downloaded to compare
- **Before a save:** get `chat_items` and `last_mes` from `/api/characters/chats` (small answer; file read on the PC) and compare both. `file_size` is **not** compared: after the page's own save the guard has no base for it without a read-back. `last_mes` is the last line's raw `send_date` (server falls back to the file's modified time when the message has none: then compare the count only). Match the request's `file_name` to the list's name, which includes `.jsonl` **Verify:** `chat_items` excludes the header line (server: `itemCounter - 1`) so it matches the payload's message count; the group equivalent (`/api/chats/group/info`); timing with a 1000-message chat **and** with a character that has many chats (the endpoint reads every chat file of that character on the PC per call: constant over the network, grows with the number of chats). There is no whole-chat fallback compare
    - same → send. Different or unreadable → **block**: synthetic OK, mark chat **stale**, report `chatSaveRefused { avatar?, groupId?, chatFile }` (from the request body: `avatar_url` + `file_name` for character chats, verified; group fields **verify**; never `characterId`, a list index that changes)
- **Accepted limit:** an edit/swipe of an older message elsewhere changes none of these values. Full compares happen at refresh points (chat re-read on tab focus / app return). The plugin's file hash closes it
- **While a chat is stale** (cleared only by a successful `/api/chats/get` or `/api/chats/group/get` for that chat; the app's 1.7 reload goes through `getChat`, so it counts). ST saves the chat when the user's message is added, before generating (`sendMessageAsUser` → `saveChatConditional`), so the block comes first:
    - **generation refused in the `fetch` wrapper** (not `generate_interceptor`: the app-injected copy has no manifest). The quick check also runs on a generation request itself
        - how: reject the `fetch` promise with `new DOMException('Chat changed on another device', 'AbortError')`, so ST handles it like Stop: no "API error" toast, no half-open stream **(verify ST's handling for streaming and non-streaming; the app's "…" card and Send/Stop state must end cleanly)**
        - match: `/api/backends/chat-completions/generate`, `/api/backends/text-completions/generate`, `/api/backends/kobold/generate`, `/api/novelai/generate`, plus any other `/api/backends/*/generate` (unknown text backend fails closed) **(verify on 1.19.0)**. Image generation (`/api/sd/…`, Phase 4 selfies) is **not** matched
    - **lorebook saves from this page refused** (`reason: "chatStale"`), added entries included (no memory of unsaved messages). **Exception: a save the user made themselves in the app's entry editor.** `bridge.js` marks the data it saves with a plain top-level `__ttUser: true`; the guard strips the mark from the body and lets that save go on to the normal version check. The mark skips only this freeze, nothing else. **The mark must not survive in the cache:** `saveWorldInfo` does `worldInfoCache.set(name, data)` without cloning (`cloneOnSet: false`) before it calls `fetch`, so the cached object carries the mark and every later copy (Memory Books') would inherit it. On a marked save the guard deletes `__ttUser` from the cache's own object (`Map.prototype.get.call(worldInfoCache, name)`), **synchronously on entry to the wrapper, before any `await`** (the `set` and the `fetch` call happen in the same tick, so no copy can be taken in between), whether the save is then sent or blocked. Desktop: no mark exists, so a World Info editor save in that short window is refused with a toast
    - all saves of that chat stay blocked
    - chat reloaded as soon as nothing generates; user's message put back in the box (desktop: extension; app: app)
    - one notice, no dialog: "This chat has new messages from another device. They're loaded now, and your message is back in the box."
- **Catch it before sending:** `checkChat()` = the quick check for the open chat only (no settings read, never leads to a page reload). Desktop: on message-box focus; `checkFresh()` (which includes it) on tab focus. If changed and not generating, reload the chat with ST's own reload (typed text stays, **verify**). App: `checkFresh` on return, `checkChat` before sending
- **Server `integrity` answer** (different chat under that name): desktop → pass through (ST's popup is visible). **App → replace** with synthetic OK + `chatSaveRefused`: the popup (`Popup.show.input`, `cancelButton: false`, `window.location.reload()` unless `OVERWRITE`) may be invisible in clean mode, leaving `saveChat` waiting with `isChatSaving` set, which later chat opens wait on
- **`force: true`** (after typed `OVERWRITE`): checked like any save, so blocked from a stale copy everywhere. App: never sent. Desktop, fresh copy: sent (typed confirmation satisfies the rule)

### Characters

**Opening, starting or restarting a chat saves the whole card:** `openCharacterChat()` → `createOrEditCharacter('newChat')` posts the edit form + `json_data` to `/api/characters/edit` only to record the current chat. A stale page reverts desktop card edits.

- **Fingerprint per avatar:** card as read from `/api/characters/get`, and `/api/characters/all` when it has full cards **(verify: shallow with lazy loading → only `/get`)**. Never the sent payload (the server rebuilds the card from form fields). After a save, ST's own `getOneCharacter` re-read sets it
- **Whenever the form's `chat` differs from the server's**, send `/api/characters/merge-attributes` `{ avatar, chat }` (ST's own one-field call, used by chat rename). Always safe, and done **whether or not the card itself is sent or blocked**, so the current chat is never lost
- **Form equals fingerprint except `chat`, no new picture** → **don't send the card**; synthetic OK; nothing reported **(verify form-to-card mapping incl. `json_data`)**
- **Any other card save** (ST's editor; or the chat-only detection failed: unknown fields, no full card read yet): read `/api/characters/get`, compare card fields (ignore `chat`, dates, list-only fields; **verify shapes**). Same → send. Different / no fingerprint → block, synthetic OK, `saveBlocked { kind: "character", name, hadChanges }` where `hadChanges` = fields other than `chat` differ from the fingerprint (`null` without a fingerprint). So a misfire on a plain chat open reports `false` / `null`, not a lost edit
- `/api/characters/merge-attributes`, `/edit-attribute` pass through

### Other writers

- Lorebook delete, settings snapshot restore, character delete: confirmed in ST's own dialogs → pass through
- Lorebook rename / duplicate: covered by the stamp's `name`. Import over an existing name: ST asks first **(verify)**
- **Presets, Quick Replies, themes, groups: unguarded whole-file saves.** Next version; blocker for the app's 1.8

### ST version check

URL matching fails silently if ST renames an endpoint. `TESTED_ST_VERSIONS` range in the guard; version from `/version`. Outside → `guardInfo.untestedServer: true`; desktop: one toast per version ("TravelingTavern hasn't been tested with this SillyTavern version yet"). Each ST release: re-check Guarded requests, widen the range.

### `checkFresh()` → `{ settingsChanged, lorebooksChanged: [names], chatChanged }`

- Compares settings (ignoring noisy paths), every lorebook in `worldInfoCache`, and the open chat (quick check) with the server
- Changed lorebooks: delete from `worldInfoCache`; if open in the World Info editor, `reloadEditor(name)`
- Reports `staleSettings` / `staleLorebooks { names }`. Never reloads the page itself
- Settings at most once per 5 s (large answer); within that, return the last result
- Read failure = unknown, not changed

## `index.js`

1. Always set `window.__ttExtension = { version, guardVersion }`, then dispatch `tt-extension-ready` on `window` (also when standing down) (`version` = manifest semver, for display; `guardVersion` = the integer `GUARD_VERSION` of the `save-guard.js` it ships, for comparing)
2. `__ttSaveGuard` exists (app injected it) → stop. No second guard, no toasts
3. Else (desktop): set `window.__ttGuardSource = "extension"`, import `save-guard.js`, then **seed from the page's own state** (extensions load after ST's first reads; a read-back would be wrong). The guard does this itself whenever it starts late (also the app's fallback injection):
    - settings: `import { settings, settingsReady } from '/script.js'` (`export let settings`: the parsed file at load, the payload after each save = exactly what the page holds). **Wait until `settingsReady` is true** (the app's fallback injection at `onPageFinished` can run before `getSettings()` finishes; `settings` is `undefined` until then), then deep-copy it as the fingerprint. A settings save before that has no base (ST itself refuses to save while `!settingsReady`). The extension always starts after it: ST activates extensions inside `loadExtensionSettings(settings, …)`. No startup window
    - characters: fingerprints from the exported `characters` array (full cards only); open chat: count + last `send_date` from the exported `chat` **(verify both exports)**
    - lorebooks: clear `worldInfoCache` so every lorebook is re-read through the guard
4. The guard posts `guardInfo { guardVersion, extensionVersion?, extensionGuardVersion?, stVersion, untestedServer }` once per page load (extension fields read from `__ttExtension` when present). The guard listens for `tt-extension-ready` and posts `guardInfo` again, since in the app's page the extension loads after the guard

**Desktop UI** (`toastr` only; never reloads the page by itself):

- Blocked save → sticky warning toast with **Reload**:
    - settings, `hadChanges: true`: "Settings changed on another device, so this change wasn't saved. Reload to get the latest."
    - settings, `hadChanges: false`: no toast (optional quiet info toast; decide on the emulator)
    - lorebook: "Lorebook {name} changed on another device, so this change wasn't saved. It will load fresh next time you open it."
    - unreachable: "Couldn't reach the server, so this change wasn't saved."
- `visibilitychange` → visible, and message-box focus: `checkFresh()`. Settings changed → info toast "Settings changed on another device." + **Reload**. Lorebooks and chat refresh quietly
- Extensions panel: "TravelingTavern {version}: protecting saves"

## Tests

**Unit (`node --test`, fake `fetch`):**

- every Decision-table row; fail closed; queue (second save compares against the first's payload)
- fingerprint after own save = sent payload (a write between save and a would-be read-back → next stale save blocked)
- `hadChanges` true / false / null; noisy-only difference sent; no-change save not sent
- deep-equal ignores key order and whitespace; gzip bodies (once verified)
- stamp: added on read, stripped on send, never in a sent body; older copy blocked after a newer re-read; rename from a stale copy blocked; no stamp → name fingerprint
- add-only re-apply; uid collision, edited base entry or deletion → block
- chat: stale blocked until re-read; own consecutive saves pass; generation and lorebook saves refused while stale, allowed after; unknown generate endpoint fails closed
- `force`: never sent in the app; desktop only from a fresh copy; server `integrity` replaced in the app, passed through on desktop
- character: chat-only save → `merge-attributes`, card never sent; other save from a stale card blocked
- XHR to a guarded URL refused; installs once; other requests untouched; untested version → `untestedServer`
- hash: pure JS, equal for reordered keys, runs without `crypto.subtle`; `source` taken from `__ttGuardSource` at install
- generation refusal rejects with `AbortError`; `/api/sd/…` not matched
- late start waits for `settingsReady`, then seeds settings from the page's `settings` export; `tt-extension-ready` → `guardInfo` posted again; `checkChat` makes no settings request; `__ttUser` save passes the stale-chat freeze but not the version check, and the mark is never sent; after a marked save (sent or blocked) `worldInfoCache.get(name)` has no `__ttUser`, and a following unmarked save while the chat is stale gets `chatStale`; stale cleared only by a chat read; last message without `send_date` → count only; `merge-attributes` sent when `chat` changed even if the card is blocked; lorebook save while chat stale → `chatStale`

**Manual** (desktop Chrome + app on emulator, ST 1.19.0, throwaway persona / lorebook / chat):

- [ ] Install from `main`; panel line shows; release a newer version to `main`; ST's Update works
- [ ] Phone creates a persona; old desktop tab clicked around → nothing sent or blocked silently; persona kept. With a real desktop change → toast
- [ ] Phone edits a lorebook entry; desktop (lorebook loaded earlier) edits another → blocked, toast, phone's edit kept
- [ ] Desktop edits an entry; Memory Books on the phone adds a memory from its old copy → both in the file
- [ ] World Info editor open; phone changes the lorebook; tab refocus → editor shows it. Edit without refocus → blocked
- [ ] Rename a lorebook in a stale tab → blocked, nothing deleted
- [ ] Desktop edits a character description; stale phone opens that character's chat → description kept
- [ ] Phone adds messages; click the desktop message box → chat reloads first
- [ ] Same, sending immediately → blocked, **no reply, no memory**, chat reloads, text back in the box
- [ ] 1000-message chat: delay added per sent message not noticeable
- [ ] `OVERWRITE` typed on a stale copy → blocked; on a fresh copy → saved
- [ ] Nothing changed elsewhere → saves as before, no toasts
- [ ] In the app with the extension installed → one guard (`source: "app"`), `__ttExtension.version` set, no desktop toasts

Optional: GitHub Action running `npm test` on push. Release to `main` (PR from `dev`), tag `v0.1.0` there.

## Verified in source (ST 1.19.1 `release`)

- `script.js` line 615 `export let settings;` set at load (`JSON.parse(data.settings)`) and after each save (`settings = payload`)
- `/api/characters/chats`: reads every `.jsonl` of the character via `getChatInfo` (`chat_items = itemCounter - 1`); `simple: true` returns names only
- Settings, lorebook, chat, character saves all use `fetch` (no XHR / `sendBeacon` / `keepalive`)
- `/api/settings/save` writes `JSON.stringify(body, null, 4)`, answers `{ result: 'ok' }`; `/api/worldinfo/edit` writes `body.data` the same way
- `saveSettings()` builds the payload from page globals (`power_user`, `extension_settings`, `oai_settings`, …); no in-page re-read exists, only a page load
- `saveSettings()`: non-OK → "Settings could not be saved" toast; OK → `settings = payload`. `saveSettingsDebounced` = 1000 ms
- `_save()` (lorebooks) ignores the response, always emits `WORLDINFO_UPDATED`; `saveWorldInfo()` debounced unless `immediately`
- Memory Books (aikohanasaki/SillyTavern-MemoryBooks): `loadWorldInfo` → `createWorldInfoEntry` → `saveWorldInfo(…, true)`; keeps uid references between entries
- `saveChat` sends `force` in the JSON body; the server answers `{ error: 'integrity' }` on an id mismatch
- Plugins: off by default (`enableServerPlugins`); router only under `/api/plugins/{id}`, mounted after ST's routes → **can't intercept ST's save routes**; no install API (`node plugins.js install <url>` + restart)
- `/api/extensions/install` `{ url, global, branch }` (admin only for `global`); `/api/extensions/update` `{ extensionName, global }` → `git pull origin {current branch}`
- Backups: chats per save (throttled, 50 kept); settings auto (throttled); **lorebooks none**

## Not in v0.1.0

- Merge; lorebook snapshots (with merge, via ST user files)
- Presets, Quick Replies, themes, groups
- Moving `bridge.js` into the extension (undecided)
- Plugin features: atomic writes, file hashes, change notices, leases
