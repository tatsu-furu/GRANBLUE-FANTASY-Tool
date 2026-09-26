// GBF Tool Split View — anti-framebust content script
// Runs in MAIN world at document_start inside GameWith iframes.
// Overrides window.top / window.parent so that frame-busting checks
// (e.g. "if (top !== self) top.location = self.location") are silenced.
(function () {
    'use strict';
    const tag = '[GBF-ext]';
    try {
        Object.defineProperty(window, 'top', { get: () => window, configurable: true });
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
