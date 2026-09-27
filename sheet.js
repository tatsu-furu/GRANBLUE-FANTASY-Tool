// 共有シート（簡易スプレッドシート）。
// データは GBFCollab.currentStore() の sheets/ 以下に置く。ルーム中は全員で同期、ルーム外はこのブラウザ内だけ。
//   sheets/{id} = { name, order, rows, cols, freeze, widths: {列: px}, cells: { '行_列': 文字列 }, align: { '行_列': 'c' | 'r' } }
// セル単位で書き込むので、別々のセルなら同時に編集しても消し合わない。
(function () {
    'use strict';

    const DEFAULT_ROWS = 30;
    const DEFAULT_COLS = 8;
    const MAX_ROWS = 500;
    const MAX_COLS = 52;
    const MAX_CELL = 2000;
    const COL_W = 110;

    const panel = document.getElementById('sheet-panel');
    if (!panel || !window.GBFCollab) return;

    let store = null;
    let unsub = null;
    let sheets = {};
    let activeId = null;
    let builtFor = ''; // 今の表がどのシートの何行何列で組んであるか
    let lastAnnounced = '';
    // 選択範囲（anchor から focus まで）。lastKey は最後にいたセル（予兆パネルからの挿入先）
    let sel = null;
    let lastKey = null;

    panel.innerHTML = `
        <div class="sheet-tabs" role="tablist"></div>
        <div class="sheet-toolbar">
            <button class="btn" data-act="rows">行を追加 (+10)</button>
            <button class="btn" data-act="cols">列を追加</button>
            <button class="btn" data-act="freeze"></button>
            <span class="sep"></span>
            <button class="btn" data-act="al-l" title="左揃え">左揃え</button>
            <button class="btn" data-act="al-c" title="中央揃え">中央</button>
            <button class="btn" data-act="al-r" title="右揃え">右揃え</button>
            <span class="sep"></span>
            <button class="btn" data-act="copy">表をコピー</button>
            <button class="btn" data-act="csv">CSVで保存</button>
            <button class="btn" data-act="rename">名前を変更</button>
            <button class="btn reset-btn" data-act="delete">シートを削除</button>
        </div>
        <p class="sheet-where"></p>
        <div class="sheet-wrap"><table class="sheet-grid"></table></div>
        <p class="sheet-hint">Googleスプレッドシートなどでコピーした範囲は、左上にしたいセルを選んで貼り付け（Ctrl+V）できます。Enterで下、Tabで右へ移動します。Shift+クリック・Shift+矢印で範囲選択、列・行の番号をクリックで列・行ごと選択できます（揃え・Delete・コピーが範囲にかかります）。</p>`;
    const tabsEl = panel.querySelector('.sheet-tabs');
    const gridEl = panel.querySelector('.sheet-grid');
    const whereEl = panel.querySelector('.sheet-where');
    const freezeBtn = panel.querySelector('[data-act="freeze"]');

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const colName = (c) => (c < 26 ? '' : String.fromCharCode(64 + Math.floor(c / 26))) + String.fromCharCode(65 + (c % 26));
    const newId = () => Math.random().toString(36).slice(2, 10);
    const sheetList = () => Object.entries(sheets)
        .filter(([, s]) => s && typeof s === 'object')
        .map(([id, s]) => ({ id, ...s }))
        .sort((a, b) => (a.order || 0) - (b.order || 0) || a.id.localeCompare(b.id));
    const active = () => (activeId && sheets[activeId] ? { id: activeId, ...sheets[activeId] } : null);
    const cellsOf = (s) => (s && s.cells) || {};

    // ---------- 書き込み ----------
    const write = (path, updates) => store.update(path, updates).catch((e) => { console.warn('sheet write failed', e); whereEl.textContent = '保存に失敗しました（通信を確認してください）'; });

    function addSheet(name) {
        const list = sheetList();
        const id = newId();
        const order = list.length ? Math.max(...list.map((s) => s.order || 0)) + 1 : 1;
        activeId = id;
        return write('sheets', { [id]: { name: name || `シート${list.length + 1}`, order, rows: DEFAULT_ROWS, cols: DEFAULT_COLS, freeze: true } });
    }
    function setCells(sheetId, entries) {
        const updates = {};
        for (const [key, value] of entries) updates[key] = value === '' ? null : String(value).slice(0, MAX_CELL);
        return write(`sheets/${sheetId}/cells`, updates);
    }

    // ---------- 描画 ----------
    function render() {
        const list = sheetList();
        if (!active()) activeId = list[0]?.id || null;
        tabsEl.innerHTML = list.map((s) => `<button class="sheet-tab${s.id === activeId ? ' on' : ''}" role="tab" aria-selected="${s.id === activeId}" data-id="${esc(s.id)}">${esc(s.name || '無題')}</button>`).join('')
            + '<button class="sheet-tab add" data-act="add" title="シートを追加">＋</button>';
        whereEl.textContent = GBFCollab.inRoom
            ? 'ルームの全員と同期しています。'
            : 'いまはこのブラウザ内だけに保存されます。上の「ルームを作成」で共有できます。';

        const s = active();
        panel.querySelectorAll('.sheet-toolbar .btn').forEach((b) => { b.disabled = !s; });
        if (!s) { gridEl.innerHTML = '<tbody><tr><td class="sheet-empty">「＋」でシートを追加してください</td></tr></tbody>'; builtFor = ''; return; }
        freezeBtn.textContent = s.freeze ? '1行目の固定を解除' : '1行目を固定';

        const rows = Math.min(Number(s.rows) || DEFAULT_ROWS, MAX_ROWS);
        const cols = Math.min(Number(s.cols) || DEFAULT_COLS, MAX_COLS);
        const shape = `${s.id}:${rows}:${cols}`;
        if (builtFor !== shape) {
            builtFor = shape; // 先に記録する（作り直しでフォーカスが戻る→在室更新→再描画、の再入で作り直さない）
            buildGrid(s, rows, cols);
        }
        gridEl.classList.toggle('freeze', !!s.freeze);
        applyWidths(s, cols);
        fillValues(s);
        renderSelection();
        renderPresence();
    }

    function buildGrid(s, rows, cols) {
        const focused = document.activeElement?.closest?.('.sheet-grid') ? document.activeElement.dataset.key : null;
        let html = '<thead><tr><th class="corner"></th>';
        for (let c = 0; c < cols; c++) html += `<th class="pick" data-c="${c}"><div class="col-head">${colName(c)}</div></th>`;
        html += '</tr></thead><tbody>';
        for (let r = 0; r < rows; r++) {
            html += `<tr><th class="row-head pick" data-r="${r}">${r + 1}</th>`;
            for (let c = 0; c < cols; c++) html += `<td><input data-key="${r}_${c}" data-r="${r}" data-c="${c}" aria-label="${colName(c)}${r + 1}"></td>`;
            html += '</tr>';
        }
        gridEl.innerHTML = html + '</tbody>';
        if (focused) gridEl.querySelector(`input[data-key="${focused}"]`)?.focus();
    }

    function applyWidths(s, cols) {
        const widths = s.widths || {};
        for (let c = 0; c < cols; c++) {
            const head = gridEl.querySelector(`th[data-c="${c}"] .col-head`);
            if (head && !head.dataset.resizing) head.style.width = `${Number(widths[c]) || COL_W}px`;
        }
    }

    function fillValues(s) {
        const cells = cellsOf(s);
        const align = s.align || {};
        gridEl.querySelectorAll('input[data-key]').forEach((input) => {
            const v = cells[input.dataset.key] ?? '';
            if (input !== document.activeElement && input.value !== v) input.value = v;
            const a = align[input.dataset.key];
            const td = input.parentElement;
            td.classList.toggle('al-c', a === 'c');
            td.classList.toggle('al-r', a === 'r');
        });
    }

    // ---------- 選択範囲 ----------
    const rect = () => sel && {
        r1: Math.min(sel.ar, sel.fr), r2: Math.max(sel.ar, sel.fr),
        c1: Math.min(sel.ac, sel.fc), c2: Math.max(sel.ac, sel.fc),
    };
    function selectedKeys() {
        const q = rect();
        if (!q) return [];
        const keys = [];
        for (let r = q.r1; r <= q.r2; r++) for (let c = q.c1; c <= q.c2; c++) keys.push(`${r}_${c}`);
        return keys;
    }
    const isMulti = () => { const q = rect(); return !!q && (q.r1 !== q.r2 || q.c1 !== q.c2); };
    function renderSelection() {
        const q = rect();
        const multi = isMulti();
        gridEl.querySelectorAll('input[data-key]').forEach((input) => {
            const r = Number(input.dataset.r);
            const c = Number(input.dataset.c);
            input.parentElement.classList.toggle('sel', multi && r >= q.r1 && r <= q.r2 && c >= q.c1 && c <= q.c2);
        });
        // ツールバーの揃えボタンに、いまのセルの揃えを表示
        const s = active();
        const a = s && sel ? (s.align || {})[`${sel.fr}_${sel.fc}`] || 'l' : null;
        ['l', 'c', 'r'].forEach((k) => panel.querySelector(`[data-act="al-${k}"]`)?.classList.toggle('on', a === k));
    }
    function setSel(ar, ac, fr, fc) { sel = { ar, ac, fr, fc }; renderSelection(); }

    // 他の人がいまいるセルに色枠を付ける
    function renderPresence() {
        gridEl.querySelectorAll('td.peer').forEach((td) => { td.classList.remove('peer'); td.style.removeProperty('--peer'); td.removeAttribute('data-peer'); });
        const presence = GBFCollab.presence || {};
        for (const [id, p] of Object.entries(presence)) {
            if (!p || id === GBFCollab.clientId || p.sheet !== activeId || !p.cell) continue;
            const td = gridEl.querySelector(`input[data-key="${p.cell}"]`)?.parentElement;
            if (!td) continue;
            td.classList.add('peer');
            td.style.setProperty('--peer', p.color || '#888');
            td.dataset.peer = p.name || '';
        }
    }

    // ---------- 入力 ----------
    const inputAt = (r, c) => gridEl.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
    function move(input, dr, dc, extend = false) {
        const next = inputAt(Number(input.dataset.r) + dr, Number(input.dataset.c) + dc);
        if (!next) return;
        const anchor = extend && sel ? [sel.ar, sel.ac] : null;
        if (anchor) extending = true;
        next.focus();
        next.select();
        if (anchor) setSel(anchor[0], anchor[1], Number(next.dataset.r), Number(next.dataset.c));
    }

    gridEl.addEventListener('input', (e) => {
        const input = e.target.closest('input[data-key]');
        const s = active();
        if (input && s) setCells(s.id, [[input.dataset.key, input.value]]);
    });
    let extending = false; // Shift で範囲を広げている途中
    gridEl.addEventListener('mousedown', (e) => {
        const input = e.target.closest('input[data-key]');
        if (input && e.shiftKey && sel) {
            e.preventDefault();
            setSel(sel.ar, sel.ac, Number(input.dataset.r), Number(input.dataset.c));
        }
    });
    gridEl.addEventListener('focusin', (e) => {
        const input = e.target.closest('input[data-key]');
        if (!input) return;
        lastKey = input.dataset.key;
        if (!extending) setSel(Number(input.dataset.r), Number(input.dataset.c), Number(input.dataset.r), Number(input.dataset.c));
        extending = false;
        const key = `${activeId}:${input.dataset.key}`;
        if (key !== lastAnnounced) { lastAnnounced = key; GBFCollab.announce({ sheet: activeId, cell: input.dataset.key }); }
    });
    gridEl.addEventListener('keydown', (e) => {
        const input = e.target.closest('input[data-key]');
        if (!input || e.isComposing || e.keyCode === 229) return;
        const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const atEnd = input.selectionStart === input.value.length;
        const s = active();
        if (e.shiftKey && e.key.startsWith('Arrow')) {
            e.preventDefault();
            const d = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
            move(input, d[0], d[1], true);
        } else if (e.key === 'Enter') { e.preventDefault(); move(input, e.shiftKey ? -1 : 1, 0); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); move(input, 1, 0); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(input, -1, 0); }
        else if (e.key === 'ArrowLeft' && atStart) { e.preventDefault(); move(input, 0, -1); }
        else if (e.key === 'ArrowRight' && atEnd) { e.preventDefault(); move(input, 0, 1); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && isMulti() && s) {
            // 範囲選択中は範囲をまとめて消す
            e.preventDefault();
            const keys = selectedKeys();
            keys.forEach((k) => { const el = gridEl.querySelector(`input[data-key="${k}"]`); if (el) el.value = ''; });
            setCells(s.id, keys.map((k) => [k, '']));
        } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && isMulti() && s) {
            e.preventDefault();
            const q = rect();
            navigator.clipboard?.writeText(toText(s, '\t', q)).then(() => { whereEl.textContent = `${q.r2 - q.r1 + 1}行×${q.c2 - q.c1 + 1}列をコピーしました。`; });
        }
    });

    // 表計算ソフトからの貼り付け（タブ区切り。改行を含むセルは "" で囲まれている）
    function parseTsv(text) {
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (quoted) {
                if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
                else if (ch === '"') quoted = false;
                else cell += ch;
            } else if (ch === '"' && cell === '') quoted = true;
            else if (ch === '\t') { row.push(cell); cell = ''; }
            else if (ch === '\n' || ch === '\r') {
                if (ch === '\r' && text[i + 1] === '\n') i++;
                row.push(cell); rows.push(row); row = []; cell = '';
            } else cell += ch;
        }
        if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
        return rows;
    }
    gridEl.addEventListener('paste', (e) => {
        const input = e.target.closest('input[data-key]');
        const s = active();
        const text = e.clipboardData?.getData('text/plain') || '';
        if (!input || !s || !/[\t\n]/.test(text.replace(/\n$/, ''))) return; // 1セル分は普通に貼る
        e.preventDefault();
        const data = parseTsv(text);
        const r0 = Number(input.dataset.r);
        const c0 = Number(input.dataset.c);
        const needRows = Math.min(r0 + data.length, MAX_ROWS);
        const needCols = Math.min(c0 + Math.max(...data.map((r) => r.length)), MAX_COLS);
        const entries = [];
        data.forEach((row, i) => row.forEach((v, j) => {
            if (r0 + i < MAX_ROWS && c0 + j < MAX_COLS) entries.push([`${r0 + i}_${c0 + j}`, v]);
        }));
        const grow = {};
        if (needRows > (Number(s.rows) || 0)) grow.rows = needRows;
        if (needCols > (Number(s.cols) || 0)) grow.cols = needCols;
        const cellUpdates = Object.fromEntries(entries.map(([k, v]) => [`cells/${k}`, v === '' ? null : v.slice(0, MAX_CELL)]));
        write(`sheets/${s.id}`, { ...grow, ...cellUpdates });
    });

    // 列幅（見出しの右下をドラッグ）
    gridEl.addEventListener('pointerdown', (e) => {
        const head = e.target.closest('.col-head');
        if (!head) return;
        head.dataset.resizing = '1';
        const start = head.offsetWidth;
        const done = () => {
            window.removeEventListener('pointerup', done);
            delete head.dataset.resizing;
            const s = active();
            const c = head.parentElement.dataset.c;
            if (head.offsetWidth !== start) head.parentElement.dataset.justResized = '1';
            if (s && head.offsetWidth !== start) write(`sheets/${s.id}/widths`, { [c]: Math.max(40, Math.min(600, head.offsetWidth)) });
        };
        window.addEventListener('pointerup', done);
    });

    // 列・行の番号クリックで、列・行ごと選択
    gridEl.addEventListener('click', (e) => {
        const th = e.target.closest('th.pick');
        const s = active();
        if (!th || !s) return;
        if (th.dataset.justResized) { delete th.dataset.justResized; return; }
        const rows = Math.min(Number(s.rows) || DEFAULT_ROWS, MAX_ROWS);
        const cols = Math.min(Number(s.cols) || DEFAULT_COLS, MAX_COLS);
        extending = true;
        if (th.dataset.c != null) { const c = Number(th.dataset.c); inputAt(0, c)?.focus(); setSel(0, c, rows - 1, c); }
        else if (th.dataset.r != null) { const r = Number(th.dataset.r); inputAt(r, 0)?.focus(); setSel(r, 0, r, cols - 1); }
        extending = false;
    });

    // ---------- ツールバー・タブ ----------
    function toText(s, sep, range) {
        const cells = cellsOf(s);
        let firstR = 0;
        let firstC = 0;
        let lastR = -1;
        let lastC = -1;
        if (range) ({ r1: firstR, c1: firstC, r2: lastR, c2: lastC } = range);
        else {
            for (const k of Object.keys(cells)) {
                const [r, c] = k.split('_').map(Number);
                if (cells[k] !== '') { lastR = Math.max(lastR, r); lastC = Math.max(lastC, c); }
            }
        }
        const quote = (v) => (sep === ',' ? (/[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v) : (/[\t\n\r"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v));
        const lines = [];
        for (let r = firstR; r <= lastR; r++) {
            const row = [];
            for (let c = firstC; c <= lastC; c++) row.push(quote(cells[`${r}_${c}`] ?? ''));
            lines.push(row.join(sep));
        }
        return lines.join('\r\n');
    }

    panel.addEventListener('click', (e) => {
        const tab = e.target.closest('.sheet-tab[data-id]');
        if (tab) { activeId = tab.dataset.id; sel = null; lastKey = null; render(); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        const s = active();
        if (act === 'add') addSheet();
        if (!s) return;
        if (act === 'rows') write(`sheets/${s.id}`, { rows: Math.min((Number(s.rows) || DEFAULT_ROWS) + 10, MAX_ROWS) });
        else if (act === 'cols') write(`sheets/${s.id}`, { cols: Math.min((Number(s.cols) || DEFAULT_COLS) + 1, MAX_COLS) });
        else if (act === 'freeze') write(`sheets/${s.id}`, { freeze: !s.freeze });
        else if (act && act.startsWith('al-')) {
            const v = act === 'al-l' ? null : act.slice(3);
            const keys = selectedKeys();
            if (!keys.length) { whereEl.textContent = '揃えを変えるセルを選んでください。'; return; }
            write(`sheets/${s.id}/align`, Object.fromEntries(keys.map((k) => [k, v])));
        }
        else if (act === 'rename') {
            const name = prompt('シート名', s.name || '');
            if (name != null && name.trim()) write(`sheets/${s.id}`, { name: name.trim().slice(0, 30) });
        } else if (act === 'delete') {
            if (confirm(`「${s.name}」を削除しますか？${GBFCollab.inRoom ? '\nルームの全員から消えます。' : ''}`)) { activeId = null; write('sheets', { [s.id]: null }); }
        } else if (act === 'copy') {
            navigator.clipboard?.writeText(toText(s, '\t')).then(() => { whereEl.textContent = 'コピーしました。スプレッドシートにそのまま貼り付けられます。'; });
        } else if (act === 'csv') {
            const blob = new Blob(['﻿' + toText(s, ',')], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${s.name || 'sheet'}.csv`;
            a.click();
            URL.revokeObjectURL(a.href);
        }
    });

    // ---------- 置き場の切り替え ----------
    function attach(newStore) {
        if (unsub) unsub();
        store = newStore;
        sheets = {};
        builtFor = '';
        unsub = store.onValue('sheets', (v) => { sheets = v || {}; render(); });
    }
    GBFCollab.onStoreChange(attach);
    window.addEventListener('gbf-presence', renderPresence);

    // シートタブを初めて開いたとき、1枚も無ければ作る
    window.addEventListener('gbf-tab', (e) => {
        if (e.detail !== 'sheet') return;
        if (!sheetList().length) store.get('sheets').then((v) => { if (!v) addSheet('シート1'); });
    });

    // 予兆パネルの行クリックなど、外から最後に選んでいたセルへ文字を足す
    window.GBFSheet = {
        insertText(text) {
            const s = active();
            if (!s || !lastKey) { whereEl.textContent = '先に挿入したいセルをクリックしてください。'; return; }
            const input = gridEl.querySelector(`input[data-key="${lastKey}"]`);
            const cur = input ? input.value : (cellsOf(s)[lastKey] || '');
            const next = cur ? `${cur} / ${text}` : text;
            if (input) input.value = next;
            setCells(s.id, [[lastKey, next]]);
        },
    };

    attach(GBFCollab.currentStore());
})();
