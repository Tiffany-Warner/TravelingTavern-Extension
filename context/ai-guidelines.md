# AI Interaction Guidelines

## Communication

- Concise and direct; explain non-obvious decisions briefly
- Ask before large refactors or architectural changes
- No features outside the current spec. Never delete files without asking

## Workflow (every feature / fix)

1. **Document** it in @context/current-feature.md
2. **Branch** from `dev`: `feature/…`, `fix/…` or `chore/…`
3. **Implement** what current-feature.md describes
4. **Test:** `node --test` must pass before every commit and merge. Then verify in SillyTavern: install the branch, hard-refresh (Ctrl+Shift+R), run the spec's manual checklist in a desktop browser. Anything touching the guard also needs the **two-page test** (two SillyTavern pages open, one holding an old copy), and a check in the TravelingTavern app when the spec asks
5. **Iterate** as needed
6. **Commit** only with my permission, after tests pass and it works
7. **Merge** into `dev` and push `dev`. Never merge or push to `main`
8. **Delete** the branch after merging (ask first)
9. **Review** AI-written code periodically and on request
10. Mark complete in current-feature.md and add a history entry. History entries: 3–5 lines max — what changed, cause/key decisions, gotchas, what's unverified, version. No verification logs or test counts

## Branches

- **`dev`**: working branch. Feature branches start from it and merge back; local merge + push is fine. Never delete it. If a local merge isn't possible (cloud session), push the feature branch and open a PR into `dev`
- **`main`**: what users get. SillyTavern installs from the default branch and updates with `git pull`, so `main` must always work. It changes only through a PR from `dev`, which I merge on GitHub

### Releasing to main (when I ask)

1. `dev` pushed, `node --test` passing, `manifest.json` version and (if guard behavior changed) `GUARD_VERSION` bumped
2. PR `dev` → `main`, titled with the version (e.g. `Release 0.1.0`), listing the history entries included and which manual checks were done (spec checklist, two-page test)
3. I merge with **Create a merge commit** (not squash or rebase: they make `main` and `dev` drift apart)
4. Tag the merge commit `vX.Y.Z`. Then the app repo bumps its submodule to that tag

## Private Data

The repo is public. Nothing identifying my network, devices or accounts in any committed file, test, spec, history entry, commit message or PR description:

- No real IPs, machine-specific ports, Tailscale machine / tailnet names, hostnames, usernames, emails, passwords, tokens, API keys
- No real chat content, lorebook entries, personas, character names from my library, exported settings or backups. Tests and examples use invented data
- History entries describe the setup instead: "against SillyTavern 1.19.0 in Chrome", "with the TravelingTavern app on the Pixel 8"
- Placeholders only: `100.64.0.2:8000`, `desktop.tail1234.ts.net`, `user` / `pass`, `Example Character.png`
- Check the diff before every commit. If something private is already committed, **stop and tell me**; don't overwrite it (it stays in Git history)

## Commits

- Ask first; never auto-commit
- Conventional messages (`feat:`, `fix:`, `chore:` …), one feature / fix per commit
- Never add "Generated with Claude" to commit messages

## When Stuck

- After 2–3 failed attempts, stop and explain. No random fixes
- Ask when requirements are unclear

## Investigating SillyTavern

The guard depends on SillyTavern's endpoints, module exports and page behavior, which change between versions.

- Never guess an endpoint, request / response shape, export, setting or DOM id. Confirm it in SillyTavern's source or the live page (DevTools) first
- A spec item marked **(verify)** must be confirmed before building on it. Write the finding into the spec's Verified / Notes section with the SillyTavern version checked
- Never test against real data: throwaway persona, lorebook, character and chat only
- **Every manual test, spike and cleanup runs on a separate SillyTavern install** (its own folder and data, its own port), never the one in daily use. **No unreleased guard or lease code is ever installed in the SillyTavern in daily use**, not even for a quick check or to clean up through a page. Throwaway characters aren't enough: user files, settings, Quick Replies and extension data (e.g. Memory Books' `stmb-*.json`) are shared by the whole install. The session-lease spike and its cleanup overwrote real user files this way (`context/decisions/session-lease-spike.md`)

## Code Changes

- Minimal changes for the task; no unrelated refactors; no "nice to have" additions
- Follow existing patterns. Guard logic goes in pure functions inside `createSaveGuard`; desktop-only code goes in `index.js`
- No dependencies, no build step, no secure-context APIs (`crypto.subtle`)
- A change to guard behavior bumps `GUARD_VERSION`; a change to anything the app depends on (see `CLAUDE.md` Hard Rules) is raised with me first

## Code Review

Check AI-written code especially for:

- **Data safety:** no path where a stale save is sent; fails closed on unreadable or unrecognized requests; guard marks (`__ttRev`, `__ttUser`) never sent or left in SillyTavern's cache; no read-back used as a base
- **Coverage:** every whole-file save endpoint in the spec is matched; nothing passes through by default that should be guarded
- **Security:** no `eval`, no HTML built from data, nothing sensitive in console logs; the guard exposes no way to turn itself off
- **Performance:** no timers or polling; no whole-chat downloads to compare; settings checks rate-limited
- **Quiet on desktop:** no change to SillyTavern's look or behavior beyond the spec's toasts
- **Patterns:** matches the existing code
