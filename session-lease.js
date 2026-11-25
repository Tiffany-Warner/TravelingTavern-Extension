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
        /** Take over anyway: a claim written over whatever the file holds (spec E4). */
        force: 'force',
    });

    /** Why a page is parked (spec E11 `leaseState.reason`). */
    const PARK_REASON = Object.freeze({
        held: 'held',
        lost: 'lost',
        claiming: 'claiming',
        waitingForReply: 'waitingForReply',
        lostRace: 'lostRace',
        /** A lease file couldn't be fetched: network error or a status other than 2xx / 404. */
        unreadable: 'unreadable',
        /** A lease file answered 2xx but isn't valid JSON or has a wrong field. */
        damaged: 'damaged',
        /** Lease writes kept failing while reads worked, or a lease-code error. */
        error: 'error',
        unknownFormat: 'unknownFormat',
        reloadPending: 'reloadPending',
    });

    /** The ways out a parked page offers (spec E9, E11 `leaseState.actions`). */
    const ACTION = Object.freeze({
        useHere: 'useHere',
        refresh: 'refresh',
        takeOverAnyway: 'takeOverAnyway',
        turnOffProtection: 'turnOffProtection',
        turnProtectionOn: 'turnProtectionOn',
    });

    /**
     * `leaseState.actions` by reason, in display order with the primary first (spec E9, E11). Every
     * error state offers a way back in (Refresh) and a way to go ahead at the user's own risk.
     */
    const ACTIONS_BY_REASON = Object.freeze({
        held: Object.freeze([ACTION.useHere]),
        lost: Object.freeze([ACTION.useHere]),
        lostRace: Object.freeze([ACTION.useHere]),
        unreadable: Object.freeze([ACTION.useHere, ACTION.refresh, ACTION.takeOverAnyway, ACTION.turnOffProtection]),
        damaged: Object.freeze([ACTION.takeOverAnyway, ACTION.refresh, ACTION.turnOffProtection]),
        error: Object.freeze([ACTION.refresh, ACTION.takeOverAnyway, ACTION.turnOffProtection]),
        unknownFormat: Object.freeze([ACTION.refresh, ACTION.takeOverAnyway, ACTION.turnOffProtection]),
        reloadPending: Object.freeze([ACTION.refresh]),
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
    /** "Take over anyway" is offered once the claim has waited this long for `busy` (spec E4, E9). */
    const FORCE_OFFER_AFTER_MS = 10000;
    /** After the last reply ends, `busy` waits at most this long for ST's chat save (spec E8). */
    const SAVE_WAIT_MAX_MS = 3000;

    /** A holder trusts a lease read this old for GETs and allowlisted reads (spec E6). */
    const READ_WINDOW_MS = 2000;
    /** ST's own `/csrf-token` waits at most this long for the lease's token fetch (spec E6). */
    const CSRF_ORDER_MAX_WAIT_MS = 2000;
    /**
     * Every lease read and write (its own fetch, body included) is aborted after this long and counts as
     * "can't reach ST" (spec E2, E3), so no state waits on a server that never answers.
     */
    const LEASE_FETCH_TIMEOUT_MS = 10000;
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

    /**
     * Generation endpoints (spec E8, E15): sent only after `busy: true` is confirmed. Confirmed in ST
     * 1.19.0 and 1.19.1. `*` is one path segment, so a new backend still sets `busy`.
     */
    const GENERATION_PATHS = Object.freeze(['/api/backends/*/generate', '/api/novelai/generate', '/api/horde/generate-text']);

    /** ST's `onlineStatus` while no model is connected (spec E10). */
    const NO_CONNECTION = 'no_connection';
    /**
     * ST's connect button per `main_api` (spec E10): the buttons ST's own auto-connect presses
     * (`RA_autoconnect`). Confirmed in ST 1.19.0 and 1.19.1. Other APIs (e.g. `koboldhorde`) have none.
     */
    const CONNECT_BUTTONS = Object.freeze({
        kobold: '#api_button',
        novel: '#api_button_novel',
        textgenerationwebui: '#api_button_textgenerationwebui',
        openai: '#api_button_openai',
    });
    /**
     * The class ST's `startStatusLoading()` adds to every connect button while an attempt runs, and
     * `stopStatusLoading()` removes (spec E10, E15).
     */
    const CONNECTING_CLASS = 'disabled';
    /** After pressing connect, the page waits at most this long for ST's attempt (spec E10). */
    const CONNECT_WAIT_MS = 10000;

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
        /** Protection is off in this tab (spec E4 → Turn off protection); removed by Turn protection back on. */
        off: 'tt-lease-off',
    });

    /**
     * Prefix put on `window.name` when sessionStorage is blocked: protection is off for the next load
     * only. That load removes it and restores the name. ST doesn't use `window.name` (spec E15).
     */
    const OFF_ONCE_NAME_PREFIX = 'tt-lease-off-once:';

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
        return { action: 'retry', reason: unreadableReason(read) };
    }

    /**
     * The park reason for an unreadable read (spec E9): `damaged` when ST answered 2xx with a file that
     * isn't valid, `unreadable` when the file couldn't be fetched.
     * @param {{ damaged?: boolean }} read An unreadable read.
     * @returns {string} PARK_REASON.damaged or PARK_REASON.unreadable.
     */
    function unreadableReason(read) {
        return read.damaged === true ? PARK_REASON.damaged : PARK_REASON.unreadable;
    }

    /**
     * The ways out a page offers now (`leaseState.actions`, spec E9, E11), primary first.
     * @param {string|null} reason The park reason; null for a holder.
     * @param {number} waitedMs How long the claim has waited for `busy` (`waitingForReply` only).
     * @returns {string[]} ACTION values. Take over anyway joins `waitingForReply` after
     *     FORCE_OFFER_AFTER_MS; a holder, `claiming` and unknown reasons offer nothing.
     */
    function actionsFor(reason, waitedMs) {
        if (reason === PARK_REASON.waitingForReply) return waitedMs >= FORCE_OFFER_AFTER_MS ? [ACTION.takeOverAnyway] : [];
        if (typeof reason !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS_BY_REASON, reason)) return [];
        return ACTIONS_BY_REASON[reason].slice();
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
        if (leaseRead.kind === 'unreadable') return { action: 'park', reason: unreadableReason(leaseRead) };
        if (leaseRead.kind === 'missing') return { action: 'claim' };
        const lease = leaseRead.lease;
        if (tabOf(lease.holder) === tabId) return { action: 'bump', from: { holder: lease.holder, epoch: lease.epoch } };
        if (markerRead.kind === 'unreadable') return { action: 'park', reason: unreadableReason(markerRead) };
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
        if (read.kind === 'unreadable') return { action: 'retry', reason: unreadableReason(read) };
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
     * What a forced claim (Take over anyway, spec E4) builds on, from the lease read when it starts:
     * only a readable lease of a known format gives its epoch and `active`. Nothing else is needed.
     * @param {{ kind: string, lease?: object }} read Result of reading the lease.
     * @returns {{ epoch: number, active: object|null }} The epoch to write and the chat to carry over.
     */
    function forceBase(read) {
        if (read.kind !== 'ok') return { epoch: 1, active: null };
        return { epoch: read.lease.epoch + 1, active: read.lease.active };
    }

    /**
     * Decides a forced claim's write (Take over anyway, spec E4) against the lease just re-read: always
     * written over whatever the file holds (damaged, unknown format, busy, another holder), unless an
     * earlier attempt already landed.
     * @param {{ kind: string, lease?: object }} read Result of re-reading the lease.
     * @param {{ holder: string, epoch: number }} pair The forced pair (a new holder id).
     * @param {string} claimedAt Informational timestamp.
     * @param {object|null} active The chat to carry over (forceBase).
     * @returns {{ action: 'write', lease: object } | { action: 'skip', lease: object }} What to do.
     */
    function decideForceClaim(read, pair, claimedAt, active) {
        if (read.kind === 'ok' && holdsPair(read.lease, pair)) return { action: 'skip', lease: read.lease };
        return { action: 'write', lease: claimLease(pair.holder, pair.epoch, claimedAt, active) };
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
        if (read.kind === 'unreadable') return { ok: false, reason: unreadableReason(read) };
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

    /** Whether a request is a generation (spec E8): a POST to a generation endpoint. */
    function isGeneration(path, method) {
        return method === 'POST' && GENERATION_PATHS.some((pattern) => matchesEndpoint(path, pattern));
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
     * @returns {{ status: 'parked', reason: string } | { status: 'failed' }} Claims (forced too) and bumps
     *     park as `error` (reads worked, writes didn't); the holder's `busy` / `active` updates fail and
     *     the page stays holder.
     */
    function exhaustedOutcome(kind) {
        if (kind === WRITE_KIND.claim || kind === WRITE_KIND.bump || kind === WRITE_KIND.force) {
            return { status: 'parked', reason: PARK_REASON.error };
        }
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

    // ---- SillyTavern's context: reopen and reconnect (spec E4, E10) ------------------------------

    /**
     * The open chat as the lease's `active` (spec E4), from a fresh `SillyTavern.getContext()`.
     * @param {object|null} context ST's context (`groupId`, `characterId`, `characters`, `chatId`).
     * @returns {object|null} `{ avatar, chatFile }`, `{ groupId, chatFile }`, or null without a chat.
     */
    function activeFromContext(context) {
        if (!isObject(context) || !isText(context.chatId)) return null;
        const groupId = context.groupId;
        if (groupId !== null && groupId !== undefined && groupId !== '') {
            return { groupId: String(groupId), chatFile: context.chatId };
        }
        const characters = Array.isArray(context.characters) ? context.characters : [];
        const character = context.characterId === undefined ? undefined : characters[context.characterId];
        if (!isObject(character) || !isText(character.avatar)) return null;
        return { avatar: character.avatar, chatFile: context.chatId };
    }

    /**
     * How to reopen the lease's `active` after a claim's reload (spec E4). Characters only: a group
     * stays on ST's start screen (ST's `openGroupById` isn't in its context; the app reopens groups by
     * its own route).
     * @param {object|null} active The lease's `active` when this load became holder.
     * @param {unknown} characters ST's `characters` array.
     * @returns {{ action: 'none' } | { action: 'skip', why: 'group'|'missing' } | { action: 'open', index: number, chatFile: string }}
     *     Nothing to reopen, skip (logged), or select the character at `index` and open `chatFile`.
     */
    function decideReopen(active, characters) {
        if (!isObject(active)) return { action: 'none' };
        if (isText(active.groupId)) return { action: 'skip', why: 'group' };
        const list = Array.isArray(characters) ? characters : [];
        const index = list.findIndex((character) => isObject(character) && character.avatar === active.avatar);
        if (index === -1) return { action: 'skip', why: 'missing' };
        return { action: 'open', index, chatFile: active.chatFile };
    }

    /**
     * Whether to press ST's connect button after a claim's reload (spec E10). Only after Use here or
     * the app's onForeground claim, never after the automatic claim, and only while not connected.
     * @param {string|null} kind The claim that preceded this load (CLAIM_KIND), or null.
     * @param {unknown} onlineStatus ST's `onlineStatus`.
     * @param {unknown} mainApi ST's `mainApi`.
     * @returns {{ action: 'none', why: 'automatic'|'connected' } | { action: 'press', button: string|null }}
     *     Nothing, or press `button` (null: this API has none; the page still waits for ST's attempt).
     */
    function decideConnect(kind, onlineStatus, mainApi) {
        if (kind !== CLAIM_KIND.useHere && kind !== CLAIM_KIND.foreground) return { action: 'none', why: 'automatic' };
        if (onlineStatus !== NO_CONNECTION) return { action: 'none', why: 'connected' };
        const button = Object.prototype.hasOwnProperty.call(CONNECT_BUTTONS, mainApi) ? CONNECT_BUTTONS[mainApi] : null;
        return { action: 'press', button };
    }

    /**
     * Whether ST is connected to a model (`leaseState.connected`, spec E10, E11).
     * @param {object|null} context ST's context.
     * @returns {boolean} False without a context or while `onlineStatus` is `no_connection`.
     */
    function isConnected(context) {
        return isObject(context) && typeof context.onlineStatus === 'string' && context.onlineStatus !== NO_CONNECTION;
    }

    /**
     * Whether ST's own connect attempt is running (spec E10): its button carries CONNECTING_CLASS from
     * `startStatusLoading()` until `stopStatusLoading()`. A press then would start a second status check.
     * @param {{ classList?: { contains: Function } }|null} button ST's connect button.
     * @returns {boolean} True while an attempt runs.
     */
    function isConnecting(button) {
        return isObject(button) && isObject(button.classList) && typeof button.classList.contains === 'function'
            && button.classList.contains(CONNECTING_CLASS) === true;
    }

    // ---- The lease ---------------------------------------------------------------------------

    /**
     * Creates the lease's logic for one page. No DOM, network or globals except through the params,
     * so Node can test it with a fake fetch.
     * @param {object} deps
     * @param {(url: string, init?: object) => Promise<Response>} deps.fetch The original fetch, never the
     *     wrapped one. The browser glue adds ST's request headers (incl. its CSRF header) to POSTs.
     * @param {(type: string, payload: object) => void} deps.post Reports (spec E11); the browser glue
     *     adds the page-only field `origin` and routes them to the app or `tt-lease`.
     * @param {() => number} deps.now Milliseconds since the epoch: timestamps and the bounded busy wait.
     * @param {(ms: number) => Promise<void>} deps.sleep Bounded one-off delay.
     * @param {{ getItem: Function, setItem: Function, removeItem: Function }} deps.storage This tab's
     *     sessionStorage. Errors are caught: no storage means no automatic claim and a new id per load.
     * @param {(level: string, message: string, details?: object) => void} deps.log Logger: events,
     *     reasons, paths and counts only.
     * @param {Promise<void>} [deps.whenActive] The start decision waits for it (spec E4: a prerendered
     *     page never decides). Default: at once.
     * @param {Function} [deps.setTimeout] Timer for the lease I/O bound (LEASE_FETCH_TIMEOUT_MS). Default:
     *     the global one.
     * @param {Function} [deps.clearTimeout] Clears it.
     * @returns {object} The lease for this page.
     */
    function createSessionLease({
        fetch, post, now, sleep, storage, log, whenActive = Promise.resolve(),
        setTimeout: setTimer = (fn, ms) => setTimeout(fn, ms), clearTimeout: clearTimer = (id) => clearTimeout(id),
    }) {
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
            let answer;
            try {
                answer = await withTimeout(async (signal) => {
                    const response = await fetch(USER_FILES_PATH + name, { cache: 'no-store', signal });
                    const text = response.ok ? await response.text() : '';
                    return { status: response.status, ok: response.ok, text };
                });
            } catch (error) {
                return { kind: 'unreadable', why: error && error.timedOut ? 'timeout' : 'network' };
            }
            if (answer.status === 404) return { kind: 'missing' };
            if (!answer.ok) return { kind: 'unreadable', why: 'status ' + answer.status };
            try {
                return { kind: 'json', value: JSON.parse(answer.text) };
            } catch (error) {
                return { kind: 'unreadable', why: 'json', damaged: true };
            }
        }

        /**
         * Runs one lease request (fetch and body) within LEASE_FETCH_TIMEOUT_MS: aborted and rejected
         * (`timedOut: true`) when ST hasn't answered by then (spec E2, E3).
         * @param {(signal: AbortSignal|undefined) => Promise<T>} task The request; passes the signal to fetch.
         * @returns {Promise<T>} The task's result.
         * @throws {Error} The task's error, or a timeout error with `timedOut: true`.
         * @template T
         */
        function withTimeout(task) {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timer = null;
            const timedOut = new Promise((resolve, reject) => {
                timer = setTimer(() => {
                    if (controller) controller.abort();
                    reject(Object.assign(new Error('lease request timed out'), { timedOut: true }));
                }, LEASE_FETCH_TIMEOUT_MS);
            });
            const run = Promise.resolve().then(() => task(controller ? controller.signal : undefined));
            return Promise.race([run, timedOut]).finally(() => clearTimer(timer));
        }

        /**
         * Validates a file read: a 2xx answer that doesn't parse is `damaged` (spec E2, E9).
         * @param {object} file Result of readFile.
         * @param {(value: unknown) => object} parse parseLease or parseMarker.
         * @returns {object} The parsed read; an unreadable one carries `damaged` when ST answered 2xx.
         */
        function validated(file, parse) {
            if (file.kind !== 'json') return file;
            const read = parse(file.value);
            return read.kind === 'unreadable' ? Object.assign({}, read, { damaged: true }) : read;
        }

        /**
         * Reads and validates the lease.
         * @returns {Promise<{ kind: 'ok', lease: object } | { kind: 'missing' } | { kind: 'unknownFormat' } | { kind: 'unreadable', why: string, damaged?: true }>}
         *     The lease, or why there is none.
         */
        async function readLease() {
            const read = validated(await readFile(LEASE_FILE), parseLease);
            if (read.kind === 'unreadable') log('warn', 'lease unreadable', { why: read.why, damaged: read.damaged === true });
            return read;
        }

        /**
         * Reads and validates the release marker.
         * @returns {Promise<{ kind: 'ok', marker: object } | { kind: 'missing' } | { kind: 'unknownFormat' } | { kind: 'unreadable', why: string, damaged?: true }>}
         *     The marker, or why there is none.
         */
        async function readMarker() {
            const read = validated(await readFile(RELEASE_FILE), parseMarker);
            if (read.kind === 'unreadable') log('warn', 'release marker unreadable', { why: read.why, damaged: read.damaged === true });
            return read;
        }

        /**
         * Uploads a file through ST's upload endpoint, within LEASE_FETCH_TIMEOUT_MS.
         * @param {string} name File name.
         * @param {object} value JSON content.
         * @returns {Promise<'ok'|'failed'|'unreachable'>} 2xx; another answer (e.g. `EPERM` as 500); or no
         *     answer (a network error or the timeout: ST can't be reached).
         */
        async function upload(name, value) {
            try {
                const ok = await withTimeout(async (signal) => (await fetch(UPLOAD_PATH, uploadInit(name, value, { signal }))).ok);
                return ok ? 'ok' : 'failed';
            } catch (error) {
                return 'unreachable';
            }
        }

        /**
         * The release marker's upload (spec E5): `keepalive`, no timeout (the page is leaving or freezing;
         * nothing waits for it).
         * @param {string} name File name.
         * @param {object} value JSON content.
         * @returns {Promise<boolean>} True when ST answered 2xx.
         */
        async function uploadKeepalive(name, value) {
            try {
                return (await fetch(UPLOAD_PATH, uploadInit(name, value, { keepalive: true }))).ok;
            } catch (error) {
                return false;
            }
        }

        /** fetch options for an upload. */
        function uploadInit(name, value, extra) {
            return Object.assign({
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: uploadBody(name, value),
                cache: 'no-store',
            }, extra);
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
            let lastWriteUnreachable = false;
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
                const result = await upload(LEASE_FILE, decision.lease);
                if (result === 'ok') return { status: 'written', lease: decision.lease };
                lastWriteUnreachable = result === 'unreachable';
                log('warn', 'lease write failed', { kind, attempt, unreachable: lastWriteUnreachable });
            }
            if (lastReadFailure) return { status: 'parked', reason: lastReadFailure };
            const outcome = exhaustedOutcome(kind);
            // No answer to the last write (network error, timeout): ST can't be reached, not a refused write.
            if (outcome.status === 'parked' && lastWriteUnreachable) return { status: 'parked', reason: PARK_REASON.unreadable };
            return outcome;
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

        /**
         * The reopen flag a claim set before its reload (spec E4), read and removed once per load, so
         * only the load right after the claim reopens.
         * @returns {string|null} The claim's CLAIM_KIND, or null.
         */
        function takeReopenFlag() {
            const kind = storageGet(STORAGE_KEYS.reopen);
            if (kind !== null) storageRemove(STORAGE_KEYS.reopen);
            return Object.values(CLAIM_KIND).includes(kind) ? kind : null;
        }
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
            /** When the claim's wait for `busy` started (`now()` ms), null outside it (spec E4, E9). */
            waitStartedAt: null,
            /** Take over anyway was tapped during the wait for `busy`; the wait ends at its next step. */
            forceRequested: false,
            /** Set by release(): the claim was given up on `pagehide` or `freeze` (spec E5). */
            released: false,
            /** What released the claim (`pagehide` or `freeze`) and the pair given up; read on `resume`. */
            releasedOn: null,
            releasedPair: null,
            /** The check after `resume` (spec E5); requests wait for it. */
            resumePromise: null,
            /** Generation requests in flight (spec E8); `busy` stays true until the last one is over. */
            generations: 0,
            /** The `busy: true` write the generations in flight share. */
            busyWrite: null,
            /** `busy: true` is confirmed in the lease (reported as `leaseState.busy`). */
            busy: false,
            /** How often the last generation in flight ended; a chat save notes it when it starts. */
            generationEnds: 0,
            /** After the last generation ended, until a chat save started since completes (spec E8). */
            saveWait: null,
            startPromise: null,
            lastReport: '',
            /** When a lease read last confirmed this holder's pair (`now()` ms). */
            verifiedAt: -Infinity,
            checkPromise: null,
            /** ST's version from `/version`; null until read. The allowlist is on only for tested ones. */
            stVersion: null,
            /** ST is connected to a model (`leaseState.connected`, spec E10). */
            connected: false,
            /**
             * After a claim's reload (spec E4, E10): the claim's kind, the lease's `active` when this load
             * became holder, and `pending` until the reopen is over (chat changes aren't recorded meanwhile).
             */
            reopen: { kind: null, active: null, pending: false },
        };
        page.reopen.kind = takeReopenFlag();
        page.reopen.pending = page.reopen.kind !== null;

        /** ISO timestamp for the informational fields. */
        function timestamp() {
            return new Date(now()).toISOString();
        }

        /**
         * Reports `leaseState` when it changed (spec E11). Nothing is reported before the start decision.
         * `busy`: this page is generating, with `busy: true` confirmed in the lease (spec E8).
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
                busy: page.busy,
                connected: page.connected,
                actions: currentActions(),
            };
            const key = JSON.stringify(payload);
            if (key === page.lastReport) return;
            page.lastReport = key;
            post('leaseState', payload);
        }

        /**
         * The ways out this page offers now (spec E9, E11), primary first. Nothing while deciding, as
         * holder, or once released on `pagehide` / `freeze`.
         * @returns {string[]} ACTION values.
         */
        function currentActions() {
            if (page.phase !== PHASE.parked || page.released) return [];
            const waited = page.waitStartedAt === null ? 0 : now() - page.waitStartedAt;
            return actionsFor(page.reason, waited);
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

        /** A lease bug parks the page (`error`, with its ways out), never lets requests through. */
        function failed(step, error) {
            log('error', step + ' failed', { error: String(error && error.message) });
            page.claiming = false;
            page.waitStartedAt = null;
            page.forceRequested = false;
            return park(PARK_REASON.error);
        }

        /** The start decision's steps. A prerendered page waits until it is shown (spec E4). */
        async function runStart() {
            await whenActive;
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
            const read = await readLease();
            const verified = decideVerify(read, pair, PARK_REASON.lost);
            if (!verified.ok) return park(verified.reason);
            // The chat to reopen after a claim's reload (spec E4): the claim carried `active` over.
            page.reopen.active = read.lease.active;
            return becomeHolder(pair);
        }

        /**
         * Claims the lease (spec E4 steps 1–6). On success the page stays parked (`claiming`, requests
         * held) and the caller aborts held chat saves and reloads.
         * @param {string} kind One of CLAIM_KIND.
         * @param {{ force?: boolean }} [options] `force`: Take over anyway (runForceClaim).
         * @returns {Promise<{ status: 'reload', pair: object } | { status: 'parked', reason: string }>} The outcome.
         */
        async function claim(kind, { force = false } = {}) {
            page.claiming = true;
            page.forceRequested = false;
            park(PARK_REASON.claiming);
            let outcome;
            try {
                outcome = await (force ? runForceClaim(kind) : runClaim(kind));
            } catch (error) {
                return failed('claim', error);
            }
            if (outcome.status !== 'reload') page.claiming = false;
            return outcome;
        }

        /** The claim's steps. Take over anyway during the wait for `busy` switches to the forced claim. */
        async function runClaim(kind) {
            const [leaseRead, markerRead] = await readBoth();
            if (leaseRead.kind === 'unknownFormat' || markerRead.kind === 'unknownFormat') return park(PARK_REASON.unknownFormat);
            if (leaseRead.kind === 'unreadable') return park(unreadableReason(leaseRead));
            let base = leaseRead.kind === 'ok' ? leaseRead.lease : null;
            if (base && base.busy && !isReleased(leaseRead, markerRead)) {
                const waited = await waitForReply(base);
                if (waited.status === 'parked') return waited;
                park(PARK_REASON.claiming);
                if (waited.status === 'force') return runForceClaim(kind);
                base = waited.base;
            }
            const claimedAt = timestamp();
            const written = await enqueue(() => writeWithRetry(WRITE_KIND.claim, (read) => decideClaim(read, base, page.id, claimedAt)));
            if (written.status === 'parked') return park(written.reason);
            const pair = { holder: page.id, epoch: base ? base.epoch + 1 : 1 };
            await sleep(GRACE_MS);
            const verified = decideVerify(await readLease(), pair, PARK_REASON.lostRace);
            if (!verified.ok) return park(verified.reason);
            return claimed(kind, pair);
        }

        /** A verified claim: sets the reopen flag; the caller aborts held chat saves and reloads. */
        function claimed(kind, pair) {
            if (!storageSet(STORAGE_KEYS.reopen, kind)) log('warn', 'reopen flag not stored: the chat will not reopen');
            log('info', 'claimed, reloading', { kind, epoch: pair.epoch });
            return { status: 'reload', pair };
        }

        /**
         * Take over anyway (spec E4): a claim written over whatever the lease file holds, after the user
         * confirmed a warning. No wait for `busy`, nothing has to match: a new holder id (this tab, a new
         * load id), so every other page parks by the pair rule. A damaged or unknown-format release
         * marker is first replaced by one that matches nothing. Then the grace and the verify, as a claim.
         * @param {string} kind The claim's CLAIM_KIND (reopen and reconnect after the reload).
         * @returns {Promise<{ status: 'reload', pair: object } | { status: 'parked', reason: string }>} The outcome.
         */
        async function runForceClaim(kind) {
            page.forceRequested = false;
            const [leaseRead, markerRead] = await readBoth();
            const { epoch, active } = forceBase(leaseRead);
            const pair = { holder: tabId + '.' + randomHex(8), epoch };
            log('warn', 'taking over anyway', { lease: leaseRead.kind, marker: markerRead.kind });
            // Writes that fail after a read that couldn't reach ST: the server is down, not the writes.
            const unreachable = [leaseRead, markerRead].some((read) => read.kind === 'unreadable' && read.damaged !== true);
            const writeFailed = unreachable ? PARK_REASON.unreadable : PARK_REASON.error;
            if (markerRead.kind === 'unknownFormat' || markerRead.damaged === true) {
                const fresh = markerFor({ holder: 'r' + randomHex(8) + '.' + randomHex(8), epoch: 1 }, timestamp());
                const repaired = await enqueue(() => uploadWithRetry(RELEASE_FILE, fresh));
                if (repaired !== 'ok') return park(repaired === 'unreachable' ? PARK_REASON.unreadable : writeFailed);
            }
            const claimedAt = timestamp();
            const written = await enqueue(() => writeWithRetry(WRITE_KIND.force, (read) => decideForceClaim(read, pair, claimedAt, active)));
            if (written.status === 'parked') return park(written.reason === PARK_REASON.error ? writeFailed : written.reason);
            await sleep(GRACE_MS);
            const verified = decideVerify(await readLease(), pair, PARK_REASON.lostRace);
            if (!verified.ok) return park(verified.reason);
            return claimed(kind, pair);
        }

        /**
         * Uploads a file with the bounded retry (spec E3): at most WRITE_ATTEMPTS, a random 100–200 ms
         * apart. For the forced claim's marker repair, which builds on nothing.
         * @param {string} name File name.
         * @param {object} value JSON content.
         * @returns {Promise<'ok'|'failed'|'unreachable'>} Accepted, or the last attempt's failure.
         */
        async function uploadWithRetry(name, value) {
            let result = 'failed';
            for (let attempt = 1; attempt <= WRITE_ATTEMPTS; attempt++) {
                if (attempt > 1) await sleep(RETRY_MIN_MS + Math.floor(Math.random() * (RETRY_MAX_MS - RETRY_MIN_MS + 1)));
                result = await upload(name, value);
                if (result === 'ok') return result;
                log('warn', 'file write failed', { name, attempt });
            }
            return result;
        }

        /**
         * Waits for the holder's reply to finish (spec E4 step 2): re-reads once per second for at most
         * 60 s. The one named polling exception: bounded, only during a claim. Each step re-reports, so
         * Take over anyway is offered once FORCE_OFFER_AFTER_MS have passed; a tap ends the wait at the
         * next step.
         * @param {object} base The busy lease.
         * @returns {Promise<{ status: 'continue', base: object|null } | { status: 'force' } | { status: 'parked', reason: string }>}
         *     Continue the claim on top of `base`, take over anyway, or parked.
         */
        async function waitForReply(base) {
            // A tap from an earlier wait that ended on its own must not force this one.
            page.forceRequested = false;
            page.waitStartedAt = now();
            try {
                park(PARK_REASON.waitingForReply);
                return await waitSteps(base);
            } finally {
                page.waitStartedAt = null;
            }
        }

        /** The wait's steps (waitForReply). */
        async function waitSteps(base) {
            const basePair = { holder: base.holder, epoch: base.epoch };
            const startedAt = page.waitStartedAt;
            let latest = base;
            while (now() - startedAt < BUSY_WAIT_MAX_MS) {
                await sleep(BUSY_WAIT_INTERVAL_MS);
                if (page.forceRequested) return { status: 'force' };
                report();
                const [leaseRead, markerRead] = await readBoth();
                if (page.forceRequested) return { status: 'force' };
                const step = decideWaitStep(leaseRead, markerRead, basePair);
                if (step.action === 'park') return park(step.reason);
                if (step.action === 'continue') return { status: 'continue', base: step.base };
                if (step.base) latest = step.base;
            }
            log('warn', 'reply wait ended at the limit', { seconds: BUSY_WAIT_MAX_MS / 1000 });
            return { status: 'continue', base: latest };
        }

        /**
         * Use here (spec E4, E11): claims if parked, not already claiming, and Use here is offered.
         * @returns {Promise<{ status: 'reload', pair: object } | { status: 'parked', reason: string } | { status: 'ignored' }>}
         *     The outcome.
         */
        function useHere() {
            if (page.claiming || !currentActions().includes(ACTION.useHere)) return Promise.resolve({ status: 'ignored' });
            return claim(CLAIM_KIND.useHere);
        }

        /**
         * Take over anyway (spec E4, E11), only while offered; the caller showed the warning. During the
         * wait for `busy` the running claim switches to the forced one at its next step and reloads
         * itself, so this resolves `forcing` (no second reload).
         * @returns {Promise<{ status: 'reload', pair: object } | { status: 'parked', reason: string } | { status: 'forcing' } | { status: 'ignored' }>}
         *     The outcome.
         */
        function takeOverAnyway() {
            if (!currentActions().includes(ACTION.takeOverAnyway)) return Promise.resolve({ status: 'ignored' });
            if (page.claiming) {
                page.forceRequested = true;
                return Promise.resolve({ status: 'forcing' });
            }
            return claim(CLAIM_KIND.useHere, { force: true });
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
            return uploadKeepalive(RELEASE_FILE, marker);
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
            // `busy` from this page's own replies: a reply that ended while released left none.
            const outcome = await bumpEpoch(pair, { busy: replyInProgress() });
            if (outcome.status === 'parked') return park(outcome.reason);
            const next = { holder: pair.holder, epoch: pair.epoch + 1 };
            await sleep(GRACE_MS);
            const again = decideVerify(await readLease(), next, PARK_REASON.lost);
            if (!again.ok) return park(again.reason);
            log('info', 'resumed after freeze', { epoch: next.epoch });
            return becomeHolder(next);
        }

        // ---- busy (spec E8) ----------------------------------------------------------------------

        /**
         * Before a generation request is sent (spec E3, E8): writes `busy: true` (shared by overlapping
         * generations) and waits until it's confirmed. Call only for a request the gate let through.
         * @returns {Promise<{ status: 'send' } | { status: 'hold' } | { status: 'abort' }>} Send it (then
         *     call endGeneration once its response is over); hold it (the page parked); or reject it with
         *     an `AbortError` (`busy: true` couldn't be written: `leaseNotice` `replyNotStarted`).
         */
        async function beginGeneration() {
            if (page.phase !== PHASE.holder) return { status: 'hold' };
            page.generations++;
            // A new reply during the save wait: `busy` stays true, the wait starts again when it ends.
            cancelSaveWait();
            if (!page.busyWrite) page.busyWrite = writeBusy(page.pair, true);
            let outcome;
            let pair;
            try {
                ({ outcome, pair } = await page.busyWrite);
            } catch (error) {
                outcome = { status: 'parked', reason: PARK_REASON.unreadable };
            }
            const confirmed = outcome.status === 'written' || outcome.status === 'unchanged';
            if (confirmed && stillHolds(pair)) {
                page.busy = true;
                page.verifiedAt = now();
                report();
                return { status: 'send' };
            }
            dropGeneration();
            // It cancelled a save wait: nothing runs now. A failed write left `busy: false` pending (E3).
            if (page.generations === 0 && page.busy) {
                page.busy = false;
                report();
            }
            if (outcome.status === 'parked') {
                park(outcome.reason);
                return { status: 'hold' };
            }
            if (!confirmed) {
                log('warn', 'busy true not written: reply not started');
                post('leaseNotice', { kind: 'replyNotStarted' });
                return { status: 'abort' };
            }
            return { status: 'hold' };
        }

        /**
         * Writes `busy` for this page's pair.
         * @param {{ holder: string, epoch: number }} pair The pair the write starts from.
         * @param {boolean} busy The value to write.
         * @returns {Promise<{ outcome: object, pair: object }>} The update's outcome and the pair it used.
         */
        function writeBusy(pair, busy) {
            return writeHolderUpdate(pair, { busy });
        }

        /**
         * Writes a holder update (`busy` / `active`) for this page's pair. If the write found the lease at
         * a newer pair of this page's own (its epoch bump, e.g. onForeground, landed first in the queue),
         * it retries once with that pair, as the gate's check does; anything else is left to the caller.
         * @param {{ holder: string, epoch: number }} pair The pair the write starts from.
         * @param {{ busy?: boolean, active?: object|null }} changes Fields to set.
         * @returns {Promise<{ outcome: object, pair: object }>} The update's outcome and the pair it used.
         */
        async function writeHolderUpdate(pair, changes) {
            const outcome = await updateLease(pair, changes);
            const ownNewerPair = outcome.status === 'parked' && outcome.reason === PARK_REASON.lost
                && page.phase === PHASE.holder && page.pair !== null
                && page.pair.holder === pair.holder && page.pair.epoch > pair.epoch;
            if (!ownNewerPair) return { outcome, pair };
            const retryPair = page.pair;
            return { outcome: await updateLease(retryPair, changes), pair: retryPair };
        }

        // ---- Open chat, reopen and connection (spec E4, E10) -------------------------------------

        /**
         * ST's `CHAT_CHANGED` (spec E4): the holder records its open chat as `active` (skipped when
         * unchanged). Not while a reopen is pending: ST's startup chat changes would overwrite the chat
         * still to be reopened. A failed write leaves the page holder (spec E3).
         * @param {object|null} active The open chat (activeFromContext).
         * @returns {Promise<{ status: string }>} The update's outcome, or `skipped`.
         */
        async function recordChat(active) {
            if (page.phase !== PHASE.holder || page.reopen.pending) return { status: 'skipped' };
            try {
                const { outcome } = await writeHolderUpdate(page.pair, { active });
                if (outcome.status === 'parked') park(outcome.reason);
                return outcome;
            } catch (error) {
                return failed('active', error);
            }
        }

        /**
         * After ST's `APP_READY` (spec E4, E10): what to do in the load right after a claim, once. Waits
         * for the start decision. Anything but a holder after a claim's reload gets null, and chat changes
         * are recorded from then on.
         * @returns {Promise<{ kind: string, active: object|null } | null>} The claim's kind (reconnect only
         *     after `useHere` / `foreground`) and the chat to reopen, or null.
         */
        async function takeReopen() {
            await start();
            const { kind, active, pending } = page.reopen;
            page.reopen.kind = null;
            if (pending && kind !== null && page.phase === PHASE.holder) return { kind, active };
            page.reopen.pending = false;
            return null;
        }

        /**
         * The reopen is over (spec E4): chat changes are recorded again, and the chat now open is
         * recorded. Without one (a skipped reopen: start screen) `active` stays as it was.
         * @param {object|null} active The chat open now (activeFromContext).
         * @returns {Promise<{ status: string }>} The update's outcome, or `skipped`.
         */
        function finishReopen(active) {
            page.reopen.pending = false;
            return active ? recordChat(active) : Promise.resolve({ status: 'skipped' });
        }

        /**
         * ST's connection state changed (spec E10): reported as `leaseState.connected`.
         * @param {boolean} connected Whether ST is connected to a model.
         * @returns {void}
         */
        function setConnected(connected) {
            page.connected = connected === true;
            report();
        }

        /** Counts a generation as over without writing; the last one forgets the shared write. */
        function dropGeneration() {
            page.generations = Math.max(0, page.generations - 1);
            if (page.generations === 0) page.busyWrite = null;
        }

        /**
         * A generation's response is over (spec E8): body fully read, stream closed, an error or a
         * cancel. After the last one, `busy` stays true until a chat save that started after this end
         * has completed (chatSaveDone), at most SAVE_WAIT_MAX_MS, then `busy: false` is written (a failed
         * write stays pending, spec E3). A page that is no longer holder writes nothing.
         * @param {object} [options]
         * @param {string} [options.path] The generation's endpoint path, for the log.
         * @param {boolean} [options.waitForSave=true] False writes `busy: false` at once (the headers
         *     fallback, which can't see the end of the reply).
         * @returns {Promise<void>} Settles once `busy: false` was handled, or a new reply took over.
         */
        function endGeneration({ path = null, waitForSave = true } = {}) {
            if (page.generations === 0) return Promise.resolve();
            dropGeneration();
            if (page.generations > 0) return Promise.resolve();
            // Not holder: its chat save is held and never completes, so no wait.
            if (!waitForSave || page.phase !== PHASE.holder) return clearBusy();
            return waitForChatSave(path);
        }

        /**
         * Starts the wait for ST's chat save after the last reply ended (spec E8). Runs synchronously up
         * to the bounded delay, so a save ST starts right after this end counts.
         * @param {string|null} path The generation's endpoint path, for the log.
         * @returns {Promise<void>} Settles when the wait is over or cancelled.
         */
        function waitForChatSave(path) {
            cancelSaveWait();
            page.generationEnds++;
            let settle;
            const done = new Promise((resolve) => { settle = resolve; });
            const wait = { after: page.generationEnds, path, settle };
            page.saveWait = wait;
            const atLimit = () => endSaveWait(wait, true);
            sleep(SAVE_WAIT_MAX_MS).then(atLimit, atLimit);
            return done;
        }

        /**
         * Ends a save wait that is still current: clears `busy`. No-op for one already ended or cancelled.
         * @param {object} wait The wait (page.saveWait when it started).
         * @param {boolean} atLimit True when no chat save completed within SAVE_WAIT_MAX_MS.
         * @returns {void}
         */
        function endSaveWait(wait, atLimit) {
            if (page.saveWait !== wait) return;
            page.saveWait = null;
            if (atLimit) log('warn', 'no chat save after the reply: busy cleared at the limit', { path: wait.path, reason: 'no save within ' + SAVE_WAIT_MAX_MS + ' ms' });
            clearBusy().then(wait.settle);
        }

        /** Drops a running save wait without clearing `busy` (a new reply started). */
        function cancelSaveWait() {
            const wait = page.saveWait;
            if (!wait) return;
            page.saveWait = null;
            wait.settle();
        }

        /** Writes `busy: false` for the holder; a page that is no longer holder only reports it. */
        async function clearBusy() {
            page.busy = false;
            report();
            if (page.phase !== PHASE.holder) return;
            try {
                const { outcome } = await writeBusy(page.pair, false);
                if (outcome.status === 'parked') park(outcome.reason);
            } catch (error) {
                failed('busy clear', error);
            }
        }

        /** Whether a reply runs or its chat save is awaited: the `busy` an epoch bump writes (spec E8). */
        function replyInProgress() {
            return page.generations > 0 || page.saveWait !== null;
        }

        /**
         * A chat save request starts (spec E8): call when ST sends it, before the lease check.
         * @returns {number} Its mark, passed to chatSaveDone.
         */
        function chatSaveMark() {
            return page.generationEnds;
        }

        /**
         * A chat save request completed, whatever its status (spec E8). A save that started after the
         * last reply ended ends the save wait; one that started earlier doesn't count.
         * @param {number} mark From chatSaveMark when the save started.
         * @returns {void}
         */
        function chatSaveDone(mark) {
            const wait = page.saveWait;
            if (wait && mark >= wait.after) endSaveWait(wait, false);
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
         * Always reports `leaseState` (unless a reload follows), unchanged too: the app's pre-check (A4)
         * may have parked its own scrim and waits for the page to confirm.
         * @returns {Promise<{ status: string }>} holder, parked, reload (after a claim) or ignored.
         */
        async function onForeground() {
            const before = page.lastReport;
            const outcome = await foregroundOutcome();
            if (outcome.status !== 'reload' && page.lastReport === before) {
                page.lastReport = '';
                report();
            }
            return outcome;
        }

        /** onForeground's decision, without the report. */
        async function foregroundOutcome() {
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
            // `busy` from this page's own replies: a reply that ended while released left none.
            const outcome = await bumpEpoch(pair, { busy: replyInProgress() });
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
            beginGeneration,
            endGeneration,
            chatSaveMark,
            chatSaveDone,
            recordChat,
            takeReopen,
            finishReopen,
            setConnected,
            /** Whether a failed `busy: false` is still waiting to be written. */
            hasPendingBusyClear: () => state.pendingBusyClear,
            start,
            useHere,
            takeOverAnyway,
            /** The ways out offered now (`leaseState.actions`). */
            actions: currentActions,
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
                generations: page.generations,
                busy: page.busy,
                awaitingChatSave: page.saveWait !== null,
                connected: page.connected,
                reopenPending: page.reopen.pending,
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
        FORCE_OFFER_AFTER_MS,
        SAVE_WAIT_MAX_MS,
        STORAGE_KEYS,
        OFF_ONCE_NAME_PREFIX,
        PARK_REASON,
        ACTION,
        actionsFor,
        forceBase,
        decideForceClaim,
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
        isGeneration,
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
        GENERATION_PATHS,
        CONNECT_BUTTONS,
        CONNECT_WAIT_MS,
        activeFromContext,
        decideReopen,
        decideConnect,
        isConnected,
        isConnecting,
        createStHooks,
        READ_WINDOW_MS,
        CSRF_ORDER_MAX_WAIT_MS,
        RELOAD_FALLBACK_MS,
        LEASE_FETCH_TIMEOUT_MS,
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

        /** The lease's own token, within LEASE_FETCH_TIMEOUT_MS (a hung answer must not stall every write). */
        async function fetchToken() {
            const controller = typeof AbortController === 'function' ? new AbortController() : null;
            let timer = null;
            try {
                const data = await new Promise((resolve, reject) => {
                    timer = setTimeout(() => {
                        if (controller) controller.abort();
                        reject(new Error('CSRF token request timed out'));
                    }, LEASE_FETCH_TIMEOUT_MS);
                    fetch(CSRF_TOKEN_PATH, { cache: 'no-store', signal: controller ? controller.signal : undefined })
                        .then((response) => (response.ok ? response.json() : null))
                        .then(resolve, reject);
                });
                token = data && typeof data.token === 'string' ? data.token : null;
            } catch (error) {
                token = null;
            } finally {
                clearTimeout(timer);
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
            // A chat save notes when it started (here, before the lease check): spec E8's save wait.
            const saveMark = isChatSave(path) ? ctx.lease.chatSaveMark() : null;
            const send = () => {
                if (isGeneration(path, method)) return sendGeneration(win, ctx, path, () => ctx.originalFetch(input, init), hold);
                if (saveMark !== null) return sendChatSave(ctx, saveMark, () => ctx.originalFetch(input, init));
                return ctx.originalFetch(input, init);
            };
            return ctx.lease.gate(path, method).then((verdict) => (verdict === 'send' ? send() : hold()), hold);
        };
    }

    /** Sends a chat save and tells the lease once it completed, whatever its status (spec E8). */
    function sendChatSave(ctx, mark, request) {
        const done = () => ctx.lease.chatSaveDone(mark);
        let pending;
        try {
            pending = request();
        } catch (error) {
            done();
            throw error;
        }
        return pending.then((response) => {
            done();
            return response;
        }, (error) => {
            done();
            throw error;
        });
    }

    /**
     * Sends a generation request only after `busy: true` is confirmed (spec E8), and ends it once the
     * response is over: body fully read or closed, an error, or a cancel (Stop). Never at the headers.
     */
    function sendGeneration(win, ctx, path, request, hold) {
        return ctx.lease.beginGeneration().then((begin) => {
            if (begin.status === 'hold') return hold();
            if (begin.status === 'abort') throw new win.DOMException('TravelingTavern: reply not started', 'AbortError');
            const end = once((options) => { ctx.lease.endGeneration(Object.assign({ path }, options)); });
            let pending;
            try {
                pending = request();
            } catch (error) {
                end();
                throw error;
            }
            return pending.then((response) => trackBody(win, response, end, ctx.log), (error) => {
                end();
                throw error;
            });
        });
    }

    /** A function that runs at most once. */
    function once(fn) {
        let done = false;
        return (...args) => {
            if (done) return;
            done = true;
            fn(...args);
        };
    }

    /**
     * The same response, with its body passed through a stream that calls `end` when the body is fully
     * read, errors, or is cancelled (spec E8). No body: `end` at once.
     */
    function trackBody(win, response, end, log) {
        if (!response.body) {
            end();
            return response;
        }
        const reader = response.body.getReader();
        const stream = new win.ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        end();
                        controller.close();
                    } else {
                        controller.enqueue(value);
                    }
                } catch (error) {
                    end();
                    controller.error(error);
                }
            },
            cancel(reason) {
                end();
                return reader.cancel(reason);
            },
        });
        try {
            const tracked = new win.Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
            Object.defineProperty(tracked, 'url', { value: response.url });
            return tracked;
        } catch (error) {
            // Can't rebuild it: don't leave `busy` stuck (spec E8, R19); the reply may still stream, so
            // `busy: false` now, without the chat-save wait.
            log('warn', 'generation response not tracked: busy cleared at the headers');
            reader.releaseLock();
            end({ waitForSave: false });
            return response;
        }
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
            const generation = isGeneration(target.path, target.method);
            if (!target.async) {
                // A synchronous XHR can't wait: sent only if no lease read is needed, else held. A
                // generation always waits for `busy: true`, so a synchronous one is held.
                if (!generation && ctx.lease.decideNow(target.path, target.method) === 'send') return send.apply(this, args);
                return hold();
            }
            const sendNow = () => {
                try {
                    send.apply(xhr, args);
                    return true;
                } catch (error) {
                    ctx.log('warn', 'XHR not sent after the lease check', { path: target.path });
                    return false;
                }
            };
            ctx.lease.gate(target.path, target.method).then((verdict) => {
                if (verdict !== 'send') return hold();
                if (!generation) return sendNow();
                return sendXhrGeneration(ctx, target.path, xhr, sendNow, hold);
            }, hold);
            return undefined;
        };
    }

    /**
     * A generation XHR (spec E8): sent after `busy: true` is confirmed, `busy` cleared on `loadend`. If
     * `busy: true` can't be written, it's aborted (ST sees an abort, as with Stop).
     */
    function sendXhrGeneration(ctx, path, xhr, sendNow, hold) {
        return ctx.lease.beginGeneration().then((begin) => {
            if (begin.status === 'hold') return hold();
            if (begin.status === 'abort') return xhr.abort();
            const end = once(() => { ctx.lease.endGeneration({ path }); });
            xhr.addEventListener('loadend', end);
            if (!sendNow()) end();
            return undefined;
        });
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
     * The lease's hooks into ST's context (spec E4, E10): records the open chat, tracks `connected`, and
     * after a claim's reload reopens the chat and, after Use here / onForeground only, connects once.
     * Reads a fresh `getContext()` every time (it returns a snapshot). Nothing here can let a request
     * through: these only call ST's own functions and lease updates.
     * @param {object} deps
     * @param {() => object|null} deps.getContext A fresh ST context, or null.
     * @param {object} deps.lease The page's lease.
     * @param {(type: string, payload: object) => void} deps.post Reports (`leaseNotice`).
     * @param {Function} deps.log Logger.
     * @param {Function} deps.setTimeout Timer for the bounded connect wait.
     * @param {Function} deps.clearTimeout Clears it.
     * @param {(selector: string) => { click: Function, classList: object }|null} deps.querySelector Finds
     *     ST's connect button.
     * @returns {{ attach: (context: object) => void, afterAppReady: () => Promise<void> }} `attach`
     *     subscribes to ST's events once its context exists.
     */
    function createStHooks({ getContext, lease, post, log, setTimeout, clearTimeout, querySelector }) {
        const fresh = () => {
            try {
                return getContext();
            } catch (error) {
                return null;
            }
        };

        /** Selects the character, then opens the chat if it isn't the one ST opened (ST's own recent-chat steps). */
        async function reopenChat(active) {
            const context = fresh();
            const decision = decideReopen(active, context && context.characters);
            if (decision.action === 'none') return;
            if (decision.action === 'skip') {
                log('info', 'chat not reopened: start screen', { why: decision.why });
                return;
            }
            await context.selectCharacterById(decision.index);
            const selected = fresh();
            // ST skips the switch while a save or a reply runs; openCharacterChat would then change the
            // wrong character's chat.
            if (!selected || String(selected.characterId) !== String(decision.index) || activeFromContext(selected) === null
                || (selected.groupId !== null && selected.groupId !== undefined && selected.groupId !== '')) {
                log('warn', 'chat not reopened: character not selected');
                return;
            }
            if (selected.chatId !== decision.chatFile) await selected.openCharacterChat(decision.chatFile);
            log('info', 'chat reopened');
        }

        /** Resolves true once ST reports a connection, or after CONNECT_WAIT_MS with its status then. */
        function waitForConnection(context) {
            return new Promise((resolve) => {
                const { eventSource, eventTypes } = context;
                let timer = null;
                const finish = (connected) => {
                    clearTimeout(timer);
                    eventSource.removeListener(eventTypes.ONLINE_STATUS_CHANGED, onChange);
                    resolve(connected);
                };
                const onChange = (status) => {
                    if (typeof status === 'string' && status !== NO_CONNECTION) finish(true);
                };
                eventSource.on(eventTypes.ONLINE_STATUS_CHANGED, onChange);
                timer = setTimeout(() => finish(isConnected(fresh())), CONNECT_WAIT_MS);
            });
        }

        /**
         * Presses ST's connect button once if not connected and ST isn't already connecting (e.g. its own
         * Auto-connect); `notConnected` if ST's attempt fails.
         */
        async function reconnect(kind) {
            const context = fresh();
            const decision = decideConnect(kind, context && context.onlineStatus, context && context.mainApi);
            if (decision.action === 'none') return;
            const button = decision.button ? querySelector(decision.button) : null;
            const connecting = isConnecting(button);
            if (button && !connecting) button.click();
            log('info', 'connecting after a takeover', { pressed: button !== null && !connecting, alreadyConnecting: connecting });
            if (await waitForConnection(context)) return;
            log('info', 'not connected after a takeover');
            post('leaseNotice', { kind: 'notConnected' });
        }

        /** After `APP_READY`: reports `connected`, then reopens and reconnects in the load after a claim. */
        async function afterAppReady() {
            lease.setConnected(isConnected(fresh()));
            const plan = await lease.takeReopen();
            if (!plan) return;
            const reopened = reopenChat(plan.active)
                .catch((error) => log('warn', 'chat not reopened', { error: String(error && error.message) }))
                .then(() => lease.finishReopen(activeFromContext(fresh())));
            const connected = reconnect(plan.kind)
                .catch((error) => log('warn', 'connect failed', { error: String(error && error.message) }));
            await Promise.all([reopened, connected]);
        }

        /** Subscribes to ST's events. `APP_READY` fires again for a late listener (ST's auto-fire events). */
        function attach(context) {
            const { eventSource, eventTypes } = context;
            eventSource.on(eventTypes.CHAT_CHANGED, () => { lease.recordChat(activeFromContext(fresh())); });
            eventSource.on(eventTypes.ONLINE_STATUS_CHANGED, () => { lease.setConnected(isConnected(fresh())); });
            eventSource.on(eventTypes.APP_READY, () => { afterAppReady(); });
        }

        return { attach, afterAppReady };
    }

    /**
     * Wires the ST hooks once ST's context can be read: at once on desktop (the extension loads during
     * ST's startup), else on `load` (the app injects the lease at document start). ST sets its global
     * before it waits for `load`, but `getContext()` reads module variables declared after that wait,
     * so it throws until `script.js` resumes; a `load` attach that can't read it retries once, one task
     * later (spec E10, E15).
     * @param {object} win The page's window.
     * @param {object} lease The page's lease.
     * @param {(type: string, payload: object) => void} post Reports.
     * @param {Function} log Logger.
     */
    function wireSillyTavern(win, lease, post, log) {
        const getContext = () => (win.SillyTavern && typeof win.SillyTavern.getContext === 'function'
            ? win.SillyTavern.getContext() : null);
        const hooks = createStHooks({
            getContext,
            lease,
            post,
            log,
            setTimeout: (fn, ms) => win.setTimeout(fn, ms),
            clearTimeout: (id) => win.clearTimeout(id),
            querySelector: (selector) => (win.document && typeof win.document.querySelector === 'function'
                ? win.document.querySelector(selector) : null),
        });
        const attach = (retry) => {
            let context = null;
            try {
                context = getContext();
            } catch (error) {
                context = null;
            }
            if (!context || !context.eventSource || !context.eventTypes) {
                if (retry) {
                    win.setTimeout(() => attach(false), 0);
                    return;
                }
                log('warn', 'SillyTavern context not found: no reopen, no reconnect');
                return;
            }
            hooks.attach(context);
        };
        if (win.SillyTavern) attach(false);
        else win.addEventListener('load', () => attach(true), { once: true });
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

    /**
     * Reads (and consumes) the off mark (spec E4 → Turn off protection): the sessionStorage flag, kept
     * until Turn protection back on, or the one-load `window.name` prefix used when storage is blocked.
     * The prefix counts only when sessionStorage can't be written in this load and the load is a reload
     * (Turn off protection always reloads): another site can name a window it opens, so a prefix on any
     * other load is removed and ignored.
     * @param {Window} win The page's window.
     * @returns {boolean} True when protection is off in this load.
     */
    function takeOffMark(win) {
        let off = false;
        try {
            off = win.sessionStorage.getItem(STORAGE_KEYS.off) === '1';
        } catch (error) {
            off = false;
        }
        const name = typeof win.name === 'string' ? win.name : '';
        if (name.startsWith(OFF_ONCE_NAME_PREFIX)) {
            win.name = name.slice(OFF_ONCE_NAME_PREFIX.length);
            if (!sessionStorageWorks(win) && isReloadNavigation(win)) off = true;
        }
        return off;
    }

    /** Whether this load can write sessionStorage (a probe key, removed at once). */
    function sessionStorageWorks(win) {
        try {
            win.sessionStorage.setItem(STORAGE_KEYS.off + '-probe', '1');
            win.sessionStorage.removeItem(STORAGE_KEYS.off + '-probe');
            return true;
        } catch (error) {
            return false;
        }
    }

    /** Whether this load is a reload (Navigation Timing); anything unreadable is not. */
    function isReloadNavigation(win) {
        try {
            const entry = win.performance.getEntriesByType('navigation')[0];
            return Boolean(entry) && entry.type === 'reload';
        } catch (error) {
            return false;
        }
    }

    /**
     * Sets the off mark for this tab: the sessionStorage flag, or, if storage is blocked, the
     * `window.name` prefix for the next load only (spec E4).
     * @param {Window} win The page's window.
     * @param {Function} log Logger.
     * @returns {void}
     */
    function setOffMark(win, log) {
        try {
            win.sessionStorage.setItem(STORAGE_KEYS.off, '1');
            return;
        } catch (error) {
            log('warn', 'no sessionStorage: protection off for the next load only');
        }
        win.name = OFF_ONCE_NAME_PREFIX + (typeof win.name === 'string' ? win.name : '');
    }

    /** Removes the off mark (Turn protection back on); errors ignored. */
    function clearOffMark(win) {
        try {
            win.sessionStorage.removeItem(STORAGE_KEYS.off);
        } catch (error) {
            // Storage blocked: the flag can't be there either.
        }
    }

    /**
     * Protection is off in this tab (spec E4, E11): the lease stands down for this load. No wrapper,
     * no lease reads or writes, no claim; `window.__ttLease` is still defined (a second copy stands
     * down) and reports `leaseState` `state: 'off'` with Turn protection back on, which reloads protected.
     * @param {Window} win The page's window.
     * @param {string} source `app` or `extension`.
     * @param {Function} log Logger.
     * @returns {boolean} True (installed, off).
     */
    function installOff(win, source, log) {
        log('warn', 'protection is off in this tab');
        const post = makePost(win);
        const report = () => post('leaseState', {
            state: 'off',
            reason: null,
            pageId: null,
            epoch: null,
            busy: false,
            connected: false,
            actions: [ACTION.turnProtectionOn],
            origin: win.location.origin,
        });
        const ignored = () => Promise.resolve({ status: 'ignored' });
        const api = Object.freeze({
            version: LEASE_VERSION,
            source,
            useHere: ignored,
            onForeground: () => {
                report();
                return Promise.resolve({ status: 'off' });
            },
            takeOverAnyway: ignored,
            turnOffProtection: () => false,
            turnProtectionOn: () => {
                clearOffMark(win);
                log('info', 'protection back on: reloading');
                win.location.reload();
                return true;
            },
            refresh: () => false,
        });
        Object.defineProperty(win, '__ttLease', { value: api, writable: false, configurable: false, enumerable: false });
        report();
        readStVersion(win.fetch.bind(win)).then((stVersion) => {
            const sendLeaseInfo = () => post('leaseInfo', buildLeaseInfo(stVersion, win.__ttExtension));
            sendLeaseInfo();
            win.addEventListener('tt-extension-ready', sendLeaseInfo);
        });
        return true;
    }

    /** The lease for this page, its CSRF client and reports wired to the window. */
    function createPageLease(win, originalFetch, log, whenActive) {
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
                ? Object.assign({}, payload, { origin: win.location.origin })
                : payload),
            now: () => Date.now(),
            sleep: (ms) => new Promise((resolve) => win.setTimeout(resolve, ms)),
            storage: pageStorage(win),
            log,
            whenActive,
            setTimeout: (fn, ms) => win.setTimeout(fn, ms),
            clearTimeout: (id) => win.clearTimeout(id),
        });
        return { lease, csrf, post };
    }

    /**
     * Installs the lease in a page: main frame only, never on ST's login page, once per page (a second
     * copy stands down completely). `window.__ttLease` is frozen; only the user can turn protection off,
     * in one tab, after a warning (Turn off protection, spec E4, E11). `__ttLease` is defined before the
     * wrapper, so an install error can't leave held requests behind an overlay whose buttons do nothing.
     * A page installed while Chrome prerenders it never decides; it reloads when shown (spec E4).
     * @param {Window} win The page's window.
     * @returns {boolean} True when installed now (protected or off).
     */
    function install(win) {
        if (!isMainFrame(win) || isLoginPage(win.location.pathname)) return false;
        if (Object.prototype.hasOwnProperty.call(win, '__ttLease')) return false;
        const source = win.__ttLeaseSource === 'extension' ? 'extension' : 'app';
        const log = makeLog(win.console);
        if (takeOffMark(win)) return installOff(win, source, log);
        const doc = win.document;
        const prerendering = Boolean(doc) && doc.prerendering === true;
        const originalFetch = win.fetch.bind(win);
        // A prerendered page's start decision never runs: requests wait, and the page reloads when shown.
        const whenActive = prerendering ? new Promise(() => {}) : Promise.resolve();
        const { lease, csrf, post } = createPageLease(win, originalFetch, log, whenActive);
        const makeAbortError = () => new win.DOMException('TravelingTavern: request held while parked', 'AbortError');
        const held = createHeldRegistry(makeAbortError);
        const ctx = { lease, held, csrf, originalFetch, makeAbortError, log };

        const reloadPage = () => reloadAfterAborts(win, lease, held, log);
        const afterOutcome = (outcome) => {
            if (outcome && outcome.status === 'reload') reloadPage();
        };
        const offered = (action) => lease.actions().includes(action);
        const api = Object.freeze({
            version: LEASE_VERSION,
            source,
            useHere: () => lease.useHere().then(afterOutcome),
            onForeground: () => lease.onForeground().then(afterOutcome),
            takeOverAnyway: () => lease.takeOverAnyway().then(afterOutcome),
            turnOffProtection: () => {
                if (!offered(ACTION.turnOffProtection)) return false;
                setOffMark(win, log);
                log('warn', 'turning protection off in this tab: reloading');
                reloadPage();
                return true;
            },
            turnProtectionOn: () => false,
            refresh: () => {
                if (!offered(ACTION.refresh)) return false;
                reloadPage();
                return true;
            },
        });
        Object.defineProperty(win, '__ttLease', { value: api, writable: false, configurable: false, enumerable: false });
        wrapFetch(win, ctx);
        wrapXhr(win, ctx);
        wrapBeacon(win, ctx);

        if (prerendering) {
            doc.addEventListener('prerenderingchange', () => {
                log('info', 'prerendered page shown: reloading');
                reloadPage();
            }, { once: true });
        }
        // The app releases from Kotlin (app spec A5).
        if (source === 'extension') wireDesktopRelease(win, lease, reloadPage);
        startAndReport(win, lease, post, originalFetch, afterOutcome);
        wireSillyTavern(win, lease, post, log);
        return true;
    }
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    } else if (typeof window !== 'undefined') {
        install(window);
    }
})();
