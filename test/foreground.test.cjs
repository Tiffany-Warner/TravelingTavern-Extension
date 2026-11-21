'use strict';

// onForeground (spec E11, app A5): a holder invalidates its own release marker with an epoch bump; a
// parked page claims only a released or missing lease.

const test = require('node:test');
const assert = require('node:assert');
const { GRACE_MS } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER, KEYS } = require('./helpers/fake-server.cjs');

async function holderHarness() {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    assert.strictEqual((await h.lease.start()).status, 'holder');
    return h;
}

test('holder, not released: stays holder, nothing written', async () => {
    const h = await holderHarness();
    const uploads = h.uploads.length;
    const outcome = await h.lease.onForeground();
    assert.strictEqual(outcome.status, 'holder');
    assert.strictEqual(h.uploads.length, uploads);
});

test('holder whose release marker matches (written from Kotlin): bumps the epoch, verifies, stays holder', async () => {
    const h = await holderHarness();
    const me = h.lease.pageId();
    h.setFile(MARKER, markerFile({ holder: me, epoch: 4 }));
    h.sleeps.length = 0;
    const outcome = await h.lease.onForeground();
    assert.deepStrictEqual(outcome, { status: 'holder', pair: { holder: me, epoch: 5 } });
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch], [me, 5]);
    assert.deepStrictEqual(h.sleeps, [GRACE_MS]);
    assert.strictEqual(h.posts.at(-1).epoch, 5, 'leaseState reports the new epoch');
    // The old marker no longer frees the lease.
    const other = h.newPage({ [KEYS.tabId]: 'page-b' });
    assert.deepStrictEqual(await other.lease.start(), { status: 'parked', reason: 'held' });
});

test('holder whose lease another page took: parks (lost)', async () => {
    const h = await holderHarness();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    assert.deepStrictEqual(await h.lease.onForeground(), { status: 'parked', reason: 'lost' });
});

test('requests during the foreground bump compare against the new pair (no false park)', async () => {
    const h = await holderHarness();
    const me = h.lease.pageId();
    h.setFile(MARKER, markerFile({ holder: me, epoch: 4 }));
    const verdicts = [];
    h.server.onSleep = () => { verdicts.push(h.lease.gate('/api/settings/save', 'POST')); };
    await h.lease.onForeground();
    assert.deepStrictEqual(await Promise.all(verdicts), ['send']);
    assert.strictEqual(h.lease.status().phase, 'holder');
});

test('parked, lease released: claims (kind foreground) and reloads', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 6 }) } });
    await h.lease.start();
    h.setFile(MARKER, markerFile({ holder: 'page-b', epoch: 6 }));
    const outcome = await h.lease.onForeground();
    assert.strictEqual(outcome.status, 'reload');
    assert.strictEqual(h.storage.map.get(KEYS.reopen), 'foreground');
});

test('parked, lease missing: claims', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    h.server.files.delete(LEASE);
    assert.strictEqual((await h.lease.onForeground()).status, 'reload');
});

test('parked, lease held by another page: stays parked, nothing written', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    assert.deepStrictEqual(await h.lease.onForeground(), { status: 'parked', reason: 'held' });
    assert.strictEqual(h.uploads.length, 0);
});

test('ignored before the start decision, while claiming and with an unknown format', async () => {
    const early = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    assert.deepStrictEqual(await early.lease.onForeground(), { status: 'ignored' });

    const outdated = createHarness({ files: { [LEASE]: leaseFile({ format: 2 }) } });
    await outdated.lease.start();
    assert.deepStrictEqual(await outdated.lease.onForeground(), { status: 'ignored' });
});
