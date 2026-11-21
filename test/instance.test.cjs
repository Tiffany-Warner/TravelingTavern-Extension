'use strict';

// One lease instance per page (spec E11): main frame only, never on the login page, a second copy
// stands down, window.__ttLease frozen with no off switch; index.js's versions.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { isLoginPage, LEASE_VERSION } = require('../session-lease.js');
const manifest = require('../manifest.json');
const { leaseFile, LEASE, MARKER } = require('./helpers/fake-server.cjs');
const { createFakeWindow, flush, track } = require('./helpers/fake-window.cjs');

test('installs once; a second copy stands down completely', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-b' }) } });
    assert.strictEqual(w.install(), true);
    const wrappedFetch = w.win.fetch;
    const api = w.win.__ttLease;
    assert.strictEqual(w.install(), false);
    assert.strictEqual(w.win.fetch, wrappedFetch, 'no second wrapper');
    assert.strictEqual(w.win.__ttLease, api);
});

test('window.__ttLease: frozen, non-writable, non-configurable, only the contract’s members', () => {
    const w = createFakeWindow();
    w.install();
    const api = w.win.__ttLease;
    assert.deepStrictEqual(Object.keys(api).sort(), ['onForeground', 'source', 'useHere', 'version']);
    assert.strictEqual(Object.isFrozen(api), true);
    assert.strictEqual(api.version, LEASE_VERSION);
    const descriptor = Object.getOwnPropertyDescriptor(w.win, '__ttLease');
    assert.deepStrictEqual([descriptor.writable, descriptor.configurable], [false, false]);
    assert.throws(() => { 'use strict'; w.win.__ttLease = {}; }, TypeError);
});

test('source: extension when marked by index.js, app otherwise', () => {
    const desktop = createFakeWindow({ source: 'extension' });
    desktop.install();
    assert.strictEqual(desktop.win.__ttLease.source, 'extension');
    const app = createFakeWindow({ source: 'something-else' });
    app.install();
    assert.strictEqual(app.win.__ttLease.source, 'app');
});

test('not in a child frame', () => {
    const w = createFakeWindow({ frame: true });
    assert.strictEqual(w.install(), false);
    assert.strictEqual('__ttLease' in w.win, false);
});

test('never on the login page (pathname, trailing slashes, case; the query is not in the pathname)', () => {
    for (const pathname of ['/login', '/login/', '/LOGIN', '/login//', '/st/login']) {
        assert.strictEqual(isLoginPage(pathname), true, pathname);
        const w = createFakeWindow({ pathname });
        assert.strictEqual(w.install(), false, pathname);
        assert.strictEqual('__ttLease' in w.win, false);
    }
    for (const pathname of ['/', '/index.html', '/loginx', '/login.html', '/my-login-page']) {
        assert.strictEqual(isLoginPage(pathname), false, pathname);
    }
});

test('desktop releases on pagehide; the app’s page never does (the app releases from Kotlin)', async () => {
    const desktop = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    desktop.install();
    await flush();
    desktop.fire('pagehide');
    await flush();
    assert.strictEqual(desktop.harness.markerFile().holder, desktop.events[0].pageId);

    const app = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, app: true });
    app.install();
    await flush();
    app.fire('pagehide');
    await flush();
    assert.strictEqual(app.server.files.has(MARKER), false);
});

test('desktop: a holder restored from the back/forward cache after releasing parks and reloads', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    w.install();
    await flush();
    w.fire('pagehide');
    w.fire('pageshow', { persisted: true });
    await flush();
    assert.strictEqual(w.win.location.reloads, 1);
    const save = w.win.fetch('/api/settings/save', { method: 'POST' });
    let settled = false;
    save.then(() => { settled = true; }, () => { settled = true; });
    await flush();
    assert.strictEqual(settled, false, 'a write at restore is held');
});

test('desktop releases on freeze (a frozen tab may be discarded without pagehide); the app’s page never does', async () => {
    const desktop = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    desktop.install();
    await flush();
    const state = desktop.events.find((e) => e.type === 'leaseState' && e.state === 'holder');
    desktop.fireDocument('freeze');
    await flush();
    const marker = desktop.harness.markerFile();
    assert.deepStrictEqual([marker.holder, marker.epoch], [state.pageId, state.epoch], 'the marker names the exact pair');

    const app = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, app: true });
    app.install();
    await flush();
    app.fireDocument('freeze');
    await flush();
    assert.strictEqual(app.server.files.has(MARKER), false);
});

test('desktop: resume after freeze holds again without a reload; a request at resume waits, then is sent', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    w.install();
    await flush();
    w.fireDocument('freeze');
    await flush();
    w.fireDocument('resume');
    const save = track(w.win.fetch('/api/settings/save', { method: 'POST' }));
    assert.strictEqual(w.server.stRequests.some((r) => r.url === '/api/settings/save'), false, 'waits for the check');
    await flush(60);
    assert.strictEqual(w.win.location.reloads, 0);
    assert.strictEqual(w.events.filter((e) => e.type === 'leaseState').at(-1).state, 'holder');
    assert.strictEqual(w.server.stRequests.some((r) => r.url === '/api/settings/save'), true, 'sent once holder again');
    assert.strictEqual(save.settled(), true);
});

test('desktop: resume after freeze when another page claimed: parks as lost; the request is held, never sent', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    w.install();
    await flush();
    w.fireDocument('freeze');
    await flush();
    w.harness.setFile(LEASE, leaseFile({ holder: 'page-b.load', epoch: 9 }));
    w.fireDocument('resume');
    const save = track(w.win.fetch('/api/settings/save', { method: 'POST' }));
    await flush(60);
    assert.strictEqual(w.events.filter((e) => e.type === 'leaseState').at(-1).reason, 'lost');
    assert.strictEqual(w.server.stRequests.some((r) => r.url === '/api/settings/save'), false);
    assert.strictEqual(save.settled(), false);
    assert.strictEqual(w.win.location.reloads, 0);
});

test('desktop: pagehide then freeze writes one marker; a back/forward-cache restore still reloads', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a' }) }, source: 'extension' });
    w.install();
    await flush();
    w.fire('pagehide');
    w.fireDocument('freeze');
    await flush();
    assert.strictEqual(w.harness.uploads.filter((u) => u.name === MARKER).length, 1);
    w.fireDocument('resume');
    w.fire('pageshow', { persisted: true });
    await flush();
    assert.strictEqual(w.win.location.reloads, 1);
});

test('an automatic claim at start reloads the page', async () => {
    const w = createFakeWindow();
    w.install();
    await flush();
    assert.strictEqual(w.win.location.reloads, 1);
});

test('index.js versions match manifest.json and session-lease.js', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
    assert.strictEqual(source.match(/const EXTENSION_VERSION = '([^']+)'/)[1], manifest.version);
    assert.strictEqual(Number(source.match(/const LEASE_VERSION = (\d+)/)[1]), LEASE_VERSION);
});
