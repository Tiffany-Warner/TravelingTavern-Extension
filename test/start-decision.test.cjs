'use strict';

// The start decision (spec E4): own id → epoch bump; free or released → automatic claim, once per
// tab; otherwise parked.

const test = require('node:test');
const assert = require('node:assert');
const { GRACE_MS, decideStart, parseLease, parseMarker } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER, KEYS } = require('./helpers/fake-server.cjs');

test('no lease: automatic claim of epoch 1, then reload', async () => {
    const h = createHarness();
    const outcome = await h.lease.start();
    assert.deepStrictEqual(outcome, { status: 'reload', pair: { holder: 'page-a', epoch: 1 } });
    assert.deepStrictEqual(h.leaseFile(), {
        format: 1, holder: 'page-a', epoch: 1, claimedAt: '2026-01-01T00:00:00.000Z', busy: false, active: null,
    });
    assert.deepStrictEqual(h.sleeps, [GRACE_MS]);
    assert.strictEqual(h.storage.map.get(KEYS.reopen), 'automatic');
    assert.strictEqual(h.storage.map.get(KEYS.autoClaimed), '1');
    assert.strictEqual(h.lease.status().phase, 'parked', 'stays parked (requests held) until the reload');
    assert.deepStrictEqual(h.posts.map((p) => p.reason), ['claiming']);
});

test('released lease: automatic claim of epoch + 1, active carried over, stale busy not waited for', async () => {
    const h = createHarness({
        files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 7, busy: true }), [MARKER]: markerFile({ holder: 'page-b', epoch: 7 }) },
    });
    const outcome = await h.lease.start();
    assert.strictEqual(outcome.status, 'reload');
    const file = h.leaseFile();
    assert.deepStrictEqual([file.holder, file.epoch, file.busy], ['page-a', 8, false]);
    assert.deepStrictEqual(file.active, leaseFile().active);
    assert.deepStrictEqual(h.sleeps, [GRACE_MS], 'no busy wait');
});

test('own id (refresh): bumps the epoch with busy false, verifies after the grace, becomes holder', async () => {
    const h = createHarness({
        files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3, busy: true }) },
        storage: { [KEYS.pageId]: 'page-a', [KEYS.autoClaimed]: '1' },
    });
    const outcome = await h.lease.start();
    assert.deepStrictEqual(outcome, { status: 'holder', pair: { holder: 'page-a', epoch: 4 } });
    assert.deepStrictEqual([h.leaseFile().epoch, h.leaseFile().busy], [4, false]);
    assert.deepStrictEqual(h.sleeps, [GRACE_MS]);
    assert.strictEqual(h.storage.map.has(KEYS.autoClaimed), false, 'a successful load clears the automatic-claim mark');
    assert.deepStrictEqual(h.posts, [{ type: 'leaseState', state: 'holder', reason: null, pageId: 'page-a', epoch: 4, busy: false }]);
});

test('own id even with a matching release marker: bumps, so its own marker stops counting', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }), [MARKER]: markerFile({ holder: 'page-a', epoch: 3 }) } });
    assert.strictEqual((await h.lease.start()).status, 'holder');
    assert.strictEqual(h.leaseFile().epoch, 4);
    assert.strictEqual(h.markerFile().epoch, 3);
});

test('duplicated tab (same id): the newer load takes over; the older page parks at its next check', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    const original = await h.lease.start();
    assert.deepStrictEqual(original.pair, { holder: 'page-a', epoch: 4 });

    const duplicate = h.newPage({ [KEYS.pageId]: 'page-a' });
    assert.deepStrictEqual((await duplicate.lease.start()).pair, { holder: 'page-a', epoch: 5 });

    assert.deepStrictEqual(await h.lease.updateLease(original.pair, { active: null }), { status: 'parked', reason: 'lost' });
});

test('the bump fails verification when another page claims during the grace: parked (lost)', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    h.server.onSleep = () => h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'lost' });
    assert.strictEqual(h.lease.status().epoch, null, 'never held in this load');
});

test('another holder, not released: parked (held), nothing written', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'held' });
    assert.strictEqual(h.uploads.length, 0);
    assert.deepStrictEqual(h.posts, [{ type: 'leaseState', state: 'parked', reason: 'held', pageId: 'page-a', epoch: null, busy: false }]);
});

test('a stale marker (older claim) does not free the lease', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 5 }), [MARKER]: markerFile({ holder: 'page-c', epoch: 4 }) } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'held' });
});

test('unreadable lease, or unreadable marker with another holder: parked (unreadable), nothing written', async () => {
    let h = createHarness({ files: { [LEASE]: 'not json' } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'unreadable' });
    h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }), [MARKER]: '{' } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'unreadable' });
    assert.strictEqual(h.uploads.length, 0);
});

test('unknown format in either file: parked (unknownFormat), nothing written', async () => {
    for (const files of [
        { [LEASE]: leaseFile({ format: 2 }) },
        { [LEASE]: leaseFile({ holder: 'page-a' }), [MARKER]: markerFile({ format: 2 }) },
        { [MARKER]: markerFile({ format: 2 }) },
    ]) {
        const h = createHarness({ files });
        assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'unknownFormat' });
        assert.strictEqual(h.uploads.length, 0);
    }
});

test('automatic claim at most once per tab between successful loads', async () => {
    const h = createHarness({ storage: { [KEYS.pageId]: 'page-a', [KEYS.autoClaimed]: '1' } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'held' });
    assert.strictEqual(h.uploads.length, 0);
});

test('no sessionStorage: no automatic claim (no reload loop), new id for this load', async () => {
    const h = createHarness({ storage: null });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'held' });
    assert.match(h.lease.pageId(), /^p-[0-9a-f]{24}$/);
    assert.strictEqual(h.uploads.length, 0);
});

test('the page id is kept in sessionStorage and reused', () => {
    const h = createHarness({ storage: {} });
    const id = h.lease.pageId();
    assert.match(id, /^p-[0-9a-f]{24}$/);
    assert.strictEqual(h.storage.map.get(KEYS.pageId), id);
    assert.strictEqual(h.newPage({ [KEYS.pageId]: id }).lease.pageId(), id);
});

test('start runs once per load', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    const [a, b] = await Promise.all([h.lease.start(), h.lease.start()]);
    assert.strictEqual(a, b);
    assert.strictEqual(h.leaseFile().epoch, 4);
});

test('a failed epoch bump at start parks (unreadable)', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'unreadable' });
});

test('decideStart: pure decisions', () => {
    const lease = parseLease(leaseFile({ holder: 'page-b', epoch: 2 }));
    assert.deepStrictEqual(decideStart({ kind: 'missing' }, { kind: 'unreadable', why: 'x' }, 'page-a'), { action: 'claim' });
    assert.deepStrictEqual(decideStart(lease, parseMarker(markerFile({ holder: 'page-b', epoch: 2 })), 'page-a'), { action: 'claim' });
    assert.deepStrictEqual(decideStart(lease, { kind: 'missing' }, 'page-b'), { action: 'bump', from: { holder: 'page-b', epoch: 2 } });
    assert.deepStrictEqual(decideStart(lease, { kind: 'missing' }, 'page-a'), { action: 'park', reason: 'held' });
});
