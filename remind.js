// Discord リマインド（ベータ）のページ
// ・Webhook の URL はこのブラウザ（localStorage）に保存し、「今すぐ送る」はブラウザから Discord に直接送る
// ・予約は Firebase の reminders/<uid>/<id> と reminderQueue/<id> に書き、送信サーバー（Netlify の定期実行）が送る
import {
    DAY, LIMITS, buildPayload, fmtJst, isWebhookUrl, jstParts, jstToEpoch, nextOccurrence, renderContent, validateReminder,
} from './remind-core.js';

const FIREBASE_VERSION = '10.12.2';
const HOOKS_KEY = 'gbf_remind_hooks';
const FORM_KEY = 'gbf_remind_form';
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

$('limit').textContent = String(LIMITS.perUser);

/* ---------- 保存（このブラウザ） ---------- */

function load(key, fallback) {
    try {
        const v = JSON.parse(localStorage.getItem(key) || 'null');
        return v ?? fallback;
    } catch {
        return fallback;
    }
}
function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* 保存できなくても続ける */ }
}

let hooks = load(HOOKS_KEY, []).filter((h) => h && isWebhookUrl(h.url));
const form = load(FORM_KEY, {});

function msg(id, text, ok = true) {
    const el = $(id);
    el.textContent = text;
    el.className = `msg ${text ? (ok ? 'ok' : 'ng') : ''}`;
}

/* ---------- Webhook ---------- */

const mask = (url) => url.replace(/\/([\w-]{6})[\w-]+$/, '/$1…');

function renderHooks() {
    $('hook-list').innerHTML = hooks.length
        ? hooks.map((h, i) => `<li><div><span class="title">${esc(h.name)}</span><br><span class="small muted">${esc(mask(h.url))}</span></div>
            <div class="actions"><button type="button" class="small" data-test="${i}">テスト送信</button><button type="button" class="small" data-del="${i}">削除</button></div></li>`).join('')
        : '<li class="small muted">まだ登録していません。</li>';
    for (const sel of document.querySelectorAll('.hook-select')) {
        const cur = sel.value;
        sel.innerHTML = hooks.length ? hooks.map((h, i) => `<option value="${i}">${esc(h.name)}</option>`).join('') : '<option value="">（先に送り先を登録してください）</option>';
        if (cur && hooks[cur]) sel.value = cur;
    }
    $('now-send').disabled = !hooks.length;
    $('sch-save').disabled = !hooks.length || !fb;
}

$('hook-add').addEventListener('click', () => {
    const url = $('hook-url').value.trim();
    const name = $('hook-name').value.trim() || `送り先 ${hooks.length + 1}`;
    if (!isWebhookUrl(url)) return msg('hook-msg', 'Discord の Webhook の URL（https://discord.com/api/webhooks/…）を入れてください', false);
    if (hooks.some((h) => h.url === url)) return msg('hook-msg', 'その URL はもう登録してあります', false);
    hooks.push({ name, url });
    save(HOOKS_KEY, hooks);
    $('hook-url').value = '';
    $('hook-name').value = '';
    msg('hook-msg', `「${name}」を登録しました`);
    renderHooks();
});

$('hook-list').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.del != null) {
        const h = hooks[Number(t.dataset.del)];
        if (!h || !confirm(`「${h.name}」を一覧から消しますか？（この送り先への予約は止まりません。予約は下の一覧から消してください）`)) return;
        hooks.splice(Number(t.dataset.del), 1);
        save(HOOKS_KEY, hooks);
        renderHooks();
    } else if (t.dataset.test != null) {
        const h = hooks[Number(t.dataset.test)];
        const r = await post(h.url, buildPayload({ content: '✅ GBF Tool からのテスト送信です。このチャンネルに届きます。', mention: 'none' }));
        msg('hook-msg', r.ok ? `「${h.name}」にテスト送信しました` : r.error, r.ok);
    }
});

