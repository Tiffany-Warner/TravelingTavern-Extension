'use strict';

// Desktop overlay and toasts (spec E9, E3, E10, E12): what index.js shows for each lease report.
// The DOM parts (dialog, re-raising over ST popups, styles) are checked manually on the test install.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href);

const ACTIONS = {
    held: ['useHere'],
    lost: ['useHere'],
    claiming: [],
    waitingForReply: [],
    lostRace: ['useHere'],
    unreadable: ['useHere', 'refresh', 'takeOverAnyway', 'turnOffProtection'],
    damaged: ['takeOverAnyway', 'refresh', 'turnOffProtection'],
    error: ['refresh', 'takeOverAnyway', 'turnOffProtection'],
    unknownFormat: ['refresh', 'takeOverAnyway', 'turnOffProtection'],
    reloadPending: ['refresh'],
};

test('overlay: nothing for the holder or when off; the spec’s texts, spinner and buttons for every parked reason', async () => {
    const { overlayContent } = await load();
    assert.strictEqual(overlayContent({ type: 'leaseState', state: 'holder', reason: null, actions: [] }), null);
    assert.strictEqual(overlayContent({ type: 'leaseState', state: 'off', reason: null, actions: ['turnProtectionOn'] }), null);
    const expected = {
        held: ['In use on another device', false],
        lost: ['In use on another device', false],
        claiming: ['Taking over…', true],
        waitingForReply: ['Finishing a reply…', true],
        lostRace: ['Another device took over', false],
        unreadable: ["Can't reach SillyTavern", false],
        damaged: ['The lease file is damaged', false],
        error: ['Something went wrong', false],
        unknownFormat: ['Update needed', false],
        reloadPending: ['Reload needed', false],
    };
    for (const [reason, [title, spinner]] of Object.entries(expected)) {
        const content = overlayContent({ type: 'leaseState', state: 'parked', reason, actions: ACTIONS[reason] });
        assert.deepStrictEqual([content.title, content.spinner, content.actions], [title, spinner, ACTIONS[reason]], reason);
        assert.ok(content.line.length > 0, reason);
    }
});

test('overlay: a damaged file and an unreachable server read differently', async () => {
    const { overlayContent } = await load();
    const damaged = overlayContent({ state: 'parked', reason: 'damaged', actions: ACTIONS.damaged });
    const unreachable = overlayContent({ state: 'parked', reason: 'unreadable', actions: ACTIONS.unreadable });
    assert.notStrictEqual(damaged.title, unreachable.title);
    assert.match(damaged.line, /can't read its lease file/);
    assert.match(unreachable.line, /Check that SillyTavern is running/);
});

test('overlay: waiting for a reply adds the line and Take over anyway once offered (10 s)', async () => {
    const { overlayContent } = await load();
    const early = overlayContent({ state: 'parked', reason: 'waitingForReply', actions: [] });
    const later = overlayContent({ state: 'parked', reason: 'waitingForReply', actions: ['takeOverAnyway'] });
    assert.deepStrictEqual([early.spinner, early.actions], [true, []]);
    assert.deepStrictEqual([later.spinner, later.actions], [true, ['takeOverAnyway']]);
    assert.match(later.line, /take over anyway/);
    assert.doesNotMatch(early.line, /take over anyway/);
});

test('overlay: unknown actions get no button; a parked card without any action still gets Refresh', async () => {
    const { overlayContent } = await load();
    assert.deepStrictEqual(overlayContent({ state: 'parked', reason: 'held', actions: ['useHere', 'later', 'toString'] }).actions, ['useHere']);
    assert.deepStrictEqual(overlayContent({ state: 'parked', reason: 'held' }).actions, ['refresh']);
    assert.deepStrictEqual(overlayContent({ state: 'parked', reason: 'claiming', actions: [] }).actions, [], 'a spinner is no dead end');
});

test('overlay: the warning step before Take over anyway and Turn off protection only', async () => {
    const { confirmContent } = await load();
    assert.match(confirmContent('takeOverAnyway').line, /Anything unsaved on your other device may be lost/);
    assert.match(confirmContent('turnOffProtection').line, /can save over newer changes from your other devices/);
    for (const action of ['useHere', 'refresh', 'turnProtectionOn', 'toString']) assert.strictEqual(confirmContent(action), null, action);
});

test('banner: shown only when protection is off', async () => {
    const { bannerShown } = await load();
    assert.strictEqual(bannerShown({ state: 'off' }), true);
    assert.strictEqual(bannerShown({ state: 'parked', reason: 'held' }), false);
    assert.strictEqual(bannerShown({ state: 'holder' }), false);
    assert.strictEqual(bannerShown(null), false);
});

test('overlay: claiming tells the user to choose Leave', async () => {
    const { overlayContent } = await load();
    assert.match(overlayContent({ state: 'parked', reason: 'claiming', actions: [] }).line, /choose Leave/);
});

test('overlay: an unknown parked reason still shows the parked card, never nothing', async () => {
    const { overlayContent } = await load();
    assert.strictEqual(overlayContent({ state: 'parked', reason: 'somethingNew' }).title, 'In use on another device');
    assert.strictEqual(overlayContent({ state: 'parked', reason: 'toString' }).title, 'In use on another device');
});

test('untested-version toast: once per ST version, none on a tested version', async () => {
    const { untestedToastFor } = await load();
    assert.strictEqual(untestedToastFor({ untestedServer: false, stVersion: '1.19.1' }, null), null);
    assert.strictEqual(untestedToastFor({ untestedServer: true, stVersion: '1.20.0' }, null), '1.20.0');
    assert.strictEqual(untestedToastFor({ untestedServer: true, stVersion: '1.20.0' }, '1.20.0'), null);
    assert.strictEqual(untestedToastFor({ untestedServer: true, stVersion: '1.20.1' }, '1.20.0'), '1.20.1');
    assert.strictEqual(untestedToastFor({ untestedServer: true, stVersion: null }, null), 'unknown');
});

test('notices: a toast for each known kind, nothing for an unknown kind', async () => {
    const { noticeText } = await load();
    assert.match(noticeText({ kind: 'replyNotStarted' }), /start the reply/);
    assert.match(noticeText({ kind: 'notConnected' }), /Not connected to a model/);
    assert.strictEqual(noticeText({ kind: 'later' }), null);
    assert.strictEqual(noticeText({ kind: 'constructor' }), null);
});
