// GBF Tool Split View — background service worker

const TAG = '[GBF-ext]';

// Content script diagnostic reports: tabId → latest report
const diagReports = new Map();

// Debugger state per tab:
// tabId → { parentAttached, sessions: Map<sessionId, {url, type, isGameWith, cspApplied, error}>, error }
const debuggerState = new Map();

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
        const dbgState = tabId != null ? debuggerState.get(tabId) : null;

        // Serialize debugger state for transport
        const debugInfo = dbgState ? {
            parentAttached: dbgState.parentAttached,
            error: dbgState.error,
            sessions: [...(dbgState.sessions?.entries() || [])].map(([sid, s]) => ({
                sessionId:     sid.slice(0, 16) + (sid.length > 16 ? '…' : ''),
                url:           s.url,
                type:          s.type,
                title:         s.title,
                targetId:      s.targetId,
                parentSession: s.parentSessionId
                    ? s.parentSessionId.slice(0, 8) + '…'
                    : '(root)',
                isGameWith:    s.isGameWith,
                cspApplied:    s.cspApplied,
                cspError:      s.cspError || null
            }))
        } : null;

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
                sendResponse({ report: report || null, dnrMatches: matches, debugInfo });
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

    // Side Panel: open chrome.sidePanel and navigate to URL
    if (message.action === 'openSidePanel') {
        const tabId = sender.tab?.id;
        const url = message.url;
        if (!tabId || !url) { sendResponse({ success: false, error: 'missing tabId or url' }); return; }
        chrome.storage.session.set({ sidePanelUrl: url })
            .then(async () => {
                try {
                    // Associate this side panel with the specific tab and open it
                    await chrome.sidePanel.setOptions({ tabId, path: 'sidepanel.html', enabled: true });
                    await chrome.sidePanel.open({ tabId });
                    console.log(TAG, 'side panel opened for tab', tabId, '| url:', url);
                    sendResponse({ success: true });
                } catch (e) {
                    console.error(TAG, 'sidePanel.open failed:', e.message);
                    sendResponse({ success: false, error: e.message });
                }
            })
            .catch(e => sendResponse({ success: false, error: e.message }));
        return true;
    }

    // Diagnostic: fetch response headers for a URL (HEAD request from background)
    // Extension host_permissions bypass CORS for listed origins.
    // Note: headers may differ from actual sub_frame requests (no Sec-Fetch-Dest: iframe).
    if (message.action === 'checkSiteHeaders') {
        const url = message.url;
        if (!url) { sendResponse({ error: 'no url' }); return; }
        (async () => {
            try {
                const resp = await fetch(url, {
                    method: 'HEAD',
                    redirect: 'follow',
                    credentials: 'omit'
                });
                sendResponse({
                    status:        resp.status,
                    finalUrl:      resp.url,
                    xFrameOptions: resp.headers.get('x-frame-options'),
                    csp:           resp.headers.get('content-security-policy'),
                    contentType:   resp.headers.get('content-type'),
                    redirected:    resp.redirected
                });
            } catch (e) {
                sendResponse({ error: e.message });
            }
        })();
        return true;
    }

    // MODE B: chrome.debugger + OOPIF CSP bypass
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

// ===== MODE B: chrome.debugger OOPIF-aware CSP bypass =====
// Tracks which tabIds have a debugger attached
const debuggerAttached = new Set();

// Apply CSP bypass to a specific debugger target (tabId + optional sessionId)
async function applyBypassToTarget(tabId, sessionId) {
    const target = sessionId ? { tabId, sessionId } : { tabId };
    const label = sessionId ? `session ${sessionId.slice(0, 8)}…` : `tab ${tabId}`;
    try {
        await chrome.debugger.sendCommand(target, 'Page.enable', {});
        await chrome.debugger.sendCommand(target, 'Page.setBypassCSP', { enabled: true });
        console.log(TAG, `Page.setBypassCSP(true) → ${label}`);
        return true;
    } catch (e) {
        console.error(TAG, `Page.setBypassCSP failed for ${label}:`, e.message);
        return false;
    }
}

// Set up auto-attach for iframe sub-targets on a given debugger target
async function setAutoAttachIframes(tabId, sessionId) {
    const target = sessionId ? { tabId, sessionId } : { tabId };
    try {
        await chrome.debugger.sendCommand(target, 'Target.setAutoAttach', {
            autoAttach: true,
            waitForDebuggerOnStart: false,
            flatten: true,               // Use flat session model
            filter: [{ type: 'iframe', exclude: false }]
        });
        console.log(TAG, 'Target.setAutoAttach(iframes) set on',
            sessionId ? `session ${sessionId.slice(0, 8)}…` : `tab ${tabId}`);
    } catch (e) {
        console.warn(TAG, 'Target.setAutoAttach failed:', e.message);
    }
}

