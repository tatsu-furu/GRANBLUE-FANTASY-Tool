// 共有シート → Discord に貼る文章
// ・ムーブ表シート：ターンごとに「予兆」「キャラ: 行動」「その他」「メモ」の形
// ・ほかのシート：1行を「 | 」でつないだ形（1行目は太字の見出し）
// Discord の1投稿は2000文字までなので、超えるときはターン（行）の切れ目で分けてコピーできるようにする
(function () {
    'use strict';

    const LIMIT = 2000;
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const oneLine = (v) => String(v).replace(/\s*\n\s*/g, ' / ').trim();

    // ムーブ表シート → ブロック（1ターン=1ブロック）
    function moveBlocks(sh) {
        const cm = sh.colMap || {};
        const grid = sh.grid;
        const head = grid[0] || [];
        const at = (row, c) => (c != null && c >= 0 && row[c] ? oneLine(row[c].v) : '');
        const charCols = [0, 1, 2, 3].map((i) => cm[`c${i}`]).filter((c) => c != null && c >= 0);
        const names = charCols.map((c) => at(head, c) || '');
        // ページ側の let 変数なので window 経由では見えない
        const raid = typeof currentRaidTemplate !== 'undefined' && currentRaidTemplate ? currentRaidTemplate.name : '';
        const title = [`═══ ${sh.name || 'ムーブ表'} ═══`];
        if (raid) title.push(`【${raid}】`);
        const party = names.filter(Boolean);
        if (party.length) title.push(`👥 ${party.join(' / ')}`);
        const blocks = [title.join('\n')];
        for (let r = 1; r < grid.length; r++) {
            const row = grid[r];
            const acts = charCols.map((c, i) => [names[i] || `キャラ${i + 1}`, at(row, c)]).filter(([, v]) => v);
            const omen = at(row, cm.omen);
            const other = at(row, cm.other);
            const memo = at(row, cm.memo);
            if (!acts.length && !omen && !other && !memo) continue;
            const turn = at(row, cm.turn) || String(r);
            const lines = [`─── ${/^\d/.test(turn) ? `TURN ${turn}` : turn} ───`];
            if (omen) lines.push(`⚠ ${omen}`);
            acts.forEach(([n, v]) => lines.push(`${n}：${v}`));
            if (other) lines.push(`▶ ${other}`);
            if (memo) lines.push(`📝 ${memo}`);
            blocks.push(lines.join('\n'));
        }
        return blocks;
    }

    // ふつうのシート → 1行=1ブロック
    function tableBlocks(sh) {
        const blocks = [`═══ ${sh.name || 'シート'} ═══`];
        sh.grid.forEach((row, r) => {
            const vals = row.map((c) => oneLine(c.v));
            while (vals.length && !vals[vals.length - 1]) vals.pop();
            if (!vals.some(Boolean)) return;
            const line = vals.join(' | ');
            blocks.push(r === 0 && sh.freeze ? `**${line}**` : line);
        });
        return blocks;
    }

    // 2000文字に収まるよう、ブロックの切れ目で分ける
    function split(blocks) {
        const parts = [];
        let cur = '';
        for (const b of blocks) {
            const piece = b.length > LIMIT ? `${b.slice(0, LIMIT - 1)}…` : b;
            const next = cur ? `${cur}\n${piece}` : piece;
            if (next.length > LIMIT) { parts.push(cur); cur = piece; } else cur = next;
        }
        if (cur) parts.push(cur);
        return parts;
    }

    function build() {
        const [sh] = window.GBFSheet.snapshot('active');
        if (!sh || !sh.grid.length) return [];
        return split(sh.kind === 'move' ? moveBlocks(sh) : tableBlocks(sh));
    }

    const menu = document.createElement('div');
    menu.className = 'gs-menu dc-menu';
    menu.hidden = true;
    const say = (t) => { const m = menu.querySelector('.gs-msg'); if (m) m.textContent = t; };
    async function write(text) {
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    }

    async function copy(anchor) {
        const parts = build();
        if (!menu.isConnected) anchor.closest('.sheet-toolbar').after(menu);
        if (!parts.length) { menu.innerHTML = '<p class="gs-msg">シートが空です。</p>'; menu.hidden = false; return; }
        if (parts.length === 1) {
            const ok = await write(parts[0]);
            menu.innerHTML = `<p class="gs-msg">${ok ? `コピーしました（${parts[0].length}文字）。Discord にそのまま貼り付けられます。` : 'コピーできませんでした。'}</p>`;
            menu.hidden = false;
            clearTimeout(copy.t);
            copy.t = setTimeout(() => { menu.hidden = true; }, 4000);
            return;
        }
        // 2000文字を超えるときは分けてコピー
        menu.innerHTML = `<p class="gs-note">Discord の1投稿（2000文字）に収まらないので、${parts.length}回に分けてコピーしてください。</p>`
            + parts.map((p, i) => `<button class="btn" data-dc="${i}">${i + 1}/${parts.length} をコピー（${p.length}文字）</button>`).join('')
            + '<p class="gs-msg"></p>';
        menu.hidden = false;
        menu.onclick = async (e) => {
            const i = e.target.closest('[data-dc]')?.dataset.dc;
            if (i == null) return;
            const ok = await write(parts[Number(i)]);
            e.target.closest('[data-dc]').classList.toggle('done', ok);
            say(ok ? `${Number(i) + 1}/${parts.length} をコピーしました。貼り付けたら次へ。` : 'コピーできませんでした。');
        };
    }
    document.addEventListener('click', (e) => {
        if (!menu.hidden && !menu.contains(e.target) && !e.target.closest('[data-act="discord"]')) menu.hidden = true;
    });

    window.GBFDiscord = { copy, build, _split: split };
})();
