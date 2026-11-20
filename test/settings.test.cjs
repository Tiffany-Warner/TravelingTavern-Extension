'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { createHarness, stRequest, gzip } = require('./helpers/fake-st.cjs');

const loaded = { username: 'User', power_user: { theme: 'dark' } };

test('server unchanged: save is sent, fingerprint becomes the sent payload', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    const edited = { ...loaded, username: 'Renamed' };
    const response = await h.saveSettings(edited);
    assert.deepStrictEqual(await response.json(), { result: 'ok' });
    assert.deepStrictEqual(h.serverSettings(), edited);
    assert.strictEqual(h.posts.length, 0);
});

test('server changed elsewhere: save blocked, synthetic ok, file kept', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    const otherDevice = { ...loaded, power_user: { theme: 'light', persona: 'New persona' } };
    h.otherDeviceWrites(otherDevice);
    const response = await h.saveSettings({ ...loaded, username: 'Renamed' });
    assert.deepStrictEqual(await response.json(), { result: 'ok' });
    assert.deepStrictEqual(h.serverSettings(), otherDevice);
    assert.strictEqual(h.sentSaves().length, 0);
    assert.deepStrictEqual(h.posts, [{ type: 'saveBlocked', kind: 'settings', reason: 'changed', hadChanges: null }]);
});

test('no-change save is not sent; stale server reported', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    h.otherDeviceWrites({ ...loaded, username: 'Phone' });
    const response = await h.saveSettings({ power_user: { theme: 'dark' }, username: 'User' });
    assert.deepStrictEqual(await response.json(), { result: 'ok' });
    assert.strictEqual(h.sentSaves().length, 0);
    assert.strictEqual(h.serverSettings().username, 'Phone');
    assert.deepStrictEqual(h.posts, [{ type: 'staleSettings' }]);
});

test('no-change save with fresh server: nothing sent, nothing reported', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    await h.saveSettings(loaded);
    assert.strictEqual(h.sentSaves().length, 0);
    assert.strictEqual(h.posts.length, 0);
});

test('after own save the base is the sent payload, never a read-back', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    await h.saveSettings({ ...loaded, username: 'A' });
    // Another device writes between our save and our next one.
    h.otherDeviceWrites({ ...loaded, username: 'A', power_user: { theme: 'light' } });
    await h.saveSettings({ ...loaded, username: 'B' });
    assert.strictEqual(h.serverSettings().power_user.theme, 'light');
    assert.deepStrictEqual(h.posts, [{ type: 'saveBlocked', kind: 'settings', reason: 'changed', hadChanges: true }]);
});

test('queue: second save compares against the first one\'s payload', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    const first = h.saveSettings({ ...loaded, username: 'A' });
    const second = h.saveSettings({ ...loaded, username: 'B' });
    await Promise.all([first, second]);
    assert.strictEqual(h.serverSettings().username, 'B');
    assert.strictEqual(h.sentSaves().length, 2);
    assert.strictEqual(h.posts.length, 0);
});

test('server unreadable: blocked as unreachable (fail closed)', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    h.server.failReads = true;
    await h.saveSettings({ ...loaded, username: 'A' });
    assert.strictEqual(h.sentSaves().length, 0);
    assert.deepStrictEqual(h.posts, [{ type: 'saveBlocked', kind: 'settings', reason: 'unreachable', hadChanges: null }]);
});

test('no base (settings never read through the guard): blocked as unseen', async () => {
    const h = createHarness({ settings: loaded });
    await h.saveSettings({ ...loaded, username: 'A' });
    assert.strictEqual(h.sentSaves().length, 0);
    assert.deepStrictEqual(h.posts, [{ type: 'saveBlocked', kind: 'settings', reason: 'unseen', hadChanges: null }]);
});

test('server answer without result ok: base not moved to the payload', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    h.server.saveAnswer = { code: 'EACCES' };
    await h.saveSettings({ ...loaded, username: 'A' });
    h.server.saveAnswer = null;
    // The file still holds `loaded`, so a save from the page's copy still matches.
    await h.saveSettings({ ...loaded, username: 'B' });
    assert.strictEqual(h.serverSettings().username, 'B');
    assert.strictEqual(h.posts.length, 0);
});

test('key order and whitespace never count as a change', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    h.server.settingsText = '{"power_user":{"theme":"dark"},"username":"User"}';
    await h.saveSettings({ ...loaded, username: 'A' });
    assert.strictEqual(h.serverSettings().username, 'A');
    assert.strictEqual(h.posts.length, 0);
});

test('gzip body (Content-Encoding: gzip) is read and checked', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    h.otherDeviceWrites({ ...loaded, username: 'Phone' });
    const request = stRequest({});
    request.headers['Content-Encoding'] = 'gzip';
    request.body = await gzip(JSON.stringify({ ...loaded, username: 'A' }));
    await h.guard.handleFetch('/api/settings/save', request);
    assert.strictEqual(h.serverSettings().username, 'Phone');
    assert.strictEqual(h.posts[0].reason, 'changed');
});

test('unreadable body (bad gzip, stream, bad JSON) is blocked', async () => {
    const bodies = [
        { headers: { 'Content-Encoding': 'gzip' }, body: new Uint8Array([1, 2, 3]) },
        { body: new ReadableStream() },
        { body: '{not json' },
    ];
    for (const extra of bodies) {
        const h = createHarness({ settings: loaded });
        await h.loadSettings();
        const response = await h.saveSettings({}, extra);
        assert.deepStrictEqual(await response.json(), { result: 'ok' });
        assert.strictEqual(h.sentSaves().length, 0);
        assert.strictEqual(h.posts[0].type, 'saveBlocked');
    }
});

test('freshness check: rate-limited to one settings read per 5 s', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    const reads = () => h.requests.filter((r) => r.path.endsWith('/api/settings/get')).length;
    const before = reads();
    assert.strictEqual((await h.guard.checkFresh()).settingsChanged, false);
    h.otherDeviceWrites({ ...loaded, username: 'Phone' });
    assert.strictEqual((await h.guard.checkFresh()).settingsChanged, false);
    assert.strictEqual(reads(), before + 1);
    h.advance(5000);
    assert.strictEqual((await h.guard.checkFresh()).settingsChanged, true);
    assert.deepStrictEqual(h.posts, [{ type: 'staleSettings' }]);
});

test('freshness check: read failure is unknown, not changed', async () => {
    const h = createHarness({ settings: loaded });
    await h.loadSettings();
    h.server.failReads = true;
    assert.strictEqual((await h.guard.checkFresh()).settingsChanged, null);
    assert.strictEqual(h.posts.length, 0);
});

test('guard reads reuse ST\'s CSRF token and path prefix', async () => {
    const h = createHarness({ settings: loaded });
    await h.guard.handleFetch('/st/api/settings/get', stRequest({}));
    await h.guard.handleFetch('/st/api/settings/save', stRequest({ ...loaded, username: 'A' }));
    const guardRead = h.requests.filter((r) => r.path === '/st/api/settings/get')[1];
    assert.ok(guardRead, 'guard read uses the prefix');
    assert.strictEqual(new Headers(guardRead.init.headers).get('X-CSRF-Token'), 'test-token');
});
