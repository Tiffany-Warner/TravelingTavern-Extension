'use strict';

// A fake SillyTavern server for the guard's tests. Invented data only.

const { createSaveGuard } = require('../../save-guard.js');

/**
 * Creates a fake ST server, a guard wired to it, and recorders for posts and requests.
 * @param {object} [options]
 * @param {object} [options.settings] Initial settings file content.
 * @returns {object} Test harness.
 */
function createHarness({ settings = { username: 'User', power_user: { theme: 'dark' } } } = {}) {
    const server = {
        settingsText: JSON.stringify(settings, null, 4),
        failReads: false,
        saveAnswer: null,
    };
    const requests = [];
    const posts = [];
    let clock = 0;

    async function fakeFetch(input, init = {}) {
        const path = new URL(String(input), 'http://localhost/').pathname;
        requests.push({ path, init });
        if (String(init.method).toUpperCase() !== 'POST') return Response.json({ untouched: true });
        if (path.endsWith('/api/settings/get')) {
            if (server.failReads) throw new TypeError('Failed to fetch');
            return Response.json({ settings: server.settingsText });
        }
        if (path.endsWith('/api/settings/save')) {
            if (server.saveAnswer) return Response.json(server.saveAnswer);
            server.settingsText = JSON.stringify(JSON.parse(await bodyText(init)), null, 4);
            return Response.json({ result: 'ok' });
        }
        return Response.json({ untouched: true });
    }

    const guard = createSaveGuard({
        fetch: fakeFetch,
        post: (type, payload) => posts.push({ type, ...payload }),
        now: () => clock,
        log: () => {},
    });

    return {
        guard,
        server,
        requests,
        posts,
        advance: (ms) => { clock += ms; },
        /** ST's settings read at page load. */
        loadSettings: async () => (await guard.handleFetch('/api/settings/get', stRequest({}))).json(),
        /** ST's settings save. */
        saveSettings: async (payload, extra = {}) => guard.handleFetch('/api/settings/save', { ...stRequest(payload), ...extra }),
        /** Another device writing settings directly. */
        otherDeviceWrites: (value) => { server.settingsText = JSON.stringify(value, null, 4); },
        serverSettings: () => JSON.parse(server.settingsText),
        sentSaves: () => requests.filter((r) => r.path.endsWith('/api/settings/save')),
    };
}

/** Request options as ST's getRequestHeaders() builds them. */
function stRequest(body) {
    return {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'test-token' },
        body: JSON.stringify(body),
        cache: 'no-cache',
    };
}

async function bodyText(init) {
    const headers = new Headers(init.headers);
    if (headers.get('Content-Encoding') === 'gzip') {
        const stream = new Blob([init.body]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).text();
    }
    return typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body);
}

/** gzip as ST's request-compression.js sends it. */
async function gzip(text) {
    const stream = new Blob([new TextEncoder().encode(text)]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
}

module.exports = { createHarness, stRequest, gzip };
