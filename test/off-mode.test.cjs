'use strict';

// Turn off protection (spec E4, E11): only when offered, a per-tab flag that survives a refresh and
// is cleared by Turn protection back on, the one-load fallback when storage is blocked, and the
// stood-down page (no wrapper, no lease I/O, state 'off').

const test = require('node:test');
const assert = require('node:assert');
const { STORAGE_KEYS, OFF_ONCE_NAME_PREFIX } = require('../session-lease.js');
const { leaseFile, LEASE } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush } = require('./helpers/fake-window.cjs');

const DAMAGED = { [LEASE]: 'not json' };

/** A Navigation Timing stub for one load of the given type. */
function navigation(type) {
    return { getEntriesByType: (kind) => (kind === 'navigation' ? [{ type }] : []) };
}

/** The next load in the same tab: same server, a copy of this tab's sessionStorage. */
function refresh(w, options = {}) {
    return createFakeWindow(Object.assign({ harness: w.harness, storage: Object.fromEntries(w.win.sessionStorage.map) }, options));
}

test('only when offered: a held page can’t turn protection off', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension' });
    w.install();
    await flush();
    assert.strictEqual(w.win.__ttLease.turnOffProtection(), false);
    assert.strictEqual(w.win.sessionStorage.map.has(STORAGE_KEYS.off), false);
    await flush();
    assert.strictEqual(w.win.location.reloads, 0);
});

test('on an error state: sets the tab’s flag and reloads; held requests are never sent', async () => {
    const w = createFakeWindow({ files: DAMAGED, source: 'extension' });
    w.install();
    await flush();
    assert.strictEqual(w.events.filter((e) => e.type === 'leaseState').at(-1).reason, 'damaged');
    let rejected = null;
    w.win.fetch('/api/chats/save', { method: 'POST' }).catch((error) => { rejected = error.name; });
    await flush();
    assert.strictEqual(w.win.__ttLease.turnOffProtection(), true);
    await flush();
    assert.strictEqual(w.win.sessionStorage.map.get(STORAGE_KEYS.off), '1');
    assert.strictEqual(w.win.location.reloads, 1);
    assert.strictEqual(rejected, 'AbortError', 'the held save is aborted before the reload (no Leave site?)');
    assert.strictEqual(w.server.stRequests.length, 0, 'the held save never reached the server');
});

test('off: no wrapper, no lease reads or writes, state off; requests go straight through', async () => {
    const before = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension', storage: { [STORAGE_KEYS.off]: '1' } });
    const original = before.win.fetch;
    assert.strictEqual(before.install(), true);
    await flush();
    assert.strictEqual(before.win.fetch, original, 'fetch not wrapped');
    await before.win.fetch('/api/chats/save', { method: 'POST' });
    assert.strictEqual(before.server.stRequests.length, 1);
    assert.strictEqual(before.server.leaseReads, 0);
    assert.strictEqual(before.harness.uploads.length, 0);
    const state = before.events.find((e) => e.type === 'leaseState');
    assert.deepStrictEqual([state.state, state.reason, state.pageId, state.epoch, state.actions],
        ['off', null, null, null, ['turnProtectionOn']]);
    assert.ok(before.events.some((e) => e.type === 'leaseInfo'), 'versions still reported');
    assert.strictEqual(before.install(), false, 'a second copy stands down');
});

test('off survives a refresh of the tab; Turn protection back on clears it and reloads protected', async () => {
    const off = createFakeWindow({ files: DAMAGED, source: 'extension', storage: { [STORAGE_KEYS.off]: '1' } });
    off.install();
    const again = refresh(off, { source: 'extension' });
    again.install();
    assert.strictEqual(again.events[0].state, 'off');
    assert.strictEqual(again.win.__ttLease.turnProtectionOn(), true);
    assert.strictEqual(again.win.sessionStorage.map.has(STORAGE_KEYS.off), false);
    assert.strictEqual(again.win.location.reloads, 1);
    again.harness.setFile(LEASE, leaseFile({ holder: 'page-b' }));
    const back = refresh(again, { source: 'extension' });
    back.install();
    await flush();
    assert.deepStrictEqual([back.events[0].state, back.events[0].reason], ['parked', 'held']);
});

