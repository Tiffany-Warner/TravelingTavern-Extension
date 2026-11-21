'use strict';

// Reloads after a claim (spec E7): held chat saves are aborted and ST's handlers run before the
// reload; a reload that didn't happen ends in reloadPending, never a permanent claiming.

const test = require('node:test');
const assert = require('node:assert');
const { leaseFile, LEASE, createHarness } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush } = require('./helpers/fake-window.cjs');

test('held chat saves are rejected and their handlers run before location.reload()', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    const order = [];
    w.win.location.reload = () => { order.push('reload'); };
    w.install();
    await flush();
    // ST's saveChatConditional: isChatSaving is cleared in a handler of the save's promise.
    w.win.fetch('/api/chats/save', { method: 'POST', body: '{}' })
        .catch((error) => { order.push('st clears isChatSaving: ' + error.name); });
    await w.win.__ttLease.useHere();
    await flush();
    assert.deepStrictEqual(order, ['st clears isChatSaving: AbortError', 'reload']);
});

test('a cancelled reload ends in reloadPending, never a permanent claiming', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    let reloads = 0;
    w.win.location.reload = () => { reloads++; }; // the page stays alive: beforeunload cancelled it
    w.install();
    await flush();
    await w.win.__ttLease.useHere();
    await flush();
    assert.strictEqual(reloads, 1);
    const reasons = w.events.filter((e) => e.type === 'leaseState').map((e) => e.reason);
    assert.deepStrictEqual(reasons, ['held', 'claiming', 'reloadPending']);
    // Use here is not offered again: the claim is in the lease; the user's Reload finishes it.
    const uploads = w.harness.uploads.length;
    await w.win.__ttLease.useHere();
    await w.win.__ttLease.onForeground();
    await flush();
    assert.strictEqual(w.harness.uploads.length, uploads);
});

test('a reloadPending page still holds every request', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.win.location.reload = () => {};
    w.install();
    await flush();
    await w.win.__ttLease.useHere();
    await flush();
    let settled = false;
    w.win.fetch('/api/settings/save', { method: 'POST' }).then(() => { settled = true; }, () => { settled = true; });
    await flush();
    assert.strictEqual(settled, false);
    assert.deepStrictEqual(w.server.stRequests, []);
});

test('the reload that follows (the user’s Reload) decides afresh: this tab’s claim makes it holder', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    w.win.location.reload = () => {};
    w.install();
    await flush();
    await w.win.__ttLease.useHere();
    await flush();
    const reloaded = createFakeWindow({ harness: w.harness, storage: Object.fromEntries(w.win.sessionStorage.map) });
    reloaded.install();
    await flush();
    assert.strictEqual(reloaded.events.find((e) => e.type === 'leaseState').state, 'holder');
});

test('core: reloadPending parks with that reason and clears claiming', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    await h.lease.useHere();
    assert.strictEqual(h.lease.status().claiming, true);
    h.lease.reloadPending();
    assert.deepStrictEqual([h.lease.status().reason, h.lease.status().claiming], ['reloadPending', false]);
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'ignored' });
});
