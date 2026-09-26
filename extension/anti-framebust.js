// GBF Tool Split View — anti-framebust content script
// Runs in MAIN world at document_start inside GameWith iframes.
// Overrides window.top / window.parent so that frame-busting checks
// (e.g. "if (top !== self) top.location = self.location") are silenced.
// Sets data-gbf-fb="1" on <html> when top getter is accessed so
// the ISOLATED world content-diag.js can detect frame-busting activity.
(function () {
    'use strict';
    const tag = '[GBF-ext]';
    try {
        Object.defineProperty(window, 'top', {
            get: function () {
                // Mark that frame-busting code accessed window.top
                try { document.documentElement.setAttribute('data-gbf-fb', '1'); } catch (_) {}
                return window;
            },
            configurable: true
        });
        console.log(tag, 'frame-bust prevention active (top) on', location.hostname);
    } catch (e) {
        console.warn(tag, 'window.top override failed:', e.message);
    }
    try {
        Object.defineProperty(window, 'parent', { get: () => window, configurable: true });
    } catch (e) {
        console.warn(tag, 'window.parent override failed:', e.message);
    }
})();
