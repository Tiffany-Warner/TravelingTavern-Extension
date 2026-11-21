// TravelingTavern session lease: one SillyTavern page per user writes, every other page is parked.
// Classic script (one IIFE, no imports): loaded by the extension's index.js, injected by the
// TravelingTavern app at document start, or by Playwright. Spec: context/specs/ext-0.2-session-lease-spec.md
(function () {
    'use strict';

    /** Bump on every change to lease behavior or the app contract (spec E11). The app compares it. */
    const LEASE_VERSION = 1;

    /** File format this copy writes (spec E2). */
    const LEASE_FORMAT = 1;
    /** File formats this copy can read. Anything else (incl. a missing format) parks the page. */
    const KNOWN_FORMATS = Object.freeze([1]);

    const LEASE_FILE = 'tt-session-lease.json';
    const RELEASE_FILE = 'tt-session-release.json';
    /** ST serves a user's files here (GET). */
    const USER_FILES_PATH = '/user/files/';
    /** ST's user-file upload (POST, `{ name, data }` with data as base64). Writes atomically. */
    const UPLOAD_PATH = '/api/files/upload';

    /** Lease writes: attempts in total, and the random delay before each retry (spec E3). */
    const WRITE_ATTEMPTS = 3;
    const RETRY_MIN_MS = 100;
    const RETRY_MAX_MS = 200;

    /** Write kinds, which decide what happens when every attempt failed (spec E3). */
    const WRITE_KIND = Object.freeze({
        claim: 'claim',
        bump: 'bump',
        busy: 'busy',
        active: 'active',
    });

    /** Why a page is parked (spec E11 `leaseState.reason`). */
    const PARK_REASON = Object.freeze({
        held: 'held',
        lost: 'lost',
        claiming: 'claiming',
        waitingForReply: 'waitingForReply',
        lostRace: 'lostRace',
        unreadable: 'unreadable',
        unknownFormat: 'unknownFormat',
        reloadPending: 'reloadPending',
    });

    /** Page phases. A page leaves `deciding` once; it becomes holder only through the start decision. */
    const PHASE = Object.freeze({ deciding: 'deciding', holder: 'holder', parked: 'parked' });

    /** What started a claim; stored in the reopen flag (spec E4, E10). */
    const CLAIM_KIND = Object.freeze({ automatic: 'automatic', useHere: 'useHere', foreground: 'foreground' });

    /** Claim grace: a write the old holder already sent lands before this page loads (spec E4). */
    const GRACE_MS = 1000;
    /** The claim's wait for `busy`: re-read once per second for at most 60 s (spec E4, the one polling exception). */
    const BUSY_WAIT_INTERVAL_MS = 1000;
    const BUSY_WAIT_MAX_MS = 60000;

    /** A holder trusts a lease read this old for GETs and allowlisted reads (spec E6). */
    const READ_WINDOW_MS = 2000;
    /** ST's own `/csrf-token` waits at most this long for the lease's token fetch (spec E6). */
    const CSRF_ORDER_MAX_WAIT_MS = 2000;
    /** A page still alive this long after its reload was asked for parks as `reloadPending` (spec E7). */
    const RELOAD_FALLBACK_MS = 2500;

    /** ST versions this lease was tested against (spec E12). The allowlist is off on any other. */
    const TESTED_ST_VERSIONS = Object.freeze(['1.19.0', '1.19.1']);

    const CSRF_TOKEN_PATH = '/csrf-token';
    const VERSION_PATH = '/version';
    /** ST's login page: the lease never installs there (spec E11). */
    const LOGIN_PATH = '/login';

    /**
     * Read-only POST endpoints that skip the holder's pre-request check (spec E6). Each confirmed in ST
     * 1.19.0 and 1.19.1 (spec E15). `*` is one path segment. Still held while parked.
     */
    const READ_ALLOWLIST = Object.freeze([
        '/api/settings/get',
        '/api/characters/all',
        '/api/characters/get',
        '/api/groups/all',
        '/api/chats/get',
        '/api/chats/group/get',
        '/api/chats/recent',
        '/api/worldinfo/get',
        '/api/avatars/get',
        '/api/backgrounds/folders',
        '/api/image-metadata/all',
        '/api/secrets/read',
        '/api/stats/get',
        '/api/sd/comfy/workflows',
        '/api/tokenizers/*/encode',
        '/api/tokenizers/*/count',
    ]);

    /** Chat saves: the only held requests aborted before a reload (spec E7, E15). */
    const CHAT_SAVE_PATHS = Object.freeze(['/api/chats/save', '/api/chats/group/save']);

    /** Messages (spec E11). */
    const MESSAGE_VERSION = 1;
    const APP_LISTENER = 'TravelingTavern';
    const DESKTOP_EVENT = 'tt-lease';
    const LOG_PREFIX = '[TravelingTavern]';

    /** sessionStorage keys (per tab, per origin). */
    const STORAGE_KEYS = Object.freeze({
        /** This tab's id, the first part of the lease's `holder` (a refresh keeps it, a duplicated tab copies it). */
        tabId: 'tt-lease-tab-id',
        /** Set before an automatic claim; cleared once a load becomes holder (no reload loop). */
        autoClaimed: 'tt-lease-auto-claimed',
        /** Set before a claim's reload: the CLAIM_KIND, read after the reload to reopen the chat. */
        reopen: 'tt-lease-reopen',
    });

    // ---- Pure decisions ----------------------------------------------------------------------

    /**
     * Whether a value is a plain JSON object (not null, not an array).
     * @param {unknown} value Parsed JSON.
     * @returns {boolean} True for an object.
     */
    function isObject(value) {
        return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /**
     * Whether a value is an epoch: an integer of at least 1.
     * @param {unknown} value Field value.
     * @returns {boolean} True for a valid epoch.
     */
    function isEpoch(value) {
        return Number.isInteger(value) && value >= 1;
    }

    /**
     * Whether a value is a non-empty string.
     * @param {unknown} value Field value.
     * @returns {boolean} True for a non-empty string.
     */
    function isText(value) {
        return typeof value === 'string' && value.length > 0;
    }

    /**
     * Checks a file's `format`. A missing or non-integer format is an unknown format (spec E2).
     * @param {object} value Parsed file object.
     * @returns {boolean} True when this copy can read the file.
     */
    function hasKnownFormat(value) {
        return Number.isInteger(value.format) && KNOWN_FORMATS.includes(value.format);
    }

    /**
     * Parses the lease's `active` field: the holder's open chat, or null.
     * @param {unknown} value Field value.
     * @returns {{ ok: true, active: object|null } | { ok: false }} Only the known keys are kept.
     */
    function parseActive(value) {
        if (value === null) return { ok: true, active: null };
        if (!isObject(value) || !isText(value.chatFile)) return { ok: false };
        if (isText(value.groupId)) return { ok: true, active: { groupId: value.groupId, chatFile: value.chatFile } };
        if (isText(value.avatar)) return { ok: true, active: { avatar: value.avatar, chatFile: value.chatFile } };
        return { ok: false };
    }

    /**
     * Validates a parsed lease file (spec E2). Unknown fields are dropped, so a page that writes the
     * lease back never keeps fields it doesn't know.
     * @param {unknown} value Parsed JSON.
     * @returns {{ kind: 'ok', lease: object } | { kind: 'unknownFormat' } | { kind: 'unreadable', why: string }}
     *     The lease, or why it can't be used.
     */
    function parseLease(value) {
        if (!isObject(value)) return { kind: 'unreadable', why: 'not an object' };
        if (!hasKnownFormat(value)) return { kind: 'unknownFormat' };
        if (!isText(value.holder)) return { kind: 'unreadable', why: 'holder' };
        if (!isEpoch(value.epoch)) return { kind: 'unreadable', why: 'epoch' };
        if (typeof value.claimedAt !== 'string') return { kind: 'unreadable', why: 'claimedAt' };
        if (typeof value.busy !== 'boolean') return { kind: 'unreadable', why: 'busy' };
        const active = parseActive(value.active);
        if (!active.ok) return { kind: 'unreadable', why: 'active' };
        return {
            kind: 'ok',
            lease: {
                format: value.format,
                holder: value.holder,
                epoch: value.epoch,
                claimedAt: value.claimedAt,
                busy: value.busy,
                active: active.active,
            },
        };
    }

    /**
     * Validates a parsed release marker (spec E2).
     * @param {unknown} value Parsed JSON.
     * @returns {{ kind: 'ok', marker: object } | { kind: 'unknownFormat' } | { kind: 'unreadable', why: string }}
     *     The marker, or why it can't be used.
     */
    function parseMarker(value) {
        if (!isObject(value)) return { kind: 'unreadable', why: 'not an object' };
        if (!hasKnownFormat(value)) return { kind: 'unknownFormat' };
        if (!isText(value.holder)) return { kind: 'unreadable', why: 'holder' };
        if (!isEpoch(value.epoch)) return { kind: 'unreadable', why: 'epoch' };
        if (typeof value.releasedAt !== 'string') return { kind: 'unreadable', why: 'releasedAt' };
        return {
            kind: 'ok',
            marker: { format: value.format, holder: value.holder, epoch: value.epoch, releasedAt: value.releasedAt },
        };
    }

    /**
     * The pair rule (spec E2): whether a lease names exactly this (holder, epoch). Never the epoch alone.
     * @param {object|null} lease Parsed lease, or null.
     * @param {{ holder: string, epoch: number }|null} pair Pair to compare.
     * @returns {boolean} True when both holder and epoch match.
     */
    function holdsPair(lease, pair) {
        return Boolean(lease && pair) && lease.holder === pair.holder && lease.epoch === pair.epoch;
    }

    /**
     * Whether the lease is released (spec E2): both files read and known, and the marker names the
     * lease's exact pair. Anything else is not released.
     * @param {{ kind: string, lease?: object }} leaseRead Result of reading the lease.
     * @param {{ kind: string, marker?: object }} markerRead Result of reading the marker.
     * @returns {boolean} True only on an exact pair match.
     */
    function isReleased(leaseRead, markerRead) {
        if (leaseRead.kind !== 'ok' || markerRead.kind !== 'ok') return false;
        return holdsPair(leaseRead.lease, markerRead.marker);
    }

    /**
     * Whether two `active` values name the same chat.
     * @param {object|null} a Parsed `active`.
     * @param {object|null} b Parsed `active`.
     * @returns {boolean} True when equal.
     */
    function sameActive(a, b) {
        if (a === null || b === null) return a === b;
        return a.avatar === b.avatar && a.groupId === b.groupId && a.chatFile === b.chatFile;
    }

    /**
     * Decides a holder's `busy` / `active` update against the lease just re-read (spec E3).
     * @param {{ kind: string, lease?: object }} read Result of reading the lease.
     * @param {{ holder: string, epoch: number }} pair The holder's pair.
     * @param {{ busy?: boolean, active?: object|null }} changes Fields to set.
     * @returns {{ action: 'write', lease: object } | { action: 'skip', lease: object } | { action: 'park'|'retry', reason: string }}
     *     What to do.
     */
    function decideUpdate(read, pair, changes) {
        const blocked = blockedByRead(read);
        if (blocked) return blocked;
        const lease = read.lease;
        if (!holdsPair(lease, pair)) return { action: 'park', reason: PARK_REASON.lost };
        const next = Object.assign({}, lease, { format: LEASE_FORMAT }, changes);
        const unchanged = next.busy === lease.busy && sameActive(next.active, lease.active);
        return unchanged ? { action: 'skip', lease } : { action: 'write', lease: next };
    }

    /**
     * Decides an epoch bump to (holder, epoch + 1) against the lease just re-read (spec E2, E3). The new
     * holder is `changes.holder` (a new load in the same tab) or stays `from.holder`. A lease that already
     * holds the target pair means an earlier attempt landed despite its error answer.
     * @param {{ kind: string, lease?: object }} read Result of reading the lease.
     * @param {{ holder: string, epoch: number }} from The pair the bump starts from.
     * @param {{ holder?: string, busy?: boolean }} changes Fields to set with the bump.
     * @param {string} claimedAt Informational timestamp.
     * @returns {{ action: 'write', lease: object } | { action: 'skip', lease: object } | { action: 'park'|'retry', reason: string }}
     *     What to do.
     */
    function decideBump(read, from, changes, claimedAt) {
        const blocked = blockedByRead(read);
        if (blocked) return blocked;
        const lease = read.lease;
        if (holdsPair(lease, { holder: changes.holder || from.holder, epoch: from.epoch + 1 })) return { action: 'skip', lease };
        if (!holdsPair(lease, from)) return { action: 'park', reason: PARK_REASON.lost };
        const next = Object.assign({}, lease, { format: LEASE_FORMAT }, changes, { epoch: lease.epoch + 1, claimedAt });
        return { action: 'write', lease: next };
    }

    /**
     * The decision for a lease read that can't be built on (spec E2, E3). An unknown format parks at
     * once. An unreadable or missing lease may be transient, so it counts as a failed attempt and is
     * retried; it parks only if the last attempt's read still fails (missing: this page's claim is gone).
     * @param {{ kind: string }} read Result of reading the lease.
     * @returns {{ action: 'park'|'retry', reason: string } | null} Park or retry, or null when the lease was read.
     */
    function blockedByRead(read) {
        if (read.kind === 'ok') return null;
        if (read.kind === 'unknownFormat') return { action: 'park', reason: PARK_REASON.unknownFormat };
        if (read.kind === 'missing') return { action: 'retry', reason: PARK_REASON.lost };
        return { action: 'retry', reason: PARK_REASON.unreadable };
    }

    /**
     * The start decision (spec E4) from the two files read at page load.
     * @param {{ kind: string, lease?: object }} leaseRead Result of reading the lease.
     * @param {{ kind: string, marker?: object }} markerRead Result of reading the marker.
     * @param {string} tabId This tab's id.
     * @returns {{ action: 'bump', from: { holder: string, epoch: number } } | { action: 'claim' } | { action: 'park', reason: string }}
     *     Lease held from this tab (a refresh or a duplicated tab) → bump the epoch to this load; no
     *     lease or released → automatic claim; otherwise park.
     */
    function decideStart(leaseRead, markerRead, tabId) {
        if (leaseRead.kind === 'unknownFormat' || markerRead.kind === 'unknownFormat') {
            return { action: 'park', reason: PARK_REASON.unknownFormat };
        }
        if (leaseRead.kind === 'unreadable') return { action: 'park', reason: PARK_REASON.unreadable };
        if (leaseRead.kind === 'missing') return { action: 'claim' };
        const lease = leaseRead.lease;
        if (tabOf(lease.holder) === tabId) return { action: 'bump', from: { holder: lease.holder, epoch: lease.epoch } };
        if (markerRead.kind === 'unreadable') return { action: 'park', reason: PARK_REASON.unreadable };
        if (isReleased(leaseRead, markerRead)) return { action: 'claim' };
        return { action: 'park', reason: PARK_REASON.held };
    }

    /**
     * One step of the claim's wait for `busy` (spec E4).
     * @param {{ kind: string, lease?: object }} leaseRead Result of re-reading the lease.
     * @param {{ kind: string, marker?: object }} markerRead Result of re-reading the marker.
     * @param {{ holder: string, epoch: number }} basePair The pair being waited on.
     * @returns {{ action: 'wait', base?: object } | { action: 'continue', base: object|null } | { action: 'park', reason: string }}
     *     Keep waiting (an unreadable read is not free: keep waiting); continue the claim when `busy`
     *     cleared, the lease was released or is gone; park when another page claimed.
     */
    function decideWaitStep(leaseRead, markerRead, basePair) {
        if (leaseRead.kind === 'unknownFormat' || markerRead.kind === 'unknownFormat') {
            return { action: 'park', reason: PARK_REASON.unknownFormat };
        }
        if (leaseRead.kind === 'unreadable') return { action: 'wait' };
        if (leaseRead.kind === 'missing') return { action: 'continue', base: null };
        if (!holdsPair(leaseRead.lease, basePair)) return { action: 'park', reason: PARK_REASON.lostRace };
        if (!leaseRead.lease.busy || isReleased(leaseRead, markerRead)) return { action: 'continue', base: leaseRead.lease };
        return { action: 'wait', base: leaseRead.lease };
    }

    /**
     * Decides the claim write (spec E4 step 3) against the lease just re-read. The claim builds on the
     * lease it read before (`base`); if that pair changed, another page claimed first.
     * @param {{ kind: string, lease?: object }} read Result of re-reading the lease.
     * @param {object|null} base The lease the claim builds on, or null when there was none.
     * @param {string} pageId This page's id.
     * @param {string} claimedAt Informational timestamp.
     * @returns {{ action: 'write', lease: object } | { action: 'skip', lease: object } | { action: 'park'|'retry', reason: string }}
     *     What to do. Writes `epoch + 1` (1 without a lease), `busy: false`, `active` carried over.
     */
    function decideClaim(read, base, pageId, claimedAt) {
        if (read.kind === 'unknownFormat') return { action: 'park', reason: PARK_REASON.unknownFormat };
        if (read.kind === 'unreadable') return { action: 'retry', reason: PARK_REASON.unreadable };
        const epoch = base ? base.epoch + 1 : 1;
        if (read.kind === 'missing') {
            if (base) return { action: 'retry', reason: PARK_REASON.unreadable };
            return { action: 'write', lease: claimLease(pageId, epoch, claimedAt, null) };
        }
        if (holdsPair(read.lease, { holder: pageId, epoch })) return { action: 'skip', lease: read.lease };
        if (!holdsPair(read.lease, base)) return { action: 'park', reason: PARK_REASON.lostRace };
        return { action: 'write', lease: claimLease(pageId, epoch, claimedAt, read.lease.active) };
    }

    /**
     * A claim's lease file: every field of this copy's format.
     * @param {string} holder Page id.
     * @param {number} epoch New epoch.
     * @param {string} claimedAt Informational timestamp.
     * @param {object|null} active Carried over from the previous lease.
     * @returns {object} Lease file content.
     */
    function claimLease(holder, epoch, claimedAt, active) {
        return { format: LEASE_FORMAT, holder, epoch, claimedAt, busy: false, active };
    }

    /**
     * The verify after a claim or an epoch bump (pair rule, spec E2): the lease must hold this pair.
     * @param {{ kind: string, lease?: object }} read Result of re-reading the lease.
     * @param {{ holder: string, epoch: number }} pair The pair just written.
     * @param {string} lostReason Park reason when another pair is in the file.
     * @returns {{ ok: true } | { ok: false, reason: string }} Verified, or why not.
     */
    function decideVerify(read, pair, lostReason) {
        if (read.kind === 'unknownFormat') return { ok: false, reason: PARK_REASON.unknownFormat };
        if (read.kind === 'unreadable') return { ok: false, reason: PARK_REASON.unreadable };
        if (read.kind === 'missing' || !holdsPair(read.lease, pair)) return { ok: false, reason: lostReason };
        return { ok: true };
    }

    /**
     * The release marker for an exact claim (spec E2, E5).
     * @param {{ holder: string, epoch: number }} pair The claim being given up.
     * @param {string} releasedAt Informational timestamp.
     * @returns {object} Marker file content.
     */
    function markerFor(pair, releasedAt) {
        return { format: LEASE_FORMAT, holder: pair.holder, epoch: pair.epoch, releasedAt };
    }

    /**
     * The tab part of a holder (`<tab id>.<load id>`, spec E2): everything before the first dot.
     * @param {string} holder A lease's holder.
     * @returns {string} Tab id.
     */
    function tabOf(holder) {
        const dot = holder.indexOf('.');
        return dot === -1 ? holder : holder.slice(0, dot);
    }

    /**
     * Whether a stored value can be a tab id: non-empty, no dot.
     * @param {unknown} value Stored value.
     * @returns {boolean} True for a usable tab id.
     */
    function isTabId(value) {
        return isText(value) && !value.includes('.');
    }

    /**
     * A random id in hex: tab ids and load ids. `crypto.getRandomValues` works over plain http
     * (unlike `crypto.subtle` and `randomUUID`); Math.random is the fallback. No personal data.
     * @param {number} byteCount Random bytes.
     * @returns {string} Hex id.
     */
    function randomHex(byteCount) {
        const bytes = new Uint8Array(byteCount);
        const source = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
        if (source) source.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Pathname of a fetch or XHR target, lower-cased and without trailing slashes (Express routing
     * ignores both), so a variant spelling can't slip past the wrapper.
     * @param {string|URL|Request} input fetch input or XHR URL.
     * @returns {string} Normalized pathname, or '' if it can't be parsed.
     */
    function requestPath(input) {
        const raw = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
        try {
            return new URL(raw, 'http://localhost/').pathname.toLowerCase().replace(/\/+$/, '');
        } catch (error) {
            return '';
        }
    }

    /**
     * HTTP method of a fetch call, upper-cased (init overrides a Request's, as fetch does).
     * @param {string|URL|Request} input fetch input.
     * @param {RequestInit} [init] fetch options.
     * @returns {string} Method.
     */
    function requestMethod(input, init) {
        if (init && init.method) return String(init.method).toUpperCase();
        if (input && typeof input === 'object' && typeof input.method === 'string') return input.method.toUpperCase();
        return 'GET';
    }

    /**
     * The AbortSignal of a fetch call, if any (init overrides a Request's).
     * @param {string|URL|Request} input fetch input.
     * @param {RequestInit} [init] fetch options.
     * @returns {AbortSignal|null} Signal.
     */
    function requestSignal(input, init) {
        if (init && init.signal) return init.signal;
        if (input && typeof input === 'object' && input.signal) return input.signal;
        return null;
    }

    /**
     * Server data (spec E6): a path under `/api/` or `/user/`, or any method other than GET.
     * @param {string} path Normalized pathname.
     * @param {string} method Upper-case method.
     * @returns {boolean} True when the wrapper must decide about the request.
     */
    function isServerData(path, method) {
        return method !== 'GET' || /(^|\/)(api|user)(\/|$)/.test(path);
    }

    /**
     * Whether a path is an endpoint pattern (`*` = one segment). A prefix before it is allowed (ST
     * behind a reverse-proxy subpath).
     * @param {string} path Normalized pathname.
     * @param {string} pattern Endpoint pattern starting with '/'.
     * @returns {boolean} True on a match.
     */
    function matchesEndpoint(path, pattern) {
        const parts = path.split('/');
        const want = pattern.split('/');
        const offset = parts.length - want.length;
        if (offset < 0) return false;
        for (let i = 1; i < want.length; i++) {
            const part = parts[offset + i];
            if (!part || (want[i] !== '*' && want[i] !== part)) return false;
        }
        return true;
    }

    /** Whether a path is on the read allowlist (spec E6). */
    function isAllowlisted(path) {
        return READ_ALLOWLIST.some((pattern) => matchesEndpoint(path, pattern));
    }

    /** Whether a path is a chat save (spec E7). */
    function isChatSave(path) {
        return CHAT_SAVE_PATHS.some((pattern) => matchesEndpoint(path, pattern));
    }

    /** Whether a request is ST's own CSRF token request (spec E6, ordering). */
    function isCsrfTokenRequest(path, method) {
        return method === 'GET' && matchesEndpoint(path, CSRF_TOKEN_PATH);
    }

    /**
     * Whether a page is ST's login page (spec E11): URL pathname ending in `/login`, compared
     * lower-case with trailing slashes ignored. The query string is not part of the pathname.
     * @param {string} pathname `location.pathname`.
     * @returns {boolean} True on the login page.
     */
    function isLoginPage(pathname) {
        return matchesEndpoint(String(pathname).toLowerCase().replace(/\/+$/, ''), LOGIN_PATH);
    }

    /**
     * What the wrapper does with a server-data request (spec E6).
     * @param {object} input
     * @param {string} input.phase The page's phase.
     * @param {string} input.method Upper-case method.
     * @param {boolean} input.allowlisted On the allowlist, with the allowlist on.
     * @param {number} input.readAgeMs Age of the holder's last confirming lease read.
     * @returns {'wait'|'hold'|'send'|'check'} Wait for the start decision; hold; send; or re-read the
     *     lease first.
     */
    function decideRequest({ phase, method, allowlisted, readAgeMs }) {
        if (phase === PHASE.deciding) return 'wait';
        if (phase !== PHASE.holder) return 'hold';
        if ((method === 'GET' || allowlisted) && readAgeMs <= READ_WINDOW_MS) return 'send';
        return 'check';
    }

    /**
     * Held requests (spec E6, E7): only each one's path and reject function are kept, never the
     * request, so no code path can send one later.
     * @param {() => Error} makeAbortError Makes the AbortError a rejected request gets.
     * @returns {{ add: Function, abortChatSaves: Function, size: Function }} The registry.
     */
    function createHeldRegistry(makeAbortError) {
        const held = new Set();
        return {
            /**
             * Keeps a held request's path and reject function.
             * @returns {() => void} Removes the entry (e.g. when its own signal aborts).
             */
            add(path, reject) {
                const entry = { path, reject };
                held.add(entry);
                return () => { held.delete(entry); };
            },
            /**
             * Before a reload: rejects held chat saves with an AbortError; held reads stay pending.
             * @returns {number} How many were aborted.
             */
            abortChatSaves() {
                let count = 0;
                for (const entry of Array.from(held)) {
                    if (!isChatSave(entry.path)) continue;
                    held.delete(entry);
                    entry.reject(makeAbortError());
                    count++;
                }
                return count;
            },
            size: () => held.size,
        };
    }

    /**
     * Holds a fetch (spec E6): a promise that stays pending. Its own signal aborting rejects it with an
     * AbortError and removes it from the registry, so it can never be sent.
     * @param {object} held Registry from createHeldRegistry.
     * @param {string} path Normalized pathname.
     * @param {AbortSignal|null} signal The request's signal.
     * @param {() => Error} makeAbortError Makes an AbortError.
     * @returns {Promise<never>} Never resolves.
     */
    function holdFetch(held, path, signal, makeAbortError) {
        return new Promise((resolve, reject) => {
            if (signal && signal.aborted) {
                reject(makeAbortError());
                return;
            }
            const onAbort = () => {
                remove();
                reject(makeAbortError());
            };
            const remove = held.add(path, (error) => {
                if (signal) signal.removeEventListener('abort', onAbort);
                reject(error);
            });
            if (signal) signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    /**
     * The `leaseInfo` message (spec E11, E12).
     * @param {string|null} stVersion ST's version from `/version`, or null.
     * @param {unknown} extension `window.__ttExtension`, if any.
     * @returns {object} Message fields.
     */
    function buildLeaseInfo(stVersion, extension) {
        const ext = isObject(extension) ? extension : {};
        return {
            leaseVersion: LEASE_VERSION,
            extensionVersion: typeof ext.version === 'string' ? ext.version : null,
            extensionLeaseVersion: Number.isInteger(ext.leaseVersion) ? ext.leaseVersion : null,
            stVersion: typeof stVersion === 'string' ? stVersion : null,
            untestedServer: !TESTED_ST_VERSIONS.includes(stVersion),
        };
    }

    /**
     * What a write's caller is told when every attempt failed (spec E3).
     * @param {string} kind One of WRITE_KIND.
     * @returns {{ status: 'parked', reason: string } | { status: 'failed' }} Claims and bumps park; the
     *     holder's `busy` / `active` updates fail and the page stays holder.
     */
    function exhaustedOutcome(kind) {
        if (kind === WRITE_KIND.claim || kind === WRITE_KIND.bump) return { status: 'parked', reason: PARK_REASON.unreadable };
        return { status: 'failed' };
    }

    /**
     * Base64 of a string's UTF-8 bytes (ST's upload format). No secure-context APIs.
     * @param {string} text Text to encode.
     * @returns {string} Base64.
     */
    function base64Utf8(text) {
        const bytes = new TextEncoder().encode(text);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    /**
     * Request body for ST's user-file upload.
     * @param {string} name File name.
     * @param {object} value JSON content.
     * @returns {string} JSON body.
     */
    function uploadBody(name, value) {
        return JSON.stringify({ name, data: base64Utf8(JSON.stringify(value)) });
    }

    // ---- The lease ---------------------------------------------------------------------------

    /**
     * Creates the lease's logic for one page. No DOM, network or globals except through the params,
     * so Node can test it with a fake fetch.
     * @param {object} deps
     * @param {(url: string, init?: object) => Promise<Response>} deps.fetch The original fetch, never the
     *     wrapped one. The browser glue adds ST's request headers (incl. its CSRF header) to POSTs.
     * @param {(type: string, payload: object) => void} deps.post Reports (spec E11); the browser glue
     *     adds the page-only fields (`connected`, `origin`) and routes them to the app or `tt-lease`.
     * @param {() => number} deps.now Milliseconds since the epoch: timestamps and the bounded busy wait.
     * @param {(ms: number) => Promise<void>} deps.sleep Bounded one-off delay.
     * @param {{ getItem: Function, setItem: Function, removeItem: Function }} deps.storage This tab's
     *     sessionStorage. Errors are caught: no storage means no automatic claim and a new id per load.
     * @param {(level: string, message: string, details?: object) => void} deps.log Logger: events,
     *     reasons, paths and counts only.
     * @returns {object} The lease for this page.
     */
    function createSessionLease({ fetch, post, now, sleep, storage, log }) {
        const state = {
            queue: Promise.resolve(),
            /** A `busy: false` that couldn't be written yet: sent with the holder's next lease write. */
            pendingBusyClear: false,
        };

        /**
         * Reads one of the lease files, uncached (spec E2).
         * @param {string} name File name.
         * @returns {Promise<{ kind: 'missing' } | { kind: 'unreadable', why: string } | { kind: 'json', value: unknown }>}
         *     404 is missing; anything else that isn't a 2xx JSON answer is unreadable.
         */
        async function readFile(name) {
            let response;
            try {
                response = await fetch(USER_FILES_PATH + name, { cache: 'no-store' });
            } catch (error) {
                return { kind: 'unreadable', why: 'network' };
            }
            if (response.status === 404) return { kind: 'missing' };
            if (!response.ok) return { kind: 'unreadable', why: 'status ' + response.status };
            try {
                return { kind: 'json', value: JSON.parse(await response.text()) };
            } catch (error) {
                return { kind: 'unreadable', why: 'json' };
            }
        }

        /**
         * Reads and validates the lease.
         * @returns {Promise<{ kind: 'ok', lease: object } | { kind: 'missing' } | { kind: 'unknownFormat' } | { kind: 'unreadable', why: string }>}
         *     The lease, or why there is none.
         */
        async function readLease() {
            const file = await readFile(LEASE_FILE);
            const read = file.kind === 'json' ? parseLease(file.value) : file;
            if (read.kind === 'unreadable') log('warn', 'lease unreadable', { why: read.why });
            return read;
        }

        /**
         * Reads and validates the release marker.
         * @returns {Promise<{ kind: 'ok', marker: object } | { kind: 'missing' } | { kind: 'unknownFormat' } | { kind: 'unreadable', why: string }>}
         *     The marker, or why there is none.
         */
        async function readMarker() {
            const file = await readFile(RELEASE_FILE);
            const read = file.kind === 'json' ? parseMarker(file.value) : file;
            if (read.kind === 'unreadable') log('warn', 'release marker unreadable', { why: read.why });
            return read;
        }

        /**
         * Uploads a file through ST's upload endpoint.
         * @param {string} name File name.
         * @param {object} value JSON content.
         * @param {object} [extra] Extra fetch options (`keepalive` for the release).
         * @returns {Promise<boolean>} True when ST answered 2xx.
         */
        async function uploadFile(name, value, extra) {
            try {
                const response = await fetch(UPLOAD_PATH, Object.assign({
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: uploadBody(name, value),
                    cache: 'no-store',
                }, extra));
                return response.ok;
            } catch (error) {
                return false;
            }
        }

        /**
         * Runs lease writes one at a time, in order (spec E3: one write in flight).
         * @param {() => Promise<T>} task Write task.
         * @returns {Promise<T>} The task's result.
         * @template T
         */
        function enqueue(task) {
            const run = state.queue.then(task, task);
            state.queue = run.then(() => undefined, () => undefined);
            return run;
        }

        /**
         * One lease write with the bounded retry (spec E3): re-read before every attempt, decide, write.
         * Parks at once when the decision says so (pair changed, unknown format). A failed write and an
         * unreadable or missing re-read are both failed attempts. After the last attempt: a failed read
         * parks; a failed write leaves the outcome to the kind.
         * @param {string} kind One of WRITE_KIND.
         * @param {(read: object) => { action: string, lease?: object, reason?: string }} decide Decision
         *     for the lease just read.
         * @returns {Promise<{ status: 'written'|'unchanged', lease: object } | { status: 'parked', reason: string } | { status: 'failed' }>}
         *     The outcome.
         */
        async function writeWithRetry(kind, decide) {
            let lastReadFailure = null;
            for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
                if (attempt > 1) await sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS + 1)));
                const decision = decide(await readLease());
                if (decision.action === 'park') return { status: 'parked', reason: decision.reason };
                if (decision.action === 'skip') return { status: 'unchanged', lease: decision.lease };
                if (decision.action === 'retry') {
                    lastReadFailure = decision.reason;
                    log('warn', 'lease re-read failed before a write', { kind, attempt, reason: decision.reason });
                    continue;
                }
                lastReadFailure = null;
                if (await uploadFile(LEASE_FILE, decision.lease)) return { status: 'written', lease: decision.lease };
                log('warn', 'lease write failed', { kind, attempt });
            }
            if (lastReadFailure) return { status: 'parked', reason: lastReadFailure };
            return exhaustedOutcome(kind);
        }

        /**
         * Changes the holder's `busy` and / or `active` (spec E3). A pending `busy: false` from an earlier
         * failed write goes with it. Unchanged values aren't written.
         * @param {{ holder: string, epoch: number }} pair This page's pair.
         * @param {{ busy?: boolean, active?: object|null }} changes Fields to set.
         * @returns {Promise<{ status: 'written'|'unchanged', lease: object } | { status: 'parked', reason: string } | { status: 'failed' }>}
         *     `failed` leaves the page holder; after a failed `busy` write a `busy: false` stays pending.
         */
        function updateLease(pair, changes) {
            return enqueue(async () => {
                const merged = Object.assign({}, changes);
                if (state.pendingBusyClear && merged.busy === undefined) merged.busy = false;
                const kind = merged.busy === undefined ? WRITE_KIND.active : WRITE_KIND.busy;
                const outcome = await writeWithRetry(kind, (read) => decideUpdate(read, pair, merged));
                settlePendingBusyClear(merged.busy, outcome);
                if (outcome.status === 'failed') log('warn', 'lease update gave up', { kind });
                return outcome;
            });
        }

        /**
         * Keeps or clears the pending `busy: false` after an update (spec E3).
         * @param {boolean|undefined} busy The `busy` value the update tried to write.
         * @param {{ status: string }} outcome The update's outcome.
         * @returns {void}
         */
        function settlePendingBusyClear(busy, outcome) {
            if (busy === undefined) return;
            // Landed, or no longer holder: nothing to carry. Any failed `busy` write leaves a clear
            // pending: a failed `busy: true` may still have landed (error answer after the write), and
            // no reply was started.
            state.pendingBusyClear = outcome.status === 'failed';
        }

        /**
         * Bumps the epoch to (holder, epoch + 1), from a pair this page holds or its tab held (spec E2,
         * E4, E5). The caller verifies the new pair afterwards (pair rule).
         * @param {{ holder: string, epoch: number }} from The pair to bump from.
         * @param {{ holder?: string, busy?: boolean }} [changes] Fields to set, e.g. this load's holder and
         *     `busy: false` at a fresh load.
         * @returns {Promise<{ status: 'written'|'unchanged', lease: object } | { status: 'parked', reason: string }>}
         *     The new lease, or park (incl. when every attempt failed).
         */
        function bumpEpoch(from, changes) {
            return enqueue(() => writeWithRetry(WRITE_KIND.bump, (read) =>
                decideBump(read, from, changes || {}, new Date(now()).toISOString())));
        }

        // ---- This page: start decision, claim, release (spec E4, E5) ---------------------------

        /** Reads sessionStorage; null when it's missing or throws. */
        function storageGet(key) {
            try {
                return storage.getItem(key);
            } catch (error) {
                return null;
            }
        }

        /** Writes sessionStorage; false when it throws. */
        function storageSet(key, value) {
            try {
                storage.setItem(key, value);
                return true;
            } catch (error) {
                return false;
            }
        }

        /** Removes a sessionStorage key; errors ignored. */
        function storageRemove(key) {
            try {
                storage.removeItem(key);
            } catch (error) {
                // Nothing to undo: the key stays or never existed.
            }
        }

        /**
         * This tab's id from sessionStorage, or a new one (kept when storage works).
         * @returns {string} Tab id.
         */
        function loadTabId() {
            const stored = storageGet(STORAGE_KEYS.tabId);
            if (isTabId(stored)) return stored;
            const id = 't' + randomHex(8);
            if (!storageSet(STORAGE_KEYS.tabId, id)) log('warn', 'no sessionStorage: tab id kept for this load only');
            return id;
        }

        const tabId = loadTabId();
        const page = {
            /** This load's holder id, `<tab id>.<load id>` (spec E2): a new load id on every page load. */
            id: tabId + '.' + randomHex(8),
            phase: PHASE.deciding,
            reason: null,
            /** The pair this page holds now (holder only). */
            pair: null,
            /** The epoch held in this load, kept after parking (`leaseState.epoch`). */
            heldEpoch: null,
            claiming: false,
            /** Set by release(): the claim was given up on `pagehide` or `freeze` (spec E5). */
            released: false,
            /** What released the claim (`pagehide` or `freeze`) and the pair given up; read on `resume`. */
            releasedOn: null,
            releasedPair: null,
            /** The check after `resume` (spec E5); requests wait for it. */
            resumePromise: null,
            startPromise: null,
            lastReport: '',
            /** When a lease read last confirmed this holder's pair (`now()` ms). */
            verifiedAt: -Infinity,
            checkPromise: null,
            /** ST's version from `/version`; null until read. The allowlist is on only for tested ones. */
            stVersion: null,
        };

        /** ISO timestamp for the informational fields. */
        function timestamp() {
            return new Date(now()).toISOString();
        }

        /**
         * Reports `leaseState` when it changed (spec E11). Nothing is reported before the start decision.
         * `busy` (this page is generating, spec E8) isn't tracked yet: always false.
         * @returns {void}
         */
        function report() {
            if (page.phase === PHASE.deciding) return;
            const holder = page.phase === PHASE.holder;
            const payload = {
                state: holder ? 'holder' : 'parked',
                reason: holder ? null : page.reason,
                pageId: page.id,
                epoch: page.heldEpoch,
                busy: false,
            };
            const key = JSON.stringify(payload);
            if (key === page.lastReport) return;
            page.lastReport = key;
            post('leaseState', payload);
        }

        /**
         * Parks the page: from now on every server-data request is held (spec E7). A parked page becomes
         * holder again only through a fresh load.
         * @param {string} reason One of PARK_REASON.
         * @returns {{ status: 'parked', reason: string }} The outcome, for callers to return.
         */
        function park(reason) {
            page.phase = PHASE.parked;
            page.reason = reason;
            page.pair = null;
            page.verifiedAt = -Infinity;
            log('info', 'parked', { reason });
            report();
            return { status: 'parked', reason };
        }

        /**
         * Makes this load the holder (only from the start decision).
         * @param {{ holder: string, epoch: number }} pair The verified pair.
         * @returns {{ status: 'holder', pair: object }} The outcome.
         */
        function becomeHolder(pair) {
            page.phase = PHASE.holder;
            page.reason = null;
            page.pair = pair;
            page.heldEpoch = pair.epoch;
            page.verifiedAt = now();
            storageRemove(STORAGE_KEYS.autoClaimed);
            log('info', 'holder', { epoch: pair.epoch });
            report();
            return { status: 'holder', pair };
        }

        /** Reads the lease and the marker together. */
        function readBoth() {
            return Promise.all([readLease(), readMarker()]);
        }

        /**
         * The start decision, once per page load (spec E4). Requests wait for it (spec E6).
         * @returns {Promise<{ status: 'holder', pair: object } | { status: 'parked', reason: string } | { status: 'reload', pair: object }>}
         *     Holder, parked, or `reload` after an automatic claim (the glue reloads the page).
         */
        function start() {
            if (!page.startPromise) page.startPromise = runStart().catch((error) => failed('start', error));
            return page.startPromise;
        }

        /** A lease bug parks the page, never lets requests through. */
        function failed(step, error) {
            log('error', step + ' failed', { error: String(error && error.message) });
            page.claiming = false;
            return park(PARK_REASON.unreadable);
        }

        /** The start decision's steps. */
        async function runStart() {
            const [leaseRead, markerRead] = await readBoth();
            const decision = decideStart(leaseRead, markerRead, tabId);
            if (decision.action === 'park') return park(decision.reason);
            if (decision.action === 'bump') return bumpAtStart(decision.from);
            if (storageGet(STORAGE_KEYS.autoClaimed) !== null) {
                log('info', 'automatic claim already tried in this tab');
                return park(PARK_REASON.held);
            }
            if (!storageSet(STORAGE_KEYS.autoClaimed, '1')) {
                log('warn', 'automatic claim skipped: no sessionStorage');
                return park(PARK_REASON.held);
            }
            const outcome = await claim(CLAIM_KIND.automatic);
            // The mark only prevents a reload loop: a claim that ended without a reload clears it.
            if (outcome.status !== 'reload') storageRemove(STORAGE_KEYS.autoClaimed);
            return outcome;
        }

        /**
         * A refresh or a duplicated tab: always bump the epoch to this load's holder with `busy: false`,
         * then verify after the grace (pair rule, spec E2, E4). The newest load in the tab wins.
         * @param {{ holder: string, epoch: number }} from The pair in the lease (an earlier load of this tab).
         * @returns {Promise<{ status: 'holder', pair: object } | { status: 'parked', reason: string }>} The outcome.
         */
        async function bumpAtStart(from) {
            const outcome = await bumpEpoch(from, { holder: page.id, busy: false });
            if (outcome.status === 'parked') return park(outcome.reason);
            const pair = { holder: page.id, epoch: from.epoch + 1 };
            await sleep(GRACE_MS);
            const verified = decideVerify(await readLease(), pair, PARK_REASON.lost);
            if (!verified.ok) return park(verified.reason);
            return becomeHolder(pair);
        }

        /**
         * Claims the lease (spec E4 steps 1–6). On success the page stays parked (`claiming`, requests
         * held) and the caller aborts held chat saves and reloads.
         * @param {string} kind One of CLAIM_KIND.
         * @returns {Promise<{ status: 'reload', pair: object } | { status: 'parked', reason: string }>} The outcome.
         */
        async function claim(kind) {
            page.claiming = true;
            park(PARK_REASON.claiming);
            let outcome;
            try {
                outcome = await runClaim(kind);
            } catch (error) {
                return failed('claim', error);
            }
            if (outcome.status !== 'reload') page.claiming = false;
            return outcome;
        }

        /** The claim's steps. */
        async function runClaim(kind) {
            const [leaseRead, markerRead] = await readBoth();
            if (leaseRead.kind === 'unknownFormat' || markerRead.kind === 'unknownFormat') return park(PARK_REASON.unknownFormat);
            if (leaseRead.kind === 'unreadable') return park(PARK_REASON.unreadable);
            let base = leaseRead.kind === 'ok' ? leaseRead.lease : null;
            if (base && base.busy && !isReleased(leaseRead, markerRead)) {
                const waited = await waitForReply(base);
                if (waited.status === 'parked') return waited;
                base = waited.base;
                park(PARK_REASON.claiming);
            }
            const claimedAt = timestamp();
            const written = await enqueue(() => writeWithRetry(WRITE_KIND.claim, (read) => decideClaim(read, base, page.id, claimedAt)));
            if (written.status === 'parked') return park(written.reason);
            const pair = { holder: page.id, epoch: base ? base.epoch + 1 : 1 };
            await sleep(GRACE_MS);
            const verified = decideVerify(await readLease(), pair, PARK_REASON.lostRace);
            if (!verified.ok) return park(verified.reason);
            if (!storageSet(STORAGE_KEYS.reopen, kind)) log('warn', 'reopen flag not stored: the chat will not reopen');
            log('info', 'claimed, reloading', { kind, epoch: pair.epoch });
            return { status: 'reload', pair };
        }

        /**
         * Waits for the holder's reply to finish (spec E4 step 2): re-reads once per second for at most
         * 60 s. The one named polling exception: bounded, only during a claim.
         * @param {object} base The busy lease.
         * @returns {Promise<{ status: 'continue', base: object|null } | { status: 'parked', reason: string }>}
         *     Continue the claim on top of `base`, or parked.
         */
        async function waitForReply(base) {
            park(PARK_REASON.waitingForReply);
            const basePair = { holder: base.holder, epoch: base.epoch };
            const startedAt = now();
            let latest = base;
            while (now() - startedAt < BUSY_WAIT_MAX_MS) {
                await sleep(BUSY_WAIT_INTERVAL_MS);
                const [leaseRead, markerRead] = await readBoth();
                const step = decideWaitStep(leaseRead, markerRead, basePair);
                if (step.action === 'park') return park(step.reason);
                if (step.action === 'continue') return { status: 'continue', base: step.base };
                if (step.base) latest = step.base;
            }
            log('warn', 'reply wait ended at the limit', { seconds: BUSY_WAIT_MAX_MS / 1000 });
            return { status: 'continue', base: latest };
        }

        /**
         * Use here (spec E4, E11): claims if parked and not already claiming. Never with an unknown
         * format (the page offers no Use here then).
         * @returns {Promise<{ status: 'reload', pair: object } | { status: 'parked', reason: string } | { status: 'ignored' }>}
         *     The outcome.
         */
        function useHere() {
            const noUseHere = page.reason === PARK_REASON.unknownFormat || page.reason === PARK_REASON.reloadPending;
            if (page.phase !== PHASE.parked || page.claiming || page.released || noUseHere) {
                return Promise.resolve({ status: 'ignored' });
            }
            return claim(CLAIM_KIND.useHere);
        }

        /**
         * Release on `pagehide` or `freeze` (spec E5): a holder writes the marker naming its exact pair,
         * with `keepalive`, and holds everything from then on. Never touches the lease. Reports nothing:
         * the page is leaving, entering the back/forward cache, or being frozen (and maybe discarded). The
         * request is sent before the first `await`, so it goes out even if the page runs no further task.
         * @param {'pagehide'|'freeze'} [cause] What released the claim; a `freeze` is checked on `resume`.
         * @returns {Promise<boolean>} True when ST accepted the marker; false when not holder or it failed.
         */
        function release(cause = 'pagehide') {
            if (page.phase !== PHASE.holder) return Promise.resolve(false);
            const marker = markerFor(page.pair, timestamp());
            page.releasedPair = page.pair;
            page.releasedOn = cause;
            page.phase = PHASE.parked;
            page.reason = PARK_REASON.held;
            page.pair = null;
            page.released = true;
            log('info', 'releasing', { epoch: marker.epoch });
            return uploadFile(RELEASE_FILE, marker, { keepalive: true });
        }

        /**
         * The reload after a claim didn't happen (e.g. ST's `beforeunload` cancelled it, spec E7). The page
         * stays parked, never stuck in `claiming`: it reports `reloadPending`, whose control reloads from a
         * click. No new claim: the fresh load decides (spec E4).
         * @returns {void}
         */
        function reloadPending() {
            page.claiming = false;
            log('warn', 'reload did not happen');
            park(PARK_REASON.reloadPending);
        }

        /**
         * `pageshow` from the back/forward cache (spec E5). A page that released its claim parks at once
         * and must reload; the fresh load decides again.
         * @returns {{ reload: boolean }} Whether the glue reloads the page.
         */
        function restoredFromCache() {
            if (!page.released) return { reload: false };
            log('info', 'restored from the back/forward cache after releasing');
            park(PARK_REASON.held);
            return { reload: true };
        }

        /**
         * `resume` after a `freeze` (spec E5): the same check as the app's foreground holder path. A page
         * that released on `freeze` re-reads the lease and the marker; if the lease still holds its exact
         * pair (no other page claimed), it bumps the epoch (invalidating its own marker), verifies after
         * the grace (pair rule) and is holder again, without a reload. Pair changed → `lost`; unreadable →
         * `unreadable`. Requests wait for the check (gate). Anything else (not released, or released on
         * `pagehide`) is ignored: the back/forward cache reloads on `pageshow`.
         * @returns {Promise<{ status: string }>} holder, parked or ignored.
         */
        function resumeAfterFreeze() {
            if (page.resumePromise) return page.resumePromise;
            if (!page.released || page.releasedOn !== 'freeze') return Promise.resolve({ status: 'ignored' });
            const pair = page.releasedPair;
            page.released = false;
            page.releasedOn = null;
            page.releasedPair = null;
            page.resumePromise = runResume(pair)
                .catch((error) => failed('resume', error))
                .finally(() => { page.resumePromise = null; });
            return page.resumePromise;
        }

        /** The resume check's steps (spec E5): verify the pair, bump, grace, verify again. */
        async function runResume(pair) {
            const [leaseRead, markerRead] = await readBoth();
            if (markerRead.kind === 'unknownFormat') return park(PARK_REASON.unknownFormat);
            const verified = decideVerify(leaseRead, pair, PARK_REASON.lost);
            if (!verified.ok) return park(verified.reason);
            const outcome = await bumpEpoch(pair, {});
            if (outcome.status === 'parked') return park(outcome.reason);
            const next = { holder: pair.holder, epoch: pair.epoch + 1 };
            await sleep(GRACE_MS);
            const again = decideVerify(await readLease(), next, PARK_REASON.lost);
            if (!again.ok) return park(again.reason);
            log('info', 'resumed after freeze', { epoch: next.epoch });
            return becomeHolder(next);
        }

        // ---- Requests and the app's hooks (spec E6, E11) ---------------------------------------

        /** Records ST's version (spec E12); the allowlist is on only for a tested version. */
        function setStVersion(version) {
            page.stVersion = typeof version === 'string' ? version : null;
            if (!TESTED_ST_VERSIONS.includes(page.stVersion)) log('warn', 'untested SillyTavern version: allowlist off');
        }

        /** Whether the allowlist applies now. */
        function allowlistOn() {
            return TESTED_ST_VERSIONS.includes(page.stVersion);
        }

        /**
         * The wrapper's decision for a request right now, without waiting (spec E6).
         * @param {string} path Normalized pathname.
         * @param {string} method Upper-case method.
         * @returns {'wait'|'hold'|'send'|'check'} See decideRequest.
         */
        function decideNow(path, method) {
            return decideRequest({
                phase: page.phase,
                method,
                allowlisted: allowlistOn() && isAllowlisted(path),
                readAgeMs: now() - page.verifiedAt,
            });
        }

        /**
         * Decides a server-data request (spec E6): waits for the start decision, then sends, holds, or
         * re-reads the lease first. A lease bug holds, never sends.
         * @param {string} path Normalized pathname.
         * @param {string} method Upper-case method.
         * @returns {Promise<'send'|'hold'>} The verdict.
         */
        async function gate(path, method) {
            try {
                await start();
                if (page.resumePromise) await page.resumePromise;
                const verdict = decideNow(path, method);
                if (verdict === 'send' || verdict === 'hold') return verdict;
                return (await checkHolder()) ? 'send' : 'hold';
            } catch (error) {
                failed('request gate', error);
                return 'hold';
            }
        }

        /**
         * The holder's lease check before a request (spec E6). Concurrent checks share one read. A
         * pending `busy: false` is written with it (spec E3). Fails closed: unreadable parks.
         * @returns {Promise<boolean>} True when still holder.
         */
        function checkHolder() {
            if (page.phase !== PHASE.holder) return Promise.resolve(false);
            if (!page.checkPromise) {
                page.checkPromise = runCheck(true)
                    .catch((error) => { failed('lease check', error); return false; })
                    .finally(() => { page.checkPromise = null; });
            }
            return page.checkPromise;
        }

        /**
         * One lease check.
         * @param {boolean} mayRepeat Re-run once if the page's own pair changed meanwhile (its epoch bump).
         * @returns {Promise<boolean>} True when still holder.
         */
        async function runCheck(mayRepeat) {
            const pair = page.pair;
            if (state.pendingBusyClear) {
                const outcome = await updateLease(pair, {});
                if (outcome.status === 'parked') {
                    park(outcome.reason);
                    return false;
                }
                if (outcome.status !== 'failed' && holdsPair(page.pair, pair)) {
                    page.verifiedAt = now();
                    return true;
                }
            }
            // Through the write queue, so it never reads a write (e.g. a foreground bump) whose outcome
            // the page hasn't processed yet.
            const read = await enqueue(() => readLease());
            if (page.phase !== PHASE.holder) return false;
            if (!holdsPair(page.pair, pair)) return mayRepeat ? runCheck(false) : false;
            const verified = decideVerify(read, pair, PARK_REASON.lost);
            if (!verified.ok) {
                park(verified.reason);
                return false;
            }
            page.verifiedAt = now();
            return true;
        }

        /**
         * The app returned to the foreground (spec E11, app A5). Holder: confirm the lease, bump the epoch
         * if its release marker matches, else park. Parked: claim only if the lease is released or gone.
         * @returns {Promise<{ status: string }>} holder, parked, reload (after a claim) or ignored.
         */
        async function onForeground() {
            try {
                if (page.phase === PHASE.holder) return await foregroundHolder();
                const canClaim = page.phase === PHASE.parked && !page.claiming && !page.released
                    && page.reason !== PARK_REASON.unknownFormat && page.reason !== PARK_REASON.reloadPending;
                return canClaim ? await foregroundParked() : { status: 'ignored' };
            } catch (error) {
                return failed('foreground', error);
            }
        }

        /** Whether the page is still holder of exactly this pair (after an await). */
        function stillHolds(pair) {
            return page.phase === PHASE.holder && holdsPair(page.pair, pair);
        }

        /** The outcome for a holder step that found the page no longer holder of its pair after an await. */
        function notHolderAnyMore() {
            return { status: page.phase, reason: page.reason };
        }

        /**
         * onForeground for a holder: invalidates its own release marker with an epoch bump. Stops as soon as
         * the page is no longer holder of the pair it started with (a check parked it meanwhile).
         */
        async function foregroundHolder() {
            const pair = page.pair;
            const [leaseRead, markerRead] = await readBoth();
            if (!stillHolds(pair)) return notHolderAnyMore();
            if (markerRead.kind === 'unknownFormat') return park(PARK_REASON.unknownFormat);
            const verified = decideVerify(leaseRead, pair, PARK_REASON.lost);
            if (!verified.ok) return park(verified.reason);
            if (!isReleased(leaseRead, markerRead)) {
                page.verifiedAt = now();
                return { status: 'holder', pair };
            }
            const outcome = await bumpEpoch(pair, {});
            if (!stillHolds(pair)) return notHolderAnyMore();
            if (outcome.status === 'parked') return park(outcome.reason);
            const next = { holder: pair.holder, epoch: pair.epoch + 1 };
            page.pair = next;
            page.heldEpoch = next.epoch;
            report();
            await sleep(GRACE_MS);
            if (!stillHolds(next)) return notHolderAnyMore();
            const read = await readLease();
            if (!stillHolds(next)) return notHolderAnyMore();
            const again = decideVerify(read, next, PARK_REASON.lost);
            if (!again.ok) return park(again.reason);
            page.verifiedAt = now();
            log('info', 'release marker invalidated', { epoch: next.epoch });
            return { status: 'holder', pair: next };
        }

        /** onForeground for a parked page: claims only a released or missing lease (R43). */
        async function foregroundParked() {
            const [leaseRead, markerRead] = await readBoth();
            if (leaseRead.kind === 'unknownFormat' || markerRead.kind === 'unknownFormat') return park(PARK_REASON.unknownFormat);
            if (leaseRead.kind === 'missing' || isReleased(leaseRead, markerRead)) return claim(CLAIM_KIND.foreground);
            return { status: 'parked', reason: page.reason };
        }

        return {
            readLease,
            readMarker,
            updateLease,
            bumpEpoch,
            setStVersion,
            decideNow,
            gate,
            checkHolder,
            onForeground,
            /** Whether a failed `busy: false` is still waiting to be written. */
            hasPendingBusyClear: () => state.pendingBusyClear,
            start,
            useHere,
            release,
            restoredFromCache,
            resumeAfterFreeze,
            reloadPending,
            park,
            /** This load's holder id, `<tab id>.<load id>` (`leaseState.pageId`). */
            pageId: () => page.id,
            /** ST's version as recorded, or null. */
            stVersion: () => page.stVersion,
            /** A snapshot of this page's state. */
            status: () => ({
                phase: page.phase,
                reason: page.reason,
                pair: page.pair ? Object.assign({}, page.pair) : null,
                epoch: page.heldEpoch,
                claiming: page.claiming,
            }),
        };
    }

    const exported = {
        LEASE_VERSION,
        LEASE_FORMAT,
        LEASE_FILE,
        RELEASE_FILE,
        UPLOAD_PATH,
        USER_FILES_PATH,
        WRITE_ATTEMPTS,
        RETRY_MIN_MS,
        RETRY_MAX_MS,
        GRACE_MS,
        BUSY_WAIT_INTERVAL_MS,
        BUSY_WAIT_MAX_MS,
        STORAGE_KEYS,
        parseLease,
        parseMarker,
        holdsPair,
        isReleased,
        decideUpdate,
        decideBump,
        decideStart,
        decideWaitStep,
        decideClaim,
        decideVerify,
        decideRequest,
        requestPath,
        requestMethod,
        isServerData,
        isAllowlisted,
        isChatSave,
        isCsrfTokenRequest,
        isLoginPage,
        createHeldRegistry,
        holdFetch,
        buildLeaseInfo,
        createCsrfClient,
        makePost,
        createSessionLease,
        install,
        TESTED_ST_VERSIONS,
        READ_ALLOWLIST,
        CHAT_SAVE_PATHS,
        READ_WINDOW_MS,
        CSRF_ORDER_MAX_WAIT_MS,
        RELOAD_FALLBACK_MS,
    };

    // ---- Browser install (thin: wiring only) ---------------------------------------------------

    /**
     * The lease's own CSRF token (spec E6): fetched once through the original fetch, kept in memory
     * only, never logged or posted. Lease POSTs carry it; a 403 fetches it again once and resends.
     * @param {object} deps
     * @param {Function} deps.fetch The original fetch.
     * @param {Function} deps.setTimeout Timer for the bounded ordering wait.
     * @param {Function} deps.clearTimeout Clears it.
     * @param {Function} deps.log Logger.
     * @returns {{ leaseFetch: Function, afterOwnToken: Function }} The lease's fetch, and the wait ST's
     *     own `/csrf-token` request does before it is sent.
     */
    function createCsrfClient({ fetch, setTimeout, clearTimeout, log }) {
        let token = null;
        let pending = fetchToken();

        async function fetchToken() {
            try {
                const response = await fetch(CSRF_TOKEN_PATH, { cache: 'no-store' });
                const data = response.ok ? await response.json() : null;
                token = data && typeof data.token === 'string' ? data.token : null;
            } catch (error) {
                token = null;
            }
            if (token === null) log('warn', 'CSRF token not available; lease writes will fail closed');
        }

        /** ST's `/csrf-token` waits for the lease's fetch, at most CSRF_ORDER_MAX_WAIT_MS (never held). */
        function afterOwnToken() {
            return new Promise((resolve) => {
                const timer = setTimeout(resolve, CSRF_ORDER_MAX_WAIT_MS);
                pending.then(() => { clearTimeout(timer); resolve(); });
            });
        }

        function withToken(init) {
            const headers = new Headers(init.headers);
            if (token !== null) headers.set('X-CSRF-Token', token);
            return Object.assign({}, init, { headers });
        }

        async function leaseFetch(url, init = {}) {
            if (String(init.method || 'GET').toUpperCase() === 'GET') return fetch(url, init);
            if (token === null) await pending;
            const response = await fetch(url, withToken(init));
            if (response.status !== 403) return response;
            log('warn', 'lease write refused (403): fetching the CSRF token again');
            pending = fetchToken();
            await pending;
            return fetch(url, withToken(init));
        }

        return { leaseFetch, afterOwnToken };
    }

    /** Reports to the app's listener when present, else as a `tt-lease` event for index.js (spec E11). */
    function makePost(win) {
        return function post(type, payload) {
            const port = win[APP_LISTENER];
            if (port && typeof port.postMessage === 'function') {
                port.postMessage(JSON.stringify(Object.assign({ v: MESSAGE_VERSION, type }, payload)));
                return;
            }
            win.dispatchEvent(new win.CustomEvent(DESKTOP_EVENT, { detail: Object.assign({ type }, payload) }));
        };
    }

    /** Console logger with the lease's prefix. Callers pass events, reasons, paths and counts only. */
    function makeLog(console) {
        return function log(level, message, details) {
            const write = console[level] || console.log;
            write.call(console, LOG_PREFIX, message, details || '');
        };
    }

    /** sessionStorage through a getter that may throw (blocked site data); the core catches errors. */
    function pageStorage(win) {
        return {
            getItem: (key) => win.sessionStorage.getItem(key),
            setItem: (key, value) => win.sessionStorage.setItem(key, value),
            removeItem: (key) => win.sessionStorage.removeItem(key),
        };
    }

    /** Whether this is the main frame (a cross-origin parent throws: not main). */
    function isMainFrame(win) {
        try {
            return win.top === win;
        } catch (error) {
            return false;
        }
    }

    /** Wraps fetch (spec E6). The lease's own I/O keeps the original fetch. */
    function wrapFetch(win, ctx) {
        win.fetch = function fetch(input, init) {
            const method = requestMethod(input, init);
            const path = requestPath(input);
            if (isCsrfTokenRequest(path, method)) return ctx.csrf.afterOwnToken().then(() => ctx.originalFetch(input, init));
            if (!isServerData(path, method)) return ctx.originalFetch(input, init);
            const signal = requestSignal(input, init);
            const hold = () => holdFetch(ctx.held, path, signal, ctx.makeAbortError);
            return ctx.lease.gate(path, method).then(
                (verdict) => (verdict === 'send' ? ctx.originalFetch(input, init) : hold()),
                hold,
            );
        };
    }

    /** Wraps XMLHttpRequest (spec E6): held XHRs are never sent and never complete. */
    function wrapXhr(win, ctx) {
        const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
        if (!proto) return;
        const targets = new WeakMap();
        const open = proto.open;
        const send = proto.send;
        proto.open = function (method, url, ...rest) {
            targets.set(this, { method: String(method).toUpperCase(), path: requestPath(String(url)), async: rest[0] !== false });
            return open.call(this, method, url, ...rest);
        };
        proto.send = function (...args) {
            const target = targets.get(this);
            if (!target || !isServerData(target.path, target.method)) return send.apply(this, args);
            const xhr = this;
            const hold = () => { ctx.held.add(target.path, () => xhr.abort()); };
            if (!target.async) {
                // A synchronous XHR can't wait: sent only if no lease read is needed, else held.
                if (ctx.lease.decideNow(target.path, target.method) === 'send') return send.apply(this, args);
                return hold();
            }
            ctx.lease.gate(target.path, target.method).then((verdict) => {
                if (verdict !== 'send') return hold();
                try {
                    send.apply(xhr, args);
                } catch (error) {
                    ctx.log('warn', 'XHR not sent after the lease check', { path: target.path });
                }
                return undefined;
            }, hold);
            return undefined;
        };
    }

    /** sendBeacon can't wait for a lease check: refused (false) unless holder (spec E6). */
    function wrapBeacon(win, ctx) {
        const nav = win.navigator;
        if (!nav || typeof nav.sendBeacon !== 'function') return;
        const beacon = nav.sendBeacon;
        nav.sendBeacon = function sendBeacon(url, data) {
            if (ctx.lease.status().phase !== PHASE.holder) return false;
            return beacon.call(nav, url, data);
        };
    }

    /** Reads ST's version for the allowlist and `leaseInfo` (spec E12). */
    async function readStVersion(originalFetch) {
        try {
            const response = await originalFetch(VERSION_PATH, { cache: 'no-store' });
            const data = response.ok ? await response.json() : null;
            return data && typeof data.pkgVersion === 'string' ? data.pkgVersion : null;
        } catch (error) {
            return null;
        }
    }

    /**
     * Reloads the page (spec E7): aborts held chat saves, waits one task so ST's save handlers clear
     * `isChatSaving` before its `beforeunload` runs, then reloads. A page still alive RELOAD_FALLBACK_MS
     * later (the reload was cancelled) parks as `reloadPending`, never staying in `claiming`.
     */
    function reloadAfterAborts(win, lease, held, log) {
        log('info', 'reloading', { abortedChatSaves: held.abortChatSaves() });
        win.setTimeout(() => {
            win.location.reload();
            win.setTimeout(() => lease.reloadPending(), RELOAD_FALLBACK_MS);
        }, 0);
    }

    /**
     * Desktop release (spec E5): on `pagehide`, and on the Page Lifecycle `freeze` (a frozen tab may be
     * discarded, which fires no `pagehide`). On `resume` a page that released on `freeze` checks the lease
     * and holds again if no other page claimed; a back/forward-cache restore (`pageshow`) reloads. Not in
     * the app's page: the app releases from Kotlin.
     */
    function wireDesktopRelease(win, lease, reloadPage) {
        win.addEventListener('pagehide', () => { lease.release('pagehide'); });
        win.addEventListener('pageshow', (event) => {
            if (event.persisted && lease.restoredFromCache().reload) reloadPage();
        });
        const doc = win.document;
        if (!doc || typeof doc.addEventListener !== 'function') return;
        doc.addEventListener('freeze', () => { lease.release('freeze'); });
        doc.addEventListener('resume', () => { lease.resumeAfterFreeze(); });
    }

    /**
     * Runs the start decision, reads ST's version, then sends `leaseInfo` (again on every
     * `tt-extension-ready`) (spec E11, E12).
     */
    function startAndReport(win, lease, post, originalFetch, afterOutcome) {
        const version = readStVersion(originalFetch).then((stVersion) => { lease.setStVersion(stVersion); });
        const sendLeaseInfo = () => post('leaseInfo', buildLeaseInfo(lease.stVersion(), win.__ttExtension));
        Promise.all([lease.start().then(afterOutcome), version]).then(() => {
            sendLeaseInfo();
            win.addEventListener('tt-extension-ready', sendLeaseInfo);
        });
    }

    /** The lease for this page, its CSRF client and reports wired to the window. */
    function createPageLease(win, originalFetch, log) {
        const csrf = createCsrfClient({
            fetch: originalFetch,
            setTimeout: (fn, ms) => win.setTimeout(fn, ms),
            clearTimeout: (id) => win.clearTimeout(id),
            log,
        });
        const post = makePost(win);
        const lease = createSessionLease({
            fetch: csrf.leaseFetch,
            post: (type, payload) => post(type, type === 'leaseState'
                // `connected` (spec E10) isn't tracked yet: always false.
                ? Object.assign({}, payload, { connected: false, origin: win.location.origin })
                : payload),
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => win.setTimeout(resolve, ms)),
            storage: pageStorage(win),
            log,
        });
        return { lease, csrf, post };
    }

    /**
     * Installs the lease in a page: main frame only, never on ST's login page, once per page (a second
     * copy stands down completely). `window.__ttLease` is frozen and has no off switch (spec E11).
     * @param {Window} win The page's window.
     * @returns {boolean} True when installed now.
     */
    function install(win) {
        if (!isMainFrame(win) || isLoginPage(win.location.pathname)) return false;
        if (Object.prototype.hasOwnProperty.call(win, '__ttLease')) return false;
        const source = win.__ttLeaseSource === 'extension' ? 'extension' : 'app';
        const log = makeLog(win.console);
        const originalFetch = win.fetch.bind(win);
        const { lease, csrf, post } = createPageLease(win, originalFetch, log);
        const makeAbortError = () => new win.DOMException('TravelingTavern: request held while parked', 'AbortError');
        const held = createHeldRegistry(makeAbortError);
        const ctx = { lease, held, csrf, originalFetch, makeAbortError, log };
        wrapFetch(win, ctx);
        wrapXhr(win, ctx);
        wrapBeacon(win, ctx);

        const reloadPage = () => reloadAfterAborts(win, lease, held, log);
        const afterOutcome = (outcome) => {
            if (outcome && outcome.status === 'reload') reloadPage();
        };
        const api = Object.freeze({
            version: LEASE_VERSION,
            source,
            useHere: () => lease.useHere().then(afterOutcome),
            onForeground: () => lease.onForeground().then(afterOutcome),
        });
        Object.defineProperty(win, '__ttLease', { value: api, writable: false, configurable: false, enumerable: false });

        // The app releases from Kotlin (app spec A5).
        if (source === 'extension') wireDesktopRelease(win, lease, reloadPage);
        startAndReport(win, lease, post, originalFetch, afterOutcome);
        return true;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    } else if (typeof window !== 'undefined') {
        install(window);
    }
})();
