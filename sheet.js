// 共有シート（簡易スプレッドシート）。
// データは GBFCollab.currentStore() の sheets/ 以下に置く。ルーム中は全員で同期、ルーム外はこのブラウザ内だけ。
//   sheets/{id} = { name, order, rows, cols, freeze, widths: {列: px}, cells: { '行_列': 文字列 }, align: { '行_列': 'c' | 'r' },
//                   bg: { '行_列': 'r' | 'y' | 'g' | 'b' | 'p' }（セルの色）,
//                   kind: 'move' | 'omen' | なし, colMap: { 役割: 列 }, nowrap: true で折り返さない }
// セル単位で書き込むので、別々のセルなら同時に編集しても消し合わない。
// kind: 'move' は「ムーブ表シート」。1行が1ターンで、キャラごとの列がある（colMap で役割→列）。
// 編成パーツ（palette.js）から置いた行動は、その行のそのキャラの列に入る。
(function () {
    'use strict';

    const DEFAULT_ROWS = 30;
    const DEFAULT_COLS = 8;
    const MAX_ROWS = 500;
    const MAX_COLS = 52;
    const MAX_CELL = 2000;
    const COL_W = 110;
    const ACTION_SEP = ' → ';
    const BG_COLORS = ['r', 'y', 'g', 'b', 'p']; // セルの色（赤・黄・緑・青・紫）
    // ムーブ表シートの列（役割 → 列番号）
    const MOVE_COLS = { turn: 0, omen: 1, c0: 2, c1: 3, c2: 4, c3: 5, other: 6, memo: 7 };
    const CHAR_ROLE = /^c\d$/; // c0〜c8：編成の1〜9人目
    const MOVE_TURNS = 30;

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
            <button class="btn" data-act="lines" title="選んでいる行・列の前後に挿入、削除（右クリックでも開けます）">行・列の挿入・削除 ▾</button>
            <button class="btn" data-act="freeze"></button>
            <button class="btn" data-act="wrap"></button>
            <span class="sep"></span>
            <button class="btn" data-act="al-l" title="左揃え">左揃え</button>
            <button class="btn" data-act="al-c" title="中央揃え">中央</button>
            <button class="btn" data-act="al-r" title="右揃え">右揃え</button>
            <span class="sep"></span>
            <span class="sheet-colors" role="group" aria-label="セルの色">
                <button class="swatch" data-act="bg-r" title="赤" aria-label="赤"></button>
                <button class="swatch" data-act="bg-y" title="黄" aria-label="黄"></button>
                <button class="swatch" data-act="bg-g" title="緑" aria-label="緑"></button>
                <button class="swatch" data-act="bg-b" title="青" aria-label="青"></button>
                <button class="swatch" data-act="bg-p" title="紫" aria-label="紫"></button>
                <button class="swatch none" data-act="bg-x" title="色なし" aria-label="色なし">✕</button>
            </span>
            <span class="sep"></span>
            <button class="btn" data-act="copy">表をコピー</button>
            <button class="btn" data-act="gsheet">Googleスプレッドシートへ</button>
            <button class="btn" data-act="discord">Discordにコピー</button>
            <button class="btn" data-act="csv">CSVで保存</button>
            <button class="btn" data-act="rename">名前を変更</button>
            <button class="btn reset-btn" data-act="delete">シートを削除</button>
        </div>
        <p class="sheet-where"></p>
        <div class="sheet-wrap"><table class="sheet-grid"></table></div>
        <p class="sheet-move-hint" hidden>ムーブ表シート: 右の「編成パーツ」でアビをタップすると、選んでいる行（ターン）のそのキャラの列に入ります。セルへドラッグしても置けます。</p>
        <p class="sheet-hint">Googleスプレッドシートなどでコピーした範囲は、左上にしたいセルを選んで貼り付け（Ctrl+V）できます。Enterで下、Tabで右へ移動、Alt+Enter（Macは Option+Enter）でセル内改行します。Shift+クリック・Shift+矢印で範囲選択、列・行の番号をクリックで列・行ごと選択できます（揃え・Delete・コピーが範囲にかかります）。行番号・列の文字を別の行・列の真ん中へドラッグすると入れ替え、端（線が出る位置）へドラッグするとその隙間へ移動します。右クリック（スマホは「行・列の挿入・削除」）で行・列を挿入・削除できます。</p>`;
    const tabsEl = panel.querySelector('.sheet-tabs');
    const gridEl = panel.querySelector('.sheet-grid');
    const whereEl = panel.querySelector('.sheet-where');
    const freezeBtn = panel.querySelector('[data-act="freeze"]');
    const wrapBtn = panel.querySelector('[data-act="wrap"]');
    const moveHintEl = panel.querySelector('.sheet-move-hint');

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
        const icon = (k) => (k === 'move' ? '⚔ ' : k === 'omen' ? '📋 ' : '');
        tabsEl.innerHTML = list.map((s) => `<button class="sheet-tab${s.id === activeId ? ' on' : ''}" role="tab" aria-selected="${s.id === activeId}" data-id="${esc(s.id)}">${icon(s.kind)}${esc(s.name || '無題')}</button>`).join('')
            + '<button class="sheet-tab add" data-act="add" title="空のシートを追加">＋</button>'
            + '<button class="sheet-tab add" data-act="add-move" title="ムーブ表シートを追加">＋ ムーブ表</button>';
        whereEl.textContent = GBFCollab.inRoom
            ? 'ルームの全員と同期しています。'
            : 'いまはこのブラウザ内だけに保存されます。上の「ルームを作成」で共有できます。';

        const s = active();
        panel.querySelectorAll('.sheet-toolbar .btn').forEach((b) => { b.disabled = !s; });
        moveHintEl.hidden = !(s && s.kind === 'move');
        window.dispatchEvent(new CustomEvent('gbf-sheet-active', { detail: s ? { id: s.id, kind: s.kind || '', name: s.name } : null }));
        if (!s) { gridEl.innerHTML = '<tbody><tr><td class="sheet-empty">「＋」でシートを追加してください</td></tr></tbody>'; builtFor = ''; return; }
        freezeBtn.textContent = s.freeze ? '1行目の固定を解除' : '1行目を固定';
        wrapBtn.textContent = s.nowrap ? '折り返す' : '折り返さない';

        const rows = Math.min(Number(s.rows) || DEFAULT_ROWS, MAX_ROWS);
        const cols = Math.min(Number(s.cols) || DEFAULT_COLS, MAX_COLS);
        const shape = `${s.id}:${rows}:${cols}`;
        if (builtFor !== shape) {
            builtFor = shape; // 先に記録する（作り直しでフォーカスが戻る→在室更新→再描画、の再入で作り直さない）
            buildGrid(s, rows, cols);
        }
        gridEl.classList.toggle('freeze', !!s.freeze);
        gridEl.classList.toggle('nowrap', !!s.nowrap);
        applyWidths(s, cols);
        fillValues(s);
        autosizeAll();
        renderSelection();
        renderPresence();
    }

    function buildGrid(s, rows, cols) {
        const focused = document.activeElement?.closest?.('.sheet-grid') ? document.activeElement.dataset.key : null;
        let html = '<thead><tr><th class="corner"></th>';
        for (let c = 0; c < cols; c++) html += `<th class="pick" data-c="${c}"><div class="col-head"><span class="grip" draggable="true" title="ドラッグで列を入れ替え">${colName(c)}</span></div></th>`;
        html += '</tr></thead><tbody>';
        for (let r = 0; r < rows; r++) {
            html += `<tr><th class="row-head pick" data-r="${r}" draggable="true" title="ドラッグで行を入れ替え">${r + 1}</th>`;
            for (let c = 0; c < cols; c++) html += `<td><textarea class="cell" rows="1" spellcheck="false" data-key="${r}_${c}" data-r="${r}" data-c="${c}" aria-label="${colName(c)}${r + 1}"></textarea></td>`;
            html += '</tr>';
        }
        gridEl.innerHTML = html + '</tbody>';
        if (focused) gridEl.querySelector(`textarea.cell[data-key="${focused}"]`)?.focus();
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
        const bg = s.bg || {};
        gridEl.querySelectorAll('textarea.cell[data-key]').forEach((input) => {
            const v = cells[input.dataset.key] ?? '';
            if (input !== document.activeElement && input.value !== v) input.value = v;
            const a = align[input.dataset.key];
            const td = input.parentElement;
            td.classList.toggle('al-c', a === 'c');
            td.classList.toggle('al-r', a === 'r');
            const color = BG_COLORS.includes(bg[input.dataset.key]) ? bg[input.dataset.key] : '';
            if ((td.dataset.bg || '') !== color) { if (color) td.dataset.bg = color; else delete td.dataset.bg; }
        });
    }

    // ---------- 自動折り返し：行の高さを中身に合わせる ----------
    // 1行の中で一番高いセルに、その行の全セルの高さをそろえる
    function autosizeRows(rowEls) {
        const wrap = !gridEl.classList.contains('nowrap');
        const rows = [...rowEls];
        const all = rows.flatMap((tr) => [...tr.querySelectorAll('textarea.cell')]);
        all.forEach((t) => { t.style.height = ''; });
        if (!wrap) return;
        const heights = rows.map((tr) => Math.max(0, ...[...tr.querySelectorAll('textarea.cell')].map((t) => t.scrollHeight)));
        rows.forEach((tr, i) => {
            if (!heights[i]) return;
            tr.querySelectorAll('textarea.cell').forEach((t) => { if (heights[i] > t.clientHeight + 1) t.style.height = `${heights[i]}px`; });
        });
    }
    const autosizeAll = () => autosizeRows(gridEl.querySelectorAll('tbody tr'));
    const autosizeRowOf = (el) => { const tr = el?.closest('tr'); if (tr) autosizeRows([tr]); };
    window.addEventListener('resize', () => { clearTimeout(autosizeAll.t); autosizeAll.t = setTimeout(autosizeAll, 150); });
    // 隠れている間は高さを測れないので、シートタブを開いたときに測り直す
    window.addEventListener('gbf-tab', (e) => { if (e.detail === 'sheet') requestAnimationFrame(autosizeAll); });

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
        const s0 = active();
        const moveRow = s0 && s0.kind === 'move' && sel ? sel.fr : -1;
        gridEl.querySelectorAll('textarea.cell[data-key]').forEach((input) => {
            const r = Number(input.dataset.r);
            const c = Number(input.dataset.c);
            const td = input.parentElement;
            td.classList.toggle('sel', multi && r >= q.r1 && r <= q.r2 && c >= q.c1 && c <= q.c2);
            td.classList.toggle('cur', !!sel && r === sel.fr && c === sel.fc);
            td.classList.toggle('cur-row', r === moveRow && r > 0);
        });
        window.dispatchEvent(new CustomEvent('gbf-sheet-cursor', { detail: sel ? { row: sel.fr, col: sel.fc } : null }));
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
            const td = gridEl.querySelector(`textarea.cell[data-key="${p.cell}"]`)?.parentElement;
            if (!td) continue;
            td.classList.add('peer');
            td.style.setProperty('--peer', p.color || '#888');
            td.dataset.peer = p.name || '';
        }
    }

    // ---------- 入力 ----------
    const inputAt = (r, c) => gridEl.querySelector(`textarea.cell[data-r="${r}"][data-c="${c}"]`);
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
        const input = e.target.closest('textarea.cell[data-key]');
        const s = active();
        if (input && s) { setCells(s.id, [[input.dataset.key, input.value]]); autosizeRowOf(input); }
    });
    let extending = false; // Shift で範囲を広げている途中
    gridEl.addEventListener('mousedown', (e) => {
        const input = e.target.closest('textarea.cell[data-key]');
        if (input && e.shiftKey && sel) {
            e.preventDefault();
            setSel(sel.ar, sel.ac, Number(input.dataset.r), Number(input.dataset.c));
        }
    });
    gridEl.addEventListener('focusin', (e) => {
        const input = e.target.closest('textarea.cell[data-key]');
        if (!input) return;
        lastKey = input.dataset.key;
        if (!extending) setSel(Number(input.dataset.r), Number(input.dataset.c), Number(input.dataset.r), Number(input.dataset.c));
        extending = false;
        const key = `${activeId}:${input.dataset.key}`;
        if (key !== lastAnnounced) { lastAnnounced = key; GBFCollab.announce({ sheet: activeId, cell: input.dataset.key }); }
    });
    gridEl.addEventListener('keydown', (e) => {
        const input = e.target.closest('textarea.cell[data-key]');
        if (!input || e.isComposing || e.keyCode === 229) return;
        const atStart = input.selectionStart === 0 && input.selectionEnd === 0;
        const atEnd = input.selectionStart === input.value.length;
        const s = active();
        if (e.shiftKey && e.key.startsWith('Arrow')) {
            e.preventDefault();
            const d = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[e.key];
            move(input, d[0], d[1], true);
        } else if (e.key === 'Enter' && e.altKey) {
            // セル内で改行（表計算ソフトと同じ）
            e.preventDefault();
            const { selectionStart: a, selectionEnd: b, value } = input;
            input.value = value.slice(0, a) + '\n' + value.slice(b);
            input.selectionStart = input.selectionEnd = a + 1;
            input.dispatchEvent(new Event('input', { bubbles: true }));
        } else if (e.key === 'Enter') { e.preventDefault(); move(input, e.shiftKey ? -1 : 1, 0); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); move(input, 1, 0); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); move(input, -1, 0); }
        else if (e.key === 'ArrowLeft' && atStart) { e.preventDefault(); move(input, 0, -1); }
        else if (e.key === 'ArrowRight' && atEnd) { e.preventDefault(); move(input, 0, 1); }
        else if ((e.key === 'Delete' || e.key === 'Backspace') && isMulti() && s) {
            // 範囲選択中は範囲をまとめて消す
            e.preventDefault();
            const keys = selectedKeys();
            keys.forEach((k) => { const el = gridEl.querySelector(`textarea.cell[data-key="${k}"]`); if (el) el.value = ''; });
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
        const input = e.target.closest('textarea.cell[data-key]');
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
            autosizeAll();
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

    // 編成パーツのドラッグ＆ドロップ
    const TOKEN_TYPE = 'application/x-gbf-token';
    let dropTd = null;
    const clearDrop = () => { dropTd?.classList.remove('drop'); dropTd = null; };
    gridEl.addEventListener('dragover', (e) => {
        if (!e.dataTransfer?.types?.includes(TOKEN_TYPE)) return;
        const input = e.target.closest?.('textarea.cell[data-key]');
        if (!input) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (dropTd !== input.parentElement) { clearDrop(); dropTd = input.parentElement; dropTd.classList.add('drop'); }
    });
    gridEl.addEventListener('dragleave', (e) => { if (!gridEl.contains(e.relatedTarget)) clearDrop(); });
    gridEl.addEventListener('drop', (e) => {
        const raw = e.dataTransfer?.getData(TOKEN_TYPE);
        const input = e.target.closest?.('textarea.cell[data-key]');
        clearDrop();
        if (!raw || !input) return;
        e.preventDefault();
        try { GBFSheet.placeAt(Number(input.dataset.r), Number(input.dataset.c), JSON.parse(raw)); } catch (err) { console.warn(err); }
    });

    // 行・列の入れ替え（行番号・列の文字を別の行・列へドラッグ）
    const ROW_TYPE = 'application/x-gbf-row';
    const COL_TYPE = 'application/x-gbf-col';
    let swapTarget = null;
    const DROP_CLASSES = ['swap-target', 'ins-before', 'ins-after'];
    const clearSwap = () => { swapTarget?.classList.remove(...DROP_CLASSES); swapTarget = null; };
    gridEl.addEventListener('dragstart', (e) => {
        const rowHead = e.target.closest?.('th.row-head');
        const grip = e.target.closest?.('.grip');
        if (rowHead) e.dataTransfer.setData(ROW_TYPE, rowHead.dataset.r);
        else if (grip) e.dataTransfer.setData(COL_TYPE, grip.closest('th').dataset.c);
        else return;
        e.dataTransfer.effectAllowed = 'move';
    });
    // ドロップ先：行なら行番号かその行のセル、列なら列見出しかその列のセル。
    // 端（行なら上下、列なら左右の 1/4）に落とすと「その隙間へ移動」、真ん中なら「入れ替え」
    function swapHeadAt(e) {
        const types = e.dataTransfer?.types || [];
        const input = e.target.closest?.('textarea.cell[data-key]');
        let head = null;
        let kind = '';
        if (types.includes(ROW_TYPE)) {
            const r = e.target.closest?.('th.row-head')?.dataset.r ?? input?.dataset.r;
            head = r != null ? gridEl.querySelector(`th.row-head[data-r="${r}"]`) : null;
            kind = 'row';
        } else if (types.includes(COL_TYPE)) {
            const c = e.target.closest?.('th[data-c]')?.dataset.c ?? input?.dataset.c;
            head = c != null ? gridEl.querySelector(`th[data-c="${c}"]`) : null;
            kind = 'col';
        }
        if (!head) return null;
        const box = (kind === 'row' ? head : head).getBoundingClientRect();
        const pos = kind === 'row' ? (e.clientY - box.top) / box.height : (e.clientX - box.left) / box.width;
        const zone = pos < 0.25 ? 'ins-before' : pos > 0.75 ? 'ins-after' : 'swap-target';
        return { head, kind, zone };
    }
    gridEl.addEventListener('dragover', (e) => {
        const t = swapHeadAt(e);
        if (!t) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (swapTarget !== t.head || !t.head.classList.contains(t.zone)) { clearSwap(); swapTarget = t.head; t.head.classList.add(t.zone); }
    });
    gridEl.addEventListener('dragend', clearSwap);
    gridEl.addEventListener('drop', (e) => {
        const t = swapHeadAt(e);
        clearSwap();
        const s = active();
        if (!t || !s) return;
        e.preventDefault();
        const from = Number(t.kind === 'row' ? e.dataTransfer.getData(ROW_TYPE) : e.dataTransfer.getData(COL_TYPE));
        const to = Number(t.kind === 'row' ? t.head.dataset.r : t.head.dataset.c);
        if (Number.isNaN(from) || Number.isNaN(to)) return;
        if (t.zone === 'swap-target') swapLines(s, t.kind, from, to);
        else moveLine(s, t.kind, from, t.zone === 'ins-before' ? to : to + 1);
    });

    // ---------- 行・列の挿入・削除・移動 ----------
    const lineCount = (s, kind) => (kind === 'row' ? rowsOf(s) : Math.min(Number(s.cols) || DEFAULT_COLS, MAX_COLS));
    const MAX_OF = { row: MAX_ROWS, col: MAX_COLS };
    // 行（列）番号を map(旧番号) → 新番号 / null（消す）で付け替えて、まとめて書き直す
    function remapLines(s, kind, map, newCount, { keepTurn = false, patch = null } = {}) {
        const cells = cellsOf(s);
        const align = s.align || {};
        const keep = keepTurn && kind === 'row' && s.kind === 'move' ? colMapOf(s).turn : -1;
        const nc = {};
        const na = {};
        let dropped = 0;
        const move = (src, dst, k, v) => {
            const [r, c] = k.split('_').map(Number);
            if (kind === 'row' && c === keep) { dst[k] = v; return; }
            const old = kind === 'row' ? r : c;
            const nu = map(old);
            if (nu == null) return;
            if (nu >= MAX_OF[kind]) { if (src === cells && v) dropped++; return; }
            dst[kind === 'row' ? `${nu}_${c}` : `${r}_${nu}`] = v;
        };
        for (const [k, v] of Object.entries(cells)) move(cells, nc, k, v);
        for (const [k, v] of Object.entries(align)) move(align, na, k, v);
        const bgSrc = s.bg || {};
        const nb = {};
        for (const [k, v] of Object.entries(bgSrc)) move(bgSrc, nb, k, v);
        const updates = {
            cells: Object.keys(nc).length ? nc : null,
            align: Object.keys(na).length ? na : null,
            bg: Object.keys(nb).length ? nb : null,
            [kind === 'row' ? 'rows' : 'cols']: Math.max(1, Math.min(newCount, MAX_OF[kind])),
        };
        if (kind === 'col') {
            const widths = s.widths || {};
            const nw = {};
            for (const [c, w] of Object.entries(widths)) { const nu = map(Number(c)); if (nu != null && nu < MAX_COLS) nw[nu] = w; }
            updates.widths = Object.keys(nw).length ? nw : null;
            if (s.kind === 'move') {
                // ムーブ表シートは、キャラなどの役割がどの列かも付け替える（消えた列は -1）
                const cm = colMapOf(s);
                updates.colMap = Object.fromEntries(Object.entries(cm).map(([role, c]) => { const nu = c >= 0 ? map(c) : null; return [role, nu == null ? -1 : nu]; }));
            }
        }
        if (patch) patch(updates);
        // 画面は先に並べ替えておく（書き込みの反映待ちで一瞬ずれて見えないように）
        const shown = updates.cells || {};
        gridEl.querySelectorAll('textarea.cell[data-key]').forEach((el) => { if (el !== document.activeElement) el.value = shown[el.dataset.key] ?? ''; });
        write(`sheets/${s.id}`, updates);
        return dropped;
    }
    function insertLines(s, kind, at, count) {
        const n = lineCount(s, kind);
        if (n + count > MAX_OF[kind]) { whereEl.textContent = `${kind === 'row' ? '行' : '列'}はこれ以上増やせません（最大${MAX_OF[kind]}）。`; return; }
        remapLines(s, kind, (i) => (i >= at ? i + count : i), n + count);
        whereEl.textContent = kind === 'row' ? `${at + 1}行目に${count}行挿入しました。` : `${colName(at)}列に${count}列挿入しました。`;
        if (kind === 'row') setSel(at, 0, at + count - 1, lineCount(s, 'col') - 1); else setSel(0, at, rowsOf(s) - 1, at + count - 1);
    }
    function deleteLines(s, kind, from, to) {
        const n = lineCount(s, kind);
        const count = to - from + 1;
        if (count >= n) { whereEl.textContent = 'すべての行・列は削除できません。'; return; }
        const cells = cellsOf(s);
        const hasData = Object.entries(cells).some(([k, v]) => { const [r, c] = k.split('_').map(Number); const i = kind === 'row' ? r : c; return v && i >= from && i <= to; });
        const label = kind === 'row' ? `${from + 1}〜${to + 1}行目` : `${colName(from)}〜${colName(to)}列`;
        if (hasData && !confirm(`${label}を削除します。中身も消えます。よろしいですか？`)) return;
        remapLines(s, kind, (i) => (i < from ? i : i > to ? i - count : null), n - count);
        whereEl.textContent = `${label}を削除しました。`;
        sel = null;
        renderSelection();
    }
    // from の行（列）を、隙間 gap（0 = 先頭の前、n = 最後の後ろ）へ移す
    function moveLine(s, kind, from, gap) {
        const n = lineCount(s, kind);
        if (gap === from || gap === from + 1) return;
        const order = Array.from({ length: n }, (_, i) => i);
        order.splice(from, 1);
        const dest = gap > from ? gap - 1 : gap;
        order.splice(dest, 0, from);
        const newIndex = new Map(order.map((old, i) => [old, i]));
        remapLines(s, kind, (i) => newIndex.get(i) ?? i, n, { keepTurn: true });
        whereEl.textContent = kind === 'row' ? `${from + 1}行目を${dest + 1}行目へ移動しました。` : `${colName(from)}列を${colName(dest)}列へ移動しました。`;
        if (kind === 'row') setSel(dest, 0, dest, lineCount(s, 'col') - 1); else setSel(0, dest, rowsOf(s) - 1, dest);
    }

    // 右クリック／「行・列」ボタンのメニュー
    const ctxEl = document.createElement('div');
    ctxEl.className = 'sheet-ctx';
    ctxEl.hidden = true;
    document.body.appendChild(ctxEl);
    function targetRange() {
        const q = rect();
        if (q) return q;
        if (lastKey) { const [r, c] = lastKey.split('_').map(Number); return { r1: r, r2: r, c1: c, c2: c }; }
        return null;
    }
    function openCtx(x, y, only) {
        const q = targetRange();
        if (!q || !active()) { whereEl.textContent = '先に行・列（セル）を選んでください。'; return; }
        const nr = q.r2 - q.r1 + 1;
        const ncol = q.c2 - q.c1 + 1;
        const item = (act, label) => `<button data-ctx="${act}">${label}</button>`;
        let html = '';
        if (only !== 'col') html += item('row-above', `上に${nr}行挿入`) + item('row-below', `下に${nr}行挿入`) + item('row-del', `${nr}行を削除`);
        if (!only) html += '<hr>';
        if (only !== 'row') html += item('col-left', `左に${ncol}列挿入`) + item('col-right', `右に${ncol}列挿入`) + item('col-del', `${ncol}列を削除`);
        ctxEl.innerHTML = html;
        ctxEl.hidden = false;
        ctxOpenedAt = Date.now();
        const w = ctxEl.offsetWidth;
        const h = ctxEl.offsetHeight;
        ctxEl.style.left = `${Math.max(4, Math.min(x, window.innerWidth - w - 4))}px`;
        ctxEl.style.top = `${Math.max(4, Math.min(y, window.innerHeight - h - 4))}px`;
    }
    let ctxOpenedAt = 0;
    const closeCtx = () => { ctxEl.hidden = true; };
    gridEl.addEventListener('contextmenu', (e) => {
        const th = e.target.closest('th.pick');
        const input = e.target.closest('textarea.cell[data-key]');
        const s = active();
        if (!s || (!th && !input)) return;
        e.preventDefault();
        const q = rect();
        const inSel = (r, c) => q && r >= q.r1 && r <= q.r2 && c >= q.c1 && c <= q.c2;
        if (th?.dataset.r != null) {
            const r = Number(th.dataset.r);
            if (!(q && r >= q.r1 && r <= q.r2 && q.c1 === 0)) setSel(r, 0, r, lineCount(s, 'col') - 1);
            openCtx(e.clientX, e.clientY, 'row');
        } else if (th?.dataset.c != null) {
            const c = Number(th.dataset.c);
            if (!(q && c >= q.c1 && c <= q.c2 && q.r1 === 0)) setSel(0, c, rowsOf(s) - 1, c);
            openCtx(e.clientX, e.clientY, 'col');
        } else {
            const r = Number(input.dataset.r);
            const c = Number(input.dataset.c);
            if (!inSel(r, c)) { setSel(r, c, r, c); lastKey = input.dataset.key; }
            openCtx(e.clientX, e.clientY, null);
        }
    });
    ctxEl.addEventListener('click', (e) => {
        const act = e.target.closest('[data-ctx]')?.dataset.ctx;
        const s = active();
        const q = targetRange();
        closeCtx();
        if (!act || !s || !q) return;
        const nr = q.r2 - q.r1 + 1;
        const ncol = q.c2 - q.c1 + 1;
        if (act === 'row-above') insertLines(s, 'row', q.r1, nr);
        else if (act === 'row-below') insertLines(s, 'row', q.r2 + 1, nr);
        else if (act === 'row-del') deleteLines(s, 'row', q.r1, q.r2);
        else if (act === 'col-left') insertLines(s, 'col', q.c1, ncol);
        else if (act === 'col-right') insertLines(s, 'col', q.c2 + 1, ncol);
        else if (act === 'col-del') deleteLines(s, 'col', q.c1, q.c2);
    });
    document.addEventListener('pointerdown', (e) => { if (!ctxEl.hidden && !ctxEl.contains(e.target)) closeCtx(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCtx(); });
    // 開いた直後のスクロール（要素を見える位置へ寄せたときなど）では閉じない
    window.addEventListener('scroll', () => { if (Date.now() - ctxOpenedAt > 300) closeCtx(); }, true);

    // 2つの行（列）の中身・揃え（列なら幅と、ムーブ表シートの役割）をまとめて入れ替える
    function swapLines(s, kind, a, b) {
        if (a === b) return;
        const cells = cellsOf(s);
        const align = s.align || {};
        const n = kind === 'row' ? Math.min(Number(s.cols) || DEFAULT_COLS, MAX_COLS) : rowsOf(s);
        const key = (line, i) => (kind === 'row' ? `${line}_${i}` : `${i}_${line}`);
        const updates = {};
        // ムーブ表シートの行を入れ替えるときは、ターン番号の列はそのまま（中身だけ入れ替える）
        const keepCol = kind === 'row' && s.kind === 'move' ? colMapOf(s).turn : -1;
        for (let i = 0; i < n; i++) {
            if (i === keepCol) continue;
            const ka = key(a, i);
            const kb = key(b, i);
            if ((cells[ka] ?? '') !== (cells[kb] ?? '')) { updates[`cells/${ka}`] = cells[kb] ?? null; updates[`cells/${kb}`] = cells[ka] ?? null; }
            if ((align[ka] ?? '') !== (align[kb] ?? '')) { updates[`align/${ka}`] = align[kb] ?? null; updates[`align/${kb}`] = align[ka] ?? null; }
            const bgm = s.bg || {};
            if ((bgm[ka] ?? '') !== (bgm[kb] ?? '')) { updates[`bg/${ka}`] = bgm[kb] ?? null; updates[`bg/${kb}`] = bgm[ka] ?? null; }
        }
        if (kind === 'col') {
            const widths = s.widths || {};
            updates[`widths/${a}`] = widths[b] ?? null;
            updates[`widths/${b}`] = widths[a] ?? null;
            if (s.kind === 'move') {
                const cm = colMapOf(s);
                for (const [role, c] of Object.entries(cm)) {
                    if (c === a) updates[`colMap/${role}`] = b;
                    else if (c === b) updates[`colMap/${role}`] = a;
                }
            }
        }
        // 画面は先に入れ替えておく（書き込みの反映待ちで一瞬戻らないように）
        for (const [k, v] of Object.entries(updates)) {
            if (!k.startsWith('cells/')) continue;
            const el = gridEl.querySelector(`textarea.cell[data-key="${k.slice(6)}"]`);
            if (el) el.value = v ?? '';
        }
        write(`sheets/${s.id}`, updates);
        whereEl.textContent = kind === 'row' ? `${a + 1}行目と${b + 1}行目を入れ替えました。` : `${colName(a)}列と${colName(b)}列を入れ替えました。`;
        if (kind === 'row') setSel(b, 0, b, n - 1); else setSel(0, b, rowsOf(s) - 1, b);
    }

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
        if (act === 'add-move') { if (window.GBFPalette) GBFPalette.createMoveSheet(); else GBFSheet.createMoveSheet(); return; }
        if (!s) return;
        if (act === 'rows') write(`sheets/${s.id}`, { rows: Math.min((Number(s.rows) || DEFAULT_ROWS) + 10, MAX_ROWS) });
        else if (act === 'cols') write(`sheets/${s.id}`, { cols: Math.min((Number(s.cols) || DEFAULT_COLS) + 1, MAX_COLS) });
        else if (act === 'freeze') write(`sheets/${s.id}`, { freeze: !s.freeze });
        else if (act === 'lines') { const b = e.target.closest('[data-act]').getBoundingClientRect(); openCtx(b.left, b.bottom + 4, null); }
        else if (act === 'wrap') write(`sheets/${s.id}`, { nowrap: s.nowrap ? null : true });
        else if (act && act.startsWith('al-')) {
            const v = act === 'al-l' ? null : act.slice(3);
            const keys = selectedKeys();
            if (!keys.length) { whereEl.textContent = '揃えを変えるセルを選んでください。'; return; }
            write(`sheets/${s.id}/align`, Object.fromEntries(keys.map((k) => [k, v])));
        }
        else if (act && act.startsWith('bg-')) {
            const v = act === 'bg-x' ? null : act.slice(3);
            const keys = selectedKeys();
            if (!keys.length) { whereEl.textContent = '色を付けるセルを選んでください。'; return; }
            write(`sheets/${s.id}/bg`, Object.fromEntries(keys.map((k) => [k, v])));
        }
        else if (act === 'rename') {
            const name = prompt('シート名', s.name || '');
            if (name != null && name.trim()) write(`sheets/${s.id}`, { name: name.trim().slice(0, 30) });
        } else if (act === 'delete') {
            if (confirm(`「${s.name}」を削除しますか？${GBFCollab.inRoom ? '\nルームの全員から消えます。' : ''}`)) { activeId = null; write('sheets', { [s.id]: null }); }
        } else if (act === 'copy') {
            navigator.clipboard?.writeText(toText(s, '\t')).then(() => { whereEl.textContent = 'コピーしました。スプレッドシートにそのまま貼り付けられます。'; });
        } else if (act === 'discord') {
            window.GBFDiscord?.copy(e.target.closest('[data-act]'));
        } else if (act === 'gsheet') {
            window.GBFGSheets?.toggle(e.target.closest('[data-act]'));
        } else if (act === 'csv') {
            const blob = new Blob(['﻿' + toText(s, ',')], { type: 'text/csv' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${s.name || 'sheet'}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
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

    // ---------- 外から使う入口（編成パーツ・予兆パネル） ----------
    function appendCell(s, r, c, text, sep) {
        const key = `${r}_${c}`;
        const input = gridEl.querySelector(`textarea.cell[data-key="${key}"]`);
        const cur = input && input === document.activeElement ? input.value : (cellsOf(s)[key] || '');
        const next = cur ? `${cur}${sep}${text}` : text;
        if (input) { input.value = next; autosizeRowOf(input); }
        return setCells(s.id, [[key, next]]);
    }
    const rowsOf = (s) => Math.min(Number(s.rows) || DEFAULT_ROWS, MAX_ROWS);
    const colMapOf = (s) => ({ ...MOVE_COLS, ...(s.colMap || {}) });
    // ムーブ表シートで「いまの行」。未選択なら行動が空の最初のターン行
    function currentMoveRow(s) {
        // 1行だけ選んでいるときはその行。列ごと選択などで複数行のときは、行動が空の最初のターン行
        if (sel && sel.fr > 0 && sel.ar === sel.fr) return sel.fr;
        const cm = colMapOf(s);
        const cells = cellsOf(s);
        const actionCols = Object.entries(cm).filter(([k, c]) => (CHAR_ROLE.test(k) || k === 'other') && c >= 0).map(([, c]) => c);
        for (let r = 1; r < rowsOf(s); r++) if (actionCols.every((c) => !cells[`${r}_${c}`])) return r;
        return 1;
    }
    function moveCursor(r, c) {
        setSel(r, c, r, c);
        lastKey = `${r}_${c}`;
        inputAt(r, c)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    // item = { role: 'c0'..'c8' | 'summon' | 'common', label: 'アビ名', full: '[キャラ] アビ名' }
    function columnFor(s, role) {
        const cm = colMapOf(s);
        if (CHAR_ROLE.test(role) && cm[role] != null && cm[role] >= 0) return cm[role];
        return cm.other >= 0 ? cm.other : 0;
    }
    // そのキャラ自身の列に入るときだけ名前を省く
    const textFor = (s, c, item) => (s.kind === 'move' && CHAR_ROLE.test(item.role) && colMapOf(s)[item.role] === c ? item.label : item.full);

    function createSheet(def) {
        const list = sheetList();
        const id = newId();
        const order = list.length ? Math.max(...list.map((x) => x.order || 0)) + 1 : 1;
        activeId = id;
        sel = null;
        lastKey = null;
        return write('sheets', { [id]: { order, freeze: true, ...def } });
    }

    // 書き出し用：シートの中身（使っている範囲まで）
    function snapshot(s) {
        const cells = cellsOf(s);
        let lastR = -1;
        let lastC = -1;
        const bgm = s.bg || {};
        // 文字のあるセルと、色だけ付いたセルの両方が入る範囲
        for (const k of [...Object.keys(cells).filter((x) => cells[x] !== ''), ...Object.keys(bgm).filter((x) => BG_COLORS.includes(bgm[x]))]) {
            const [r, c] = k.split('_').map(Number);
            lastR = Math.max(lastR, r);
            lastC = Math.max(lastC, c);
        }
        const align = s.align || {};
        const widths = s.widths || {};
        const grid = [];
        for (let r = 0; r <= lastR; r++) {
            const row = [];
            for (let c = 0; c <= lastC; c++) row.push({ v: cells[`${r}_${c}`] ?? '', a: align[`${r}_${c}`] || 'l', bg: BG_COLORS.includes(bgm[`${r}_${c}`]) ? bgm[`${r}_${c}`] : '' });
            grid.push(row);
        }
        return {
            name: s.name || 'シート',
            kind: s.kind || '',
            colMap: s.kind === 'move' ? colMapOf(s) : null,
            freeze: !!s.freeze,
            wrap: !s.nowrap,
            widths: Array.from({ length: lastC + 1 }, (_, c) => Number(widths[c]) || COL_W),
            grid,
        };
    }

    window.GBFSheet = {
        snapshot(which = 'active') {
            if (which === 'all') return sheetList().map((x) => snapshot(sheets[x.id] ? { id: x.id, ...sheets[x.id] } : x));
            const s = active();
            return s ? [snapshot(s)] : [];
        },
        get active() {
            const s = active();
            if (!s) return null;
            const row = s.kind === 'move' ? currentMoveRow(s) : sel?.fr ?? null;
            const turn = s.kind === 'move' ? cellsOf(s)[`${row}_${colMapOf(s).turn}`] || '' : '';
            return { id: s.id, kind: s.kind || '', name: s.name, row, turn };
        },

        // 編成パーツをタップしたとき
        place(item) {
            const s = active();
            if (!s) { whereEl.textContent = '先にシートを選んでください。'; return false; }
            if (s.kind === 'move') {
                const r = currentMoveRow(s);
                const c = columnFor(s, item.role);
                appendCell(s, r, c, textFor(s, c, item), ACTION_SEP);
                moveCursor(r, c);
                return true;
            }
            if (!lastKey) { whereEl.textContent = '先に置きたいセルをクリックしてください。'; return false; }
            const [r, c] = lastKey.split('_').map(Number);
            appendCell(s, r, c, item.full, ACTION_SEP);
            return true;
        },
        // セルへドロップしたとき
        placeAt(r, c, item) {
            const s = active();
            if (!s) return;
            appendCell(s, r, c, textFor(s, c, item), ACTION_SEP);
            moveCursor(r, c);
        },
        // ムーブ表シートで行（ターン）を進める・戻す
        stepRow(d) {
            const s = active();
            if (!s) return;
            const r = Math.max(1, Math.min(rowsOf(s) - 1, (s.kind === 'move' ? currentMoveRow(s) : sel?.fr ?? 0) + d));
            if (r >= rowsOf(s) - 1 && d > 0) write(`sheets/${s.id}`, { rows: Math.min(rowsOf(s) + 10, MAX_ROWS) });
            moveCursor(r, sel ? sel.fc : colMapOf(s).c0);
        },
        // 予兆一覧の行クリック
        insertOmen(o) {
            const s = active();
            if (!s) { whereEl.textContent = '先にシートを選んでください。'; return; }
            if (s.kind === 'move' && colMapOf(s).omen >= 0) {
                const r = currentMoveRow(s);
                const c = colMapOf(s).omen;
                const clear = o.clear && !/なし/.test(o.clear) ? `（${o.clear}）` : '';
                appendCell(s, r, c, `${o.name}${clear}`, ' / ');
                moveCursor(r, c);
                return;
            }
            if (!lastKey) { whereEl.textContent = '先に挿入したいセルをクリックしてください。'; return; }
            const [r, c] = lastKey.split('_').map(Number);
            appendCell(s, r, c, o.memo, ' / ');
        },
        // 旧来の文字挿入（互換用）
        insertText(text) {
            const s = active();
            if (!s || !lastKey) { whereEl.textContent = '先に挿入したいセルをクリックしてください。'; return; }
            const [r, c] = lastKey.split('_').map(Number);
            appendCell(s, r, c, text, ' / ');
        },

        // ムーブ表シートを作る。count = キャラの人数（前衛4＋サブ）。turns にムーブ表タブの内容を渡すと書き写す
        createMoveSheet({ names = [], count = 4, turns = null, name } = {}) {
            const n = Math.max(1, Math.min(9, count));
            const cm = { turn: 0, omen: 1, other: 2 + n, memo: 3 + n };
            for (let i = 0; i < n; i++) cm[`c${i}`] = 2 + i;
            const cells = {};
            const align = {};
            const head = ['ターン', '予兆・HP', ...Array.from({ length: n }, (_, i) => names[i] || (i === 0 ? '主人公' : i < 4 ? `キャラ${i + 1}` : `サブ${i - 3}`)), '召喚・その他', 'メモ'];
            head.forEach((h, c) => { cells[`0_${c}`] = h; align[`0_${c}`] = 'c'; });
            let r = 1;
            const put = (c, v) => { if (v) cells[`${r}_${c}`] = String(v).slice(0, MAX_CELL); };
            if (turns && turns.length) {
                turns.forEach((t) => {
                    t.branches.forEach((b, bi) => {
                        put(cm.turn, t.branches.length > 1 ? `${t.turnNumber}-${String.fromCharCode(65 + bi)}` : t.turnNumber);
                        align[`${r}_${cm.turn}`] = 'c';
                        const byCol = {};
                        b.cells.forEach(([role, text]) => { const c = CHAR_ROLE.test(role) && cm[role] != null ? cm[role] : cm.other; (byCol[c] ||= []).push(text); });
                        Object.entries(byCol).forEach(([c, arr]) => put(Number(c), arr.join(ACTION_SEP)));
                        put(cm.memo, b.memo);
                        r++;
                    });
                });
            }
            // 書き写した後ろは、続きのターン番号だけ入れた空行
            const rows = Math.max(r + 10, MOVE_TURNS + 1);
            const lastTurn = turns && turns.length ? Number(turns[turns.length - 1].turnNumber) || 0 : 0;
            for (let rr = r; rr < rows; rr++) {
                cells[`${rr}_${cm.turn}`] = String(lastTurn + (rr - r) + 1);
                align[`${rr}_${cm.turn}`] = 'c';
            }
            const widths = { 0: 56, 1: 200, [cm.other]: 170, [cm.memo]: 200 };
            for (let i = 0; i < n; i++) widths[2 + i] = i < 4 ? 150 : 130;
            return createSheet({ name: (name || 'ムーブ表').slice(0, 30), kind: 'move', colMap: cm, rows, cols: 4 + n, cells, align, widths });
        },
        // キャラ列を今の編成に合わせる：見出しの名前を直し、足りないキャラの列は「召喚・その他」の前に足す
        syncMoveHeader(names, count = 4) {
            const s = active();
            if (!s || s.kind !== 'move') return;
            const cm = colMapOf(s);
            const n = Math.max(1, Math.min(9, count));
            const missing = [];
            for (let i = 0; i < n; i++) if (!(cm[`c${i}`] >= 0)) missing.push(i);
            const label = (i) => names[i] || (i === 0 ? '主人公' : i < 4 ? `キャラ${i + 1}` : `サブ${i - 3}`);
            if (!missing.length) {
                setCells(s.id, Array.from({ length: n }, (_, i) => [`0_${cm[`c${i}`]}`, label(i)]));
                whereEl.textContent = 'キャラ列の見出しを今の編成に合わせました。';
                return;
            }
            const cols = lineCount(s, 'col');
            const k = missing.length;
            if (cols + k > MAX_COLS) { whereEl.textContent = '列がいっぱいで追加できません。'; return; }
            const at = cm.other >= 0 ? cm.other : cols;
            remapLines(s, 'col', (i) => (i >= at ? i + k : i), cols + k, {
                patch: (u) => {
                    u.cells ||= {};
                    u.align ||= {};
                    u.widths ||= {};
                    u.colMap ||= {};
                    for (let i = 0; i < n; i++) {
                        const c = cm[`c${i}`];
                        if (c >= 0) u.cells[`0_${c >= at ? c + k : c}`] = label(i);
                    }
                    missing.forEach((i, j) => {
                        const c = at + j;
                        u.colMap[`c${i}`] = c;
                        u.cells[`0_${c}`] = label(i);
                        u.align[`0_${c}`] = 'c';
                        u.widths[c] = 130;
                    });
                },
            });
            whereEl.textContent = `${missing.map(label).join('・')}の列を追加しました。`;
        },
        // 予兆一覧をまとめてシートにする
        createOmenSheet(raid) {
            const cells = {};
            const align = {};
            const head = ['条件', '予兆名', '解除条件', '備考', '動き方', '担当', '済'];
            head.forEach((h, c) => { cells[`0_${c}`] = h; align[`0_${c}`] = 'c'; });
            let r = 1;
            const row = (vals) => { vals.forEach((v, c) => { if (v) cells[`${r}_${c}`] = String(v).slice(0, MAX_CELL); }); align[`${r}_6`] = 'c'; r++; };
            // シートでは HP ごとの見出し行を入れず、上から順に続けて並べる（CT 特殊技はどの HP 帯かを条件に書く）
            raid.phases.forEach((p) => {
                p.triggers.forEach((t) => row([t.condition, t.name, t.clear, t.note || '']));
                (p.ctSpecials || []).forEach((ct) => row([p.ctLabel || `CT（${p.range}）`, ct.name, ct.clear, ct.note || '']));
            });
            const widths = { 0: 110, 1: 150, 2: 200, 3: 260, 4: 260, 5: 90, 6: 44 };
            return createSheet({ name: `予兆: ${raid.name}`.slice(0, 30), kind: 'omen', rows: Math.max(r + 5, 20), cols: 7, cells, align, widths });
        },
    };

    attach(GBFCollab.currentStore());
})();
