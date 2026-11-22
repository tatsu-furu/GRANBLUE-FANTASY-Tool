/**
 * 古戦場ツール：スケジュール計算（画面に触らない計算だけ）
 *
 * kosenjou.html・kosenjou-beta.html・かんたん計画（kosenjou-plan.js）・テストが、同じ計算を使う。
 * ふつうの <script src> で読み込む（関数と定数は、そのままグローバルになる）。
 * DOM・localStorage・ほかのファイルには依存しない（必要なのは performance だけ）。
 *
 * 入口：
 *   scheduleScenario(priority, { diffs, stock, mat250, need, hoursOpt }) … 優先（'time' | 'meat'）ごとの試算
 *   planSchedule({ stock, mat250, phases, diffs, target, lpOnly, maxNodes, deadline }) … 回数の割り振り
 *   diffs    … [{ id, name, tier, contrib, chunks, is250, time, only }]（討伐時間 time は秒。ページの planDiffsFrom で作る）
 *   hoursOpt … { includeQ, hours: { q, d1, d2, d3, d4 } }（数・数の文字列 = 固定、null か空 = 自動）
 */

// 予選・インターバルは 90・95HELL、本戦1日目に 100・150HELL、2日目に 200HELL、3日目に 250HELL が使えるようになる。本戦は 1日 最大17時間
const PHASES = [
    { id:'q',  name:'予選・インターバル', maxTier:95  },
    { id:'d1', name:'本戦1日目',          maxTier:150 },
    { id:'d2', name:'本戦2日目',          maxTier:200 },
    { id:'d3', name:'本戦3日目',          maxTier:250 },
    { id:'d4', name:'本戦4日目',          maxTier:250 },
];
const DAY_MAX_HOURS = 17;                                              // 本戦の 1日に遊べる時間の上限
// その日（ph）に、その難易度（d）を使えるか：討伐時間が入っていて、解放済みで、「この日だけ」の指定（only）があれば、その日であること
const usableIn = (d, ph) => d.time > 0 && d.tier <= ph.maxTier && (!d.only || d.only.includes(ph.id));

/** 単体法（最大化）：max c·x  ただし A x ≤ b, x ≥ 0。b ≥ 0 なら x = 0 から始められる。変数も式も少ないので、素朴な表で解く */
function simplexMax(c, A, b) {
    const m = A.length, n = c.length, W = n + m + 1, EPS = 1e-9;
    const T = A.map((row, i) => [...row, ...Array.from({ length: m }, (_, j) => (i === j ? 1 : 0)), b[i]]);
    const z = [...c.map(v => -v), ...new Array(m + 1).fill(0)];
    const basis = Array.from({ length: m }, (_, i) => n + i);
    for (let iter = 0; iter < 20000; iter++) {
        let col = -1;
        for (let j = 0; j < n + m; j++) if (z[j] < -EPS) { col = j; break; }      // Bland の決まり（同点は番号の小さい方）
        if (col < 0) break;
        let row = -1, best = Infinity;
        for (let i = 0; i < m; i++) {
            if (T[i][col] <= EPS) continue;
            const r = T[i][W - 1] / T[i][col];
            if (r < best - EPS || (Math.abs(r - best) <= EPS && basis[i] < basis[row])) { best = r; row = i; }
        }
        if (row < 0) return { unbounded: true };
        const pv = T[row][col];
        for (let j = 0; j < W; j++) T[row][j] /= pv;
        for (let i = 0; i < m; i++) {
            if (i === row) continue;
            const f = T[i][col];
            if (f !== 0) for (let j = 0; j < W; j++) T[i][j] -= f * T[row][j];
        }
        const f = z[col];
        for (let j = 0; j < W; j++) z[j] -= f * T[row][j];
        basis[row] = col;
    }
    const x = new Array(n).fill(0);
    basis.forEach((bv, i) => { if (bv < n) x[bv] = T[i][W - 1]; });
    return { x, value: z[W - 1] };
}

