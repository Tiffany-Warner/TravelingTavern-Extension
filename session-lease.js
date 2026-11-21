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

    /** Why a page parks (spec E11 `leaseState.reason`), for the reasons decided here. */
    const PARK_REASON = Object.freeze({
        lost: 'lost',
        lostRace: 'lostRace',
        unreadable: 'unreadable',
        unknownFormat: 'unknownFormat',
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
     * @param {() => number} deps.now Milliseconds since the epoch (informational timestamps only).
     * @param {(ms: number) => Promise<void>} deps.sleep Bounded one-off delay.
     * @param {(level: string, message: string, details?: object) => void} deps.log Logger: events,
     *     reasons, paths and counts only.
     * @returns {object} The lease's reads and writes.
     */
    function createSessionLease({ fetch, now, sleep, log }) {
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
         * @returns {Promise<boolean>} True when ST answered 2xx.
         */
        async function uploadFile(name, value) {
            try {
                const response = await fetch(UPLOAD_PATH, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: uploadBody(name, value),
                    cache: 'no-store',
                });
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

        return {
            readLease,
            readMarker,
            updateLease,
            bumpEpoch,
            /** Whether a failed `busy: false` is still waiting to be written. */
            hasPendingBusyClear: () => state.pendingBusyClear,
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
        parseLease,
        parseMarker,
        holdsPair,
        isReleased,
        decideUpdate,
        decideBump,
        createSessionLease,
    };

    // The browser install (wrapper, window.__ttLease) arrives with slice 3 (spec E6, E11).
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    }
})();
