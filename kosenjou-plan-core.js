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

    // ───────────── 極星器 ─────────────
    // 計画の周回で自然に落ちる本数を出し、欲しい本数があるときは、そのぶんの追加の周回を、計画（整数計画）の中で決める。

    /** log Γ(x)（ランチョスの近似） */
    function lgamma(x) {
        const g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
        if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
        x -= 1;
        let a = c[0]; const t = x + g + 0.5;
        for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
        return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
    }

    /** 二項分布 Bin(n, q) の確率の並び。{ lo, pmf }：lo 本のときの確率から（無視できる両端は、切る。合計が 1 になるようにそろえる） */
    function binomialPmf(n, q) {
        if (!(n > 0) || !(q > 0)) return { lo: 0, pmf: [1] };
        if (q >= 1) return { lo: n, pmf: [1] };
        const mode = Math.min(n, Math.floor((n + 1) * q));                  // いちばん確率の高い本数から、上と下へ広げる（周回数が多くても、桁あふれしない）
        const logp = lgamma(n + 1) - lgamma(mode + 1) - lgamma(n - mode + 1) + mode * Math.log(q) + (n - mode) * Math.log(1 - q);
        const up = [Math.exp(logp)];
        for (let k = mode; k < n; k++) { const v = up[up.length - 1] * (n - k) / (k + 1) * q / (1 - q); if (v < 1e-18) break; up.push(v); }
        const down = [];
        for (let k = mode; k > 0; k--) { const v = (down.length ? down[down.length - 1] : up[0]) * k / (n - k + 1) * (1 - q) / q; if (v < 1e-18) break; down.push(v); }
        const pmf = down.slice().reverse().concat(up);
        const sum = pmf.reduce((a, b) => a + b, 0);
        return { lo: mode - down.length, pmf: pmf.map((v) => v / sum) };
    }

    /** 極星器の本数の分布（ポアソン二項分布）：難易度ごとに確率が違うので、難易度ごとの二項分布を、動的計画法（たたみ込み）で足し合わせる。groups: [{ n: 周回数, q: 1周の確率 }] */
    function starPmf(groups) {
        let acc = { lo: 0, pmf: [1] };
        for (const g of groups) {
            const b = binomialPmf(g.n, g.q);
            const out = new Array(acc.pmf.length + b.pmf.length - 1).fill(0);
            for (let i = 0; i < acc.pmf.length; i++) { const a = acc.pmf[i]; if (a === 0) continue; for (let j = 0; j < b.pmf.length; j++) out[i + j] += a * b.pmf[j]; }
            acc = { lo: acc.lo + b.lo, pmf: out };
        }
        return acc;
    }

    /**
     * 極星器の本数：期待値 mean・「90%の確率で ◯本以上」n90（下から 10% の点。n90 本以上になる確率が 90% 以上で、n90 + 1 本以上では 90% 未満）・k 本以上になる確率 pAtLeast。
     * runsById: { 難易度の id: 周回数 }　q: { 難易度の id: 1周の確率（0〜1） }（確率不明の難易度は、入れない = 数えない）
     */
    function starStats(runsById, q, k) {
        const groups = Object.keys(runsById).filter((id) => q[id] > 0 && runsById[id] > 0).map((id) => ({ n: runsById[id], q: q[id] }));
        const mean = groups.reduce((a, g) => a + g.n * g.q, 0);
        const { lo, pmf } = starPmf(groups);
        let cdf = 0, n90 = lo + pmf.length - 1;
        for (let i = 0; i < pmf.length; i++) { cdf += pmf[i]; if (cdf > 0.1) { n90 = lo + i; break; } }
        let pAtLeast = null;
        if (k != null) { let below = 0; for (let i = 0; i < pmf.length && lo + i < k; i++) below += pmf[i]; pAtLeast = Math.max(0, 1 - below); }
        return { mean, n90, pAtLeast };
    }

    /** 平均 λ のポアソン分布で、n 本以上になる確率が 90% になる λ（二分探索）。ポアソン二項分布より、ばらつきが大きいので、必要な平均の「多めの目安」 */
    function poissonMean90(n) {
        const tail = (lam) => { let term = Math.exp(-lam), cdf = 0; for (let k = 0; k < n; k++) { cdf += term; term *= lam / (k + 1); } return 1 - cdf; };
        let lo = n, hi = n + 10 * Math.sqrt(n) + 10;
        for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (tail(mid) >= 0.9) hi = mid; else lo = mid; }
        return hi;
    }

    /** トレハンタブの設定（env.trehun）から、難易度ごとの、1周で極星器が落ちる確率 q（0〜1）。確率不明の難易度（箱の基本率のデータがない）は、q に入れず、unknown に入れる */
    function starProbs(trehun, HELL) {
        const per = (trehun && trehun.perDiff) || {};
        const q = {}, rates = {}, unknown = [];
        HELL.forEach((d) => {
            const r = per[d.id];
            if (r && r.known) { q[d.id] = Math.min(r.item, 100) / 100; rates[d.id] = { box: r.box, item: r.item }; } else unknown.push({ id: d.id, name: d.name });
        });
        return { q, rates, unknown };
    }

    /** 計画（plan）で、難易度ごとに何周するか（全日の合計）と、極星器の本数の見込み */
    function starViewOf(plan, diffsP, sp, core, nWant) {
        const runsById = {};
        core.PHASES.forEach((ph) => diffsP.forEach((d) => { runsById[d.id] = (runsById[d.id] || 0) + ((plan.runs[ph.id] && plan.runs[ph.id][d.id]) || 0); }));
        const st = starStats(runsById, sp.q, nWant > 0 ? Math.ceil(nWant - 1e-9) : null);
        const byDiff = diffsP.filter((d) => runsById[d.id] > 0).map((d) => ({ id: d.id, name: d.name, runs: runsById[d.id], q: sp.q[d.id] != null ? sp.q[d.id] : null, mean: sp.q[d.id] != null ? runsById[d.id] * sp.q[d.id] : null }));
        return { mean: st.mean, n90: st.n90, pAtLeast: st.pAtLeast, byDiff, unknownUsed: byDiff.filter((x) => x.q == null).map((x) => x.name), runsById };
    }

    /** 日ごとのカードに出す計画：いまの肉・素材で足りるとき、必要な肉を求めたときの計画（目標に届く中で、肉が最小）。足りないときは、取れるだけ取る計画 */
    function displayChoice(sc, ctx) {
        const req = sc.req, A = sc.solved.actual;
        const matKnown = ctx.mat250 != null;
        const affordable = !!(req && req.plan && req.meat <= ctx.stock + (matKnown ? 2 * Math.max(0, Math.min(500, ctx.mat250 - req.mat)) : 0) && (!matKnown || req.mat <= ctx.mat250));
        return { affordable, plan: affordable ? req.plan : A.plan, autoHours: affordable ? req.hours : A.hours };
    }

    /** 追加の周回に使う難易度を指定したとき：ほかの難易度の周回は、極星器のない計画（base）の回数を超えないようにする（増やせるのは、指定した難易度だけ） */
    function capsFrom(base, ctx, extraId) {
        const ch = displayChoice(base, ctx);
        const caps = {};
        ctx.core.PHASES.forEach((ph) => base.diffsP.forEach((d) => { if (d.id !== extraId) caps[`${ph.id}|${d.id}`] = (ch.plan.runs[ph.id] && ch.plan.runs[ph.id][d.id]) || 0; }));
        return caps;
    }

    /** 平均の制約 μ を、n から少しずつ上げて解き直し、n 本以上になる確率が 90% 以上になる、最小に近い μ の結果を返す（分布は線形でないので、平均の制約で解く → 確率を計算 → 足りなければ上げる） */
    function raiseUntil90(n, solve, okOf, probOf) {
        const first = solve(n);
        if (!okOf(first) || probOf(first) >= 0.9) return first;
        let lo = n, hi = Math.max(n + 0.5, poissonMean90(n)), resHi = solve(hi);
        for (let g = 0; g < 6 && okOf(resHi) && probOf(resHi) < 0.9; g++) { lo = hi; hi *= 1.25; resHi = solve(hi); }
        if (!okOf(resHi) || probOf(resHi) < 0.9) return Object.assign(first, { p90Unmet: true });       // 90% にできる平均には、上限の時間では届かない：平均で n 本の結果を見せる
        for (let it = 0; it < 4; it++) {
            const mid = (lo + hi) / 2, rm = solve(mid);
            if (okOf(rm) && probOf(rm) >= 0.9) { hi = mid; resHi = rm; } else lo = mid;
        }
        return resHi;
    }

    /** 極星器をたくさん集めたいとき：極星器の本数の制約つきで、計画を解き直す（目標がある）。base は、制約のない試算 */
    function starScenario(core, pr, a) {
        const { diffs, stock, mat250, need, hoursOpt, base, ctx, sp, n, mode } = a;
        const extra = a.extra && a.extra !== 'auto' && sp.q[a.extra] > 0 ? a.extra : null;
        const caps = extra ? capsFrom(base, ctx, extra) : null;
        const solve = (mu) => core.scheduleScenario(pr, { diffs, stock, mat250, need, hoursOpt, star: { n: mu, q: sp.q }, caps, extra });
        if (mode !== 'p90') return solve(n);
        const ok = (sc) => sc.solved.actual.reachable;
        const prob = (sc) => starViewOf(displayChoice(sc, ctx).plan, sc.diffsP, sp, core, n).pAtLeast;
        return raiseUntil90(n, solve, ok, prob);
    }

    /** 目標を決めないとき（時間が決まっている）：極星器の本数の制約つきで、貢献度が最大の計画。starUnmet は、制約を守る計画がないこと */
    function starForwardPlan(core, a) {
        const { diffsP, spec, stock, mat250, sp, n, mode, base, ctx } = a;
        const extra = a.extra && a.extra !== 'auto' && sp.q[a.extra] > 0 ? a.extra : null;
        const caps = extra ? (() => { const c = {}; core.PHASES.forEach((ph) => diffsP.forEach((d) => { if (d.id !== extra) c[`${ph.id}|${d.id}`] = (base.runs[ph.id] && base.runs[ph.id][d.id]) || 0; })); return c; })() : null;
        const phases = core.PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : 0 }));
        const solve = (mu) => core.planSchedule({ stock, mat250, phases, diffs: diffsP, star: { n: mu, q: sp.q }, caps });
        if (mode !== 'p90') return solve(n);
        const prob = (plan) => starViewOf(plan, diffsP, sp, core, n).pAtLeast;
        return raiseUntil90(n, solve, (plan) => !plan.starUnmet, prob);
    }

    /** 肉を集める速さ（個/時間）。「◯分で肉◯個」から */
    function gatherRate(W) {
        const min = num(W.gatherMin), meat = num(W.gatherMeat);
        return min > 0 && meat > 0 ? meat * 60 / min : null;
    }

    /** 時間がなくてもできる逆算：目標までに、各難易度だけで回すと何回・肉（素材）いくつか */
    function countsTable(core, need, times, q) {
        return core.HELL_DIFFS.map((d) => {
            const runs = Math.ceil(need / d.contrib);
            return { id: d.id, name: d.name, runs, meat: d.is250 ? 0 : runs * d.chunks, mat: d.is250 ? runs * d.chunks : 0, sec: times[d.id] > 0 ? runs * times[d.id] : null,
                     stars: q && q[d.id] != null ? runs * q[d.id] : null };                       // その難易度だけで回したときの、極星器の期待本数（確率不明は null）
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
        const { affordable, plan, autoHours } = displayChoice(sc, ctx);
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
            cum += gain;
            if (hours[i] > 0) checkpoints.push({ id: ph.id, name: ph.name, total: ctx.cur + cum });
            days.push({ id: ph.id, name: ph.name, hours: hours[i], fixed: spec[i].fixed, off: !!spec[i].off, noTier: !!spec[i].noTier, parts, gain, meat, mat, idleSec: hours[i] > 0 ? Math.max(0, hours[i] * 3600 - usedSec) : 0 });
        });
        const finalTotal = ctx.cur + cum;
        let shortage = null;
        if (sc.req && ctx.meatKnown) {
            const matKnown = ctx.mat250 != null;
            const haveMeat = ctx.stock + (matKnown ? 2 * Math.max(0, Math.min(500, ctx.mat250 - sc.req.mat)) : 0);
            shortage = { meat: Math.max(0, sc.req.meat - haveMeat), mat: matKnown ? Math.max(0, sc.req.mat - ctx.mat250) : 0 };
        }
        return {
            priority: sc.priority, reachable: A.reachable, hasAuto: solved.hasAuto, autoHours: solved.hasAuto ? autoHours : null, minMeat: affordable, showIdle: !!ctx.goalView,
            idealReach: U.reachable, idealHours: solved.hasAuto && U.reachable ? U.hours : null,
            days, checkpoints, finalTotal, bd: core.hoursByDiff(plan, sc.diffsP), req: sc.req, shortage,
            stars: ctx.sp ? starViewOf(plan, sc.diffsP, ctx.sp, core, ctx.nStar) : null,
            starBlocked: !!A.starBlocked, p90Unmet: !!sc.p90Unmet,
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
        // 極星器：難易度ごとの確率（トレハンタブの設定）と、欲しい本数（「集める」を選んだとき）
        const sp = starProbs(env.trehun, core.HELL_DIFFS);
        const nStar = W.starCollect === 'yes' ? Math.floor(num(W.starText) || 0) : 0;
        const star = { collect: W.starCollect === 'yes', n: nStar, mode: W.starMode === 'p90' ? 'p90' : 'avg', extra: W.starDiff || '', rates: sp.rates, unknown: sp.unknown, anyKnown: Object.keys(sp.q).length > 0 };
        const wantStar = nStar > 0 && star.anyKnown;
        Object.assign(R, { goal, cur, meatKnown, matKnown, meat: meat0, collect, mat250, days, hoursOpt, star, gatherPerHour: gatherRate(W), views: null, forward: null });
        const have = meat0 + collect;
        const stock = meatKnown ? Math.max(0, have) : Infinity;        // 肉が未入力のときは、足りる前提（無制限）で、必要な数を出す

        if (goal.value > 0) {
            R.need0 = Math.max(0, goal.value - cur);
            R.counts = countsTable(core, R.need0, ti.times, sp.q);
            if (R.need0 <= 0) { R.done = true; return R; }
            if (!R.hasTime) return R;
            const ctx = { core, stock, mat250, cur, meatKnown, goalView: true, sp, nStar };
            R.views = {};
            ['time', 'meat'].forEach((pr) => {
                const base = core.scheduleScenario(pr, { diffs, stock, mat250, need: R.need0, hoursOpt });
                const baseView = planView(base, ctx);
                if (!wantStar) { R.views[pr] = baseView; return; }
                const sc = starScenario(core, pr, { diffs, stock, mat250, need: R.need0, hoursOpt, base, ctx, sp, n: nStar, mode: star.mode, extra: star.extra });
                const v = planView(sc, ctx);
                v.base = { reachable: baseView.reachable, autoHours: baseView.autoHours, reqMeat: baseView.req ? baseView.req.meat : null, reqMat: baseView.req ? baseView.req.mat : null, stars: baseView.stars, bd: baseView.bd };
                R.views[pr] = v;
            });
        } else if (goal.kind === 'none' && R.hasTime) {
            const ctx = { core, stock, mat250, cur, meatKnown, sp, nStar };
            R.forward = {};
            ['time', 'meat'].forEach((pr) => {
                const diffsP0 = core.allowedDiffs(diffs, pr);
                const extra = star.extra && star.extra !== 'auto' && sp.q[star.extra] > 0 ? star.extra : null;
                const exDiff = extra && !diffsP0.some((d) => d.id === extra) ? diffs.find((d) => d.id === extra && d.time > 0) : null;
                const planOf = (diffsP, withStar) => {
                    const spec = core.scheduleHoursSpec(diffsP, hoursOpt);
                    const phases = core.PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : 0 }));
                    return { spec, phases, plan: core.planSchedule({ stock, mat250, phases, diffs: diffsP }) };
                };
                const base = planOf(diffsP0);
                let diffsP = diffsP0, spec = base.spec, plan = base.plan, starUnmet = false;
                if (wantStar) {
                    diffsP = exDiff ? [...diffsP0, { ...exDiff, extra: true }] : diffsP0;
                    spec = core.scheduleHoursSpec(diffsP, hoursOpt);
                    const sp2 = starForwardPlan(core, { diffsP, spec, stock, mat250, sp, n: nStar, mode: star.mode, extra: star.extra, base: base.plan, ctx });
                    if (sp2.starUnmet) starUnmet = true; else plan = sp2;
                    if (starUnmet) { diffsP = diffsP0; spec = base.spec; }
                }
                const sc = { priority: pr, diffsP, spec, req: null, solved: { hasAuto: false, actual: { reachable: true, hours: 0, plan }, unlimited: { reachable: true, hours: 0, plan } } };
                const v = planView(sc, ctx);
                const use = core.scheduleUsage(plan, diffsP, stock, mat250);
                v.use = { meat: use.meat, mat: use.mat };
                v.starUnmet = starUnmet;
                v.rank = rankEstimate(v.finalTotal, env.points);
                R.forward[pr] = v;
            });
        }
        return R;
    }

    global.PlanCore = { DAYS, num, int0, blank, runsForCount, effectiveTimes, resolveGoal, dayStates, hoursOptFrom, starProbs, starStats, starPmf, binomialPmf, poissonMean90, starViewOf, displayChoice, capsFrom, starScenario, gatherRate, countsTable, rankEstimate, planView, compute };
})(typeof self !== 'undefined' ? self : globalThis);
