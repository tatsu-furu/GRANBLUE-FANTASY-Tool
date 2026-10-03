// Discord リマインド：ページ（remind.js）と送信サーバー（netlify/functions/discord-dispatch.mjs）で共有する計算
// ・時刻はすべて日本時間（JST）で扱う。保存するのはミリ秒のエポック値
// ・Webhook の URL は discord.com / discordapp.com のものだけ受け付ける

export const DAY = 24 * 60 * 60 * 1000;
const JST = 9 * 60 * 60 * 1000;

export const LIMITS = {
    content: 1800, // Discord の上限 2000 からメンションの分を引いた余裕
    username: 80,
    title: 40,
    perUser: 20, // 1人（ブラウザ）あたりの予約数
};

export const WEBHOOK_RE = /^https:\/\/(?:ptb\.|canary\.)?(?:discord|discordapp)\.com\/api\/webhooks\/(\d{17,20})\/([\w-]{20,})$/;

export function isWebhookUrl(url) {
    return WEBHOOK_RE.test(String(url || '').trim());
}

/** 日本時間の「YYYY-MM-DD」と「HH:MM」→ エポック（ミリ秒） */
export function jstToEpoch(date, time) {
    const [y, m, d] = String(date).split('-').map(Number);
    const [hh, mm] = String(time || '00:00').split(':').map(Number);
    if (!y || !m || !d || Number.isNaN(hh) || Number.isNaN(mm)) return NaN;
    return Date.UTC(y, m - 1, d, hh, mm) - JST;
}

/** エポック → 日本時間の各部分 */
export function jstParts(epoch) {
    const t = new Date(epoch + JST);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), hh: t.getUTCHours(), mm: t.getUTCMinutes(), wd: t.getUTCDay() };
}

export function fmtJst(epoch) {
    const p = jstParts(epoch);
    const w = '日月火水木金土'[p.wd];
    return `${p.m}/${p.d}(${w}) ${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`;
}

/**
 * 次に送る時刻。after より後で最初のもの。終わっていれば null。
 * repeat: 'none' | 'daily' | 'weekly'
 */
export function nextOccurrence(r, after) {
    const step = r.repeat === 'daily' ? DAY : r.repeat === 'weekly' ? 7 * DAY : 0;
    let t = r.nextAt;
    if (!step) return t > after ? t : null;
    if (t <= after) t += Math.ceil((after - t + 1) / step) * step;
    if (r.endAt && t > r.endAt) return null;
    return t;
}

/** 本文の差し込み：{day} = 何日目（startAt の日を1日目）、{date} = 月/日 */
export function renderContent(r, at) {
    const start = r.startAt || r.nextAt || at;
    const day = Math.floor((at + JST) / DAY) - Math.floor((start + JST) / DAY) + 1;
    const p = jstParts(at);
    return String(r.content || '')
        .replace(/\{day\}/g, String(day))
        .replace(/\{date\}/g, `${p.m}/${p.d}`);
}

/** メンションの指定 → 先頭に付ける文字列と allowed_mentions */
export function mentionOf(mention) {
    if (mention === 'everyone') return { prefix: '@everyone ', allowed: { parse: ['everyone'] } };
    if (mention === 'here') return { prefix: '@here ', allowed: { parse: ['everyone'] } };
    const role = /^role:(\d{17,20})$/.exec(mention || '');
    if (role) return { prefix: `<@&${role[1]}> `, allowed: { parse: [], roles: [role[1]] } };
    // それ以外はメンションを一切飛ばさない（本文に @everyone と書かれていても通知しない）
    return { prefix: '', allowed: { parse: [] } };
}

/** Discord に送る JSON */
export function buildPayload({ content, mention, username }) {
    const m = mentionOf(mention);
    const body = (m.prefix + String(content || '')).slice(0, 2000);
    return {
        content: body,
        username: String(username || 'GBF Tool リマインド').slice(0, LIMITS.username),
        allowed_mentions: m.allowed,
    };
}

/** 予約データの検査（ページとサーバーの両方で使う）。問題があれば理由の文字列 */
export function validateReminder(r) {
    if (!r || typeof r !== 'object') return '予約の形式が正しくありません';
    if (!isWebhookUrl(r.webhook)) return 'Webhook の URL が正しくありません';
    if (!r.content || String(r.content).trim() === '') return '本文が空です';
    if (String(r.content).length > LIMITS.content) return `本文は ${LIMITS.content} 文字までです`;
    if (!['none', 'daily', 'weekly'].includes(r.repeat)) return '繰り返しの指定が正しくありません';
    if (!Number.isFinite(r.nextAt)) return '日時が正しくありません';
    if (r.endAt != null && !(Number.isFinite(r.endAt) && r.endAt >= r.nextAt)) return '終了日が開始より前です';
    return null;
}
