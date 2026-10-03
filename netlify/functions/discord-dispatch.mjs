// Discord リマインドの送信サーバー（Netlify の Scheduled Function・5分ごと）
//
// Firebase Realtime Database の reminderQueue から「時刻が来た予約」を取り出し、Discord の Webhook に送る。
// 送ったら次の時刻に進める（繰り返しがなければ終了）。結果は reminderStatus/lastRun に記録し、ページに稼働状況を出す。
//
// Netlify の環境変数（Site configuration → Environment variables）:
//   FIREBASE_DB_URL            例: https://gbf-tool-3a205-default-rtdb.asia-southeast1.firebasedatabase.app
//   FIREBASE_SERVICE_ACCOUNT   Firebase のサービスアカウントの JSON（そのまま、または base64）
//   （どちらかが無ければ何もしない）
import { createSign } from 'node:crypto';
import { LIMITS, buildPayload, nextOccurrence, renderContent, validateReminder } from '../../remind-core.js';

const GRACE = 30 * 60 * 1000; // 遅れてもこの時間以内なら送る（サーバーが止まっていた場合など）
const BATCH = 50;

export const config = { schedule: '*/5 * * * *' };

export default async () => {
    try {
        const result = await dispatch(fromEnv());
        return new Response(JSON.stringify(result), { headers: { 'content-type': 'application/json' } });
    } catch (e) {
        console.error(e);
        return new Response(String(e && e.message), { status: 500 });
    }
};

function fromEnv() {
    const env = process.env;
    return {
        dbUrl: env.FIREBASE_DB_URL,
        serviceAccount: env.FIREBASE_SERVICE_ACCOUNT,
        // テスト用：エミュレーターと、Discord の代わりのサーバー
        emulatorNs: env.FIREBASE_EMULATOR_NS,
        discordBase: env.DISCORD_TEST_BASE,
    };
}

/* ---------- Firebase（REST） ---------- */

async function accessToken(serviceAccount) {
    const sa = JSON.parse(serviceAccount.trim().startsWith('{') ? serviceAccount : Buffer.from(serviceAccount, 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
    })}`;
    const sig = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
    });
    if (!res.ok) throw new Error(`token: ${res.status} ${await res.text()}`);
    return (await res.json()).access_token;
}

function makeDb({ dbUrl, token, emulatorNs }) {
    const base = dbUrl.replace(/\/$/, '');
    const url = (path, query = {}) => {
        const q = new URLSearchParams(query);
        if (emulatorNs) q.set('ns', emulatorNs);
        return `${base}/${path}.json${q.toString() ? `?${q}` : ''}`;
    };
    const headers = { Authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const call = async (method, path, body, query) => {
        const res = await fetch(url(path, query), { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
        if (!res.ok) throw new Error(`firebase ${method} ${path}: ${res.status} ${await res.text()}`);
        return res.json();
    };
    return {
        get: (path, query) => call('GET', path, undefined, query),
        update: (path, body) => call('PATCH', path, body),
        set: (path, body) => call('PUT', path, body),
    };
}

/* ---------- 送信 ---------- */

/** 1回分の送信。戻り値: 'sent' | 'retry'（あとでもう一度） | エラーの説明（止める） */
async function send(r, at, discordBase) {
    const payload = buildPayload({ content: renderContent(r, at), mention: r.mention, username: r.username });
    let url = `${r.webhook.trim()}?wait=true`;
    if (discordBase) url = url.replace(/^https:\/\/[^/]+/, discordBase);
    let res;
    try {
        res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    } catch {
        return 'retry';
    }
    if (res.ok) return 'sent';
    if (res.status === 429 || res.status >= 500) return 'retry';
    if (res.status === 401 || res.status === 403 || res.status === 404) return 'Webhook が削除されたか、無効になっています';
    return `Discord に送れませんでした（${res.status}）`;
}

export async function dispatch(opts, now = Date.now()) {
    if (!opts.dbUrl || !(opts.serviceAccount || opts.emulatorNs)) return { skipped: 'not configured' };
    const token = opts.emulatorNs ? 'owner' : await accessToken(opts.serviceAccount);
    const db = makeDb({ dbUrl: opts.dbUrl, token, emulatorNs: opts.emulatorNs });
    const due = (await db.get('reminderQueue', { orderBy: '"nextAt"', endAt: String(now), limitToFirst: String(BATCH) })) || {};
    const perUser = new Map();
    let sent = 0;
    let failed = 0;
    for (const [id, q] of Object.entries(due)) {
        const uid = q && q.uid;
        const path = `reminders/${uid}/${id}`;
        const r = uid ? await db.get(path) : null;
        // 本体が無い・止めてある予約は列から外すだけ
        if (!r || r.enabled === false) {
            await db.update('', { [`reminderQueue/${id}`]: null });
            continue;
        }
        const count = (perUser.get(uid) || 0) + 1;
        perUser.set(uid, count);
        if (count > LIMITS.perUser) continue;
        const bad = validateReminder(r);
        if (bad) {
            await db.update('', { [`${path}/enabled`]: false, [`${path}/lastError`]: bad, [`reminderQueue/${id}`]: null });
            failed++;
            continue;
        }
        const at = r.nextAt;
        let outcome = 'skipped';
        if (now - at <= GRACE) outcome = await send(r, at, opts.discordBase);
        if (outcome === 'retry' && now - at <= GRACE) continue;
        const updates = {};
        if (outcome === 'sent' || outcome === 'skipped' || outcome === 'retry') {
            if (outcome === 'sent') {
                updates[`${path}/lastSentAt`] = now;
                updates[`${path}/lastError`] = null;
                sent++;
            } else updates[`${path}/lastError`] = '送信の時刻を過ぎていたため、この回は送りませんでした';
            const next = nextOccurrence(r, now);
            if (next) {
                updates[`${path}/nextAt`] = next;
                updates[`reminderQueue/${id}`] = { uid, nextAt: next };
            } else {
                updates[`${path}/enabled`] = false;
                updates[`${path}/done`] = true;
                updates[`reminderQueue/${id}`] = null;
            }
        } else {
            // 送れない理由がはっきりしているものは止める
            updates[`${path}/enabled`] = false;
            updates[`${path}/lastError`] = outcome;
            updates[`reminderQueue/${id}`] = null;
            failed++;
        }
        await db.update('', updates);
    }
    await db.set('reminderStatus', { lastRun: now, sent, failed });
    return { due: Object.keys(due).length, sent, failed };
}
