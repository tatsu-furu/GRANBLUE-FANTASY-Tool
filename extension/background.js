// GBF Tool Split View — background service worker

const TAG = '[GBF-ext]';

// Store diagnostic reports per tab: tabId → latest report
const diagReports = new Map();

// ===== Content script → background: iframeDiagReport =====
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'iframeDiagReport') {
        const tabId = sender.tab?.id;
        if (tabId != null) {
            diagReports.set(tabId, { ...message, tabId });
            console.log(TAG, 'iframeDiagReport from tab', tabId, '|', message.hostname,
                '| metaCsp:', message.metaCsp != null,
                '| sw:', message.swRegistrations?.length,
                '| frameBust:', message.frameBust
            );
        }
        sendResponse({ ok: true });
        return;
    }
});

// ===== Website → background (externally_connectable) =====
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

    // Return latest diagnostic report for the requesting tab
    if (message.action === 'getDiagResults') {
        const tabId = sender.tab?.id;
        const report = tabId != null ? diagReports.get(tabId) : null;

        // Also query getMatchedRules for this tab
        chrome.declarativeNetRequest.getMatchedRules(
            { tabId, minTimeStamp: Date.now() - 60000 },
            result => {
                const matches = (result?.rulesMatchedInfo || []).map(m => ({
                    ruleId:    m.rule.ruleId,
                    url:       m.request.url,
                    type:      m.request.type,
                    initiator: m.request.initiator
                }));
                console.log(TAG, 'getDiagResults: tab', tabId, '→', matches.length, 'DNR hits (60s)');
                sendResponse({ report: report || null, dnrMatches: matches });
            }
        );
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

    // MODE B: chrome.debugger で Page.setBypassCSP(true) を実行
    if (message.action === 'enableDebuggerBypass') {
        const tabId = sender.tab?.id;
        if (tabId == null) { sendResponse({ success: false, error: 'no tabId' }); return; }
        enableDebuggerBypass(tabId)
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    if (message.action === 'disableDebuggerBypass') {
        const tabId = sender.tab?.id;
        if (tabId == null) { sendResponse({ success: false, error: 'no tabId' }); return; }
        disableDebuggerBypass(tabId)
            .then(() => sendResponse({ success: true }))
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }
});

// ===== DNRデバッグ: ルールがヒットするたびにService Workerコンソールへ出力 =====
// declarativeNetRequestFeedback パーミッションが必要（開発用拡張のみ動作）
if (chrome.declarativeNetRequest.onRuleMatchedDebug) {
    chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
        const r = info.request;
        const mark = r.type === 'sub_frame' ? '★' : ' ';
        const ruleName = info.rule.ruleId === 1 ? 'XFO' : info.rule.ruleId === 2 ? 'CSP' : `#${info.rule.ruleId}`;
        console.log(TAG, `${mark}DNR hit rule#${info.rule.ruleId}(${ruleName})`,
            `| ${r.type} | ${r.url}`,
            `| from: ${r.initiator || '(none)'}`
        );
    });
    console.log(TAG, 'onRuleMatchedDebug リスナー登録完了');
} else {
    console.warn(TAG, 'onRuleMatchedDebug 未対応 — declarativeNetRequestFeedback パーミッションを確認');
}

// ===== MODE B: chrome.debugger CSP bypass =====
const debuggerAttached = new Set(); // tabIds currently attached

async function enableDebuggerBypass(tabId) {
    if (!debuggerAttached.has(tabId)) {
        await chrome.debugger.attach({ tabId }, '1.3');
        debuggerAttached.add(tabId);
        console.log(TAG, 'debugger attached to tab', tabId);
    }
    await chrome.debugger.sendCommand({ tabId }, 'Page.setBypassCSP', { enabled: true });
    console.log(TAG, 'Page.setBypassCSP(true) sent to tab', tabId);
}

async function disableDebuggerBypass(tabId) {
    if (debuggerAttached.has(tabId)) {
        try {
            await chrome.debugger.sendCommand({ tabId }, 'Page.setBypassCSP', { enabled: false });
        } catch (_) {}
        await chrome.debugger.detach({ tabId });
        debuggerAttached.delete(tabId);
        console.log(TAG, 'debugger detached from tab', tabId);
    }
}

// Clean up debugger attachment if tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
    if (debuggerAttached.has(tabId)) {
        chrome.debugger.detach({ tabId }).catch(() => {});
        debuggerAttached.delete(tabId);
        diagReports.delete(tabId);
    }
});

// ===== Split view helpers =====
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
    const match = self.navigator?.userAgent?.match(/Chrome\/(\d+)/);
    const version = match ? parseInt(match[1], 10) : 0;
    return version >= 155;
}

async function openSplitWindows(url, senderTab) {
    const displays = await getDisplayBounds();
    const halfW = Math.floor(displays.width / 2);
    const h = displays.height;

    await chrome.windows.update(senderTab.windowId, {
        state: 'normal',
        left: displays.left,
        top: displays.top,
        width: halfW,
        height: h
    });

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
    try {
        const wins = await chrome.windows.getAll();
        const maximized = wins.find(w => w.state === 'maximized' || w.state === 'fullscreen');
        if (maximized) {
            return { left: 0, top: 0, width: maximized.width, height: maximized.height };
        }
    } catch (_) { /* ignore */ }
    return { left: 0, top: 0, width: 1920, height: 1080 };
}
