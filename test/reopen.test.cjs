'use strict';

// Reopening the chat after a claim's reload, and recording the open chat (spec E4): the reopen flag
// is read once per load; characters only (groups stay on the start screen); ST's startup chat
// changes don't overwrite `active` while the reopen is pending.

const test = require('node:test');
const assert = require('node:assert');
const { activeFromContext, decideReopen, createStHooks } = require('../session-lease.js');
const { createHarness, leaseFile, LEASE, KEYS } = require('./helpers/fake-server.cjs');
const { createFakeSt, createFakeTimers, EVENT_TYPES } = require('./helpers/fake-st.cjs');

const CHARACTERS = [{ avatar: 'Example Character.png' }, { avatar: 'Other Character.png' }];

/** The load right after a claim: the lease names an earlier load of this tab, the reopen flag is set. */
function afterClaimReload({ kind = 'useHere', active } = {}) {
    const fields = { holder: 'page-a.0123456789abcdef', epoch: 5 };
    if (active !== undefined) fields.active = active;
    return createHarness({
        files: { [LEASE]: leaseFile(fields) },
        storage: { [KEYS.tabId]: 'page-a', [KEYS.reopen]: kind },
    });
}

/** ST hooks around a harness page and a fake ST. */
function hooksFor(h, st, posts = []) {
    const timers = createFakeTimers();
    const logs = [];
    const hooks = createStHooks({
        getContext: st.getContext,
        lease: h.lease,
        post: (type, payload) => posts.push(Object.assign({ type }, payload)),
        log: (level, message, details) => logs.push({ level, message, details }),
        setTimeout: timers.setTimeout,
        clearTimeout: timers.clearTimeout,
        querySelector: () => null,
    });
    return { hooks, timers, logs, posts };
}

test('decideReopen: character by avatar; group and missing character skipped; nothing without active', () => {
    assert.deepStrictEqual(decideReopen({ avatar: 'Other Character.png', chatFile: 'A' }, CHARACTERS), { action: 'open', index: 1, chatFile: 'A' });
    assert.deepStrictEqual(decideReopen({ groupId: '1700000000000', chatFile: 'A' }, CHARACTERS), { action: 'skip', why: 'group' });
    assert.deepStrictEqual(decideReopen({ avatar: 'Deleted Character.png', chatFile: 'A' }, CHARACTERS), { action: 'skip', why: 'missing' });
    assert.deepStrictEqual(decideReopen(null, CHARACTERS), { action: 'none' });
    assert.deepStrictEqual(decideReopen({ avatar: 'Example Character.png', chatFile: 'A' }, undefined), { action: 'skip', why: 'missing' });
});

test('activeFromContext: character, group, or null without a chat', () => {
    assert.deepStrictEqual(activeFromContext({ characters: CHARACTERS, characterId: '1', groupId: null, chatId: 'Chat B' }),
        { avatar: 'Other Character.png', chatFile: 'Chat B' });
    assert.deepStrictEqual(activeFromContext({ characters: CHARACTERS, characterId: undefined, groupId: '1700000000000', chatId: 'Group Chat' }),
        { groupId: '1700000000000', chatFile: 'Group Chat' });
    assert.strictEqual(activeFromContext({ characters: CHARACTERS, characterId: undefined, groupId: null, chatId: undefined }), null);
    assert.strictEqual(activeFromContext({ characters: CHARACTERS, characterId: 7, groupId: null, chatId: 'Chat' }), null);
    assert.strictEqual(activeFromContext(null), null);
});

test('after a claim: takeReopen gives the kind and the lease’s active once; the flag is removed at load', async () => {
    const h = afterClaimReload({ active: { avatar: 'Other Character.png', chatFile: 'Chat B' } });
    assert.strictEqual(h.storage.map.has(KEYS.reopen), false, 'read and removed when the page loads');
    assert.strictEqual(h.lease.status().reopenPending, true);
    assert.deepStrictEqual(await h.lease.takeReopen(), { kind: 'useHere', active: { avatar: 'Other Character.png', chatFile: 'Chat B' } });
    assert.strictEqual(await h.lease.takeReopen(), null, 'only once');
});

