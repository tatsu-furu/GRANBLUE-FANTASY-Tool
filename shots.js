// スクショ置き場。ルームの全員で所持キャラ・編成などのスクショを置いて見られる。
//   shots/{id}    = { title, by, at, w, h, thumb }   … 一覧用（小さいサムネイル込み）
//   shotData/{id} = 'data:image/jpeg;base64,…'       … 本体。開いたときだけ読む
// 画像はブラウザ内で縮小・JPEG にしてから置く（Realtime Database の容量・転送量を抑えるため）。
(function () {
    'use strict';

    const panel = document.getElementById('shots-panel');
    if (!panel || !window.GBFCollab) return;

    const FULL_MAX_W = 1600;
    const FULL_MAX_CHARS = 1400000; // rules の上限（1.5M 文字）より少し下
    const THUMB_W = 360;
    const THUMB_MAX_CHARS = 80000; // rules の上限（10万文字）より下

    // ルームの外では、このブラウザの IndexedDB に置く（サーバーは使わない）。
    // ルームと同じ形（onValue / update / get）で使えるようにしておく
    function createLocalShotStore() {
        let dbp = null;
        const open = () => (dbp ||= new Promise((resolve, reject) => {
            const req = indexedDB.open('gbfLocalShots', 1);
            req.onupgradeneeded = () => { req.result.createObjectStore('shots'); req.result.createObjectStore('shotData'); };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        }));
        const tx = async (names, mode, fn) => {
            const db = await open();
            return new Promise((resolve, reject) => {
                const t = db.transaction(names, mode);
                const out = fn(t);
                t.oncomplete = () => resolve(out && 'result' in out ? out.result : undefined);
                t.onerror = () => reject(t.error);
            });
        };
        const readAll = (name) => tx([name], 'readonly', (t) => {
            const res = { result: {} };
            const req = t.objectStore(name).openCursor();
            req.onsuccess = () => { const c = req.result; if (c) { res.result[c.key] = c.value; c.continue(); } };
            return res;
        });
        const listeners = new Set();
        const notify = async () => { const v = await readAll('shots'); listeners.forEach((cb) => cb(v)); };
        return {
            kind: 'local-shots',
            onValue(path, cb) { listeners.add(cb); readAll('shots').then(cb).catch(() => cb({})); return () => listeners.delete(cb); },
            async update(path, updates) {
                await tx(['shots', 'shotData'], 'readwrite', (t) => {
                    for (const [k, v] of Object.entries(updates)) {
                        const [name, id, field] = (path ? `${path}/${k}` : k).split('/');
                        const os = t.objectStore(name);
                        if (field) { const g = os.get(id); g.onsuccess = () => { if (g.result) os.put({ ...g.result, [field]: v }, id); }; }
                        else if (v == null) os.delete(id);
                        else os.put(v, id);
                    }
                });
                notify();
            },
            async get(path) {
                const [name, id] = path.split('/');
                if (!id) return readAll(name);
                return tx([name], 'readonly', (t) => { const res = { result: null }; const g = t.objectStore(name).get(id); g.onsuccess = () => { res.result = g.result ?? null; }; return res; });
            },
        };
    }
    let localShots = null;
    const shotStore = () => (GBFCollab.inRoom ? GBFCollab.currentStore() : (localShots ||= createLocalShotStore()));

    let store = null;
    let unsub = null;
    let shots = {};
    let filter = '';
    const fullCache = new Map();

    panel.innerHTML = `
        <div class="shots-drop" tabindex="0" role="button" aria-label="スクショを追加">
            <input type="file" accept="image/*" multiple hidden>
            <strong>スクショを追加</strong>
            <span>クリックで選択（複数可）・ドラッグ＆ドロップ・このタブで Ctrl+V</span>
        </div>
        <p class="shots-where"></p>
        <div class="shots-bar">
            <label>表示 <select class="shots-filter"></select></label>
            <span class="shots-msg"></span>
        </div>
        <div class="shots-grid"></div>
        <div class="shots-view" hidden>
            <div class="shots-view-inner">
                <div class="shots-view-head">
                    <span class="shots-view-title"></span>
                    <a class="btn shots-dl" download>保存</a>
                    <button class="btn shots-close" aria-label="閉じる">✕</button>
                </div>
                <button class="shots-nav prev" aria-label="前へ">‹</button>
                <img alt="">
                <button class="shots-nav next" aria-label="次へ">›</button>
            </div>
        </div>`;
    const dropEl = panel.querySelector('.shots-drop');
    const fileEl = dropEl.querySelector('input[type=file]');
    const gridEl = panel.querySelector('.shots-grid');
    const msgEl = panel.querySelector('.shots-msg');
    const whereEl = panel.querySelector('.shots-where');
    const filterEl = panel.querySelector('.shots-filter');
    const viewEl = panel.querySelector('.shots-view');
    const viewImg = viewEl.querySelector('img');

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const list = () => Object.entries(shots)
        .filter(([, s]) => s && typeof s === 'object')
        .map(([id, s]) => ({ id, ...s }))
        .sort((a, b) => (b.at || 0) - (a.at || 0));
    const visible = () => list().filter((s) => !filter || s.by === filter);
    const say = (t) => { msgEl.textContent = t; };

    // ---------- 画像の縮小 ----------
    const loadImage = (file) => new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
        img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読めませんでした')); };
        img.src = url;
    });
    function encode(img, maxW, quality, maxH = Infinity) {
        const scale = Math.min(1, maxW / img.naturalWidth, maxH / img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.naturalWidth * scale);
        canvas.height = Math.round(img.naturalHeight * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        return { data: canvas.toDataURL('image/jpeg', quality), w: canvas.width, h: canvas.height };
    }
    function encodeFull(img) {
        // 上限に収まるまで画質→大きさの順に下げる
        for (const [w, q] of [[FULL_MAX_W, 0.8], [FULL_MAX_W, 0.65], [1280, 0.65], [1024, 0.6], [800, 0.55]]) {
            const out = encode(img, w, q);
            if (out.data.length <= FULL_MAX_CHARS) return out;
        }
        return null;
    }

    async function addFiles(files) {
        const images = [...files].filter((f) => f.type.startsWith('image/'));
        if (!images.length) return;
        let done = 0;
        for (const file of images) {
            say(`追加中… ${done + 1}/${images.length}`);
            try {
                const img = await loadImage(file);
                const full = encodeFull(img);
                if (!full) { say(`「${file.name}」は大きすぎて置けませんでした`); continue; }
                // サムネイルは縦長のスクショでも上限に収まるよう、縦横とも抑えて画質を下げていく
                let thumb = null;
                for (const [w, q] of [[THUMB_W, 0.6], [THUMB_W, 0.45], [280, 0.45], [200, 0.4]]) {
                    thumb = encode(img, w, q, w * 1.4);
                    if (thumb.data.length <= THUMB_MAX_CHARS) break;
                }
                const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
                const base = (file.name || '').replace(/\.[^.]+$/, '');
                const title = (/^(image|pasted_image|スクリーンショット|Screenshot)/i.test(base) || !base) ? `${GBFCollab.myName || 'ななし'}のスクショ` : base;
                await store.update('', {
                    [`shots/${id}`]: { title: title.slice(0, 40), by: GBFCollab.myName || 'ななし', at: Date.now(), w: full.w, h: full.h, thumb: thumb.data },
                    [`shotData/${id}`]: full.data,
                });
                fullCache.set(id, full.data);
                done++;
            } catch (e) {
                console.warn(e);
                say(/permission/i.test(String(e && (e.code || e.message)))
                    ? '追加できませんでした（サーバーに拒否されました）。管理人は Firebase のルールが最新（database.rules.json）になっているか確認してください。'
                    : `追加できませんでした: ${e.message || e}`);
                return;
            }
        }
        say(done ? `${done}枚追加しました` : '');
    }

    // ---------- 一覧 ----------
    function render() {
        const inRoom = GBFCollab.inRoom;
        const names = [...new Set(list().map((s) => s.by).filter(Boolean))];
        if (filter && !names.includes(filter)) filter = '';
        filterEl.innerHTML = `<option value="">全員（${list().length}枚）</option>` + names.map((n) => `<option value="${esc(n)}"${n === filter ? ' selected' : ''}>${esc(n)}（${list().filter((s) => s.by === n).length}枚）</option>`).join('');
        whereEl.textContent = inRoom ? 'ルームの全員と共有しています。' : 'いまはこのブラウザの中だけに保存されます（サーバーは使いません）。ルームを作ると、みんなと共有できます。';
        const items = visible();
        if (!items.length) { gridEl.innerHTML = '<p class="shots-empty">まだスクショがありません。上の枠から追加してください。</p>'; return; }
        // タイトル入力中のカードは作り直さない
        const focused = document.activeElement?.closest?.('.shot-card')?.dataset.id;
        const existing = new Map([...gridEl.querySelectorAll('.shot-card')].map((el) => [el.dataset.id, el]));
        const frag = document.createDocumentFragment();
        items.forEach((s) => {
            let card = existing.get(s.id);
            if (!card) {
                card = document.createElement('figure');
                card.className = 'shot-card';
                card.dataset.id = s.id;
                card.innerHTML = `
                    <button class="shot-open" aria-label="大きく見る"><img alt="" loading="lazy"></button>
                    <figcaption>
                        <input class="shot-title" maxlength="40" aria-label="タイトル">
                        <span class="shot-meta"></span>
                        <button class="btn reset-btn shot-del" aria-label="削除">✕</button>
                    </figcaption>`;
            }
            const img = card.querySelector('img');
            if (img.getAttribute('src') !== s.thumb) img.src = s.thumb || '';
            const title = card.querySelector('.shot-title');
            if (s.id !== focused && title.value !== (s.title || '')) title.value = s.title || '';
            card.querySelector('.shot-meta').textContent = `${s.by || 'ななし'}・${new Date(s.at || 0).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
            frag.appendChild(card);
        });
        gridEl.replaceChildren(frag);
        if (focused) gridEl.querySelector(`.shot-card[data-id="${focused}"] .shot-title`)?.focus();
    }

    // ---------- 大きく見る ----------
    let viewing = null;
    async function openView(id) {
        const s = shots[id];
        if (!s) return;
        viewing = id;
        viewEl.hidden = false;
        viewEl.querySelector('.shots-view-title').textContent = `${s.title || ''}（${s.by || 'ななし'}）`;
        viewImg.src = s.thumb || '';
        const dl = viewEl.querySelector('.shots-dl');
        dl.removeAttribute('href');
        let full = fullCache.get(id);
        if (!full) {
            try { full = await store.get(`shotData/${id}`); } catch (e) { console.warn(e); }
            if (full) fullCache.set(id, full);
        }
        if (viewing !== id) return;
        if (full) { viewImg.src = full; dl.href = full; dl.download = `${(s.title || 'screenshot').replace(/[\\/:*?"<>|]/g, '_')}.jpg`; }
    }
    function step(d) {
        const ids = visible().map((s) => s.id);
        const i = ids.indexOf(viewing);
        if (i >= 0 && ids.length) openView(ids[(i + d + ids.length) % ids.length]);
    }
    const closeView = () => { viewEl.hidden = true; viewing = null; viewImg.removeAttribute('src'); };

    // ---------- 操作 ----------
    dropEl.addEventListener('click', () => fileEl.click());
    dropEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); dropEl.click(); } });
    fileEl.addEventListener('change', () => { addFiles(fileEl.files); fileEl.value = ''; });
    dropEl.addEventListener('dragover', (e) => { e.preventDefault(); dropEl.classList.add('over'); });
    dropEl.addEventListener('dragleave', () => dropEl.classList.remove('over'));
    dropEl.addEventListener('drop', (e) => { e.preventDefault(); dropEl.classList.remove('over'); addFiles(e.dataTransfer.files); });
    document.addEventListener('paste', (e) => {
        if (document.body.dataset.tab !== 'shots' || e.target.closest?.('input, textarea')) return;
        const files = [...(e.clipboardData?.items || [])].filter((it) => it.type.startsWith('image/')).map((it) => it.getAsFile()).filter(Boolean);
        if (files.length) { e.preventDefault(); addFiles(files); }
    });
    filterEl.addEventListener('change', () => { filter = filterEl.value; render(); });

    gridEl.addEventListener('click', (e) => {
        const card = e.target.closest('.shot-card');
        if (!card) return;
        if (e.target.closest('.shot-open')) openView(card.dataset.id);
        else if (e.target.closest('.shot-del')) {
            const s = shots[card.dataset.id];
            if (!confirm(`「${s?.title || 'スクショ'}」を削除しますか？\nルームの全員から消えます。`)) return;
            store.update('', { [`shots/${card.dataset.id}`]: null, [`shotData/${card.dataset.id}`]: null });
            fullCache.delete(card.dataset.id);
        }
    });
    gridEl.addEventListener('change', (e) => {
        const card = e.target.closest('.shot-card');
        if (card && e.target.classList.contains('shot-title')) store.update(`shots/${card.dataset.id}`, { title: e.target.value.trim().slice(0, 40) || 'スクショ' });
    });
    gridEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.classList.contains('shot-title')) e.target.blur(); });

    viewEl.addEventListener('click', (e) => {
        if (e.target === viewEl || e.target.closest('.shots-close')) closeView();
        else if (e.target.closest('.shots-nav.prev')) step(-1);
        else if (e.target.closest('.shots-nav.next')) step(1);
    });
    document.addEventListener('keydown', (e) => {
        if (viewEl.hidden) return;
        if (e.key === 'Escape') closeView();
        else if (e.key === 'ArrowLeft') step(-1);
        else if (e.key === 'ArrowRight') step(1);
    });

    // ---------- 置き場の切り替え ----------
    function attach() {
        if (unsub) unsub();
        store = shotStore();
        shots = {};
        fullCache.clear();
        closeView();
        unsub = store.onValue('shots', (v) => { shots = v || {}; render(); });
        render();
    }
    GBFCollab.onStoreChange(attach);
    attach();

    // ルームの保存ファイルや「今の内容で作成」に、ルーム外のスクショも入れる
    window.GBFShots = {
        async localAll() {
            const s = localShots || (localShots = createLocalShotStore());
            try { return { shots: (await s.get('shots')) || {}, shotData: (await s.get('shotData')) || {} }; } catch { return { shots: {}, shotData: {} }; }
        },
    };
})();
