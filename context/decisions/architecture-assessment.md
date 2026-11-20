# Architecture Assessment: Protecting SillyTavern Data Across Devices

2026-11-20. Investigation only; no code written or changed. SillyTavern (ST) facts were read in the 1.19.1 `release` source; Memory Books facts in the aikohanasaki/SillyTavern-MemoryBooks source.

Evidence labels: **[C]** confirmed in source this session · **[A]** reasonable assumption · **[S]** needs a spike.

## 1. Reframing the problem

The brief calls this "memory management". The evidence says the problem is wider, and that changes which options can work.

- **Root cause [C]:** an ST page reads data once and later saves the **whole file** from its copy. ST has no awareness of other open pages (no `BroadcastChannel`, `storage` listener, focus or visibility handling in core). Two live pages = last writer wins.
- **It affects every whole-file save, not just memory [C]:** settings (the original persona bug), chats, character cards (saved on every chat open), lorebooks, and presets / Quick Replies / themes / groups.
- **Prompt building runs in the page [C]:** `Generate()`, World Info activation and every extension (Memory Books included) are browser code. Any design that keeps ST's features needs a live ST page, and every live page is a writer.
- **TravelingTavern adds pages:** the app's long-lived WebView today, a headless page in Phase 8.

So the question is not "where should memories live" but **"how do several ST pages avoid overwriting each other"**. Memory (lorebooks) is one of at least five affected data types.

That is also why the current design feels like fighting ST: it retrofits per-file version checks onto a system built for one page at a time.

## 2. Option 1 — Continue: per-save guard (+ optional plugin)

**Architecture.** `save-guard.js` wraps `fetch` in every page (app-injected; extension for desktop tabs). Before each whole-file save it compares the server's file with the version the saving copy came from; stale saves are blocked. Optimistic concurrency, applied per file from the client.

**Feasibility.** Achievable **[C for each mechanism, S for the whole]**. Every mechanism in the spec was traced to source, but nothing has been run, and about twenty items are still marked "(verify)".

**Compatibility.** Memory Books keeps working untouched. Known cost: when two devices each add a memory from old copies, the entry ids collide and one save is blocked (Memory Books cross-references ids, so renumbering is unsafe) **[C]**.

**Complexity: large.** The spec needs a different mechanism per data type:

| Data | Mechanism needed |
|---|---|
| Settings | fingerprint, "noisy fields" list, first-save uncertainty, no-change detection |
| Lorebooks | version stamp inside the data, cache surgery (`Map.prototype.get.call`), add-only re-apply |
| Chats | count + last-date check, stale freeze, generation refusal via `AbortError`, `__ttUser` mark |
| Characters | form-to-card mapping, rewrite to `merge-attributes` |
| Presets, Quick Replies, themes, groups | not designed yet (blocks app 1.8) |

**Dependence on ST internals: high [C].** ~12 endpoint URLs and body shapes, 4 module exports (`settings`, `settingsReady`, `characters`, `chat`), `worldInfoCache` clone behavior, `reloadEditor`, the synthetic answer each endpoint expects, how ST treats an aborted generation, Memory Books' id semantics. A renamed endpoint fails **silently** (the save passes through unguarded); the spec's version check only warns.

**Maintainability: poor.** Every ST release needs an audit. Every new whole-file save in ST or an extension is a hole until found. Three design reviews in one day each found a new hole (character saves, chat integrity, cache marks); that trend is the strongest evidence against this option.

**What the plugin adds.** Closes the check-then-save gap and the older-message gap. It cannot intercept ST's own routes **[C]** (plugins get a router under `/api/plugins/{id}` only), so the page guard and all its per-type logic remain.

**Failure scenarios.** Missed endpoint → silent overwrite. Wrong "noisy" entry → silent overwrite of a real setting. Guard bug in a lorebook path → lost entries with no ST backup **[C]**.

**Spike.** Build only the settings path and run it for a day on two devices. Count: blocked saves, reloads, entries needed in the noisy list. If that list keeps growing, the approach is confirmed fragile.

## 3. Option 2 — Independent TravelingTavern memory system

**Architecture.** Memories leave lorebooks. Storage: one small file per memory through ST's user-files API (`/api/files/upload` writes atomically, any name matching `[a-zA-Z0-9_.-]`, read back at `/user/files/…` **[C]**), or ST's vector store (`/api/vector/insert|query|delete`, per-item server-side upserts **[C]**). Injection: `setExtensionPrompt()` or a `generate_interceptor` **[C]**. Creation: our own summarizer using `generateRaw()` **[C]**. A settings toggle picks ST memory or TravelingTavern memory.

