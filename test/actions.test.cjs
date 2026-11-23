'use strict';

// The ways out a parked page offers (spec E9, E11 `leaseState.actions`): actionsFor for every reason,
// and Take over anyway joining "Finishing a reply…" after 10 s, re-posted once.

const test = require('node:test');
const assert = require('node:assert');
const { actionsFor, PARK_REASON, FORCE_OFFER_AFTER_MS, BUSY_WAIT_INTERVAL_MS } = require('../session-lease.js');
const { createHarness, leaseFile, LEASE } = require('./helpers/fake-server.cjs');

test('actionsFor: every reason, primary first; every error state has Refresh and a way to go ahead', () => {
    const expected = {
        held: ['useHere'],
        lost: ['useHere'],
        lostRace: ['useHere'],
        claiming: [],
        waitingForReply: [],
        unreadable: ['useHere', 'refresh', 'takeOverAnyway', 'turnOffProtection'],
        damaged: ['takeOverAnyway', 'refresh', 'turnOffProtection'],
        error: ['refresh', 'takeOverAnyway', 'turnOffProtection'],
        unknownFormat: ['refresh', 'takeOverAnyway', 'turnOffProtection'],
        reloadPending: ['refresh'],
    };
    assert.deepStrictEqual(Object.keys(expected).sort(), Object.values(PARK_REASON).sort(), 'every reason is covered');
    for (const [reason, actions] of Object.entries(expected)) {
        assert.deepStrictEqual(actionsFor(reason, 0), actions, reason);
    }
    for (const reason of ['unreadable', 'damaged', 'error', 'unknownFormat', 'reloadPending']) {
        assert.ok(actionsFor(reason, 0).includes('refresh'), reason + ': a way back in');
    }
});

test('actionsFor: waitingForReply offers Take over anyway from 10 s on, never Turn off protection', () => {
    assert.strictEqual(FORCE_OFFER_AFTER_MS, 10000);
    assert.deepStrictEqual(actionsFor('waitingForReply', FORCE_OFFER_AFTER_MS - 1), []);
    assert.deepStrictEqual(actionsFor('waitingForReply', FORCE_OFFER_AFTER_MS), ['takeOverAnyway']);
    assert.deepStrictEqual(actionsFor('waitingForReply', 59000), ['takeOverAnyway']);
    assert.deepStrictEqual(actionsFor('claiming', 30000), [], 'only the wait for busy counts');
});

test('actionsFor: a holder (null), an unknown reason or an Object.prototype name offers nothing; results are copies', () => {
    assert.deepStrictEqual(actionsFor(null, 0), []);
    assert.deepStrictEqual(actionsFor('somethingNew', 0), []);
    assert.deepStrictEqual(actionsFor('toString', 0), []);
    const first = actionsFor('held', 0);
    first.push('x');
    assert.deepStrictEqual(actionsFor('held', 0), ['useHere']);
});

test('waiting for a reply: leaseState is re-posted once with Take over anyway at 10 s', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }) } });
    await h.lease.start();
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: true }));
    h.posts.length = 0;
    let steps = 0;
    h.server.onSleep = (ms) => {
        if (ms !== BUSY_WAIT_INTERVAL_MS) return;
        steps++;
        if (steps === 14) h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: false }));
    };
    assert.strictEqual((await h.lease.useHere()).status, 'reload');
    const waiting = h.posts.filter((p) => p.reason === 'waitingForReply');
    assert.deepStrictEqual(waiting.map((p) => p.actions), [[], ['takeOverAnyway']]);
});

test('a holder and a page released on pagehide offer nothing', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    await h.lease.start();
    assert.deepStrictEqual(h.lease.actions(), []);
    await h.lease.release('pagehide');
    assert.deepStrictEqual(h.lease.actions(), []);
});