/**
 * 整数計画（分枝限定法）：max c·x  ただし A x ≤ b、x は 0 以上の整数。
 * 線形計画（simplexMax）で、その枝で出せる貢献度の上限を出し、上限が、いまの解より良くならない枝は、調べない。
 * 分数になった変数で、「その整数以下」と「その整数 + 1 以上」の 2 つの枝に分ける（下限は、変数をずらして表す）。
 * start は、すでにある整数解（これより良い解だけ探す）。右辺が負になる枝は、負の係数の変数（素材からの変換）を上げて直し、直せなければ、解なし。
 *   opts … { g: 目的の最小の刻み, target: これ以上の解が見つかったら止める, maxNodes: 調べる枝の数の上限, downFirst: 「下」の枝から調べる, deadline: これを過ぎたらやめる（performance.now() の値） }
 * 戻り値の complete は、枝を調べ終えたか（目標に届いたときも true）。false のときは、上限に達して、途中でやめている
 */
function ilpMax(c, A, b, start, opts) {
    const n = c.length, m = A.length, EPS = 1e-7;
    const g = (opts && opts.g) || 1e-9, target = opts && opts.target != null ? opts.target : Infinity, maxNodes = (opts && opts.maxNodes) || 300;
    const deadline = opts && opts.deadline != null ? opts.deadline : Infinity;
    const val = (x) => { let s = 0; for (let j = 0; j < n; j++) s += c[j] * x[j]; return s; };
    let best = { x: start.slice(), v: val(start) }, nodes = 0;
    const relax = (lo0, up) => {
        const lo = lo0.slice(), rhs = b.slice();
        for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (lo[j]) rhs[i] -= A[i][j] * lo[j];
        for (let pass = 0; pass < 4; pass++) {                                   // 右辺が負の式は、負の係数の変数を上げて直す
            let again = false;
            for (let i = 0; i < m; i++) {
                if (rhs[i] >= -EPS) continue;
                const j = A[i].findIndex(a => a < -EPS);
                if (j < 0) return null;
                const d = rhs[i] / A[i][j];
                lo[j] += d; again = true;
                for (let r = 0; r < m; r++) rhs[r] -= A[r][j] * d;
            }
            if (!again) break;
        }
        if (rhs.some(v => v < -EPS)) return null;
        const rows = A.map(r => r.slice()), rh = rhs.map(v => Math.max(0, v));
        for (let j = 0; j < n; j++) {
            if (up[j] === Infinity) continue;
            const room = up[j] - lo[j];
            if (room < -EPS) return null;
            rows.push(Array.from({ length: n }, (_, k) => (k === j ? 1 : 0))); rh.push(Math.max(0, room));
        }
        const lp = simplexMax(c, rows, rh);
        if (!lp.x) return null;
        const x = lp.x.map((v, j) => v + lo[j]);
        return { x, v: val(x) };
    };
    const stack = [{ lo: new Array(n).fill(0), up: new Array(n).fill(Infinity) }];
    while (stack.length && nodes < maxNodes && best.v < target - EPS && !(nodes % 8 === 7 && performance.now() > deadline)) {
        const nd = stack.pop(); nodes++;
        const r = relax(nd.lo, nd.up);
        if (!r || r.v < Math.max(best.v + g, target === Infinity ? -Infinity : target) - EPS) continue;   // この枝では、いまの解より良くならない（目標があるときは、目標に届かない枝も）
        let k = -1, score = -1;
        for (let j = 0; j < n; j++) {
            const f = Math.abs(r.x[j] - Math.round(r.x[j]));
            if (f > 1e-6 && c[j] > score) { k = j; score = c[j]; }                // 分数の変数のうち、貢献度の大きいもの
        }
        if (k < 0) { best = { x: r.x.map(Math.round), v: r.v }; continue; }       // 全部、整数になった
        const fl = Math.floor(r.x[k] + 1e-9);
        const down = { lo: nd.lo.slice(), up: nd.up.map((u, j) => (j === k ? Math.min(u, fl) : u)) };
        const upBr = { lo: nd.lo.map((l, j) => (j === k ? Math.max(l, fl + 1) : l)), up: nd.up.slice() };
        if (opts && opts.downFirst) stack.push(upBr, down); else stack.push(down, upBr);   // 後に入れた枝から調べる（既定は「上」の枝から）
    }
    best.nodes = nodes;
    best.complete = stack.length === 0 || best.v >= target - EPS;
    return best;
}