test('a load without the flag (refresh) reopens nothing and records chats at once', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    assert.strictEqual(await h.lease.takeReopen(), null);
    const outcome = await h.lease.recordChat({ avatar: 'Other Character.png', chatFile: 'Chat B' });
    assert.strictEqual(outcome.status, 'written');
    assert.deepStrictEqual(h.leaseFile().active, { avatar: 'Other Character.png', chatFile: 'Chat B' });
});

test('an unknown flag value is ignored', async () => {
    const h = afterClaimReload({ kind: 'something-else' });
    assert.strictEqual(h.lease.status().reopenPending, false);
    assert.strictEqual(await h.lease.takeReopen(), null);
});

test('a parked load after a claim gets no reopen, and records nothing', async () => {
    const h = createHarness({
        files: { [LEASE]: leaseFile({ holder: 'page-b', epoch: 5 }) },
        storage: { [KEYS.tabId]: 'page-a', [KEYS.reopen]: 'useHere' },
    });
    assert.strictEqual(await h.lease.takeReopen(), null);
    assert.deepStrictEqual(await h.lease.recordChat({ avatar: 'Other Character.png', chatFile: 'Chat B' }), { status: 'skipped' });
    assert.strictEqual(h.leaseUploads().length, 0);
});

test('while the reopen is pending, chat changes aren’t recorded; finishReopen records the chat now open', async () => {
    const h = afterClaimReload();
    await h.lease.start();
    const before = h.leaseUploads().length;
    assert.deepStrictEqual(await h.lease.recordChat(null), { status: 'skipped' }, 'ST’s startup CHAT_CHANGED with no chat');
    assert.deepStrictEqual(await h.lease.recordChat({ avatar: 'Other Character.png', chatFile: 'Auto-loaded' }), { status: 'skipped' });
    assert.strictEqual(h.leaseUploads().length, before);
    await h.lease.takeReopen();
    const outcome = await h.lease.finishReopen({ avatar: 'Example Character.png', chatFile: 'Chat C' });
    assert.strictEqual(outcome.status, 'written');
    assert.deepStrictEqual(h.leaseFile().active, { avatar: 'Example Character.png', chatFile: 'Chat C' });
    assert.strictEqual((await h.lease.recordChat({ avatar: 'Example Character.png', chatFile: 'Chat D' })).status, 'written', 'recorded again after the reopen');
});

test('finishReopen without an open chat keeps active as it was (a group stays recorded)', async () => {
    const group = { groupId: '1700000000000', chatFile: 'Group Chat' };
    const h = afterClaimReload({ active: group });
    await h.lease.takeReopen();
    const uploads = h.leaseUploads().length;
    assert.deepStrictEqual(await h.lease.finishReopen(null), { status: 'skipped' });
    assert.strictEqual(h.leaseUploads().length, uploads);
    assert.deepStrictEqual(h.leaseFile().active, group);
});

test('recordChat: unchanged active isn’t written; a changed pair parks the page (lost)', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    await h.lease.start();
    const uploads = h.leaseUploads().length;
    assert.strictEqual((await h.lease.recordChat(leaseFile().active)).status, 'unchanged');
    assert.strictEqual(h.leaseUploads().length, uploads);
    h.setFile(LEASE, leaseFile({ holder: 'page-b', epoch: 9 }));
    assert.deepStrictEqual(await h.lease.recordChat({ avatar: 'Other Character.png', chatFile: 'Chat B' }), { status: 'parked', reason: 'lost' });
    assert.deepStrictEqual([h.lease.status().phase, h.lease.status().reason], ['parked', 'lost']);
    assert.strictEqual(h.leaseFile().holder, 'page-b');
});

test('recordChat: a failed write leaves the page holder (spec E3)', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    await h.lease.start();
    h.server.failUploads = 3;
    assert.deepStrictEqual(await h.lease.recordChat({ avatar: 'Other Character.png', chatFile: 'Chat B' }), { status: 'failed' });
    assert.strictEqual(h.lease.status().phase, 'holder');
});

