'use strict';

// The request wrapper (spec E6, E7): what counts as server data, holder vs parked, the 2 s read
// window, the allowlist, held requests, aborting only chat saves.

const test = require('node:test');
const assert = require('node:assert');
const lease = require('../session-lease.js');
const { createHarness, leaseFile, LEASE } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush, track } = require('./helpers/fake-window.cjs');

const { requestPath, requestMethod, isServerData, isAllowlisted, isChatSave, isCsrfTokenRequest, decideRequest, createHeldRegistry, holdFetch } = lease;
const abortError = () => new DOMException('held', 'AbortError');

test('requestPath: lower-case, no trailing slashes, from strings, URLs and Requests', () => {
    assert.strictEqual(requestPath('/API/Chats/Save/'), '/api/chats/save');
    assert.strictEqual(requestPath('http://localhost/api/settings/get?x=1'), '/api/settings/get');
    assert.strictEqual(requestPath(new URL('http://localhost/user/files/a.json')), '/user/files/a.json');
    assert.strictEqual(requestPath(new Request('http://localhost/api/x//')), '/api/x');
});

test('requestMethod: init overrides a Request', () => {
    assert.strictEqual(requestMethod('/x'), 'GET');
    assert.strictEqual(requestMethod('/x', { method: 'post' }), 'POST');
    assert.strictEqual(requestMethod(new Request('http://localhost/x', { method: 'PUT' })), 'PUT');
    assert.strictEqual(requestMethod(new Request('http://localhost/x', { method: 'PUT' }), { method: 'DELETE' }), 'DELETE');
});

test('server data: /api/ or /user/ paths, or any method other than GET', () => {
    assert.strictEqual(isServerData('/api/settings/get', 'GET'), true);
    assert.strictEqual(isServerData('/user/files/stmb-x.json', 'GET'), true);
    assert.strictEqual(isServerData('/scripts/extensions/third-party/x/index.js', 'GET'), false);
    assert.strictEqual(isServerData('/characters/example.png', 'GET'), false);
    assert.strictEqual(isServerData('/user%20avatars/a.png', 'GET'), false);
    assert.strictEqual(isServerData('/version', 'GET'), false);
    assert.strictEqual(isServerData('/anything', 'POST'), true);
    assert.strictEqual(isServerData('/anything', 'HEAD'), true);
    assert.strictEqual(isServerData('/proxy/api/x', 'GET'), true, 'an /api/ segment anywhere counts');
});

test('allowlist: confirmed reads only; backgrounds/all is not on it; * is one segment', () => {
    for (const path of ['/api/settings/get', '/api/chats/get', '/api/tokenizers/llama3/encode', '/api/tokenizers/openai/count', '/api/sd/comfy/workflows']) {
        assert.strictEqual(isAllowlisted(path), true, path);
    }
    for (const path of ['/api/backgrounds/all', '/api/settings/save', '/api/chats/save', '/api/tokenizers/remote/kobold/count', '/api/tokenizers/encode', '/api/files/upload']) {
        assert.strictEqual(isAllowlisted(path), false, path);
    }
});

test('chat saves and the CSRF token request are recognized', () => {
    assert.strictEqual(isChatSave('/api/chats/save'), true);
    assert.strictEqual(isChatSave('/api/chats/group/save'), true);
    assert.strictEqual(isChatSave('/api/chats/get'), false);
    assert.strictEqual(isCsrfTokenRequest('/csrf-token', 'GET'), true);
    assert.strictEqual(isCsrfTokenRequest('/csrf-token', 'POST'), false);
});

test('decideRequest: wait before the decision, hold when parked, 2 s window for reads in the holder', () => {
    const holder = { phase: 'holder', allowlisted: false };
    assert.strictEqual(decideRequest({ phase: 'deciding', method: 'GET', allowlisted: false, readAgeMs: 0 }), 'wait');
    assert.strictEqual(decideRequest({ phase: 'parked', method: 'GET', allowlisted: true, readAgeMs: 0 }), 'hold');
    assert.strictEqual(decideRequest({ ...holder, method: 'GET', readAgeMs: 2000 }), 'send');
    assert.strictEqual(decideRequest({ ...holder, method: 'GET', readAgeMs: 2001 }), 'check');
    assert.strictEqual(decideRequest({ ...holder, method: 'POST', readAgeMs: 0 }), 'check', 'writes always re-read');
    assert.strictEqual(decideRequest({ ...holder, method: 'POST', allowlisted: true, readAgeMs: 100 }), 'send');
    assert.strictEqual(decideRequest({ ...holder, method: 'POST', allowlisted: true, readAgeMs: 2500 }), 'check');
});