/**
 * 予定の回数を、獲得貢献度が最大になるように決める。
 * 日ごとの使える時間・難易度の解放日・所持の肉と素材（余った素材は 500個まで肉2個に変換）を守る。
 * 線形計画（単体法）で上限を出し、整数にして足し直した解から、分枝限定法（ilpMax）で、最大の整数解を探す。
 *   stock … 使える通常肉　mat250 … 250専用素材（null = 未入力）　phases … [{ id, maxTier, hours }]
 *   diffs … [{ id, tier, contrib, chunks, is250, time, only }]（time は 1回の討伐秒数。未入力は null で、計画に入れない。only は、その難易度を使う日の id の一覧で、ないときは、解放済みのどの日でも使う）
 *   target … 貢献度がこれに届けば、探すのをやめる（届くかどうかだけ知りたいとき）　lpOnly … 上限（bound）だけ出す
 *   maxNodes … 調べる枝の数の上限　deadline … これを過ぎたら、探すのをやめる（performance.now() の値）
 * 戻り値：{ runs: { 日: { 難易度: 回数 } }, total, bound, skipped }（bound は、整数にする前の上限）
 */
function planSchedule({ stock, mat250, phases, diffs, target = null, lpOnly = false, maxNodes = 300, deadline = Infinity }) {
    const CONVERT_MAX = mat250 == null ? 0 : 500;
    const d250 = diffs.find(d => d.is250);
    const active = phases.filter(ph => ph.hours > 0);
    const plan = { runs: {}, total: 0, bound: 0, skipped: diffs.filter(d => !(d.time > 0)) };
    phases.forEach(ph => { plan.runs[ph.id] = {}; diffs.forEach(d => { plan.runs[ph.id][d.id] = 0; }); });

    const vars = [];
    active.forEach(ph => diffs.forEach(d => { if (usableIn(d, ph)) vars.push({ ph, d }); }));
    if (!vars.length) return plan;
    const nv = vars.length, hasY = CONVERT_MAX > 0;
    const cost250 = d250 ? d250.chunks : 20;
    // 肉・素材は、使いきれない分を、式の中では小さくしておく（桁が大きいと、計算の誤差が出る）
    const useMax = (is250) => active.reduce((a, ph) => a + Math.max(0, ...vars.filter(v => v.ph === ph && !!v.d.is250 === is250).map(v => ph.hours * 3600 / v.d.time * v.d.chunks)), 0);
    const meatCap = Math.min(Math.max(0, stock), useMax(false) + 1);
    const matCap = mat250 == null ? useMax(true) + 1 : Math.max(0, mat250);

    // 線形計画：変数 = 各（日, 難易度）の回数 + 素材から肉への変換数 y
    const n = nv + (hasY ? 1 : 0);
    const rows = [], rhs = [];
    const pad = (arr) => (hasY ? arr.concat(0) : arr);
    active.forEach(ph => { rows.push(pad(vars.map(v => (v.ph === ph ? v.d.time / 60 : 0)))); rhs.push(ph.hours * 60); });   // 日ごとの使える時間（分）
    rows.push(vars.map(v => (v.d.is250 ? 0 : v.d.chunks)).concat(hasY ? [-2] : [])); rhs.push(meatCap);                       // 肉：使う ≤ 所持 + 変換 × 2
    rows.push(vars.map(v => (v.d.is250 ? v.d.chunks : 0)).concat(hasY ? [1] : [])); rhs.push(matCap);                         // 素材：250HELL で使う + 変換 ≤ 所持
    if (hasY) { rows.push(Array.from({ length: n }, (_, j) => (j === nv ? 1 : 0))); rhs.push(CONVERT_MAX); }                  // 変換は 500個まで
    const cPure = pad(vars.map(v => v.d.contrib / 1e4));
    const root = simplexMax(cPure, rows, rhs);
    if (!root.x) return plan;
    plan.bound = vars.reduce((a, v, k) => a + v.d.contrib * root.x[k], 0);
    if (lpOnly) return plan;

    // 整数の解：同じ貢献度なら、肉の少ない解になるように、肉に、ごく小さな重みをつけた線形計画から始める
    const TIE = 1e-4;
    const tie = simplexMax(pad(vars.map(v => v.d.contrib / 1e4 - (v.d.is250 ? 0 : TIE * v.d.chunks))), rows, rhs);
    const runs = (tie.x || root.x).slice(0, nv).map(x => Math.max(0, Math.floor(x + 1e-9)));
    const fits = () => {
        const sec = new Map(); let meat = 0, mat = 0;
        vars.forEach((v, k) => {
            if (!runs[k]) return;
            sec.set(v.ph, (sec.get(v.ph) || 0) + runs[k] * v.d.time);
            if (v.d.is250) mat += runs[k] * cost250; else meat += runs[k] * v.d.chunks;
        });
        for (const ph of active) if ((sec.get(ph) || 0) > ph.hours * 3600 + 1e-6) return false;
        return mat <= matCap && meat <= Math.max(0, stock) + 2 * Math.min(CONVERT_MAX, matCap - mat);
    };
    for (let guard = 0; guard < 10000 && !fits(); guard++) {            // 丸めで、わずかに超えたときは、貢献度の小さいものから減らす
        let k = -1;
        vars.forEach((v, i) => { if (runs[i] > 0 && (k < 0 || v.d.contrib < vars[k].d.contrib)) k = i; });
        if (k < 0) break;
        runs[k]--;
    }
    const sumOf = (arr) => { let t = 0; for (let k = 0; k < nv; k++) t += arr[k] * vars[k].d.contrib; return t; };
    const sumC = () => sumOf(runs);
    const refill = () => {                                              // 余った時間・肉・素材に、入るだけ足す（貢献度の大きいものから）
        for (let guard = 0; guard < 10000; guard++) {
            let best = -1;
            vars.forEach((v, k) => {
                runs[k]++;
                if (fits() && (best < 0 || v.d.contrib > vars[best].d.contrib)) best = k;
                runs[k]--;
            });
            if (best < 0) break;
            runs[best]++;
        }
    };
    refill();
    for (let pass = 0; pass < 20 && !(target != null && sumC() >= target); pass++) {   // 1回ぶん外して足し直すと、貢献度が増えるなら、そうする
        let improved = false;
        for (let i = 0; i < nv; i++) {
            if (!runs[i]) continue;
            const before = sumC(), saved = runs.slice();
            runs[i]--; refill();
            if (sumC() > before + 1e-6) improved = true; else for (let k = 0; k < nv; k++) runs[k] = saved[k];
        }
        if (!improved) break;
    }

    // 分枝限定法で、最大の整数解を探す（目標に届いたら止める）
    const hopeless = target != null && plan.bound < target - 1;                    // 上限が目標に届かなければ、整数にしても届かない（探しても無駄）
    if (!hopeless && !(target != null && sumC() >= target) && plan.bound - sumC() > 1) {
        let meat = 0; vars.forEach((v, k) => { if (!v.d.is250) meat += runs[k] * v.d.chunks; });
        const startX = runs.slice(); if (hasY) startX.push(Math.max(0, Math.ceil((meat - Math.max(0, stock)) / 2)));
        const gcd = (a, b2) => (b2 ? gcd(b2, a % b2) : a);
        const g = vars.reduce((a, v) => gcd(a, Math.round(v.d.contrib)), 0) / 1e4;
        const o = { g: g > 0 ? g : 1e-9, target: target != null ? target / 1e4 : undefined, maxNodes, deadline };
        let r = null;
        plan.nodes = 0;                                                             // 調べた枝の数
        if (target != null) {                                                       // 届くかどうか：肉の上限を、線形計画の解の近くから、少しずつゆるめて探す（肉の少ない計画が先に見つかり、探すのも速い）
            const lpMeat = vars.reduce((a, v, k) => a + (v.d.is250 ? 0 : v.d.chunks * (tie.x || root.x)[k]), 0);
            for (const cap of [lpMeat * 1.03 + 40, lpMeat * 1.2 + 200]) {
                if (cap >= meatCap) break;
                const rhsX = rhs.slice(); rhsX[active.length] = cap;                 // 肉の式は、時間の式の次
                const st = meat <= cap ? startX : new Array(n).fill(0);
                let rc = ilpMax(cPure, rows, rhsX, st, o);
                plan.nodes += rc.nodes;
                if (rc.v < target / 1e4 - 1e-7 && !rc.complete) {                   // 上限に達したら、枝を調べる順を変えて、もう一度
                    const rd = ilpMax(cPure, rows, rhsX, st, { ...o, downFirst: true });
                    plan.nodes += rd.nodes;
                    if (rd.v > rc.v) rc = rd;
                }
                if (rc.v >= target / 1e4 - 1e-7) { r = rc; plan.complete = true; break; }
            }
        }
        if (!r) {
            r = ilpMax(cPure, rows, rhs, startX, o);
            plan.nodes += r.nodes;
            if (!r.complete) {                                                       // 上限に達したら、枝を調べる順を変えて、もう一度（問題によって、向く順が違う）
                const r2 = ilpMax(cPure, rows, rhs, startX, { ...o, downFirst: true });
                plan.nodes += r2.nodes;
                if (r2.v > r.v) r = r2;
                plan.complete = r2.complete;
            } else plan.complete = true;
        }
        const saved = runs.slice();
        for (let k = 0; k < nv; k++) runs[k] = r.x[k];
        if (!fits() || sumC() < sumOf(saved)) for (let k = 0; k < nv; k++) runs[k] = saved[k];   // 誤差などで、制限を超えたら、使わない
    }
    vars.forEach((v, k) => { plan.runs[v.ph.id][v.d.id] += runs[k]; plan.total += runs[k] * v.d.contrib; });
    return plan;
}

