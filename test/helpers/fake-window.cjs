'use strict';

// A fake browser window around the fake server, for the lease's install (wrapper, messages,
// window.__ttLease). Timers run 1000× faster. Invented data only.

const { install } = require('../../session-lease.js');
const { createHarness, fakeStorage } = require('./fake-server.cjs');

class FakeCustomEvent {
    constructor(type, options = {}) {
        this.type = type;
        this.detail = options.detail;
        this.persisted = options.persisted === true;
    }
}

/**
 * A fake window wired to a fake server.
 * @param {object} [options]
 * @param {object} [options.harness] An existing harness (shared server); default: a new one.
 * @param {object} [options.files] Initial lease files for a new harness.
 * @param {string} [options.pathname] `location.pathname`.
 * @param {string} [options.source] `__ttLeaseSource`.
 * @param {object|null} [options.storage] sessionStorage content (default: tab id `page-a`).
 * @param {boolean} [options.app] Adds the app's `TravelingTavern` listener.
 * @param {boolean} [options.frame] Makes it a child frame.
 * @returns {object} The window and recorders.
 */
function createFakeWindow({ harness, files, pathname = '/', source, storage = { 'tt-lease-tab-id': 'page-a' }, app = false, frame = false } = {}) {
    const h = harness || createHarness({ files });
    const listeners = new Map();
    const docListeners = new Map();
    const events = [];
    const appMessages = [];
    const beacons = [];
    const xhrs = [];

    class FakeXHR {
        open(method, url, async) {
            this.method = method;
            this.url = url;
            this.async = async;
        }
        send(body) {
            this.sent = true;
            h.server.stRequests.push({ url: this.url, method: String(this.method).toUpperCase(), xhr: true, body });
        }
        abort() {
            this.aborted = true;
        }
        addEventListener(type, fn) {
            this.listeners = this.listeners || {};
            (this.listeners[type] = this.listeners[type] || []).push(fn);
        }
        /** Fires an XHR event (e.g. loadend) for the tests. */
        fire(type) {
            for (const fn of (this.listeners && this.listeners[type]) || []) fn({ type });
        }
    }

    const win = {
        console: { log() {}, info() {}, warn() {}, error() {}, debug() {} },
        location: { pathname, origin: 'http://localhost', reloads: 0, reload() { win.location.reloads++; } },
        fetch: (url, init) => h.fetch(url, init),
        sessionStorage: fakeStorage(storage || {}),
        setTimeout: (fn, ms) => setTimeout(fn, ms / 1000),
        clearTimeout: (id) => clearTimeout(id),
        DOMException,
        ReadableStream,
        Response,
        CustomEvent: FakeCustomEvent,
        XMLHttpRequest: FakeXHR,
        navigator: { sendBeacon(url) { beacons.push(url); return true; } },
        addEventListener(type, fn) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(fn);
        },
        dispatchEvent(event) {
            if (event.type === 'tt-lease') events.push(event.detail);
            for (const fn of listeners.get(event.type) || []) fn(event);
            return true;
        },
    };
    win.document = {
        addEventListener(type, fn) {
            if (!docListeners.has(type)) docListeners.set(type, []);
            docListeners.get(type).push(fn);
        },
    };
    win.top = frame ? {} : win;
    if (source) win.__ttLeaseSource = source;
    if (app) win.TravelingTavern = { postMessage: (text) => appMessages.push(JSON.parse(text)) };

    return {
        win,
        harness: h,
        server: h.server,
        events,
        appMessages,
        beacons,
        newXhr: () => { const xhr = new win.XMLHttpRequest(); xhrs.push(xhr); return xhr; },
        install: () => install(win),
        /** Fires a window event (pagehide, pageshow, tt-extension-ready). */
        fire: (type, options) => win.dispatchEvent(new FakeCustomEvent(type, options)),
        /** Fires a document event (the Page Lifecycle's freeze and resume). */
        fireDocument: (type) => {
            for (const fn of docListeners.get(type) || []) fn(new FakeCustomEvent(type));
        },
    };
}

/** Waits for pending promises and fast timers to run. */
function flush(ms = 30) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Tracks whether a promise settles.
 * @param {Promise} promise The promise.
 * @returns {{ settled: () => boolean, result: () => object }} Tracker.
 */
function track(promise) {
    let state = null;
    promise.then((value) => { state = { value }; }, (error) => { state = { error }; });
    return { settled: () => state !== null, result: () => state };
}

module.exports = { createFakeWindow, flush, track };
