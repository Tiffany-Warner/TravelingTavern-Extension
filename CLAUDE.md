# TravelingTavern Extension

A SillyTavern extension that lets only one SillyTavern page write at a time: a **session lease**. The holder writes; every other page is parked behind an overlay with **Use here**, its server requests held, until the user takes over, which reloads it from fresh data. SillyTavern pages save whole files from their own copy, so a page left open on one device erases what another saved since. This is the desktop half of the [TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern) app's data protection; the app bundles the same lease.

## Context Files

Read at the start of every session:

- @context/ai-guidelines.md
- @context/coding-standards.md
- @context/current-feature.md
- @context/project-schema.md

Spec: `context/specs/ext-0.2-session-lease-spec.md` (app side: TravelingTavern's `session-lease-app-spec.md`). Decision, requirements R1–R44 and their map: `context/decisions/session-lease-spike.md`.

## Commands

```bash
node --test    # automated tests (Node's built-in runner)
```

No build step. To try a change, install the branch on the **test install** and hard-refresh (Ctrl+Shift+R).

## Stack

- `session-lease.js`: the lease core and its **single source of truth** (the app pulls it in through a submodule). Classic script, one IIFE; also runs when the app injects it at document start, with no extension around it
- `index.js`: ES module, everything desktop-only (overlay, toasts, announcing the extension)
- Plain JavaScript, SillyTavern's own endpoints, events and context functions. No dependencies, no bundler, no secure-context APIs (the app uses plain `http://`). Tests: `node:test` with a fake `fetch`

## Versioning

- **`manifest.json` version**, mirrored by `EXTENSION_VERSION` in `index.js`: the release shown to users. The lease ships as `0.2.0`
- **`LEASE_VERSION`** (`session-lease.js` and `index.js`): bump on **every change to lease behavior or the app contract** (spec E11). The app compares this number
- **`format`** (both lease files): bump only for a change that would make an older reader decide wrongly; it locks the older side out until it updates
- **Tags:** releases `vX.Y.Z` on `main`; release candidates `vX.Y.Z-rc.N` on `dev` when the app needs code first. The app's submodule pins a tag, never an untagged commit, and re-pins to the release tag before its own merge

## Hard Rules

- **Never delete or overwrite SillyTavern data unless the user confirmed it in a dialog.** Saving an older copy over newer data counts as deleting. No change may weaken this
- **Fail closed.** A lease or marker that can't be read or understood (incl. an unknown `format`) parks the page; a request the lease can't decide about is held. Only the user's tap after a warning goes past it (Take over anyway, Turn off protection: spec E4)
- **Never stuck.** Every parked or waiting state offers a way back in; going ahead at your own risk is always a user tap after a warning. Nothing stands down or force-claims by itself
- **Held, never refused; no exemptions.** A parked page holds every server-data request (`sendBeacon`, which can't wait, is refused while parked: spec E6); nothing passes the wrapper by URL. The lease's own I/O uses the original `fetch`
- **The lease adds nothing to SillyTavern's data:** it writes only `tt-session-lease.json` and `tt-session-release.json`
- **The lease never requires the app or the extension;** `session-lease.js` works however it was loaded
- **Nothing turns the lease off but the user:** `window.__ttLease` is frozen; only the user can turn protection off, in one tab, after a warning, and that tab reloads from fresh data before anything passes (spec E4)
- **Don't change SillyTavern's look or behavior** beyond parking, the overlay and the spec's toasts; never modify its code
- **Keep the repo and folder name `TravelingTavern-Extension`:** SillyTavern installs into it and the app's install calls use it
- **Keep the names the app depends on** (spec E11): `window.__ttLease` (`version`, `source`, `useHere`, `onForeground`, `takeOverAnyway`, `turnOffProtection`, `turnProtectionOn`, `refresh`), `window.__ttLeaseSource`, `window.__ttExtension` (`version`, `leaseVersion`), the `tt-extension-ready` and `tt-lease` events (incl. `type`), the `leaseState` (incl. `actions`), `leaseInfo` and `leaseNotice` messages and fields, and both lease files and fields. Ask before changing one, and bump `LEASE_VERSION`
- **Every endpoint list is in the spec** (allowlist, chat saves, generation, connect buttons). On a new SillyTavern version, re-check them in its source (findings: `context/specs/ext-0.2-st-source-notes.md`) and run the checklist before widening `TESTED_ST_VERSIONS`
- **Never test against real data.** Every manual test, spike and cleanup runs on the separate **test install** (own folder, data and port), never the **real server**; no unreleased lease code ever goes on the real server, not even for a quick check. Throwaway characters aren't enough: user files and extension data are shared by the whole install (the spike's cleanup overwrote real Memory Books files this way)
- **The repo is public:** nothing private anywhere (`ai-guidelines.md` → Private Data)

## Related Repos

- **[TravelingTavern](https://github.com/Tiffany-Warner/TravelingTavern)**: the Android app; includes this repo as a submodule
- **[SillyTavern](https://github.com/SillyTavern/SillyTavern)**: the source to check against; never changed here
- **TravelingTavern-Bridge** (later): an optional server plugin that could enforce the lease on the server (spec E13)

Changes for the app or the plugin go in those repos.
