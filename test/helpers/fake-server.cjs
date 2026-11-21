'use strict';

// A fake SillyTavern server holding the two lease files, and pages (lease instances) sharing it,
// for the lease's tests. Invented data only.

const lease = require('../../session-lease.js');

/**
 * Creates a fake server, a first page wired to it, and recorders.
 * @param {object} [options]
 * @param {object} [options.files] Initial files by name: an object (stored as JSON) or a raw string.
 * @param {object|null} [options.storage] The first page's sessionStorage content (default: page id
 *     `page-a`); null for a storage that throws.
 * @returns {object} Test harness.
 */
function createHarness({ files = {}, storage = { [lease.STORAGE_KEYS.tabId]: 'page-a' } } = {}) {
    const server = {
        /** File contents by name, as text. */
        files: new Map(Object.entries(files).map(([name, value]) => [name, toText(value)])),
        /** Answer status for reads of a file name (e.g. 500), instead of its content. */
        readStatus: new Map(),
        /** Reads throw a network error while true. */
        offline: false,
        /** Number of upcoming lease-file reads answered 500 (transient). */
        failLeaseReads: 0,
        /** Number of upcoming lease-file reads answered 404 (transient). */
        missingLeaseReads: 0,
        /** Number of upcoming uploads answered 500 without writing (Windows EPERM). */
        failUploads: 0,
        /** Uploads answered 500 after writing (the write landed, the answer says it didn't). */
        failAfterWrite: 0,
        /** Called before each upload is applied; may change server state (another page writing). */
        beforeUpload: null,
        /** Called on every sleep with the delay; may change server state (time passing elsewhere). */
        onSleep: null,
        /** When set, uploads need this X-CSRF-Token header (else 403), and /csrf-token answers it. */
        csrfToken: null,
        /** Awaited before /csrf-token answers (a slow token fetch). */
        tokenDelay: null,
        /** /csrf-token requests seen. */
        tokenRequests: 0,
        /** ST's version, answered by /version. */
        stVersion: '1.19.1',
        /** Every request that isn't the lease's (ST's own), in order. */
        stRequests: [],
        /** Reads of the lease file. */
        leaseReads: 0,
    };
    const uploads = [];
    const sleeps = [];
    const logs = [];
    let clock = Date.UTC(2026, 0, 1);
    let inFlight = 0;
    let maxInFlight = 0;

    async function fakeFetch(url, init = {}) {
        if (server.offline) throw new TypeError('Failed to fetch');
        const method = String(init.method || 'GET').toUpperCase();
        if (method === 'GET' && url.startsWith(lease.USER_FILES_PATH)) return answerRead(url.slice(lease.USER_FILES_PATH.length));
        if (method === 'POST' && url === lease.UPLOAD_PATH) {
            if (server.csrfToken !== null && new Headers(init.headers).get('X-CSRF-Token') !== server.csrfToken) {
                return new Response('Invalid CSRF token', { status: 403 });
            }
            return answerUpload(JSON.parse(init.body), init);
        }
        if (method === 'GET' && url === '/csrf-token') {
            server.tokenRequests++;
            if (server.tokenDelay) await server.tokenDelay;
            return Response.json({ token: server.csrfToken || 'disabled' });
        }
        if (method === 'GET' && url === '/version') return Response.json({ agent: 'x', pkgVersion: server.stVersion });
        server.stRequests.push({ url: String(url), method, headers: new Headers(init.headers) });
        return Response.json({ ok: true });
    }

    function answerRead(name) {
        if (name === lease.LEASE_FILE) server.leaseReads++;
        if (name === lease.LEASE_FILE && server.failLeaseReads > 0) {
            server.failLeaseReads--;
            return new Response('error', { status: 500 });
        }
        if (name === lease.LEASE_FILE && server.missingLeaseReads > 0) {
            server.missingLeaseReads--;
            return new Response('Not Found', { status: 404 });
        }
        if (server.readStatus.has(name)) return new Response('error', { status: server.readStatus.get(name) });
        if (!server.files.has(name)) return new Response('Not Found', { status: 404 });
        return new Response(server.files.get(name), { status: 200 });
    }

    async function answerUpload({ name, data }, init) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        try {
            if (server.beforeUpload) server.beforeUpload(name);
            const text = Buffer.from(data, 'base64').toString('utf8');
            uploads.push({ name, value: JSON.parse(text), keepalive: init.keepalive === true });
            if (server.failUploads > 0) {
                server.failUploads--;
                return new Response('EPERM', { status: 500 });
            }
            server.files.set(name, text);
            if (server.failAfterWrite > 0) {
                server.failAfterWrite--;
                return new Response('error', { status: 500 });
            }
            return Response.json({ path: '/user/files/' + name });
        } finally {
            inFlight--;
        }
    }

    /**
     * A page load on this server: its own lease instance, sessionStorage and reports.
     * @param {object|null} storageContent sessionStorage content (pass the same object's entries for a
     *     refresh in the same tab), or null for a storage that throws.
     * @returns {{ lease: object, posts: object[], storage: object }} The page.
     */
    function newPage(storageContent) {
        const pageStorage = storageContent === null ? brokenStorage() : fakeStorage(storageContent);
        const posts = [];
        const instance = lease.createSessionLease({
            fetch: fakeFetch,
            post: (type, payload) => posts.push(Object.assign({ type }, payload)),
            now: () => clock,
            sleep: async (ms) => {
                sleeps.push(ms);
                clock += ms;
                if (server.onSleep) server.onSleep(ms);
            },
            storage: pageStorage,
            log: (level, message, details) => logs.push({ level, message, details }),
        });
        return { lease: instance, posts, storage: pageStorage };
    }

    const first = newPage(storage);

    return {
        lease: first.lease,
        posts: first.posts,
        storage: first.storage,
        newPage,
        /** The fake server's fetch (a page's original fetch). */
        fetch: fakeFetch,
        /** Moves the pages' clock forward without a sleep. */
        advance: (ms) => { clock += ms; },
        server,
        uploads,
        sleeps,
        logs,
        maxInFlight: () => maxInFlight,
        /** Lease writes only (not the release marker). */
        leaseUploads: () => uploads.filter((u) => u.name === lease.LEASE_FILE),
        /** The lease file as stored, parsed. */
        leaseFile: () => JSON.parse(server.files.get(lease.LEASE_FILE)),
        /** The release marker as stored, parsed. */
        markerFile: () => JSON.parse(server.files.get(lease.RELEASE_FILE)),
        setFile: (name, value) => server.files.set(name, toText(value)),
    };
}

