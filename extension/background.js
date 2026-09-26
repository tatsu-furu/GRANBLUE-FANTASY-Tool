// GBF Tool Split View — background service worker

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
        sendResponse({ installed: true, version: chrome.runtime.getManifest().version });
        return;
    }
    if (message.action === 'openSplit' && message.url) {
        handleOpenSplit(message.url, sender.tab)
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true; // async response
    }
});

async function handleOpenSplit(url, senderTab) {
    // Chrome 155+ では chrome.tabs.create の splitWithTabId オプションが使える
    // それ以前は2ウィンドウを左右に並べるフォールバック
    if (hasSplitTabsApi()) {
        await chrome.tabs.create({
            url: url,
            splitWithTabId: senderTab.id,
            windowId: senderTab.windowId
        });
    } else {
        await openSplitWindows(url, senderTab);
    }
}

function hasSplitTabsApi() {
    // splitWithTabId が chrome.tabs.create に存在するかで Chrome 155+ を判定
    // ※ APIのfeature detectionはランタイムで確認できないため、
    //   実際に呼び出してエラーをキャッチするか、バージョン文字列で判定する
    const match = self.navigator?.userAgent?.match(/Chrome\/(\d+)/);
    const version = match ? parseInt(match[1], 10) : 0;
    return version >= 155;
}

async function openSplitWindows(url, senderTab) {
    // Chrome 154 以前: 2ウィンドウを画面左右に並べる
    const displays = await getDisplayBounds();
    const halfW = Math.floor(displays.width / 2);
    const h = displays.height;

    // 現在のウィンドウを左半分に
    await chrome.windows.update(senderTab.windowId, {
        state: 'normal',
        left: displays.left,
        top: displays.top,
        width: halfW,
        height: h
    });

    // 新しいウィンドウを右半分に
    await chrome.windows.create({
        url: url,
        left: displays.left + halfW,
        top: displays.top,
        width: halfW,
        height: h,
        state: 'normal'
    });
}

async function getDisplayBounds() {
    // 現在のウィンドウの画面情報から推定
    // chrome.system.display は別パーミッションが必要なためウィンドウベースで推定
    try {
        const wins = await chrome.windows.getAll();
        // 最大化されたウィンドウがあればその幅を流用
        const maximized = wins.find(w => w.state === 'maximized' || w.state === 'fullscreen');
        if (maximized) {
            return { left: 0, top: 0, width: maximized.width, height: maximized.height };
        }
    } catch (_) { /* ignore */ }
    // フォールバック: 一般的な解像度を仮定
    return { left: 0, top: 0, width: 1920, height: 1080 };
}