/* ---------- Discord への直接送信 ---------- */

async function post(url, payload) {
    try {
        const res = await fetch(`${url}?wait=true`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        if (res.ok) return { ok: true };
        if (res.status === 401 || res.status === 403 || res.status === 404) return { ok: false, error: 'この Webhook は削除されたか、無効になっています。Discord で URL を確認してください。' };
        if (res.status === 429) return { ok: false, error: '送る回数が多すぎます。少し待ってからもう一度送ってください。' };
        return { ok: false, error: `送れませんでした（Discord の応答 ${res.status}）` };
    } catch {
        return { ok: false, error: '送れませんでした。通信状態を確認してください。' };
    }
}

/* ---------- メンション ---------- */

const MENTIONS = [
    ['none', 'なし'],
    ['everyone', '@everyone'],
    ['here', '@here（オンラインの人）'],
    ['role', 'ロールを指定'],
];
for (const sel of document.querySelectorAll('.mention-select')) {
    sel.innerHTML = MENTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('');
    sel.addEventListener('change', () => {
        sel.closest('section').querySelector('.role-field').classList.toggle('hidden', sel.value !== 'role');
        updatePreviews();
    });
}
function mentionValue(selId, roleId) {
    const v = $(selId).value;
    if (v !== 'role') return v;
    const id = $(roleId).value.trim();
    return /^\d{17,20}$/.test(id) ? `role:${id}` : null;
}

function previewHtml(payload) {
    return esc(payload.content)
        .replace(/^(@everyone|@here|&lt;@&amp;\d+&gt;)/, (m) => `<span class="mention">${m.startsWith('&lt;') ? '@ロール' : m}</span>`)
        || '<span class="muted">（本文が空です）</span>';
}

/* ---------- 今すぐ送る ---------- */

let nowTab = 'multi';
for (const b of document.querySelectorAll('#now [role="tab"]')) {
    b.addEventListener('click', () => {
        nowTab = b.dataset.tab;
        for (const x of document.querySelectorAll('#now [role="tab"]')) x.setAttribute('aria-selected', String(x === b));
        for (const p of document.querySelectorAll('#now [data-pane]')) p.classList.toggle('hidden', p.dataset.pane !== nowTab);
        updatePreviews();
    });
}

function nowContent() {
    if (nowTab === 'free') return $('free-text').value.trim();
    const quest = $('multi-quest').value.trim();
    const id = $('multi-id').value.trim().toUpperCase();
    const note = $('multi-note').value.trim();
    const lines = ['🔔 **マルチ募集**'];
    if (quest) lines.push(`【クエスト】${quest}`);
    if (id) lines.push(`【参戦ID】${id}`);
    if (note) lines.push(note);
    return lines.length > 1 ? lines.join('\n') : '';
}

$('now-send').addEventListener('click', async () => {
    const h = hooks[Number($('now-hook').value)];
    const mention = mentionValue('now-mention', 'now-role');
    const content = nowContent();
    if (!h) return msg('now-msg', '送り先を選んでください', false);
    if (mention == null) return msg('now-msg', 'ロールの ID（17〜20桁の数字）を入れてください', false);
    if (!content) return msg('now-msg', '送る内容を入れてください', false);
    if (nowTab === 'multi' && $('multi-id').value.trim() && !/^[0-9A-Fa-f]{8}$/.test($('multi-id').value.trim()))
        return msg('now-msg', '参戦ID は8桁の英数字です', false);
    $('now-send').disabled = true;
    const r = await post(h.url, buildPayload({ content, mention }));
    $('now-send').disabled = false;
    msg('now-msg', r.ok ? `「${h.name}」に送りました` : r.error, r.ok);
    if (r.ok) {
        form.now = { hook: $('now-hook').value, mention: $('now-mention').value, role: $('now-role').value, quest: $('multi-quest').value, note: $('multi-note').value };
        save(FORM_KEY, form);
        $('multi-id').value = '';
        updatePreviews();
    }
});

/* ---------- 予約 ---------- */

const todayJst = () => {
    const p = jstParts(Date.now());
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};
const addDays = (date, n) => {
    const t = jstToEpoch(date, '12:00') + n * DAY;
    const p = jstParts(t);
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
};

const PRESETS = {
    kosen: () => ({
        title: '古戦場 納品リマインド',
        repeat: 'daily',
        time: '07:00',
        end: addDays($('sch-date').value || todayJst(), 3),
        content: '⚔️ **古戦場 本戦{day}日目**（{date}）\n今日も肉の納品と、目標の貢献度をお忘れなく！\n・本戦は 7:00〜翌0:00\n・終わったら団のスプシ／チャンネルに報告お願いします',
        mention: 'everyone',
        hint: '日付に「本戦1日目」を入れてください。最後の日は本戦4日目（3日後）になっています。',
    }),
    weekly: () => ({
        title: '毎週の団イベント',
        repeat: 'weekly',
        time: '21:00',
        end: '',
        content: '📢 今週の団イベントです！\n21:30 から通話でマルチやります。来られる人は 👍 をお願いします。',
        mention: 'here',
        hint: '',
    }),
    once: () => ({ title: '', repeat: 'none', time: $('sch-time').value || '21:00', end: '', content: '', mention: 'none', hint: '' }),
};

for (const b of document.querySelectorAll('[data-preset]')) {
    b.addEventListener('click', () => {
        const p = PRESETS[b.dataset.preset]();
        if (!$('sch-date').value) $('sch-date').value = todayJst();
        $('sch-title').value = p.title;
        $('sch-repeat').value = p.repeat;
        $('sch-time').value = p.time;
        $('sch-end').value = p.end;
        $('sch-content').value = p.content;
        $('sch-mention').value = p.mention;
        $('sch-mention').dispatchEvent(new Event('change'));
        msg('sch-msg', p.hint);
        updatePreviews();
    });
}

function readSchedule() {
    const h = hooks[Number($('sch-hook').value)];
    const repeat = $('sch-repeat').value;
    const nextAt = jstToEpoch($('sch-date').value, $('sch-time').value);
    const endDate = $('sch-end').value;
    const r = {
        title: $('sch-title').value.trim().slice(0, LIMITS.title),
        webhook: h ? h.url : '',
        content: $('sch-content').value.trim(),
        mention: mentionValue('sch-mention', 'sch-role'),
        repeat,
        nextAt,
        startAt: nextAt,
        enabled: true,
        createdAt: Date.now(),
    };
    // 最後の日は、その日の送信時刻まで（日本時間）
    if (repeat !== 'none' && endDate) r.endAt = jstToEpoch(endDate, $('sch-time').value);
    return r;
}

function updatePreviews() {
    const nm = mentionValue('now-mention', 'now-role') ?? 'none';
    $('now-preview').innerHTML = previewHtml(buildPayload({ content: nowContent(), mention: nm }));
    const r = readSchedule();
    $('sch-end-wrap').classList.toggle('hidden', r.repeat === 'none');
    const at = Number.isFinite(r.nextAt) ? r.nextAt : Date.now();
    $('sch-preview').innerHTML = previewHtml(buildPayload({ content: renderContent(r, at), mention: r.mention ?? 'none' }));
}
for (const el of document.querySelectorAll('#now input, #now textarea, #schedule input, #schedule textarea, #schedule select')) el.addEventListener('input', updatePreviews);

/* ---------- Firebase ---------- */

let fb = null; // { db, m, uid }

async function connect() {
    const config = window.GBF_FIREBASE_CONFIG;
    if (!config) return null;
    const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
    const appMod = await import(`${base}/firebase-app.js`);
    const dbMod = await import(`${base}/firebase-database.js`);
    const authMod = await import(`${base}/firebase-auth.js`);
    const app = appMod.getApps().length ? appMod.getApp() : appMod.initializeApp(config);
    const auth = authMod.getAuth(app);
    if (config.authEmulatorUrl) authMod.connectAuthEmulator(auth, config.authEmulatorUrl, { disableWarnings: true });
    await auth.authStateReady();
    if (!auth.currentUser) await authMod.signInAnonymously(auth);
    return { db: dbMod.getDatabase(app), m: dbMod, uid: auth.currentUser.uid };
}

let reminders = {};

function renderList() {
    const items = Object.entries(reminders).sort(([, a], [, b]) => (b.enabled - a.enabled) || (a.nextAt - b.nextAt));
    const rep = { none: '1回', daily: '毎日', weekly: '毎週' };
    $('sch-list').innerHTML = items.length
        ? items.map(([id, r]) => {
            const hook = hooks.find((h) => h.url === r.webhook);
            const state = r.done ? '<span class="tag off">送信済み</span>' : r.enabled ? '<span class="tag on">予約中</span>' : '<span class="tag off">停止中</span>';
            const err = r.lastError ? `<br><span class="small" style="color:var(--ng)">⚠ ${esc(r.lastError)}</span>` : '';
            const next = r.done ? (r.lastSentAt ? `最後に送った日時: ${fmtJst(r.lastSentAt)}` : '') : `次に送る日時: ${fmtJst(r.nextAt)}`;
            const end = r.endAt ? `（${fmtJst(r.endAt).replace(/ .*/, '')} まで）` : '';
            return `<li><div><span class="title">${esc(r.title || r.content.split('\n')[0].slice(0, 30))}</span>${state}<span class="tag">${rep[r.repeat] || ''}</span>
                <br><span class="small muted">${next}${end}${hook ? ` ・ ${esc(hook.name)}` : ''}</span>${err}</div>
                <div class="actions">
                    <button type="button" class="small" data-act="test" data-id="${id}">今すぐテスト</button>
                    ${r.done ? '' : `<button type="button" class="small" data-act="${r.enabled ? 'pause' : 'resume'}" data-id="${id}">${r.enabled ? '止める' : '再開する'}</button>`}
                    <button type="button" class="small" data-act="del" data-id="${id}">削除</button>
                </div></li>`;
        }).join('')
        : '<li class="small muted">予約はまだありません。</li>';
}

$('sch-save').addEventListener('click', async () => {
    if (!fb) return msg('sch-msg', '予約の機能に接続できていません', false);
    const r = readSchedule();
    if (r.mention == null) return msg('sch-msg', 'ロールの ID（17〜20桁の数字）を入れてください', false);
    if (!r.title) delete r.title;
    const bad = validateReminder(r);
    if (bad) return msg('sch-msg', bad, false);
    if (r.nextAt < Date.now() + 60 * 1000) return msg('sch-msg', '1分以上先の日時を指定してください', false);
    if (Object.values(reminders).filter((x) => !x.done).length >= LIMITS.perUser) return msg('sch-msg', `予約は ${LIMITS.perUser} 件までです。使わないものを削除してください`, false);
    const { db, m, uid } = fb;
    const id = m.push(m.ref(db, `reminders/${uid}`)).key;
    try {
        await m.update(m.ref(db), { [`reminders/${uid}/${id}`]: r, [`reminderQueue/${id}`]: { uid, nextAt: r.nextAt } });
        msg('sch-msg', `予約しました。最初は ${fmtJst(r.nextAt)} に送ります`);
        form.sch = { hook: $('sch-hook').value, mention: $('sch-mention').value, role: $('sch-role').value, time: $('sch-time').value };
        save(FORM_KEY, form);
    } catch (e) {
        msg('sch-msg', `予約できませんでした：${e.message || e}`, false);
    }
});

$('sch-list').addEventListener('click', async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b || !fb) return;
    const { db, m, uid } = fb;
    const id = b.dataset.id;
    const r = reminders[id];
    if (!r) return;
    const path = `reminders/${uid}/${id}`;
    try {
        if (b.dataset.act === 'del') {
            if (!confirm('この予約を削除しますか？')) return;
            await m.update(m.ref(db), { [path]: null, [`reminderQueue/${id}`]: null });
        } else if (b.dataset.act === 'pause') {
            await m.update(m.ref(db), { [`${path}/enabled`]: false, [`reminderQueue/${id}`]: null });
        } else if (b.dataset.act === 'resume') {
            const next = r.nextAt > Date.now() ? r.nextAt : nextOccurrence(r, Date.now());
            if (!next) return msg('sch-msg', 'この予約はもう終わっています。日付を変えて予約し直してください', false);
            await m.update(m.ref(db), { [`${path}/enabled`]: true, [`${path}/nextAt`]: next, [`${path}/lastError`]: null, [`reminderQueue/${id}`]: { uid, nextAt: next } });
        } else if (b.dataset.act === 'test') {
            const res = await post(r.webhook, buildPayload({ content: renderContent(r, r.done ? Date.now() : r.nextAt), mention: r.mention, username: r.username }));
            msg('sch-msg', res.ok ? 'テストとして今すぐ送りました（予約はそのままです）' : res.error, res.ok);
        }
    } catch (err) {
        msg('sch-msg', `操作できませんでした：${err.message || err}`, false);
    }
});

