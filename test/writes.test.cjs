'use strict';

// Lease writes (spec E3): one in flight, re-read first, bounded retry, outcomes per write type.

const test = require('node:test');
const assert = require('node:assert');
const { RETRY_MIN_MS, RETRY_MAX_MS, WRITE_ATTEMPTS } = require('../session-lease.js');
const { createHarness, leaseFile, LEASE } = require('./helpers/fake-server.cjs');

const PAIR = Object.freeze({ holder: 'page-a', epoch: 3 });

function holderHarness(fields) {
    return createHarness({ files: { [LEASE]: leaseFile(Object.assign({ holder: 'page-a', epoch: 3 }, fields)) } });
}

test('an update writes only busy / active and keeps holder, epoch and format', async () => {
    const h = holderHarness();
    const outcome = await h.lease.updateLease(PAIR, { busy: true });
    assert.strictEqual(outcome.status, 'written');
    assert.deepStrictEqual(h.leaseFile(), leaseFile({ holder: 'page-a', epoch: 3, busy: true }));
});

test('an update drops fields this copy does not know', async () => {
    const h = holderHarness({ futureField: 'x' });
    await h.lease.updateLease(PAIR, { busy: true });
    assert.strictEqual('futureField' in h.leaseFile(), false);
});

test('unchanged writes are skipped', async () => {
    const h = holderHarness();
    const active = { avatar: 'Example Character.png', chatFile: 'Example Chat' };
    assert.strictEqual((await h.lease.updateLease(PAIR, { busy: false })).status, 'unchanged');
    assert.strictEqual((await h.lease.updateLease(PAIR, { active: Object.assign({}, active) })).status, 'unchanged');
    assert.strictEqual(h.uploads.length, 0);
    assert.strictEqual((await h.lease.updateLease(PAIR, { active: { avatar: 'Example Character.png', chatFile: 'Other Chat' } })).status, 'written');
});

test('one write in flight at a time', async () => {
    const h = holderHarness();
    await Promise.all([
        h.lease.updateLease(PAIR, { busy: true }),
        h.lease.updateLease(PAIR, { active: null }),
        h.lease.updateLease(PAIR, { busy: false }),
    ]);
    assert.strictEqual(h.maxInFlight(), 1);
    assert.deepStrictEqual(h.uploads.map((u) => [u.value.busy, u.value.active]), [
        [true, leaseFile().active],
        [true, null],
        [false, null],
    ]);
});

test('an update queued behind an epoch bump cannot write the old epoch back', async () => {
    const h = holderHarness();
    const [bump, update] = await Promise.all([
        h.lease.bumpEpoch(PAIR),
        h.lease.updateLease(PAIR, { busy: true }),
    ]);
    assert.strictEqual(bump.status, 'written');
    assert.deepStrictEqual(update, { status: 'parked', reason: 'lost' });
    assert.strictEqual(h.leaseFile().epoch, 4);
});

test('a failed write is retried after 100–200 ms, re-reading first', async () => {
    const h = holderHarness();
    h.server.failUploads = 1;
    const outcome = await h.lease.updateLease(PAIR, { busy: true });
    assert.strictEqual(outcome.status, 'written');
    assert.strictEqual(h.uploads.length, 2);
    assert.strictEqual(h.sleeps.length, 1);
    assert.ok(h.sleeps[0] >= RETRY_MIN_MS && h.sleeps[0] <= RETRY_MAX_MS, `delay ${h.sleeps[0]}`);
});

test('at most 3 attempts', async () => {
    const h = holderHarness();
    h.server.failUploads = 10;
    await h.lease.updateLease(PAIR, { active: null });
    assert.strictEqual(h.uploads.length, WRITE_ATTEMPTS);
    assert.strictEqual(h.sleeps.length, WRITE_ATTEMPTS - 1);
    assert.ok(h.sleeps.every((ms) => ms >= RETRY_MIN_MS && ms <= RETRY_MAX_MS));
});