async function enableDebuggerBypass(tabId) {
    const state = {
        parentAttached: false,
        sessions: new Map(),
        error: null
    };
    debuggerState.set(tabId, state);

    try {
        // 1. Attach to parent tab
        if (!debuggerAttached.has(tabId)) {
            await chrome.debugger.attach({ tabId }, '1.3');
            debuggerAttached.add(tabId);
            console.log(TAG, 'debugger attached to tab', tabId);
        }
        state.parentAttached = true;

        // 2. Apply bypass to parent tab target (covers same-origin frames)
        await applyBypassToTarget(tabId, null);

        // 3. Set up auto-attach for cross-origin iframe targets (OOPIFs)
        //    This triggers attachedToTarget events for each iframe
        await setAutoAttachIframes(tabId, null);

    } catch (e) {
        state.error = e.message;
        console.error(TAG, 'enableDebuggerBypass failed:', e.message);
        throw e;
    }
}

async function disableDebuggerBypass(tabId) {
    const state = debuggerState.get(tabId);
    if (state) {
        // Try to disable on all known sessions first
        for (const [sid] of (state.sessions || [])) {
            try {
                await chrome.debugger.sendCommand({ tabId, sessionId: sid }, 'Page.setBypassCSP', { enabled: false });
            } catch (_) {}
        }
        debuggerState.delete(tabId);
    }
    if (debuggerAttached.has(tabId)) {
        try {
            await chrome.debugger.sendCommand({ tabId }, 'Page.setBypassCSP', { enabled: false });
        } catch (_) {}
        await chrome.debugger.detach({ tabId });
        debuggerAttached.delete(tabId);
        console.log(TAG, 'debugger detached from tab', tabId);
    }
}

// ===== chrome.debugger CDP event listener (OOPIF target tracking) =====
chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (tabId == null) return;

    if (method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = params;
        const url        = targetInfo?.url      || '';
        const type       = targetInfo?.type     || '';
        const title      = targetInfo?.title    || '';
        const targetId   = targetInfo?.targetId || '';
        // source.sessionId is the parent session (undefined = root tab)
        const parentSessionId = source.sessionId || null;
        const isGameWith = url.includes('gamewith.jp');

        const state = debuggerState.get(tabId);
        if (state) {
            state.sessions.set(sessionId, {
                url, type, title, targetId, parentSessionId,
                isGameWith,
                cspApplied: false,
                cspError: null
            });
        }

        // Detailed log — visible in Service Worker console
        console.log(TAG, '━━ Target.attachedToTarget ━━');
        console.log(TAG, `  sessionId:     ${sessionId}`);
        console.log(TAG, `  type:          ${type}`);
        console.log(TAG, `  url:           ${url}`);
        console.log(TAG, `  title:         ${title}`);
        console.log(TAG, `  targetId:      ${targetId}`);
        console.log(TAG, `  parentSession: ${parentSessionId || '(root)'}`);
        console.log(TAG, `  isGameWith:    ${isGameWith}`);

        if (isGameWith) {
            // Apply CSP bypass to this GameWith iframe session
            applyBypassToTarget(tabId, sessionId)
                .then(ok => {
                    const sess = state?.sessions.get(sessionId);
                    if (sess) sess.cspApplied = ok;
                    console.log(TAG, `  CSP bypass: ${ok ? 'SUCCESS' : 'FAILED (no error thrown)'} → ${url}`);
                })
                .catch(e => {
                    const sess = state?.sessions.get(sessionId);
                    if (sess) { sess.cspApplied = false; sess.cspError = e.message; }
                    console.error(TAG, `  CSP bypass ERROR: ${e.message} → ${url}`);
                });
            // Set up auto-attach for nested iframes inside this GameWith iframe
            setAutoAttachIframes(tabId, sessionId);
        }
    }

    if (method === 'Target.detachedFromTarget') {
        const { sessionId } = params;
        const state = debuggerState.get(tabId);
        if (state?.sessions.has(sessionId)) {
            const sess = state.sessions.get(sessionId);
            console.log(TAG, `Target.detachedFromTarget | session:${sessionId.slice(0, 8)}… | url:${sess?.url}`);
            state.sessions.delete(sessionId);
        }
    }
});

// Detach when debugger is forcibly removed (e.g. user opens DevTools)
chrome.debugger.onDetach.addListener((source, reason) => {
    const tabId = source.tabId;
    if (tabId != null) {
        console.log(TAG, 'debugger detached (external) from tab', tabId, '| reason:', reason);
        debuggerAttached.delete(tabId);
        const state = debuggerState.get(tabId);
        if (state) {
            state.parentAttached = false;
            state.error = `外部から切断: ${reason}`;
        }
    }
});

// Clean up when tab is closed
chrome.tabs.onRemoved.addListener(tabId => {
    if (debuggerAttached.has(tabId)) {
        chrome.debugger.detach({ tabId }).catch(() => {});
        debuggerAttached.delete(tabId);
    }
    debuggerState.delete(tabId);
    diagReports.delete(tabId);
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
