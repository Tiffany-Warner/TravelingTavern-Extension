'use strict';

// Release on pagehide or freeze, the back/forward cache, and the check on resume after a freeze (spec E5).

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, leaseFile, LEASE, MARKER, KEYS } = require('./helpers/fake-server.cjs');

/** page-a holding the lease at epoch 4 (after a refresh bump). */
async function holderHarness() {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    assert.strictEqual((await h.lease.start()).status, 'holder');
    return h;
}

test('the holder writes a marker naming its exact pair, with keepalive, and never touches the lease', async () => {
    const h = await holderHarness();
    const leaseBefore = h.leaseFile();
    const uploadsBefore = h.uploads.length;
    assert.strictEqual(await h.lease.release(), true);
    const sent = h.uploads.slice(uploadsBefore);
    assert.deepStrictEqual(sent.map((u) => [u.name, u.keepalive]), [[MARKER, true]]);
    assert.deepStrictEqual(h.markerFile(), { format: 1, holder: h.lease.pageId(), epoch: 4, releasedAt: '2026-01-01T00:00:01.000Z' });
    assert.deepStrictEqual(h.leaseFile(), leaseBefore);
});

test('after release the page holds everything (parked) and reports nothing', async () => {
    const h = await holderHarness();
    const postsBefore = h.posts.length;
    await h.lease.release();
    assert.strictEqual(h.lease.status().phase, 'parked');
    assert.strictEqual(h.posts.length, postsBefore);
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'ignored' });
});

test('a parked page never releases', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    assert.strictEqual(await h.lease.release(), false);
    assert.strictEqual(h.uploads.length, 0);
});

test('a parked page reloading after its claim never releases', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    await h.lease.useHere();
    const uploadsBefore = h.uploads.length;
    assert.strictEqual(await h.lease.release(), false);
    assert.strictEqual(h.uploads.length, uploadsBefore);
});

test('the next page claims a released lease without a click', async () => {
    const h = await holderHarness();
    await h.lease.release();
    const next = h.newPage({ [KEYS.tabId]: 'page-b' });
    assert.deepStrictEqual(await next.lease.start(), { status: 'reload', pair: { holder: next.lease.pageId(), epoch: 5 } });
});

test('a refreshed holder finds its own marker matching, bumps, and the marker stops counting', async () => {
    const h = await holderHarness();
    await h.lease.release();
    const refreshed = h.newPage({ [KEYS.tabId]: 'page-a' });
    assert.deepStrictEqual(await refreshed.lease.start(), { status: 'holder', pair: { holder: refreshed.lease.pageId(), epoch: 5 } });
    const other = h.newPage({ [KEYS.tabId]: 'page-b' });
    assert.deepStrictEqual(await other.lease.start(), { status: 'parked', reason: 'held' });
});

test('an old tab closed after a takeover: its marker names its old claim; the lease stays held', async () => {
    const h = await holderHarness();
    // page-b took over (epoch 5); then the old holder's tab closes.
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 5 }));
    await h.lease.release();
    assert.deepStrictEqual([h.markerFile().holder, h.markerFile().epoch], [h.lease.pageId(), 4]);
    const next = h.newPage({ [KEYS.tabId]: 'page-c' });
    assert.deepStrictEqual(await next.lease.start(), { status: 'parked', reason: 'held' });
});

test('back/forward cache: a page that released parks and reloads on restore', async () => {
    const h = await holderHarness();
    await h.lease.release();
    assert.deepStrictEqual(h.lease.restoredFromCache(), { reload: true });
    assert.strictEqual(h.lease.status().phase, 'parked');
    assert.strictEqual(h.posts.at(-1).state, 'parked');
});

test('back/forward cache: a page that never released does not reload', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    assert.deepStrictEqual(h.lease.restoredFromCache(), { reload: false });
});

test('resume after freeze, lease unchanged: bumps the epoch, verifies, holds again without a reload', async () => {
    const h = await holderHarness();
    const id = h.lease.pageId();
    await h.lease.release('freeze');
    assert.deepStrictEqual([h.markerFile().holder, h.markerFile().epoch], [id, 4]);
    const outcome = await h.lease.resumeAfterFreeze();
    assert.deepStrictEqual(outcome, { status: 'holder', pair: { holder: id, epoch: 5 } });
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch], [id, 5]);
    assert.ok(h.sleeps.includes(1000), 'grace before the verify');
    assert.deepStrictEqual(h.posts.at(-1), { type: 'leaseState', state: 'holder', reason: null, pageId: id, epoch: 5, busy: false, connected: false, actions: [] });
});

test('resume after freeze, another page claimed meanwhile: parks as lost and writes nothing', async () => {
    const h = await holderHarness();
    await h.lease.release('freeze');
    h.setFile(LEASE, leaseFile({ holder: 'page-b.load', epoch: 5 }));
    const leaseWrites = h.leaseUploads().length;
    assert.deepStrictEqual(await h.lease.resumeAfterFreeze(), { status: 'parked', reason: 'lost' });
    assert.strictEqual(h.leaseUploads().length, leaseWrites);
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch], ['page-b.load', 5]);
    assert.strictEqual(h.posts.at(-1).reason, 'lost');
});

test('resume after freeze, lease unreadable: parks as unreadable and writes nothing', async () => {
    const h = await holderHarness();
    await h.lease.release('freeze');
    h.server.readStatus.set(LEASE, 500);
    const leaseWrites = h.leaseUploads().length;
    assert.deepStrictEqual(await h.lease.resumeAfterFreeze(), { status: 'parked', reason: 'unreadable' });
    assert.strictEqual(h.leaseUploads().length, leaseWrites);
});

test('resume after freeze, a claim lands during the grace: the verify parks as lost', async () => {
    const h = await holderHarness();
    await h.lease.release('freeze');
    h.server.onSleep = (ms) => { if (ms === 1000) h.setFile(LEASE, leaseFile({ holder: 'page-b.load', epoch: 5 })); };
    assert.deepStrictEqual(await h.lease.resumeAfterFreeze(), { status: 'parked', reason: 'lost' });
});

test('resume is ignored after a pagehide release (the back/forward cache reloads) and for a parked page', async () => {
    const h = await holderHarness();
    await h.lease.release('pagehide');
    assert.deepStrictEqual(await h.lease.resumeAfterFreeze(), { status: 'ignored' });
    assert.deepStrictEqual(h.lease.restoredFromCache(), { reload: true });

    const parked = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await parked.lease.start();
    assert.strictEqual(await parked.lease.release('freeze'), false);
    assert.deepStrictEqual(await parked.lease.resumeAfterFreeze(), { status: 'ignored' });
});

test('a marker that failed to send is reported false', async () => {
    const h = await holderHarness();
    h.server.failUploads = 1;
    assert.strictEqual(await h.lease.release(), false);
    assert.strictEqual(h.uploads.at(-1).name, MARKER);
});
