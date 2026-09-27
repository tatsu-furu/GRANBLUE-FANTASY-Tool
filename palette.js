// 右パネルの「編成パーツ」。編成（キャラ・アビ・召喚石）をチップにして、
// - 共有シートを開いているとき: タップで選んでいる行（ムーブ表シートならそのキャラの列）に置く／セルへドラッグで置く
// - ムーブ表タブの入力画面のとき: タップでその行動を記録する（今までのボタンと同じ動き）
(function () {
    'use strict';

    const root = document.getElementById('party-palette');
    if (!root) return;
    const TOKEN_TYPE = 'application/x-gbf-token';
    const COMMON = [
        { label: '攻撃（奥義ON）', action: '攻撃 (奥義ON)' },
        { label: '攻撃（奥義OFF）', action: '攻撃 (奥義OFF)' },
        { label: 'オールポーション', action: 'オールポーション' },
        { label: 'FC', action: 'FC' },
    ];

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const defaultName = (i) => (i === 0 ? '主人公' : i < 4 ? `キャラ${i + 1}` : `サブ${i - 3}`);
    const nameOf = (setup, i) => (setup.characters?.[i] || '').trim() || defaultName(i);

    // いまの編成からチップの一覧を作る
    function partyItems() {
        const setup = currentWorkData.setup;
        const count = 4 + (Number(setup.subCount) || 2);
        const chars = [];
        for (let i = 0; i < count; i++) {
            const name = nameOf(setup, i);
            const abis = [0, 1, 2, 3].map((k) => ({ k, label: (setup.characterAbilities?.[i]?.[k] || '').trim() || `${k + 1}アビ` }));
            const items = [
                ...abis.map((a) => ({ role: `c${i}`, label: a.label, full: `[${name}] ${a.label}`, move: { char: i, abi: a.k } })),
                { role: `c${i}`, label: 'ガード', full: `[${name}] ガード`, move: { char: i, action: 'ガード' } },
                { role: `c${i}`, label: 'キュアポ', full: `[${name}] キュアポ`, move: { char: i, action: 'キュアポ' } },
            ];
            chars.push({ i, name, icon: setup.characterIcons?.[i] || null, sub: i >= 4, items });
        }
        const summons = (setup.summons || []).filter((x) => x && x.trim()).map((x) => ({ role: 'summon', label: x, full: `召喚: ${x}`, move: { summon: x } }));
        const common = COMMON.map((c) => ({ role: 'common', label: c.label, full: c.label, move: { action: c.action } }));
        return { chars, summons, common };
    }

    let items = [];
    let lastKey = '';
    function render(force = false) {
        const { chars, summons, common } = partyItems();
        const key = JSON.stringify([chars.map((c) => [c.name, c.icon ? c.icon.length : 0, c.items.map((x) => x.label)]), summons.map((x) => x.label)]);
        if (!force && key === lastKey) { renderStatus(); return; }
        lastKey = key;
        items = [];
        const chip = (item, extra = '') => { items.push(item); return `<button class="chip${extra}" draggable="true" data-i="${items.length - 1}" title="${esc(item.full)}">${esc(item.label)}</button>`; };
        root.innerHTML = `
            <div class="pal-status"></div>
            ${chars.map((c) => `
                <section class="pal-char${c.sub ? ' sub' : ''}">
                    <h4>${c.icon ? `<img src="${esc(c.icon)}" alt="">` : ''}<span>${esc(c.name)}</span>${c.sub ? '<small>サブ</small>' : ''}</h4>
                    <div class="chips">${c.items.map((it, k) => chip(it, k >= 4 ? ' minor' : '')).join('')}</div>
                </section>`).join('')}
            <section class="pal-char"><h4><span>召喚石</span></h4><div class="chips">${summons.length ? summons.map((it) => chip(it, ' summon')).join('') : '<span class="pal-empty">編成で召喚石を登録すると出ます</span>'}</div></section>
            <section class="pal-char"><h4><span>ターン終了・アイテム</span></h4><div class="chips">${common.map((it) => chip(it, ' common')).join('')}</div></section>
            <p class="pal-foot">キャラ名・アビ名・召喚石は「ムーブ表」タブの編成登録で変えられます（ルーム中は全員に反映）。</p>`;
        renderStatus();
    }

    // 上部：いまの置き先と、ターン送り・ムーブ表シートの作成
    function renderStatus() {
        const box = root.querySelector('.pal-status');
        if (!box) return;
        const tab = document.body.dataset.tab || 'move';
        const sheet = window.GBFSheet?.active;
        if (tab !== 'sheet') {
            const inMove = movePhase.style.display === 'block' && !movePhase.classList.contains('playback-mode');
            box.innerHTML = inMove
                ? '<p>タップでムーブ表に記録します（キャラは自動で切り替わります）。</p>'
                : '<p>「共有シート」タブのムーブ表シートか、ムーブ入力画面で使えます。</p>';
            return;
        }
        if (!sheet) { box.innerHTML = '<p>シートを選んでください。</p>'; return; }
        if (sheet.kind === 'move') {
            box.innerHTML = `
                <div class="pal-turn">
                    <button class="btn" data-pal="up" aria-label="前の行へ">↑</button>
                    <span>置き先: <strong>${sheet.row}行目</strong></span>
                    <button class="btn pal-next" data-pal="down">次のターン ↓</button>
                </div>
                <p>チップをタップ → この行のそのキャラの列へ。セルへドラッグでも置けます。</p>
                <button class="btn pal-small" data-pal="sync-head">見出しのキャラ名を今の編成に合わせる</button>`;
        } else {
            box.innerHTML = `
                <p>タップで選んでいるセルに追加、またはセルへドラッグ。</p>
                <button class="btn pal-small" data-pal="new-move">＋ ムーブ表シートを作る</button>`;
        }
    }

    // ムーブ表タブの内容をシート用に読み替える
    function turnsFromMoveTab() {
        const setup = currentWorkData.setup;
        const names = Array.from({ length: 9 }, (_, i) => nameOf(setup, i));
        const turns = currentWorkData.state.turns
            .map((t) => ({
                turnNumber: t.turnNumber,
                branches: t.branches.map((b) => ({
                    memo: b.memo || '',
                    cells: b.actions.map((a) => {
                        const m = a.match(/^\[(.+?)\]\s*(.*)$/);
                        if (!m) return ['other', a];
                        if (!m[2]) return ['other', m[1].replace(/^召喚:\s*/, '召喚: ')];
                        const i = names.indexOf(m[1]);
                        return i >= 0 && i < 4 ? [`c${i}`, m[2]] : ['other', a];
                    }),
                })),
            }))
            .filter((t) => t.branches.some((b) => b.cells.length || b.memo));
        return { names, turns };
    }

    function createMoveSheet() {
        const { names, turns } = turnsFromMoveTab();
        const useTurns = turns.length > 0 && confirm(`ムーブ表タブの内容（${turns.length}ターン分）を書き写しますか？\nキャンセルすると空のムーブ表シートを作ります。`);
        window.GBFSheet.createMoveSheet({ names, turns: useTurns ? turns : null });
    }
    window.GBFPalette = { createMoveSheet, render };

    // ムーブ表タブ（入力画面）で押したとき：既存のボタンを押したのと同じにする
    function doMoveAction(item) {
        const m = item.move;
        if (m.char != null) {
            selectCharacter(m.char);
            const btn = m.abi != null ? document.getElementById(`abi-btn-${m.abi}`) : document.querySelector(`.action-panel .action-btn[data-action="${m.action}"]`);
            btn?.click();
        } else if (m.summon) {
            [...document.querySelectorAll('.summon-btn')].find((b) => b.textContent === m.summon)?.click();
        } else if (m.action) {
            document.querySelector(`.action-panel .action-btn[data-action="${m.action}"]`)?.click();
        }
    }

    root.addEventListener('click', (e) => {
        const pal = e.target.closest('[data-pal]')?.dataset.pal;
        if (pal === 'up') window.GBFSheet?.stepRow(-1);
        else if (pal === 'down') window.GBFSheet?.stepRow(1);
        else if (pal === 'new-move') createMoveSheet();
        else if (pal === 'sync-head') window.GBFSheet?.syncMoveHeader([0, 1, 2, 3].map((i) => nameOf(currentWorkData.setup, i)));
        if (pal) return;

        const chipEl = e.target.closest('.chip[data-i]');
        if (!chipEl) return;
        const item = items[Number(chipEl.dataset.i)];
        const tab = document.body.dataset.tab || 'move';
        let ok = false;
        if (tab === 'sheet') ok = window.GBFSheet?.place(item);
        else if (movePhase.style.display === 'block' && !movePhase.classList.contains('playback-mode')) { doMoveAction(item); ok = true; }
        if (ok) { chipEl.classList.add('flash'); setTimeout(() => chipEl.classList.remove('flash'), 250); }
    });
    root.addEventListener('dragstart', (e) => {
        const chipEl = e.target.closest('.chip[data-i]');
        if (!chipEl) return;
        const item = items[Number(chipEl.dataset.i)];
        e.dataTransfer.setData(TOKEN_TYPE, JSON.stringify({ role: item.role, label: item.label, full: item.full }));
        e.dataTransfer.setData('text/plain', item.full);
        e.dataTransfer.effectAllowed = 'copy';
    });

    ['gbf-work-changed', 'gbf-tab'].forEach((ev) => window.addEventListener(ev, () => render()));
    ['gbf-sheet-active', 'gbf-sheet-cursor'].forEach((ev) => window.addEventListener(ev, renderStatus));
    render(true);
})();
