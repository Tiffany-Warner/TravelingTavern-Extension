# AI Interaction Guidelines

## Communication

- Concise and direct; explain non-obvious decisions briefly
- Ask before large refactors or architectural changes
- No features outside the current spec. Never delete files without asking
- After 2–3 failed attempts, stop and explain; no random fixes. Ask when requirements are unclear

## Workflow (every feature / fix)

1. **Document** it in @context/current-feature.md
2. **Branch** from `dev`: `feature/…`, `fix/…` or `chore/…`
3. **Implement** what current-feature.md describes
4. **Test:** `node --test` passes before every commit and merge; then the spec's manual checklist on the test install. Lease changes also need the **two-page test** (two pages, one holding an old copy), and the app when the spec asks
5. **Iterate** as needed
6. **Commit** only with my permission, after tests pass and it works
7. **Merge** into `dev` and push `dev`. Never merge or push to `main`
8. **Delete** the branch after merging (ask first)
9. **Review** AI-written code periodically and on request
10. Mark complete in current-feature.md with a 3–5 line history entry (what changed, key decisions, gotchas, what's unverified, version); no test logs or counts

## Branches

- **`dev`**: working branch; feature branches start from it and merge back (local merge + push is fine; in a cloud session, a PR). Never delete it
- **`main`**: what users get (SillyTavern installs from it and updates with `git pull`), so it must always work. Changes only through a PR from `dev`, which I merge

### Releasing to main (when I ask)

0. **Release candidate** (when the app needs the code first): tag `vX.Y.Z-rc.N` on `dev` and push the tag. The app's feature branch pins it; both checklists run against it
1. `dev` pushed, `node --test` passing; versions bumped together: `manifest.json` and `EXTENSION_VERSION` in `index.js`, and, if lease behavior or the app contract changed, `LEASE_VERSION` in `session-lease.js` and `index.js`
2. PR `dev` → `main` titled with the version (e.g. `Release 0.2.0`), listing the history entries included and the manual checks done (spec checklist, two-page test)
3. I merge with **Create a merge commit** (not squash or rebase: they make `main` and `dev` drift apart)
4. Tag the merge commit `vX.Y.Z`; the app repo then bumps its submodule to it

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

## Investigating SillyTavern

- Never guess an endpoint, request / response shape, export, setting or DOM id. Confirm it in SillyTavern's source or the live page (DevTools) first, and write the finding into the spec's Verified section with the version checked
- All of it on the test install only (`CLAUDE.md` Hard Rules): throwaway persona, lorebook, character and chat

## Code Changes

- Minimal changes for the task; no unrelated refactors or "nice to have" additions
- Follow existing patterns (`coding-standards.md`)
- A change to anything the app depends on is raised with me first (`CLAUDE.md` Hard Rules)

## Code Review

Check AI-written code against `CLAUDE.md` Hard Rules and `coding-standards.md`, and also for:

- **Spec drift:** the spec, its Verified section and the unit tests change in the same branch as the behavior they describe