test('held registry: only chat saves are aborted before a reload', () => {
    const held = createHeldRegistry(abortError);
    const rejected = [];
    held.add('/api/chats/save', (e) => rejected.push(['chat', e.name]));
    held.add('/api/chats/group/save', (e) => rejected.push(['group', e.name]));
    held.add('/user/files/stmb-side-prompts.json', () => rejected.push(['read']));
    held.add('/api/settings/save', () => rejected.push(['settings']));
    assert.strictEqual(held.abortChatSaves(), 2);
    assert.deepStrictEqual(rejected, [['chat', 'AbortError'], ['group', 'AbortError']]);
    assert.strictEqual(held.size(), 2, 'reads and other writes stay held');
});

test('a held fetch never settles; its own abort signal rejects it with AbortError and removes it', async () => {
    const held = createHeldRegistry(abortError);
    const quiet = track(holdFetch(held, '/api/settings/save', null, abortError));
    const controller = new AbortController();
    const stoppable = track(holdFetch(held, '/api/backends/chat-completions/generate', controller.signal, abortError));
    await flush(5);
    assert.strictEqual(quiet.settled(), false);
    assert.strictEqual(held.size(), 2);
    controller.abort();
    await flush(5);
    assert.strictEqual(stoppable.result().error.name, 'AbortError');
    assert.strictEqual(held.size(), 1);
    assert.strictEqual(quiet.settled(), false);
});

test('a fetch whose signal is already aborted is rejected and never kept', async () => {
    const held = createHeldRegistry(abortError);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(holdFetch(held, '/api/x', controller.signal, abortError), { name: 'AbortError' });
    assert.strictEqual(held.size(), 0);
});

// ---- The gate, through the core ----

async function holder(fields = {}) {
    const h = createHarness({ files: { [LEASE]: leaseFile(Object.assign({ holder: 'page-a', epoch: 3 }, fields)) } });
    assert.strictEqual((await h.lease.start()).status, 'holder');
    h.lease.setStVersion('1.19.1');
    return h;
}

test('holder: a fresh GET is sent without a lease read; a POST re-reads first', async () => {
    const h = await holder();
    const before = h.server.leaseReads;
    assert.strictEqual(await h.lease.gate('/api/whatever', 'GET'), 'send');
    assert.strictEqual(h.server.leaseReads, before);
    assert.strictEqual(await h.lease.gate('/api/settings/save', 'POST'), 'send');
    assert.strictEqual(h.server.leaseReads, before + 1);
});

test('holder: a write after another page claimed is held and the page parks (lost)', async () => {
    const h = await holder();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    assert.strictEqual(await h.lease.gate('/api/settings/save', 'POST'), 'hold');
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().reason], ['parked', 'lost']);
    assert.strictEqual(await h.lease.gate('/api/settings/get', 'POST'), 'hold', 'everything is held from then on');
});

test('holder: a lease read that fails parks the page and holds the request (fail closed)', async () => {
    const h = await holder();
    h.server.failLeaseReads = 1;
    assert.strictEqual(await h.lease.gate('/api/chats/save', 'POST'), 'hold');
    assert.strictEqual(h.lease.status().reason, 'unreadable');
});

test('holder: allowlisted reads and GETs within 2 s skip the check; after 2 s they re-read', async () => {
    const h = await holder();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    h.advance(2000);
    assert.strictEqual(await h.lease.gate('/api/settings/get', 'POST'), 'send', 'trusted read window');
    assert.strictEqual(await h.lease.gate('/user/files/example.json', 'GET'), 'send');
    h.advance(1);
    assert.strictEqual(await h.lease.gate('/api/settings/get', 'POST'), 'hold');
    assert.strictEqual(h.lease.status().reason, 'lost');
});

test('holder on an untested ST version: the allowlist is off, every POST re-reads', async () => {
    const h = await holder();
    h.lease.setStVersion('1.20.0');
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    assert.strictEqual(await h.lease.gate('/api/settings/get', 'POST'), 'hold');
});

test('allowlist off until ST’s version is known', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    await h.lease.start();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    assert.strictEqual(await h.lease.gate('/api/settings/get', 'POST'), 'hold');
});

