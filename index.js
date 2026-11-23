// TravelingTavern extension entry (ES module, desktop only). Spec: context/specs/ext-0.2-session-lease-spec.md
// Announces the extension, shows the parked overlay (E9) and the toasts (E3, E10, E12) from the lease's
// `tt-lease` events, then loads the lease core (session-lease.js) as a classic script, unless a copy
// already runs in this page (the TravelingTavern app injects its own at document start).

/** This extension's release version. Must equal manifest.json's `version` (checked by the tests). */
const EXTENSION_VERSION = '0.0.1';
/** The LEASE_VERSION of this extension's session-lease.js (checked by the tests). */
const LEASE_VERSION = 1;

const LEASE_SCRIPT = 'session-lease.js';
const LEASE_EVENT = 'tt-lease';
const LOG_PREFIX = '[TravelingTavern]';

/** Class prefix of every overlay element and style rule (spec E9). */
const CSS_PREFIX = 'tt-lease';
/** localStorage key: the last ST version the untested-version toast was shown for (one toast per version, E12). */
const UNTESTED_TOAST_KEY = 'tt-lease-untested-toast';

/** The repo's Issues page, linked from the protection-off banner (spec E9). */
const ISSUES_URL = 'https://github.com/Tiffany-Warner/TravelingTavern-Extension/issues';

/** Button labels by `leaseState.actions` value (spec E9, E11). Unknown actions get no button. */
const ACTION_LABELS = Object.freeze({
    useHere: 'Use here',
    refresh: 'Refresh',
    takeOverAnyway: 'Take over anyway',
    turnOffProtection: 'Turn off protection',
});

/** The warning step before going ahead at the user's own risk (spec E9), by action. */
const CONFIRM_TEXTS = Object.freeze({
    takeOverAnyway: Object.freeze({
        title: 'Take over anyway?',
        line: 'Anything unsaved on your other device may be lost.',
        confirm: 'Take over anyway',
    }),
    turnOffProtection: Object.freeze({
        title: 'Turn off protection in this tab?',
        line: 'This page can save over newer changes from your other devices.',
        confirm: 'Turn off protection',
    }),
});

const IN_USE = Object.freeze({ title: 'In use on another device', line: 'Use SillyTavern here instead?' });
const NOTHING_SAVED = 'Nothing is saved from this page.';

/** The overlay's texts by `leaseState.reason` (spec E9); the buttons come from `leaseState.actions`. */
const OVERLAY_TEXTS = Object.freeze({
    held: IN_USE,
    lost: IN_USE,
    claiming: Object.freeze({
        title: 'Taking over…',
        line: 'Loading your chat on this device. If your browser asks whether to leave the site, choose Leave.',
        spinner: true,
    }),
    waitingForReply: Object.freeze({
        title: 'Finishing a reply…',
        line: 'Your other device is still writing a reply.',
        spinner: true,
        /** Added once Take over anyway is offered (after 10 s). */
        lineWithForce: 'Your other device is still writing a reply. If it has stopped responding, you can take over anyway.',
    }),
    lostRace: Object.freeze({ title: 'Another device took over', line: 'It claimed SillyTavern first.' }),
    unreadable: Object.freeze({ title: 'Can\'t reach SillyTavern', line: `${NOTHING_SAVED} Check that SillyTavern is running.` }),
    damaged: Object.freeze({ title: 'The lease file is damaged', line: `TravelingTavern can't read its lease file. ${NOTHING_SAVED}` }),
    error: Object.freeze({ title: 'Something went wrong', line: `TravelingTavern couldn't update its lease file. ${NOTHING_SAVED}` }),
    unknownFormat: Object.freeze({ title: 'Update needed', line: 'Update the TravelingTavern extension to use SillyTavern here.' }),
    reloadPending: Object.freeze({ title: 'Reload needed', line: 'Reload this page to finish taking over.' }),
});

const BANNER_TEXT = Object.freeze({
    before: 'Protection is off in this tab. If this keeps happening, please report it on ',
    link: 'GitHub',
    after: ' with the steps that led to it, or uninstall the extension.',
    button: 'Turn protection back on',
});

/** Toast texts by `leaseNotice.kind` (spec E3, E10). Unknown kinds are ignored (E11). */
const NOTICE_TEXTS = Object.freeze({
    replyNotStarted: 'Couldn\'t reach SillyTavern to start the reply. Try again.',
    notConnected: 'Not connected to a model. Connect in API Connections.',
});
const UNTESTED_TEXT = 'TravelingTavern hasn\'t been tested with this SillyTavern version.';

