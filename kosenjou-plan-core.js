/**
 * 古戦場ツール：かんたん計画の計算（画面に触らない部分）
 *
 * 入力（W：かんたん計画の状態、env：ボーダーの値・トレハンの確率・討伐時間）から、画面に出す結果（R）をすべて計算する。
 * ページ（kosenjou-plan.js）と、Web Worker（kosenjou-worker.js）の、どちらでも動く。
 * 必要なもの：kosenjou-data.js・kosenjou-schedule.js（グローバルの定数・関数）。DOM・localStorage には触らない。
 *   env … { rows, points, trehun, killTimes }（JSON にできる値だけ）
 * 同じ入力からは、どこで計算しても、同じ結果になる。
 */
(function (global) {
    'use strict';

    const DAYS = ['d1', 'd2', 'd3', 'd4'];
    const num = (t) => { const s = String(t == null ? '' : t).normalize('NFKC').replace(/[,\s]/g, ''); if (!s) return null; const v = Number(s); return Number.isFinite(v) ? v : null; };
    const int0 = (t) => Math.max(0, Math.floor(num(t) || 0));
    const blank = (t) => String(t == null ? '' : t).trim() === '';

    /** 計算が使う部品：Worker でも、ページでも、同じ名前のグローバル（kosenjou-data.js・kosenjou-schedule.js）から集める */
    function engineCore(env) {
        return { HELL_DIFFS, PHASES, DAY_MAX_HOURS, tierOf, planDiffsFrom, parseGoal, planSchedule, allowedDiffs, scheduleHoursSpec, scheduleScenario, scheduleUsage, hoursByDiff, getKillTimes: () => env.killTimes || {} };
    }

    // ───────────── 計算（画面と切り離して、テストできるように） ─────────────

    /** 1周で落ちる確率が q（0〜1）のとき、n 個以上落ちる確率が conf 以上になる、最小の周回数（二項分布） */
    function runsForCount(q, n, conf) {
        if (!(q > 0)) return Infinity;
        if (q >= 1) return n;
        const tail = (R) => {                                         // P(X ≥ n) = 1 − Σ_{k<n} C(R,k) q^k (1−q)^(R−k)
            let term = Math.pow(1 - q, R), cdf = 0;
            for (let k = 0; k < n; k++) { cdf += term; term *= (R - k) / (k + 1) * q / (1 - q); }
            return 1 - cdf;
        };
        let lo = n, hi = Math.max(n, Math.ceil(n / q * 3) + 50);
        while (tail(hi) < conf && hi < 1e8) hi *= 2;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (tail(mid) >= conf) hi = mid; else lo = mid + 1; }
        return lo;
    }

    /** 計算に使う討伐時間（秒）。しっかり入力 = 討伐効率タブの時間。1つだけ = 入れた1つ＋それより上の難易度を同じ効率で推定。ざっくり = ◯分で◯回から */
    function effectiveTimes(W, core) {
        const HELL = core.HELL_DIFFS;
        const times = {}, estimated = [];
        let base = null;
        if (W.timeMode === 'rough') {
            HELL.forEach((d) => {
                const r = W.rough[d.id], runs = num(r && r.runs);
                const min = num(r && r.min) != null ? num(r.min) : (d.is250 ? 30 : 5);     // 分が空なら、入力欄に薄く出ている値
                if (min > 0 && runs > 0) times[d.id] = min * 60 / runs;
            });
        } else if (W.timeMode === 'one') {
            const sec = (num(W.oneMin) || 0) * 60 + (num(W.oneSec) || 0);
            const b = HELL.find((d) => d.id === W.oneId);
            if (b && sec > 0) {
                base = b; times[b.id] = sec;
                const perSec = b.contrib / sec;
                HELL.forEach((d) => { if (d !== b && core.tierOf(d) > core.tierOf(b)) { times[d.id] = d.contrib / perSec; estimated.push(d.id); } });   // 丸めない（効率がずれないように）
            }
        } else {
            const kt = core.getKillTimes();
            HELL.forEach((d) => { if (kt[d.id] > 0) times[d.id] = kt[d.id]; });
        }
        return { times, estimated, base, mode: W.timeMode };
    }

    function resolveGoal(W, core, rows) {
        if (W.goalKind === 'none') return { kind: 'none', value: null };
        if (W.goalKind === 'rank') {
            const row = rows.find((r) => r.rank === W.goalRank);
            const value = row ? (row.final != null ? row.final : row.current) : null;
            return value > 0 ? { kind: 'rank', value, label: row.label, basis: row.final != null ? 'final' : 'current' } : { kind: 'rank', value: null, missing: true };
        }
        if (blank(W.goalText)) return { kind: 'number', value: null, empty: true };
        const v = core.parseGoal(W.goalText);
        return v > 0 ? { kind: 'number', value: v } : { kind: 'number', value: null, invalid: true };
    }

    /** 本戦の4日の状態：終わった日（past）・今日（now）・これから */
    function dayStates(W) {
        const idx = W.where === 'pre' ? -1 : DAYS.indexOf(W.where);
        return DAYS.map((id, i) => ({ id, past: i < idx, now: i === idx, mark: W.marks[id] || 'o', typed: W.hours[id] }));
    }

    /** 日ごとの時間（数 = 固定、null = 自動）。終わった日・×の日は 0。目標がなければ、○の日は「ふつうの日の時間」 */
    function hoursOptFrom(W, hasGoal, days) {
        const hours = { q: null };
        days.forEach((d) => {
            let h;
            const typed = W.detail ? num(d.typed) : null;
            if (d.past) h = 0;
            else if (typed != null && typed >= 0) h = typed;
            else if (d.mark === 'x') h = 0;
            else if (d.mark === 't') h = num(W.triHours) != null ? Math.max(0, num(W.triHours)) : 3;
            else h = hasGoal ? null : (num(W.normalHours) != null ? Math.max(0, num(W.normalHours)) : 4);
            hours[d.id] = h;
        });
        return { includeQ: false, hours };
    }

    /** 極星器：欲しい本数 → 周回する難易度（トレハンの設定）の周回数・時間・肉・貢献度 */
    function starInfo(W, core, trehun, times) {
        const n = Math.floor(num(W.starText) || 0);
        if (n <= 0) return null;
        const d = trehun ? core.HELL_DIFFS.find((x) => x.id === trehun.diff) : null;
        const p = trehun ? trehun.item : 0;
        if (!d) return { n, error: '周回する難易度が決まっていません（トレハンタブで選べます）' };
        if (!(p > 0)) return { n, diff: d, p, error: 'ドロップ率が 0% です（トレハンタブの設定を確かめてください）' };
        const q = Math.min(p, 100) / 100;
        const runsAvg = Math.ceil(n / q), runs90 = runsForCount(q, n, 0.9);
        const runs = W.starMode === 'p90' ? runs90 : runsAvg;
        const secPer = times[d.id] > 0 ? times[d.id] : null;
        return { n, diff: d, p, box: trehun.box, itemRate: trehun.itemRate, runsAvg, runs90, runs, secPer, sec: secPer ? runs * secPer : null,
                 meat: d.is250 ? 0 : runs * d.chunks, mat: d.is250 ? runs * d.chunks : 0, contrib: runs * d.contrib };
    }

    /** 極星器の周回を入れる日：使える日（終わっていない・×でない・解放済み）のうち、自動の○の日。なければ、使える日 */
    function starPlacement(star, days, hoursOpt, core) {
        if (!star || star.error || !(star.sec > 0)) return null;
        const maxTier = (id) => core.PHASES.find((p) => p.id === id).maxTier;
        const ok = days.filter((d) => !d.past && hoursOpt.hours[d.id] !== 0 && core.tierOf(star.diff) <= maxTier(d.id));
        const autos = ok.filter((d) => hoursOpt.hours[d.id] == null);
        const target = autos.length ? autos : ok;
        if (!target.length) return { days: [], perDay: 0, perDayContrib: 0 };
        return { days: target.map((d) => d.id), perDay: star.sec / target.length, perDayContrib: star.contrib / target.length };
    }

    /** 肉を集める速さ（個/時間）。「◯分で肉◯個」から */
    function gatherRate(W) {
        const min = num(W.gatherMin), meat = num(W.gatherMeat);
        return min > 0 && meat > 0 ? meat * 60 / min : null;
    }

    /** 時間がなくてもできる逆算：目標までに、各難易度だけで回すと何回・肉（素材）いくつか */
    function countsTable(core, need, times) {
        return core.HELL_DIFFS.map((d) => {
            const runs = Math.ceil(need / d.contrib);
            return { id: d.id, name: d.name, runs, meat: d.is250 ? 0 : runs * d.chunks, mat: d.is250 ? runs * d.chunks : 0, sec: times[d.id] > 0 ? runs * times[d.id] : null };
        });
    }

    /** 貢献度から、順位の目安（ボーダーの点を、対数で結ぶ）。pts: [{ rank, value }]（順位の昇順） */
    function rankEstimate(value, pts) {
        if (!pts.length || !(value > 0)) return null;
        const fmt = (r) => {
            const n = r < 1000 ? Math.round(r / 10) * 10 : r < 10000 ? Math.round(r / 100) * 100 : Math.round(r / 1000) * 1000;
            return n >= 10000 ? `${(n / 10000).toLocaleString(undefined, { maximumFractionDigits: 1 })}万位` : `${Math.max(1, n).toLocaleString()}位`;
        };
        if (value >= pts[0].value) return { text: `${pts[0].rank.toLocaleString()}位以内`, rank: pts[0].rank };
        const last = pts[pts.length - 1];
        if (value < last.value) return { text: `${last.rank >= 10000 ? `${last.rank / 10000}万` : last.rank.toLocaleString()}位より下`, rank: last.rank * 1.5 };
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i], b = pts[i + 1];
            if (value <= a.value && value >= b.value) {
                const t = a.value === b.value ? 0 : (Math.log(a.value) - Math.log(value)) / (Math.log(a.value) - Math.log(b.value));
                const rank = Math.exp(Math.log(a.rank) + t * (Math.log(b.rank) - Math.log(a.rank)));
                return { text: `約 ${fmt(rank)}`, rank };
            }
        }
        return null;
    }

    /**
     * 1つの優先の試算（scheduleScenario の結果）を、画面に出す形にまとめる。
     * 日ごとのカード（days）は、いまの肉・素材で足りるとき、「目標に届く中で、肉が最小の計画」（必要な肉を求めたときの解 req.plan）を出す。
     * 足りないときは、いまの肉・素材で取れるだけ取る計画（actual.plan）。日ごとに、使わなかった時間（余裕）も出す
     */
    function planView(sc, ctx) {
        const core = ctx.core;
        const solved = sc.solved, A = solved.actual, U = solved.unlimited;
        const spec = sc.spec;
        const req = sc.req;
        const matKnown0 = ctx.mat250 != null;
        const affordable = !!(req && req.plan && req.meat <= ctx.stock + (matKnown0 ? 2 * Math.max(0, Math.min(500, ctx.mat250 - req.mat)) : 0) && (!matKnown0 || req.mat <= ctx.mat250));
        const plan = affordable ? req.plan : A.plan;
        const autoHours = affordable ? req.hours : A.hours;
        const hours = spec.map((s) => (s.fixed ? s.hours : (solved.hasAuto ? autoHours : 0)));
        const days = [];
        let cum = 0;
        const checkpoints = [];
        core.PHASES.forEach((ph, i) => {
            if (ph.id === 'q') return;
            const parts = [];
            let meat = 0, mat = 0, gain = 0;
            let usedSec = 0;
            sc.diffsP.forEach((d) => {
                const n = plan.runs[ph.id][d.id] || 0;
                if (!n) return;
                parts.push({ name: d.name, runs: n });
                gain += n * d.contrib;
                usedSec += n * d.time;
                if (d.is250) mat += n * d.chunks; else meat += n * d.chunks;
            });
            cum += gain + (ctx.extra[ph.id] || 0);
            if (hours[i] > 0 || (ctx.extra[ph.id] || 0) > 0) checkpoints.push({ id: ph.id, name: ph.name, total: ctx.cur + cum });
            days.push({ id: ph.id, name: ph.name, hours: hours[i], fixed: spec[i].fixed, off: !!spec[i].off, noTier: !!spec[i].noTier, parts, gain, meat, mat, idleSec: hours[i] > 0 ? Math.max(0, hours[i] * 3600 - usedSec) : 0 });
        });
        const finalTotal = ctx.cur + cum;
        let shortage = null;
        if (sc.req && ctx.meatKnown) {
            const matKnown = ctx.mat250 != null;
            const haveMeat = ctx.stock + (matKnown ? 2 * Math.max(0, Math.min(500, ctx.mat250 - sc.req.mat)) : 0);
            shortage = { meat: Math.max(0, sc.req.meat - haveMeat) + ctx.starDeficit, mat: matKnown ? Math.max(0, sc.req.mat - ctx.mat250) : 0 };
        }
        return {
            priority: sc.priority, reachable: A.reachable, hasAuto: solved.hasAuto, autoHours: solved.hasAuto ? autoHours : null, minMeat: affordable, showIdle: !!ctx.goalView,
            idealReach: U.reachable, idealHours: solved.hasAuto && U.reachable ? U.hours : null,
            days, checkpoints, finalTotal, bd: core.hoursByDiff(plan, sc.diffsP), req: sc.req, shortage,
        };
    }

    /** 入力から、画面に出す結果をすべて計算する */
    function compute(W, env) {
        const core = env.core || engineCore(env);                      // ページ（KJ_CORE）か、グローバル（Worker など）から
        const R = { W };
        const ti = effectiveTimes(W, core);
        const diffs = core.planDiffsFrom(ti.times, ti.estimated);
        Object.assign(R, { ti, diffs, hasTime: diffs.some((d) => d.time > 0) });
        const goal = resolveGoal(W, core, env.rows);
        const cur = core.parseGoal(W.curText) || 0;
        const meatKnown = !blank(W.meatText), matKnown = !blank(W.matText);
        const meat0 = int0(W.meatText), collect = int0(W.collectText);
        const mat250 = matKnown ? int0(W.matText) : null;
        const days = dayStates(W);
        const hoursOpt = hoursOptFrom(W, goal.value > 0, days);
        const star = starInfo(W, core, env.trehun, ti.times);
        const starOk = star && !star.error ? star : null;
        const placement = starPlacement(starOk, days, hoursOpt, core);
        const extra = {};
        if (placement) placement.days.forEach((id) => { extra[id] = placement.perDayContrib; });
        Object.assign(R, { goal, cur, meatKnown, matKnown, meat: meat0, collect, mat250, days, hoursOpt, star, placement, gatherPerHour: gatherRate(W), views: null, forward: null });

        if (goal.value > 0) {
            R.need0 = Math.max(0, goal.value - cur);
            R.counts = countsTable(core, R.need0, ti.times);
            if (R.need0 <= 0) { R.done = true; return R; }
            R.needLeft = R.need0 - (starOk ? starOk.contrib : 0);
            if (R.needLeft <= 0) { R.starCovers = true; return R; }
            if (!R.hasTime) return R;
            const have = meat0 + collect;
            const stock = meatKnown ? Math.max(0, have - (starOk ? starOk.meat : 0)) : Infinity;     // 肉が未入力のときは、足りる前提（無制限）で、必要な数を出す
            const ctx = { core, stock, mat250, cur, extra, meatKnown, starDeficit: meatKnown && starOk ? Math.max(0, starOk.meat - have) : 0, goalView: true };
            R.views = {};
            ['time', 'meat'].forEach((pr) => {
                R.views[pr] = planView(core.scheduleScenario(pr, { diffs, stock, mat250, need: R.needLeft, hoursOpt }), ctx);
            });
        } else if (goal.kind === 'none' && R.hasTime) {
            const have = meat0 + collect;
            const stock = meatKnown ? Math.max(0, have - (starOk ? starOk.meat : 0)) : Infinity;
            const ctx = { core, stock, mat250, cur, extra, meatKnown, starDeficit: 0 };
            R.forward = {};
            ['time', 'meat'].forEach((pr) => {
                const diffsP = core.allowedDiffs(diffs, pr);
                const spec = core.scheduleHoursSpec(diffsP, hoursOpt);
                const phases = core.PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : 0 }));
                const plan = core.planSchedule({ stock, mat250, phases, diffs: diffsP });
                const sc = { priority: pr, diffsP, spec, req: null, solved: { hasAuto: false, actual: { reachable: true, hours: 0, plan }, unlimited: { reachable: true, hours: 0, plan } } };
                const v = planView(sc, ctx);
                const use = core.scheduleUsage(plan, diffsP, stock, mat250);
                v.use = { meat: use.meat + (starOk ? starOk.meat : 0), mat: use.mat };
                v.rank = rankEstimate(v.finalTotal, env.points);
                R.forward[pr] = v;
            });
        }
        return R;
    }

    global.PlanCore = { DAYS, num, int0, blank, runsForCount, effectiveTimes, resolveGoal, dayStates, hoursOptFrom, starInfo, starPlacement, gatherRate, countsTable, rankEstimate, planView, compute };
})(typeof self !== 'undefined' ? self : globalThis);
