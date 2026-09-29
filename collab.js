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
            uid: null,
            // ローカル置き場では「ルームごと消す」だけ扱う（rooms/<id> を消す指示を、この置き場全体の削除として扱う）
            async rootUpdate(updates) {
                if (Object.entries(updates).some(([k, v]) => /^rooms\/[^/]+$/.test(k) && v == null)) { commit({ '': null }); data = {}; try { localStorage.removeItem(storageKey); } catch { /* 無効 */ } }
            },
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
            // 匿名ログイン：ブラウザごとに見えない ID が付くだけ（管理者・鍵の判定に使う）。
            // Firebase 側で匿名ログインが有効になっていなければ、ID なしで今まで通り動く
            let uid = null;
            try {
                const authMod = await import(`${base}/firebase-auth.js`);
                const auth = authMod.getAuth(app);
                if (config.authEmulatorUrl) authMod.connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
                uid = (await authMod.signInAnonymously(auth)).user.uid;
            } catch (e) {
                console.warn('anonymous sign-in unavailable', e);
            }
            return { db: dbMod.getDatabase(app), m: dbMod, uid };
        })());
        return {
            kind: 'firebase',
            available: true,
            async connect(roomId) {
                const { db, m, uid } = await load();
                const base = `rooms/${roomId}`;
                const r = (p) => m.ref(db, joinPath(base, p));
                const unsubs = new Set();
                const presenceRefs = [];
                return {
                    kind: 'firebase',
                    uid,
                    // onError は読む権限がなくなったとき（鍵がかかった・パスワードが変わった）に呼ばれる
                    onValue(path, cb, onError) {
                        const off = m.onValue(r(path), (snap) => cb(snap.val()), (err) => { console.warn('onValue error', path, err); onError?.(err); });
                        unsubs.add(off);
                        return () => { off(); unsubs.delete(off); };
                    },
                    update(path, updates) { return m.update(r(path), updates); },
                    set(path, value) { return m.set(r(path), value); },
                    async get(path) { return (await m.get(r(path))).val(); },
                    // rooms/ の外（locks/）もまとめて書く。キーは DB のルートからのパス
                    rootUpdate(updates) { return m.update(m.ref(db), updates); },
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
        roomName: '',
        owner: null, // ルームの管理者（作った人）の匿名ID
        locked: false,
        lockPrompt: null, // 鍵つきルームのパスワード入力待ち { roomId, msg }
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
    const RECENT_KEY = 'gbfRecentRooms';
    function recentRooms() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
    function saveRecent(id, name) {
        const list = recentRooms().filter((r) => r.id !== id);
        list.unshift({ id, name: name || '', at: Date.now() });
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 12))); } catch { /* 容量 */ }
    }
    function removeRecent(id) {
        try { localStorage.setItem(RECENT_KEY, JSON.stringify(recentRooms().filter((r) => r.id !== id))); } catch { /* 容量 */ }
    }
    const isPermissionError = (e) => /permission/i.test(String((e && (e.code || e.message)) || e));
    // 鍵のパスワードはそのまま送らず、ルームIDと混ぜたハッシュにする
    async function hashPassword(roomId, pw) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`gbf-room:${roomId}:${pw}`));
        return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
    }
    const defaultSheets = () => ({ [Math.random().toString(36).slice(2, 10)]: { name: 'シート1', order: 1, rows: 30, cols: 8, freeze: true } });

    // create: 新しく作る / blank: 空で作る / seed: 保存ファイルから復元する中身
    async function connect(roomId, { create = false, blank = false, name = '', seed = null } = {}) {
        if (!remoteAdapter) return;
        setStatus('busy', seed ? '復元中…' : create ? 'ルームを作成中…' : 'ルームに接続中…');
        let room = null;
        try {
            room = await remoteAdapter.connect(roomId);
            if (create) {
                const sheets = seed ? seed.sheets : blank ? null : await currentStore().get('sheets');
                const move = seed ? normalizeMove(seed.move) : sharedMove(blank ? getDefaultWorkData() : currentWorkData);
                const meta = { createdAt: Date.now(), createdBy: myName(), name: (name || '').slice(0, 40) };
                if (room.uid) meta.owner = room.uid;
                await room.set('meta', meta);
                await room.set('move', clone(move));
                await room.set('sheets', sheets && Object.keys(sheets).length ? sheets : defaultSheets());
                // スクショは1枚ずつ（1回の書き込みを小さくする）
                for (const [id, shot] of Object.entries((seed && seed.shots) || {})) {
                    const data = seed.shotData && seed.shotData[id];
                    if (shot && data) await room.update('', { [`shots/${id}`]: shot, [`shotData/${id}`]: data });
                }
            } else {
                let meta;
                try { meta = await room.get('meta'); } catch (e) {
                    if (!isPermissionError(e)) throw e;
                    room.close();
                    askPassword(roomId, '');
                    return;
                }
                if (!meta) {
                    room.close();
                    removeRecent(roomId);
                    setStatus('error', 'ルームが見つかりません（削除されたか、リンクが違います）');
                    if (!state.room) clearHash();
                    return;
                }
            }
            // 別の内容に置き換わるときは、自分の作業を念のため退避しておく
            if (!create || blank || seed) { try { localStorage.setItem(BACKUP_KEY, localStorage.getItem(STORAGE_KEY_CURRENT) || ''); } catch { /* 容量 */ } }
            teardown(); // 前のルームにいたら抜ける
            state.room = room;
            state.roomId = roomId;
            state.roomName = name;
            state.owner = create ? room.uid : null;
            state.locked = false;
            state.lockPrompt = null;
            formOpen = false;
            manageOpen = false;
            state.lastMoveFlat = create && !blank && !seed ? flatten(clone(sharedMove(currentWorkData))) : null;
            // 読めなくなった（鍵がかかった・パスワードが変わった）ら、パスワードを聞き直す
            const lost = (err) => {
                if (state.room !== room || !isPermissionError(err)) return;
                teardown();
                askPassword(roomId, 'このルームに鍵がかかったか、パスワードが変わりました');
                emitStoreChange();
            };
            state.unsubs.push(room.onValue('move', (v) => { if (v) applyRemoteMove(v); }, lost));
            state.unsubs.push(room.onValue('presence', (v) => { state.presence = v || {}; renderBar(); window.dispatchEvent(new CustomEvent('gbf-presence', { detail: state.presence })); }, lost));
            state.unsubs.push(room.onValue('meta', (v) => {
                if (state.room !== room) return;
                if (!v) {
                    // 管理者がルームを削除した
                    teardown();
                    clearHash();
                    removeRecent(roomId);
                    setStatus('error', 'このルームは削除されました。内容はこのブラウザに残っています');
                    emitStoreChange();
                    return;
                }
                state.roomName = v.name || '';
                state.owner = v.owner || null;
                state.locked = !!v.locked;
                saveRecent(roomId, state.roomName);
                renderBar();
                window.dispatchEvent(new CustomEvent('gbf-room', { detail: { id: roomId, name: state.roomName } }));
            }, lost));
            saveRecent(roomId, name);
            await announce({});
            if (location.hash !== `#room=${roomId}`) history.replaceState(null, '', `#room=${roomId}`);
            setStatus('ok', seed ? '復元しました。新しいリンクを送ってください' : create ? 'ルームを作りました。リンクを送ってください' : '');
            emitStoreChange();
        } catch (e) {
            console.error(e);
            if (room && state.room !== room) room.close();
            setStatus('error', 'つながりませんでした: ' + (e && e.message ? e.message : e));
        }
    }

    function teardown() {
        if (!state.room) return;
        state.unsubs.forEach((u) => u());
        state.unsubs = [];
        state.room.close();
        state.room = null;
        state.roomId = null;
        state.roomName = '';
        state.owner = null;
        state.locked = false;
        state.lastMoveFlat = null;
        state.presence = {};
    }
    function leave() {
        if (!state.room) return;
        teardown();
        clearHash();
        setStatus('ok', '');
        emitStoreChange();
    }
    const clearHash = () => history.replaceState(null, '', location.pathname + location.search);

    function renameRoom(name) {
        if (!state.room) return;
        state.roomName = name.slice(0, 40);
        state.room.update('meta', { name: state.roomName }).catch((e) => setStatus('error', '名前を保存できませんでした: ' + e.message));
    }

    // ---------- 鍵・管理者・削除 ----------
    const isOwner = () => !!(state.room && state.room.uid && state.owner === state.room.uid);
    function askPassword(roomId, msg) {
        state.lockPrompt = { roomId, msg };
        if (location.hash !== `#room=${roomId}`) history.replaceState(null, '', `#room=${roomId}`);
        setStatus('ok', '');
    }
    async function submitPassword(pw) {
        const roomId = state.lockPrompt && state.lockPrompt.roomId;
        if (!roomId || !pw) return;
        setStatus('busy', '確認中…');
        let room = null;
        try {
            room = await remoteAdapter.connect(roomId);
            if (!room.uid) throw new Error('ログインの準備ができていません');
            // 正しいパスワードのときだけ、サーバーのルールがこの書き込みを通す
            await room.update('members', { [room.uid]: await hashPassword(roomId, pw) });
        } catch (e) {
            room?.close();
            setStatus('error', isPermissionError(e) ? 'パスワードが違います' : `入れませんでした: ${e.message || e}`);
            return;
        }
        room.close();
        state.lockPrompt = null;
        connect(roomId, { create: false });
    }
    async function setLock(pw) {
        if (!isOwner() || !pw) return;
        const id = state.roomId;
        const h = await hashPassword(id, pw);
        // 鍵・自分の入室・表示用の印を1回で書く（途中で自分が締め出されないように）
        await state.room.rootUpdate({ [`locks/${id}`]: h, [`rooms/${id}/members/${state.room.uid}`]: h, [`rooms/${id}/meta/locked`]: true });
        setStatus('ok', state.locked ? 'パスワードを変えました。入っていた人も、新しいパスワードが必要になります' : '鍵をかけました。パスワードを知っている人だけが入れます');
    }
    async function removeLock() {
        if (!isOwner()) return;
        const id = state.roomId;
        await state.room.rootUpdate({ [`locks/${id}`]: null, [`rooms/${id}/meta/locked`]: null });
        setStatus('ok', '鍵を外しました');
    }
    async function deleteRoom() {
        if (!isOwner()) return;
        const id = state.roomId;
        await state.room.rootUpdate({ [`rooms/${id}`]: null, [`locks/${id}`]: null });
    }
    async function claimOwner() {
        if (!state.room || !state.room.uid || state.owner) return;
        await state.room.update('meta', { owner: state.room.uid });
    }

    // ---------- 保存・復元（ファイル・Googleドライブ） ----------
    const EXPORT_SUFFIX = '.gbfroom.json';
    async function exportData() {
        const src = state.room || currentStore();
        const [sheets, shots, shotData] = await Promise.all([
            src.get('sheets'),
            state.room ? src.get('shots') : null,
            state.room ? src.get('shotData') : null,
        ]);
        return {
            format: 'gbf-room',
            version: 1,
            exportedAt: new Date().toISOString(),
            name: state.roomName || '',
            move: clone(sharedMove(currentWorkData)),
            sheets: sheets || {},
            shots: shots || {},
            shotData: shotData || {},
        };
    }
    function exportFileName(d) {
        const t = new Date();
        const stamp = `${t.getFullYear()}${String(t.getMonth() + 1).padStart(2, '0')}${String(t.getDate()).padStart(2, '0')}-${String(t.getHours()).padStart(2, '0')}${String(t.getMinutes()).padStart(2, '0')}`;
        return `${(d.name || 'GBFルーム').replace(/[\\/:*?"<>|]/g, '_').slice(0, 40)}_${stamp}${EXPORT_SUFFIX}`;
    }
    function parseExport(text) {
        let d;
        try { d = JSON.parse(text); } catch { throw new Error('ファイルを読めませんでした'); }
        if (!d || d.format !== 'gbf-room' || !d.move) throw new Error('共有ムーブ表の保存ファイルではありません');
        return d;
    }
    async function saveToFile() {
        const d = await exportData();
        const blob = new Blob([JSON.stringify(d)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = exportFileName(d);
        document.body.appendChild(a); // ページに付けてから押さないと、ファイル名が効かないブラウザがある
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        setStatus('ok', `ファイルに保存しました（シート${Object.keys(d.sheets).length}枚・スクショ${Object.keys(d.shots).length}枚）`);
    }
    function restore(d) {
        const n = Object.keys(d.shots || {}).length;
        if (!confirm(`「${d.name || '名前なし'}」を新しいルームとして復元します（シート${Object.keys(d.sheets || {}).length}枚・スクショ${n}枚）。\n新しいリンクになります。よろしいですか？`)) return;
        connect(newRoomId(), { create: true, seed: d, name: d.name || '' });
    }

    const G = () => window.GBFGoogle;
    async function driveFetch(url, opts = {}) {
        const token = await G().requestToken();
        const res = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error((body.error && body.error.message) || `HTTP ${res.status}`);
        }
        return res;
    }
    async function saveToDrive() {
        setStatus('busy', 'Googleドライブに保存中…');
        try {
            const d = await exportData();
            const boundary = `gbf${Math.random().toString(36).slice(2)}`;
            const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: exportFileName(d), mimeType: 'application/json', description: 'グラブル 共有ムーブ表のルーム（このツールで復元できます）' })}\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(d)}\r\n--${boundary}--`;
            const res = await driveFetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
            const file = await res.json();
            setStatus('ok', `Googleドライブに「${file.name}」として保存しました`);
        } catch (e) { setStatus('error', `ドライブに保存できませんでした: ${e.message || e}`); }
    }
    let driveFiles = null;
    async function listDrive() {
        setStatus('busy', 'Googleドライブを確認中…');
        try {
            const q = encodeURIComponent(`name contains '${EXPORT_SUFFIX}' and trashed = false`);
            const res = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&orderBy=modifiedTime%20desc&pageSize=30&fields=files(id,name,modifiedTime,size)`);
            driveFiles = (await res.json()).files || [];
            setStatus('ok', driveFiles.length ? '' : 'このツールで保存したファイルが見つかりません');
        } catch (e) { setStatus('error', `ドライブを開けませんでした: ${e.message || e}`); }
    }
    async function loadFromDrive(id) {
        setStatus('busy', 'Googleドライブから読み込み中…');
        try {
            const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(id)}?alt=media`);
            const d = parseExport(await res.text());
            setStatus('ok', '');
            restore(d);
        } catch (e) { setStatus('error', `読み込めませんでした: ${e.message || e}`); }
    }

    // 自分の在室情報（extra に今いるセルなどを入れる）
    let lastExtra = {};
    function announce(extra) {
        lastExtra = { ...lastExtra, ...extra };
        if (!state.room) return Promise.resolve();
        return state.room.setPresence(state.clientId, { name: myName(), color: myColor(), at: Date.now(), ...lastExtra });
    }

    window.addEventListener('pagehide', () => { if (state.room) state.room.close(); });

    // ---------- 画面（上部のルームバー） ----------
    // 入力中の欄を消さないよう、骨組みは状態が変わったときだけ作り直し、中身は差し替える
    const bar = document.getElementById('collab-bar');
    let status = { kind: 'ok', text: '' };
    let formOpen = false;
    let manageOpen = false;
    let builtMode = '';
    let builtManage = '';
    function setStatus(kind, text) { status = { kind, text }; renderBar(); }

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const recentOptions = () => {
        const list = recentRooms().filter((r) => r.id !== state.roomId);
        return `<option value="">${list.length ? '最近のルームを開く…' : '最近のルームはまだありません'}</option>`
            + list.map((r) => `<option value="${esc(r.id)}">${esc(r.name || '名前なし')}（${new Date(r.at).toLocaleDateString('ja-JP')}）</option>`).join('');
    };
    const createForm = () => `
        <div class="collab-row collab-form">
            <label>ルーム名 <input class="collab-room-new" maxlength="40" placeholder="例: 〇〇団 古戦場"></label>
            <button class="btn collab-primary" data-act="create-copy">今の内容で作成</button>
            <button class="btn" data-act="create-blank">空で作成</button>
            <button class="btn reset-btn" data-act="cancel">やめる</button>
        </div>`;

    // 管理パネル（保存・復元、鍵、削除）
    function manageHtml() {
        const google = G() && G().available;
        const inRoom = !!state.room;
        const uid = state.room && state.room.uid;
        let html = `
            <div class="cm-sec">
                <strong>保存・復元</strong>
                <div class="collab-row">
                    <button class="btn" data-act="save-file">${inRoom ? 'ルームを' : '今の内容を'}ファイルに保存</button>
                    ${google ? `<button class="btn" data-act="save-drive">Googleドライブに保存</button>` : ''}
                    <button class="btn" data-act="restore-file">ファイルから復元</button>
                    ${google ? `<button class="btn" data-act="list-drive">ドライブから復元</button>` : ''}
                    <input type="file" class="cm-file" accept=".json,application/json" hidden>
                </div>
                ${driveFiles && driveFiles.length ? `<div class="cm-drive">${driveFiles.map((f) => `<button class="btn" data-drive="${esc(f.id)}">${esc(f.name.replace(EXPORT_SUFFIX, ''))}<small>${new Date(f.modifiedTime).toLocaleString('ja-JP')}</small></button>`).join('')}</div>` : ''}
                <p class="cm-note">編成・全シート・スクショをまとめて保存します。復元すると新しいルーム（新しいリンク）になります。${inRoom ? '使わなくなったルームは、保存してから削除するとサーバーを圧迫しません。' : ''}</p>
            </div>`;
        if (!inRoom) return html;
        if (!uid) {
            return html + '<div class="cm-sec"><p class="cm-note">鍵とルーム削除は、管理人が Firebase の匿名ログインを有効にすると使えるようになります。</p></div>';
        }
        if (isOwner()) {
            html += `
            <div class="cm-sec">
                <strong>${state.locked ? '🔒 鍵つき' : '🔓 鍵なし'}</strong>
                <div class="collab-row">
                    <input type="password" class="cm-pw" placeholder="パスワード（4文字以上）" autocomplete="new-password">
                    <button class="btn" data-act="lock">${state.locked ? 'パスワードを変える' : '鍵をかける'}</button>
                    ${state.locked ? '<button class="btn reset-btn" data-act="unlock">鍵を外す</button>' : ''}
                </div>
                <p class="cm-note">鍵をかけると、リンクを知っていてもパスワードを入れた人しか見られません。パスワードを変えると、入っていた人も入れ直しになります。</p>
            </div>
            <div class="cm-sec">
                <strong>ルームの削除</strong>
                <div class="collab-row"><button class="btn cm-danger" data-act="room-delete">このルームを削除…</button></div>
                <p class="cm-note">全員のシート・スクショがサーバーから消えます（元に戻せません）。先に保存しておくと、あとで復元できます。</p>
            </div>
            <p class="cm-note">あなたはこのルームの管理者です（このブラウザで作成）。別の端末やブラウザからは管理者として操作できません。</p>`;
        } else {
            html += `
            <div class="cm-sec">
                <strong>${state.locked ? '🔒 鍵つき' : '🔓 鍵なし'}</strong>
                <p class="cm-note">鍵とルームの削除は、ルームを作った人（管理者）だけが操作できます。</p>
                ${state.owner ? '' : '<div class="collab-row"><button class="btn" data-act="claim">このルームの管理者になる</button></div><p class="cm-note">このルームにはまだ管理者がいません（以前に作ったルーム）。</p>'}
            </div>`;
        }
        return html;
    }

    function renderBar() {
        if (!bar) return;
        if (!remoteAdapter) { bar.hidden = true; return; }
        bar.hidden = false;
        const kind = state.room ? 'room' : state.lockPrompt ? 'locked' : 'idle';
        const mode = `${kind}:${formOpen}:${manageOpen}:${state.roomId || ''}:${state.lockPrompt ? state.lockPrompt.roomId : ''}`;
        if (mode !== builtMode) {
            builtMode = mode;
            builtManage = '';
            const manageBox = manageOpen ? '<div class="collab-manage"></div>' : '';
            if (kind === 'room') {
                bar.innerHTML = `
                    <div class="collab-row">
                        <span class="collab-live">● 共同編集中</span>
                        <span class="collab-lock" title="鍵つき"></span>
                        <input class="collab-room-name" maxlength="40" placeholder="ルーム名をつける" aria-label="ルーム名">
                        <span class="collab-people"></span>
                    </div>
                    <div class="collab-row">
                        <input class="collab-link" readonly value="${esc(roomUrl(state.roomId))}" aria-label="共有リンク">
                        <button class="btn" data-act="copy">リンクをコピー</button>
                        <button class="btn" data-act="manage">保存・鍵・削除 ${manageOpen ? '▴' : '▾'}</button>
                        <button class="btn" data-act="new">新しいルーム</button>
                        <select class="collab-recent" aria-label="最近のルーム"></select>
                        <button class="btn reset-btn" data-act="leave">ルームを出る</button>
                    </div>
                    ${formOpen ? createForm() : ''}
                    ${manageBox}
                    <div class="collab-row small">
                        <label>表示名 <input class="collab-name" maxlength="16"></label>
                        <span class="collab-note"></span>
                        <span class="collab-msg"></span>
                    </div>`;
            } else if (kind === 'locked') {
                bar.innerHTML = `
                    <div class="collab-row">
                        <strong class="collab-title">🔒 このルームには鍵がかかっています</strong>
                        <span class="collab-note">${esc(state.lockPrompt.msg || 'パスワードを入れると入れます。')}</span>
                    </div>
                    <div class="collab-row">
                        <input type="password" class="collab-pw" placeholder="パスワード" autocomplete="current-password">
                        <button class="btn collab-primary" data-act="enter">入る</button>
                        <button class="btn reset-btn" data-act="cancel-lock">やめる</button>
                        <span class="collab-msg"></span>
                    </div>`;
                bar.querySelector('.collab-pw')?.focus();
            } else {
                bar.innerHTML = `
                    <div class="collab-row">
                        <strong class="collab-title">共同編集</strong>
                        <span class="collab-note">ルームを作ってリンクを送ると、シート・編成・スクショをみんなで同時に編集できます。</span>
                    </div>
                    <div class="collab-row">
                        <label>表示名 <input class="collab-name" maxlength="16"></label>
                        <button class="btn collab-primary" data-act="new">ルームを作成</button>
                        <select class="collab-recent" aria-label="最近のルーム"></select>
                        <button class="btn" data-act="manage">保存・復元 ${manageOpen ? '▴' : '▾'}</button>
                        <span class="collab-msg"></span>
                    </div>
                    ${formOpen ? createForm() : ''}
                    ${manageBox}`;
            }
            bar.querySelector('.collab-room-new')?.focus();
        }
        const setVal = (sel, v) => { const el = bar.querySelector(sel); if (el && document.activeElement !== el && el.value !== v) el.value = v; };
        setVal('.collab-name', myName());
        setVal('.collab-room-name', state.roomName || '');
        const lock = bar.querySelector('.collab-lock');
        if (lock) lock.textContent = state.locked ? '🔒' : '';
        const note = bar.querySelector('.collab-note');
        if (note && kind === 'room') note.textContent = state.locked ? 'パスワードを知っている人だけが見て編集できます。' : 'リンクを知っている人は誰でも見て編集できます。';
        const recent = bar.querySelector('.collab-recent');
        if (recent && document.activeElement !== recent) recent.innerHTML = recentOptions();
        const people = bar.querySelector('.collab-people');
        if (people) {
            people.innerHTML = Object.entries(state.presence)
                .filter(([, p]) => p && p.name)
                .map(([id, p]) => `<span class="collab-chip" style="--c:${esc(p.color || '#888')}">${esc(p.name)}${id === state.clientId ? '（自分）' : ''}</span>`)
                .join('');
        }
        const box = bar.querySelector('.collab-manage');
        if (box) {
            const html = manageHtml();
            // パスワード入力中は作り直さない
            const typing = box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT';
            if (html !== builtManage && !typing) { box.innerHTML = html; builtManage = html; }
        }
        const msg = bar.querySelector('.collab-msg');
        if (msg) { msg.className = `collab-msg ${status.kind}`; msg.textContent = status.text; }
        bar.querySelectorAll('[data-act^="create"], [data-act="enter"]').forEach((b) => { b.disabled = status.kind === 'busy'; });
    }

    bar?.addEventListener('click', async (e) => {
        const drive = e.target.closest('[data-drive]')?.dataset.drive;
        if (drive) { loadFromDrive(drive); return; }
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act) return;
        try {
            if (act === 'new') { formOpen = true; manageOpen = false; renderBar(); }
            else if (act === 'cancel') { formOpen = false; renderBar(); }
            else if (act === 'manage') {
                manageOpen = !manageOpen;
                formOpen = false;
                if (manageOpen && G() && G().available) G().loadGis().catch(() => {});
                renderBar();
            } else if (act === 'create-copy' || act === 'create-blank') {
                const name = (bar.querySelector('.collab-room-new')?.value || '').trim();
                const blank = act === 'create-blank';
                const what = blank ? '空の' : '今の編成・シートを引き継いだ';
                if (!confirm(`${what}ルーム「${name || '名前なし'}」を作ります。\nリンクを知っている人は誰でも閲覧・編集できます（あとで鍵をかけられます）。よろしいですか？`)) return;
                connect(newRoomId(), { create: true, blank, name });
            } else if (act === 'copy') {
                const input = bar.querySelector('.collab-link');
                navigator.clipboard?.writeText(input.value).then(() => setStatus('ok', 'コピーしました'), () => { input.select(); setStatus('ok', '選択したのでコピーしてください'); });
            } else if (act === 'leave') {
                if (confirm('ルームから抜けます。今の内容はこのブラウザに残ります。')) leave();
            } else if (act === 'enter') {
                submitPassword(bar.querySelector('.collab-pw')?.value || '');
            } else if (act === 'cancel-lock') {
                state.lockPrompt = null;
                clearHash();
                setStatus('ok', '');
            } else if (act === 'save-file') { await saveToFile(); }
            else if (act === 'save-drive') { await saveToDrive(); }
            else if (act === 'list-drive') { await listDrive(); }
            else if (act === 'restore-file') { bar.querySelector('.cm-file')?.click(); }
            else if (act === 'lock') {
                const pw = bar.querySelector('.cm-pw')?.value || '';
                if (pw.length < 4) { setStatus('error', 'パスワードは4文字以上にしてください'); return; }
                await setLock(pw);
                const el = bar.querySelector('.cm-pw');
                if (el) el.value = '';
            } else if (act === 'unlock') {
                if (confirm('鍵を外すと、リンクを知っている人は誰でも見られるようになります。よろしいですか？')) await removeLock();
            } else if (act === 'room-delete') {
                const typed = prompt(`ルーム「${state.roomName || '名前なし'}」を削除します。全員のシート・スクショがサーバーから消え、元に戻せません。\n\n削除するなら「削除」と入力してください。`);
                if (typed !== '削除') return;
                await deleteRoom();
            } else if (act === 'claim') {
                await claimOwner();
            }
        } catch (err) {
            console.warn(err);
            setStatus('error', isPermissionError(err) ? 'この操作は許可されていません' : `できませんでした: ${err.message || err}`);
        }
    });
    bar?.addEventListener('change', (e) => {
        if (e.target.classList.contains('collab-name')) {
            nameCache = e.target.value.trim().slice(0, 16);
            try { localStorage.setItem(NAME_KEY, nameCache); } catch { /* 容量 */ }
            announce({});
            renderBar();
        } else if (e.target.classList.contains('collab-room-name')) {
            renameRoom(e.target.value.trim());
        } else if (e.target.classList.contains('collab-recent') && e.target.value) {
            const id = e.target.value;
            e.target.value = '';
            if (state.room && !confirm('今のルームを出て、選んだルームに移ります。')) return;
            connect(id, { create: false });
        } else if (e.target.classList.contains('cm-file') && e.target.files[0]) {
            const file = e.target.files[0];
            e.target.value = '';
            file.text().then((t) => restore(parseExport(t))).catch((err) => setStatus('error', err.message || String(err)));
        }
    });
    bar?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target.classList.contains('collab-room-name')) e.target.blur();
        if (e.key === 'Enter' && e.target.classList.contains('collab-pw')) bar.querySelector('[data-act="enter"]')?.click();
    });

    // ルーム中にスロットのロードやファイル読込をすると全員の内容が置き換わるので確認する
    const guard = (el, msg) => el?.addEventListener('click', (e) => {
        if (state.room && !confirm(msg)) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    guard(document.getElementById('load-btn'), 'ルームの内容が、全員分このスロットの内容に置き換わります。よろしいですか？');
    guard(document.querySelector('label[for="import-file-input"]'), 'ルームの内容が、全員分ファイルの内容に置き換わります。よろしいですか？');

    window.addEventListener('hashchange', () => {
        const id = roomFromHash();
        if (id && id !== state.roomId) connect(id, { create: false });
    });

    window.GBFCollab = {
        onLocalSave,
        currentStore,
        onStoreChange,
        announce,
        get inRoom() { return !!state.room; },
        get myName() { return nameCache; },
        get roomName() { return state.roomName || ''; },
        get isOwner() { return isOwner(); },
        get locked() { return state.locked; },
        get clientId() { return state.clientId; },
        get presence() { return state.presence; },
        // テスト・デバッグ用
        _internal: { flatten, diffFlat, normalizeMove, setAt, getAt, createLocalStore, localAdapter },
    };

    renderBar();
    const initial = roomFromHash();
    if (initial && remoteAdapter) connect(initial, { create: false });
})();
