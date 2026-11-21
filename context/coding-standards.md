# Coding Standards

One page writes, every other page holds; fail closed; stay quiet on desktop beyond the spec's overlay and toasts.

## Files and Module Format

- `session-lease.js`: classic script, one IIFE, no `import` / `export` (also runs when the app injects it at document start, or Playwright). Node export: `if (typeof module !== 'undefined') module.exports = …`
- `index.js`: ES module. All desktop-only code (the overlay, its styles, the toasts, announcing the extension) goes here, never in `session-lease.js`
- SillyTavern paths, endpoint lists (allowlist, chat-save paths, generation endpoints) and lease file names are named constants at the top of the file. Never guess one: confirm it in ST's source first (`ai-guidelines.md`)

## JavaScript

- `const` by default, `let` when reassigned, never `var`. Strict equality only
- `async` / `await` over `.then()`; every promise is awaited or handled, except held requests, which stay pending on purpose
- Small named functions (aim for under 40 lines) whose names say what they do
- JSDoc on every function in the lease's API and every pure decision function: purpose, params, return value, what it throws
- No secure-context APIs (`crypto.subtle`, etc.): pages load over plain `http://`

## Timers and Waiting

- **No polling and no repeating timers.** React to events (ST's events, `pagehide` / `pageshow`, requests passing the wrapper)
- **Bounded one-off delays are allowed:** the lease-write retry (random 100–200 ms, at most 3 attempts), the claim's grace wait (1 s) and ST's `/csrf-token` waiting for the lease's own token fetch (at most 2 s). Each has a fixed upper bound and runs once per event
- **The single named polling exception:** the claim's wait for `busy` re-reads the lease once per second, for at most 60 s, only while a claim is in progress. No other code polls; adding another exception needs the owner's approval and a line here

## Lease Structure

- Decisions are pure functions inside `createSessionLease({ fetch, post, now, sleep, storage, log })`: no DOM, network or globals except through these parameters, so Node can test them with a fake `fetch`. The browser wrapper stays thin
- **Every lease decision compares the pair (`holder`, `epoch`)**, never the epoch alone
- **One lease write in flight at a time:** claims, epoch bumps, `busy` and `active` go through one queue; every update re-reads first
- `window.__ttLease` is defined once, frozen, and has no off switch. A second copy in the same page stands down completely
- The names the app depends on (spec E11, `CLAUDE.md` Hard Rules) don't change without asking. Any change to lease behavior or the contract bumps `LEASE_VERSION`; an incompatible change to the files bumps `format`

## Request Wrapper

- **Held, never refused.** While parked (and before the start decision), server-data requests are held: their promise stays pending, held XHRs are never sent. Refusing broke ST's startup
- **No exemptions.** No request passes the wrapper by URL while parked. The lease's own reads and writes use the original `fetch` captured at install, never the wrapped one
- A held request is never sent, before or after a reload. Keep only its path and reject function, never the request
- Before a reload, abort only held chat saves; never abort held reads
- The read allowlist only skips the pre-request check in the holder; each entry is confirmed read-only in ST's source

## Data Safety

- **Fail closed:** a lease or marker that can't be read, can't be parsed, misses a field or has an unknown `format` → park. Unreadable is never "missing" and never "free"
- A page becomes writable only through a fresh load that holds the lease
- No clock time from the files is used for a decision
- Keep no copies of ST data. Messages to the app carry only the fields in spec E11, never ST data or the CSRF token

## Errors and Logging

- A lease bug must hold requests, never let them through. Catch errors at the edges and park
- Prefix logs with `[TravelingTavern]`. Log the event, the reason, endpoint paths and counts. Never log content (chat text, card fields, lorebook entries, settings), addresses, the CSRF token or other tokens

## Security

- No `eval`, `new Function`, or HTML built from data. The overlay is built with DOM methods and `textContent`; its styles live in one `<style>` element with a class prefix of its own. Toasts that include a name use toastr's `escapeHtml: true`
- Wrap only `fetch`, `XMLHttpRequest.open` / `send` and `navigator.sendBeacon`. Don't patch or modify any other SillyTavern code, and don't change its look or behavior beyond the spec's overlay and toasts
- No private data in code, tests or comments (`ai-guidelines.md` → Private Data)

## Testing

- `node:test` + `node:assert`, no dependencies, a fake `fetch`. One file per topic: `test/<topic>.test.cjs`
- Cover what could let two pages write or lose data: the pair rule, unreadable vs missing files, unknown `format`, claim verify and lost races, epoch bumps (refresh, duplicated tab), one write in flight, retry outcomes per write type, held vs sent, aborting only chat saves, `busy` set only by a sent generation request and cleared only when its response is over
- Invented data only
- Anything that needs ST or the DOM goes through the spec's manual checklist on the separate test install, noted in the history entry

## Code Quality

- No commented-out code unless explained; no unused variables; no new dependencies
- Minimal changes; no reformatting of unrelated code
