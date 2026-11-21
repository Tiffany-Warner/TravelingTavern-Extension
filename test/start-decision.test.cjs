'use strict';

// The start decision (spec E4): own id → epoch bump; free or released → automatic claim, once per
// tab; otherwise parked.

const test = require('node:test');
const assert = require('node:assert');
const { GRACE_MS, decideStart, parseLease, parseMarker } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER, KEYS } = require('./helpers/fake-server.cjs');

test('no lease: automatic claim of epoch 1, then reload', async () => {
    const h = createHarness();
    const me = h.lease.pageId();
    assert.match(me, /^page-a\.[0-9a-f]{16}$/, 'holder is <tab id>.<load id>');
    const outcome = await h.lease.start();
    assert.deepStrictEqual(outcome, { status: 'reload', pair: { holder: me, epoch: 1 } });
    assert.deepStrictEqual(h.leaseFile(), {
        format: 1, holder: me, epoch: 1, claimedAt: '2026-01-01T00:00:00.000Z', busy: false, active: null,
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
    assert.deepStrictEqual([file.holder, file.epoch, file.busy], [h.lease.pageId(), 8, false]);
    assert.deepStrictEqual(file.active, leaseFile().active);
    assert.deepStrictEqual(h.sleeps, [GRACE_MS], 'no busy wait');
});

test('lease held from this tab (refresh): bumps to this load with busy false, verifies after the grace, becomes holder', async () => {
    const h = createHarness({
        files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3, busy: true }) },
        storage: { [KEYS.tabId]: 'page-a', [KEYS.autoClaimed]: '1' },
    });
    const me = h.lease.pageId();
    const outcome = await h.lease.start();
    assert.deepStrictEqual(outcome, { status: 'holder', pair: { holder: me, epoch: 4 } });
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch, h.leaseFile().busy], [me, 4, false]);
    assert.deepStrictEqual(h.sleeps, [GRACE_MS]);
    assert.strictEqual(h.storage.map.has(KEYS.autoClaimed), false, 'a successful load clears the automatic-claim mark');
    assert.deepStrictEqual(h.posts, [{ type: 'leaseState', state: 'holder', reason: null, pageId: me, epoch: 4, busy: false, connected: false }]);
});

test('a previous load of this tab with a full holder id: the tab part decides', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a.0123456789abcdef', epoch: 3 }) } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'holder', pair: { holder: h.lease.pageId(), epoch: 4 } });
    const other = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-ab.0123456789abcdef', epoch: 3 }) } });
    assert.deepStrictEqual(await other.lease.start(), { status: 'parked', reason: 'held' }, 'a tab id that only starts the same is another tab');
});

test('own tab even with a matching release marker: bumps, so its own marker stops counting', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }), [MARKER]: markerFile({ holder: 'page-a', epoch: 3 }) } });
    assert.strictEqual((await h.lease.start()).status, 'holder');
    assert.strictEqual(h.leaseFile().epoch, 4);
    assert.strictEqual(h.markerFile().epoch, 3);
});

test('duplicated tab (same tab id): the newer load takes over; the older page parks at its next check', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    const original = await h.lease.start();
    assert.deepStrictEqual(original.pair, { holder: h.lease.pageId(), epoch: 4 });

    const duplicate = h.newPage({ [KEYS.tabId]: 'page-a' });
    assert.notStrictEqual(duplicate.lease.pageId(), h.lease.pageId(), 'each load has its own holder id');
    assert.deepStrictEqual((await duplicate.lease.start()).pair, { holder: duplicate.lease.pageId(), epoch: 5 });

    assert.deepStrictEqual(await h.lease.updateLease(original.pair, { active: null }), { status: 'parked', reason: 'lost' });
});

