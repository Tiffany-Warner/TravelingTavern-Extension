# TravelingTavern Extension — Project Schema

> Nothing you saved gets erased by a page that didn't know about it. A SillyTavern extension that stops any open page from saving an old copy of your data over a newer one.

---

## Tech Stack

- **Language**: JavaScript. `index.js` is an ES module; `save-guard.js` is a classic script (one IIFE, no imports)
- **Runs in**: SillyTavern, as a third-party extension (no build step). `save-guard.js` also runs when injected by the TravelingTavern app or by Playwright
- **SillyTavern APIs**: its save and read endpoints (wrapped through `fetch`), module exports (`/script.js`, `/scripts/world-info.js`), `toastr`
- **Storage**: none. The guard only compares; it keeps no copies of SillyTavern data
- **Tests**: Node's built-in runner (`node:test`, `node:assert`), no dependencies
- **Constraints**: no dependencies, no secure-context APIs (pages may load over plain `http://`)

## How It Fits Together

- **SillyTavern (desktop):** holds all the data. Its pages read a file once and later save the whole file from their own copy
- **`save-guard.js`:** sits between a page and its save requests. A save is sent only if the server's file is still the version that copy came from; otherwise it is blocked and reported
- **Desktop browser tabs:** get the guard from this extension, plus toasts and freshness checks on focus
- **[TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern) (Android app):** bundles the same `save-guard.js` through a git submodule pinned to a tag, injects it into its WebView at document start, and shows its own native messages. It offers to install this extension on the desktop
- **TravelingTavern-Bridge (server plugin, later, optional):** gives the guard an atomic write and cheap file versions, and runs proactive messages. The guard works without it

**The rule:** nothing here may delete or overwrite SillyTavern data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

---

## Setup

> Goal: The repo is ready for work.

- [ ] Public repo `TravelingTavern-Extension`; `dev` branch created from `main`; `main` protected
- [ ] `CLAUDE.md` and context files (`ai-guidelines.md`, `coding-standards.md`, `current-feature.md`, `project-schema.md`)
- [ ] `context/specs/ext-0.1-save-guard-spec.md`
- [ ] `manifest.json`, empty `index.js` that loads in SillyTavern, `LICENSE`, `README.md`
- [ ] `test/` folder with one passing placeholder test, so `node --test` runs
- [ ] Two-tab check on a throwaway chat: an old copy of a chat really saves over newer messages (the chat guard is built on this)

---

## Phase 1 — Save Guard (`v0.1.0`)

> Goal: No SillyTavern page can save a stale copy of settings, a lorebook, a chat or a character card over newer data.
> **Unblocks TravelingTavern** `0.1.20`.

Spec: `context/specs/ext-0.1-save-guard-spec.md`

- [ ] Guard core: `fetch` wrapper, save queue, `conditionalWrite`, fail closed, reporting to the app or the desktop UI
- [ ] Settings: fingerprint, no-change saves not sent, noisy fields, `hadChanges`
- [ ] Lorebooks: revision stamp, add-only re-apply, rename protection
- [ ] Chats: quick check (message count + last message time), stale-chat freeze (no generation, no lorebook saves), `force` rule
- [ ] Characters: chat-only saves become a one-field update; stale card edits blocked
- [ ] `checkFresh` / `checkChat`; late-start seeding from the page's own state
- [ ] Extension: `index.js`, desktop toasts, focus checks, version announce
- [ ] SillyTavern version check (`TESTED_ST_VERSIONS`)
- [ ] Unit tests and the manual checklist, including the two-page tests
- [ ] Release to `main`, tag `v0.1.0`

---

## Phase 2 — Remaining Whole-File Saves

> Goal: Everything SillyTavern's full UI can save whole is guarded.
> **Unblocks TravelingTavern** 1.8 (Advanced: full SillyTavern UI in the app).

- [ ] Presets
- [ ] Quick Replies
- [ ] Themes
- [ ] Groups
- [ ] Any other whole-file save found by reviewing SillyTavern's save endpoints

---

## Phase 3 — Merge Instead of Block

> Goal: Changes made on two devices to different parts of a file are both kept.

- [ ] Three-way merge for lorebooks, entry by entry (no renumbering; same entry changed on both sides keeps the server's)
- [ ] Three-way merge for settings, field by field
- [ ] Conflict handling: keep the server's version and say so; "Use my version instead" only behind a confirmation dialog
- [ ] Lorebook snapshots before each merge or re-apply (SillyTavern keeps no lorebook backups), with a way to restore
- [ ] Chats are never merged

---

## Phase 4 — Server Plugin Support

> Goal: With TravelingTavern-Bridge installed, the last gaps close. Without it, everything above still works.
> Depends on the plugin, built for TravelingTavern's Phase 8.

- [ ] `conditionalWrite` uses the plugin's atomic endpoint when present (closes the check-then-save gap)
- [ ] File hashes from the plugin replace the large settings read and the quick chat check (closes the older-message gap)
- [ ] Change notices from the plugin replace focus checks
- [ ] Leases per character, so only one page writes a character's chat and lorebooks at a time

---

## Later Ideas

- Moving the app's `bridge.js` into this extension, so there is one copy for every page
- A settings panel listing recent blocked saves

---

## Out of Scope (for now)

- Changing how SillyTavern looks or behaves beyond blocking stale saves and the spec's toasts
- Modifying SillyTavern's own code
- Keeping copies of chats, lorebooks or settings (except Phase 3's lorebook snapshots)
- Real-time sync between open pages
- Extra lorebooks, conflict copies or duplicate files of any kind

---

## Accepted Risks (until Phase 4)

- **Check-then-save gap:** two pages saving the same file within a fraction of a second
- **Older-message edits in chats:** the quick check doesn't see an edit to an earlier message made elsewhere

---

## Context Files

| File | Purpose |
|---|---|
| `context/ai-guidelines.md` | How Claude Code should behave: workflow, branches, releases, private data |
| `context/current-feature.md` | Active feature being worked on |
| `context/coding-standards.md` | JavaScript and data safety rules |
| `context/project-schema.md` | This file: phases and roadmap |
| `context/specs/` | Feature specs, one per feature |
