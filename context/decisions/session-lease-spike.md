# Session-Lease Spike: Results

2026-11-20. Spike from `direction-change.md`, part 1 (desktop) only. Run against SillyTavern 1.19.0 in desktop Chrome, two to four tabs. Spike code lives on the local branch `spike/session-lease` (throwaway, not pushed, never merges): v1 `9673a60` refuse while parked · v2 `e2e692c` hold requests, modal overlay, ignore dry runs, 3 s grace · v3 `b12a3de` abort held requests, check every write, 1 s grace, re-raise overlay, reopen chat · v3.1 `a1aa3ba` log why a lease check fails.

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

## Findings

- **False park of the real holder:** `/api/files/upload` answered 500 on a lease metadata write right after a takeover reload (seen 4 times, reproduced). Server error: `EPERM: operation not permitted, rename 'tt-session-lease.json.<n>' -> 'tt-session-lease.json'` from `write-file-atomic` (`renameSync`, no retry). Windows refuses to rename over a file another handle has open (a concurrent lease read, or a virus scanner on the fresh file). Transient
- **Memory Books creates default files when a read fails** (`stmb-side-prompts.json`, and a "clean document" for context settings). In a parked tab this must stay impossible; in the holder a transient read failure can still overwrite user files, outside our control
- `GENERATION_STARTED` also fires for dry runs (prompt assembly only) with no end event
- A held chat save keeps ST's `isChatSaving` set; ST's `beforeunload` then blocks the reload ("Leave site?")
- ST popups are modal dialogs: anything outside them is inert, including an overlay opened earlier
- The holder sends `POST /api/quick-replies/save` on every page load (whole-file save at load)
- After updating the extension, one tab kept running cached code until closed

## Verdict

The session lease protects every data type tested with one rule and no knowledge of ST's save endpoints. Parking is tolerable with held requests: ST stays quiet behind the overlay, and a switch costs about 3.5 s. It is **not safe as spiked**: one exemption let a parked tab overwrite real user files, and a transient Windows error parks the real holder. Both have clear fixes (below). Proceed to a spec with the requirements below, then run part 2 (the app) on a separate install before building the release.

## Requirements for the spec

1. **The wrapper exempts nothing.** Lease reads and writes use the original `fetch`; no request is let through by URL while parked
2. **Parked = hold.** Server-data requests (`/api/…`, `/user/…`, any non-GET) are held, never refused; static files load
3. **Before a reload, abort only held chat saves** (so `isChatSaving` clears and `beforeunload` doesn't block). Leave held reads pending, so no extension sees a failed read and writes a default file. No held request is ever sent
4. **A page becomes writable only through a fresh load that holds the lease.** A page that lost the lease never re-claims by itself
5. **Re-read the lease before every write.** Reads may trust a read up to 2 s old; decide on an allowlist of read-only endpoints that skip the check after measuring from the Pixel over Tailscale
6. **Claim:** wait for `busy` to clear (with timeout), write `epoch + 1`, wait the grace period (1 s), re-read, require holder **and** epoch to be ours, reload
7. **Lease writes retry on failure:** re-read; if holder and epoch are still ours, stay holder and retry a bounded number of times, ~100–200 ms apart; park only if the claim changed or the lease can't be read. Write the lease less often (skip an unchanged `active`). A failed `busy: true` write is not metadata: don't start the generation, or tell the user
8. **`busy` ignores dry runs**
9. **Overlay** is a `<dialog>` opened with `showModal()`, re-raised whenever another dialog opens while parked; Escape can't close it
10. **Reopen the chat after a takeover** from the lease's `active` (avatar or group id + chat file); don't let startup's empty `CHAT_CHANGED` erase it
11. **Fail closed:** lease unreadable → park
12. **Open:** WebSockets; Memory Books' default-file behavior in the holder; part 2 (app: hold first requests at document start, foreground takeover, release in background)
13. **`coding-standards.md` must be updated** before building: the bounded retry delay and the grace wait are one-off delays. Allow one-off delays; keep the ban on polling and repeating timers. The spike's wait for `busy` re-reads the lease every second, which is polling: the spec must replace it or name it as a bounded exception
14. **Testing:** every manual test, spike and cleanup on a separate SillyTavern install; no unreleased guard or lease code in the install in daily use
