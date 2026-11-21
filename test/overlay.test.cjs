'use strict';

// Desktop overlay and toasts (spec E9, E3, E10, E12): what index.js shows for each lease report.
// The DOM parts (dialog, re-raising over ST popups, styles) are checked manually on the test install.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const load = () => import(pathToFileURL(path.join(__dirname, '..', 'index.js')).href);

test('overlay: nothing for the holder; the spec’s texts and control for every parked reason', async () => {
    const { overlayContent } = await load();
    assert.strictEqual(overlayContent({ type: 'leaseState', state: 'holder', reason: null }), null);
    const expected = {
        held: ['In use on another device', 'useHere'],
        lost: ['In use on another device', 'useHere'],
        claiming: ['Taking over…', 'spinner'],
        waitingForReply: ['Finishing a reply…', 'spinner'],
        lostRace: ['Another device took over', 'useHere'],
        unreadable: ['Can\'t reach SillyTavern', 'useHere'],
        unknownFormat: ['Update needed', 'none'],
        reloadPending: ['Reload needed', 'reload'],
    };
    for (const [reason, [title, control]] of Object.entries(expected)) {
        const content = overlayContent({ type: 'leaseState', state: 'parked', reason });
        assert.deepStrictEqual([content.title, content.control], [title, control], reason);
        assert.ok(content.line.length > 0, reason);
    }
});

test('overlay: claiming tells the user to choose Leave', async () => {
    const { overlayContent } = await load();
    assert.match(overlayContent({ state: 'parked', reason: 'claiming' }).line, /choose Leave/);
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
