# TravelingTavern Extension

A SillyTavern extension that stops any SillyTavern page from saving an old copy of a file over a newer one. It is the desktop half of the [TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern) Android app's data protection: the app guards its own page, and this extension loads the same guard into every other SillyTavern page (desktop browser tabs).

SillyTavern pages read settings, lorebooks, chats and character cards once, then save the **whole file** from their own copy. A page that has been open for a while erases whatever another device saved since. The guard checks every such save first and refuses it when the server's file has changed.

## Context Files

Read the following at the start of every session:

- @context/ai-guidelines.md
- @context/coding-standards.md
- @context/current-feature.md
- @context/project-schema.md

Feature specs live in `context/specs/`. The first is `ext-0.1-save-guard-spec.md`.

## Commands

```bash
node --test    # run the automated tests (Node's built-in runner, no dependencies)
```

There is no build step: SillyTavern loads the extension's files directly. To try a change, install the extension in SillyTavern (Extensions → Install extension, or clone it into the third-party extensions folder as `TravelingTavern-Extension`), then hard-refresh the page (Ctrl+Shift+R).

## Stack

- **Plain JavaScript**, loaded by SillyTavern as a third-party extension
    - `index.js`: ES module, the extension's entry. Loads the guard and shows the desktop toasts
    - `save-guard.js`: a classic script (one IIFE, no imports). It must also run when injected by the Android app's WebView or by Playwright, with no extension around it
- **SillyTavern's own modules and endpoints**, reached from the page (`/script.js`, `/scripts/world-info.js`, `toastr`)
- **No dependencies**, no npm packages, no bundler
- **No secure-context browser APIs** (`crypto.subtle` and the like): the app loads SillyTavern over plain `http://`
- Tests: Node's built-in `node:test` and `node:assert`, for the guard's pure logic (`createSaveGuard` with a fake `fetch`)

## Versioning

Two numbers, kept separately:

- **`manifest.json` version** (`MAJOR.MINOR.PATCH`): the extension's release version, shown to users. Tag each release `vX.Y.Z`
- **`GUARD_VERSION`** in `save-guard.js` (an integer): bump it on **every change to the guard's behavior**. The app compares this number, not the manifest version, to decide whether the installed extension is out of date

Branches:

- `dev`: work in progress
- `main`: what users get. SillyTavern installs from the default branch and updates with `git pull`, so `main` must always work and only changes through a release PR from `dev`. Tag each release on `main`
- The app pins a tag through its git submodule. After tagging, bump the submodule in the app repo

## Architecture

- `save-guard.js` is the **single source of truth** for the guard. The app repo has no copy of its own; it pulls this file in through a submodule
- Decision logic lives in pure functions inside `createSaveGuard({ fetch, post, now, log })`; the browser wrapper around `fetch` stays thin
- The compare-and-save step is one function, `conditionalWrite`, so a later server plugin can replace it without other changes
- `index.js` holds everything that is desktop-only (toasts, focus checks, the Extensions panel line). Nothing desktop-only goes in `save-guard.js`
- Tests live in `test/`, one file per topic (e.g. `test/lorebook-stamp.test.cjs`)

## Hard Rules

- **Never delete or overwrite SillyTavern data unless the user confirmed it in a dialog.** Saving an older copy over newer data counts as deleting. This is the reason the repo exists; no change may weaken it
- **Fail closed.** If the server's file can't be read or a request can't be understood, the save is not sent. A lost change the user is told about is better than a silent overwrite
- **Nothing the guard adds is ever stored.** Marks such as `__ttRev` and `__ttUser` are removed before a request is sent and from SillyTavern's cache as the spec says
- **The guard never requires the app, and never requires the extension.** `save-guard.js` must work in any SillyTavern page however it was loaded
- **Nothing can turn the guard off** from the page: its API object is frozen and has no off switch
- **Don't change how SillyTavern looks or behaves** beyond blocking stale saves and showing the toasts in the spec. Don't modify SillyTavern's own code
- **Keep the repo and folder name `TravelingTavern-Extension`.** SillyTavern installs into a folder named after the repo, and the app's install and update calls use that name
- **Keep the names the app depends on:** `window.__ttSaveGuard` (`version`, `source`, `checkFresh`, `checkChat`), `window.__ttExtension` (`version`, `guardVersion`), the `tt-extension-ready` and `tt-save-guard` events, and the message types and fields in the spec (`saveBlocked`, `staleSettings`, `staleLorebooks`, `chatSaveRefused`, `guardInfo`). If one has to change, say so before changing it, and bump `GUARD_VERSION`
- **Every endpoint the guard matches is listed in the spec.** When SillyTavern releases a new version, re-check that list before widening `TESTED_ST_VERSIONS`
- **Never test against real data.** Use a throwaway persona, lorebook, character and chat. Editing the live page's copy of real data erased a persona once
- **The repo is public.** No server addresses, Tailscale IPs, tokens or anything else private in code, tests, docs or commit messages

## Related Repos

- **[TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern)**: the Android app. Includes this repo as a git submodule and injects `save-guard.js` into its WebView. Its `context/specs/fix-stale-page-overwrites-spec.md` covers the app side
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**: the source to check endpoint names and behavior against. Never changed by this project
- **TravelingTavern-Bridge** (later): an optional SillyTavern server plugin. It will give the guard an atomic write and cheap file versions, and run proactive messages

Changes needed in the app or the server plugin go in those repos, not here.