const OVERLAY_CSS = `
.${CSS_PREFIX}-overlay {
    box-sizing: border-box;
    width: min(360px, calc(100vw - 32px));
    max-width: none;
    margin: auto;
    padding: 24px;
    border: 1px solid var(--SmartThemeBorderColor);
    border-radius: 16px;
    background: var(--SmartThemeBlurTintColor);
    color: var(--SmartThemeBodyColor);
    box-shadow: 0 12px 40px var(--SmartThemeShadowColor);
    font-size: var(--mainFontSize);
    text-align: center;
    outline: none;
    animation: ${CSS_PREFIX}-in var(--animation-duration, 125ms) ease-out;
}
.${CSS_PREFIX}-overlay::backdrop {
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px));
    -webkit-backdrop-filter: blur(var(--SmartThemeBlurStrength, 10px));
}
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-title {
    margin: 0 0 8px;
    font-size: 1.3em;
    font-weight: 600;
    line-height: 1.3;
}
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-line {
    margin: 0 0 20px;
    line-height: 1.45;
    opacity: 0.85;
}
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-line:last-child { margin-bottom: 0; }
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-button.menu_button {
    box-sizing: border-box;
    width: 100%;
    margin: 0;
    padding: 12px 16px;
    border: 1px solid var(--SmartThemeQuoteColor);
    border-radius: 12px;
    background-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 25%, var(--SmartThemeBlurTintColor));
    color: var(--SmartThemeBodyColor);
    filter: none;
    font-size: 1.1em;
}
/* The dialog prefix outranks ST's \`.menu_button:not(.disabled):not([disabled]):focus-visible\` fill. */
dialog.${CSS_PREFIX}-overlay .${CSS_PREFIX}-button.menu_button:hover,
dialog.${CSS_PREFIX}-overlay .${CSS_PREFIX}-button.menu_button:focus-visible {
    background-color: color-mix(in srgb, var(--SmartThemeQuoteColor) 40%, var(--SmartThemeBlurTintColor));
    outline: none;
}
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-actions {
    display: flex;
    flex-direction: column;
    gap: 8px;
}
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-spinner + .${CSS_PREFIX}-actions { margin-top: 16px; }
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-button.${CSS_PREFIX}-secondary.menu_button {
    padding: 8px 12px;
    border-color: var(--SmartThemeBorderColor);
    background-color: transparent;
    font-size: 0.95em;
}
dialog.${CSS_PREFIX}-overlay .${CSS_PREFIX}-button.${CSS_PREFIX}-secondary.menu_button:hover,
dialog.${CSS_PREFIX}-overlay .${CSS_PREFIX}-button.${CSS_PREFIX}-secondary.menu_button:focus-visible {
    background-color: color-mix(in srgb, var(--SmartThemeBodyColor) 10%, transparent);
}
.${CSS_PREFIX}-banner {
    position: fixed;
    top: var(--topBarBlockSize, 0px);
    left: 0;
    right: 0;
    z-index: 3004;
    box-sizing: border-box;
    width: var(--sheldWidth, 100%);
    max-width: 100vw;
    margin: 0 auto;
    padding: 6px 12px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 6px 12px;
    border: 1px solid var(--SmartThemeQuoteColor);
    border-top: none;
    border-radius: 0 0 10px 10px;
    background: var(--SmartThemeBlurTintColor);
    color: var(--SmartThemeBodyColor);
    font-size: calc(var(--mainFontSize) * 0.9);
    line-height: 1.4;
    text-align: center;
}
.${CSS_PREFIX}-banner a { color: var(--SmartThemeQuoteColor); text-decoration: underline; }
.${CSS_PREFIX}-banner .${CSS_PREFIX}-banner-button.menu_button {
    margin: 0;
    padding: 4px 10px;
    border: 1px solid var(--SmartThemeQuoteColor);
    white-space: nowrap;
}
.${CSS_PREFIX}-overlay .${CSS_PREFIX}-spinner {
    box-sizing: border-box;
    width: 36px;
    height: 36px;
    margin: 4px auto;
    border: 3px solid var(--SmartThemeBorderColor);
    border-top-color: var(--SmartThemeQuoteColor);
    border-radius: 50%;
    animation: ${CSS_PREFIX}-spin 0.9s linear infinite;
}
@keyframes ${CSS_PREFIX}-spin { to { transform: rotate(360deg); } }
@keyframes ${CSS_PREFIX}-in { from { opacity: 0; transform: scale(0.97); } }
@media (prefers-reduced-motion: reduce) {
    .${CSS_PREFIX}-overlay, .${CSS_PREFIX}-overlay .${CSS_PREFIX}-spinner { animation: none; }
}
body.reduced-motion .${CSS_PREFIX}-overlay, body.reduced-motion .${CSS_PREFIX}-overlay .${CSS_PREFIX}-spinner { animation: none; }
`;

