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

// 探索の打ち切りは、時間ではなく「調べた枝の数」で決める（同じ入力なら、どの端末でも、同じ答えになる）。
// 時間の上限（SAFETY_VALVE_MS）は、固まるのを防ぐ最後の安全装置で、ふつうの入力では、届かない大きさにしてある
const BUDGET_SOLVE_NODES = 6000;      // 毎日の時間を決めるとき（solveSchedule の、実際の肉・素材と、十分あるときの、それぞれ）に調べてよい枝の数
const BUDGET_REQ_NODES   = 8000;      // 必要な肉の逆算（scheduleScenario）で調べてよい枝の数
const SAFETY_VALVE_MS    = 30000;     // 安全装置：これを超えたら、途中の答えを返す（結果に timedOut が立つ）。枝の数の予算で、ふつうは、数秒で終わる（CPU が 4倍遅くても 10秒ほど）ので、そこには届かない大きさにしてある
// 極星器の本数の制約があるときは、日の時間がぴったり埋まる「針の穴」のような解が必要になることがあり、探索が難しいので、予算を増やす
const BUDGET_SOLVE_NODES_STAR = 6000, BUDGET_REQ_NODES_STAR = 16000;
const RETRY_NODES = 3000, RETRY_NODES_STAR = 3000, RETRY_REQ_NODES_STAR = 3000;      // 1回の探索が途中でやめたとき、もう一度試すときの、枝の数の上限（時間を決めるとき・必要な肉の逆算）

/**
 * 単体法（最大化）：max c·x  ただし A x ≤ b, x ≥ 0。変数も式も少ないので、素朴な表で解く。
 * b ≥ 0 なら、x = 0 から始める。右辺が負の式（「◯以上」の式。極星器の本数など）があるときは、
 * その式に人工変数を足して、第1段階で、実行可能な解を探してから、第2段階で最大化する（2段階法）。
 * 戻り値：{ x, value, rc } / 解がないとき { infeasible: true } / 上限がないとき { unbounded: true }
 *   rc は、最適な表の目的行：変数 j（0..n-1）・式 i の余り（n+i）を、1だけ増やすと、最大値が rc だけ減る（0 以上。基底の変数は 0）
 */
function simplexMax(c, A, b) {
    const m = A.length, n = c.length, EPS = 1e-9;
    if (b.some(v => v < -EPS)) return simplexTwoPhase(c, A, b);
    const W = n + m + 1;
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
    return { x, value: z[W - 1], rc: z.slice(0, n + m) };
}