test('a retry parks at once when the pair changed meanwhile', async () => {
    const h = holderHarness();
    h.server.failUploads = 1;
    h.server.beforeUpload = () => {
        h.server.beforeUpload = null;
        h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    };
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { busy: true }), { status: 'parked', reason: 'lost' });
    assert.strictEqual(h.uploads.length, 1);
    assert.strictEqual(h.leaseFile().holder, 'page-b');
});

test('an unreadable re-read is retried like a failed write', async () => {
    const h = holderHarness();
    h.server.failLeaseReads = 2;
    const outcome = await h.lease.updateLease(PAIR, { busy: true });
    assert.strictEqual(outcome.status, 'written');
    assert.strictEqual(h.uploads.length, 1);
    assert.strictEqual(h.sleeps.length, 2);
    assert.ok(h.sleeps.every((ms) => ms >= RETRY_MIN_MS && ms <= RETRY_MAX_MS));
});

test('a missing (404) re-read is retried like a failed write', async () => {
    const h = holderHarness();
    h.server.missingLeaseReads = 1;
    assert.strictEqual((await h.lease.updateLease(PAIR, { busy: true })).status, 'written');
    assert.strictEqual(h.sleeps.length, 1);
});

test('unreadable on every attempt: parks (unreadable) after the last, whatever the write type', async () => {
    for (const changes of [{ busy: true }, { busy: false }, { active: null }]) {
        const h = holderHarness();
        h.server.readStatus.set(LEASE, 500);
        assert.deepStrictEqual(await h.lease.updateLease(PAIR, changes), { status: 'parked', reason: 'unreadable' });
        assert.strictEqual(h.sleeps.length, WRITE_ATTEMPTS - 1);
        assert.strictEqual(h.uploads.length, 0);
    }
    const h = holderHarness();
    h.server.readStatus.set(LEASE, 500);
    assert.deepStrictEqual(await h.lease.bumpEpoch(PAIR), { status: 'parked', reason: 'unreadable' });
    assert.strictEqual(h.sleeps.length, WRITE_ATTEMPTS - 1);
});

test('missing on every attempt: parks (lost) after the last', async () => {
    const h = holderHarness();
    h.server.missingLeaseReads = WRITE_ATTEMPTS;
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { busy: true }), { status: 'parked', reason: 'lost' });
    assert.strictEqual(h.sleeps.length, WRITE_ATTEMPTS - 1);
});

test('a failed write, then an unreadable re-read on the last attempt: parks (unreadable)', async () => {
    const h = holderHarness();
    h.server.failUploads = 2;
    h.server.beforeUpload = () => {
        if (h.uploads.length === 1) h.server.failLeaseReads = 1;
    };
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { active: null }), { status: 'parked', reason: 'unreadable' });
    assert.strictEqual(h.uploads.length, 2);
});

test('an unreadable re-read, then a good write: written', async () => {
    const h = holderHarness();
    h.server.failLeaseReads = 1;
    h.server.failUploads = 1;
    assert.strictEqual((await h.lease.updateLease(PAIR, { busy: true })).status, 'written');
    assert.strictEqual(h.uploads.length, 2);
});

test('an unknown format on a re-read parks at once, no retry', async () => {
    const h = holderHarness();
    h.server.failUploads = 1;
    h.server.beforeUpload = () => { h.setFile(LEASE, leaseFile({ holder: 'page-a', epoch: 3, format: 2 })); };
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { busy: true }), { status: 'parked', reason: 'unknownFormat' });
    assert.strictEqual(h.uploads.length, 1);
    assert.strictEqual(h.sleeps.length, 1);
});

test('all attempts failed: an epoch bump parks', async () => {
    const h = holderHarness();
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.bumpEpoch(PAIR), { status: 'parked', reason: 'unreadable' });
});

test('all attempts failed: active leaves the page holder (logged)', async () => {
    const h = holderHarness();
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { active: null }), { status: 'failed' });
    assert.ok(h.logs.some((l) => l.message === 'lease update gave up'));
    assert.strictEqual(h.lease.hasPendingBusyClear(), false);
});

