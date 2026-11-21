'use strict';

// A fake SillyTavern server holding the two lease files, for the lease's tests. Invented data only.

const lease = require('../../session-lease.js');

/**
 * Creates a fake server, a lease wired to it, and recorders.
 * @param {object} [options]
 * @param {object} [options.files] Initial files by name: an object (stored as JSON) or a raw string.
 * @returns {object} Test harness.
 */
function createHarness({ files = {} } = {}) {
    const server = {
        /** File contents by name, as text. */
        files: new Map(Object.entries(files).map(([name, value]) => [name, toText(value)])),
        /** Answer status for reads of a file name (e.g. 500), instead of its content. */
        readStatus: new Map(),
        /** Reads throw a network error while true. */
        offline: false,
        /** Number of upcoming uploads answered 500 without writing (Windows EPERM). */
        failUploads: 0,
        /** Uploads answered 500 after writing (the write landed, the answer says it didn't). */
        failAfterWrite: 0,
        /** Called before each upload is applied; may change server state (another page writing). */
        beforeUpload: null,
    };
    const uploads = [];
    const sleeps = [];
    const logs = [];
    let inFlight = 0;
    let maxInFlight = 0;

    async function fakeFetch(url, init = {}) {
        if (server.offline) throw new TypeError('Failed to fetch');
        const method = String(init.method || 'GET').toUpperCase();
        if (method === 'GET' && url.startsWith(lease.USER_FILES_PATH)) return answerRead(url.slice(lease.USER_FILES_PATH.length));
        if (method === 'POST' && url === lease.UPLOAD_PATH) return answerUpload(JSON.parse(init.body));
        return new Response('not found', { status: 404 });
    }

    function answerRead(name) {
        if (server.readStatus.has(name)) return new Response('error', { status: server.readStatus.get(name) });
        if (!server.files.has(name)) return new Response('Not Found', { status: 404 });
        return new Response(server.files.get(name), { status: 200 });
    }

    async function answerUpload({ name, data }) {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        try {
            if (server.beforeUpload) server.beforeUpload(name);
            const text = Buffer.from(data, 'base64').toString('utf8');
            uploads.push({ name, value: JSON.parse(text) });
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

    const instance = lease.createSessionLease({
        fetch: fakeFetch,
        now: () => Date.UTC(2026, 0, 1),
        sleep: async (ms) => { sleeps.push(ms); },
        log: (level, message, details) => logs.push({ level, message, details }),
    });

    return {
        lease: instance,
        server,
        uploads,
        sleeps,
        logs,
        maxInFlight: () => maxInFlight,
        /** The lease file as stored, parsed. */
        leaseFile: () => JSON.parse(server.files.get(lease.LEASE_FILE)),
        setFile: (name, value) => server.files.set(name, toText(value)),
    };
}

function toText(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
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

module.exports = { createHarness, leaseFile, markerFile, LEASE: lease.LEASE_FILE, MARKER: lease.RELEASE_FILE };
