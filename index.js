// TravelingTavern extension entry (ES module, desktop only). Spec: context/specs/ext-0.2-session-lease-spec.md
// Announces the extension, then loads the lease core (session-lease.js) as a classic script, unless a
// copy already runs in this page (the TravelingTavern app injects its own at document start).

/** This extension's release version. Must equal manifest.json's `version` (checked by the tests). */
const EXTENSION_VERSION = '0.0.1';
/** The LEASE_VERSION of this extension's session-lease.js (checked by the tests). */
const LEASE_VERSION = 1;

const LEASE_SCRIPT = 'session-lease.js';

/** Sets `window.__ttExtension` once, frozen (spec E11). */
function announceExtension() {
    if (Object.prototype.hasOwnProperty.call(window, '__ttExtension')) return;
    const info = Object.freeze({ version: EXTENSION_VERSION, leaseVersion: LEASE_VERSION });
    Object.defineProperty(window, '__ttExtension', { value: info, writable: false, configurable: false, enumerable: false });
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

announceExtension();
loadLease();
window.dispatchEvent(new CustomEvent('tt-extension-ready'));
