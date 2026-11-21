# TravelingTavern Extension — Project Schema

> One SillyTavern page writes at a time, so nothing you saved gets erased by a page that didn't know about it. A SillyTavern extension that parks every other page behind "Use here".

---

## Tech Stack

- **Language**: JavaScript. `index.js` is an ES module; `session-lease.js` is a classic script (one IIFE, no imports)
- **Runs in**: SillyTavern, as a third-party extension (no build step). `session-lease.js` also runs when injected by the TravelingTavern app at document start, or by Playwright
- **SillyTavern APIs**: user files (`/user/files/…`, `/api/files/upload`) for the two lease files, its events and context functions, `toastr`
- **Storage**: two small JSON files in the SillyTavern user's files (`tt-session-lease.json`, `tt-session-release.json`). No copies of SillyTavern data
- **Tests**: Node's built-in runner (`node:test`, `node:assert`), no dependencies
- **Constraints**: no dependencies, no secure-context APIs (pages may load over plain `http://`)

## How It Fits Together

- **SillyTavern (desktop):** holds all the data. Its pages read a file once and later save the whole file from their own copy
- **`session-lease.js`:** runs in every TravelingTavern-controlled page. One page per SillyTavern user holds the lease and writes; every other page is parked, with its server requests held. **Use here** claims the lease and reloads the page from fresh data
- **Desktop browser tabs:** get the lease from this extension, plus the overlay and toasts. A browser without the extension doesn't take part
- **[TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern) (Android app):** bundles the same `session-lease.js` through a git submodule pinned to a tag, injects it at document start, and shows its own native parked state. It offers to install this extension on the desktop
- **TravelingTavern-Bridge (server plugin, later, optional):** could enforce the lease on the server and run proactive messages. The lease works without it

**The rule:** nothing here may delete or overwrite SillyTavern data unless the user confirmed it in a dialog. Saving an older copy over newer data counts as deleting.

---

## Setup

> Goal: The repo is ready for work.

- [ ] Public repo `TravelingTavern-Extension`; `dev` branch created from `main`; `main` protected
- [x] `CLAUDE.md` and context files (`ai-guidelines.md`, `coding-standards.md`, `current-feature.md`, `project-schema.md`)
- [x] `manifest.json`, empty `index.js` that loads in SillyTavern, `LICENSE`, `README.md`
- [x] `test/` folder with one passing placeholder test, so `node --test` runs
- [x] Two-tab check on a throwaway chat: an old copy of a chat really saves over newer messages
- [x] Separate SillyTavern test install for every manual test, spike and cleanup

---

## Phase 1 — Session Lease (`v0.2.0`)

> Goal: Only one SillyTavern page per user can write; every other page is parked until the user takes over.
> **Unblocks TravelingTavern** `0.1.20`.

Spec: `context/specs/ext-0.2-session-lease-spec.md`. Decision and evidence: `context/decisions/direction-change.md`, `session-lease-spike.md`.

- [x] Spike (desktop and app) and the two specs
- [ ] Lease and release files, pair rule, `format` (E2)
- [ ] Lease writes: one in flight, bounded retry (E3)
- [ ] Claim, takeover, start decision, reopening the chat (E4)
- [ ] Release on `pagehide`, back/forward cache (E5)
- [ ] Request wrapper: held, no exemptions, read allowlist (E6); parking and reloads (E7)
- [ ] `busy` from generation requests (E8)
- [ ] Desktop overlay and toasts (E9); model connection after a takeover (E10)
- [ ] App contract: `window.__ttLease`, `leaseState`, `leaseInfo`, one instance per page (E11)
- [ ] SillyTavern version check (E12)
- [ ] Unit tests and the manual checklist on the test install (E14)
- [ ] Tag `v0.2.0-rc.1` on `dev` for the app to build and test against
- [ ] Release to `main`, tag `v0.2.0`

---

## Phase 2 — Server Plugin Support

> Goal: With TravelingTavern-Bridge installed, the lease's known limits close. Without it, everything above still works.
> Depends on the plugin, built for TravelingTavern's Phase 8.

- [ ] The server refuses writes from a page that isn't the holder (closes slow writes and pages without the lease)
- [ ] Takeover without a reload, if the server can tell pages their data changed
- [ ] The Phase 8 headless page holds the lease like any other page (decided with Phase 8)

---

## Later Ideas

- Moving the app's `bridge.js` into this extension, so there is one copy for every page

---

## Out of Scope (for now)

- Changing how SillyTavern looks or behaves beyond parking, the overlay and the toasts in the spec
- Modifying SillyTavern's own code
- Keeping copies of chats, lorebooks or settings
- Real-time sync between open pages
- Merging changes from two devices (with one writer at a time there is nothing to merge)

---

## Accepted Risks (until Phase 2)

The full list with what would close each is in the spec's Known Limits (E13). The main ones:

- **Pages without the lease** (a browser without the extension, other clients) write freely
- **A write slower than the grace period plus a reload** could land after a takeover
- **Release is best effort:** a crash leaves the lease held until someone taps Use here

---

## Context Files

| File | Purpose |
|---|---|
| `context/ai-guidelines.md` | How Claude Code should behave: workflow, branches, releases, private data |
| `context/current-feature.md` | Active feature being worked on |
| `context/coding-standards.md` | JavaScript and data safety rules |
| `context/project-schema.md` | This file: phases and roadmap |
| `context/specs/` | Feature specs, one per feature |
| `context/decisions/` | Decisions with their evidence (direction change, architecture assessment, the spike) |