// ---- Pure decisions (tested in test/overlay.test.cjs) -----------------------------------------

/**
 * What the overlay shows for a `leaseState` (spec E9).
 * @param {unknown} detail The `tt-lease` event's detail.
 * @returns {{ title: string, line: string, spinner: boolean, actions: string[] } | null} The texts, the
 *     spinner and the buttons (from `actions`, known ones only, in order; the first is primary unless a
 *     spinner shows) while parked; null otherwise (holder, off). An unknown parked reason shows the
 *     "in use" texts, and a parked card without any action still gets Refresh: never stuck.
 */
export function overlayContent(detail) {
    if (!detail || detail.state !== 'parked') return null;
    const known = Object.prototype.hasOwnProperty.call(OVERLAY_TEXTS, detail.reason);
    const texts = known ? OVERLAY_TEXTS[detail.reason] : IN_USE;
    const offered = Array.isArray(detail.actions) ? detail.actions : [];
    let actions = offered.filter((action) => Object.prototype.hasOwnProperty.call(ACTION_LABELS, action));
    const spinner = texts.spinner === true;
    if (!spinner && actions.length === 0) actions = ['refresh'];
    const line = texts.lineWithForce && actions.includes('takeOverAnyway') ? texts.lineWithForce : texts.line;
    return { title: texts.title, line, spinner, actions };
}

/**
 * The warning step for an action that goes ahead at the user's own risk (spec E9).
 * @param {string} action A `leaseState.actions` value.
 * @returns {{ title: string, line: string, confirm: string } | null} The warning, or null when the
 *     action needs none.
 */
export function confirmContent(action) {
    return Object.prototype.hasOwnProperty.call(CONFIRM_TEXTS, action) ? CONFIRM_TEXTS[action] : null;
}

/**
 * Whether a `leaseState` calls for the protection-off banner (spec E9).
 * @param {unknown} detail The `tt-lease` event's detail.
 * @returns {boolean} True for `state: 'off'`.
 */
export function bannerShown(detail) {
    return Boolean(detail) && detail.state === 'off';
}

/**
 * Whether a `leaseInfo` calls for the untested-version toast (spec E12): once per ST version.
 * @param {unknown} detail The `tt-lease` event's detail.
 * @param {string|null} lastShown The ST version the toast was last shown for.
 * @returns {string|null} The version key to toast for and remember, or null for no toast. An unreadable
 *     version is keyed as `unknown`.
 */
export function untestedToastFor(detail, lastShown) {
    if (!detail || detail.untestedServer !== true) return null;
    const version = typeof detail.stVersion === 'string' ? detail.stVersion : 'unknown';
    return version === lastShown ? null : version;
}

/**
 * The toast text for a `leaseNotice` (spec E3, E10).
 * @param {unknown} detail The `tt-lease` event's detail.
 * @returns {string|null} The text, or null for a kind this extension doesn't know.
 */
export function noticeText(detail) {
    if (!detail || !Object.prototype.hasOwnProperty.call(NOTICE_TEXTS, detail.kind)) return null;
    return NOTICE_TEXTS[detail.kind];
}

// ---- Overlay (spec E9) -------------------------------------------------------------------------

/** Adds the overlay's one `<style>` element, once. */
function addStyles() {
    if (document.getElementById(`${CSS_PREFIX}-styles`)) return;
    const style = document.createElement('style');
    style.id = `${CSS_PREFIX}-styles`;
    style.textContent = OVERLAY_CSS;
    document.head.append(style);
}

/** The overlay's spinner (claiming, waiting for a reply). */
function buildSpinner() {
    const spinner = document.createElement('div');
    spinner.className = `${CSS_PREFIX}-spinner`;
    spinner.setAttribute('role', 'progressbar');
    spinner.setAttribute('aria-label', 'Loading');
    return spinner;
}

