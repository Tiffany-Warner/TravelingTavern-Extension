'use strict';

// Take over anyway (spec E4): a claim written over whatever the lease file holds (damaged, unknown
// format, busy), a new holder id, marker repair, the grace and verify, a lost race after it.

const test = require('node:test');
const assert = require('node:assert');
const { GRACE_MS, BUSY_WAIT_INTERVAL_MS, decideForceClaim, forceBase, parseLease } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER, KEYS } = require('./helpers/fake-server.cjs');

/** A page started against these files; its posts cleared. */
async function startedHarness(files) {
    const h = createHarness({ files });
    await h.lease.start();
    h.posts.length = 0;
    return h;
}

test('damaged lease: writes a fresh claim (new holder id of this tab, epoch 1, no active), verifies, reloads', async () => {
    const h = await startedHarness({ [LEASE]: '{"format":1,"hol' });
    assert.strictEqual(h.lease.status().reason, 'damaged');
    const outcome = await h.lease.takeOverAnyway();
    assert.strictEqual(outcome.status, 'reload');
    const file = h.leaseFile();
    assert.deepStrictEqual([file.format, file.epoch, file.busy, file.active], [1, 1, false, null]);
    assert.match(file.holder, /^page-a\.[0-9a-f]{16}$/, 'this tab');
    assert.notStrictEqual(file.holder, h.lease.pageId(), 'a new load id, not this page’s');
    assert.deepStrictEqual(outcome.pair, { holder: file.holder, epoch: 1 });
    assert.deepStrictEqual(h.sleeps, [GRACE_MS], 'grace, no busy wait');
    assert.strictEqual(h.storage.map.get(KEYS.reopen), 'useHere');
    assert.deepStrictEqual(h.posts.map((p) => p.reason), ['claiming']);
});

test('after it, the old holder parks by the pair rule, and the reload of this tab bumps and holds', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }) } });
    const holder = h.newPage({ [KEYS.tabId]: 'page-b' });
    assert.strictEqual((await holder.lease.start()).status, 'holder');
    h.setFile(LEASE, 'garbage');
    assert.strictEqual((await h.lease.start()).reason, 'damaged');
    assert.strictEqual((await h.lease.takeOverAnyway()).status, 'reload');
    assert.strictEqual(await holder.lease.checkHolder(), false);
    assert.strictEqual(holder.lease.status().reason, 'lost');
    const reloaded = h.newPage(Object.fromEntries(h.storage.map));
    assert.strictEqual((await reloaded.lease.start()).status, 'holder');
    assert.strictEqual(h.leaseFile().epoch, 2);
});

test('unknown format in the lease: overwritten with format 1 after the warning; never without a tap', async () => {
    const h = await startedHarness({ [LEASE]: leaseFile({ format: 2, holder: 'page-b', epoch: 9 }) });
    assert.strictEqual(h.lease.status().reason, 'unknownFormat');
    assert.strictEqual(h.uploads.length, 0, 'nothing written by itself');
    assert.strictEqual((await h.lease.takeOverAnyway()).status, 'reload');
    assert.deepStrictEqual([h.leaseFile().format, h.leaseFile().epoch], [1, 1], 'an unknown format’s epoch is not trusted');
});

test('unknown-format or damaged marker: replaced by one that matches nothing, so other pages park as held', async () => {
    for (const marker of [markerFile({ format: 2 }), '{oops']) {
        const h = await startedHarness({ [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }), [MARKER]: marker });
        assert.strictEqual((await h.lease.takeOverAnyway()).status, 'reload');
        const fresh = h.markerFile();
        assert.strictEqual(fresh.format, 1);
        assert.notStrictEqual(fresh.holder, h.leaseFile().holder);
        assert.deepStrictEqual(h.uploads.map((u) => u.name), [MARKER, LEASE], 'marker first, then the lease');
        const other = h.newPage({ [KEYS.tabId]: 'page-c' });
        assert.deepStrictEqual(await other.lease.start(), { status: 'parked', reason: 'held' });
    }
});

test('a readable marker is left alone', async () => {
    const h = await startedHarness({ [LEASE]: '[]', [MARKER]: markerFile({ holder: 'page-b' }) });
    await h.lease.takeOverAnyway();
    assert.deepStrictEqual(h.uploads.map((u) => u.name), [LEASE]);
});

