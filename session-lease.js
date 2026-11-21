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
    });

    /** Page phases. A page leaves `deciding` once; it becomes holder only through the start decision. */
    const PHASE = Object.freeze({ deciding: 'deciding', holder: 'holder', parked: 'parked' });

    /** What started a claim; stored in the reopen flag (spec E4, E10). */
    const CLAIM_KIND = Object.freeze({ automatic: 'automatic', useHere: 'useHere' });

    /** Claim grace: a write the old holder already sent lands before this page loads (spec E4). */
    const GRACE_MS = 1000;
    /** The claim's wait for `busy`: re-read once per second for at most 60 s (spec E4, the one polling exception). */
    const BUSY_WAIT_INTERVAL_MS = 1000;
    const BUSY_WAIT_MAX_MS = 60000;

    /** sessionStorage keys (per tab, per origin). */
    const STORAGE_KEYS = Object.freeze({
        /** This tab's page id, the lease's `holder` (a refresh keeps it). */
        pageId: 'tt-lease-page-id',
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
     * Decides an epoch bump to (own id, epoch + 1) against the lease just re-read (spec E2, E3). A lease
     * that already holds the target pair means an earlier attempt landed despite its error answer.
     * @param {{ kind: string, lease?: object }} read Result of reading the lease.
     * @param {{ holder: string, epoch: number }} from The pair the bump starts from.
     * @param {{ busy?: boolean }} changes Extra fields to set with the bump.
     * @param {string} claimedAt Informational timestamp.
     * @returns {{ action: 'write', lease: object } | { action: 'skip', lease: object } | { action: 'park'|'retry', reason: string }}
     *     What to do.
     */
    function decideBump(read, from, changes, claimedAt) {
        const blocked = blockedByRead(read);
        if (blocked) return blocked;
        const lease = read.lease;
        if (holdsPair(lease, { holder: from.holder, epoch: from.epoch + 1 })) return { action: 'skip', lease };
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
     * @param {string} pageId This page's id.
     * @returns {{ action: 'bump', from: { holder: string, epoch: number } } | { action: 'claim' } | { action: 'park', reason: string }}
     *     Own id → bump the epoch; no lease or released → automatic claim; otherwise park.
     */
    function decideStart(leaseRead, markerRead, pageId) {
        if (leaseRead.kind === 'unknownFormat' || markerRead.kind === 'unknownFormat') {
            return { action: 'park', reason: PARK_REASON.unknownFormat };
        }
        if (leaseRead.kind === 'unreadable') return { action: 'park', reason: PARK_REASON.unreadable };
        if (leaseRead.kind === 'missing') return { action: 'claim' };
        if (leaseRead.lease.holder === pageId) return { action: 'bump', from: { holder: pageId, epoch: leaseRead.lease.epoch } };
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
     * A random page id. `crypto.getRandomValues` works over plain http (unlike `crypto.subtle` and
     * `randomUUID`); Math.random is the fallback. No personal data.
     * @returns {string} Page id.
     */
    function makePageId() {
        const bytes = new Uint8Array(12);
        const source = typeof crypto !== 'undefined' && crypto && typeof crypto.getRandomValues === 'function' ? crypto : null;
        if (source) source.getRandomValues(bytes);
        else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
        return 'p-' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
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
         * Bumps the epoch to (own id, epoch + 1), from a pair this page holds or names (spec E2, E4, E5).
         * The caller verifies the new pair afterwards (pair rule).
         * @param {{ holder: string, epoch: number }} from The pair to bump from.
         * @param {{ busy?: boolean }} [changes] Extra fields, e.g. `busy: false` at a fresh load.
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
         * This tab's page id from sessionStorage, or a new one (kept when storage works).
         * @returns {string} Page id.
         */
        function loadPageId() {
            const stored = storageGet(STORAGE_KEYS.pageId);
            if (isText(stored)) return stored;
            const id = makePageId();
            if (!storageSet(STORAGE_KEYS.pageId, id)) log('warn', 'no sessionStorage: page id kept for this load only');
            return id;
        }

        const page = {
            id: loadPageId(),
            phase: PHASE.deciding,
            reason: null,
            /** The pair this page holds now (holder only). */
            pair: null,
            /** The epoch held in this load, kept after parking (`leaseState.epoch`). */
            heldEpoch: null,
            claiming: false,
            /** Set by release(): the claim was given up as the page left (back/forward cache). */
            released: false,
            startPromise: null,
            lastReport: '',
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
            const decision = decideStart(leaseRead, markerRead, page.id);
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
            return claim(CLAIM_KIND.automatic);
        }

        /**
         * A refresh or a duplicated tab: always bump the epoch with `busy: false`, then verify after the
         * grace (pair rule, spec E2, E4). The newest load with this id wins.
         * @param {{ holder: string, epoch: number }} from The pair in the lease.
         * @returns {Promise<{ status: 'holder', pair: object } | { status: 'parked', reason: string }>} The outcome.
         */
        async function bumpAtStart(from) {
            const outcome = await bumpEpoch(from, { busy: false });
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
            if (page.phase !== PHASE.parked || page.claiming || page.released || page.reason === PARK_REASON.unknownFormat) {
                return Promise.resolve({ status: 'ignored' });
            }
            return claim(CLAIM_KIND.useHere);
        }

        /**
         * Release on `pagehide` (spec E5): a holder writes the marker naming its exact pair, with
         * `keepalive`, and holds everything from then on. Never touches the lease. Reports nothing: the
         * page is leaving (or entering the back/forward cache).
         * @returns {Promise<boolean>} True when ST accepted the marker; false when not holder or it failed.
         */
        function release() {
            if (page.phase !== PHASE.holder) return Promise.resolve(false);
            const marker = markerFor(page.pair, timestamp());
            page.phase = PHASE.parked;
            page.reason = PARK_REASON.held;
            page.pair = null;
            page.released = true;
            log('info', 'releasing', { epoch: marker.epoch });
            return uploadFile(RELEASE_FILE, marker, { keepalive: true });
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

        return {
            readLease,
            readMarker,
            updateLease,
            bumpEpoch,
            /** Whether a failed `busy: false` is still waiting to be written. */
            hasPendingBusyClear: () => state.pendingBusyClear,
            start,
            useHere,
            release,
            restoredFromCache,
            park,
            /** This page's id (the lease's `holder`). */
            pageId: () => page.id,
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
        createSessionLease,
    };

    // The browser install (request wrapper, window.__ttLease: spec E6, E11) is not built yet.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    }
})();
