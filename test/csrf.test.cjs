'use strict';

// The lease's own CSRF token (spec E6): carried by lease writes, fetched again once on 403, and ST's
// own /csrf-token sent only after the lease's fetch (at most 2 s later).

const test = require('node:test');
const assert = require('node:assert');
const { createCsrfClient, CSRF_ORDER_MAX_WAIT_MS, LEASE_FETCH_TIMEOUT_MS } = require('../session-lease.js');
const { leaseFile, LEASE } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush, track } = require('./helpers/fake-window.cjs');

test('lease writes carry the token the lease fetched itself', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.server.csrfToken = 'test-token-1';
    w.install();
    await flush();
    await w.win.__ttLease.useHere();
    await flush();
    assert.strictEqual(w.win.location.reloads, 1, 'the claim was accepted (403 otherwise)');
    assert.match(w.harness.leaseFile().holder, /^page-a\./);
});

test('a 403 fetches the token again once and resends', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.server.csrfToken = 'old-token';
    w.install();
    await flush();
    w.server.csrfToken = 'new-token'; // the session's token changed
    const before = w.server.tokenRequests;
    await w.win.__ttLease.useHere();
    await flush();
    assert.strictEqual(w.server.tokenRequests, before + 1);
    assert.strictEqual(w.win.location.reloads, 1);
});

test('ST’s /csrf-token waits for the lease’s own token fetch, then is sent', async () => {
    let release;
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.server.tokenDelay = new Promise((resolve) => { release = resolve; });
    w.win.setTimeout = (fn, ms) => setTimeout(fn, ms); // real timing: the 2 s cap must not fire here
    w.install();
    const stToken = track(w.win.fetch('/csrf-token'));
    await flush(20);
    assert.strictEqual(w.server.tokenRequests, 1, 'only the lease’s request so far');
    assert.strictEqual(stToken.settled(), false);
    release();
    await flush(20);
    assert.strictEqual(w.server.tokenRequests, 2);
    assert.strictEqual(stToken.settled(), true);
});

test('ST’s /csrf-token is released after at most 2 s even if the lease’s fetch hangs', async () => {
    const timers = [];
    const fetches = [];
    const client = createCsrfClient({
        fetch: (url) => { fetches.push(url); return new Promise(() => {}); },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {},
        log: () => {},
    });
    const waited = track(client.afterOwnToken());
    await flush(5);
    assert.strictEqual(waited.settled(), false);
    assert.deepStrictEqual(timers.map((t) => t.ms).sort((a, b) => a - b), [CSRF_ORDER_MAX_WAIT_MS, LEASE_FETCH_TIMEOUT_MS]);
    timers.find((t) => t.ms === CSRF_ORDER_MAX_WAIT_MS).fn();
    await flush(5);
    assert.strictEqual(waited.settled(), true);
    assert.deepStrictEqual(fetches, ['/csrf-token']);
});

test('a hung token fetch ends at the lease I/O bound (10 s), so lease writes don’t wait for it forever', async () => {
    const timers = [];
    const sent = [];
    const client = createCsrfClient({
        fetch: (url, init = {}) => {
            if (url === '/csrf-token') return new Promise(() => {});
            sent.push(new Headers(init.headers).get('X-CSRF-Token'));
            return Promise.resolve(new Response('ok', { status: 200 }));
        },
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        clearTimeout: () => {},
        log: () => {},
    });
    const write = track(client.leaseFetch('/api/files/upload', { method: 'POST' }));
    await flush(5);
    assert.strictEqual(write.settled(), false, 'waits for the token fetch');
    timers.find((t) => t.ms === LEASE_FETCH_TIMEOUT_MS).fn();
    await flush(5);
    assert.strictEqual(write.settled(), true);
    assert.deepStrictEqual(sent, [null], 'sent without a token (ST refuses it: fail closed)');
});

test('a failed token fetch releases ST’s request at once and lease writes go out without a token (refused: fail closed)', async () => {
    const client = createCsrfClient({
        fetch: async (url, init = {}) => {
            if (url === '/csrf-token') throw new TypeError('Failed to fetch');
            return new Response('Invalid CSRF token', { status: init.headers && new Headers(init.headers).has('X-CSRF-Token') ? 200 : 403 });
        },
        setTimeout: () => 1,
        clearTimeout: () => {},
        log: () => {},
    });
    await client.afterOwnToken();
    const response = await client.leaseFetch('/api/files/upload', { method: 'POST', body: '{}' });
    assert.strictEqual(response.status, 403);
});
