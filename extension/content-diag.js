// GBF Tool Split View — diagnostic content script
// Runs in ISOLATED world at document_idle inside GameWith iframes.
// Checks Meta CSP, Service Worker registrations, and frame-busting flag,
// then reports results to background.js via chrome.runtime.sendMessage.
(async function () {
    'use strict';
    const tag = '[GBF-diag]';

    // 1. Meta CSP: check for <meta http-equiv="Content-Security-Policy">
    const metaCspEl = document.querySelector('meta[http-equiv="Content-Security-Policy" i]');
    const metaCsp = metaCspEl ? metaCspEl.getAttribute('content') || '(empty)' : null;

    // 2. Service Worker registrations
    let swRegistrations = [];
    try {
        const regs = await navigator.serviceWorker.getRegistrations();
        swRegistrations = regs.map(r => ({
            scope: r.scope,
            state: r.active?.state || r.installing?.state || r.waiting?.state || 'unknown'
        }));
    } catch (e) {
        swRegistrations = [{ scope: null, state: 'error: ' + e.message }];
    }

    // 3. Frame-busting: MAIN world sets data-gbf-fb="1" when window.top is accessed
    const frameBust = document.documentElement.getAttribute('data-gbf-fb') === '1';

    // 4. Is this frame actually embedded? (window !== top would be true normally,
    //    but MAIN world overrides top so check via frameElement or window.location)
    const isSubFrame = window.self !== window.top || window.frameElement !== null;

    const report = {
        action: 'iframeDiagReport',
        url: location.href,
        hostname: location.hostname,
        isSubFrame,
        metaCsp,
        swRegistrations,
        frameBust,
        timestamp: Date.now()
    };

    console.log(tag, 'report from', location.hostname, report);
    chrome.runtime.sendMessage(report, () => {
        if (chrome.runtime.lastError) {
            console.warn(tag, 'sendMessage failed:', chrome.runtime.lastError.message);
        }
    });
})();
