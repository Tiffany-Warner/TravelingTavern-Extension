'use strict';

// busy (spec E3, E8): a generation request is sent only after `busy: true` is confirmed; `busy: false`
// only when its response is over (body read, closed, error, cancel), never at the headers, and then
// only after a chat save started since has completed (at most 3 s). Invented data.

const test = require('node:test');
const assert = require('node:assert');
const { isGeneration, SAVE_WAIT_MAX_MS } = require('../session-lease.js');
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

/** Holds the save wait's 3 s limit until the test fires it. */
function holdSaveLimit(h) {
    const limit = {};
    limit.reached = new Promise((resolve) => { limit.fire = resolve; });
    h.server.sleepGate = (ms) => (ms === SAVE_WAIT_MAX_MS ? limit.reached : null);
    return limit;
}

const limitWarnings = (h) => h.logs.filter((l) => l.message === 'no chat save after the reply: busy cleared at the limit');

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

// ---- busy until the chat save after the reply (spec E8) ---------------------------------------

test('save wait: busy stays true after the reply ends, until a chat save started since completes', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    const end = h.lease.endGeneration({ path: GENERATE });
    await flush();
    assert.strictEqual(h.leaseFile().busy, true, 'not at the end of the reply');
    assert.strictEqual(h.lease.status().awaitingChatSave, true);
    assert.strictEqual(h.posts.at(-1).busy, true, 'leaseState.busy stays true');
    const save = h.lease.chatSaveMark();
    await flush();
    assert.strictEqual(h.leaseFile().busy, true, 'not when the save starts');
    h.lease.chatSaveDone(save);
    await end;
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(h.posts.at(-1).busy, false);
    assert.strictEqual(h.lease.status().awaitingChatSave, false);
    assert.strictEqual(limitWarnings(h).length, 0);
    limit.fire();
    await flush();
    assert.deepStrictEqual(busyUploads(h).slice(-2), [true, false], 'the limit writes nothing more');
});

test('save wait: a save that started before the reply ended does not count', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    const userMessageSave = h.lease.chatSaveMark();
    const end = h.lease.endGeneration({ path: GENERATE });
    h.lease.chatSaveDone(userMessageSave);
    await flush();
    assert.strictEqual(h.leaseFile().busy, true);
    limit.fire();
    await end;
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(limitWarnings(h).length, 1);
});

test('save wait: no chat save → busy false at 3 s, one warning with the path and reason only', async () => {
    const h = await holderHarness();
    await h.lease.beginGeneration();
    await h.lease.endGeneration({ path: GENERATE });
    assert.strictEqual(h.sleeps.at(-1), SAVE_WAIT_MAX_MS);
    assert.strictEqual(h.leaseFile().busy, false);
    const warnings = limitWarnings(h);
    assert.strictEqual(warnings.length, 1);
    assert.strictEqual(warnings[0].level, 'warn');
    assert.deepStrictEqual(Object.keys(warnings[0].details).sort(), ['path', 'reason']);
    assert.strictEqual(warnings[0].details.path, GENERATE);
});

test('save wait: a new reply meanwhile keeps busy true; the wait starts again after it ends', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    const firstEnd = h.lease.endGeneration({ path: GENERATE });
    const savedDuringSecond = h.lease.chatSaveMark();
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'send' });
    await firstEnd;
    h.lease.chatSaveDone(savedDuringSecond);
    limit.fire();
    await flush();
    assert.strictEqual(h.leaseFile().busy, true, 'the first wait was dropped: neither its save nor its limit clears');
    assert.deepStrictEqual([h.lease.status().generations, h.lease.status().busy], [1, true]);
    const limit2 = holdSaveLimit(h);
    const secondEnd = h.lease.endGeneration({ path: GENERATE });
    await flush();
    h.lease.chatSaveDone(savedDuringSecond);
    await flush();
    assert.strictEqual(h.leaseFile().busy, true, 'a save from before the second end does not count');
    h.lease.chatSaveDone(h.lease.chatSaveMark());
    await secondEnd;
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(limitWarnings(h).length, 0);
    limit2.fire();
});

test('save wait: a page that parks meanwhile writes nothing', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    const end = h.lease.endGeneration({ path: GENERATE });
    await flush();
    h.setFile(LEASE, leaseFile({ holder: 'page-b.load', epoch: 9, busy: false }));
    h.lease.park('lost');
    const uploads = h.uploads.length;
    h.lease.chatSaveDone(h.lease.chatSaveMark());
    await end;
    limit.fire();
    await flush();
    assert.strictEqual(h.uploads.length, uploads);
    assert.strictEqual(h.lease.status().busy, false);
});

test('save wait: overlapping replies wait for a save after the last one ends', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await Promise.all([h.lease.beginGeneration(), h.lease.beginGeneration()]);
    await h.lease.endGeneration({ path: GENERATE });
    h.lease.chatSaveDone(h.lease.chatSaveMark());
    const end = h.lease.endGeneration({ path: GENERATE });
    await flush();
    assert.strictEqual(h.leaseFile().busy, true, 'a save between the two ends does not count');
    h.lease.chatSaveDone(h.lease.chatSaveMark());
    await end;
    assert.strictEqual(h.leaseFile().busy, false);
    limit.fire();
});

test('save wait: an epoch bump meanwhile (resume after freeze) keeps busy true', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    const end = h.lease.endGeneration({ path: GENERATE });
    await h.lease.release('freeze');
    assert.strictEqual((await h.lease.resumeAfterFreeze()).status, 'holder');
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [5, true]);
    h.lease.chatSaveDone(h.lease.chatSaveMark());
    await end;
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [5, false]);
    limit.fire();
});

