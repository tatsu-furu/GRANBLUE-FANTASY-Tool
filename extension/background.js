// GBF Tool Split View — background service worker

const TAG = '[GBF-ext]';

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    if (message.action === 'ping') {
        const v = chrome.runtime.getManifest().version;
        console.log(TAG, 'ping from', sender.tab?.url, '→ v' + v);
        sendResponse({ installed: true, version: v });
        return;
    }
    if (message.action === 'openSplit' && message.url) {
        console.log(TAG, 'openSplit request:', message.url, 'from tab', sender.tab?.id);
        handleOpenSplit(message.url, sender.tab)
            .then(() => {
                console.log(TAG, 'openSplit success');
                sendResponse({ success: true });
            })
            .catch(e => {
                console.error(TAG, 'openSplit error:', e.message);
                sendResponse({ success: false, error: e.message });
            });
        return true;
    }
    // DNRデバッグ: ページから getMatchedRules を呼べるようにする
    if (message.action === 'getMatchedRules') {
        const tabId = sender.tab?.id;
        chrome.declarativeNetRequest.getMatchedRules(
            { tabId, minTimeStamp: Date.now() - 30000 },
            result => {
                const matches = (result?.rulesMatchedInfo || []).map(m => ({
                    ruleId:    m.rule.ruleId,
                    url:       m.request.url,
                    type:      m.request.type,
                    initiator: m.request.initiator
                }));
                console.log(TAG, 'getMatchedRules: tab', tabId, '→', matches.length, '件 (直近30秒)');
                matches.forEach(m =>
                    console.log(TAG, `  rule#${m.ruleId} | ${m.type} | ${m.url} | from: ${m.initiator}`)
                );
                sendResponse({ matches });
            }
        );
        return true;
    }
});

// ===== DNRデバッグ: ルールがヒットするたびにService Workerコンソールへ出力 =====
// declarativeNetRequestFeedback パーミッションが必要（開発用拡張のみ動作）
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
        const r = info.request;
        // sub_frame（iframeリクエスト）のみ目立たせる
        const mark = r.type === 'sub_frame' ? '★' : ' ';
        console.log(TAG, `${mark}DNR hit rule#${info.rule.ruleId}`,
            `| ${r.type} | ${r.url}`,
            `| from: ${r.initiator || '(none)'}`
        );
    });
    console.log(TAG, 'onRuleMatchedDebug リスナー登録完了');
} else {
    console.warn(TAG, 'onRuleMatchedDebug 未対応 — declarativeNetRequestFeedback パーミッションを確認');
}

async function handleOpenSplit(url, senderTab) {
    const useSplitApi = hasSplitTabsApi();
    console.log(TAG, 'Chrome Split Tab API available:', useSplitApi);
    if (useSplitApi) {
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
