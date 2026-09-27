// ムーブ表の共同編集（ルーム）とデータ置き場の切り替え。
// - Firebase Realtime Database を使うときは collab-config.js に設定を書く
// - 設定が無いときは localStorage + BroadcastChannel の「ローカル置き場」で動く（同じブラウザのタブ間だけ同期）
// ページ側（beta.html）とは saveCurrentWork() からの GBFCollab.onLocalSave() 呼び出しだけでつながる。
(function () {
    'use strict';

    const FIREBASE_VERSION = '10.12.2';
    const ROOM_ID_LEN = 20;
    const NAME_KEY = 'gbfCollabName';
    const BACKUP_KEY = 'gbfMoveMakerV5_backupBeforeRoom';
    const COLORS = ['#e57373', '#64b5f6', '#81c784', '#ffb74d', '#ba68c8', '#4dd0e1', '#f06292', '#aed581'];

    // ---------- パスユーティリティ ----------
    const splitPath = (p) => (p || '').split('/').filter(Boolean);
    const joinPath = (...ps) => ps.flatMap(splitPath).join('/');
    function getAt(obj, path) {
        let cur = obj;
        for (const k of splitPath(path)) { if (cur == null || typeof cur !== 'object') return null; cur = cur[k]; }
        return cur === undefined ? null : cur;
    }
    // RTDB と同じく、空になった親は消す
    function setAt(obj, path, value) {
        const keys = splitPath(path);
        if (!keys.length) return value == null ? {} : value;
        const root = obj && typeof obj === 'object' ? obj : {};
        const stack = [root];
        let cur = root;
        for (let i = 0; i < keys.length - 1; i++) {
            if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') {
                if (value == null) return root;
                cur[keys[i]] = {};
            }
            cur = cur[keys[i]];
            stack.push(cur);
        }
        const last = keys[keys.length - 1];
        if (value == null) delete cur[last]; else cur[last] = clone(value);
        for (let i = keys.length - 2; i >= 0; i--) {
            if (Object.keys(stack[i + 1]).length === 0) delete stack[i][keys[i]]; else break;
        }
        return root;
    }
    const clone = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));

    // 葉だけの { 'a/b/0': 値 } にする（null と空の配列・オブジェクトは RTDB に残らないので捨てる）
    function flatten(value, prefix = '', out = {}) {
        if (value == null) return out;
        if (typeof value === 'object') {
            for (const k of Object.keys(value)) flatten(value[k], prefix ? `${prefix}/${k}` : k, out);
        } else {
            out[prefix] = value;
        }
        return out;
    }
    function diffFlat(before, after) {
        const updates = {};
        for (const k of Object.keys(after)) if (before[k] !== after[k]) updates[k] = after[k];
        for (const k of Object.keys(before)) if (!(k in after)) updates[k] = null;
        return updates;
    }

    // ---------- 置き場（アダプタ） ----------
    // どちらも同じ形の Room を返す:
    //   onValue(path, cb) → 解除関数 / update(path, {相対パス: 値|null}) / set(path, 値) / get(path)
    //   setPresence(id, 値) / close()

    // localStorage + BroadcastChannel。同じブラウザのタブ同士で同期する
    function createLocalStore(storageKey) {
        const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel(`gbf-store:${storageKey}`) : null;
        const listeners = new Set();
        let data = (() => { try { return JSON.parse(localStorage.getItem(storageKey)) || {}; } catch { return {}; } })();
        const notify = () => listeners.forEach((l) => l.cb(clone(getAt(data, l.path))));
        const persist = () => { try { localStorage.setItem(storageKey, JSON.stringify(data)); } catch (e) { console.warn('local store save failed', e); } };
        // 変更そのもの（パスと値）を他のタブへ送り、各タブが自分の手元に当てる。
        // localStorage は他タブへの反映が遅れるので、読み直しに頼らない
        const applyPatch = (patch) => { for (const [k, v] of Object.entries(patch)) data = setAt(data, k, v); };
        const commit = (patch) => {
            applyPatch(patch);
            persist();
            notify();
            channel?.postMessage(patch);
        };
        channel?.addEventListener('message', (e) => { applyPatch(e.data); persist(); notify(); });
        const presenceIds = new Set();
        const room = {
            kind: 'local',
            onValue(path, cb) {
                const l = { path, cb };
                listeners.add(l);
                queueMicrotask(() => cb(clone(getAt(data, path))));
                return () => listeners.delete(l);
            },
            async update(path, updates) {
                commit(Object.fromEntries(Object.entries(updates).map(([k, v]) => [joinPath(path, k), v])));
            },
            async set(path, value) { commit({ [joinPath(path)]: value }); },
            async get(path) { return clone(getAt(data, path)); },
            async setPresence(id, value) { presenceIds.add(id); return room.update('presence', { [id]: value }); },
            close() {
                listeners.clear();
                // ページを閉じたら自分の在室表示を消す（Firebase の onDisconnect 相当）
                if (presenceIds.size) commit(Object.fromEntries([...presenceIds].map((id) => [`presence/${id}`, null])));
                channel?.close();
            },
        };
        return room;
    }

    const localAdapter = {
        kind: 'local',
        available: true,
        async connect(roomId) { return createLocalStore(`gbfCollabLocalRoom_${roomId}`); },
    };

    function createFirebaseAdapter(config) {
        let dbPromise = null;
        const load = () => (dbPromise ||= (async () => {
            const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
            const appMod = await import(`${base}/firebase-app.js`);
            const dbMod = await import(`${base}/firebase-database.js`);
            const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(config);
            return { db: dbMod.getDatabase(app), m: dbMod };
        })());
        return {
            kind: 'firebase',
            available: true,
            async connect(roomId) {
                const { db, m } = await load();
                const base = `rooms/${roomId}`;
                const r = (p) => m.ref(db, joinPath(base, p));
                const unsubs = new Set();
                const presenceRefs = [];
                return {
                    kind: 'firebase',
                    onValue(path, cb) {
                        const off = m.onValue(r(path), (snap) => cb(snap.val()), (err) => console.warn('onValue error', path, err));
                        unsubs.add(off);
                        return () => { off(); unsubs.delete(off); };
                    },
                    update(path, updates) { return m.update(r(path), updates); },
                    set(path, value) { return m.set(r(path), value); },
                    async get(path) { return (await m.get(r(path))).val(); },
                    async setPresence(id, value) {
                        const pref = r(`presence/${id}`);
                        if (!presenceRefs.includes(id)) { presenceRefs.push(id); await m.onDisconnect(pref).remove(); }
                        return m.set(pref, value);
                    },
                    close() {
                        presenceRefs.forEach((id) => m.remove(r(`presence/${id}`)).catch(() => {}));
                        unsubs.forEach((off) => off());
                        unsubs.clear();
                    },
                };
            },
        };
    }

    // テストでは window.GBF_COLLAB_ADAPTER を差し込める
    const remoteAdapter = window.GBF_COLLAB_ADAPTER
        || (window.GBF_FIREBASE_CONFIG ? createFirebaseAdapter(window.GBF_FIREBASE_CONFIG) : null);

    // ---------- ムーブ表の共有部分 ----------
    // 共有するのは編成（setup）とターン（turns）だけ。今いるターンや選択キャラなどは各自のまま
    function sharedMove(work) {
        return { setup: work.setup, turns: work.state.turns };
    }
    // RTDB は配列を {0:..,2:..} のように返したり空配列を消したりするので、元の形に戻す
    function toArray(v, len = 0, fill = null) {
        let arr = [];
        if (Array.isArray(v)) arr = v.slice();
        else if (v && typeof v === 'object') {
            for (const k of Object.keys(v)) if (/^\d+$/.test(k)) arr[Number(k)] = v[k];
        }
        const n = Math.max(len, arr.length);
        for (let i = 0; i < n; i++) if (arr[i] === undefined || arr[i] === null) arr[i] = typeof fill === 'function' ? fill() : fill;
        return arr;
    }
    function normalizeMove(v) {
        const s = (v && v.setup) || {};
        const setup = {
            characters: toArray(s.characters, 9, ''),
            characterIcons: toArray(s.characterIcons, 9, null),
            characterAbilities: toArray(s.characterAbilities, 9, null).map((a) => toArray(a, 4, '')),
            summons: toArray(s.summons, 6, ''),
            subCount: Number(s.subCount) || 2,
            overallMemo: s.overallMemo || '',
            weaponImageBase64: s.weaponImageBase64 || null,
            raidTemplate: s.raidTemplate || '',
            memos: {},
        };
        for (const [id, m] of Object.entries(s.memos || {})) {
            if (m && typeof m === 'object') setup.memos[id] = { name: m.name || '', text: m.text || '', order: Number(m.order) || 0 };
        }
        let turns = toArray(v && v.turns).filter(Boolean).map((t, i) => ({
            turnNumber: Number(t.turnNumber) || i + 1,
            branches: toArray(t.branches).filter(Boolean).map((b) => ({
                actions: toArray(b.actions).filter((a) => a != null),
                memo: b.memo || '',
            })),
        }));
        turns.forEach((t) => { if (!t.branches.length) t.branches.push({ actions: [], memo: '' }); });
        if (!turns.length) turns = [{ turnNumber: 1, branches: [{ actions: [], memo: '' }] }];
        return { setup, turns };
    }

    // ---------- 本体 ----------
    const state = {
        room: null,
        roomId: null,
        clientId: Math.random().toString(36).slice(2, 10),
        lastMoveFlat: null, // 最後にルームと一致していた共有部分
        applyingRemote: false,
        unsubs: [],
        presence: {},
        listeners: new Set(),
        localSheets: null,
    };

    let nameCache = (() => { try { return (localStorage.getItem(NAME_KEY) || '').trim(); } catch { return ''; } })();
    const myName = () => nameCache || 'ななし';
    const myColor = () => COLORS[parseInt(state.clientId, 36) % COLORS.length];

    function newRoomId() {
        const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
        const bytes = crypto.getRandomValues(new Uint8Array(ROOM_ID_LEN));
        return Array.from(bytes, (b) => chars[b % chars.length]).join('');
    }
    const roomFromHash = () => {
        const m = location.hash.match(/room=([A-Za-z0-9]{20})\b/);
        return m ? m[1] : null;
    };
    const roomUrl = (id) => `${location.origin}${location.pathname}#room=${id}`;

    // ページのテキスト欄にフォーカスがあるときは、その欄の入力中の内容を残す
    function withFocusKept(fn) {
        const el = document.activeElement;
        const keep = el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && el.type !== 'file'
            ? { el, value: el.value, start: el.selectionStart, end: el.selectionEnd }
            : null;
        fn();
        if (keep && keep.el.isConnected) {
            keep.el.value = keep.value;
            try { keep.el.setSelectionRange(keep.start, keep.end); } catch { /* select 等 */ }
            if (document.activeElement !== keep.el) keep.el.focus();
        }
    }

    function applyRemoteMove(value) {
        const remote = normalizeMove(value);
        const remoteFlat = flatten(remote);
        if (state.lastMoveFlat && Object.keys(diffFlat(state.lastMoveFlat, remoteFlat)).length === 0) return;
        const localFlat = flatten(sharedMove(currentWorkData));
        state.lastMoveFlat = remoteFlat;
        if (Object.keys(diffFlat(localFlat, remoteFlat)).length === 0) return;

        const setupChanged = JSON.stringify(currentWorkData.setup) !== JSON.stringify(remote.setup);
        const turnsChanged = JSON.stringify(currentWorkData.state.turns) !== JSON.stringify(remote.turns);
        const st = currentWorkData.state;
        currentWorkData.setup = remote.setup;
        st.turns = remote.turns;
        if (st.currentTurn > st.turns.length) st.currentTurn = st.turns.length;
        if (st.currentTurn < 1) st.currentTurn = 1;
        const turn = st.turns[st.currentTurn - 1];
        if (turn && st.currentBranchIndex >= turn.branches.length) st.currentBranchIndex = 0;
        if (st.isBranchingMode && turn && turn.branches.length < 2) { st.isBranchingMode = false; st.totalBranchesInTurn = 1; }
        // 他の人の編集をまたいで Undo すると、その人の編集まで巻き戻してしまうので履歴を切る
        if (turnsChanged && typeof stateHistory !== 'undefined') stateHistory = [];

        state.applyingRemote = true;
        try {
            withFocusKept(() => refreshMoveDom(setupChanged));
            localStorage.setItem(STORAGE_KEY_CURRENT, JSON.stringify(currentWorkData));
        } finally {
            state.applyingRemote = false;
        }
        window.dispatchEvent(new Event('gbf-work-changed'));
    }

    function refreshMoveDom(setupChanged) {
        const inMove = movePhase.style.display === 'block';
        if (!inMove) {
            if (setupChanged) loadSetupDataToDOM();
            return;
        }
        if (movePhase.classList.contains('playback-mode')) { buildPlaybackView(); return; }
        if (setupChanged) goToMovePhase(); // キャラ・召喚石ボタンを作り直す
        else loadStateDataToDOM();
    }

    // saveCurrentWork() の最後から呼ばれる
    function onLocalSave() {
        if (!state.room || state.applyingRemote || !state.lastMoveFlat) return;
        const flat = flatten(sharedMove(currentWorkData));
        const updates = diffFlat(state.lastMoveFlat, flat);
        if (!Object.keys(updates).length) return;
        state.lastMoveFlat = flat;
        state.room.update('move', updates).catch((e) => { console.warn('sync failed', e); setStatus('error', '保存に失敗しました（通信を確認してください）'); });
    }

    // ---------- 置き場の切り替え（シートなど他の機能向け） ----------
    function currentStore() {
        if (state.room) return state.room;
        return (state.localSheets ||= createLocalStore('gbfSheetsLocal_v1'));
    }
    function onStoreChange(fn) { state.listeners.add(fn); return () => state.listeners.delete(fn); }
    const emitStoreChange = () => state.listeners.forEach((fn) => { try { fn(currentStore()); } catch (e) { console.error(e); } });

    // ---------- ルームの作成・参加・退出 ----------
    async function connect(roomId, { create }) {
        if (!remoteAdapter) return;
        setStatus('busy', create ? 'ルームを作成中…' : 'ルームに接続中…');
        try {
            const room = await remoteAdapter.connect(roomId);
            if (create) {
                const localSheets = await currentStore().get('sheets');
                await room.set('meta', { createdAt: Date.now(), createdBy: myName() });
                await room.set('move', clone(sharedMove(currentWorkData)));
                if (localSheets) await room.set('sheets', localSheets);
            } else {
                const meta = await room.get('meta');
                if (!meta) { room.close(); setStatus('error', 'ルームが見つかりません（リンクを確認してください）'); clearHash(); return; }
                // 参加前の自分の作業は念のため退避しておく
                try { localStorage.setItem(BACKUP_KEY, localStorage.getItem(STORAGE_KEY_CURRENT) || ''); } catch { /* 容量 */ }
            }
            state.room = room;
            state.roomId = roomId;
            state.lastMoveFlat = create ? flatten(clone(sharedMove(currentWorkData))) : null;
            state.unsubs.push(room.onValue('move', (v) => { if (v) applyRemoteMove(v); }));
            state.unsubs.push(room.onValue('presence', (v) => { state.presence = v || {}; renderBar(); window.dispatchEvent(new CustomEvent('gbf-presence', { detail: state.presence })); }));
            await announce({});
            if (location.hash !== `#room=${roomId}`) history.replaceState(null, '', `#room=${roomId}`);
            setStatus('ok', '');
            emitStoreChange();
        } catch (e) {
            console.error(e);
            setStatus('error', 'つながりませんでした: ' + (e && e.message ? e.message : e));
        }
    }

    function leave() {
        if (!state.room) return;
        state.unsubs.forEach((u) => u());
        state.unsubs = [];
        state.room.close();
        state.room = null;
        state.roomId = null;
        state.lastMoveFlat = null;
        state.presence = {};
        clearHash();
        setStatus('ok', '');
        emitStoreChange();
    }
    const clearHash = () => history.replaceState(null, '', location.pathname + location.search);

    // 自分の在室情報（extra に今いるセルなどを入れる）
    let lastExtra = {};
    function announce(extra) {
        lastExtra = { ...lastExtra, ...extra };
        if (!state.room) return Promise.resolve();
        return state.room.setPresence(state.clientId, { name: myName(), color: myColor(), at: Date.now(), ...lastExtra });
    }

    window.addEventListener('pagehide', () => { if (state.room) state.room.close(); });

    // ---------- 画面（上部のルームバー） ----------
    const bar = document.getElementById('collab-bar');
    let status = { kind: 'ok', text: '' };
    function setStatus(kind, text) { status = { kind, text }; renderBar(); }

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    function renderBar() {
        if (!bar) return;
        if (!remoteAdapter) { bar.hidden = true; return; }
        bar.hidden = false;
        const people = Object.entries(state.presence)
            .filter(([, p]) => p && p.name)
            .map(([id, p]) => `<span class="collab-chip" style="--c:${esc(p.color || '#888')}">${esc(p.name)}${id === state.clientId ? '（自分）' : ''}</span>`)
            .join('');
        const msg = status.text ? `<span class="collab-msg ${status.kind}">${esc(status.text)}</span>` : '';
        if (state.room) {
            bar.innerHTML = `
                <div class="collab-row">
                    <span class="collab-live">● 共同編集中</span>
                    <span class="collab-people">${people}</span>
                </div>
                <div class="collab-row">
                    <input class="collab-link" readonly value="${esc(roomUrl(state.roomId))}" aria-label="共有リンク">
                    <button class="btn" data-act="copy">リンクをコピー</button>
                    <button class="btn reset-btn" data-act="leave">ルームを出る</button>
                </div>
                <div class="collab-row small">
                    <label>表示名 <input class="collab-name" maxlength="16" value="${esc(myName())}"></label>
                    <span class="collab-note">リンクを知っている人は誰でも見て編集できます。</span>
                    ${msg}
                </div>`;
        } else {
            bar.innerHTML = `
                <div class="collab-row">
                    <strong class="collab-title">共同編集</strong>
                    <span class="collab-note">ルームを作ってリンクを送ると、ムーブ表と共有シートをみんなで同時に編集できます。</span>
                </div>
                <div class="collab-row">
                    <label>表示名 <input class="collab-name" maxlength="16" value="${esc(myName())}"></label>
                    <button class="btn collab-primary" data-act="create" ${status.kind === 'busy' ? 'disabled' : ''}>ルームを作成</button>
                    ${msg}
                </div>`;
        }
    }

    bar?.addEventListener('click', (e) => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (act === 'create') {
            if (!confirm('今の編成・ムーブ・共有シートを元に共同編集ルームを作ります。\nリンクを知っている人は誰でも閲覧・編集できます。よろしいですか？')) return;
            connect(newRoomId(), { create: true });
        } else if (act === 'copy') {
            const input = bar.querySelector('.collab-link');
            navigator.clipboard?.writeText(input.value).then(() => setStatus('ok', 'コピーしました'), () => { input.select(); setStatus('ok', '選択したのでコピーしてください'); });
        } else if (act === 'leave') {
            if (confirm('ルームから抜けます。今の内容はこのブラウザに残ります。')) leave();
        }
    });
    bar?.addEventListener('change', (e) => {
        if (!e.target.classList.contains('collab-name')) return;
        nameCache = e.target.value.trim().slice(0, 16);
        try { localStorage.setItem(NAME_KEY, nameCache); } catch { /* 容量 */ }
        announce({});
        renderBar();
    });

    // ルーム中にスロットのロードやファイル読込をすると全員の内容が置き換わるので確認する
    const guard = (el, msg) => el?.addEventListener('click', (e) => {
        if (state.room && !confirm(msg)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    guard(document.getElementById('load-btn'), 'ルームの内容が、全員分このスロットの内容に置き換わります。よろしいですか？');
    guard(document.querySelector('label[for="import-file-input"]'), 'ルームの内容が、全員分ファイルの内容に置き換わります。よろしいですか？');

    window.addEventListener('hashchange', () => {
        const id = roomFromHash();
        if (id && id !== state.roomId) { leave(); connect(id, { create: false }); }
    });

    window.GBFCollab = {
        onLocalSave,
        currentStore,
        onStoreChange,
        announce,
        get inRoom() { return !!state.room; },
        get myName() { return nameCache; },
        get clientId() { return state.clientId; },
        get presence() { return state.presence; },
        // テスト・デバッグ用
        _internal: { flatten, diffFlat, normalizeMove, setAt, getAt, createLocalStore, localAdapter },
    };

    renderBar();
    const initial = roomFromHash();
    if (initial && remoteAdapter) connect(initial, { create: false });
})();