test('all attempts failed: busy true is reported failed (the caller does not send the request); busy false pending', async () => {
    const h = holderHarness();
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { busy: true }), { status: 'failed' });
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(h.lease.hasPendingBusyClear(), true);
});

test('a failed busy true that landed on the last attempt is cleared by the next write', async () => {
    const h = holderHarness();
    h.server.failUploads = WRITE_ATTEMPTS - 1;
    h.server.failAfterWrite = 1;
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { busy: true }), { status: 'failed' });
    assert.strictEqual(h.leaseFile().busy, true, 'the last attempt landed despite its error answer');
    assert.strictEqual(h.lease.hasPendingBusyClear(), true);

    assert.strictEqual((await h.lease.updateLease(PAIR, { active: null })).status, 'written');
    assert.strictEqual(h.leaseFile().busy, false);
    assert.strictEqual(h.lease.hasPendingBusyClear(), false);
});

test('all attempts failed: busy false stays pending and goes with the next write; the file ends busy false', async () => {
    const h = holderHarness({ busy: true });
    h.server.failUploads = WRITE_ATTEMPTS;
    assert.deepStrictEqual(await h.lease.updateLease(PAIR, { busy: false }), { status: 'failed' });
    assert.strictEqual(h.lease.hasPendingBusyClear(), true);
    assert.strictEqual(h.leaseFile().busy, true);

    const next = await h.lease.updateLease(PAIR, { active: null });
    assert.strictEqual(next.status, 'written');
    assert.deepStrictEqual([h.leaseFile().busy, h.leaseFile().active], [false, null]);
    assert.strictEqual(h.lease.hasPendingBusyClear(), false);
});

test('a new reply while busy false is pending: busy true is already in the file, the reply’s end clears it', async () => {
    const h = holderHarness({ busy: true });
    h.server.failUploads = WRITE_ATTEMPTS;
    await h.lease.updateLease(PAIR, { busy: false });
    assert.strictEqual((await h.lease.updateLease(PAIR, { busy: true })).status, 'unchanged');
    assert.strictEqual(h.lease.hasPendingBusyClear(), false);
    assert.strictEqual((await h.lease.updateLease(PAIR, { busy: false })).status, 'written');
    assert.strictEqual(h.leaseFile().busy, false);
});

test('a write that landed despite an error answer is not written twice', async () => {
    const h = holderHarness();
    h.server.failAfterWrite = 1;
    assert.strictEqual((await h.lease.updateLease(PAIR, { busy: true })).status, 'unchanged');
    assert.strictEqual(h.uploads.length, 1);

    h.server.failAfterWrite = 1;
    const bump = await h.lease.bumpEpoch(PAIR);
    assert.strictEqual(bump.status, 'unchanged', 'the bump found its own new pair on re-read');
    assert.deepStrictEqual([h.leaseFile().holder, h.leaseFile().epoch], ['page-a', 4]);
});

test('an epoch bump writes (own id, epoch + 1) with the given fields', async () => {
    const h = holderHarness({ busy: true });
    const outcome = await h.lease.bumpEpoch(PAIR, { busy: false });
    assert.strictEqual(outcome.status, 'written');
    const file = h.leaseFile();
    assert.deepStrictEqual([file.holder, file.epoch, file.busy, file.format], ['page-a', 4, false, 1]);
    assert.deepStrictEqual(file.active, leaseFile().active, 'active carried over');
    assert.strictEqual(file.claimedAt, '2026-01-01T00:00:00.000Z');
});

test('uploads go to ST’s upload endpoint as base64 UTF-8 JSON', async () => {
    const h = holderHarness();
    await h.lease.updateLease(PAIR, { active: { avatar: 'Exämple Charactér.png', chatFile: 'Chat ✓' } });
    assert.strictEqual(h.uploads[0].name, LEASE);
    assert.strictEqual(h.leaseFile().active.chatFile, 'Chat ✓');
});
