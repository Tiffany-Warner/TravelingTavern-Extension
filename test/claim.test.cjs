'use strict';

// Claim and takeover (spec E4): busy wait, claim write, grace, verify, lost race, reopen flag.

const test = require('node:test');
const assert = require('node:assert');
const { GRACE_MS, BUSY_WAIT_INTERVAL_MS, BUSY_WAIT_MAX_MS } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER, KEYS } = require('./helpers/fake-server.cjs');

/** A page parked behind page-b's lease (epoch 3). */
async function parkedHarness(fields = {}, files = {}) {
    const h = createHarness({ files: Object.assign({ [LEASE]: leaseFile(Object.assign({ holder: 'page-b', epoch: 3 }, fields)) }, files) });
    assert.strictEqual((await h.lease.start()).status, 'parked');
    h.posts.length = 0;
    return h;
}

test('Use here: claims epoch + 1 with busy false and active carried over, waits the grace, verifies, reloads', async () => {
    const h = await parkedHarness();
    const outcome = await h.lease.useHere();
    assert.deepStrictEqual(outcome, { status: 'reload', pair: { holder: h.lease.pageId(), epoch: 4 } });
    const file = h.leaseFile();
    assert.deepStrictEqual([file.holder, file.epoch, file.busy, file.format], [h.lease.pageId(), 4, false, 1]);
    assert.deepStrictEqual(file.active, leaseFile().active);
    assert.deepStrictEqual(h.sleeps, [GRACE_MS]);
    assert.strictEqual(h.storage.map.get(KEYS.reopen), 'useHere');
    assert.deepStrictEqual(h.posts.map((p) => p.reason), ['claiming']);
    assert.strictEqual(h.lease.status().phase, 'parked', 'requests stay held until the reload');
});

test('a claim drops fields this copy does not know', async () => {
    const h = await parkedHarness({ futureField: 'x' });
    await h.lease.useHere();
    assert.strictEqual('futureField' in h.leaseFile(), false);
});

test('busy: waits, re-reading once per second, then claims when busy clears', async () => {
    const h = await parkedHarness({ busy: true });
    h.server.onSleep = () => {
        if (h.sleeps.length === 3) h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: false, active: null }));
    };
    const outcome = await h.lease.useHere();
    assert.strictEqual(outcome.status, 'reload');
    assert.deepStrictEqual(h.sleeps, [BUSY_WAIT_INTERVAL_MS, BUSY_WAIT_INTERVAL_MS, BUSY_WAIT_INTERVAL_MS, GRACE_MS]);
    assert.deepStrictEqual(h.posts.map((p) => p.reason), ['claiming', 'waitingForReply', 'claiming']);
    assert.strictEqual(h.leaseFile().active, null, 'active from the latest read');
});

test('busy that never clears: the wait ends at 60 s and the claim continues', async () => {
    const h = await parkedHarness({ busy: true });
    const outcome = await h.lease.useHere();
    assert.strictEqual(outcome.status, 'reload');
    // 60 one-second re-reads, then the grace.
    assert.strictEqual(h.sleeps.length, BUSY_WAIT_MAX_MS / BUSY_WAIT_INTERVAL_MS + 1);
    assert.strictEqual(h.sleeps.at(-1), GRACE_MS);
    assert.ok(h.logs.some((l) => l.message === 'reply wait ended at the limit'));
    assert.strictEqual(h.leaseFile().busy, false);
});

test('busy wait: another page claims meanwhile → parked (lostRace), nothing written', async () => {
    const h = await parkedHarness({ busy: true });
    h.server.onSleep = () => h.setFile(LEASE, leaseFile({ holder: 'page-c', epoch: 4 }));
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'parked', reason: 'lostRace' });
    assert.strictEqual(h.uploads.length, 0);
    assert.strictEqual(h.lease.status().claiming, false, 'Use here is offered again');
});

test('busy wait: the lease is released meanwhile → the wait ends and the claim continues', async () => {
    const h = await parkedHarness({ busy: true });
    h.server.onSleep = () => h.setFile(MARKER, markerFile({ holder: 'page-b', epoch: 3 }));
    const outcome = await h.lease.useHere();
    assert.strictEqual(outcome.status, 'reload');
    assert.deepStrictEqual(h.sleeps, [BUSY_WAIT_INTERVAL_MS, GRACE_MS]);
});

