'use strict';

const test = require('node:test');
const assert = require('node:assert');
const guardModule = require('../save-guard.js');
const { canonicalJson, hashJson, jsonEqual, requestPath, install, GUARD_VERSION } = guardModule;
const { createHarness } = require('./helpers/fake-st.cjs');

test('canonical JSON and hash ignore key order', () => {
    const a = { b: 1, a: { d: [1, { y: 2, x: 1 }], c: null } };
    const b = { a: { c: null, d: [1, { x: 1, y: 2 }] }, b: 1 };
    assert.strictEqual(canonicalJson(a), canonicalJson(b));
    assert.strictEqual(hashJson(a), hashJson(b));
    assert.ok(jsonEqual(a, b));
    assert.notStrictEqual(hashJson(a), hashJson({ ...b, b: 2 }));
});

test('hash is pure JS: works with crypto.subtle missing', () => {
    const saved = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true });
    try {
        assert.match(hashJson({ name: 'Example Lorebook' }), /^[0-9a-f]+-[0-9a-f]+$/);
    } finally {
        Object.defineProperty(globalThis, 'crypto', saved);
    }
});

test('request paths are normalized (case, trailing slash, absolute URL)', () => {
    assert.strictEqual(requestPath('/API/Settings/Save/'), '/api/settings/save');
    assert.strictEqual(requestPath('http://localhost:8000/api/settings/save'), '/api/settings/save');
    assert.strictEqual(requestPath(new URL('http://localhost/api/settings/get')), '/api/settings/get');
});

test('other requests pass through untouched', async () => {
    const h = createHarness();
    const init = { method: 'POST', body: '{}' };
    const response = await h.guard.handleFetch('/api/characters/chats', init);
    assert.deepStrictEqual(await response.json(), { untouched: true });
    assert.strictEqual(h.requests.length, 1);
    assert.strictEqual(h.requests[0].init, init);
    await h.guard.handleFetch('/api/settings/save', { method: 'GET' });
    assert.strictEqual(h.requests.length, 2);
});

test('variant spellings of a save URL are still guarded', async () => {
    const h = createHarness();
    await h.guard.handleFetch('/API/settings/save/', { method: 'post', body: '{"username":"A"}' });
    assert.strictEqual(h.sentSaves().length, 0);
    assert.strictEqual(h.posts[0].reason, 'unseen');
});

test('XHR refuses whole-file saves only', () => {
    const { guard } = createHarness();
    assert.ok(guard.refusesXhr('POST', '/api/settings/save'));
    assert.ok(guard.refusesXhr('post', '/api/worldinfo/edit'));
    assert.ok(guard.refusesXhr('POST', '/api/chats/save'));
    assert.ok(guard.refusesXhr('POST', '/api/characters/edit'));
    assert.ok(!guard.refusesXhr('POST', '/api/characters/chats'));
    assert.ok(!guard.refusesXhr('GET', '/api/settings/save'));
});

/** A minimal fake browser window for install(). */
function fakeWindow(extra = {}) {
    const events = [];
    class FakeXhr {
        open() {}
        send() { this.sent = true; }
    }
    const win = {
        fetch: async () => Response.json({ settings: '{}' }),
        console: { log() {}, warn() {}, error() {} },
        XMLHttpRequest: FakeXhr,
        DOMException,
        CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init.detail; } },
        dispatchEvent: (event) => events.push(event),
        events,
        ...extra,
    };
    win.top = win;
    return win;
}

test('install: once, frozen, source read at install, no off switch', () => {
    const win = fakeWindow({ __ttGuardSource: 'extension' });
    assert.ok(install(win));
    const api = win.__ttSaveGuard;
    assert.strictEqual(api.version, GUARD_VERSION);
    assert.strictEqual(api.source, 'extension');
    assert.ok(Object.isFrozen(api));
    assert.deepStrictEqual(Object.keys(api).sort(), ['checkChat', 'checkFresh', 'pendingSaves', 'source', 'version']);
    win.__ttGuardSource = 'app';
    assert.strictEqual(api.source, 'extension');
    assert.ok(!install(win));
    assert.throws(() => { 'use strict'; win.__ttSaveGuard = {}; });
    assert.strictEqual(win.__ttSaveGuard, api);
});

test('install: default source "app", unknown source ignored; not in sub-frames', () => {
    const win = fakeWindow({ __ttGuardSource: 'something' });
    install(win);
    assert.strictEqual(win.__ttSaveGuard.source, 'app');
    const frame = fakeWindow();
    frame.top = {};
    assert.ok(!install(frame));
    assert.strictEqual(frame.__ttSaveGuard, undefined);
});

test('install: XHR to a save URL throws; others are sent', () => {
    const win = fakeWindow();
    install(win);
    const blocked = new win.XMLHttpRequest();
    blocked.open('POST', '/api/settings/save');
    assert.throws(() => blocked.send('{}'), { name: 'NetworkError' });
    const allowed = new win.XMLHttpRequest();
    allowed.open('POST', '/api/characters/chats');
    allowed.send('{}');
    assert.ok(allowed.sent);
});

test('install: desktop reports go out as tt-save-guard events; app reports to its listener', async () => {
    const desktop = fakeWindow();
    install(desktop);
    await desktop.fetch('/api/settings/save', { method: 'POST', body: '{}' });
    assert.strictEqual(desktop.events[0].type, 'tt-save-guard');
    assert.strictEqual(desktop.events[0].detail.type, 'saveBlocked');

    const messages = [];
    const app = fakeWindow({ TravelingTavern: { postMessage: (text) => messages.push(JSON.parse(text)) } });
    install(app);
    await app.fetch('/api/settings/save', { method: 'POST', body: '{}' });
    assert.deepStrictEqual(messages, [{ v: 1, type: 'saveBlocked', kind: 'settings', reason: 'unseen', hadChanges: null }]);
});
