// GBF Tool Split View — anti-framebust content script
// Runs in MAIN world at document_start inside GameWith iframes.
//
// window.top is non-configurable in cross-origin iframes in Chrome,
// so Object.defineProperty always fails there. Strategy:
//  1. Try Object.defineProperty (works in same-origin / some contexts)
//  2. Fallback: __defineGetter__ (deprecated but sometimes works)
//  3. Fallback: intercept location.assign / location.replace / location.href
//     to block pre-DOMContentLoaded redirects (classic frame-busting pattern)
(function () {
    'use strict';
    const tag = '[GBF-ext]';
    let topOverrideOk = false;

    const markFrameBust = () => {
        try { document.documentElement.setAttribute('data-gbf-fb', '1'); } catch (_) {}
    };

    // Attempt 1: Object.defineProperty
    try {
        Object.defineProperty(window, 'top', {
            get: function () { markFrameBust(); return window; },
            configurable: true
        });
        topOverrideOk = true;
    } catch (_) {}

    // Attempt 2: __defineGetter__ (deprecated; may bypass non-configurable check in some contexts)
    if (!topOverrideOk) {
        try {
            window.__defineGetter__('top', function () { markFrameBust(); return window; });
            topOverrideOk = true;
        } catch (_) {}
    }

    if (topOverrideOk) {
        console.log(tag, 'frame-bust prevention active (window.top) on', location.hostname);
    } else {
        console.log(tag, 'window.top non-configurable on', location.hostname, '— using location intercept');
    }

    // window.parent override (same strategy)
    try {
        Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
    } catch (_) {
        try { window.__defineGetter__('parent', () => window); } catch (_) {}
    }

    // Fallback: intercept location navigation to block pre-DOMReady frame-busting
    // Classic pattern: if (top !== self) location.href = '...';
    // We block redirects that fire before DOMContentLoaded.
    try {
        let domReady = false;
        document.addEventListener('DOMContentLoaded', () => { domReady = true; }, { once: true });

        const _assign  = location.assign.bind(location);
        const _replace = location.replace.bind(location);

        const intercept = (fn, url, method) => {
            markFrameBust();
            if (!domReady) {
                console.log(tag, `frame-bust blocked [${method}] pre-DOMReady:`, url);
                return; // block the redirect
            }
            fn(url); // allow post-load navigation (user clicks etc.)
        };

        location.assign  = (url) => intercept(_assign,  url, 'assign');
        location.replace = (url) => intercept(_replace, url, 'replace');

        // Also intercept location.href setter via Location.prototype descriptor
        const hrefDesc = Object.getOwnPropertyDescriptor(Location.prototype, 'href');
        if (hrefDesc?.set) {
            Object.defineProperty(location, 'href', {
                get: hrefDesc.get ? hrefDesc.get.bind(location) : () => location.toString(),
                set: function (url) {
                    markFrameBust();
                    if (!domReady) {
                        console.log(tag, 'frame-bust blocked [location.href] pre-DOMReady:', url);
                        return;
                    }
                    hrefDesc.set.call(location, url);
                },
                configurable: true
            });
        }

        console.log(tag, 'location intercept active on', location.hostname);
    } catch (e) {
        console.warn(tag, 'location intercept failed:', e.message);
    }
})();