test('busy wait: an unreadable re-read is not free, the wait goes on', async () => {
    const h = await parkedHarness({ busy: true });
    h.server.onSleep = () => {
        if (h.sleeps.length === 1) h.server.failLeaseReads = 1;
        if (h.sleeps.length === 2) h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: false }));
    };
    assert.strictEqual((await h.lease.useHere()).status, 'reload');
    assert.deepStrictEqual(h.sleeps, [BUSY_WAIT_INTERVAL_MS, BUSY_WAIT_INTERVAL_MS, GRACE_MS]);
});

test('a released lease is not waited for, even when busy', async () => {
    const h = await parkedHarness({ busy: true }, { [MARKER]: markerFile({ holder: 'page-a', epoch: 1 }) });
    h.setFile(MARKER, markerFile({ holder: 'page-b', epoch: 3 }));
    assert.strictEqual((await h.lease.useHere()).status, 'reload');
    assert.deepStrictEqual(h.sleeps, [GRACE_MS]);
});

test('lost race: another claim lands during the grace → parked (lostRace), no reopen flag', async () => {
    const h = await parkedHarness();
    h.server.onSleep = () => h.setFile(LEASE, leaseFile({ holder: 'page-c', epoch: 4 }));
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'parked', reason: 'lostRace' });
    assert.strictEqual(h.storage.map.has(KEYS.reopen), false);
});

test('another page claims between the read and the write → parked (lostRace), its claim untouched', async () => {
    const h = await parkedHarness();
    h.server.failUploads = 1;
    h.server.beforeUpload = () => {
        h.server.beforeUpload = null;
        h.setFile(LEASE, leaseFile({ holder: 'page-c', epoch: 4 }));
    };
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'parked', reason: 'lostRace' });
    assert.strictEqual(h.leaseFile().holder, 'page-c');
});

test('two pages click Use here at once: exactly one holder', async () => {
    const h = await parkedHarness();
    const other = h.newPage({ [KEYS.tabId]: 'page-c' });
    await other.lease.start();
    const outcomes = await Promise.all([h.lease.useHere(), other.lease.useHere()]);
    const reloads = outcomes.filter((o) => o.status === 'reload');
    assert.strictEqual(reloads.length, 1);
    assert.deepStrictEqual(outcomes.find((o) => o.status === 'parked'), { status: 'parked', reason: 'lostRace' });
    assert.strictEqual(h.leaseFile().holder, reloads[0].pair.holder);
});

test('Use here is ignored while claiming, when holder, and with an unknown format', async () => {
    const h = await parkedHarness();
    const first = h.lease.useHere();
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'ignored' });
    await first;
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'ignored' }, 'after a successful claim, until the reload');

    const holder = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) } });
    await holder.lease.start();
    assert.deepStrictEqual(await holder.lease.useHere(), { status: 'ignored' });

    const outdated = createHarness({ files: { [LEASE]: leaseFile({ format: 2 }) } });
    await outdated.lease.start();
    assert.deepStrictEqual(await outdated.lease.useHere(), { status: 'ignored' });
    assert.strictEqual(outdated.uploads.length, 0);
});

test('Use here is ignored before the start decision', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'ignored' });
});

test('a claim that finds a newer format parks (unknownFormat) and writes nothing', async () => {
    const h = await parkedHarness();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', format: 2 }));
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'parked', reason: 'unknownFormat' });
    assert.strictEqual(h.uploads.length, 0);
});

test('a claim write that fails every attempt parks (unreadable); Use here is offered again', async () => {
    const h = await parkedHarness();
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.useHere(), { status: 'parked', reason: 'unreadable' });
    h.server.failUploads = 0;
    assert.strictEqual((await h.lease.useHere()).status, 'reload');
});

test('a claim write that landed despite an error answer is verified, not written again', async () => {
    const h = await parkedHarness();
    h.server.failAfterWrite = 1;
    assert.strictEqual((await h.lease.useHere()).status, 'reload');
    assert.strictEqual(h.leaseUploads().length, 1);
});
