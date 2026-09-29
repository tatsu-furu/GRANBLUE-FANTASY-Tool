// 共有シート → Googleスプレッドシート
// 1) 設定なしで使える：書式つき（太字・揃え・列幅）でコピーして、新しいスプレッドシート（sheets.new）を開く
// 2) GBF_GOOGLE_CLIENT_ID があるとき：Googleにログインして、書式つきのスプレッドシートを直接作る
//    （権限は drive.file = このツールが作ったファイルだけ。ほかのファイルは見えない）
(function () {
    'use strict';

    const CLIENT_ID = window.GBF_GOOGLE_CLIENT_ID || null;
    const SCOPE = 'https://www.googleapis.com/auth/drive.file';
    const GIS_SRC = 'https://accounts.google.com/gsi/client';

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const isNum = (v) => /^-?\d+(\.\d+)?$/.test(v);
    const ALIGN = { l: 'left', c: 'center', r: 'right' };

    // ---------- 1) コピーして貼り付け ----------
    function toHtml(sheet) {
        const cols = sheet.widths.map((w) => `<col width="${w}">`).join('');
        const rows = sheet.grid.map((row, r) => `<tr>${row.map((cell) => {
            const bold = r === 0 && sheet.freeze ? 'font-weight:bold;background:#eeeeee;' : '';
            return `<td style="text-align:${ALIGN[cell.a] || 'left'};vertical-align:top;${sheet.wrap ? 'white-space:pre-wrap;' : ''}${bold}">${esc(cell.v).replace(/\n/g, '<br>')}</td>`;
        }).join('')}</tr>`).join('');
        return `<meta charset="utf-8"><table>${cols}${rows}</table>`;
    }
    function toTsv(sheet) {
        const q = (v) => (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
        return sheet.grid.map((row) => row.map((c) => q(c.v)).join('\t')).join('\r\n');
    }
    async function copyAndOpen() {
        const [sheet] = window.GBFSheet.snapshot('active');
        if (!sheet || !sheet.grid.length) { say('シートが空です。'); return; }
        const html = toHtml(sheet);
        const text = toTsv(sheet);
        try {
            if (window.ClipboardItem && navigator.clipboard?.write) {
                await navigator.clipboard.write([new ClipboardItem({
                    'text/html': new Blob([html], { type: 'text/html' }),
                    'text/plain': new Blob([text], { type: 'text/plain' }),
                })]);
            } else {
                await navigator.clipboard.writeText(text);
            }
        } catch (e) {
            console.warn(e);
            say('コピーできませんでした。「表をコピー」を試してください。');
            return;
        }
        window.open('https://sheets.new', '_blank', 'noopener');
        say('コピーしました。開いたスプレッドシートで A1 を選んで Ctrl+V（スマホは長押し→貼り付け）してください。');
    }

    // ---------- 2) Google に直接書き出し ----------
    let gisReady = null;
    const loadGis = () => (gisReady ||= new Promise((resolve, reject) => {
        if (window.google?.accounts?.oauth2) { resolve(); return; }
        const sc = document.createElement('script');
        sc.src = GIS_SRC;
        sc.async = true;
        sc.onload = () => resolve();
        sc.onerror = () => { gisReady = null; reject(new Error('Googleのログイン部品を読み込めませんでした')); };
        document.head.appendChild(sc);
    }));
    let token = null; // { value, exp }
    let tokenClient = null;
    // ログイン画面はボタンを押した直後に開かないとブロックされるので、部品は先に読んでおく
    function requestToken() {
        if (token && token.exp > Date.now() + 60000) return Promise.resolve(token.value);
        return new Promise((resolve, reject) => {
            if (!window.google?.accounts?.oauth2) { reject(new Error('Googleのログイン部品がまだ読み込めていません。もう一度押してください')); return; }
            tokenClient ||= google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: () => {} });
            tokenClient.callback = (resp) => {
                if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
                token = { value: resp.access_token, exp: Date.now() + (Number(resp.expires_in) || 3600) * 1000 };
                resolve(token.value);
            };
            tokenClient.error_callback = (err) => reject(new Error(err?.type === 'popup_closed' ? 'ログインが閉じられました' : (err?.message || 'ログインできませんでした')));
            tokenClient.requestAccessToken({ prompt: token ? '' : undefined });
        });
    }

    // Sheets API に渡す形にする（値・太字の見出し・揃え・列幅・1行目固定）
    function buildRequest(list, title) {
        const used = new Set();
        const sheetTitle = (name) => {
            let base = (name || 'シート').replace(/[[\]*?/\\:]/g, '_').slice(0, 90) || 'シート';
            let t = base;
            for (let i = 2; used.has(t); i++) t = `${base} (${i})`;
            used.add(t);
            return t;
        };
        return {
            properties: { title },
            sheets: list.map((sh) => {
                const cols = Math.max(sh.widths.length, 1);
                const rows = Math.max(sh.grid.length, 1);
                return {
                    properties: {
                        title: sheetTitle(sh.name),
                        gridProperties: { rowCount: Math.max(rows + 20, 50), columnCount: Math.max(cols, 8), frozenRowCount: sh.freeze && rows > 0 ? 1 : 0 },
                    },
                    data: [{
                        startRow: 0,
                        startColumn: 0,
                        columnMetadata: sh.widths.map((w) => ({ pixelSize: w })),
                        rowData: sh.grid.map((row, r) => ({
                            values: row.map((cell) => {
                                const out = {};
                                if (cell.v !== '') out.userEnteredValue = isNum(cell.v) ? { numberValue: Number(cell.v) } : { stringValue: cell.v };
                                const fmt = {};
                                if (cell.a === 'c') fmt.horizontalAlignment = 'CENTER';
                                if (cell.a === 'r') fmt.horizontalAlignment = 'RIGHT';
                                if (sh.wrap && cell.v !== '') { fmt.wrapStrategy = 'WRAP'; fmt.verticalAlignment = 'TOP'; }
                                if (r === 0 && sh.freeze) {
                                    fmt.textFormat = { bold: true };
                                    fmt.backgroundColor = { red: 0.93, green: 0.93, blue: 0.93 };
                                }
                                if (Object.keys(fmt).length) out.userEnteredFormat = fmt;
                                return out;
                            }),
                        })),
                    }],
                };
            }),
        };
    }

    async function exportDirect(which) {
        const list = window.GBFSheet.snapshot(which).filter((s) => s.grid.length);
        if (!list.length) { say('書き出す内容がありません。'); return; }
        const date = new Date().toLocaleString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
        const title = `${window.GBFCollab?.roomName || 'GBF 共有シート'}${which === 'all' ? '' : ` - ${list[0].name}`}（${date}）`;
        let accessToken;
        try { accessToken = await requestToken(); } catch (e) { say(e.message); return; }
        say('書き出し中…');
        try {
            const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
                method: 'POST',
                headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(buildRequest(list, title)),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) {
                if (res.status === 401) token = null;
                throw new Error(body?.error?.message || `HTTP ${res.status}`);
            }
            const url = body.spreadsheetUrl;
            say(`書き出しました（${list.length}シート）。`, url);
            window.open(url, '_blank', 'noopener');
        } catch (e) {
            console.warn(e);
            say(`書き出せませんでした: ${e.message}`);
        }
    }

    // ---------- 画面（ツールバーのボタンから開く小さなメニュー） ----------
    const menu = document.createElement('div');
    menu.className = 'gs-menu';
    menu.hidden = true;
    menu.innerHTML = `
        <button class="btn" data-gs="copy">この表をコピーして、新しいスプレッドシートを開く</button>
        <p class="gs-note">太字の見出し・揃え・列幅つきで貼り付けられます（設定不要）。</p>
        ${CLIENT_ID ? `
            <hr>
            <button class="btn gs-primary" data-gs="api-one">Googleに直接書き出す（このシート）</button>
            <button class="btn" data-gs="api-all">Googleに直接書き出す（全シートを1つのファイルに）</button>
            <p class="gs-note">初回はGoogleのログイン画面が出ます。このツールが作ったファイルにだけアクセスします。</p>` : ''}
        <p class="gs-msg" aria-live="polite"></p>`;
    const msgEl = menu.querySelector('.gs-msg');
    function say(text, url) {
        msgEl.innerHTML = esc(text) + (url ? ` <a href="${esc(url)}" target="_blank" rel="noopener">開く</a>` : '');
    }

    function toggle(anchor) {
        if (!menu.isConnected) anchor.closest('.sheet-toolbar').after(menu);
        menu.hidden = !menu.hidden;
        if (!menu.hidden) {
            say('');
            if (CLIENT_ID) loadGis().catch((e) => say(e.message));
        }
    }
    menu.addEventListener('click', (e) => {
        const act = e.target.closest('[data-gs]')?.dataset.gs;
        if (act === 'copy') copyAndOpen();
        else if (act === 'api-one') exportDirect('active');
        else if (act === 'api-all') exportDirect('all');
    });
    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="gsheet"]')) menu.hidden = true;
    });

    // ほかの機能（Googleドライブへのルーム保存など）からも同じログインを使う
    window.GBFGoogle = { available: !!CLIENT_ID, loadGis, requestToken };

    window.GBFGSheets = { toggle, _buildRequest: buildRequest, _toHtml: toHtml };
})();
