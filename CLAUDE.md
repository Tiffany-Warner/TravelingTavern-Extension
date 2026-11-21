# TravelingTavern Extension

A SillyTavern extension that lets only one SillyTavern page write at a time: a **session lease**. The page that holds the lease writes; every other page is parked behind an overlay with **Use here**, its requests to the server held, until the user takes over, which reloads it from fresh data. It is the desktop half of the [TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern) Android app's data protection: the app bundles the same lease, and this extension brings it to every desktop browser tab.

SillyTavern pages read settings, lorebooks, chats and character cards once, then save the **whole file** from their own copy. A page left open on one device erases whatever another device saved since. With the lease, only a page that loaded while holding it can write.

## Context Files

Read the following at the start of every session:

- @context/ai-guidelines.md
- @context/coding-standards.md
- @context/current-feature.md
- @context/project-schema.md

Spec: `context/specs/ext-0.2-session-lease-spec.md` (the app side: TravelingTavern's `context/specs/session-lease-app-spec.md`). Requirements, the spike's evidence and the requirement map: `context/decisions/session-lease-spike.md`. Superseded and kept for its source findings: `context/specs/ext-0.1-save-guard-spec.md`.

## Commands

```bash
node --test    # run the automated tests (Node's built-in runner, no dependencies)
```

There is no build step: SillyTavern loads the extension's files directly. To try a change, install the branch in the **separate test SillyTavern install** (never the one in daily use), then hard-refresh the page (Ctrl+Shift+R).

## Stack

- **Plain JavaScript**, loaded by SillyTavern as a third-party extension
    - `session-lease.js`: the lease core, a classic script (one IIFE, no imports). It must also run when injected by the Android app at document start, or by Playwright, with no extension around it
    - `index.js`: ES module, desktop only. Loads the lease, shows the overlay and the toasts, announces the extension
- **SillyTavern's own endpoints, events and context functions**, reached from the page (`/user/files/…`, `/api/files/upload`, `SillyTavern.getContext()`, `toastr`)
- **No dependencies**, no npm packages, no bundler
- **No secure-context browser APIs** (`crypto.subtle` and the like): the app loads SillyTavern over plain `http://`
- Tests: Node's built-in `node:test` and `node:assert`, for the lease's pure logic (`createSessionLease` with a fake `fetch`)

## Versioning

Three numbers, kept separately:

- **`manifest.json` version** (`MAJOR.MINOR.PATCH`): the extension's release version, shown to users. Tag each release `vX.Y.Z`. The lease ships as `0.2.0`
- **`LEASE_VERSION`** in `session-lease.js` (an integer): bump it on **every change to lease behavior or to the app contract** (spec E11). The app compares this number, not the manifest version, in both directions
- **`format`** in the lease and release files (an integer): bump it only for a change that would make an older reader decide wrongly. A bump locks the older side out until it updates

Branches:

- `dev`: work in progress
- `main`: what users get. SillyTavern installs from the default branch and updates with `git pull`, so `main` must always work and only changes through a release PR from `dev`. Tag each release on `main`
- The app pins a tag through its git submodule. After tagging, bump the submodule in the app repo

## Architecture

- `session-lease.js` is the **single source of truth** for the lease. The app repo has no copy of its own; it pulls this file in through a submodule
- Decision logic lives in pure functions inside `createSessionLease({ fetch, post, now, sleep, storage, log })`; the browser wrapper around `fetch` and `XMLHttpRequest` stays thin
- Every lease decision compares the pair (`holder`, `epoch`); lease writes go through one queue, one in flight at a time
- `index.js` holds everything that is desktop-only (the overlay, toasts, the announcement). Nothing desktop-only goes in `session-lease.js`
- Tests live in `test/`, one file per topic (e.g. `test/pair-rule.test.cjs`)

## Hard Rules

- **Never delete or overwrite SillyTavern data unless the user confirmed it in a dialog.** Saving an older copy over newer data counts as deleting. This is the reason the repo exists; no change may weaken it
- **Fail closed.** If the lease or the release marker can't be read or understood (incl. an unknown `format`), the page parks. A request the lease can't decide about is held, never sent
- **Held, never refused; no exemptions.** A parked page holds every server-data request; nothing passes the wrapper by URL. The lease's own I/O uses the original `fetch`
- **The lease adds nothing to SillyTavern's data.** It writes only its two files, `tt-session-lease.json` and `tt-session-release.json`
- **The lease never requires the app, and never requires the extension.** `session-lease.js` must work in any SillyTavern page however it was loaded
- **Nothing can turn the lease off** from the page: `window.__ttLease` is frozen and has no off switch
- **Don't change how SillyTavern looks or behaves** beyond parking pages, the overlay and the toasts in the spec. Don't modify SillyTavern's own code
- **Keep the repo and folder name `TravelingTavern-Extension`.** SillyTavern installs into a folder named after the repo, and the app's install and update calls use that name
- **Keep the names the app depends on** (spec E11): `window.__ttLease` (`version`, `source`, `useHere`, `onForeground`), `window.__ttLeaseSource`, `window.__ttExtension` (`version`, `leaseVersion`), the `tt-extension-ready` and `tt-lease` events, the `leaseState` and `leaseInfo` messages and their fields, and the two lease files with their fields. If one has to change, say so before changing it, and bump `LEASE_VERSION`
- **Every endpoint list the lease uses is in the spec** (read allowlist, chat-save paths, generation endpoints). When SillyTavern releases a new version, re-check them in its source and run the checklist before widening `TESTED_ST_VERSIONS`
- **Never test against real data.** Every manual test, spike and cleanup runs on a separate SillyTavern install, never the one in daily use, and no unreleased lease code is ever installed there. Throwaway personas, lorebooks, characters and chats aren't enough: user files and extension data are shared by the whole install. Editing the live page's copy of real data erased a persona once; the session-lease spike and its cleanup overwrote real Memory Books files
- **The repo is public.** No server addresses, Tailscale IPs, ports, tokens or anything else private in code, tests, docs or commit messages

## Related Repos

- **[TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern)**: the Android app. Includes this repo as a git submodule and injects `session-lease.js` into its WebView at document start. Its `context/specs/session-lease-app-spec.md` covers the app side
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**: the source to check endpoint names and behavior against. Never changed by this project
- **TravelingTavern-Bridge** (later): an optional SillyTavern server plugin. It could enforce the lease on the server (closing the gaps in spec E13) and run proactive messages

Changes needed in the app or the server plugin go in those repos, not here.