test('shared tab id: the original’s Use here claim and the duplicate’s refresh bump at the same epoch end with one holder', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    await h.lease.start(); // original holds (page-a.L1, 4)
    const duplicate = h.newPage({ [KEYS.tabId]: 'page-a' });
    await duplicate.lease.start(); // duplicate takes over: (page-a.L2, 5)
    h.lease.park('lost'); // the original finds out at its next check

    // The duplicate refreshes (new load L3) while the original clicks Use here: both write epoch 6.
    const refreshed = h.newPage({ [KEYS.tabId]: 'page-a' });
    const [claim, bump] = await Promise.all([h.lease.useHere(), refreshed.lease.start()]);

    assert.strictEqual(h.leaseUploads().filter((u) => u.value.epoch === 6).length, 2, 'both wrote epoch 6');
    const winners = [claim, bump].filter((o) => o.status === 'reload' || o.status === 'holder');
    assert.strictEqual(winners.length, 1, 'exactly one load verifies');
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch], [winners[0].pair.holder, 6]);
    assert.ok([claim, bump].some((o) => o.status === 'parked'));
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
    assert.deepStrictEqual(h.posts, [{ type: 'leaseState', state: 'parked', reason: 'held', pageId: h.lease.pageId(), epoch: null, busy: false, connected: false }]);
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
    const h = createHarness({ storage: { [KEYS.tabId]: 'page-a', [KEYS.autoClaimed]: '1' } });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'held' });
    assert.strictEqual(h.uploads.length, 0);
});

test('an automatic claim that ends without a reload clears the mark; a later load can claim a free lease', async () => {
    const h = createHarness();
    h.server.onSleep = () => h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 1 }));
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'lostRace' });
    assert.strictEqual(h.storage.map.has(KEYS.autoClaimed), false);

    h.server.onSleep = null;
    h.server.files.delete(LEASE);
    const later = h.newPage(Object.fromEntries(h.storage.map));
    assert.strictEqual((await later.lease.start()).status, 'reload');
});

test('an automatic claim that fails every write clears the mark', async () => {
    const h = createHarness();
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'unreadable' });
    assert.strictEqual(h.storage.map.has(KEYS.autoClaimed), false);
});

test('a successful automatic claim keeps the mark until a load becomes holder', async () => {
    const h = createHarness();
    assert.strictEqual((await h.lease.start()).status, 'reload');
    assert.strictEqual(h.storage.map.get(KEYS.autoClaimed), '1');
    const reloaded = h.newPage(Object.fromEntries(h.storage.map));
    assert.strictEqual((await reloaded.lease.start()).status, 'holder');
    assert.strictEqual(reloaded.storage.map.has(KEYS.autoClaimed), false);
});

test('no sessionStorage: no automatic claim (no reload loop), new id for this load', async () => {
    const h = createHarness({ storage: null });
    assert.deepStrictEqual(await h.lease.start(), { status: 'parked', reason: 'held' });
    assert.match(h.lease.pageId(), /^t[0-9a-f]{16}\.[0-9a-f]{16}$/);
    assert.strictEqual(h.uploads.length, 0);
});

test('the tab id is kept in sessionStorage and reused; the load id is new every load', () => {
    const h = createHarness({ storage: {} });
    const tab = h.storage.map.get(KEYS.tabId);
    assert.match(tab, /^t[0-9a-f]{16}$/);
    assert.ok(h.lease.pageId().startsWith(tab + '.'));
    const next = h.newPage({ [KEYS.tabId]: tab }).lease.pageId();
    assert.ok(next.startsWith(tab + '.'));
    assert.notStrictEqual(next, h.lease.pageId());
});

test('a stored tab id with a dot is replaced', () => {
    const h = createHarness({ storage: { [KEYS.tabId]: 'bad.id' } });
    assert.match(h.storage.map.get(KEYS.tabId), /^t[0-9a-f]{16}$/);
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
    const full = parseLease(leaseFile({ holder: 'page-b.00ff', epoch: 2 }));
    assert.deepStrictEqual(decideStart(full, { kind: 'missing' }, 'page-b'), { action: 'bump', from: { holder: 'page-b.00ff', epoch: 2 } });
    assert.deepStrictEqual(decideStart(lease, { kind: 'missing' }, 'page-a'), { action: 'park', reason: 'held' });
});