/** simplexMax の、右辺が負の式があるとき（2段階法）。列：変数 | スラック | 人工 | 右辺 */
function simplexTwoPhase(c, A, b) {
    const m = A.length, n = c.length, EPS = 1e-9;
    const negRows = []; for (let i = 0; i < m; i++) if (b[i] < -EPS) negRows.push(i);
    const nArt = negRows.length, NV = n + m + nArt, W = NV + 1;
    const T = A.map((row, i) => {
        const t = new Array(W).fill(0), sg = b[i] < -EPS ? -1 : 1;                  // 負の式は、両辺に −1 をかけて、「≥」にする（余りの変数は −1）
        for (let j = 0; j < n; j++) t[j] = sg * row[j];
        t[n + i] = sg;
        t[W - 1] = Math.max(0, sg * b[i]);
        return t;
    });
    const basis = Array.from({ length: m }, (_, i) => n + i);
    negRows.forEach((i, k) => { T[i][n + m + k] = 1; basis[i] = n + m + k; });
    const pivot = (row, col, z) => {
        const pv = T[row][col];
        for (let j = 0; j < W; j++) T[row][j] /= pv;
        for (let i = 0; i < m; i++) {
            if (i === row) continue;
            const f = T[i][col];
            if (f !== 0) for (let j = 0; j < W; j++) T[i][j] -= f * T[row][j];
        }
        const f = z[col];
        if (f !== 0) for (let j = 0; j < W; j++) z[j] -= f * T[row][j];
        basis[row] = col;
    };
    const run = (z) => {                                                              // 人工変数の列は、入れない
        for (let iter = 0; iter < 20000; iter++) {
            let col = -1;
            for (let j = 0; j < n + m; j++) if (z[j] < -EPS) { col = j; break; }
            if (col < 0) return true;
            let row = -1, best = Infinity;
            for (let i = 0; i < m; i++) {
                if (T[i][col] <= EPS) continue;
                const r = T[i][W - 1] / T[i][col];
                if (r < best - EPS || (Math.abs(r - best) <= EPS && basis[i] < basis[row])) { best = r; row = i; }
            }
            if (row < 0) return false;
            pivot(row, col, z);
        }
        return true;
    };
    // 第1段階：人工変数の合計を 0 にできるか（できなければ、解なし）
    const z1 = new Array(W).fill(0);
    for (let k = 0; k < nArt; k++) z1[n + m + k] = 1;
    negRows.forEach(i => { for (let j = 0; j < W; j++) z1[j] -= T[i][j]; });
    run(z1);
    if (z1[W - 1] < -1e-7) return { infeasible: true };
    for (let i = 0; i < m; i++) {                                                     // 基底に残った人工変数（値 0）を、ふつうの変数に入れ替える
        if (basis[i] < n + m) continue;
        for (let j = 0; j < n + m; j++) if (Math.abs(T[i][j]) > 1e-7) { pivot(i, j, new Array(W).fill(0)); break; }
    }
    // 第2段階：本来の目的を最大化
    const z2 = [...c.map(v => -v), ...new Array(W - n).fill(0)];
    for (let i = 0; i < m; i++) { const f = z2[basis[i]]; if (f !== 0) for (let j = 0; j < W; j++) z2[j] -= f * T[i][j]; }
    if (!run(z2)) return { unbounded: true };
    const x = new Array(n).fill(0);
    basis.forEach((bv, i) => { if (bv < n) x[bv] = T[i][W - 1]; });
    return { x, value: z2[W - 1], rc: z2.slice(0, n + m) };
}

/**
 * 整数計画（分枝限定法）：max c·x  ただし A x ≤ b、x は 0 以上の整数。
 * 線形計画（simplexMax）で、その枝で出せる貢献度の上限を出し、上限が、いまの解より良くならない枝は、調べない。
 * 分数になった変数で、「その整数以下」と「その整数 + 1 以上」の 2 つの枝に分ける（下限は、変数をずらして表す）。
 * start は、すでにある整数解（これより良い解だけ探す。null なら、解がまだない）。右辺が負になる枝は、負の係数の変数（素材からの変換）を上げて直し、直せなければ、解なし。
 * 正の係数がない式（「◯以上」の式。極星器の本数）は、直さずに、単体法の第1段階（2段階法）に任せる。
 *   opts … { g: 目的の最小の刻み, target: これ以上の解が見つかったら止める, maxNodes: この呼び出しで調べる枝の数の上限, downFirst: 「下」の枝から調べる,
 *            budget: 共有の残り枝数 { nodes }（調べるたびに減らし、0 になったら止める）, deadline: 安全装置。これを過ぎたらやめる（performance.now() の値） }
 * 戻り値の complete は、枝を調べ終えたか（目標に届いたときも true）。false のときは、上限に達して、途中でやめている（timedOut は、安全装置で止まったとき）
 */
