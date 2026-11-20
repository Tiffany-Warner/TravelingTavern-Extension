# Direction Change: Stop the Save Guard, Spike the Session Lease

2026-11-20. Owner decision. Read this before doing anything else in `TravelingTavern` or `TravelingTavern-Extension`. Background and evidence: `architecture-assessment.md` (read it too).

## Decision

- **Stop** implementing the per-save guard (`ext-0.1-save-guard-spec.md`, `fix-stale-page-overwrites-spec.md`).
- **New direction:** one active SillyTavern (ST) page at a time, enforced by a **session lease** ("Use here"). To be validated by a spike before any spec is written.
- **Accepted by the owner:** one device at a time, with a reload on each switch.

**Unchanged rule:** nothing TravelingTavern runs may delete or overwrite ST data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

## Why

The guard retrofits per-file version checks onto a system built for one page. It needs a different mechanism for each data type, depends on about a dozen ST endpoints and several internals, and fails silently when one is missed. Three reviews each found a new hole. The lease covers every write with one rule and depends on almost nothing inside ST.

## Do now, in this order

1. **Stop.** Write no more guard code. Don't start anything from the two guard specs.
2. **Report the current state before changing it,** for both repos: branches, uncommitted changes, commits made for the guard work, files added. Wait for my answer.
3. **Delete nothing.** No branches, files, specs or commits removed or reverted without asking. The guard specs hold source findings we still need.
4. **Mark as superseded** (after I confirm step 2): add one line at the top of each guard spec: `> Superseded 2026-11-20 by the session-lease direction. Kept for its source findings. Do not implement.`
5. **Update `current-feature.md`** in each repo: guard work stopped; next is the session-lease spike in the extension repo; the app is blocked on its result.
6. **Then run the spike** below, on branch `spike/session-lease` from `dev` in `TravelingTavern-Extension`. Spike code is throwaway: it does not merge to `dev`.
7. **Report results** against the checklist. No spec, no app changes, until I've seen them.

Normal rules still apply: ask before every commit, never push to `main`, nothing private in a public repo, never test against real data.

## What carries over

- The extension repo, its `CLAUDE.md`, `ai-guidelines.md`, `project-schema.md` (to be revised after the spike; don't revise yet)
- Distribution: the app injects one script into its WebView at document start; the extension loads the same script in desktop tabs; the app pulls it in through a git submodule pinned to a tag; `dev` / `main` branching
- App plumbing: reload through `WebViewHolder` keeping the screen, snackbar pattern, extension install prompt, `ProcessLifecycleOwner` for foreground / background
- Source findings (ST 1.19.1), still true and still relevant:
    - ST core has no awareness of other open pages
    - whole-file saves: settings, lorebooks, chats, character cards (on every chat open), presets, Quick Replies, themes, groups
    - `chat_metadata.integrity` names a chat, not a version
    - lorebooks have no server backups
    - server plugins can't intercept ST's own routes
    - the app loads ST over plain `http://`: no `crypto.subtle`

## What is dropped

Fingerprints, lorebook revision stamps, `NOISY_SETTINGS_PATHS`, `hadChanges`, add-only re-apply, the quick chat check, stale-chat freeze, `__ttUser`, character-save rewriting, synthetic answers per endpoint, `conditionalWrite`, three-way merge, separate guarding of presets / Quick Replies / themes / groups, `TESTED_ST_VERSIONS` endpoint audits.

## The design to spike

- **Lease file:** one per ST user, e.g. `tt-session-lease.json`: `{ holder, epoch, claimedAt, busy, active }`
    - write: `POST /api/files/upload` `{ name, data }` (`data` base64; atomic; overwrites; name must match `[a-zA-Z0-9_.-]`)
    - read: `GET /user/files/tt-session-lease.json` with `cache: 'no-store'`
    - `holder` = a page id generated once and kept in `sessionStorage` (survives reload, unique per tab)
    - `epoch` = integer, +1 on every claim
    - `active` = reserved for Phase 8 (which chat the holder has open); write it, don't use it yet
- **Holder:** the only page that talks to the server. ST runs unmodified. No per-file logic.
- **Parked (any page that isn't the holder):** the `fetch` wrapper refuses **every** request except lease reads and writes; an overlay says "SillyTavern is in use on another device." with a **Use here** button.
- **Take over** = write the lease with own id and `epoch + 1` → wait a grace period (start with 3 s) → re-read and confirm still holder → reload the page. A page only becomes writable through a reload, so a holder is never stale.
- **Noticing a lost lease:** re-read the lease on tab focus / `visibilitychange`, on first interaction after idle, and before any request when the last read is older than 2 s. Grace period must stay longer than this.
- **Takeover only on a human action:** the **Use here** click on the desktop; the app returning to the foreground (automatic). A page that discovers it lost the lease while on screen parks itself; it never re-claims on its own.
- **New page load:** not the holder → park. If the lease is free, claim and reload once.
- **`busy`:** the holder sets it while generating and clears it after. A page taking over waits for it to clear (with a timeout and a "finishing a reply on your other device" note).
- **Fail closed:** lease can't be read → treat as parked.
- **App specifics (after the desktop spike passes):** injected at document start, the wrapper holds ST's first requests until the lease is claimed, so no second load; release the lease when the app goes to the background.

## Spike

**Goal:** prove or disprove that parking pages is safe and tolerable in real ST. About 150 lines, one throwaway extension, no tests required, no polish.

**Part 1: two desktop tabs** (ST 1.19.x, throwaway persona / lorebook / character / chat)

- [ ] Lease read is never served from cache (change it in tab A, read it in tab B)
- [ ] Parked tab: ST shows no error storm or broken state behind the overlay; nothing reaches the server (check the Network panel)
- [ ] **Use here** reloads and lands on a usable page; note whether the same chat reopens
- [ ] Persona created in tab A survives clicking around old tab B, then taking over in B
- [ ] Chat messages sent in A survive the same; B shows them after takeover
- [ ] Memory Books in the holder creates a memory normally; a parked tab's Memory Books writes nothing
- [ ] Character card edited in A is intact after B (old) takes over and opens that character's chat
- [ ] Takeover while A is generating: B waits for `busy`; A's reply is saved
- [ ] A save queued in A just before B takes over (settings debounce): refused, or sent and then visible in B. Never applied after B has loaded
- [ ] Two tabs clicking **Use here** at nearly the same time: exactly one ends up holder
- [ ] Server unreachable: page parks, nothing sent
- [ ] Time from **Use here** click to usable page

**Part 2: the app** (only if part 1 passes)

- [ ] Script injected at document start can hold ST's first requests until the lease is claimed; ST loads normally afterwards
- [ ] App to foreground takes over automatically; desktop tab is parked on its next check
- [ ] Desktop takes over while the app is on screen: app parks, shows a "Continue here" state, nothing sent
- [ ] App to background releases the lease; a desktop tab can then claim without waiting

**Report:** each box pass / fail with what was seen, the measured switch time, anything in ST that depends on a request succeeding while parked, and any request type that bypasses `fetch`.

## Not decided yet (don't build)

- Final names, message contract with the app, and the new specs: written after the spike
- Phase 8: how a proactive message is written when another page holds the lease. Planned approach: the hidden page only generates the text; the active page saves it
- Whether a server plugin later holds the lease instead of a file
- Fallback if the spike fails: a reduced guard (settings and character saves only) plus freshness checks
