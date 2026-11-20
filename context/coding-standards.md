# Coding Standards

Never send a stale save, fail closed, stay invisible on desktop.

## Files and Module Format

- `save-guard.js`: classic script, one IIFE, no `import` / `export` (also runs when injected by the app's WebView or by Playwright). ST modules are loaded by dynamic `import()` with an absolute URL. Node export: `if (typeof module !== 'undefined') module.exports = …`
- `index.js`: ES module. All desktop-only code (toasts, focus checks, panel line) goes here, never in `save-guard.js`
- SillyTavern paths and endpoint URLs are named constants at the top of the file. Never guess one: confirm it in ST's source first (`ai-guidelines.md`)

## JavaScript

- `const` by default, `let` when reassigned, never `var`. Strict equality only
- `async` / `await` over `.then()`; every promise is awaited or handled
- Small named functions (aim for under 40 lines) whose names say what they do
- JSDoc on every function in the guard's API and every pure decision function: purpose, params, return value, what it throws
- No secure-context APIs (`crypto.subtle`, etc.): pages load over plain `http://`. Hashes are pure JS over canonical JSON (sorted keys). Feature-detect `DecompressionStream`
- No timers or polling: event-driven only

## Guard Structure

- Decisions are pure functions inside `createSaveGuard({ fetch, post, now, log })`: no DOM, network or globals except through these parameters, so Node can test them with a fake `fetch`. The browser wrapper stays thin
- Compare-and-save lives only in `conditionalWrite(kind, key, base, payload)`
- One guarded save at a time (queue)
- `window.__ttSaveGuard` is frozen and has no off switch. Names the app depends on (`CLAUDE.md` Hard Rules) don't change without asking
- Any change to guard behavior bumps `GUARD_VERSION`

## Data Safety

- **Fail closed:** a server that can't be read, a body that can't be parsed or decompressed, or a request that can't be recognized means the save is blocked
- A failed read is never "no file" and never "unchanged". Keep "missing" and "couldn't load" separate
- Base = the version the saving copy came from. After the page's own successful save, base = the sent payload. **Never use a read-back as a base**
- Guard marks (`__ttRev`, `__ttUser`) are stripped before sending and removed from ST's cache as the spec says. A mark found in server data is ignored
- Keep no copies of ST data beyond fingerprints. Synthetic answers match the spec's table exactly

## Errors and Logging

- A guard bug must block the save, never let it through. Catch errors at the edges and return the spec's synthetic answer, so ST keeps working
- Prefix logs with `[TravelingTavern]`. Log kind, reason, endpoint path and counts. Never log content: chat text, card fields, lorebook entries, settings, addresses or tokens

## Security

- No `eval`, `new Function`, or HTML built from data. Toasts that include a name use toastr's `escapeHtml: true`
- Wrap only `fetch` and `XMLHttpRequest.send`. Don't patch or modify any other SillyTavern code, and don't change its look or behavior beyond the spec's toasts and panel line
- No private data in code, tests or comments (`ai-guidelines.md` → Private Data)

## Testing

- `node:test` + `node:assert`, no dependencies, a fake `fetch`. One file per topic: `test/<topic>.test.cjs`
- Cover what loses data: stale copies, failed or unreadable reads, key order and whitespace, mark lifecycle (added, stripped, never sent, never cached), uid collisions, queue order, the stale-chat freeze, first save after load
- Invented data only
- Anything that needs ST or the DOM goes through the spec's manual checklist (plus the two-page test for guard changes), noted in the history entry

## Code Quality

- No commented-out code unless explained; no unused variables; no new dependencies
- Minimal changes; no reformatting of unrelated code
