'use strict';

// busy (spec E3, E8): a generation request is sent only after `busy: true` is confirmed; `busy: false`
// only when its response is over (body read, closed, error, cancel), never at the headers. Invented data.

const test = require('node:test');
const assert = require('node:assert');
const { isGeneration } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush, track } = require('./helpers/fake-window.cjs');

const GENERATE = '/api/backends/chat-completions/generate';

/** page-a holding the lease at epoch 4 (after a refresh bump). */
async function holderHarness() {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    assert.strictEqual((await h.lease.start()).status, 'holder');
    return h;
}

/** A holder page with the wrapper installed. */
async function holderWindow() {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    w.install();
    await flush();
    return w;
}

/** A streamed reply whose chunks and end the test controls. */
function streamedReply(w) {
    const reply = { controller: null };
    w.server.stResponder = () => new Response(new ReadableStream({ start(c) { reply.controller = c; } }), { status: 200 });
    return reply;
}

const busyUploads = (h) => h.leaseUploads().map((u) => u.value.busy);

test('generation endpoints: any /api/backends/*/generate, NovelAI and Horde text; POST only', () => {
    for (const path of ['/api/backends/chat-completions/generate', '/api/backends/text-completions/generate',
        '/api/backends/kobold/generate', '/api/backends/some-new-backend/generate', '/api/novelai/generate',
        '/api/horde/generate-text', '/st/api/backends/kobold/generate']) {
        assert.strictEqual(isGeneration(path, 'POST'), true, path);
    }
    for (const [path, method] of [[GENERATE, 'GET'], ['/api/backends/a/b/generate', 'POST'], ['/api/sd/generate', 'POST'],
        ['/api/novelai/generate-image', 'POST'], ['/api/horde/generate-image', 'POST'], ['/api/azure/generate', 'POST'],
        ['/api/backends/chat-completions/status', 'POST']]) {
        assert.strictEqual(isGeneration(path, method), false, path);
    }
});

test('begin writes busy true and reports it; end writes busy false', async () => {
    const h = await holderHarness();
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'send' });
    assert.strictEqual(h.leaseFile().busy, true);
    assert.strictEqual(h.posts.at(-1).busy, true);
    await h.lease.endGeneration();
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(h.posts.at(-1).busy, false);
    assert.deepStrictEqual(busyUploads(h).slice(-2), [true, false]);
});

test('overlapping generations share one busy true; busy false only after the last one ends', async () => {
    const h = await holderHarness();
    const [a, b] = await Promise.all([h.lease.beginGeneration(), h.lease.beginGeneration()]);
    assert.deepStrictEqual([a.status, b.status], ['send', 'send']);
    const writesAfterBegin = busyUploads(h).length;
    await h.lease.endGeneration();
    assert.strictEqual(h.leaseFile().busy, true, 'one still running');
    assert.strictEqual(busyUploads(h).length, writesAfterBegin);
    const c = await h.lease.beginGeneration();
    assert.strictEqual(c.status, 'send');
    await h.lease.endGeneration();
    assert.strictEqual(h.leaseFile().busy, true);
    await h.lease.endGeneration();
    assert.strictEqual(h.leaseFile().busy, false);
    assert.deepStrictEqual(busyUploads(h).slice(-2), [true, false]);
});

test('busy true not written after all attempts: abort, replyNotStarted, busy false pending, nothing counted', async () => {
    const h = await holderHarness();
    h.server.failUploads = 3;
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'abort' });
    assert.deepStrictEqual(h.posts.filter((p) => p.type === 'leaseNotice'), [{ type: 'leaseNotice', kind: 'replyNotStarted' }]);
    assert.strictEqual(h.lease.hasPendingBusyClear(), true);
    assert.deepStrictEqual([h.lease.status().generations, h.lease.status().busy, h.lease.status().phase], [0, false, 'holder']);
});

test('pair changed before busy true: the request is held and the page parks (lost), no notice', async () => {
    const h = await holderHarness();
    h.setFile(LEASE, leaseFile({ holder: 'page-b.load', epoch: 9 }));
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'hold' });
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().reason], ['parked', 'lost']);
    assert.strictEqual(h.posts.some((p) => p.type === 'leaseNotice'), false);
});

test('a parked page holds generations; an end after parking writes nothing', async () => {
    const parked = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await parked.lease.start();
    assert.deepStrictEqual(await parked.lease.beginGeneration(), { status: 'hold' });

    const h = await holderHarness();
    await h.lease.beginGeneration();
    h.setFile(LEASE, leaseFile({ holder: 'page-b.load', epoch: 9 }));
    h.lease.park('lost');
    const uploads = h.uploads.length;
    await h.lease.endGeneration();
    assert.strictEqual(h.uploads.length, uploads);
});

test('busy true queued behind the page’s own foreground bump retries with the new pair (no false park)', async () => {
    const h = await holderHarness();
    const me = h.lease.pageId();
    h.setFile(MARKER, markerFile({ holder: me, epoch: 4 }));
    let begin = null;
    h.server.afterUpload = (name) => {
        if (name === LEASE && h.leaseFile().epoch === 5 && begin === null) begin = h.lease.beginGeneration();
    };
    const foreground = await h.lease.onForeground();
    assert.strictEqual(foreground.status, 'holder');
    assert.deepStrictEqual(await begin, { status: 'send' });
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().pair.epoch], ['holder', 5]);
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch, h.leaseFile().busy], [me, 5, true]);
});

