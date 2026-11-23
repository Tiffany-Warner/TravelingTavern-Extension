# Coding Standards

How to write the code. The rules it serves (fail closed, held never refused, no exemptions, the app's names) are in `CLAUDE.md` Hard Rules.

## Files

- `session-lease.js`: classic script, one IIFE, no `import` / `export`; Node export via `if (typeof module !== 'undefined') module.exports = …`
- `index.js`: ES module, all desktop-only code (overlay, its styles, toasts, the announcement)
- ST paths, endpoint lists, connect buttons and lease file names are named constants at the top, each confirmed in ST's source
- ST's context is read through a fresh `SillyTavern.getContext()` each time (it returns a snapshot); no ST module imports

## JavaScript

- `const` by default, `let` when reassigned, never `var`; strict equality only
- `async` / `await` over `.then()`; every promise awaited or handled, except held requests (pending on purpose)
- Small named functions (aim for under 40 lines) whose names say what they do
- JSDoc on every API and pure decision function: purpose, params, return, throws

## Timers and Waiting

- **No polling and no repeating timers.** React to events (ST's events, `pagehide` / `pageshow`, `freeze` / `resume`, requests passing the wrapper)
- **Bounded one-off delays are allowed:** the lease-write retry (random 100–200 ms, at most 3 attempts), the claim's grace wait (1 s), ST's `/csrf-token` waiting for the lease's own token fetch (at most 2 s), the reload's one-task wait (`setTimeout(0)`) and its `reloadPending` fallback (2.5 s), the connect wait after a takeover (10 s, once per claim, ended early by `ONLINE_STATUS_CHANGED`; spec E10), the ST hooks' retry on `load` (`setTimeout(0)`, once; spec E10), the chat-save wait after a reply (3 s, once per reply end, ended early by the chat save; spec E8), the lease I/O bound (10 s per lease read or write, body included, and per lease CSRF token fetch; aborted and treated as "can't reach"; spec E2, E3), and the offer of Take over anyway during the claim's wait for `busy` (after 10 s, checked inside that wait's 1 s steps, no timer of its own; spec E4, E9). Each has a fixed bound and runs once per event
- **The single named polling exception:** the claim's wait for `busy` re-reads the lease once per second, for at most 60 s, only during a claim. Another exception needs the owner's approval and a line here

## Lease Structure

- Decisions are pure functions inside `createSessionLease({ fetch, post, now, sleep, storage, log })`, touching nothing outside these, so Node tests them with a fake `fetch`. The browser glue stays thin
- **Every lease decision compares the pair (`holder`, `epoch`)**, never the epoch alone
- **One lease write in flight:** claims, epoch bumps, `busy` and `active` share one queue; every update re-reads first
- `window.__ttLease` is defined once; a second copy in the page stands down completely
- A page becomes writable only through a fresh load that holds the lease; the one exception is resume after a `freeze` with an unchanged pair, which bumps the epoch and verifies first (spec E5, E7). A tab with protection off (the user's tap after a warning) writes without the lease, but only from a fresh load (spec E4)
- Unreadable is never "missing" or "free". No clock time from the files decides anything
- A change to lease behavior or the contract bumps `LEASE_VERSION`; an incompatible file change bumps `format`

## Request Wrapper

- Wrap only `fetch`, `XMLHttpRequest.open` / `send` and `navigator.sendBeacon`
- Held fetches keep their promise pending; held XHRs are never sent (refusing broke ST's startup)
- The lease's own I/O uses the original `fetch` captured at install
- A held request is never sent, before or after a reload; keep only its path and reject function
- Before a reload, abort only held chat saves, never held reads
- The read allowlist only skips the pre-request check in the holder; each entry confirmed read-only in ST's source

## Errors and Logging

- A lease bug holds requests, never lets them through: catch errors at the edges and park
- Prefix logs with `[TravelingTavern]`; log events, reasons, endpoint paths and counts. Never content (chat text, cards, lorebooks, settings), addresses, the CSRF token or other tokens
- Keep no copies of ST data; messages to the app carry only the fields in spec E11

## Security

- No `eval`, `new Function`, or HTML built from data. The overlay uses DOM methods and `textContent`, with its styles in one `<style>` element under its own class prefix. Toasts with a name use toastr's `escapeHtml: true`

## Testing

- `node:test` + `node:assert`, a fake `fetch`, one file per topic (`test/<topic>.test.cjs`, listed in spec E14). Invented data only
- Cover what could let two pages write or lose data: the pair rule, unreadable vs missing, `format`, lost races, epoch bumps, one write in flight, retries, held vs sent, `busy`
- What needs ST or the DOM: the spec's manual checklist on the test install, noted in the history entry

## Code Quality

- No commented-out code unless explained, no unused variables, no new dependencies
- Minimal changes; no reformatting of unrelated code

## License

- This repo is AGPL-3.0-only (matches SillyTavern). No per-file license headers
- Code copied from elsewhere keeps its own copyright notice, and only from licenses that can be combined with AGPL v3 (MIT, ISC, BSD, Apache 2.0, GPL-3.0, AGPL-3.0). Ask me before anything else