function ilpMax(c, A, b, start, opts) {
    const n = c.length, m = A.length, EPS = 1e-7;
    const g = (opts && opts.g) || 1e-9, target = opts && opts.target != null ? opts.target : Infinity, maxNodes = (opts && opts.maxNodes) || 300;
    const deadline = opts && opts.deadline != null ? opts.deadline : Infinity, budget = opts && opts.budget;
    let timedOut = false;
    const val = (x) => { let s = 0; for (let j = 0; j < n; j++) s += c[j] * x[j]; return s; };
    let best = start ? { x: start.slice(), v: val(start) } : { x: new Array(n).fill(0), v: -Infinity }, nodes = 0;
    const relax = (lo0, up) => {
        const lo = lo0.slice(), rhs = b.slice();
        for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) if (lo[j]) rhs[i] -= A[i][j] * lo[j];
        for (let pass = 0; pass < 4; pass++) {                                   // 右辺が負の式は、負の係数の変数を上げて直す
            let again = false;
            for (let i = 0; i < m; i++) {
                if (rhs[i] >= -EPS || !A[i].some(a => a > EPS)) continue;      // 正の係数がない式は、第1段階に任せる
                const j = A[i].findIndex(a => a < -EPS);
                if (j < 0) return null;
                const d = rhs[i] / A[i][j];
                lo[j] += d; again = true;
                for (let r = 0; r < m; r++) rhs[r] -= A[r][j] * d;
            }
            if (!again) break;
        }
        if (rhs.some((v, i) => v < -EPS && A[i].some(a => a > EPS))) return null;
        const rows = A.map(r => r.slice()), rh = rhs.map(v => (v < 0 && v > -EPS ? 0 : v));
        const boundRow = new Array(n).fill(-1);                                  // 変数 j の上限の式が、何番目か
        for (let j = 0; j < n; j++) {
            if (up[j] === Infinity) continue;
            const room = up[j] - lo[j];
            if (room < -EPS) return null;
            boundRow[j] = rows.length;
            rows.push(Array.from({ length: n }, (_, k) => (k === j ? 1 : 0))); rh.push(Math.max(0, room));
        }
        const lp = simplexMax(c, rows, rh);
        if (!lp.x) return null;
        const x = lp.x.map((v, j) => v + lo[j]);
        return { x, v: val(x), rc: lp.rc, lo, boundRow };
    };
    const stack = [{ lo: new Array(n).fill(0), up: new Array(n).fill(Infinity) }];
    while (stack.length && nodes < maxNodes && best.v < target - EPS && !(budget && budget.nodes <= 0)) {
        if (nodes % 8 === 7 && performance.now() > deadline) { timedOut = true; break; }       // 安全装置（時間）
        const nd = stack.pop(); nodes++;
        if (budget) budget.nodes--;
        const r = relax(nd.lo, nd.up);
        if (!r || r.v < Math.max(best.v + g, target === Infinity ? -Infinity : target) - EPS) continue;   // この枝では、いまの解より良くならない（目標があるときは、目標に届かない枝も）
        let k = -1, score = -1;
        for (let j = 0; j < n; j++) {
            const f = Math.abs(r.x[j] - Math.round(r.x[j]));
            if (f > 1e-6 && c[j] > score) { k = j; score = c[j]; }                // 分数の変数のうち、貢献度の大きいもの
        }
        if (k < 0) { best = { x: r.x.map(Math.round), v: r.v }; continue; }       // 全部、整数になった
        const fl = Math.floor(r.x[k] + 1e-9);
        // 被約費用による固定：この枝の最良の値（r.v）が、探している値（いまの解より良い、または目標）より、gap だけ余っているとき、
        // 1つ増やすと gap より多く減る変数は、これ以上増やせない（上限 = 下限）。上限の式の余りを 1 増やす（変数を 1 減らす）と gap より多く減る変数は、上限のまま（下限 = 上限）
        const need = Math.max(best.v + g, target === Infinity ? -Infinity : target);
        const gap = r.v - need, tol = 1e-6 * (1 + Math.abs(r.v));
        let baseLo = nd.lo, baseUp = nd.up;
        if (isFinite(gap) && gap >= -tol) {
            baseLo = nd.lo.slice(); baseUp = nd.up.slice();
            for (let j = 0; j < n; j++) {
                if (r.rc[j] > gap + tol && baseUp[j] > r.lo[j]) baseUp[j] = Math.max(r.lo[j], baseLo[j]);
                if (r.boundRow[j] >= 0 && r.rc[n + r.boundRow[j]] > gap + tol && baseUp[j] !== Infinity && baseLo[j] < baseUp[j]) baseLo[j] = baseUp[j];
            }
            for (let j = 0; j < n; j++) if (baseLo[j] > baseUp[j]) { baseLo = null; break; }                  // 矛盾：この枝には、解がない
            if (!baseLo) continue;
        }
        const down = { lo: baseLo.slice(), up: baseUp.map((u, j) => (j === k ? Math.min(u, fl) : u)) };
        const upBr = { lo: baseLo.map((l, j) => (j === k ? Math.max(l, fl + 1) : l)), up: baseUp.slice() };
        if (opts && opts.downFirst) stack.push(upBr, down); else stack.push(down, upBr);   // 後に入れた枝から調べる（既定は「上」の枝から）
    }
    best.nodes = nodes;
    best.found = best.v > -Infinity;                  // 解が見つかったか
    best.timedOut = timedOut;
    best.complete = stack.length === 0 || best.v >= target - EPS;
    return best;
}