/** One overlay button; `secondary` makes it the smaller, plainer kind. */
function buildButton(label, secondary, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button ${CSS_PREFIX}-button${secondary ? ` ${CSS_PREFIX}-secondary` : ''}`;
    button.textContent = label;
    button.addEventListener('click', onClick);
    return button;
}

/** A column of buttons. */
function buildActions(buttons) {
    const actions = document.createElement('div');
    actions.className = `${CSS_PREFIX}-actions`;
    actions.append(...buttons);
    return actions;
}

/**
 * Runs a `leaseState` action through `window.__ttLease` (spec E9, E11); the lease reports the outcome.
 * Refresh reloads directly when the lease doesn't offer it (the fallback for an unknown reason).
 * @param {string} action A `leaseState.actions` value.
 * @returns {void}
 */
function runAction(action) {
    const lease = window.__ttLease;
    if (action === 'refresh') {
        if (!lease || lease.refresh() !== true) location.reload();
        return;
    }
    if (!lease || typeof lease[action] !== 'function') return;
    Promise.resolve(lease[action]()).catch((error) => {
        console.warn(LOG_PREFIX, `${action} failed`, error && error.name);
    });
}

/**
 * The parked overlay: a modal `<dialog>` kept as the top modal while parked. Escape can't close it, and
 * any other dialog opening (ST's popups are modal) re-raises it (spec E9).
 * @returns {{ show: (content: object) => void, hide: () => void }} Controls.
 */
function createOverlay() {
    let dialog = null;
    let shown = false;
    const observer = new MutationObserver((records) => {
        const opened = (r) => r.target !== dialog && r.target instanceof HTMLDialogElement && r.target.open;
        if (shown && records.some(opened)) raise();
    });

    /** Opens the dialog as the top modal with the focus on the card, not the button (showModal focuses the button). */
    function open() {
        dialog.showModal();
        dialog.focus({ preventScroll: true });
    }

    function raise() {
        if (dialog.open) dialog.close();
        open();
    }

    function build() {
        addStyles();
        dialog = document.createElement('dialog');
        dialog.className = `${CSS_PREFIX}-overlay`;
        dialog.setAttribute('aria-labelledby', `${CSS_PREFIX}-title`);
        dialog.setAttribute('aria-describedby', `${CSS_PREFIX}-line`);
        // The card takes the focus (see focusCard), so the button shows its focus tint only once tabbed to.
        dialog.tabIndex = -1;
        dialog.addEventListener('cancel', (event) => event.preventDefault());
        // Chrome can close a modal on a repeated Escape despite preventDefault: open it again.
        dialog.addEventListener('close', () => { if (shown && !dialog.open) open(); });
        document.body.append(dialog);
    }

    /** Title and line elements. */
    function texts(titleText, lineText) {
        const title = document.createElement('h2');
        title.id = `${CSS_PREFIX}-title`;
        title.className = `${CSS_PREFIX}-title`;
        title.textContent = titleText;
        const line = document.createElement('p');
        line.id = `${CSS_PREFIX}-line`;
        line.className = `${CSS_PREFIX}-line`;
        line.textContent = lineText;
        return [title, line];
    }

    /** The card for a parked state: texts, spinner, buttons (the first primary unless a spinner shows). */
    function render(content) {
        const children = texts(content.title, content.line);
        if (content.spinner) children.push(buildSpinner());
        const buttons = content.actions.map((action, index) => buildButton(
            ACTION_LABELS[action],
            content.spinner || index > 0,
            () => onAction(content, action),
        ));
        if (buttons.length > 0) children.push(buildActions(buttons));
        dialog.replaceChildren(...children);
    }

    /** An action tap: the warning step first for the risky ones (spec E9), else run it. */
    function onAction(content, action) {
        const warning = confirmContent(action);
        if (!warning) {
            runAction(action);
            return;
        }
        const children = texts(warning.title, warning.line);
        children.push(buildActions([
            buildButton(warning.confirm, false, () => runAction(action)),
            buildButton('Cancel', true, () => {
                render(content);
                dialog.focus({ preventScroll: true });
            }),
        ]));
        dialog.replaceChildren(...children);
        dialog.focus({ preventScroll: true });
    }

    function show(content) {
        if (!dialog) build();
        render(content);
        if (!shown) {
            shown = true;
            observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
        }
        if (!dialog.open) open();
    }

    function hide() {
        if (!shown) return;
        shown = false;
        observer.disconnect();
        dialog.close();
    }

    return { show, hide };
}

/**
 * The protection-off banner (spec E9): a bar under ST's top bar with the report link and Turn
 * protection back on. Built with DOM methods only.
 * @returns {{ show: () => void, hide: () => void }} Controls.
 */
function createBanner() {
    let banner = null;

    function build() {
        addStyles();
        banner = document.createElement('div');
        banner.className = `${CSS_PREFIX}-banner`;
        banner.setAttribute('role', 'status');
        const text = document.createElement('span');
        const link = document.createElement('a');
        link.href = ISSUES_URL;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = BANNER_TEXT.link;
        text.append(BANNER_TEXT.before, link, BANNER_TEXT.after);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `menu_button ${CSS_PREFIX}-banner-button`;
        button.textContent = BANNER_TEXT.button;
        button.addEventListener('click', () => runAction('turnProtectionOn'));
        banner.append(text, button);
    }

    function show() {
        if (!banner) build();
        if (!banner.isConnected) document.body.append(banner);
    }

    function hide() {
        if (banner) banner.remove();
    }

    return { show, hide };
}

// ---- Toasts (spec E3, E10, E12) ----------------------------------------------------------------

/** Shows one warning toast through ST's toastr, if it's there. */
function showToast(text) {
    if (typeof window.toastr === 'undefined') return;
    window.toastr.warning(text, '', { escapeHtml: true });
}

/** The untested-version toast, once per ST version (remembered per browser; in memory if storage fails). */
function createUntestedToast() {
    let lastShown = null;
    try {
        lastShown = localStorage.getItem(UNTESTED_TOAST_KEY);
    } catch (error) {
        lastShown = null;
    }
    return function onLeaseInfo(detail) {
        const version = untestedToastFor(detail, lastShown);
        if (version === null) return;
        lastShown = version;
        try {
            localStorage.setItem(UNTESTED_TOAST_KEY, version);
        } catch (error) {
            // Storage blocked: the toast shows again on the next load. Nothing else depends on it.
        }
        showToast(UNTESTED_TEXT);
    };
}

// ---- Wiring ------------------------------------------------------------------------------------

/** Sets `window.__ttExtension` once, frozen (spec E11). */
function announceExtension() {
    if (Object.prototype.hasOwnProperty.call(window, '__ttExtension')) return;
    const info = Object.freeze({ version: EXTENSION_VERSION, leaseVersion: LEASE_VERSION });
    Object.defineProperty(window, '__ttExtension', { value: info, writable: false, configurable: false, enumerable: false });
}

/** Drives the overlay and the toasts from the lease's `tt-lease` events (spec E9, E11). Never in the app's page. */
function listenToLease() {
    const overlay = createOverlay();
    const banner = createBanner();
    const onLeaseInfo = createUntestedToast();
    let holder = false;
    window.addEventListener(LEASE_EVENT, (event) => {
        if (window.__ttLease && window.__ttLease.source !== 'extension') return;
        const detail = event.detail;
        if (!detail) return;
        if (detail.type === 'leaseState') {
            holder = detail.state === 'holder';
            const content = overlayContent(detail);
            if (content) overlay.show(content);
            else overlay.hide();
            if (bannerShown(detail)) banner.show();
            else banner.hide();
        } else if (detail.type === 'leaseInfo') {
            // A parked page's toast would sit behind the overlay: the holder shows it.
            if (holder) onLeaseInfo(detail);
        } else if (detail.type === 'leaseNotice') {
            const text = noticeText(detail);
            if (text) showToast(text);
        }
    });
}

/**
 * Loads session-lease.js as a classic script, the way the app injects it. The version in the URL
 * makes a browser fetch the new file after an extension update instead of a cached copy.
 * @returns {void}
 */
function loadLease() {
    if (Object.prototype.hasOwnProperty.call(window, '__ttLease')) return;
    window.__ttLeaseSource = 'extension';
    const script = document.createElement('script');
    script.src = new URL(`${LEASE_SCRIPT}?v=${encodeURIComponent(EXTENSION_VERSION)}`, import.meta.url).href;
    document.head.append(script);
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    announceExtension();
    listenToLease();
    loadLease();
    window.dispatchEvent(new CustomEvent('tt-extension-ready'));
}