**Feasibility.** The store itself is feasible, and per-item files are naturally safe from stale writers (appending never overwrites). This is the approach already used in the EchoText fork's per-thread storage. An existing extension, CharMemory, also keeps memories outside lorebooks (in the Data Bank, retrieved by Vector Storage) and states it can coexist with lorebook-based memory.

**It does not solve the problem in section 1.**

- Settings, chats, character cards and every other lorebook stay exposed. The persona bug that started this is a settings overwrite. Option 2 would still need Option 1 or 3 underneath it.
- Storage choices that lean on ST re-enter the problem: the Data Bank's file registry lives in `extension_settings` (settings.json) and `chat_metadata` (the chat file) **[C]**.

**Memory Books compatibility: no, without a fork [C].** It is hard-wired to lorebooks: 77 call sites of `loadWorldInfo` / `createWorldInfoEntry` / `saveWorldInfo` across three files, progress markers in chat metadata, and its memories are *retrieved* by ST's World Info activation. An adapter means maintaining a fork of a ~15,000-line main file, licensed AGPL-3.0, that changes often. Rebuilding its features (scene selection, tiers, consolidation, rollback) is a project of its own.

**Complexity: very large.** Summarizer pipeline, retrieval, injection, editor UI in the app, a desktop UI (or memories become invisible in ST), migration both ways, two modes to test forever.

**Maintainability.** Dependencies shift rather than shrink: fewer ST storage internals, more ST prompt-pipeline internals, plus either a Memory Books fork or our own equivalent.

**When it would be right.** As a *product* decision (wanting memory behavior ST cannot give), not as a fix for overwrites.

**Spike.** One day: store three memories as files, inject with `setExtensionPrompt`, confirm they reach the prompt; then list which Memory Books features would have to be rebuilt. Expected result: works, but covers one of five data types.

## 4. Option 3 — One active page at a time ("Use here" session lease)

**Pattern.** Pessimistic single-writer locking instead of per-file version checks. ST is built for one live page; instead of making many pages safe, make sure only one page is live. Known from messaging web clients ("open in another window — Use here"), editors that warn when a document is open elsewhere, and lease-based locking in distributed systems (see Sources).

**Architecture.**