/**
 * 予定の回数を、獲得貢献度が最大になるように決める。
 * 日ごとの使える時間・難易度の解放日・所持の肉と素材（余った素材は 500個まで肉2個に変換）を守る。
 * 線形計画（単体法）で上限を出し、整数にして足し直した解から、分枝限定法（ilpMax）で、最大の整数解を探す。
 *   stock … 使える通常肉（null か Infinity = 無制限。肉の制約を入れない）　mat250 … 250専用素材（null = 未入力。素材の制約も入れない）　phases … [{ id, maxTier, hours }]
 *   diffs … [{ id, tier, contrib, chunks, is250, time, only }]（time は 1回の討伐秒数。未入力は null で、計画に入れない。only は、その難易度を使う日の id の一覧で、ないときは、解放済みのどの日でも使う）
 *   target … 貢献度がこれに届けば、探すのをやめる（届くかどうかだけ知りたいとき）　lpOnly … 上限（bound）だけ出す
 *   star … 極星器の期待本数の制約 { n, q }（Σ 回数 × 1周の確率 q[難易度の id] ≥ n。null なら、制約なし）
 *   caps … 回数の上限 { '日の id|難易度の id': 回数 }（null なら、上限なし）
 *   maxNodes … この呼び出しで調べる枝の数の上限　budget … 共有の残り枝数 { nodes }（呼び出しをまたいで減らす）
 *   deadline … 安全装置。これを過ぎたら、探すのをやめる（performance.now() の値。ふつうの入力では、届かない）
 * 戻り値：{ runs: { 日: { 難易度: 回数 } }, total, bound, skipped, nodes, complete, timedOut, invalid, stars, starUnmet }
 *   bound は、整数にする前の上限（極星器の制約を守れないときは -Infinity）。stars は、計画の極星器の期待本数。
 *   starUnmet は、極星器の本数の制約を守る計画がなかったこと（そのときは、回数を全部 0 にして返す）。invalid は、最後の検算（verifyPlan）に通らなかったときの理由（同じく 0 にする）
 */
