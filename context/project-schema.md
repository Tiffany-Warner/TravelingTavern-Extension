# TravelingTavern Extension — Project Schema

> One SillyTavern page writes at a time, so nothing you saved gets erased by a page that didn't know about it. A SillyTavern extension that parks every other page behind "Use here".

---

## How It Fits Together

- **SillyTavern:** holds all the data. Its pages read a file once and later save the whole file from their own copy
- **`session-lease.js`:** one page per SillyTavern user holds the lease and writes; the others are parked, requests held, until **Use here** claims and reloads
- **Desktop tabs:** get the lease, overlay and toasts from this extension
- **[TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern) (Android app):** bundles `session-lease.js` (submodule pinned to a tag), injects it at document start, shows a native parked state
- **TravelingTavern-Bridge (later, optional):** a server plugin that could enforce the lease on the server

Stack and rules: `CLAUDE.md`.

---

## Setup

- [x] Public repo `TravelingTavern-Extension`; `dev` branch created from `main`; `main` protected
- [x] `CLAUDE.md` and context files
- [x] `manifest.json`, `index.js`, `LICENSE`, `README.md`, `test/` running under `node --test`
- [x] Two-tab check: an old copy of a chat really saves over newer messages
- [x] Separate test install for every manual test, spike and cleanup

---

## Phase 1 — Session Lease (`v0.2.0`)

> Goal: only one SillyTavern page per user can write; every other page is parked until the user takes over.
> **Unblocks TravelingTavern** `0.1.20`.

Spec: `context/specs/ext-0.2-session-lease-spec.md`. Decision and evidence: `context/decisions/session-lease-spike.md`.

- [x] Spike (desktop and app) and the two specs
- [x] Slice 1: files, pair rule, writes (E2, E3)
- [x] Slice 2: claim, start decision, release (E4, E5)
- [x] Slice 3: request wrapper and app contract (E6, E7, E11)
- [x] Slice 4: overlay and toasts (E9, E12)
- [x] Slice 5: `busy` from generation requests (E8)
- [x] Slice 6: reopen and reconnect after a takeover (E4, E10)
- [x] Tag `v0.2.0-rc.1` on `dev` for the app to build and test against (`rc.2`–`rc.5` tagged for the app's fixes and the way-out buttons)
- [x] Full manual checklist on the test install against the rc (E14: on rc.4, rc.5 re-runs; a real Chrome prerender not reproduced)
- [x] Release to `main`, tag `v0.2.0`

---

## Phase 2 — Server Plugin Support

> Goal: with TravelingTavern-Bridge installed, the known limits (E13) close; without it, everything above still works.
> Depends on the plugin, built for TravelingTavern's Phase 8.

- [ ] The server refuses writes from a page that isn't the holder
- [ ] Takeover without a reload, if the server can tell pages their data changed
- [ ] The Phase 8 headless page holds the lease like any other page (decided with Phase 8)

---

## Later Ideas

- Moving the app's `bridge.js` into this extension, so there is one copy for every page

---

## Out of Scope (for now)

- Changing SillyTavern's look or behavior beyond parking, the overlay and the spec's toasts; modifying its code
- Keeping copies of chats, lorebooks or settings
- Real-time sync between open pages
- Merging changes from two devices (with one writer at a time there is nothing to merge)

---

## Accepted Risks

The spec's Known Limits (E13), with what would close each.

---

## Context Files

| File | Purpose |
|---|---|
| `CLAUDE.md` | Stack, versioning, Hard Rules |
| `context/ai-guidelines.md` | Workflow, branches, releases, private data, commits |
| `context/coding-standards.md` | How to write the code: timers, lease structure, wrapper, logging, tests |
| `context/current-feature.md` | Active feature, release order, latest history |
| `context/history.md` | All history entries, newest first |
| `context/project-schema.md` | This file: phases and roadmap |
| `context/specs/ext-0.2-session-lease-spec.md` | The session lease (E1–E15) |
| `context/specs/ext-0.2-st-source-notes.md` | SillyTavern source findings per version (spec E15) |
| `context/decisions/session-lease-spike.md` | The decision, the spike's verdict, requirements R1–R44 and their map |