/** 送信サーバーが動いているか（最後に動いた時刻） */
function watchStatus() {
    const { db, m } = fb;
    m.onValue(m.ref(db, 'reminderStatus'), (snap) => {
        const s = snap.val();
        const el = $('server-status');
        const ago = s && s.lastRun ? Math.round((Date.now() - s.lastRun) / 60000) : null;
        if (ago != null && ago <= 15) {
            el.className = 'status ok';
            el.textContent = `送信サーバー：動いています（最後の確認 ${ago <= 0 ? 'たった今' : `${ago} 分前`}）`;
        } else {
            el.className = 'status ng';
            el.textContent = ago == null
                ? '送信サーバー：まだ動いていません。予約はできますが、サーバーが動くまで送られません（今すぐ送るは使えます）。'
                : `送信サーバー：しばらく動いていません（最後の確認 ${ago} 分前）。予約が遅れることがあります。`;
        }
    }, () => {});
}

/* ---------- 起動 ---------- */

function restoreForm() {
    const n = form.now || {};
    if (n.hook && hooks[n.hook]) $('now-hook').value = n.hook;
    if (n.mention) $('now-mention').value = n.mention;
    $('now-role').value = n.role || '';
    $('multi-quest').value = n.quest || '';
    $('multi-note').value = n.note || '';
    const s = form.sch || {};
    if (s.hook && hooks[s.hook]) $('sch-hook').value = s.hook;
    if (s.mention) $('sch-mention').value = s.mention;
    $('sch-role').value = s.role || '';
    if (s.time) $('sch-time').value = s.time;
    $('sch-date').value = todayJst();
    for (const sel of document.querySelectorAll('.mention-select')) sel.dispatchEvent(new Event('change'));
}

renderHooks();
restoreForm();
updatePreviews();

try {
    fb = await connect();
} catch (e) {
    console.warn('firebase unavailable', e);
    fb = null;
}
if (fb) {
    renderHooks();
    watchStatus();
    fb.m.onValue(fb.m.ref(fb.db, `reminders/${fb.uid}`), (snap) => {
        reminders = snap.val() || {};
        renderList();
    }, (err) => {
        $('sch-list').innerHTML = `<li class="small" style="color:var(--ng)">予約の一覧を読み込めませんでした（${esc(err.message)}）</li>`;
    });
} else {
    $('server-status').className = 'status ng';
    $('server-status').textContent = '予約の機能に接続できませんでした（今すぐ送るは使えます）。';
    $('sch-list').innerHTML = '<li class="small muted">予約の機能は使えません。</li>';
}