test('requests wait for the start decision: sent if holder, held if parked', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    const verdict = h.lease.gate('/api/settings/get', 'POST'); // starts the decision itself
    assert.strictEqual(await verdict, 'hold');

    const own = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) } });
    const early = own.lease.gate('/api/settings/save', 'POST');
    assert.strictEqual(own.lease.status().phase, 'deciding');
    assert.strictEqual(await early, 'send');
});

test('concurrent checks share one lease read', async () => {
    const h = await holder();
    const before = h.server.leaseReads;
    const verdicts = await Promise.all([1, 2, 3, 4].map(() => h.lease.gate('/api/settings/save', 'POST')));
    assert.deepStrictEqual(verdicts, ['send', 'send', 'send', 'send']);
    assert.strictEqual(h.server.leaseReads, before + 1);
});

test('a pending busy false is written with the next lease check; the file ends busy false', async () => {
    const h = await holder();
    const pair = h.lease.status().pair;
    // A busy: true whose last attempt landed despite its error answer: the file says busy, the clear is pending.
    h.server.failUploads = 2;
    h.server.failAfterWrite = 1;
    assert.deepStrictEqual(await h.lease.updateLease(pair, { busy: true }), { status: 'failed' });
    assert.strictEqual(h.leaseFile().busy, true);
    assert.strictEqual(h.lease.hasPendingBusyClear(), true);
    assert.strictEqual(await h.lease.gate('/api/settings/save', 'POST'), 'send');
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(h.lease.hasPendingBusyClear(), false);
});

// ---- Through the installed wrapper (fake window) ----

test('parked page: server-data fetches and XHRs are held and never reach the server; static files load', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.install();
    const save = track(w.win.fetch('/api/settings/save', { method: 'POST', body: '{}' }));
    const read = track(w.win.fetch('/user/files/stmb-side-prompts.json'));
    const script = await w.win.fetch('/scripts/extensions/third-party/example/index.js');
    const xhr = w.newXhr();
    xhr.open('POST', '/api/tokenizers/openai/count');
    xhr.send('{}');
    await flush();
    assert.strictEqual(save.settled(), false);
    assert.strictEqual(read.settled(), false);
    assert.strictEqual(script.ok, true);
    assert.strictEqual(xhr.sent, undefined);
    assert.deepStrictEqual(w.server.stRequests.map((r) => r.url), ['/scripts/extensions/third-party/example/index.js']);
    assert.strictEqual(w.win.navigator.sendBeacon('/api/x', 'data'), false);
    assert.deepStrictEqual(w.beacons, []);
});

test('holder page: server-data requests are sent after the start decision', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) } });
    w.install();
    const response = await w.win.fetch('/api/settings/save', { method: 'POST', body: '{}' });
    assert.strictEqual(response.ok, true);
    const xhr = w.newXhr();
    xhr.open('POST', '/api/tokenizers/openai/count');
    xhr.send('{}');
    await flush();
    assert.strictEqual(xhr.sent, true);
    assert.deepStrictEqual(w.server.stRequests.map((r) => r.url), ['/api/settings/save', '/api/tokenizers/openai/count']);
    assert.strictEqual(w.win.navigator.sendBeacon('/api/x', 'data'), true);
});

test('Use here: held chat saves are aborted before the reload; held reads stay pending; nothing held is sent', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.install();
    await flush();
    const chat = track(w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' }));
    const read = track(w.win.fetch('/user/files/stmb-context-settings.json'));
    await w.win.__ttLease.useHere();
    await flush();
    assert.strictEqual(w.win.location.reloads, 1);
    assert.strictEqual(chat.result().error.name, 'AbortError');
    assert.strictEqual(read.settled(), false);
    assert.deepStrictEqual(w.server.stRequests, []);
});

test('the wrapper’s own lease reads and writes use the original fetch (nothing passes by URL while parked)', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.install();
    await flush();
    const upload = track(w.win.fetch('/api/files/upload', { method: 'POST', body: JSON.stringify({ name: 'tt-session-lease.json', data: '' }) }));
    const leaseRead = track(w.win.fetch('/user/files/tt-session-lease.json'));
    await flush();
    assert.strictEqual(upload.settled(), false, 'a page upload of the lease file is held like any other');
    assert.strictEqual(leaseRead.settled(), false);
    assert.strictEqual(w.harness.leaseFile().holder, 'page-b');
});
