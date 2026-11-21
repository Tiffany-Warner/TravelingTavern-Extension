'use strict';

// Model connection after a takeover reload (spec E10): ST's connect button pressed once, only after
// Use here / onForeground and only while not connected; `notConnected` when ST's attempt fails
// (ONLINE_STATUS_CHANGED, or the bounded 10 s wait); `leaseState.connected` tracks ST.

const test = require('node:test');
const assert = require('node:assert');
const { decideConnect, isConnected, isConnecting, createStHooks, CONNECT_BUTTONS, CONNECT_WAIT_MS } = require('../session-lease.js');
const { createHarness, leaseFile, LEASE, KEYS } = require('./helpers/fake-server.cjs');
const { createFakeSt, createFakeTimers, EVENT_TYPES } = require('./helpers/fake-st.cjs');
const { createFakeWindow, flush } = require('./helpers/fake-window.cjs');

/**
 * The load right after a claim of `kind`, with ST hooks around a fake ST.
 * @param {string} kind The claim's kind.
 * @param {object} [stOptions] Fake ST options.
 * @param {boolean} [connecting] ST's connect button carries `disabled` (an attempt is running).
 */
function afterClaim(kind, stOptions, connecting = false) {
    const h = createHarness({
        files: { [LEASE]: leaseFile({ holder: 'page-a.0123456789abcdef', epoch: 5 }) },
        storage: { [KEYS.tabId]: 'page-a', [KEYS.reopen]: kind },
    });
    const st = createFakeSt(Object.assign({ characterId: 0 }, stOptions));
    const timers = createFakeTimers();
    const clicks = [];
    const notices = [];
    const hooks = createStHooks({
        getContext: st.getContext,
        lease: h.lease,
        post: (type, payload) => notices.push(Object.assign({ type }, payload)),
        log: () => {},
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        querySelector: (selector) => ({
            click: () => clicks.push(selector),
            classList: { contains: (name) => connecting && name === 'disabled' },
        }),
    });
    hooks.attach(st.getContext());
    return { h, st, timers, clicks, notices, hooks };
}

/** Lets the hooks' promises run (lease I/O is a fake, timers are fake). */
function settle() {
    return new Promise((resolve) => setTimeout(resolve, 10));
}

test('decideConnect: only after Use here / onForeground, only while not connected; button by main_api', () => {
    assert.deepStrictEqual(decideConnect('useHere', 'no_connection', 'openai'), { action: 'press', button: '#api_button_openai' });
    assert.deepStrictEqual(decideConnect('foreground', 'no_connection', 'kobold'), { action: 'press', button: '#api_button' });
    assert.deepStrictEqual(decideConnect('useHere', 'no_connection', 'novel'), { action: 'press', button: '#api_button_novel' });
    assert.deepStrictEqual(decideConnect('useHere', 'no_connection', 'textgenerationwebui'), { action: 'press', button: '#api_button_textgenerationwebui' });
    assert.deepStrictEqual(decideConnect('useHere', 'no_connection', 'koboldhorde'), { action: 'press', button: null });
    assert.deepStrictEqual(decideConnect('useHere', 'no_connection', 'toString'), { action: 'press', button: null }, 'own keys only');
    assert.deepStrictEqual(decideConnect('automatic', 'no_connection', 'openai'), { action: 'none', why: 'automatic' });
    assert.deepStrictEqual(decideConnect(null, 'no_connection', 'openai'), { action: 'none', why: 'automatic' });
    assert.deepStrictEqual(decideConnect('useHere', 'Valid', 'openai'), { action: 'none', why: 'connected' });
    assert.deepStrictEqual(Object.keys(CONNECT_BUTTONS).sort(), ['kobold', 'novel', 'openai', 'textgenerationwebui']);
});

test('isConnected: anything but no_connection, with a context', () => {
    assert.strictEqual(isConnected({ onlineStatus: 'Valid' }), true);
    assert.strictEqual(isConnected({ onlineStatus: 'no_connection' }), false);
    assert.strictEqual(isConnected(null), false);
    assert.strictEqual(isConnected({}), false);
});

test('Use here: presses the button once; ST connects: no notice, connected reported', async () => {
    const t = afterClaim('useHere');
    const done = t.hooks.afterAppReady();
    await settle();
    assert.deepStrictEqual(t.clicks, ['#api_button_openai']);
    assert.deepStrictEqual(t.timers.pending(), [CONNECT_WAIT_MS]);
    assert.deepStrictEqual(t.st.calls, [['selectCharacterById', 0], ['openCharacterChat', 'Example Chat']], 'the reopen doesn’t wait for the connection');
    t.st.setOnlineStatus('Valid');
    await done;
    assert.deepStrictEqual(t.notices, []);
    assert.deepStrictEqual(t.timers.pending(), [], 'the wait is cleared');
    assert.strictEqual(t.st.eventSource.count(EVENT_TYPES.ONLINE_STATUS_CHANGED), 1, 'only the connected tracker stays');
    assert.strictEqual(t.h.lease.status().connected, true);
    assert.strictEqual(t.h.posts.at(-1).connected, true);
});

test('onForeground: still not connected after the wait → one notConnected notice', async () => {
    const t = afterClaim('foreground');
    const done = t.hooks.afterAppReady();
    await settle();
    t.timers.runAll();
    await done;
    assert.deepStrictEqual(t.clicks, ['#api_button_openai']);
    assert.deepStrictEqual(t.notices, [{ type: 'leaseNotice', kind: 'notConnected' }]);
    assert.strictEqual(t.h.lease.status().connected, false);
});

test('connected at the end of the wait without a change event: no notice', async () => {
    const t = afterClaim('useHere');
    const done = t.hooks.afterAppReady();
    await settle();
    t.st.onlineStatus = 'Valid';
    t.timers.runAll();
    await done;
    assert.deepStrictEqual(t.notices, []);
});