// 優先するもの：「時間」は、すべての難易度が候補（討伐時間から決まる、時間あたりの貢献度が高いものを使う）。
// 「肉」は、肉1個あたりの貢献度が高い難易度（最良の半分以上。いまは 200HELL）と、肉を使わない 250HELL を使う。
// ただし、それらがまだ使えない日（本戦1日目。予選・インターバルも）は、遊ばない日にしないように、その日に使える、いちばん上の難易度だけを使う（本戦1日目は 150HELL）。
// その難易度には only（使う日）をつけて返す
function allowedDiffs(diffs, priority) {
    if (priority !== 'meat') return diffs;
    const meatTiers = diffs.filter(d => !d.is250 && d.chunks > 0 && d.time > 0);
    const best = meatTiers.length ? Math.max(...meatTiers.map(d => d.contrib / d.chunks)) : 0;
    const main = diffs.filter(d => d.is250 || (best > 0 && d.chunks > 0 && d.contrib / d.chunks >= best * 0.5));
    const only = new Map();                                                     // 難易度 → その難易度を使う日
    PHASES.forEach(ph => {
        if (main.some(d => usableIn(d, ph))) return;
        const top = diffs.filter(d => !main.includes(d) && usableIn(d, ph)).sort((a, b) => b.tier - a.tier)[0];
        if (top) only.set(top, [...(only.get(top) || []), ph.id]);
    });
    return diffs.filter(d => main.includes(d) || only.has(d)).map(d => (only.has(d) ? { ...d, only: only.get(d) } : d));
}