test('off: onForeground re-posts the state; the other members do nothing', async () => {
    const w = createFakeWindow({ app: true, storage: { [STORAGE_KEYS.off]: '1' } });
    w.install();
    await w.win.__ttLease.onForeground();
    assert.deepStrictEqual(w.appMessages.filter((m) => m.type === 'leaseState').map((m) => m.state), ['off', 'off']);
    assert.deepStrictEqual(await w.win.__ttLease.useHere(), { status: 'ignored' });
    assert.deepStrictEqual(await w.win.__ttLease.takeOverAnyway(), { status: 'ignored' });
    assert.strictEqual(w.win.__ttLease.refresh(), false);
    assert.strictEqual(w.win.__ttLease.turnOffProtection(), false);
});

test('storage blocked: off applies to the next load only (window.name), and the name is restored', async () => {
    const w = createFakeWindow({ files: DAMAGED, source: 'extension' });
    const blocked = () => { throw new Error('SecurityError'); };
    w.win.sessionStorage = { map: new Map(), getItem: blocked, setItem: blocked, removeItem: blocked };
    w.win.name = 'earlier-name';
    w.install();
    await flush();
    assert.strictEqual(w.win.__ttLease.turnOffProtection(), true);
    assert.strictEqual(w.win.name, OFF_ONCE_NAME_PREFIX + 'earlier-name');
    const next = createFakeWindow({ harness: w.harness, source: 'extension', storage: null });
    next.win.sessionStorage = w.win.sessionStorage;
    next.win.name = w.win.name;
    next.win.performance = navigation('reload');
    next.install();
    assert.strictEqual(next.events[0].state, 'off');
    assert.strictEqual(next.win.name, 'earlier-name');
    const after = createFakeWindow({ harness: w.harness, source: 'extension', storage: null });
    after.win.sessionStorage = w.win.sessionStorage;
    after.win.name = next.win.name;
    after.install();
    await flush();
    assert.strictEqual(after.events[0].state, 'parked', 'protected again');
});

test('refresh(): only when offered; aborts held chat saves and reloads', async () => {
    const held = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension' });
    held.install();
    await flush();
    assert.strictEqual(held.win.__ttLease.refresh(), false);
    const w = createFakeWindow({ files: DAMAGED, source: 'extension' });
    w.install();
    await flush();
    let rejected = null;
    w.win.fetch('/api/chats/save', { method: 'POST' }).catch((error) => { rejected = error.name; });
    await flush();
    assert.strictEqual(w.win.__ttLease.refresh(), true);
    await flush();
    assert.strictEqual(rejected, 'AbortError');
    assert.strictEqual(w.win.location.reloads, 1);
});

test('window.name mark from another site: ignored on a fresh navigation and whenever sessionStorage works', async () => {
    const blocked = () => { throw new Error('SecurityError'); };
    // A site opens ST in a window it named with the prefix: a navigate load, storage blocked.
    const opened = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension' });
    opened.win.sessionStorage = { map: new Map(), getItem: blocked, setItem: blocked, removeItem: blocked };
    opened.win.name = OFF_ONCE_NAME_PREFIX + 'x';
    opened.win.performance = navigation('navigate');
    opened.install();
    await flush();
    assert.deepStrictEqual([opened.events[0].state, opened.events[0].reason], ['parked', 'held']);
    assert.strictEqual(opened.win.name, 'x', 'the prefix is removed');
    // A reload with working sessionStorage: the prefix can't have come from Turn off protection.
    const reloaded = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension' });
    reloaded.win.name = OFF_ONCE_NAME_PREFIX;
    reloaded.win.performance = navigation('reload');
    reloaded.install();
    await flush();
    assert.strictEqual(reloaded.events[0].state, 'parked');
    // No Navigation Timing at all: not a reload, ignored.
    const unknown = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) }, source: 'extension' });
    unknown.win.sessionStorage = { map: new Map(), getItem: blocked, setItem: blocked, removeItem: blocked };
    unknown.win.name = OFF_ONCE_NAME_PREFIX;
    unknown.install();
    await flush();
    assert.strictEqual(unknown.events[0].state, 'parked');
});
