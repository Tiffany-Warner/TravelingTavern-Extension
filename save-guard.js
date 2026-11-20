// TravelingTavern save guard.
// Classic script (one IIFE, no imports): loaded by the extension, injected by the
// TravelingTavern app's WebView, or by Playwright. Spec: context/specs/ext-0.1-save-guard-spec.md
(function () {
    'use strict';

    /** Bump on every change to the guard's behavior. The app compares this number. */
    const GUARD_VERSION = 1;
    /** `v` field of messages posted to the app (same channel format as the app's bridge.js). */
    const MESSAGE_VERSION = 1;

    const LOG_PREFIX = '[TravelingTavern]';
    const APP_LISTENER = 'TravelingTavern';
    const DESKTOP_EVENT = 'tt-save-guard';
    const GUARD_SOURCES = ['app', 'extension', 'headless'];

    /** Settings are read from the server at most this often by freshness checks (large answer). */
    const SETTINGS_CHECK_INTERVAL_MS = 5000;

    /** SillyTavern endpoints (all POST). Verified against ST 1.19.0. */
    const ENDPOINTS = Object.freeze({
        settingsGet: '/api/settings/get',
        settingsSave: '/api/settings/save',
        worldInfoEdit: '/api/worldinfo/edit',
        chatSave: '/api/chats/save',
        groupChatSave: '/api/chats/group/save',
        characterEdit: '/api/characters/edit',
    });

    /** Whole-file saves. XMLHttpRequest may never send these (ST's core uses fetch only). */
    const SAVE_ENDPOINTS = Object.freeze([
        ENDPOINTS.settingsSave,
        ENDPOINTS.worldInfoEdit,
        ENDPOINTS.chatSave,
        ENDPOINTS.groupChatSave,
        ENDPOINTS.characterEdit,
    ]);

    /**
     * Settings fields that change on their own on every device. Ignored when comparing settings.
     * One comment per path. Filled on the emulator (save with no user change, diff vs fingerprint).
     */
    const NOISY_SETTINGS_PATHS = Object.freeze([]);

    /** Synthetic answers returned instead of a blocked save (spec: Synthetic answers). */
    const SYNTHETIC = Object.freeze({
        settings: { result: 'ok' },
    });

    // ---------------------------------------------------------------- pure helpers

    /**
     * JSON with object keys sorted at every level, so key order never matters.
     * Follows JSON.stringify for `undefined` (dropped from objects, `null` in arrays).
     * @param {*} value Parsed JSON value.
     * @returns {string} Canonical JSON text.
     */
    function canonicalJson(value) {
        if (Array.isArray(value)) {
            return '[' + value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',') + ']';
        }
        if (value !== null && typeof value === 'object') {
            const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
            return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
        }
        const text = JSON.stringify(value);
        return text === undefined ? 'null' : text;
    }

    /**
     * cyrb53: a fast 53-bit string hash in plain JS (no crypto.subtle: pages may load over http).
     * Only needs to tell versions apart, not resist attacks.
     * @param {string} text Text to hash.
     * @returns {number} 53-bit hash.
     */
    function cyrb53(text) {
        let h1 = 0xdeadbeef;
        let h2 = 0x41c6ce57;
        for (let i = 0; i < text.length; i++) {
            const ch = text.charCodeAt(i);
            h1 = Math.imul(h1 ^ ch, 2654435761);
            h2 = Math.imul(h2 ^ ch, 1597334677);
        }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
        h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
        h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
        h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return 4294967296 * (2097151 & h2) + (h1 >>> 0);
    }

    /**
     * Revision of a parsed JSON value: hash of its canonical JSON plus its length.
     * @param {*} value Parsed JSON value.
     * @returns {string} Revision string, equal for equal content in any key order.
     */
    function hashJson(value) {
        const text = canonicalJson(value);
        return cyrb53(text).toString(16) + '-' + text.length.toString(16);
    }

    /**
     * Deep equality of parsed JSON values, ignoring key order.
     * @param {*} a First value.
     * @param {*} b Second value.
     * @returns {boolean} True when both have the same content.
     */
    function jsonEqual(a, b) {
        return canonicalJson(a) === canonicalJson(b);
    }

    /**
     * Copy of a parsed JSON value with the given dotted paths removed.
     * @param {*} value Parsed JSON value (not modified).
     * @param {readonly string[]} paths Dotted paths such as `power_user.some_field`.
     * @returns {*} The value itself when there are no paths, else a pruned copy.
     */
    function withoutPaths(value, paths) {
        if (paths.length === 0 || value === null || typeof value !== 'object') return value;
        const copy = JSON.parse(JSON.stringify(value));
        for (const path of paths) {
            const parts = path.split('.');
            let node = copy;
            for (let i = 0; i < parts.length - 1 && node !== null && typeof node === 'object'; i++) {
                node = node[parts[i]];
            }
            if (node !== null && typeof node === 'object') delete node[parts[parts.length - 1]];
        }
        return copy;
    }

    /**
     * Settings equality, ignoring NOISY_SETTINGS_PATHS.
     * @param {object} a Parsed settings.
     * @param {object} b Parsed settings.
     * @returns {boolean} True when equal apart from noisy fields.
     */
    function settingsEqual(a, b) {
        return jsonEqual(withoutPaths(a, NOISY_SETTINGS_PATHS), withoutPaths(b, NOISY_SETTINGS_PATHS));
    }

    /**
     * Pathname of a fetch input, lower-cased and without trailing slashes (Express routing
     * ignores both), so a variant spelling can't slip past the guard.
     * @param {string|URL|Request} input fetch input.
     * @returns {string} Normalized pathname, or '' if it can't be parsed.
     */
    function requestPath(input) {
        const raw = typeof input === 'string' ? input : (input && typeof input.url === 'string' ? input.url : String(input));
        try {
            return new URL(raw, 'http://localhost/').pathname.toLowerCase().replace(/\/+$/, '');
        } catch (error) {
            return '';
        }
    }

    /**
     * Finds which ST endpoint a path is, allowing a prefix (ST behind a reverse-proxy subpath).
     * @param {string} path Normalized pathname from requestPath.
     * @param {readonly string[]} endpoints Candidate endpoints.
     * @returns {{ endpoint: string, prefix: string } | null} Match, or null.
     */
    function matchEndpoint(path, endpoints) {
        for (const endpoint of endpoints) {
            if (path === endpoint || path.endsWith(endpoint)) {
                return { endpoint, prefix: path.slice(0, path.length - endpoint.length) };
            }
        }
        return null;
    }

    /**
     * HTTP method of a fetch call, upper-cased.
     * @param {string|URL|Request} input fetch input.
     * @param {RequestInit} [init] fetch options.
     * @returns {string} Method.
     */
    function requestMethod(input, init) {
        if (init && init.method) return String(init.method).toUpperCase();
        if (input && typeof input === 'object' && typeof input.method === 'string') return input.method.toUpperCase();
        return 'GET';
    }

    /**
     * Headers of a fetch call (init headers replace a Request's, as fetch does).
     * @param {string|URL|Request} input fetch input.
     * @param {RequestInit} [init] fetch options.
     * @returns {Headers} Headers.
     */
    function requestHeaders(input, init) {
        if (init && init.headers) return new Headers(init.headers);
        if (input && typeof input === 'object' && input.headers) return new Headers(input.headers);
        return new Headers();
    }

    /**
     * Gunzips bytes with DecompressionStream (feature-detected; works over plain http).
     * @param {Uint8Array} bytes gzip data.
     * @returns {Promise<Uint8Array>} Decompressed bytes.
     * @throws {Error} When DecompressionStream is missing or the data isn't valid gzip.
     */
    async function gunzip(bytes) {
        if (typeof DecompressionStream === 'undefined') throw new Error('DecompressionStream unavailable');
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    }

    /**
     * Raw body of a fetch call, without consuming anything the real request still needs.
     * @param {string|URL|Request} input fetch input.
     * @param {RequestInit} [init] fetch options.
     * @returns {Promise<string|Uint8Array>} Body.
     * @throws {Error} For body types the guard can't read (streams, FormData…): fail closed.
     */
    async function rawBody(input, init) {
        let body = init && init.body !== undefined ? init.body : undefined;
        if (body === undefined && typeof Request !== 'undefined' && input instanceof Request) {
            body = await input.clone().arrayBuffer();
        }
        if (typeof body === 'string') return body;
        if (body instanceof ArrayBuffer) return new Uint8Array(body);
        if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
        if (typeof Blob !== 'undefined' && body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
        throw new Error('unreadable body type');
    }

    /**
     * JSON body of a fetch call, gunzipped when ST compressed it (`Content-Encoding: gzip`).
     * @param {string|URL|Request} input fetch input.
     * @param {RequestInit} [init] fetch options.
     * @returns {Promise<*>} Parsed body.
     * @throws {Error} When the body can't be read, decompressed or parsed: fail closed.
     */
    async function readJsonBody(input, init) {
        const encoding = (requestHeaders(input, init).get('Content-Encoding') || 'identity').trim().toLowerCase();
        let body = await rawBody(input, init);
        if (encoding === 'gzip') {
            if (typeof body === 'string') throw new Error('gzip header on a text body');
            body = await gunzip(body);
        } else if (encoding !== 'identity') {
            throw new Error('unsupported Content-Encoding');
        }
        const text = typeof body === 'string' ? body : new TextDecoder('utf-8', { fatal: true }).decode(body);
        return JSON.parse(text);
    }

    /**
     * A JSON response with status 200, as returned for a blocked save.
     * @param {object} payload Answer body.
     * @returns {Response} Response.
     */
    function jsonResponse(payload) {
        return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    // ---------------------------------------------------------------- guard core

    /**
     * Creates the guard's logic. No DOM, network or globals except through the parameters,
     * so Node tests can drive it with a fake fetch.
     * @param {object} deps
     * @param {typeof fetch} deps.fetch The page's original fetch (never the wrapped one).
     * @param {(type: string, payload: object) => void} deps.post Reports to the app or desktop UI.
     * @param {() => number} deps.now Current time in ms.
     * @param {(level: string, message: string, details?: object) => void} deps.log Logger (no content).
     * @returns {object} Guard with handleFetch, refusesXhr, checkFresh, checkChat, pendingSaves, seedSettings.
     */
    function createSaveGuard({ fetch, post, now, log }) {
        const state = {
            settings: { base: null, exact: false },
            settingsCheck: { at: -Infinity, changed: null },
            prefix: '',
            csrfToken: null,
            queue: Promise.resolve(),
            pending: 0,
        };

        /** Remembers the CSRF token and path prefix of ST's own requests, for the guard's reads. */
        function rememberRequest(headers, prefix) {
            const token = headers.get('X-CSRF-Token');
            if (token) state.csrfToken = token;
            state.prefix = prefix;
        }

        /** Options for the guard's own POST reads, carrying ST's CSRF token. */
        function readOptions(body) {
            const headers = { 'Content-Type': 'application/json' };
            if (state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;
            return { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-cache' };
        }

        /**
         * Runs guarded saves one at a time, in order.
         * @param {() => Promise<Response>} task Save task.
         * @returns {Promise<Response>} The task's answer.
         */
        function enqueue(task) {
            state.pending++;
            const run = state.queue.then(task, task);
            state.queue = run.then(() => undefined, () => undefined).then(() => { state.pending--; });
            return run;
        }

        /**
         * Reads the server's current settings through the original fetch.
         * @returns {Promise<{ ok: true, value: object } | { ok: false }>} Parsed settings, or a failed read.
         */
        async function readServerSettings() {
            try {
                const response = await fetch(state.prefix + ENDPOINTS.settingsGet, readOptions({}));
                if (!response.ok) return { ok: false };
                const data = await response.json();
                return { ok: true, value: JSON.parse(data.settings) };
            } catch (error) {
                return { ok: false };
            }
        }

        /**
         * Pure decision for a settings save (spec: Decision table).
         * @param {object} input
         * @param {object} input.payload Parsed settings the page wants to save.
         * @param {object|null} input.base Fingerprint: the version the page's copy came from.
         * @param {boolean} input.exact Whether base is exactly the page's copy (after an own save).
         * @param {{ ok: boolean, value?: object }} [input.server] Server read (absent for a no-change save).
         * @returns {{ action: 'skip'|'send'|'block', reason?: string, hadChanges?: boolean|null }} Decision.
         */
        function decideSettingsSave({ payload, base, exact, server }) {
            if (base && settingsEqual(payload, base)) return { action: 'skip' };
            if (!server || !server.ok) return { action: 'block', reason: 'unreachable', hadChanges: base ? (exact ? true : null) : null };
            if (!base) return { action: 'block', reason: 'unseen', hadChanges: null };
            if (settingsEqual(server.value, base)) return { action: 'send' };
            return { action: 'block', reason: 'changed', hadChanges: exact ? true : null };
        }

        /**
         * The compare-and-save step (v0.1.0: read server → compare → send). The later server
         * plugin replaces this one function with its atomic endpoint.
         * @param {'settings'} kind What is saved.
         * @param {string|null} key File key (lorebook name…), null for settings.
         * @param {{ base: object|null, exact: boolean }} base Version the page's copy came from.
         * @param {{ value: object, send: () => Promise<Response> }} payload Parsed payload and its sender.
         * @returns {Promise<{ decision: object, response?: Response }>} Decision, and the server's answer when sent.
         */
        async function conditionalWrite(kind, key, base, payload) {
            const server = await readServerSettings();
            const decision = decideSettingsSave({ payload: payload.value, base: base.base, exact: base.exact, server });
            if (decision.action !== 'send') return { decision };
            return { decision, response: await payload.send() };
        }

        /** Reports a blocked save and returns the synthetic answer. */
        function blockSave(kind, decision, name) {
            const report = { kind, reason: decision.reason, hadChanges: decision.hadChanges };
            if (name !== undefined) report.name = name;
            log('warn', 'save blocked', { kind, reason: decision.reason, hadChanges: decision.hadChanges });
            post('saveBlocked', report);
            return jsonResponse(SYNTHETIC[kind]);
        }

        /** True when ST's answer to a settings save means the file was written. */
        async function settingsSaveSucceeded(response) {
            if (!response.ok) return false;
            try {
                const data = await response.clone().json();
                return data !== null && typeof data === 'object' && data.result === 'ok';
            } catch (error) {
                return false;
            }
        }

        /**
         * Settings freshness, rate-limited (large answer). Reports `staleSettings` when changed.
         * @returns {Promise<boolean|null>} Changed, unchanged, or null when unknown.
         */
        async function checkSettings() {
            if (now() - state.settingsCheck.at < SETTINGS_CHECK_INTERVAL_MS) return state.settingsCheck.changed;
            state.settingsCheck.at = now();
            const base = state.settings.base;
            const server = base ? await readServerSettings() : { ok: false };
            const changed = server.ok ? !settingsEqual(server.value, base) : null;
            state.settingsCheck.changed = changed;
            if (changed) post('staleSettings', {});
            return changed;
        }

        /** Guards one settings save (runs inside the queue). */
        async function guardSettingsSave(input, init) {
            let payload;
            try {
                payload = await readJsonBody(input, init);
            } catch (error) {
                log('warn', 'settings body unreadable', { endpoint: ENDPOINTS.settingsSave });
                return blockSave('settings', { reason: 'unreachable', hadChanges: null });
            }
            const base = state.settings;
            if (decideSettingsSave({ payload, base: base.base, exact: base.exact }).action === 'skip') {
                await checkSettings();
                return jsonResponse(SYNTHETIC.settings);
            }
            const { decision, response } = await conditionalWrite('settings', null, base, { value: payload, send: () => fetch(input, init) });
            if (decision.action === 'block') return blockSave('settings', decision);
            if (await settingsSaveSucceeded(response)) {
                state.settings = { base: payload, exact: true };
            }
            return response;
        }

        /** Takes the page's settings fingerprint from ST's own settings read. */
        async function observeSettingsRead(input, init) {
            const response = await fetch(input, init);
            try {
                const data = await response.clone().json();
                state.settings = { base: JSON.parse(data.settings), exact: false };
            } catch (error) {
                state.settings = { base: null, exact: false };
            }
            return response;
        }

        /** Catches guard bugs at the edge: the save is blocked, never let through. */
        function failClosed(kind, task) {
            return task().catch((error) => {
                log('error', 'guard error, save blocked', { kind, error: String(error && error.message) });
                return blockSave(kind, { reason: 'unreachable', hadChanges: null });
            });
        }

        /**
         * The fetch wrapper's logic. Unguarded requests go straight to the original fetch.
         * @param {string|URL|Request} input fetch input.
         * @param {RequestInit} [init] fetch options.
         * @returns {Promise<Response>} The server's or a synthetic answer.
         */
        function handleFetch(input, init) {
            if (requestMethod(input, init) !== 'POST') return fetch(input, init);
            const match = matchEndpoint(requestPath(input), [ENDPOINTS.settingsGet, ENDPOINTS.settingsSave]);
            if (!match) return fetch(input, init);
            rememberRequest(requestHeaders(input, init), match.prefix);
            if (match.endpoint === ENDPOINTS.settingsGet) return observeSettingsRead(input, init);
            return enqueue(() => failClosed('settings', () => guardSettingsSave(input, init)));
        }

        /**
         * Whether XMLHttpRequest.send must refuse a request (whole-file saves are fetch-only).
         * @param {string} method HTTP method.
         * @param {string} url Request URL.
         * @returns {boolean} True to refuse.
         */
        function refusesXhr(method, url) {
            return String(method).toUpperCase() === 'POST' && matchEndpoint(requestPath(url), SAVE_ENDPOINTS) !== null;
        }

        /**
         * Compares the page's copies with the server. Never reloads anything itself.
         * @returns {Promise<{ settingsChanged: boolean|null, lorebooksChanged: string[], chatChanged: boolean|null }>}
         */
        async function checkFresh() {
            const settingsChanged = await checkSettings();
            return { settingsChanged, lorebooksChanged: [], chatChanged: null };
        }

        /**
         * Quick check of the open chat only (no settings read). Chat slice not built yet: unknown.
         * @returns {Promise<{ chatChanged: boolean|null }>}
         */
        async function checkChat() {
            return { chatChanged: null };
        }

        /**
         * Seeds the settings fingerprint from the page's own state (late start). Not exact:
         * ST may have added defaults since the read.
         * @param {object} settings The page's parsed settings.
         */
        function seedSettings(settings) {
            state.settings = { base: JSON.parse(JSON.stringify(settings)), exact: false };
        }

        return {
            handleFetch,
            refusesXhr,
            checkFresh,
            checkChat,
            seedSettings,
            pendingSaves: () => state.pending,
        };
    }

    // ---------------------------------------------------------------- browser wrapper

    /** Reports to the app's listener when present, else as a DOM event for the extension UI. */
    function makePost(win) {
        return function post(type, payload) {
            const port = win[APP_LISTENER];
            if (port && typeof port.postMessage === 'function') {
                port.postMessage(JSON.stringify(Object.assign({ v: MESSAGE_VERSION, type }, payload)));
                return;
            }
            win.dispatchEvent(new win.CustomEvent(DESKTOP_EVENT, { detail: Object.assign({ type }, payload) }));
        };
    }

    /** Console logger with the guard's prefix. Callers pass kinds, reasons and counts only. */
    function makeLog(console) {
        return function log(level, message, details) {
            const write = console[level] || console.log;
            write.call(console, LOG_PREFIX, message, details || '');
        };
    }

    /** Makes XMLHttpRequest.send refuse whole-file saves. */
    function wrapXhr(win, guard) {
        const proto = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
        if (!proto) return;
        const targets = new WeakMap();
        const open = proto.open;
        const send = proto.send;
        proto.open = function (method, url, ...rest) {
            targets.set(this, { method: String(method), url: String(url) });
            return open.call(this, method, url, ...rest);
        };
        proto.send = function (...args) {
            const target = targets.get(this);
            if (target && guard.refusesXhr(target.method, target.url)) {
                throw new win.DOMException('TravelingTavern: this save must go through fetch', 'NetworkError');
            }
            return send.apply(this, args);
        };
    }

    /**
     * Installs the guard in a page: once, main frame only. The API object is frozen and
     * can't be replaced; nothing turns the guard off.
     * @param {Window} win The page's window.
     * @returns {boolean} True when installed now.
     */
    function install(win) {
        if (win.top !== win || win.__ttSaveGuard) return false;
        const source = GUARD_SOURCES.includes(win.__ttGuardSource) ? win.__ttGuardSource : 'app';
        const originalFetch = win.fetch.bind(win);
        const guard = createSaveGuard({ fetch: originalFetch, post: makePost(win), now: () => Date.now(), log: makeLog(win.console) });
        win.fetch = function fetch(input, init) {
            return guard.handleFetch(input, init);
        };
        wrapXhr(win, guard);
        const api = Object.freeze({
            version: GUARD_VERSION,
            source,
            checkFresh: guard.checkFresh,
            checkChat: guard.checkChat,
            pendingSaves: guard.pendingSaves,
        });
        Object.defineProperty(win, '__ttSaveGuard', { value: api, writable: false, configurable: false, enumerable: false });
        return true;
    }

    const exported = {
        GUARD_VERSION,
        ENDPOINTS,
        NOISY_SETTINGS_PATHS,
        canonicalJson,
        hashJson,
        jsonEqual,
        requestPath,
        createSaveGuard,
        install,
    };

    if (typeof module !== 'undefined' && module.exports) {
        module.exports = exported;
    } else if (typeof window !== 'undefined') {
        install(window);
    }
})();