test('during the wait for busy: offered at 10 s, ends the wait at the next step, claims epoch + 1 with active', async () => {
    const h = await startedHarness({ [LEASE]: leaseFile({ holder: 'page-b', epoch: 3 }) });
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 3, busy: true }));
    let steps = 0;
    const taps = [];
    h.server.onSleep = (ms) => {
        if (ms !== BUSY_WAIT_INTERVAL_MS) return;
        steps++;
        if (steps === 5 || steps === 10) taps.push(h.lease.takeOverAnyway());
    };
    const outcome = await h.lease.useHere();
    assert.deepStrictEqual(await Promise.all(taps), [{ status: 'ignored' }, { status: 'forcing' }], 'not offered before 10 s');
    assert.strictEqual(outcome.status, 'reload', 'the running claim reloads, once');
    assert.strictEqual(steps, 11, 'ten wait steps, then only the grace');
    const file = h.leaseFile();
    assert.deepStrictEqual([file.epoch, file.busy, file.active], [4, false, leaseFile().active]);
    assert.notStrictEqual(file.holder, h.lease.pageId());
});

test('lost race after it: another write lands during the grace → lostRace, no reload', async () => {
    const h = await startedHarness({ [LEASE]: 'nope' });
    h.server.onSleep = (ms) => {
        if (ms === GRACE_MS) h.setFile(LEASE, leaseFile({ holder: 'page-z.load', epoch: 1 }));
    };
    assert.deepStrictEqual(await h.lease.takeOverAnyway(), { status: 'parked', reason: 'lostRace' });
    assert.deepStrictEqual(h.lease.actions(), ['useHere']);
});

test('writes that keep failing: parks as error, still offering its ways out', async () => {
    const h = await startedHarness({ [LEASE]: 'nope' });
    h.server.failUploads = 10;
    assert.deepStrictEqual(await h.lease.takeOverAnyway(), { status: 'parked', reason: 'error' });
    assert.deepStrictEqual(h.lease.actions(), ['refresh', 'takeOverAnyway', 'turnOffProtection']);
});

test('server unreachable: parks as unreadable (Use here still offered), not as error', async () => {
    const h = await startedHarness({ [LEASE]: leaseFile({ holder: 'page-b' }) });
    h.server.offline = true;
    assert.strictEqual(await h.lease.checkHolder(), false);
    await h.lease.useHere();
    assert.strictEqual(h.lease.status().reason, 'unreadable');
    assert.deepStrictEqual(await h.lease.takeOverAnyway(), { status: 'parked', reason: 'unreadable' });
    assert.ok(h.lease.actions().includes('useHere'));
});

test('not offered: held, claiming, holder → ignored, nothing written', async () => {
    const held = await startedHarness({ [LEASE]: leaseFile({ holder: 'page-b' }) });
    assert.deepStrictEqual(await held.lease.takeOverAnyway(), { status: 'ignored' });
    const holder = await startedHarness({ [LEASE]: leaseFile({ holder: 'page-a' }) });
    const writes = holder.uploads.length;
    assert.deepStrictEqual(await holder.lease.takeOverAnyway(), { status: 'ignored' });
    assert.strictEqual(held.uploads.length, 0);
    assert.strictEqual(holder.uploads.length, writes);
});

test('decideForceClaim and forceBase: pure decisions', () => {
    const pair = { holder: 'page-a.new', epoch: 4 };
    const read = { kind: 'ok', lease: parseLease(leaseFile({ holder: 'page-b', epoch: 3, busy: true })).lease };
    assert.strictEqual(decideForceClaim(read, pair, 't', null).action, 'write', 'busy and another holder don’t matter');
    assert.strictEqual(decideForceClaim({ kind: 'unreadable', damaged: true }, pair, 't', null).action, 'write');
    assert.strictEqual(decideForceClaim({ kind: 'unknownFormat' }, pair, 't', null).action, 'write');
    assert.strictEqual(decideForceClaim({ kind: 'missing' }, pair, 't', null).action, 'write');
    const landed = { kind: 'ok', lease: parseLease(leaseFile({ holder: 'page-a.new', epoch: 4 })).lease };
    assert.strictEqual(decideForceClaim(landed, pair, 't', null).action, 'skip', 'an earlier attempt landed');
    assert.deepStrictEqual(forceBase(read), { epoch: 4, active: leaseFile().active });
    assert.deepStrictEqual(forceBase({ kind: 'unknownFormat' }), { epoch: 1, active: null });
    assert.deepStrictEqual(forceBase({ kind: 'missing' }), { epoch: 1, active: null });
});
