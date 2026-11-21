'use strict';

// Messages (spec E11): leaseState, leaseInfo, to the app or as tt-lease with type; no CSRF token or
// ST data in any message.

const test = require('node:test');
const assert = require('node:assert');
const { buildLeaseInfo, makePost, LEASE_VERSION } = require('../session-lease.js');
const { leaseFile, LEASE } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush } = require('./helpers/fake-window.cjs');

const STATE_FIELDS = ['type', 'state', 'reason', 'pageId', 'epoch', 'busy', 'connected', 'origin'].sort();
const INFO_FIELDS = ['type', 'leaseVersion', 'extensionVersion', 'extensionLeaseVersion', 'stVersion', 'untestedServer'].sort();

test('makePost: to the app as a JSON string in the v1 envelope', () => {
    const sent = [];
    const win = { TravelingTavern: { postMessage: (text) => sent.push(text) } };
    makePost(win)('leaseState', { state: 'holder' });
    assert.deepStrictEqual(sent.map((t) => JSON.parse(t)), [{ v: 1, type: 'leaseState', state: 'holder' }]);
});

test('makePost: without the app, a tt-lease event with type in detail', () => {
    const events = [];
    const win = {
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        dispatchEvent: (event) => events.push([event.type, event.detail]),
    };
    makePost(win)('leaseInfo', { leaseVersion: 1 });
    assert.deepStrictEqual(events, [['tt-lease', { type: 'leaseInfo', leaseVersion: 1 }]]);
});

test('buildLeaseInfo: versions, untested server, missing extension', () => {
    assert.deepStrictEqual(buildLeaseInfo('1.19.1', { version: '0.2.0', leaseVersion: 1 }), {
        leaseVersion: LEASE_VERSION, extensionVersion: '0.2.0', extensionLeaseVersion: 1, stVersion: '1.19.1', untestedServer: false,
    });
    assert.deepStrictEqual(buildLeaseInfo('1.20.0', undefined), {
        leaseVersion: LEASE_VERSION, extensionVersion: null, extensionLeaseVersion: null, stVersion: '1.20.0', untestedServer: true,
    });
    const unknown = buildLeaseInfo(null, { version: 2, leaseVersion: '1' });
    assert.deepStrictEqual([unknown.stVersion, unknown.untestedServer, unknown.extensionVersion, unknown.extensionLeaseVersion], [null, true, null, null]);
});

test('desktop: leaseState then leaseInfo as tt-lease events, with exactly the contract’s fields', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension' });
    w.win.__ttExtension = Object.freeze({ version: '0.0.1', leaseVersion: 1 });
    w.install();
    await flush();
    assert.deepStrictEqual(w.events.map((e) => e.type), ['leaseState', 'leaseInfo']);
    const [state, info] = w.events;
    assert.deepStrictEqual(Object.keys(state).sort(), STATE_FIELDS);
    assert.deepStrictEqual(Object.keys(info).sort(), INFO_FIELDS);
    assert.deepStrictEqual([state.state, state.reason, state.epoch, state.busy, state.connected, state.origin], ['parked', 'held', null, false, false, 'http://localhost']);
    assert.match(state.pageId, /^page-a\.[0-9a-f]{16}$/);
    assert.deepStrictEqual([info.stVersion, info.untestedServer, info.extensionVersion], ['1.19.1', false, '0.0.1']);
});

test('app: messages go to the app listener, not as events; leaseInfo again on tt-extension-ready', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, app: true });
    w.install();
    await flush();
    assert.deepStrictEqual(w.events, []);
    assert.deepStrictEqual(w.appMessages.map((m) => [m.v, m.type]), [[1, 'leaseState'], [1, 'leaseInfo']]);
    assert.strictEqual(w.appMessages[0].state, 'holder');
    w.fire('tt-extension-ready');
    assert.deepStrictEqual(w.appMessages.map((m) => m.type), ['leaseState', 'leaseInfo', 'leaseInfo']);
});

test('no message carries the CSRF token', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, app: true });
    w.server.csrfToken = 'secret-test-token';
    w.install();
    await flush();
    await w.win.__ttLease.useHere();
    await flush();
    assert.ok(w.appMessages.length >= 3);
    for (const message of w.appMessages) assert.strictEqual(JSON.stringify(message).includes('secret-test-token'), false);
});