function toText(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

/** sessionStorage over a Map. */
function fakeStorage(content = {}) {
    const map = new Map(Object.entries(content));
    return {
        map,
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => { map.set(key, String(value)); },
        removeItem: (key) => { map.delete(key); },
    };
}

/** sessionStorage that throws (blocked site data). */
function brokenStorage() {
    const fail = () => { throw new Error('SecurityError'); };
    return { map: new Map(), getItem: fail, setItem: fail, removeItem: fail };
}

/**
 * A valid lease file (format 1) with invented values.
 * @param {object} [fields] Fields to override.
 * @returns {object} Lease file content.
 */
function leaseFile(fields = {}) {
    return Object.assign({
        format: 1,
        holder: 'page-a',
        epoch: 3,
        claimedAt: '2026-01-01T00:00:00.000Z',
        busy: false,
        active: { avatar: 'Example Character.png', chatFile: 'Example Chat' },
    }, fields);
}

/**
 * A valid release marker (format 1) with invented values.
 * @param {object} [fields] Fields to override.
 * @returns {object} Marker file content.
 */
function markerFile(fields = {}) {
    return Object.assign({ format: 1, holder: 'page-a', epoch: 3, releasedAt: '2026-01-01T00:00:00.000Z' }, fields);
}

module.exports = {
    createHarness,
    fakeStorage,
    leaseFile,
    markerFile,
    LEASE: lease.LEASE_FILE,
    MARKER: lease.RELEASE_FILE,
    KEYS: lease.STORAGE_KEYS,
};
