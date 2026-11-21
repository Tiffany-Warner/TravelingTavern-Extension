'use strict';

// Reading the lease and the release marker (spec E2): missing vs unreadable, fields, format.

const test = require('node:test');
const assert = require('node:assert');
const { parseLease, parseMarker, isReleased } = require('../session-lease.js');
const { createHarness, leaseFile, markerFile, LEASE, MARKER } = require('./helpers/fake-server.cjs');

test('404 is missing, never unreadable or free', async () => {
    const h = createHarness();
    assert.deepStrictEqual(await h.lease.readLease(), { kind: 'missing' });
    assert.deepStrictEqual(await h.lease.readMarker(), { kind: 'missing' });
});

test('other error statuses and network errors are unreadable', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile() } });
    for (const status of [500, 403, 401, 302]) {
        h.server.readStatus.set(LEASE, status);
        assert.strictEqual((await h.lease.readLease()).kind, 'unreadable', `status ${status}`);
    }
    h.server.readStatus.clear();
    h.server.offline = true;
    assert.strictEqual((await h.lease.readLease()).kind, 'unreadable');
});

test('a body that is not a JSON object is unreadable', async () => {
    for (const body of ['', 'not json', '[1]', 'null', '42', '"text"', '<html></html>']) {
        const h = createHarness({ files: { [LEASE]: body } });
        assert.strictEqual((await h.lease.readLease()).kind, 'unreadable', JSON.stringify(body));
    }
});

test('the lease is read uncached', async () => {
    const seen = [];
    const { createSessionLease } = require('../session-lease.js');
    const instance = createSessionLease({
        fetch: async (url, init) => { seen.push(init); return new Response('', { status: 404 }); },
        now: () => 0,
        sleep: async () => {},
        log: () => {},
    });
    await instance.readLease();
    await instance.readMarker();
    assert.deepStrictEqual(seen.map((init) => init.cache), ['no-store', 'no-store']);
});

test('a valid lease parses', () => {
    const read = parseLease(leaseFile());
    assert.strictEqual(read.kind, 'ok');
    assert.deepStrictEqual(read.lease, leaseFile());
});

test('active may be null, a character chat or a group chat', () => {
    assert.strictEqual(parseLease(leaseFile({ active: null })).lease.active, null);
    assert.deepStrictEqual(
        parseLease(leaseFile({ active: { groupId: 'group-1', chatFile: 'Group Chat' } })).lease.active,
        { groupId: 'group-1', chatFile: 'Group Chat' },
    );
});

test('missing or mistyped required fields are unreadable', () => {
    const cases = {
        'no holder': leaseFile({ holder: undefined }),
        'empty holder': leaseFile({ holder: '' }),
        'epoch 0': leaseFile({ epoch: 0 }),
        'epoch as text': leaseFile({ epoch: '3' }),
        'fractional epoch': leaseFile({ epoch: 1.5 }),
        'no claimedAt': leaseFile({ claimedAt: undefined }),
        'busy as text': leaseFile({ busy: 'false' }),
        'no busy': leaseFile({ busy: undefined }),
        'no active': leaseFile({ active: undefined }),
        'active without chatFile': leaseFile({ active: { avatar: 'Example Character.png' } }),
        'active without avatar or group': leaseFile({ active: { chatFile: 'Example Chat' } }),
        'active as text': leaseFile({ active: 'Example Chat' }),
    };
    for (const [name, value] of Object.entries(cases)) {
        const json = JSON.parse(JSON.stringify(value));
        assert.strictEqual(parseLease(json).kind, 'unreadable', name);
    }
});

test('unknown fields are ignored and never kept', () => {
    const read = parseLease(leaseFile({ futureField: 'x', active: { avatar: 'Example Character.png', chatFile: 'Example Chat', extra: 1 } }));
    assert.strictEqual(read.kind, 'ok');
    assert.strictEqual('futureField' in read.lease, false);
    assert.strictEqual('extra' in read.lease.active, false);
});

test('unknown or missing format parks: unknownFormat, for both files', () => {
    for (const format of [undefined, 2, 0, '1', null, 1.5]) {
        const lease = JSON.parse(JSON.stringify(leaseFile({ format })));
        const marker = JSON.parse(JSON.stringify(markerFile({ format })));
        assert.deepStrictEqual(parseLease(lease), { kind: 'unknownFormat' }, `lease format ${format}`);
        assert.deepStrictEqual(parseMarker(marker), { kind: 'unknownFormat' }, `marker format ${format}`);
    }
});

test('a valid marker parses; missing fields are unreadable', () => {
    assert.strictEqual(parseMarker(markerFile()).kind, 'ok');
    assert.strictEqual(parseMarker(JSON.parse(JSON.stringify(markerFile({ holder: undefined })))).kind, 'unreadable');
    assert.strictEqual(parseMarker(markerFile({ epoch: -1 })).kind, 'unreadable');
    assert.strictEqual(parseMarker(JSON.parse(JSON.stringify(markerFile({ releasedAt: undefined })))).kind, 'unreadable');
});

test('released only on an exact pair match with both files readable', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile(), [MARKER]: markerFile() } });
    assert.strictEqual(isReleased(await h.lease.readLease(), await h.lease.readMarker()), true);
});

test('a stale marker means nothing', () => {
    const lease = parseLease(leaseFile({ holder: 'page-a', epoch: 4 }));
    assert.strictEqual(isReleased(lease, parseMarker(markerFile({ holder: 'page-a', epoch: 3 }))), false, 'older epoch');
    assert.strictEqual(isReleased(lease, parseMarker(markerFile({ holder: 'page-b', epoch: 4 }))), false, 'same epoch, other holder');
});

test('not released when either file is missing, unreadable or of unknown format', () => {
    const lease = parseLease(leaseFile());
    const marker = parseMarker(markerFile());
    assert.strictEqual(isReleased(lease, { kind: 'missing' }), false);
    assert.strictEqual(isReleased(lease, { kind: 'unreadable', why: 'x' }), false);
    assert.strictEqual(isReleased(lease, parseMarker(markerFile({ format: 2 }))), false);
    assert.strictEqual(isReleased({ kind: 'missing' }, marker), false);
    assert.strictEqual(isReleased(parseLease(leaseFile({ format: 2 })), marker), false);
});