test('save wait: a new reply that parks instead of starting leaves leaseState.busy false', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    h.lease.endGeneration({ path: GENERATE });
    await flush();
    h.server.failLeaseReads = 3;
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'hold' });
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().busy], ['parked', false]);
    assert.strictEqual(h.posts.filter((p) => p.type === 'leaseState').at(-1).busy, false);
    limit.fire();
});

/** A holder window whose ST answers chat saves with `saveStatus` and streams generations. */
async function holderWindowWithSaves({ saveStatus = 200 } = {}) {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension', holdTimer: SAVE_WAIT_MAX_MS });
    w.install();
    await flush();
    const reply = { controller: null, busyAtSave: [] };
    w.server.stResponder = (url) => {
        if (url === '/api/chats/save') {
            reply.busyAtSave.push(w.harness.leaseFile().busy);
            return Response.json({ ok: saveStatus === 200 }, { status: saveStatus });
        }
        return new Response(new ReadableStream({ start(c) { reply.controller = c; } }), { status: 200 });
    };
    return { w, reply };
}

/** Sends a generation through the wrapper and ends its stream. */
async function finishedReply(w, reply) {
    const response = await w.win.fetch(GENERATE, { method: 'POST', body: '{}' });
    reply.controller.close();
    await response.text();
    await flush();
}

test('wrapper: busy stays true after the stream closes; ST’s chat save after it is sent with busy true and clears it', async () => {
    const { w, reply } = await holderWindowWithSaves();
    await w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' });
    await finishedReply(w, reply);
    assert.strictEqual(w.harness.leaseFile().busy, true, 'the user message’s save from before does not count');
    await w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' });
    await flush();
    assert.deepStrictEqual(reply.busyAtSave, [false, true]);
    assert.strictEqual(w.harness.leaseFile().busy, false);
    assert.strictEqual(w.events.filter((e) => e.type === 'leaseState').at(-1).busy, false);
});

test('wrapper: a chat save answered with an error status still clears busy', async () => {
    const { w, reply } = await holderWindowWithSaves({ saveStatus: 500 });
    await finishedReply(w, reply);
    const save = await w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' });
    assert.strictEqual(save.status, 500);
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: a chat save that fails to send still clears busy', async () => {
    const { w, reply } = await holderWindowWithSaves();
    await finishedReply(w, reply);
    w.server.stResponder = () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' }), TypeError);
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: no chat save after the reply → busy false when the 3 s limit fires', async () => {
    const { w, reply } = await holderWindowWithSaves();
    await finishedReply(w, reply);
    assert.strictEqual(w.harness.leaseFile().busy, true);
    assert.strictEqual(w.heldTimers(), 1);
    w.fireHeldTimers();
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: the headers fallback (Response not rebuilt) still writes busy false at once, no save wait', async () => {
    const { w } = await holderWindowWithSaves();
    w.win.Response = function () { throw new TypeError('no Response'); };
    w.server.stResponder = () => new Response(new ReadableStream({ start() {} }), { status: 200 });
    await w.win.fetch(GENERATE, { method: 'POST', body: '{}' });
    await flush();
    assert.strictEqual(w.heldTimers(), 0, 'no save wait');
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('save wait: a page no longer holder when the reply ends doesn’t wait (its save is held): busy false at once, no warning', async () => {
    const h = await holderHarness();
    holdSaveLimit(h);
    await h.lease.beginGeneration();
    h.lease.park('lost');
    const uploads = h.uploads.length;
    await h.lease.endGeneration({ path: GENERATE });
    assert.strictEqual(h.lease.status().awaitingChatSave, false);
    assert.strictEqual(h.posts.filter((p) => p.type === 'leaseState').at(-1).busy, false);
    assert.strictEqual(h.uploads.length, uploads);
    assert.strictEqual(limitWarnings(h).length, 0);
});

test('save wait: a new reply that can’t write busy true aborts; the wait is gone, busy false pending, not reported busy', async () => {
    const h = await holderHarness();
    const limit = holdSaveLimit(h);
    await h.lease.beginGeneration();
    h.lease.endGeneration({ path: GENERATE });
    await flush();
    // Contrived: busy false in the file, so the new reply's busy true must be written, and it fails.
    h.setFile(LEASE, Object.assign(h.leaseFile(), { busy: false }));
    h.server.failUploads = 3;
    assert.deepStrictEqual(await h.lease.beginGeneration(), { status: 'abort' });
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().busy, h.lease.status().awaitingChatSave], ['holder', false, false]);
    assert.strictEqual(h.posts.filter((p) => p.type === 'leaseState').at(-1).busy, false);
    assert.strictEqual(h.lease.hasPendingBusyClear(), true);
    limit.fire();
});

test('wrapper: a group chat save after the reply ends the wait too', async () => {
    const { w, reply } = await holderWindowWithSaves();
    await finishedReply(w, reply);
    assert.strictEqual(w.harness.leaseFile().busy, true);
    w.server.stResponder = () => Response.json({ ok: true });
    await w.win.fetch('/api/chats/group/save', { method: 'POST', body: '{}' });
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});

test('wrapper: a generation XHR waits for the chat save after loadend', async () => {
    const { w } = await holderWindowWithSaves();
    const xhr = w.newXhr();
    xhr.open('POST', GENERATE);
    xhr.send('{}');
    await flush();
    xhr.fire('loadend');
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, true, 'not at loadend');
    await w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' });
    await flush();
    assert.strictEqual(w.harness.leaseFile().busy, false);
});