test('busy false queued behind the page’s own foreground bump retries with the new pair (no false park)', async () => {
    const h = await holderHarness();
    const me = h.lease.pageId();
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'send' });
    h.setFile(MARKER, markerFile({ holder: me, epoch: 4 }));
    let end = null;
    h.server.afterUpload = (name) => {
        if (name === LEASE && h.leaseFile().epoch === 5 && end === null) end = h.lease.endGeneration();
    };
    assert.strictEqual((await h.lease.onForeground()).status, 'holder');
    await end;
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().pair.epoch], ['holder', 5]);
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [5, false]);
});

test('a reply that ended while released on freeze: resume’s bump writes busy false, not the stale true', async () => {
    const h = await holderHarness();
    await h.lease.beginGeneration();
    assert.strictEqual(h.leaseFile().busy, true);
    await h.lease.release('freeze');
    await h.lease.endGeneration();
    assert.strictEqual(h.leaseFile().busy, true, 'nothing written while released');
    assert.strictEqual((await h.lease.resumeAfterFreeze()).status, 'holder');
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [5, false]);
});

test('a reply still running across freeze and resume keeps busy true in the bump', async () => {
    const h = await holderHarness();
    await h.lease.beginGeneration();
    await h.lease.release('freeze');
    assert.strictEqual((await h.lease.resumeAfterFreeze()).status, 'holder');
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [5, true]);
    await h.lease.endGeneration();
    assert.strictEqual(h.leaseFile().busy, false);
});

test('the foreground bump writes busy from the page’s own generations: a stale busy true is cleared', async () => {
    const h = await holderHarness();
    const me = h.lease.pageId();
    h.setFile(LEASE, leaseFile({ holder: me, epoch: 4, busy: true }));
    h.setFile(MARKER, markerFile({ holder: me, epoch: 4 }));
    assert.strictEqual((await h.lease.onForeground()).status, 'holder');
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [5, false]);
});

test('wrapper: the generation request reaches ST only after busy true is in the lease', async () => {
    const w = await holderWindow();
    const response = await w.win.fetch(GENERATE, { method: 'POST', body: '{}' });
    const sent = w.server.stRequests.find((r) => r.url === GENERATE);
    assert.strictEqual(sent.leaseAtSend.busy, true);
    await response.text();
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: busy stays true after the headers and through the stream; cleared when it closes', async () => {
    const w = await holderWindow();
    const reply = streamedReply(w);
    const response = await w.win.fetch(GENERATE, { method: 'POST', body: '{}' });
    const reader = response.body.getReader();
    reply.controller.enqueue(new TextEncoder().encode('data: one\n\n'));
    await reader.read();
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, true, 'not at the headers or the first chunk');
    assert.strictEqual(w.events.filter((e) => e.type === 'leaseState').at(-1).busy, true);
    reply.controller.close();
    assert.strictEqual((await reader.read()).done, true);
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
    assert.strictEqual(w.events.filter((e) => e.type === 'leaseState').at(-1).busy, false);
});

test('wrapper: Stop (the read cancelled) and a stream error both clear busy', async () => {
    const w = await holderWindow();
    let reply = streamedReply(w);
    let response = await w.win.fetch(GENERATE, { method: 'POST', body: '{}' });
    await response.body.getReader().cancel();
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false, 'cancel');

    reply = streamedReply(w);
    response = await w.win.fetch(GENERATE, { method: 'POST', body: '{}' });
    const reader = response.body.getReader();
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, true);
    reply.controller.error(new Error('connection lost'));
    await assert.rejects(reader.read());
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false, 'error');
});

test('wrapper: a request that fails clears busy', async () => {
    const w = await holderWindow();
    w.server.stResponder = () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(w.win.fetch(GENERATE, { method: 'POST', body: '{}' }), TypeError);
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: busy true not written → AbortError, never sent, leaseNotice replyNotStarted as tt-lease', async () => {
    const w = await holderWindow();
    w.server.failUploads = 3;
    await assert.rejects(w.win.fetch(GENERATE, { method: 'POST', body: '{}' }), (error) => error.name === 'AbortError');
    assert.strictEqual(w.server.stRequests.some((r) => r.url === GENERATE), false);
    assert.deepStrictEqual(w.events.filter((e) => e.type === 'leaseNotice'), [{ type: 'leaseNotice', kind: 'replyNotStarted' }]);
});

test('wrapper: other requests never set busy (dry runs send no generation request)', async () => {
    const w = await holderWindow();
    await w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' });
    await w.win.fetch('/api/backends/chat-completions/status', { method: 'POST', body: '{}' });
    await flush();
    assert.strictEqual(w.harness.leaseUploads().some((u) => u.value.busy === true), false);
});

test('wrapper: a generation XHR is sent after busy true and clears it on loadend', async () => {
    const w = await holderWindow();
    const xhr = w.newXhr();
    xhr.open('POST', GENERATE);
    xhr.send('{}');
    await flush();
    assert.strictEqual(xhr.sent, true);
    assert.strictEqual(w.harness.leaseFile().busy, true);
    xhr.fire('loadend');
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: a parked page holds a generation request; it never settles and sets no busy', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, storage: { 'tt-lease-tab-id': 'page-c' }, source: 'extension' });
    w.install();
    await flush();
    const request = track(w.win.fetch(GENERATE, { method: 'POST', body: '{}' }));
    await flush();
    assert.strictEqual(request.settled(), false);
    assert.strictEqual(w.server.stRequests.some((r) => r.url === GENERATE), false);
    assert.strictEqual(w.harness.leaseFile().busy, false);
});