function planSchedule({ stock, mat250, phases, diffs, target = null, lpOnly = false, maxNodes = 300, deadline = Infinity, budget = null, star = null, caps = null }) {
    if (stock == null) stock = Infinity;                                        // 無制限
    const CONVERT_MAX = mat250 == null ? 0 : 500;
    const d250 = diffs.find(d => d.is250);
    const active = phases.filter(ph => ph.hours > 0);
    const plan = { runs: {}, total: 0, bound: 0, skipped: diffs.filter(d => !(d.time > 0)) };
    phases.forEach(ph => { plan.runs[ph.id] = {}; diffs.forEach(d => { plan.runs[ph.id][d.id] = 0; }); });

    const vars = [];
    active.forEach(ph => diffs.forEach(d => { if (usableIn(d, ph)) vars.push({ ph, d }); }));
    const wantStar = !!(star && star.n > 0);
    const qOf = (v) => (wantStar && star.q && star.q[v.d.id]) || 0;
    if (!vars.length || (wantStar && !vars.some(v => qOf(v) > 0))) { if (wantStar) { plan.bound = -Infinity; plan.starUnmet = true; } return plan; }
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
    if (wantStar) {                                                                                                          // 極星器：Σ q·回数 ≥ n（桁をそろえるため、いちばん大きい q が 1 になるように、全体を割る）
        const sc = 1 / Math.max(...vars.map(qOf));
        rows.push(pad(vars.map(v => -qOf(v) * sc))); rhs.push(-star.n * sc);
    }
    const capK = vars.map(v => (caps && caps[`${v.ph.id}|${v.d.id}`] != null ? caps[`${v.ph.id}|${v.d.id}`] : Infinity));
    capK.forEach((cp, k) => { if (cp < Infinity) { rows.push(pad(vars.map((_, j) => (j === k ? 1 : 0)))); rhs.push(cp); } });   // 回数の上限
    const cPure = pad(vars.map(v => v.d.contrib / 1e4));
    const root = simplexMax(cPure, rows, rhs);
    if (root.infeasible) { plan.bound = -Infinity; if (wantStar) plan.starUnmet = true; return plan; }                // 制約を、すべては守れない
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
        for (let k = 0; k < nv; k++) if (runs[k] > capK[k]) return false;
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
    const starOf = (arr) => { let t = 0; for (let k = 0; k < nv; k++) t += arr[k] * qOf(vars[k]); return t; };
    const starMet = (arr) => !wantStar || starOf(arr) >= star.n - 1e-9;
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
    for (let pass = 0; pass < 20 && !(target != null && sumC() >= target) && !wantStar; pass++) {      // （極星器の制約があるときは、貢献度だけを良くする足し直しはしない）   // 1回ぶん外して足し直すと、貢献度が増えるなら、そうする
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
    const heurStar = starMet(runs);                                                // 極星器の制約を、ここまでの解が守っているか
    if (!hopeless && !(target != null && sumC() >= target && heurStar) && (!heurStar || plan.bound - sumC() > 1)) {
        let meat = 0; vars.forEach((v, k) => { if (!v.d.is250) meat += runs[k] * v.d.chunks; });
        const startX = heurStar ? runs.slice() : null; if (startX && hasY) startX.push(Math.max(0, Math.ceil((meat - Math.max(0, stock)) / 2)));
        const gcd = (a, b2) => (b2 ? gcd(b2, a % b2) : a);
        const g = vars.reduce((a, v) => gcd(a, Math.round(v.d.contrib)), 0) / 1e4;
        const o = { g: g > 0 ? g : 1e-9, target: target != null ? target / 1e4 : undefined, maxNodes, deadline, budget };
        let r = null;
        plan.nodes = 0;                                                             // 調べた枝の数
        const note = (x) => { plan.nodes += x.nodes; if (x.timedOut) plan.timedOut = true; return x; };
        if (target != null) {                                                       // 届くかどうか：肉の上限を、線形計画の解の近くから、少しずつゆるめて探す（肉の少ない計画が先に見つかり、探すのも速い）
            const lpMeat = vars.reduce((a, v, k) => a + (v.d.is250 ? 0 : v.d.chunks * (tie.x || root.x)[k]), 0);
            for (const cap of [lpMeat * 1.03 + 40, lpMeat * 1.2 + 200]) {
                if (cap >= meatCap) break;
                const rhsX = rhs.slice(); rhsX[active.length] = cap;                 // 肉の式は、時間の式の次
                const st = meat <= cap ? startX : (wantStar ? null : new Array(n).fill(0));
                let rc = note(ilpMax(cPure, rows, rhsX, st, o));
                if (rc.v < target / 1e4 - 1e-7 && !rc.complete) {                   // 上限に達したら、枝を調べる順を変えて、もう一度
                    const rd = note(ilpMax(cPure, rows, rhsX, st, { ...o, downFirst: true }));
                    if (rd.v > rc.v) rc = rd;
                }
                if (rc.v >= target / 1e4 - 1e-7) { r = rc; plan.complete = true; break; }
            }
        }
        if (!r) {
            r = note(ilpMax(cPure, rows, rhs, startX, o));
            if (!r.complete) {                                                       // 上限に達したら、枝を調べる順を変えて、もう一度（問題によって、向く順が違う）
                const r2 = note(ilpMax(cPure, rows, rhs, startX, { ...o, downFirst: true }));
                if (r2.v > r.v) r = r2;
                plan.complete = r2.complete;
            } else plan.complete = true;
        }
        const saved = runs.slice();
        if (r.found) {
            for (let k = 0; k < nv; k++) runs[k] = r.x[k];
            if (!fits() || !starMet(runs) || (heurStar && sumC() < sumOf(saved))) for (let k = 0; k < nv; k++) runs[k] = saved[k];   // 誤差などで、制限を超えたら、使わない
        }
    }
    if (wantStar && !starMet(runs)) { runs.fill(0); plan.starUnmet = true; }          // 極星器の制約を守る計画が見つからなかった
    vars.forEach((v, k) => { plan.runs[v.ph.id][v.d.id] += runs[k]; plan.total += runs[k] * v.d.contrib; });
    plan.stars = wantStar ? starOf(runs) : 0;
    const check = verifyPlan(plan, { stock, mat250, phases, diffs, star: plan.starUnmet ? null : star, caps });            // 最後に、整数の回数 × 整数の係数で、全部の制約を確かめる。通らない解は捨てる
    if (!check.ok) {
        plan.invalid = check.errors;
        plan.total = 0; plan.stars = 0;
        phases.forEach(ph => diffs.forEach(d => { plan.runs[ph.id][d.id] = 0; }));
    }
    return plan;
}

/**
 * 計画（planSchedule の結果）が、全部の制約を守っているかを、整数で確かめる（単体法の小数の計算に頼らない検算）。
 *   ・回数は 0 以上の整数　・使えない日・難易度（usableIn）や、時間 0 の日には、回数がない
 *   ・日ごとの時間：回数 × 討伐時間（秒）の合計 ≤ 使える時間　・素材：250HELL で使う ≤ 所持　・肉：使う ≤ 所持 + 余った素材の変換（500個まで、肉2個）
 *   ・plan.total が、回数 × 貢献度の合計と合っている
 *   ・star（{ n, q }）があれば、極星器の期待本数 Σ 回数 × q ≥ n　・caps があれば、回数 ≤ 上限
 * stock・mat250 は、null か Infinity で無制限。戻り値：{ ok, errors, usage: { meat, mat, total, stars } }
 */
function verifyPlan(plan, { stock, mat250, phases, diffs, star = null, caps = null }) {
    const errors = [];
    const unlimitedMeat = stock == null || stock === Infinity;
    let meat = 0, mat = 0, total = 0, stars = 0;
    for (const ph of phases) {
        const row = (plan.runs && plan.runs[ph.id]) || {};
        let sec = 0;
        for (const d of diffs) {
            const n = row[d.id] || 0;
            if (!Number.isInteger(n) || n < 0) { errors.push(`${ph.id}・${d.id}：回数が 0 以上の整数でない（${n}）`); continue; }
            if (n === 0) continue;
            if (!(ph.hours > 0)) errors.push(`${ph.id}：時間が 0 の日に ${d.id} の回数がある`);
            if (!usableIn(d, ph)) errors.push(`${ph.id}・${d.id}：その日に使えない難易度に回数がある`);
            sec += n * d.time;
            total += n * d.contrib;
            stars += n * ((star && star.q && star.q[d.id]) || 0);
            if (caps && caps[`${ph.id}|${d.id}`] != null && n > caps[`${ph.id}|${d.id}`]) errors.push(`${ph.id}・${d.id}：回数の上限を超えている（${n} > ${caps[`${ph.id}|${d.id}`]}）`);
            if (d.is250) mat += n * d.chunks; else meat += n * d.chunks;
        }
        if (sec > ph.hours * 3600 + 1e-6) errors.push(`${ph.id}：時間を超えている（${sec} 秒 > ${ph.hours * 3600} 秒）`);
    }
    if (mat250 != null && mat > Math.max(0, mat250)) errors.push(`素材を超えている（${mat} > ${mat250}）`);
    const converted = mat250 == null ? 0 : 2 * Math.max(0, Math.min(500, mat250 - mat));
    if (!unlimitedMeat && meat > Math.max(0, stock) + converted) errors.push(`肉を超えている（${meat} > ${Math.max(0, stock)} + 変換 ${converted}）`);
    if (typeof plan.total === 'number' && Math.abs(plan.total - total) > 0.5) errors.push(`合計が合わない（${plan.total} ≠ ${total}）`);
    if (star && star.n > 0 && stars < star.n - 1e-9) errors.push(`極星器の期待本数が足りない（${stars} < ${star.n}）`);
    return { ok: errors.length === 0, errors, usage: { meat, mat, total, stars } };
}

// 難易度ごとの、計画用の入力（時間は秒。入れていない難易度は null。estimatedIds は、推定した難易度の id）
function planDiffsFrom(times, estimatedIds = []) {
    return HELL_DIFFS.map(d => ({ id: d.id, name: d.name, tier: tierOf(d), contrib: d.contrib, chunks: d.chunks, is250: d.is250, time: times[d.id] || null, estimated: estimatedIds.includes(d.id) }));
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
// 肉と素材が十分ある場合（unlimited）も、あわせて出す（肉・素材の制約を入れずに解く）。
// 時間を決める二分探索は、線形計画の上限（lpOnly）で行い、最後に、整数の解（目標に届くかどうか）を確かめる。
// 探索は、枝の数の予算（BUDGET_SOLVE_NODES。実際の肉・素材と、十分あるときで、別々）で打ち切る。
// 戻り値の exhausted は、予算を使い切ったか（そのときは、時間が少し長めに出ている可能性がある）、timedOut は、安全装置の時間で止まったか。
// star（極星器の制約 { n, q }）・caps（回数の上限）を渡すと、それを守る計画で解く。上限の時間でも守れないときは、starBlocked（目標だけなら届くか）を立てる
function solveSchedule({ need, stock, mat250, diffs, spec, onlyActual = false, star = null, caps = null }) {
    const hasAuto = spec.some(s => !s.fixed);
    const valve = performance.now() + SAFETY_VALVE_MS;                         // 安全装置（固まるのを防ぐ。ふつうは届かない）
    const phasesAt = (n) => PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : n }));
    const STEP = 0.05, MAX_K = Math.round(DAY_MAX_HOURS / STEP);
    const solve = (stk, mat) => {
        const budget = { nodes: star ? BUDGET_SOLVE_NODES_STAR : BUDGET_SOLVE_NODES };
        let timedOut = false;
        const run = (n, opts) => {
            const p = planSchedule({ stock: stk, mat250: mat, phases: phasesAt(n), diffs, deadline: valve, budget, star, caps, ...opts });
            if (p.timedOut) timedOut = true;
            return p;
        };
        const attempt = (n) => {                                               // 目標に届く整数の計画を探す。途中でやめたときは、枝の数を増やして、もう一度
            let p = run(n, { target: need });
            if (p.total < need && p.complete === false) p = run(n, { target: need, maxNodes: star ? RETRY_NODES_STAR : RETRY_NODES });
            return p;
        };
        const done = (o) => ({ ...o, exhausted: budget.nodes <= 0, timedOut });
        if (!hasAuto) { const plan = attempt(0); return done({ reachable: plan.total >= need, hours: 0, plan }); }
        if (run(MAX_K * STEP, { lpOnly: true }).bound + 1 < need) {                  // 上限の時間でも届かない：できるだけ多く取る計画を見せる
            const blocked = !!star && run(MAX_K * STEP, { lpOnly: true, star: null, caps: null }).bound + 1 >= need;   // 極星器の制約がなければ届くか
            return done({ reachable: false, hours: DAY_MAX_HOURS, plan: run(MAX_K * STEP, blocked ? { star: null, caps: null } : {}), starBlocked: blocked });
        }
        let lo = 0, hi = MAX_K;
        while (lo < hi) {                                         // 時間が長いほど、取れる貢献度の上限は増えるので、二分探索
            const mid = (lo + hi) >> 1;
            if (run(mid * STEP, { lpOnly: true }).bound >= need - 1e-6) hi = mid; else lo = mid + 1;
        }
        let k = lo, plan = attempt(k * STEP);
        while (plan.total < need && k < MAX_K) { k++; plan = attempt(k * STEP); }   // 整数にしたぶんの不足は、少しずつ足す
        return done({ reachable: plan.total >= need, hours: Math.round(k * STEP * 100) / 100, plan });
    };
    return { hasAuto, actual: solve(stock, mat250), unlimited: onlyActual ? null : solve(Infinity, null) };
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
// そのときの時間で、目標に届くのにいちばん少ない肉の数と、そのとき使う素材の数（req）。
// req.plan は、その「肉がいちばん少ない計画」（req.hours は、そのときの毎日の時間）で、肉の使用は req.meat と同じ。
// 日ごとのカードには、肉が足りるとき、この計画を出す（目標に届く中で、肉が最小）。
// 探索は、枝の数の予算（BUDGET_REQ_NODES）で打ち切る。req.exhausted は、予算を使い切ったか（そのときは、必要な肉が少し多めに出ている可能性がある）
// star（極星器の制約 { n, q }）・caps（回数の上限）・extra（追加の周回に使う難易度の id。priority の候補になくても、使える）を渡せる
function scheduleScenario(priority, { diffs, stock, mat250, need, hoursOpt, star = null, caps = null, extra = null }) {
    let diffsP = allowedDiffs(diffs, priority);
    if (extra) { const ex = diffs.find(d => d.id === extra); if (ex && ex.time > 0 && !diffsP.some(d => d.id === extra)) diffsP = [...diffsP, { ...ex, extra: true }]; }
    const spec = scheduleHoursSpec(diffsP, hoursOpt);
    const solved = solveSchedule({ need, stock, mat250, diffs: diffsP, spec, star, caps });
    const U = solved.unlimited;
    let req = null;
    if (U.reachable) {
        const valve = performance.now() + SAFETY_VALVE_MS;                       // 安全装置（固まるのを防ぐ。ふつうは届かない）
        const budget = { nodes: star ? BUDGET_REQ_NODES_STAR : BUDGET_REQ_NODES };
        let timedOut = false;
        const phasesU = PHASES.map((ph, i) => ({ id: ph.id, maxTier: ph.maxTier, hours: spec[i].fixed ? spec[i].hours : U.hours }));
        const meatOf = (plan) => scheduleUsage(plan, diffsP, 0, null).meat;
        let best = { plan: U.plan, meat: meatOf(U.plan) };                       // 目標に届いた計画のうち、肉がいちばん少ないもの。肉が十分あるときの計画は、その計画の肉の数で届く
        const attempt = (e) => {                                                 // 肉が e 個で、目標に届く整数の計画があるか。途中でやめたときは、枝の数を増やして、もう一度
            const run = (maxNodes) => { const p = planSchedule({ stock: e, mat250: null, phases: phasesU, diffs: diffsP, target: need, maxNodes, deadline: valve, budget, star, caps }); if (p.timedOut) timedOut = true; return p; };
            let p = run(300);
            if (p.total < need && p.complete === false) p = run(star ? RETRY_REQ_NODES_STAR : RETRY_NODES);
            if (p.total >= need) { const m = meatOf(p); if (m < best.meat) best = { plan: p, meat: m }; }
            return p;
        };
        let lo = 0, hi = Math.max(1, best.meat);
        attempt(hi);                                                             // まず、その数で、肉がもっと少ない計画がないか見る（あれば、best が入れ替わる）
        hi = Math.max(1, best.meat);
        // 肉を増やすほど届きやすいので、二分探索。届いた計画が、mid より少ない肉で済んでいれば、その数まで下げる。
        // 難しい問題で、予算を使い切ったら、そこまでに届くとわかった数（hi）で打ち切る
        while (lo < hi && budget.nodes > 0) {
            const mid = Math.floor((lo + hi) / 2);
            if (attempt(mid).total >= need) hi = Math.min(mid, best.meat); else lo = mid + 1;
        }
        req = { meat: best.meat, mat: scheduleUsage(best.plan, diffsP, 0, null).mat, plan: best.plan, hours: U.hours, exhausted: budget.nodes <= 0, timedOut };
    }
    return { priority, diffsP, spec, solved, req };
}