test('isConnecting: ST’s disabled class on the connect button', () => {
    const button = (classes) => ({ classList: { contains: (name) => classes.includes(name) } });
    assert.strictEqual(isConnecting(button(['api_button', 'disabled'])), true);
    assert.strictEqual(isConnecting(button(['api_button'])), false);
    assert.strictEqual(isConnecting(null), false);
    assert.strictEqual(isConnecting({}), false);
});

test('ST already connecting (its own Auto-connect): no second press; its attempt still decides', async () => {
    const t = afterClaim('useHere', {}, true);
    const done = t.hooks.afterAppReady();
    await settle();
    assert.deepStrictEqual(t.clicks, []);
    assert.deepStrictEqual(t.timers.pending(), [CONNECT_WAIT_MS]);
    t.st.setOnlineStatus('Valid');
    await done;
    assert.deepStrictEqual(t.notices, []);
});

test('ST already connecting and still not connected after the wait: notConnected', async () => {
    const t = afterClaim('useHere', {}, true);
    const done = t.hooks.afterAppReady();
    await settle();
    t.timers.runAll();
    await done;
    assert.deepStrictEqual([t.clicks, t.notices], [[], [{ type: 'leaseNotice', kind: 'notConnected' }]]);
});

test('the automatic claim never presses connect, never reports notConnected', async () => {
    const t = afterClaim('automatic');
    await t.hooks.afterAppReady();
    assert.deepStrictEqual([t.clicks, t.notices, t.timers.pending()], [[], [], []]);
});

test('already connected (ST’s own Auto-connect): no press', async () => {
    const t = afterClaim('useHere', { onlineStatus: 'Valid' });
    await t.hooks.afterAppReady();
    assert.deepStrictEqual([t.clicks, t.notices, t.timers.pending()], [[], [], []]);
    assert.strictEqual(t.h.lease.status().connected, true);
});

test('an API without a connect button: nothing pressed, ST’s state decides after the wait', async () => {
    const t = afterClaim('useHere', { mainApi: 'koboldhorde' });
    const done = t.hooks.afterAppReady();
    await settle();
    t.timers.runAll();
    await done;
    assert.deepStrictEqual(t.clicks, []);
    assert.deepStrictEqual(t.notices, [{ type: 'leaseNotice', kind: 'notConnected' }]);
});

test('a page without a claim before it: no press, but connected is tracked', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    const st = createFakeSt({ characterId: 0 });
    const clicks = [];
    const hooks = createStHooks({
        getContext: st.getContext, lease: h.lease, post: () => {}, log: () => {},
        setTimeout, clearTimeout, querySelector: (s) => ({ click: () => clicks.push(s) }),
    });
    hooks.attach(st.getContext());
    await hooks.afterAppReady();
    assert.deepStrictEqual(clicks, []);
    st.setOnlineStatus('Valid');
    assert.strictEqual(h.lease.status().connected, true);
    st.setOnlineStatus('no_connection');
    assert.strictEqual(h.lease.status().connected, false);
});

test('install: hooks ST at once when its context exists; APP_READY reports connected in leaseState', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) }, app: true });
    const st = createFakeSt({ characterId: 0, onlineStatus: 'Valid' });
    w.win.SillyTavern = { getContext: st.getContext };
    w.install();
    st.eventSource.emit(EVENT_TYPES.APP_READY);
    await flush();
    const states = w.appMessages.filter((m) => m.type === 'leaseState');
    assert.deepStrictEqual([states.at(-1).state, states.at(-1).connected], ['holder', true]);
});

test('install at document start (the app): hooks ST on load, APP_READY already fired still runs', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) }, app: true });
    w.install();
    const st = createFakeSt({ characterId: 0, onlineStatus: 'Valid' });
    w.win.SillyTavern = { getContext: st.getContext };
    st.eventSource.emit(EVENT_TYPES.APP_READY);
    w.fire('load');
    await flush();
    assert.strictEqual(st.eventSource.count(EVENT_TYPES.CHAT_CHANGED), 1);
    const states = w.appMessages.filter((m) => m.type === 'leaseState');
    assert.strictEqual(states.at(-1).connected, true);
});

test('install at document start: getContext throws on load (ST not resumed yet), works one task later', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) }, app: true });
    w.install();
    const st = createFakeSt({ characterId: 0, onlineStatus: 'Valid' });
    let calls = 0;
    w.win.SillyTavern = {
        getContext: () => {
            calls += 1;
            if (calls === 1) throw new ReferenceError("Cannot access 'chat' before initialization");
            return st.getContext();
        },
    };
    st.eventSource.emit(EVENT_TYPES.APP_READY);
    w.fire('load');
    assert.strictEqual(st.eventSource.count(EVENT_TYPES.CHAT_CHANGED), 0);
    await flush();
    assert.strictEqual(st.eventSource.count(EVENT_TYPES.CHAT_CHANGED), 1);
    const states = w.appMessages.filter((m) => m.type === 'leaseState');
    assert.strictEqual(states.at(-1).connected, true);
});

test('install at document start: getContext still throwing after the retry → one warning, no hooks', async () => {
    const w = createFakeWindow({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) }, app: true });
    w.install();
    let calls = 0;
    const warnings = [];
    w.win.console.warn = (prefix, message) => warnings.push(message);
    w.win.SillyTavern = { getContext: () => { calls += 1; throw new ReferenceError('not initialized'); } };
    w.fire('load');
    await flush();
    assert.strictEqual(calls, 2);
    assert.deepStrictEqual(warnings.filter((m) => m.startsWith('SillyTavern context')),
        ['SillyTavern context not found: no reopen, no reconnect']);
});