// 日ごとの時間の指定：欄が空 = 自動、数 = 固定（0 は、その日は遊ばない。本戦は 17時間まで）。
// 予選・インターバルは、時間を入れたときだけ使う（「自動の対象」で予選も含めると、自動の日になる）。
// 自動の日でも、その日に使える難易度（討伐時間が入っていて、解放済みで、優先の条件に合うもの）がなければ、使わない
// opt（{ includeQ, hours: { 日の id: 数 または null（自動） } }）で決める。スケジュールタブの欄から opt を作るのは、ページ側（domHoursOpt）
function scheduleHoursSpec(planDiffs, opt) {
    opt = opt || { includeQ: false, hours: {} };                                // 指定がなければ、全部自動（予選・インターバルは使わない）
    const includeQ = !!opt.includeQ;
    return PHASES.map(ph => {
        const raw = opt.hours[ph.id] == null ? '' : String(opt.hours[ph.id]).trim();
        const n = parseFloat(raw);
        if (raw !== '' && Number.isFinite(n) && n >= 0) return { ph, fixed: true, hours: Math.min(n, ph.id === 'q' ? 99 : DAY_MAX_HOURS), idle: !planDiffs.some(d => usableIn(d, ph)) };
        if (ph.id === 'q' && !includeQ) return { ph, fixed: true, hours: 0, off: true };
        if (!planDiffs.some(d => usableIn(d, ph))) return { ph, fixed: true, hours: 0, off: true, noTier: true };
        return { ph, fixed: false, hours: 0 };
    });
}

