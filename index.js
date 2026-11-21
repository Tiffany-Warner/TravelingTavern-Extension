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

const CONTROL = Object.freeze({ useHere: 'useHere', reload: 'reload', spinner: 'spinner', none: 'none' });

const IN_USE = Object.freeze({ title: 'In use on another device', line: 'Use SillyTavern here instead?', control: CONTROL.useHere });

/** The overlay's texts by `leaseState.reason` (spec E9). */
const OVERLAY_TEXTS = Object.freeze({
    held: IN_USE,
    lost: IN_USE,
    claiming: Object.freeze({
        title: 'Taking over…',
        line: 'Loading your chat on this device. If your browser asks whether to leave the site, choose Leave.',
        control: CONTROL.spinner,
    }),
    waitingForReply: Object.freeze({ title: 'Finishing a reply…', line: 'Your other device is still writing a reply.', control: CONTROL.spinner }),
    lostRace: Object.freeze({ title: 'Another device took over', line: 'It claimed SillyTavern first.', control: CONTROL.useHere }),
    unreadable: Object.freeze({ title: 'Can\'t reach SillyTavern', line: 'Nothing is saved from this page.', control: CONTROL.useHere }),
    unknownFormat: Object.freeze({
        title: 'Update needed',
        line: 'Update the TravelingTavern extension to use SillyTavern here.',
        control: CONTROL.none,
    }),
    reloadPending: Object.freeze({ title: 'Reload needed', line: 'Reload this page to finish taking over.', control: CONTROL.reload }),
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
    border-radius: 12px;
    font-size: 1.1em;
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
 * @returns {{ title: string, line: string, control: string } | null} The texts and control while
 *     parked; null when holder. An unknown parked reason shows the "in use" texts (Use here; the lease
 *     ignores it if it can't claim).
 */
export function overlayContent(detail) {
    if (!detail || detail.state !== 'parked') return null;
    return Object.prototype.hasOwnProperty.call(OVERLAY_TEXTS, detail.reason) ? OVERLAY_TEXTS[detail.reason] : IN_USE;
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

/** A control element for the overlay: the Use here / Reload button, the spinner, or nothing. */
function buildControl(control) {
    if (control === CONTROL.spinner) {
        const spinner = document.createElement('div');
        spinner.className = `${CSS_PREFIX}-spinner`;
        spinner.setAttribute('role', 'progressbar');
        spinner.setAttribute('aria-label', 'Loading');
        return spinner;
    }
    if (control !== CONTROL.useHere && control !== CONTROL.reload) return null;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `menu_button ${CSS_PREFIX}-button`;
    button.textContent = control === CONTROL.reload ? 'Reload' : 'Use here';
    button.addEventListener('click', control === CONTROL.reload ? () => location.reload() : useHere);
    return button;
}

/** Use here (spec E9): the lease reports the outcome through `leaseState`. */
function useHere() {
    window.__ttLease.useHere().catch((error) => {
        console.warn(LOG_PREFIX, 'Use here failed', error && error.name);
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

    function raise() {
        if (dialog.open) dialog.close();
        dialog.showModal();
    }

    function build() {
        addStyles();
        dialog = document.createElement('dialog');
        dialog.className = `${CSS_PREFIX}-overlay`;
        dialog.setAttribute('aria-labelledby', `${CSS_PREFIX}-title`);
        dialog.setAttribute('aria-describedby', `${CSS_PREFIX}-line`);
        dialog.addEventListener('cancel', (event) => event.preventDefault());
        // Chrome can close a modal on a repeated Escape despite preventDefault: open it again.
        dialog.addEventListener('close', () => { if (shown && !dialog.open) dialog.showModal(); });
        document.body.append(dialog);
    }

    function render(content) {
        const title = document.createElement('h2');
        title.id = `${CSS_PREFIX}-title`;
        title.className = `${CSS_PREFIX}-title`;
        title.textContent = content.title;
        const line = document.createElement('p');
        line.id = `${CSS_PREFIX}-line`;
        line.className = `${CSS_PREFIX}-line`;
        line.textContent = content.line;
        const control = buildControl(content.control);
        dialog.replaceChildren(...(control ? [title, line, control] : [title, line]));
    }

    function show(content) {
        if (!dialog) build();
        render(content);
        if (!shown) {
            shown = true;
            observer.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });
        }
        if (!dialog.open) dialog.showModal();
    }

    function hide() {
        if (!shown) return;
        shown = false;
        observer.disconnect();
        dialog.close();
    }

    return { show, hide };
}

// ---- Toasts (spec E3, E10, E12) ----------------------------------------------------------------

/** Shows one warning toast through ST's toastr, if it's there. */
function showToast(text) {
    if (typeof window.toastr === 'undefined') return;
    window.toastr.warning(text, 'TravelingTavern', { escapeHtml: true });
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
