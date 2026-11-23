'use strict';

// The lease I/O bound (spec E2, E3): every lease read and write is aborted after 10 s and counts as
// "can't reach ST" (`unreadable`, with its ways out), in the start decision, a claim, the wait for
// `busy` and Take over anyway. A write that lands after its timeout is found by the next re-read.

const test = require('node:test');
const assert = require('node:assert');
const { LEASE_FETCH_TIMEOUT_MS, BUSY_WAIT_INTERVAL_MS } = require('../session-lease.js');
const { createHarness, leaseFile, LEASE } = require('./helpers/fake-server.cjs');
const { flush, track } = require('./helpers/fake-window.cjs');

/** Runs a lease call to its end, firing each 10 s timeout once it is the only thing left to wait for. */
async function settle(h, promise) {
    const tracked = track(promise);
    for (let i = 0; i < 50 && !tracked.settled(); i++) {
        await flush(1);
        h.fireTimeouts();
    }
    assert.ok(tracked.settled(), 'settles once the timeouts fire');
    return tracked.result().value;
}

test('the bound is 10 s, and a request that answers clears its timer', async () => {
    assert.strictEqual(LEASE_FETCH_TIMEOUT_MS, 10000);
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    assert.strictEqual(h.pendingTimeouts(), 0);
});

test('hung lease read at start: waits, then parks as unreadable (can’t reach) with its ways out', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    h.server.hangLeaseReads = 1;
    const start = track(h.lease.start());
    await flush(5);
    assert.strictEqual(start.settled(), false, 'still deciding while ST hasn’t answered');
    assert.strictEqual(h.fireTimeouts(), 1);
    await flush(5);
    assert.deepStrictEqual(start.result().value, { status: 'parked', reason: 'unreadable' });
    assert.deepStrictEqual(h.lease.actions(), ['useHere', 'refresh', 'takeOverAnyway', 'turnOffProtection']);
    assert.strictEqual(h.uploads.length, 0);
});

test('hung write in a claim: every attempt times out → parks as unreadable (not error), Use here offered again', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    await h.lease.start();
    h.server.hangUploads = 3;
    assert.deepStrictEqual(await settle(h, h.lease.useHere()), { status: 'parked', reason: 'unreadable' });
    assert.strictEqual(h.uploads.filter((u) => u.hung).length, 3, 'three attempts, each aborted');
    assert.ok(h.lease.actions().includes('useHere'));
    assert.strictEqual(h.leaseFile().holder, 'page-b', 'nothing landed');
});

test('a write that lands after its timeout: the next re-read finds this page’s pair, verified, no second write', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }) } });
    await h.lease.start();
    h.server.hangUploads = 1;
    h.server.landHungUploads = true;
    const outcome = await settle(h, h.lease.useHere());
    assert.deepStrictEqual(outcome, { status: 'reload', pair: { holder: h.lease.pageId(), epoch: 4 } });
    assert.strictEqual(h.leaseUploads().length, 1, 'the late write counted, not written again');
});

test('a write that lands after the page gave up: the page stays parked (never holder without a fresh load); others park and can Use here', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }) } });
    await h.lease.start();
    h.server.hangUploads = 3;
    assert.deepStrictEqual(await settle(h, h.lease.useHere()), { status: 'parked', reason: 'unreadable' });
    const late = h.uploads.filter((u) => u.hung).at(-1).value;
    h.setFile(LEASE, late);
    assert.strictEqual(await h.lease.gate('/api/chats/save', 'POST'), 'hold', 'its requests stay held');
    const other = h.newPage({ 'tt-lease-tab-id': 'page-c' });
    assert.deepStrictEqual(await other.lease.start(), { status: 'parked', reason: 'held' });
    assert.strictEqual((await other.lease.useHere()).status, 'reload');
});

test('busy wait: a hung read is one wait step (still waiting), the claim goes on once busy clears', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }) } });
    await h.lease.start();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: true }));
    let steps = 0;
    h.server.onSleep = (ms) => {
        if (ms !== BUSY_WAIT_INTERVAL_MS) return;
        steps++;
        if (steps === 2) h.server.hangLeaseReads = 1;
        if (steps === 4) h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: false }));
    };
    const outcome = await settle(h, h.lease.useHere());
    assert.strictEqual(outcome.status, 'reload');
    assert.strictEqual(h.leaseFile().epoch, 4);
});

test('Take over anyway with ST not answering: parks as unreadable', async () => {
    const h = createHarness({ files: { [LEASE]: 'garbage' } });
    await h.lease.start();
    assert.strictEqual(h.lease.status().reason, 'damaged');
    h.server.hangUploads = 3;
    assert.deepStrictEqual(await settle(h, h.lease.takeOverAnyway()), { status: 'parked', reason: 'unreadable' });
});