// 目標に届く、いちばん短い時間（自動の日に、同じ時間ずつ。0.05時間きざみ。1日 DAY_MAX_HOURS まで）。
// 肉と素材が十分ある場合（unlimited）も、あわせて出す。
// 時間を決める二分探索は、線形計画の上限（lpOnly）で行い、最後に、整数の解（目標に届くかどうか）を確かめる
function solveSchedule({ need, stock, mat250, diffs, spec, onlyActual = false }) {
    const hasAuto = spec.some(s => !s.fixed);
    const deadline = performance.now() + 250;                                  // 難しい問題で、固まらないための、時間の上限
    const phasesAt = (n) => PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : n }));
    const run = (n, stk, mat, opts) => planSchedule({ stock: stk, mat250: mat, phases: phasesAt(n), diffs, deadline, ...opts });
    const attempt = (n, stk, mat) => {                                         // 目標に届く整数の計画を探す。途中でやめたときは、枝の数を増やして、もう一度
        let p = run(n, stk, mat, { target: need });
        if (p.total < need && p.complete === false) p = run(n, stk, mat, { target: need, maxNodes: 3000 });
        return p;
    };
    const STEP = 0.05, MAX_K = Math.round(DAY_MAX_HOURS / STEP);
    const solve = (stk, mat) => {
        if (!hasAuto) { const plan = attempt(0, stk, mat); return { reachable: plan.total >= need, hours: 0, plan }; }
        if (run(MAX_K * STEP, stk, mat, { lpOnly: true }).bound + 1 < need) return { reachable: false, hours: DAY_MAX_HOURS, plan: run(MAX_K * STEP, stk, mat) };   // 上限の時間でも届かない：できるだけ多く取る計画を見せる
        let lo = 0, hi = MAX_K;
        while (lo < hi) {                                         // 時間が長いほど、取れる貢献度の上限は増えるので、二分探索
            const mid = (lo + hi) >> 1;
            if (run(mid * STEP, stk, mat, { lpOnly: true }).bound >= need - 1e-6) hi = mid; else lo = mid + 1;
        }
        let k = lo, plan = attempt(k * STEP, stk, mat);
        while (plan.total < need && k < MAX_K) { k++; plan = attempt(k * STEP, stk, mat); }   // 整数にしたぶんの不足は、少しずつ足す
        return { reachable: plan.total >= need, hours: Math.round(k * STEP * 100) / 100, plan };
    };
    return { hasAuto, actual: solve(stock, mat250), unlimited: onlyActual ? null : solve(1e9, null) };
}

