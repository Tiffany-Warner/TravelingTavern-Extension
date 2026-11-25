'use strict';

// The pair rule (spec E2): every decision compares (holder, epoch), never the epoch alone.

const test = require('node:test');
const assert = require('node:assert');
const { holdsPair, parseLease, decideUpdate, decideBump } = require('../session-lease.js');
const { createHarness, leaseFile, LEASE } = require('./helpers/fake-server.cjs');

test('holdsPair needs both holder and epoch', () => {
    const lease = parseLease(leaseFile({ holder: 'page-a', epoch: 3 })).lease;
    assert.strictEqual(holdsPair(lease, { holder: 'page-a', epoch: 3 }), true);
    assert.strictEqual(holdsPair(lease, { holder: 'page-b', epoch: 3 }), false, 'same epoch, other holder');
    assert.strictEqual(holdsPair(lease, { holder: 'page-a', epoch: 2 }), false, 'same holder, other epoch');
    assert.strictEqual(holdsPair(null, { holder: 'page-a', epoch: 3 }), false);
    assert.strictEqual(holdsPair(lease, null), false);
});

test('an update parks (lost) when another page holds the same epoch', () => {
    const read = parseLease(leaseFile({ holder: 'page-b', epoch: 3 }));
    assert.deepStrictEqual(decideUpdate(read, { holder: 'page-a', epoch: 3 }, { busy: true }), { action: 'park', reason: 'lost' });
});

test('a bump verifies the pair it starts from, not the epoch alone', () => {
    const read = parseLease(leaseFile({ holder: 'page-b', epoch: 3 }));
    assert.deepStrictEqual(decideBump(read, { holder: 'page-a', epoch: 3 }, {}, 'now'), { action: 'park', reason: 'lost' });
});

test('a bump and a claim writing the same epoch: the pair decides', async () => {
    // page-a bumps 3 → 4; page-b's claim of epoch 4 lands right before page-a's write is read back.
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    const bumped = await h.lease.bumpEpoch({ holder: 'page-a', epoch: 3 });
    assert.strictEqual(bumped.status, 'written');
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 4 }));
    // page-a's next update (or verify) finds epoch 4 with another holder and parks.
    const update = await h.lease.updateLease({ holder: 'page-a', epoch: 4 }, { busy: true });
    assert.deepStrictEqual(update, { status: 'parked', reason: 'lost' });
    assert.strictEqual(h.leaseFile().holder, 'page-b');
});

test('a lease still missing or unreadable after every attempt parks; unknown format parks', async () => {
    const h = createHarness();
    assert.deepStrictEqual(await h.lease.updateLease({ holder: 'page-a', epoch: 3 }, { busy: true }), { status: 'parked', reason: 'lost' });
    h.setFile(LEASE, 'not json');
    assert.deepStrictEqual(await h.lease.updateLease({ holder: 'page-a', epoch: 3 }, { busy: true }), { status: 'parked', reason: 'damaged' });
    h.setFile(LEASE, leaseFile({ holder: 'page-a', epoch: 3 }));
    h.server.readStatus.set(LEASE, 500);
    assert.deepStrictEqual(await h.lease.updateLease({ holder: 'page-a', epoch: 3 }, { busy: true }), { status: 'parked', reason: 'unreadable' });
    h.server.readStatus.delete(LEASE);
    h.setFile(LEASE, leaseFile({ format: 2 }));
    assert.deepStrictEqual(await h.lease.updateLease({ holder: 'page-a', epoch: 3 }, { busy: true }), { status: 'parked', reason: 'unknownFormat' });
    assert.strictEqual(h.uploads.length, 0, 'nothing written over a file it cannot read');
});