test('hooks: reopens another chat of the character, then records it', async () => {
    const h = afterClaimReload({ active: { avatar: 'Other Character.png', chatFile: 'Older Chat' } });
    const st = createFakeSt({ onlineStatus: 'Valid' });
    const { hooks } = hooksFor(h, st);
    hooks.attach(st.getContext());
    st.eventSource.emit(EVENT_TYPES.CHAT_CHANGED, undefined);
    await hooks.afterAppReady();
    assert.deepStrictEqual(st.calls, [['selectCharacterById', 1], ['openCharacterChat', 'Older Chat']]);
    assert.deepStrictEqual(h.leaseFile().active, { avatar: 'Other Character.png', chatFile: 'Older Chat' });
    assert.strictEqual(h.lease.status().reopenPending, false);
});

test('hooks: the chat ST opened is the one to reopen: no openCharacterChat', async () => {
    const h = afterClaimReload({ active: { avatar: 'Example Character.png', chatFile: 'Example Chat - 1' } });
    const st = createFakeSt({ onlineStatus: 'Valid' });
    const { hooks } = hooksFor(h, st);
    await hooks.afterAppReady();
    assert.deepStrictEqual(st.calls, [['selectCharacterById', 0]]);
});

test('hooks: a group or a deleted character stays on the start screen, logged, active kept', async () => {
    for (const active of [{ groupId: '1700000000000', chatFile: 'Group Chat' }, { avatar: 'Deleted Character.png', chatFile: 'Chat' }]) {
        const h = afterClaimReload({ active });
        const st = createFakeSt({ onlineStatus: 'Valid' });
        const { hooks, logs } = hooksFor(h, st);
        await hooks.afterAppReady();
        assert.deepStrictEqual(st.calls, []);
        assert.ok(logs.some((l) => l.message === 'chat not reopened: start screen'));
        assert.deepStrictEqual(h.leaseFile().active, active);
    }
});

test('hooks: a selection ST skipped (save or reply running) never opens the chat on another character', async () => {
    const h = afterClaimReload({ active: { avatar: 'Other Character.png', chatFile: 'Older Chat' } });
    const st = createFakeSt({ characterId: 0, selectFails: true, onlineStatus: 'Valid' });
    const { hooks, logs } = hooksFor(h, st);
    await hooks.afterAppReady();
    assert.deepStrictEqual(st.calls, [['selectCharacterById', 1]]);
    assert.strictEqual(st.characters[0].chat, 'Example Chat - 1', 'the other character’s chat is untouched');
    assert.ok(logs.some((l) => l.message === 'chat not reopened: character not selected'));
    assert.deepStrictEqual(h.leaseFile().active, { avatar: 'Example Character.png', chatFile: 'Example Chat - 1' }, 'records what is open');
});

test('hooks: after an automatic claim the chat reopens too', async () => {
    const h = afterClaimReload({ kind: 'automatic', active: { avatar: 'Other Character.png', chatFile: 'Older Chat' } });
    const st = createFakeSt({ onlineStatus: 'Valid' });
    const { hooks } = hooksFor(h, st);
    await hooks.afterAppReady();
    assert.deepStrictEqual(st.calls, [['selectCharacterById', 1], ['openCharacterChat', 'Older Chat']]);
});

test('hooks: CHAT_CHANGED records the open chat for a holder without a reopen', async () => {
    const h = createHarness({ files: { [LEASE]: leaseFile({ holder: 'page-a', epoch: 3 }) } });
    await h.lease.start();
    const st = createFakeSt({ characterId: 1, onlineStatus: 'Valid' });
    const { hooks } = hooksFor(h, st);
    hooks.attach(st.getContext());
    st.eventSource.emit(EVENT_TYPES.CHAT_CHANGED, 'Other Chat');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepStrictEqual(h.leaseFile().active, { avatar: 'Other Character.png', chatFile: 'Other Chat' });
});