// 計画で使う肉・素材・250HELL の回数と、使える肉（余った素材は 500個まで肉2個に変換。素材が未入力なら、変換しない）
function scheduleUsage(plan, diffs, stock, mat250) {
    const d250 = diffs.find(d => d.is250);
    let meat = 0, z = 0;
    diffs.forEach(d => PHASES.forEach(ph => { const n = plan.runs[ph.id][d.id] || 0; if (d.is250) z += n; else meat += n * d.chunks; }));
    const mat = z * (d250 ? d250.chunks : 20);
    const converted = mat250 == null ? 0 : 2 * Math.max(0, Math.min(500, mat250 - mat));
    return { meat, mat, z, converted, pool: stock + converted };
}

// 難易度ごとの時間（全日の合計）：回数 × 討伐時間。回数が 0 の難易度は入れない
function hoursByDiff(plan, diffs) {
    return diffs.map(d => ({ name: d.name, runs: PHASES.reduce((a, ph) => a + ((plan.runs[ph.id] && plan.runs[ph.id][d.id]) || 0), 0), time: d.time }))
        .filter(x => x.runs > 0).map(x => ({ name: x.name, runs: x.runs, sec: x.runs * x.time }));
}

// 優先（time / meat）ごとの試算：実際の肉・素材での答え（actual）、肉と素材が十分あるときの答え（unlimited）、
// そのときの時間で、目標に届くのにいちばん少ない肉の数と、そのとき使う素材の数（req）
function scheduleScenario(priority, { diffs, stock, mat250, need, hoursOpt }) {
    const diffsP = allowedDiffs(diffs, priority);
    const spec = scheduleHoursSpec(diffsP, hoursOpt);
    const solved = solveSchedule({ need, stock, mat250, diffs: diffsP, spec });
    const U = solved.unlimited;
    let req = null;
    if (U.reachable) {
        const deadline = performance.now() + 200;                                // 難しい問題で、固まらないための、時間の上限
        const phasesU = PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : U.hours }));
        let spent = 0;                                                           // 調べた枝の数の合計
        const attempt = (e) => {                                                 // 肉が e 個で、目標に届く整数の計画があるか。途中でやめたときは、枝の数を増やして、もう一度
            const run = (maxNodes) => { const p = planSchedule({ stock: e, mat250: null, phases: phasesU, diffs: diffsP, target: need, maxNodes, deadline }); spent += p.nodes || 0; return p; };
            let p = run(300);
            if (p.total < need && p.complete === false) p = run(3000);
            return p;
        };
        let lo = 0, hi = Math.max(1, scheduleUsage(U.plan, diffsP, 0, null).meat);   // 肉が十分あるときの計画で使う肉は、足りる数の1つ
        while (attempt(hi).total < need && hi < 1e7) hi *= 2;
        // 肉を増やすほど届きやすいので、二分探索。難しい問題で、枝の数が多くなりすぎたら、そこまでに届くとわかった数（hi）で打ち切る
        while (lo < hi && spent < 5000) { const mid = Math.floor((lo + hi) / 2); if (attempt(mid).total >= need) hi = mid; else lo = mid + 1; }
        req = { meat: hi, mat: scheduleUsage(attempt(hi), diffsP, hi, null).mat };
    }
    return { priority, diffsP, spec, solved, req };
}