- **Lease:** one small file per ST user, `{ holder, epoch, claimedAt, busy }`, stored through the user-files API **[C: endpoint exists, atomic, overwrites]**. `holder` is a page id kept in `sessionStorage`.
- **Holder:** the only page allowed to talk to the server. Works exactly as ST does today. No per-file logic.
- **Every other page is parked:** its `fetch` wrapper refuses **all** requests, and it shows "SillyTavern is in use on another device. **Use here**".
- **Take over = claim, short grace wait, reload.** The page that takes over always loads fresh, after the previous holder has stopped writing. A holder is therefore never stale.
- **Losing the lease is noticed** on tab focus, on first interaction after idle, and before a request if the last check is older than ~2 s (one tiny read).
- **Takeover only on a human action:** app comes to the foreground (automatic), or a click on the desktop. Two visible pages never fight.
- **`busy`:** set while generating, so a takeover waits for the reply instead of losing it.
- **Distribution unchanged:** app injects at document start (and can hold ST's first requests until it has the lease, so no double load); the extension covers desktop tabs; Playwright covers the headless page.

**What it removes from Option 1.** Fingerprints, lorebook stamps, noisy-field list, first-save uncertainty, character and chat special cases, stale-chat freeze, synthetic answers, merge (Phase 3), and the separate work for presets / Quick Replies / themes / groups. The app-1.8 blocker disappears: every write is covered because the rule doesn't look at what is being written.

**Feasibility [S, with confirmed parts].** Lease storage and the fetch wrapper are confirmed mechanisms. To prove: ST tolerates held or refused requests cleanly behind an overlay; lease reads aren't cached; reload returns the user to the same chat; the app can hold first requests at document start.

**Compatibility.** Memory Books and every other extension run unmodified in the holder page. No id collisions: two pages never write.

**Dependence on ST internals: minimal.** One file endpoint and the browser `fetch`. No knowledge of save endpoints, body shapes, caches or module exports. A new or renamed ST endpoint is covered automatically.

**Complexity: small.** Estimated at well under a quarter of Option 1's first version **[A]**.

**Disadvantages and failure scenarios.**

- **No simultaneous use.** Switching devices costs a reload (1–3 s) and, on the desktop, one click. Chatting on phone and desktop at the same moment is not possible.
- **Still needs code in every page.** A desktop tab without the extension ignores the lease, exactly as it ignores the guard in Option 1.
- **Self-enforced.** A page checks the lease itself; the server doesn't reject a stale holder. The grace wait covers the normal case; a request in flight longer than the grace period could slip through **[A: rare]**. Lease literature is explicit that only enforcement at the storage layer is airtight, and ST offers no hook for that.
- **Unsaved work in a parked page is lost** (a half-typed desktop edit when the phone takes over). `busy` covers generation only.
- **Phase 8:** the headless page can write only when no person holds the lease. A reminder due while you are chatting must be generated by the active page instead **[S: design needed]**.

**Spike (1–2 days).** A ~150-line script loaded as a throwaway extension in two desktop tabs: lease file, park overlay, refuse-all wrapper, "Use here". Test: persona made in tab A survives clicking around old tab B; chat messages likewise; Memory Books in the holder; takeover during a generation; measure switch time. Then inject the same script from the app.

## 5. Comparison

| | 1. Per-save guard | 2. Independent memory | 3. One active page |
|---|---|---|---|
| Solves stale overwrites for | 4 data types now, rest later | memories only | all data, present and future |
| Technical feasibility | traced, unproven, many open verifies | store feasible; Memory Books adapter not without a fork | mechanisms confirmed; behavior needs spike |
| Implementation effort | large, then more per data type | very large, and still needs 1 or 3 | small |
| Memory Books | works; id collisions blocked | fork or rebuild | works unchanged |
| Dependence on ST internals | high (endpoints, exports, caches) | medium (prompt pipeline) + fork | minimal (one file endpoint) |
| Risk from ST updates | high; failures are silent | medium | low |
| Long-term maintenance | audit every ST release | own memory product + fork | little |
| Simultaneous use of two devices | yes | yes (memories) | **no** |
| Residual risk | check-then-save gap; missed endpoints | everything outside memory | takeover race; pages without the extension |
| Extensibility (Phase 8) | per-character leases via plugin | unaffected | global lease; active page does scheduled work |
| Suitability | workable but brittle | wrong tool for this problem | best fit for one user, two devices |

## 6. Recommendation

**Adopt Option 3, validated by its spike first. Shelve Option 1's guard. Do not pursue Option 2 for this problem.**

Why:

1. It matches how ST is built instead of opposing it, which is the concern that prompted this review.
2. It protects everything with one rule, so there is no list of endpoints to keep complete. Option 1's weakness is that a single missed case is a silent overwrite.
3. It matches real use: one person moving between a phone and a PC, almost never typing on both at once.
4. It is small enough to prove or disprove in two days.

Tradeoffs accepted: no simultaneous use; a reload on every device switch; enforcement by the pages themselves, not the server; a Phase 8 design constraint.

**If the spike fails** (ST misbehaves when parked, or the switch feels too slow), fall back to Option 1 in a reduced form: settings and character guards only, plus the "reload before editing" freshness checks.

**What carries over from today's work:** the extension repo and its context files, app-side injection and reload plumbing, the submodule and install prompt, and every source finding (chat integrity is not a version check; cards are saved on chat open; lorebooks have no backups; plugins cannot intercept ST's routes).

**Decision needed from the owner:** is "one device at a time, with a quick switch" acceptable? If simultaneous use on two devices is a requirement, Option 1 is the only candidate and its cost should be accepted knowingly.

## Sources

- SillyTavern 1.19.1 source: `public/script.js`, `public/scripts/world-info.js`, `public/scripts/chats.js`, `public/scripts/extensions.js`, `src/endpoints/{files,vectors,settings,worldinfo,chats,characters}.js`, `src/plugin-loader.js`, `src/users.js`
- [SillyTavern-MemoryBooks](https://github.com/aikohanasaki/SillyTavern-MemoryBooks) source (`addlore.js`, `arcanalysis.js`, `index.js`, `LICENSE`)
- [CharMemory](https://github.com/bal-spec/sillytavern-character-memory): memories in the Data Bank, retrieved by Vector Storage
- [Martin Kleppmann, "How to do distributed locking"](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html): leases and fencing tokens
- [World Anvil issue tracker](https://www.worldanvil.com/udan-tracker/99db26ba-5c91-433d-bb5c-49465761a066/view): a product stating it is not meant for concurrent tabs or devices
- [Discourse: "Draft is being edited in another window"](https://meta.discourse.org/t/reducing-the-frequency-of-display-for-the-warning-draft-is-being-edited-in-another-window/150826): the warn-and-take-over pattern in a web editor
