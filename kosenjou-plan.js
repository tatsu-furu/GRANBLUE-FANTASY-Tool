/**
 * 古戦場ツール：かんたん計画（順番に入れていくと、目標までの計画が出る）
 *
 * 目標 → 今の状況 → 極星器 → 討伐タイム → 走れる日 の順に入れる。わからない所は、飛ばしてもよい。
 * 入れた分だけで、次のことを出す：
 *   ・目標が決まっていて、討伐タイムが1つでもあれば：毎日の時間・難易度ごとの時間・必要な肉と素材・足りない分（肉を集める時間の目安）・日ごとの計画・各日の終了時の目安
 *   ・討伐タイムがなければ：各難易度での必要回数
 *   ・目標を決めなければ：この条件で、どこまで行けるか（貢献度と、順位の目安）
 * 時間優先と肉優先は、結果をタブで分ける。
 *
 * 計算は、ページ側のスケジュールの計算（kosenjou.html の KJ_CORE）をそのまま使う。
 * 使い方：new PlanPanel(要素, core, { getBorderRows, getTrehun })
 *   getBorderRows() → [{ label, rank, current, final }]（ボーダータブの値）
 *   getTrehun()     → { diff, item, box, itemRate }（トレハンタブの、周回する難易度と、1周でアイテムが落ちる確率・箱が落ちる確率・箱からアイテムが落ちる確率（%））
 * 保存先は localStorage の gbf_kj_plan（討伐時間は、討伐効率タブと同じ gbf_kj_times）。
 */
(function (global) {
    'use strict';

    const KEY = 'gbf_kj_plan';
    const { DAYS, num, int0, blank, runsForCount, effectiveTimes, rankEstimate, hoursOptFrom, dayStates, starStats, compute } = PlanCore;   // 計算は kosenjou-plan-core.js（画面に触らない。Web Worker でも動く）
    const WHERE = [['pre', '本戦前（予選前・予選中）'], ['d1', '本戦1日目'], ['d2', '本戦2日目'], ['d3', '本戦3日目'], ['d4', '本戦4日目']];
    const STEPS = [
        { id: 'goal', no: '①', title: '目標' },
        { id: 'now',  no: '②', title: '今の状況' },
        { id: 'star', no: '③', title: '極星器' },
        { id: 'time', no: '④', title: '討伐タイム' },
        { id: 'days', no: '⑤', title: '走れる日' },
    ];
    const MARKS = [['o', '○'], ['t', '△'], ['x', '×']];
    const DEFAULTS = {
        open: 'goal',
        goalKind: 'number', goalText: '', goalRank: 0,
        where: 'pre', curText: '', meatText: '', matText: '', collectText: '',
        starCollect: 'no', starText: '', starMode: 'avg', starDiff: '',
        timeMode: 'full', oneId: 'h150', oneMin: '', oneSec: '',
        gatherMin: '10', gatherMeat: '',
        triHours: '3', normalHours: '4', detail: false,
        tab: 'time',
    };

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

    const W_TAB = (cur, k) => (cur === k ? '▶ ' : '　');

    // ───────────── 画面 ─────────────

    class PlanPanel {
        constructor(root, core, opts) {
            this.root = root;
            this.core = core;
            this.opts = opts || {};
            this.state = this.load();
            this.seq = 0; this.inflight = 0; this.pending = null;
            this.injectStyle();
            this.build();
            this.worker = this.makeWorker();
            this.update();
        }

        freshState() {
            return { ...DEFAULTS, rough: {}, marks: { d1: 'o', d2: 'o', d3: 'o', d4: 'o' }, hours: { d1: '', d2: '', d3: '', d4: '' }, skipped: {}, fresh: true };
        }

        load() {
            const W = this.freshState();
            let s = null;
            try { s = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { s = null; }
            if (s && typeof s === 'object') {
                W.fresh = false;
                Object.keys(DEFAULTS).forEach((k) => { if (typeof DEFAULTS[k] === typeof s[k]) W[k] = s[k]; });
                if (s.marks && typeof s.marks === 'object') DAYS.forEach((d) => { if (['o', 't', 'x'].includes(s.marks[d])) W.marks[d] = s.marks[d]; });
                if (s.hours && typeof s.hours === 'object') DAYS.forEach((d) => { if (typeof s.hours[d] === 'string') W.hours[d] = s.hours[d]; });
                if (s.rough && typeof s.rough === 'object') Object.keys(s.rough).forEach((id) => { const r = s.rough[id]; if (r && typeof r === 'object') W.rough[id] = { min: String(r.min == null ? '' : r.min), runs: String(r.runs == null ? '' : r.runs) }; });
                if (s.skipped && typeof s.skipped === 'object') Object.keys(s.skipped).forEach((k) => { if (s.skipped[k] === true) W.skipped[k] = true; });
            }
            if (s && typeof s === 'object' && typeof s.starCollect !== 'string' && (num(s.starText) || 0) > 0) W.starCollect = 'yes';     // 古い保存：欲しい本数が入っていたら、「集める」
            if (W.open !== '' && !STEPS.some((st) => st.id === W.open)) W.open = 'goal';
            const pick = (k, list) => { if (!list.includes(W[k])) W[k] = DEFAULTS[k]; };
            pick('goalKind', ['number', 'rank', 'none']); pick('where', WHERE.map((x) => x[0])); pick('timeMode', ['full', 'one', 'rough']);
            pick('tab', ['time', 'meat']); pick('starMode', ['avg', 'p90']); pick('starCollect', ['no', 'yes']); pick('starDiff', ['', 'auto', ...this.core.HELL_DIFFS.map((d) => d.id)]); pick('oneId', this.core.HELL_DIFFS.map((d) => d.id));
            if (!Number.isFinite(W.goalRank)) W.goalRank = 0;
            return W;
        }

        save() {
            const { fresh, ...rest } = this.state;
            try { localStorage.setItem(KEY, JSON.stringify(rest)); } catch (e) { /* 保存できなくても動く */ }
        }

        /** はじめて開いたとき：ほかのタブに入っている目標・貢献度・肉・素材を、取り込む */
        adopt() {
            const v = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
            const W = this.state;
            if (v('t-goal')) W.goalText = v('t-goal');
            if (v('t-cur') && v('t-cur') !== '0') W.curText = v('t-cur');
            if (parseInt(v('m-normal')) > 0) W.meatText = String(parseInt(v('m-normal')));
            if (parseInt(v('m-mat')) > 0) W.matText = String(parseInt(v('m-mat')));
            if (parseInt(v('s-collect')) > 0) W.collectText = String(parseInt(v('s-collect')));
        }

        /** ほかのタブ（目標計算・肉計算）に入っている値 */
        otherTabs() {
            const v = (id) => { const el = document.getElementById(id); return el ? String(el.value || '').trim() : ''; };
            const pos = (id) => { const n = parseInt(v(id)); return n > 0 ? String(n) : ''; };
            return { goal: v('t-goal'), cur: v('t-cur') !== '0' ? v('t-cur') : '', meat: pos('m-normal'), mat: pos('m-mat') };
        }

        importFromTabs(what) {
            const W = this.state, o = this.otherTabs();
            if (what === 'goal' && o.goal) { W.goalKind = 'number'; W.goalText = o.goal; delete W.skipped.goal; }
            if (what === 'now') {
                if (o.cur) W.curText = o.cur;
                if (o.meat) W.meatText = o.meat;
                if (o.mat) W.matText = o.mat;
            }
        }

        injectStyle() {
            if (document.getElementById('pl-style')) return;
            const style = document.createElement('style');
            style.id = 'pl-style';
            style.textContent = `
.pl-intro { font-size:0.85em; color:var(--text-2); line-height:1.7; margin-bottom:10px; }
.pl-chips { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:10px; }
.pl-chip { font:inherit; font-size:0.78em; padding:4px 10px; border:1px solid var(--border); border-radius:999px; background:var(--surface); color:var(--text-3); cursor:pointer; }
.pl-chip:hover { border-color:var(--accent); color:var(--accent); }
.pl-chip.done { color:var(--text); border-color:var(--accent-lo); }
.pl-chip.on { background:var(--accent); color:var(--on-accent); border-color:var(--accent); }
.pl-sum { position:sticky; top:0; z-index:6; margin-bottom:10px; padding:8px 12px; background:var(--surface-2, var(--surface)); border:1px solid var(--accent-lo); border-left:3px solid var(--accent); font-size:0.88em; line-height:1.6; color:var(--text); }
.pl-sum small { color:var(--text-3); }
.pl-step { border:1px solid var(--border); background:var(--surface); border-radius:2px; }
.pl-step.open { border-color:var(--accent-lo); }
.pl-head { width:100%; display:flex; align-items:center; gap:8px; padding:10px 12px; background:none; border:0; color:var(--text); font:inherit; cursor:pointer; text-align:left; }
.pl-no { color:var(--accent); font-weight:700; }
.pl-ttl { font-weight:700; font-size:0.92em; }
.pl-state { font-size:0.72em; padding:1px 8px; border-radius:999px; border:1px solid var(--border); color:var(--text-3); white-space:nowrap; }
.pl-state.done { color:#4caf50; border-color:#3a6b3c; }
.pl-state.skip { color:var(--text-3); }
.pl-summ { margin-left:auto; font-size:0.8em; color:var(--text-2); text-align:right; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pl-body { padding:4px 12px 12px; border-top:1px solid var(--border); }
.pl-body[hidden] { display:none; }
.pl-arrow { text-align:center; color:var(--accent-lo); font-size:0.8em; line-height:1.5; }
.pl-seg { display:flex; flex-wrap:wrap; gap:6px; margin:10px 0; }
.pl-seg button, .pl-nav button, .pl-rt button { font:inherit; font-size:0.84em; padding:6px 12px; background:var(--bg); color:var(--text-2); border:1px solid var(--border); border-radius:4px; cursor:pointer; }
.pl-seg button:hover, .pl-nav button:hover, .pl-rt button:hover { border-color:var(--accent); color:var(--accent); }
.pl-seg button.on, .pl-rt button.on { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:700; }
.pl-nav { display:flex; gap:8px; margin-top:12px; justify-content:flex-end; }
.pl-nav .pl-next { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:700; }
.pl-sub { font-size:0.78em; font-weight:700; color:var(--accent); margin:14px 0 6px; }
.pl-rows { display:flex; flex-direction:column; gap:6px; margin:6px 0; }
.pl-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:0.88em; }
.pl-row .pl-k { min-width:7em; color:var(--text-2); font-weight:700; }
.pl-row input[type=number], .pl-row input[type=text], .pl-row select { font:inherit; font-size:0.95em; padding:5px 6px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px; }
.pl-row input[type=number] { width:100px; text-align:right; -moz-appearance:textfield; appearance:textfield; }
.pl-row input[type=number]::-webkit-outer-spin-button, .pl-row input[type=number]::-webkit-inner-spin-button { -webkit-appearance:none; margin:0; }
.pl-row input.pl-s { width:60px; }
.pl-row .pl-u { color:var(--text-3); font-size:0.9em; }
.pl-row .pl-calc { color:var(--text-3); font-size:0.85em; }
.pl-marks { display:inline-flex; gap:4px; }
.pl-marks button { font:inherit; font-size:0.95em; width:36px; padding:4px 0; background:var(--bg); color:var(--text-2); border:1px solid var(--border); border-radius:4px; cursor:pointer; }
.pl-marks button.on { background:var(--accent); color:var(--on-accent); border-color:var(--accent); font-weight:700; }
.pl-day-past { opacity:0.5; }
.pl-res .pl-rt { display:flex; gap:6px; margin-bottom:10px; }
.pl-res[data-busy] [data-resbody] { opacity:0.55; transition:opacity 0.15s; }
.pl-head-line { font-size:1.12em; font-weight:700; color:var(--accent); line-height:1.5; }
.pl-head-line.ng { color:#e07070; }
.pl-head-line.ok { color:#4caf50; }
.pl-ok { color:#4caf50; font-weight:700; padding:12px; text-align:center; }
.pl-line { font-size:0.84em; color:var(--text-2); line-height:1.8; }
.pl-line b { color:var(--text); }
.pl-line a, .pl-calc a { color:var(--accent); }
.pl-line.pl-calc { color:var(--text-3); font-size:0.8em; }
.pl-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:8px; margin:10px 0; }
.pl-box { border:1px solid var(--border); background:var(--bg); padding:8px 10px; }
.pl-box .k { font-size:0.74em; color:var(--text-3); }
.pl-box .v { font-size:1.1em; font-weight:700; color:var(--text); }
.pl-box .s { font-size:0.78em; color:var(--text-2); margin-top:2px; line-height:1.5; }
.pl-bad { color:#e07070; font-weight:700; }
.pl-good { color:#4caf50; font-weight:700; }
.pl-advice { margin:8px 0; padding:8px 12px; border-left:3px solid var(--accent-lo); background:var(--accent-bg); font-size:0.85em; line-height:1.8; color:var(--text-2); }
.pl-advice li { margin-left:1.1em; }
.pl-star { margin:10px 0; padding:8px 12px; border:1px solid var(--border); background:var(--bg); }
.pl-days { display:grid; grid-template-columns:repeat(auto-fit, minmax(210px, 1fr)); gap:8px; margin:10px 0; }
.pl-card { border:1px solid var(--border); background:var(--bg); padding:8px 10px; font-size:0.84em; line-height:1.7; }
.pl-card.past { opacity:0.5; }
.pl-card-h { display:flex; align-items:center; justify-content:space-between; gap:6px; margin-bottom:4px; }
.pl-card-t { color:var(--accent); font-weight:700; }
.pl-card-f { color:var(--text-3); font-size:0.92em; margin-top:2px; }
.pl-notice { font-size:0.82em; color:var(--text-2); line-height:1.7; margin:4px 0; }
.pl-notice a { color:var(--accent); }
.pl-notice .base-btn { margin-left:6px; font-size:0.9em; padding:3px 10px; }
@media (max-width: 600px) { .pl-row .pl-k { min-width:100%; } .pl-summ { display:none; } .pl-sum { position:static; } }
`;
            document.head.appendChild(style);
        }

        // ───── 画面の部品 ─────
        seg(field, items) {
            return `<div class="pl-seg" data-seg="${field}">${items.map(([v, t]) => `<button type="button" data-v="${v}">${esc(t)}</button>`).join('')}</div>`;
        }

        step(st, body) {
            return `
<section class="pl-step" data-step="${st.id}">
  <button type="button" class="pl-head" data-head="${st.id}" aria-expanded="false">
    <span class="pl-no">${st.no}</span><span class="pl-ttl">${esc(st.title)}</span><span class="pl-state" data-state="${st.id}"></span><span class="pl-summ" data-summ="${st.id}"></span>
  </button>
  <div class="pl-body" data-body="${st.id}" hidden>${body}
    <div class="pl-nav">${st.id === 'days' ? '' : `<button type="button" data-skip="${st.id}">スキップ</button>`}<button type="button" class="pl-next" data-next="${st.id}">${st.id === 'days' ? '結果を見る ▼' : '次へ ▼'}</button></div>
  </div>
</section>`;
        }

        /** 画面の骨組みを作る（入力欄・ボタンなど。結果の中身は、render(R, env)） */
        build() {
            const core = this.core;
            const HELL = core.HELL_DIFFS;
            const contribList = (() => { const v = []; for (let x = 5; x <= 200; x += 5) v.push(x); v.push(300, 400, 500, 700, 1000); return v.map((x) => `<option value="${x}億"></option>`).join(''); })();
            const fullRows = HELL.map((d) => `
<div class="pl-row"><span class="pl-k">${esc(d.name)}</span>
  <input type="number" min="0" max="${d.is250 ? 90 : 30}" inputmode="numeric" data-tf="${d.id}" data-part="min" class="pl-s" placeholder="0"><span class="pl-u">分</span>
  <input type="number" min="0" max="59" inputmode="numeric" data-tf="${d.id}" data-part="sec" class="pl-s" placeholder="0"><span class="pl-u">秒</span></div>`).join('');
            const roughRows = HELL.map((d) => `
<div class="pl-row"><span class="pl-k">${esc(d.name)}</span>
  <input type="number" min="1" inputmode="numeric" data-rough="${d.id}" data-part="min" class="pl-s" placeholder="${d.is250 ? 30 : 5}"><span class="pl-u">分で</span>
  <input type="number" min="0" inputmode="numeric" data-rough="${d.id}" data-part="runs" placeholder="回数"><span class="pl-u">回</span><span class="pl-calc" data-roughcalc="${d.id}"></span></div>`).join('');
            const oneOpts = HELL.filter((d) => d.id !== HELL[HELL.length - 1].id).map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('');
            const body = {
                goal: `
${this.seg('goalKind', [['number', '数字で入れる'], ['rank', '順位（ボーダー）から選ぶ'], ['none', '決めない']])}
<div data-box="goal-number">
  <div class="pl-row"><span class="pl-k">目標貢献度</span><input type="text" id="pl-goal" data-f="goalText" list="pl-contrib-list" inputmode="decimal" autocomplete="off" placeholder="例：50億" style="width:140px"><span class="pl-calc" data-echo="goal"></span></div>
  <datalist id="pl-contrib-list">${contribList}</datalist>
  <div class="pl-notice">「50億」「1億5000万」のように入れます。</div>
  <div class="pl-notice" data-importgoal hidden></div>
</div>
<div data-box="goal-rank" hidden>
  <div class="pl-row"><span class="pl-k">順位</span><select data-rank></select></div>
  <div class="pl-notice" data-rankinfo></div>
</div>
<div data-box="goal-none" hidden><div class="pl-notice">目標を決めずに、「この条件で、どこまで行けるか」を見ます。⑤で、1日に走れる時間を入れてください。</div></div>`,
                now: `
${this.seg('where', WHERE)}
<div class="pl-notice">予選では貢献度がほとんど増えないので、予選前と予選中は同じ扱いです（いまの肉の数だけ入れてください）。</div>
<div class="pl-rows">
  <div class="pl-row"><span class="pl-k">今の貢献度</span><input type="text" data-f="curText" inputmode="decimal" autocomplete="off" placeholder="なければ空" list="pl-contrib-list" style="width:140px"><span class="pl-calc" data-echo="cur"></span></div>
  <div class="pl-row"><span class="pl-k">通常肉</span><input type="number" min="0" data-f="meatText" inputmode="numeric" placeholder="未入力"><span class="pl-u">個</span><span class="pl-calc">空にすると、必要な数だけ出します</span></div>
  <div class="pl-row"><span class="pl-k">250専用素材</span><input type="number" min="0" data-f="matText" inputmode="numeric" placeholder="未入力"><span class="pl-u">個</span><span class="pl-calc">空にすると、素材の数は気にせず、必要な合計を出します</span></div>
  <div class="pl-row"><span class="pl-k">集める予定の肉</span><input type="number" min="0" data-f="collectText" inputmode="numeric" placeholder="0"><span class="pl-u">個</span><span class="pl-calc">これから集める予定の分（任意）</span></div>
</div>
<div class="pl-notice" data-importnow hidden></div>`,
                star: `
<div class="pl-sub" style="margin-top:6px">たくさん集める？</div>
${this.seg('starCollect', [['no', '集めない'], ['yes', '集める']])}
<div class="pl-notice">目標のために周回すれば、極星器は、そのぶん落ちます。結果に、計画の周回で落ちる本数の目安を出します。たくさん欲しいときだけ「集める」を選ぶと、その本数に届くための追加の周回も、計画に入れます。</div>
<div data-box="star-yes" hidden>
  <div class="pl-row"><span class="pl-k">欲しい本数</span><input type="number" min="0" data-f="starText" inputmode="numeric" placeholder="0"><span class="pl-u">本</span></div>
  <div class="pl-row"><span class="pl-k">見積り</span><select data-f="starMode"><option value="avg">平均で</option><option value="p90">90%の確率で届くように</option></select></div>
  <div class="pl-row"><span class="pl-k">追加で回す難易度</span><select data-f="starDiff"><option value="">おまかせ（いちばん得な増やし方）</option>${HELL.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
</div>
<div class="pl-notice" data-starinfo></div>`,
                time: `
${this.seg('timeMode', [['full', 'しっかり入力'], ['one', '1つだけ入力（ほかは同じ効率で推定）'], ['rough', 'ざっくり（◯分で何回）']])}
<div data-box="time-full"><div class="pl-notice">討伐効率タブと同じ時間です（ここで入れると、そちらにも入ります）。入れていない難易度は、使いません。</div><div class="pl-rows">${fullRows}</div></div>
<div data-box="time-one" hidden>
  <div class="pl-notice">1つだけ入れると、それより上の難易度（例：150HELL なら 200HELL・250HELL）を、同じ貢献度/時間だと考えて、時間を推定します。</div>
  <div class="pl-row"><span class="pl-k">基準</span><select data-f="oneId">${oneOpts}</select>
    <input type="number" min="0" data-f="oneMin" class="pl-s" inputmode="numeric" placeholder="0"><span class="pl-u">分</span><input type="number" min="0" max="59" data-f="oneSec" class="pl-s" inputmode="numeric" placeholder="0"><span class="pl-u">秒</span></div>
  <div class="pl-notice" data-onelist></div>
</div>
<div data-box="time-rough" hidden>
  <div class="pl-notice">時間を計るのが面倒なときは、「◯分で何回周回できたか」を入れます（わかる難易度だけでかまいません）。</div>
  <div class="pl-rows">${roughRows}</div>
</div>
<div class="pl-sub">肉を集める速さ（任意）</div>
<div class="pl-row"><span class="pl-k">肉集め</span><input type="number" min="1" data-f="gatherMin" class="pl-s" inputmode="numeric" placeholder="10"><span class="pl-u">分で肉</span><input type="number" min="0" data-f="gatherMeat" inputmode="numeric" placeholder="個数"><span class="pl-u">個</span><span class="pl-calc">肉が足りないとき、あと何時間集めればよいかを出します</span></div>`,
                days: `
<div class="pl-notice">本戦の日ごとに、走れそうかを選びます。○＝走れる（目標に届く時間を、自動で決めます）／△＝少しだけ／×＝走れない。あとから、結果の日ごとのカードでも変えられます。</div>
<div class="pl-rows" data-daylist></div>
<div class="pl-row"><span class="pl-k">△の日の時間</span><input type="number" min="0" step="0.5" data-f="triHours" inputmode="decimal" placeholder="3"><span class="pl-u">時間</span></div>
<div class="pl-row" data-normalrow hidden><span class="pl-k">○の日の時間</span><input type="number" min="0" step="0.5" data-f="normalHours" inputmode="decimal" placeholder="4"><span class="pl-u">時間（目標を決めないときだけ使います）</span></div>
<label class="pl-row" style="cursor:pointer;margin-top:6px;"><input type="checkbox" data-f="detail"> 走れる時間を日ごとに細かく入れる</label>`,
            };
            this.root.innerHTML = `
<div class="pl-intro">順番に入れると、目標までの計画が出ます。わからない所は「スキップ」でかまいません。入れた分だけで、わかる範囲の結果を出します。 <button type="button" class="base-btn" data-reset style="margin-left:6px;">最初からやり直す</button></div>
<div class="pl-chips" data-chips></div>
<div class="pl-sum" data-sum></div>
${STEPS.map((st, i) => this.step(st, body[st.id]) + (i < STEPS.length - 1 ? '<div class="pl-arrow">▼</div>' : '')).join('')}
<div class="pl-arrow">▼</div>
<div class="card pl-res" data-res>
  <div class="card-title">結果</div>
  <div class="pl-rt" data-rtabs><button type="button" data-rt="time">時間優先</button><button type="button" data-rt="meat">肉優先</button></div>
  <div data-resbody></div>
</div>`;
            this.bind();
            this.syncInputs();
        }

        // ───── 入力の反映 ─────
        timeRowValue(id) {
            const sec = this.core.getKillTimes()[id];
            return sec > 0 ? { min: String(Math.floor(sec / 60)), sec: String(Math.round(sec % 60)) } : { min: '', sec: '' };
        }

        /** 状態を、入力欄に入れる（開いたとき・ほかのタブから戻ったとき） */
        syncInputs() {
            const W = this.state, root = this.root;
            root.querySelectorAll('[data-f]').forEach((el) => {
                const k = el.dataset.f;
                if (el.type === 'checkbox') el.checked = !!W[k]; else el.value = W[k];
            });
            root.querySelectorAll('[data-tf]').forEach((el) => { const v = this.timeRowValue(el.dataset.tf); el.value = v[el.dataset.part]; });
            root.querySelectorAll('[data-rough]').forEach((el) => { const r = W.rough[el.dataset.rough]; el.value = r ? r[el.dataset.part] : ''; });
        }

        bind() {
            const root = this.root, W = this.state;
            const change = () => { this.save(); this.update(); };
            root.addEventListener('click', (e) => {
                const t = e.target.closest('button');
                if (!t || !root.contains(t)) return;
                if (t.dataset.head) { W.open = W.open === t.dataset.head ? '' : t.dataset.head; return change(); }
                if (t.dataset.chip) { W.open = t.dataset.chip; this.save(); this.update(); const sec = root.querySelector(`[data-step="${W.open}"]`); if (sec && sec.scrollIntoView) sec.scrollIntoView({ block: 'nearest' }); return; }
                if (t.dataset.next || t.dataset.skip) {
                    const id = t.dataset.next || t.dataset.skip;
                    if (t.dataset.skip) W.skipped[id] = true; else delete W.skipped[id];
                    const i = STEPS.findIndex((s) => s.id === id);
                    W.open = i + 1 < STEPS.length ? STEPS[i + 1].id : '';
                    this.save(); this.update();
                    const tgt = W.open ? root.querySelector(`[data-step="${W.open}"]`) : root.querySelector('[data-res]');
                    if (tgt && tgt.scrollIntoView) tgt.scrollIntoView({ block: 'nearest' });
                    return;
                }
                if (t.dataset.reset != null) {
                    if (!global.confirm('入力した目標・今の状況・極星器・タイムなどを、すべて消します。よろしいですか？（討伐効率タブの討伐時間は、そのまま残ります）')) return;
                    const fresh = this.freshState();
                    Object.keys(W).forEach((k) => delete W[k]);
                    Object.assign(W, fresh, { fresh: false });
                    this.syncInputs();
                    return change();
                }
                if (t.dataset.import) { this.importFromTabs(t.dataset.import); this.syncInputs(); return change(); }
                if (t.dataset.rt) { W.tab = t.dataset.rt; return change(); }
                if (t.dataset.mark) { W.marks[t.dataset.day] = t.dataset.mark; return change(); }
                const seg = t.closest('[data-seg]');
                if (seg && t.dataset.v != null) { W[seg.dataset.seg] = t.dataset.v; delete W.skipped[{ goalKind: 'goal', where: 'now', timeMode: 'time', starCollect: 'star' }[seg.dataset.seg]]; return change(); }
            });
            root.addEventListener('input', (e) => this.onInput(e));
            root.addEventListener('change', (e) => this.onInput(e));
        }

        onInput(e) {
            const el = e.target, W = this.state;
            if (el.dataset.f != null) {
                W[el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value;
                if (['goalText'].includes(el.dataset.f)) delete W.skipped.goal;
            } else if (el.dataset.rank != null) {
                W.goalRank = parseInt(el.value) || 0;
            } else if (el.dataset.rough != null) {
                const id = el.dataset.rough;
                W.rough[id] = { min: '', runs: '', ...(W.rough[id] || {}) };
                W.rough[id][el.dataset.part] = el.value;
            } else if (el.dataset.hours != null) {
                W.hours[el.dataset.hours] = el.value;
            } else if (el.dataset.tf != null) {
                const id = el.dataset.tf;
                const minEl = this.root.querySelector(`[data-tf="${id}"][data-part="min"]`), secEl = this.root.querySelector(`[data-tf="${id}"][data-part="sec"]`);
                const sec = (num(minEl.value) || 0) * 60 + (num(secEl.value) || 0);
                this.core.setKillTime(id, sec > 0 ? sec : null);
            } else return;
            this.save();
            this.update();
        }

        /** ほかのタブの入力が復元されたあとに、ページ側から呼ぶ：まだ何も保存していなければ、ほかのタブの目標・肉などを取り込む */
        afterRestore() {
            if (this.state.fresh) this.adopt();
            this.syncInputs();
            this.update();
        }

        /** ほかのタブから戻ったとき：討伐効率タブで変えた時間などを、取り込む */
        refresh() {
            this.syncInputs();
            this.update();
        }

        // ───── 計算と表示 ─────
        env() {
            const rows = (this.opts.getBorderRows ? this.opts.getBorderRows() : []).filter((r) => r.rank > 0 && (r.final != null || r.current != null) && (r.final ?? r.current) > 0);
            const points = rows.map((r) => ({ rank: r.rank, value: r.final != null ? r.final : r.current })).sort((a, b) => a.rank - b.rank);
            return { rows, points, trehun: this.opts.getTrehun ? this.opts.getTrehun() : null, killTimes: this.core.getKillTimes() };
        }

        /**
         * 入力が変わったときに呼ぶ。計算は、Worker（別のスレッド）に任せ、結果が届いたら画面に出す（render）。
         * 計算中の入力は、最新の1つだけ取っておく。古い入力の結果は、捨てる。Worker が使えないときは、その場で計算する
         */
        update() {
            const W = this.state;
            const env = this.env();
            this._env = env;
            this.renderInputs(W, env);                                  // 入力のまわり（計算に頼らない部分）は、すぐ更新する
            const payload = { id: ++this.seq, W: JSON.parse(JSON.stringify(W)), env };
            if (!this.worker) { this.render(compute(payload.W, env), env); return; }
            this.root.querySelector('[data-res]').dataset.busy = '1';               // 計算中（前の結果を、うすく出しておく）
            if (this.inflight) { this.pending = payload; return; }
            this.send(payload);
        }

        send(payload) {
            this.inflight = payload.id;
            this.worker.postMessage(payload);
        }

        /** Worker から結果が届いた */
        onResult(msg) {
            this.inflight = 0;
            if (msg.error) { this.giveUpWorker(msg.error); return; }
            if (msg.id === this.seq) {                                   // 最新の入力の結果だけを出す
                this.pending = null;
                delete this.root.querySelector('[data-res]').dataset.busy;
                this.render(msg.R, this._env);
            } else if (this.pending) {
                const next = this.pending; this.pending = null; this.send(next);
            }
        }

        /** Worker が使えなかった（読み込めない・計算で例外）：以後は、ページの中で計算する */
        giveUpWorker(reason) {
            try { if (this.worker) this.worker.terminate(); } catch (e) { /* 何もしない */ }
            this.worker = null; this.inflight = 0; this.pending = null;
            this.workerError = reason;
            delete this.root.querySelector('[data-res]').dataset.busy;
            this.update();
        }

        /** 計算が終わっている（待っている入力がない）ときに解決する。テストや、続けて何かをしたいときに使う */
        whenIdle() {
            return new Promise((resolve) => {
                const check = () => { if (!this.worker || (!this.inflight && !this.pending)) resolve(); else setTimeout(check, 5); };
                check();
            });
        }

        makeWorker() {
            if (global.KJ_NO_WORKER || typeof global.Worker === 'undefined') return null;
            try {
                const w = new global.Worker(this.opts.workerUrl || 'kosenjou-worker.js');
                w.onmessage = (e) => this.onResult(e.data);
                w.onerror = (e) => { if (e && e.preventDefault) e.preventDefault(); this.giveUpWorker(String((e && e.message) || 'Worker のエラー')); };
                return w;
            } catch (e) {
                return null;
            }
        }

        /** 入力のまわり（切り替えボタン・枠の出し入れ・入力のとなりの表示など。計算の結果に頼らない部分） */
        renderInputs(W, env) {
            const core = this.core;
            const root = this.root;
            const $ = (sel) => root.querySelector(sel);
            const fmtC = core.fmtC;

            // 切り替えボタンと、枠の出し入れ
            root.querySelectorAll('[data-seg]').forEach((seg) => seg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === String(W[seg.dataset.seg]))));
            root.querySelectorAll('[data-rt]').forEach((b) => b.classList.toggle('on', b.dataset.rt === W.tab));
            ['goal-number', 'goal-rank', 'goal-none'].forEach((k) => { const el = $(`[data-box="${k}"]`); if (el) el.hidden = k !== `goal-${W.goalKind}`; });
            ['time-full', 'time-one', 'time-rough'].forEach((k) => { const el = $(`[data-box="${k}"]`); if (el) el.hidden = k !== `time-${W.timeMode}`; });
            const normalRow = $('[data-normalrow]'); if (normalRow) normalRow.hidden = W.goalKind !== 'none';
            STEPS.forEach((st) => {
                const open = W.open === st.id;
                $(`[data-body="${st.id}"]`).hidden = !open;
                $(`[data-head="${st.id}"]`).setAttribute('aria-expanded', open ? 'true' : 'false');
                $(`[data-step="${st.id}"]`).classList.toggle('open', open);
            });

            // 順位の選択肢
            const sel = $('[data-rank]');
            if (sel) {
                const opts = env.rows.slice().sort((a, b) => a.rank - b.rank);
                const html = opts.length ? opts.map((r) => `<option value="${r.rank}">${esc(r.label)}（${r.final != null ? '最終予想' : '現在'} ${fmtC(r.final != null ? r.final : r.current)}）</option>`).join('') : '<option value="0">ボーダーの値がありません</option>';
                if (sel.dataset.sig !== html) { sel.innerHTML = html; sel.dataset.sig = html; }
                if (!opts.some((r) => r.rank === W.goalRank) && opts.length) { W.goalRank = (opts.find((r) => r.rank === 2000) || opts[0]).rank; this.save(); }
                sel.value = String(W.goalRank);
            }

            // 入力のとなりの表示
            const echo = (k, text) => { const el = $(`[data-echo="${k}"]`); if (el) el.textContent = text; };
            const goalN = core.parseGoal(W.goalText), curN = core.parseGoal(W.curText);
            echo('goal', blank(W.goalText) ? '' : (goalN ? `＝ ${goalN.toLocaleString()}` : '読み取れません'));
            echo('cur', blank(W.curText) ? '' : (curN != null ? `＝ ${curN.toLocaleString()}` : '読み取れません'));
            // ほかのタブの値が、ここと違うときの案内
            const o = this.otherTabs();
            const goalDiff = o.goal && core.parseGoal(o.goal) > 0 && !(W.goalKind === 'number' && core.parseGoal(W.goalText) === core.parseGoal(o.goal));
            const impG = $('[data-importgoal]');
            if (impG) { impG.hidden = !goalDiff; if (goalDiff) impG.innerHTML = `目標計算タブには「<b>${esc(o.goal)}</b>」が入っています。<button type="button" class="base-btn" data-import="goal">これを使う</button>`; }
            const nowDiffs = [];
            if (o.cur && core.parseGoal(o.cur) !== (core.parseGoal(W.curText) || 0)) nowDiffs.push(`今の貢献度 ${esc(o.cur)}`);
            if (o.meat && o.meat !== String(int0(W.meatText))) nowDiffs.push(`通常肉 ${Number(o.meat).toLocaleString()}個`);
            if (o.mat && o.mat !== String(int0(W.matText))) nowDiffs.push(`250専用素材 ${Number(o.mat).toLocaleString()}個`);
            const impN = $('[data-importnow]');
            if (impN) { impN.hidden = !nowDiffs.length; if (nowDiffs.length) impN.innerHTML = `ほかのタブには「${nowDiffs.join('・')}」が入っています。<button type="button" class="base-btn" data-import="now">これを使う</button>`; }
        }

        /** 計算の結果（R）を、画面に出す */
        render(R, env) {
            const W = this.state, core = this.core;
            this.R = R;
            const root = this.root;
            const $ = (sel) => root.querySelector(sel);
            const fmtC = core.fmtC;
            const rankInfo = $('[data-rankinfo]');
            if (rankInfo) rankInfo.innerHTML = R.goal.kind === 'rank' && R.goal.value ? `${esc(R.goal.label)}の${R.goal.basis === 'final' ? '最終予想' : '現在のボーダー'}：<b>${fmtC(R.goal.value)}</b>` : (env.rows.length ? '' : 'ボーダータブに値がありません。<a href="#border">ボーダータブ</a>で「最新を取得」を押すか、値を入れてください。');
            this.updateStarInfo(R, env);
            this.updateTimeInfo(R);
            this.updateDayList(R);

            // 要約・進み具合・結果
            STEPS.forEach((st) => {
                const s = this.stepState(st.id, R);
                const stEl = $(`[data-state="${st.id}"]`);
                stEl.textContent = s.label; stEl.className = `pl-state ${s.cls}`;
                $(`[data-summ="${st.id}"]`).textContent = s.summary;
            });
            $('[data-chips]').innerHTML = STEPS.map((st) => { const s = this.stepState(st.id, R); return `<button type="button" class="pl-chip ${s.cls}${W.open === st.id ? ' on' : ''}" data-chip="${st.id}">${st.no} ${esc(st.title.replace('（なくてもよい）', ''))}</button>`; }).join('');
            $('[data-sum]').innerHTML = this.summaryHtml(R);
            $('[data-resbody]').innerHTML = this.resultHtml(R, env);
        }

        stepState(id, R) {
            const W = this.state, core = this.core, fmtC = core.fmtC;
            const skipped = !!W.skipped[id];
            let done = false, summary = '';
            if (id === 'goal') {
                done = R.goal.kind === 'none' || R.goal.value > 0;
                summary = R.goal.kind === 'none' ? '決めない' : (R.goal.value > 0 ? fmtC(R.goal.value) : '未入力');
            } else if (id === 'now') {
                done = !blank(W.meatText) || !blank(W.curText) || !blank(W.matText) || W.where !== 'pre';
                const where = (WHERE.find((x) => x[0] === W.where) || WHERE[0])[1].replace('（予選前・予選中）', '');
                summary = `${where}・肉 ${blank(W.meatText) ? '―' : int0(W.meatText).toLocaleString()}`;
            } else if (id === 'star') {
                done = W.starCollect === 'yes' && R.star.n > 0;
                summary = W.starCollect === 'yes' ? (R.star.n > 0 ? `${R.star.n}本集める` : '本数を入れてください') : '集めない';
            } else if (id === 'time') {
                const n = Object.keys(R.ti.times).length - R.ti.estimated.length;
                done = n > 0;
                summary = n > 0 ? `${n}つ入力${R.ti.estimated.length ? `＋推定${R.ti.estimated.length}つ` : ''}` : '未入力';
            } else if (id === 'days') {
                done = DAYS.some((d) => W.marks[d] !== 'o' || (W.detail && !blank(W.hours[d]))) || W.where !== 'pre';
                summary = R.days.filter((d) => !d.past).map((d) => ({ o: '○', t: '△', x: '×' }[d.mark])).join('') || '―';
            }
            return { label: skipped && !done ? 'スキップ' : (done ? '入力済み' : (id === 'days' || id === 'star' ? '初期値' : '未入力')), cls: done ? 'done' : (skipped ? 'skip' : ''), summary, done };
        }

        updateStarInfo(R, env) {
            const root = this.root, W = this.state, core = this.core, st = R.star;
            const box = root.querySelector('[data-box="star-yes"]'); if (box) box.hidden = W.starCollect !== 'yes';
            const sel = root.querySelector('select[data-f="starDiff"]');
            if (sel) [...sel.options].forEach((o) => { const u = o.value && st.unknown.some((x) => x.id === o.value); o.disabled = !!u; if (o.value) o.textContent = `${(core.HELL_DIFFS.find((d) => d.id === o.value) || {}).name || o.value}${u ? '（確率不明）' : ''}`; });
            const el = root.querySelector('[data-starinfo]');
            if (!el) return;
            const p = (x) => `${Math.round(x * 1000) / 1000}%`;
            const known = core.HELL_DIFFS.filter((d) => st.rates[d.id]).map((d) => `${esc(d.name)} ${p(st.rates[d.id].item)}`);
            let html = `1周で極星器が落ちる確率（<a href="#trehun">トレハンタブ</a>の設定。ドロップ率アップやアイテムの確率を入れると変わります）：<br>${known.length ? known.join('・') : '―'}`;
            if (st.unknown.length) html += `<br><span class="pl-calc">${esc(st.unknown.map((x) => x.name).join('・'))} は、確率がわからない（箱の基本率のデータがない）ので、極星器の本数には数えません。</span>`;
            if (W.starCollect === 'yes' && !st.anyKnown) html += '<br><span class="pl-bad">確率がわかる難易度がありません。本数の目安を出せません。</span>';
            el.innerHTML = html;
        }

        updateTimeInfo(R) {
            const root = this.root, core = this.core, W = this.state;
            // 「ざっくり」：1回あたりの時間
            core.HELL_DIFFS.forEach((d) => {
                const el = root.querySelector(`[data-roughcalc="${d.id}"]`);
                if (!el) return;
                const t = R.ti.mode === 'rough' ? R.ti.times[d.id] : null;
                el.textContent = t ? `＝ 1回 約 ${core.fmtTime(Math.round(t))}` : '';
            });
            // 「1つだけ」：推定した時間の一覧
            const one = root.querySelector('[data-onelist]');
            if (one) {
                one.innerHTML = R.ti.base
                    ? `推定した時間：${core.HELL_DIFFS.filter((d) => R.ti.estimated.includes(d.id)).map((d) => `${esc(d.name)} ${core.fmtTime(Math.round(R.ti.times[d.id]))}`).join('・') || 'なし（基準より上の難易度がありません）'}。基準より下の難易度は、使いません。`
                    : '基準の難易度と時間を入れてください。';
            }
        }

        /** ⑤：日ごとの ○△×（と、細かい時間）の並び */
        updateDayList(R) {
            const list = this.root.querySelector('[data-daylist]');
            if (!list) return;
            const W = this.state;
            const sig = JSON.stringify([R.days.map((d) => [d.id, d.past, d.now]), W.detail]);
            if (list.dataset.sig !== sig) {
                list.dataset.sig = sig;
                list.innerHTML = R.days.map((d) => `
<div class="pl-row${d.past ? ' pl-day-past' : ''}" data-dayrow="${d.id}"><span class="pl-k">${esc(this.dayName(d.id))}${d.now ? '（今日）' : ''}</span>
  ${d.past ? '<span class="pl-calc">終わりました</span>' : `<span class="pl-marks">${MARKS.map(([v, t]) => `<button type="button" data-mark="${v}" data-day="${d.id}">${t}</button>`).join('')}</span>
  ${W.detail ? `<input type="number" min="0" max="17" step="0.5" data-hours="${d.id}" inputmode="decimal" placeholder="自動"><span class="pl-u">時間</span>` : ''}`}</div>`).join('');
                list.querySelectorAll('[data-hours]').forEach((el) => { el.value = W.hours[el.dataset.hours]; });
            }
            list.querySelectorAll('[data-mark]').forEach((b) => b.classList.toggle('on', W.marks[b.dataset.day] === b.dataset.mark));
        }

        dayName(id) { return (this.core.PHASES.find((p) => p.id === id) || {}).name || id; }

        // ───── 結果 ─────
        hhmm(h) { return h ? this.core.fmtTime(Math.round(h * 3600)) : '0時間'; }

        summaryHtml(R) {
            const core = this.core, fmtC = core.fmtC, W = this.state;
            if (R.done) return '🎉 今の貢献度で、すでに目標を超えています';
            const v = R.views && R.views[W.tab];
            if (v) {
                const meat = v.req ? `必要な通常肉 ${v.req.meat.toLocaleString()}個${v.shortage ? (v.shortage.meat > 0 ? `（<span class="pl-bad">あと ${v.shortage.meat.toLocaleString()}個</span>）` : '（足ります）') : ''}` : '';
                return `<b>${W.tab === 'time' ? '時間優先' : '肉優先'}</b>：${this.headline(v, R, true)}${meat ? ` ／ ${meat}` : ''}`;
            }
            const f = R.forward && R.forward[W.tab];
            if (f) return `<b>この条件だと</b>、貢献度 約 ${fmtC(f.finalTotal)}${f.rank ? `（順位の目安：${f.rank.text}）` : ''}`;
            if (R.goal.value > 0 && R.counts) return `目標まで あと ${fmtC(R.need0)}。④で討伐タイムを入れると、毎日の時間と肉の計画が出ます。`;
            return '<small>①目標を入れる（または「決めない」）と、ここに要点が出ます。</small>';
        }

        /** 見出しの文（short = 要約用の短い形） */
        headline(v, R, short) {
            const core = this.core;
            const future = v.days.filter((d) => !R.days.find((x) => x.id === d.id).past);
            const autos = future.filter((d) => !d.fixed);
            const who = autos.length === future.length ? '毎日' : `自動の日（${autos.map((d) => d.name).join('・')}）は`;
            if (v.hasAuto) {
                return v.reachable
                    ? `${who} 約 ${this.hhmm(v.autoHours)}ずつで、届きます`
                    : `${who} ${core.DAY_MAX_HOURS}時間ずつ（1日の上限）でも、届きません`;
            }
            return v.reachable ? `決めた時間で、届きます（見込み ${core.fmtC(v.finalTotal)}）` : `決めた時間では、届きません（見込み ${core.fmtC(v.finalTotal)}）`;
        }

        notices(R) {
            const out = [];
            const g = R.goal;
            if (g.kind === 'number' && g.empty) out.push('①で目標を入れてください（「決めない」を選ぶと、この条件でどこまで行けるかを出します）。');
            if (g.kind === 'number' && g.invalid) out.push('目標を読み取れません。「50億」「1億5000万」のように入れてください。');
            if (g.kind === 'rank' && g.missing) out.push('選んだ順位のボーダーがありません。<a href="#border">ボーダータブ</a>で値を取得してください。');
            if (g.kind === 'none' && !R.hasTime) out.push('④で討伐タイムを1つでも入れると、毎日の時間と肉の計画が出ます。1つだけでも、ほかの難易度を同じ効率で推定できます。');
            if (g.value > 0 && R.hasTime && !R.meatKnown && R.views) out.push('通常肉が未入力なので、足りるかどうかは出していません（必要な数だけ出します）。');
            return out;
        }

        resultHtml(R, env) {
            const core = this.core, W = this.state, fmtC = core.fmtC;
            const parts = [];
            if (R.views) parts.push(this.compareHtml(R));
            this.notices(R).forEach((t) => parts.push(`<div class="pl-notice">${t}</div>`));
            if (R.done) parts.push('<div class="pl-ok">🎉 今の貢献度で、すでに目標を超えています</div>');
            const v = R.views && R.views[W.tab];
            if (v) parts.push(this.planHtml(v, R));
            const f = R.forward && R.forward[W.tab];
            if (f) parts.push(this.forwardHtml(f, R));
            if (!v && !f && R.counts && !R.done) parts.push(this.countsHtml(R));
            if (!parts.length) parts.push('<div class="no-data">①から順に入れると、ここに結果が出ます</div>');
            return parts.join('');
        }

        /** 時間優先と肉優先を、1行ずつ並べる（結果のタブを切り替えなくても、見比べられるように） */
        compareHtml(R) {
            const line = (k, name) => {
                const v = R.views[k];
                const meat = v.req ? `必要な通常肉 ${v.req.meat.toLocaleString()}個` : '';
                return `<div>${W_TAB(this.state.tab, k)}<b>${name}</b>：${this.headline(v, R, true)}${meat ? `・${meat}` : ''}</div>`;
            };
            return `<div class="pl-line" style="margin-bottom:8px;">${line('time', '時間優先')}${line('meat', '肉優先')}</div>`;
        }

        /** 極星器の欄（見込みの本数・追加の周回）。v … 結果の1つ（目標があるとき planView、ないとき forward） */
        starHtml(R, v) {
            const core = this.core, st = R.star, s = v.stars;
            if (!s) return '';
            const f2 = (x) => (Math.round(x * 100) / 100).toLocaleString();
            const pct = (q) => `${Math.round(q * 100000) / 1000}%`;
            const lines = [];
            if (!st.anyKnown) return '<div class="pl-star"><div class="pl-bad">極星器：確率がわかる難易度がないので、本数は出せません（<a href="#trehun">トレハンタブ</a>の設定を確かめてください）。</div></div>';
            lines.push(`<div class="pl-line"><b>極星器</b>：この計画の周回で、<b>期待 約 ${f2(s.mean)}本</b>（90%の確率で <b>${s.n90}本以上</b>）落ちます。</div>`);
            const used = s.byDiff.filter((x) => x.q != null);
            lines.push(`<div class="pl-line pl-calc" data-starbasis>${used.length ? `${used.map((x) => `${esc(x.name)}・1周 ${pct(x.q)}`).join('、')} で計算` : '極星器が落ちる難易度を、周回しません'}（<a href="#trehun">トレハンタブ</a>の設定。周回数：${used.map((x) => `${esc(x.name)} ${x.runs.toLocaleString()}周`).join('・') || '―'}）${s.unknownUsed.length ? `。${esc(s.unknownUsed.join('・'))} は確率不明なので、数えていません` : ''}</div>`);
            if (st.collect && st.n > 0) {
                if (v.starBlocked || v.starUnmet) lines.push(`<div class="pl-line pl-bad">${st.n}本は、${v.starUnmet ? 'いまの走れる時間では' : `1日 ${core.DAY_MAX_HOURS}時間（本戦の1日に遊べる上限）でも`}集められません。極星器の本数を決めない計画を出しています。</div>`);
                else if (v.base) {
                    const b = v.base.stars;
                    if (b.mean >= st.n - 1e-9) lines.push(`<div class="pl-line pl-good">追加の周回はいりません（計画どおりで、期待 約 ${f2(b.mean)}本）。</div>`);
                    else {
                        const up = [], down = [];
                        const ids = [...new Set([...s.byDiff.map((x) => x.id), ...b.byDiff.map((x) => x.id)])];
                        ids.forEach((id) => {
                            const name = (s.byDiff.find((x) => x.id === id) || b.byDiff.find((x) => x.id === id)).name;
                            const d = ((s.runsById[id]) || 0) - ((b.runsById[id]) || 0);
                            if (d > 0) up.push(`${esc(name)} を ${d.toLocaleString()}回`); else if (d < 0) down.push(`${esc(name)} ${(-d).toLocaleString()}回`);
                        });
                        const dm = v.hasAuto && v.reachable && v.base.reachable && v.base.autoHours != null ? Math.round((v.autoHours - v.base.autoHours) * 60) : null;
                        const dmeat = v.req && v.base.reqMeat != null ? v.req.meat - v.base.reqMeat : null;
                        const extra = [dm != null ? `毎日 ${dm >= 0 ? '+' : '−'}${Math.abs(dm).toLocaleString()}分` : '', dmeat != null ? `肉 ${dmeat >= 0 ? '+' : '−'}${Math.abs(dmeat).toLocaleString()}個` : ''].filter(Boolean).join('、');
                        lines.push(`<div class="pl-line" data-starextra>計画どおりだと期待 約 ${f2(b.mean)}本 → <b>${st.n}本</b>欲しいなら、<b>追加で ${up.join('・') || '（周回の組み直しだけ）'}</b>${extra ? `（${extra}）` : ''}。${down.length ? `<br><span class="pl-calc">そのぶん、組み直した周回：${down.join('・')} 減</span>` : ''}</div>`);
                        if (v.p90Unmet) lines.push(`<div class="pl-line pl-bad">90%の確率で ${st.n}本に届く平均には、1日 ${core.DAY_MAX_HOURS}時間でも届かないので、平均で ${st.n}本の計画を出しています（${st.n}本以上になる確率は ${Math.round((s.pAtLeast || 0) * 100)}%）。</div>`);
                        else if (st.mode === 'p90') lines.push(`<div class="pl-line pl-calc">${st.n}本以上になる確率は ${Math.round((s.pAtLeast || 0) * 1000) / 10}%（90%以上になるように、平均の目標を上げて解き直しています）。</div>`);
                        else lines.push(`<div class="pl-line pl-calc">平均で ${st.n}本の計画です（${st.n}本以上になる確率は ${Math.round((s.pAtLeast || 0) * 100)}% くらい。確実にしたいときは、③で「90%の確率で届くように」を選んでください）。</div>`);
                    }
                }
            }
            return `<div class="pl-star">${lines.join('')}</div>`;
        }

        planHtml(v, R) {
            const core = this.core, fmtC = core.fmtC, W = this.state;
            const future = v.days.filter((d) => !R.days.find((x) => x.id === d.id).past);
            const total = future.reduce((a, d) => a + d.hours, 0);
            const goal = R.goal.value;
            const lines = [];
            lines.push(`<div class="pl-head-line ${v.reachable ? '' : 'ng'}">${this.headline(v, R)}</div>`);
            if (!v.reachable) lines.push(`<div class="pl-line">そのときの見込みは <b>${fmtC(v.finalTotal)}</b>（あと ${fmtC(Math.max(0, goal - v.finalTotal))}）。</div>`);
            lines.push(`<div class="pl-line">使う時間は、合計 <b>${this.hhmm(total)}</b>。${v.bd.length ? `<br>難易度ごとの時間：${esc(core.hoursText(v.bd, '・'))}` : ''}</div>`);
            lines.push(this.starHtml(R, v));                                    // 極星器の見込み・追加の周回
            // 必要な肉・素材
            const sh = v.shortage;
            const matKnown = R.mat250 != null;
            const boxes = [];
            if (v.req) {
                boxes.push(`<div class="pl-box"><div class="k">必要な通常肉</div><div class="v">${v.req.meat.toLocaleString()}個</div><div class="s">${sh ? (sh.meat > 0 ? `<span class="pl-bad">いま ${(R.meat + R.collect).toLocaleString()}個 → あと ${sh.meat.toLocaleString()}個 足りません</span>（200HELL なら約 ${Math.ceil(sh.meat / 20).toLocaleString()}回ぶん）` : `<span class="pl-good">いま ${(R.meat + R.collect).toLocaleString()}個で足ります</span>`) : '（いまの肉が未入力）'}</div></div>`);
                boxes.push(`<div class="pl-box"><div class="k">必要な250専用素材</div><div class="v">${v.req.mat > 0 ? `${v.req.mat.toLocaleString()}個` : '使いません'}</div><div class="s">${v.req.mat > 0 ? `250HELL ${Math.ceil(v.req.mat / 20).toLocaleString()}回` : ''}${matKnown && v.req.mat > 0 ? (sh && sh.mat > 0 ? `<br><span class="pl-bad">いま ${R.mat250.toLocaleString()}個 → あと ${sh.mat.toLocaleString()}個 足りません</span>` : `<br><span class="pl-good">いま ${R.mat250.toLocaleString()}個で足ります</span>`) : (v.req.mat > 0 ? '<br>（いまの素材は未入力）' : '')}</div></div>`);
            }
            boxes.push(`<div class="pl-box"><div class="k">見込みの貢献度</div><div class="v">${fmtC(v.finalTotal)}</div><div class="s">目標 ${fmtC(goal)}（${Math.round(v.finalTotal / goal * 100)}%）${this.rankText(v.finalTotal, R) ? `<br>順位の目安：${this.rankText(v.finalTotal, R)}` : ''}</div></div>`);
            lines.push(`<div class="pl-grid">${boxes.join('')}</div>`);
            // 提案
            const adv = [];
            if (sh && sh.meat > 0) {
                const g = R.gatherPerHour;
                const gatherH = g ? sh.meat / g : null;
                const autoDays = v.days.filter((d) => !d.fixed && !R.days.find((x) => x.id === d.id).past).length;
                const saveH = v.hasAuto && v.idealReach && v.reachable ? Math.max(0, v.autoHours - v.idealHours) * autoDays : 0;
                adv.push(`通常肉があと ${sh.meat.toLocaleString()}個 足りません。${g ? `肉集めが「${esc(W.gatherMin)}分で ${esc(W.gatherMeat)}個」なら、あと <b>約 ${core.fmtHM(gatherH * 3600)}</b> 集めると足ります（予選などで）。` : '④で「◯分で肉◯個」を入れると、あと何時間集めればよいかも出ます。'}②の「集める予定の肉」に入れると、計画に反映されます。`);
                if (saveH > 0) adv.push(`肉が足りれば、毎日 約 ${this.hhmm(v.idealHours)}で届きます（いまは 約 ${this.hhmm(v.autoHours)}）。本戦で、合計 <b>約 ${core.fmtHM(saveH * 3600)}</b> 節約できます${gatherH ? (gatherH < saveH ? `。集める時間（約 ${core.fmtHM(gatherH * 3600)}）より長いので、集める価値があります。` : `。ただし、集める時間（約 ${core.fmtHM(gatherH * 3600)}）のほうが長いので、無理に集めなくてもかまいません。`) : '。'}`);
            }
            if (sh && sh.mat > 0) adv.push(`250専用素材があと ${sh.mat.toLocaleString()}個（250HELL ${Math.ceil(sh.mat / 20).toLocaleString()}回ぶん）足りません。足りないぶんは、ほかの難易度で回すので、いまの計画は時間が増えています。`);
            if (!v.reachable && v.idealReach && v.hasAuto) adv.push(`肉と素材が足りれば、${this.headline({ ...v, reachable: true, autoHours: v.idealHours }, R)}。`);
            if (!v.reachable && !v.idealReach) adv.push(`この走れる日・タイムだと、肉と素材が十分あっても届きません。目標を下げるか、走れる日（×・△）を減らすか、討伐タイムを縮めてください。${this.rankText(v.finalTotal, R) ? `いまの条件で届くのは 約 ${fmtC(v.finalTotal)}（順位の目安：${this.rankText(v.finalTotal, R)}）です。` : ''}`);
            if (!v.hasAuto && v.reachable === false) adv.push('すべての日の時間を決めているので、時間を増やすか、「○」にして自動にすると、届く時間を出せます。');
            if (adv.length) lines.push(`<ul class="pl-advice">${adv.map((a) => `<li>${a}</li>`).join('')}</ul>`);
            // 日ごとのカード
            lines.push(`<div class="pl-days">${v.days.map((d) => this.dayCard(d, R, v)).join('')}</div>`);
            if (v.checkpoints.length) lines.push(`<div class="pl-line"><b>${v.reachable ? '各日の終了時に、これだけの貢献度があれば順調です' : 'この条件だと、各日の終了時の見込み'}</b><br>${v.checkpoints.map((c) => `${esc(c.name)}終了時：<b>${fmtC(c.total)}</b>（目標の ${Math.round(c.total / goal * 100)}%）`).join('<br>')}</div>`);
            return lines.join('');
        }

        rankText(value, R) {
            const r = rankEstimate(value, (this._env || this.env()).points);
            return r ? r.text : '';
        }

        dayCard(d, R, v) {
            const core = this.core, fmtC = core.fmtC;
            const st = R.days.find((x) => x.id === d.id);
            let title, body = '';
            if (st.past) { title = '終わりました'; }
            else if (d.noTier) title = '使える難易度なし';
            else if (d.hours <= 0) title = '走らない';
            else title = `${this.hhmm(d.hours)}${d.fixed ? '' : '（自動）'}`;
            if (!st.past) {
                body = d.parts.length ? d.parts.map((p) => `${esc(p.name)} ${p.runs.toLocaleString()}回`).join('<br>') : (d.hours > 0 && !d.noTier ? '<span class="pl-card-f">回数なし（いまの肉は、ほかの日に回すほうが、貢献度が高いため）</span>' : '');
            }
            const marks = st.past ? '' : `<span class="pl-marks">${MARKS.map(([m, t]) => `<button type="button" data-mark="${m}" data-day="${d.id}" class="${st.mark === m ? 'on' : ''}">${t}</button>`).join('')}</span>`;
            return `<div class="pl-card${st.past ? ' past' : ''}"><div class="pl-card-h"><b>${esc(d.name)}</b>${marks}</div><div class="pl-card-t">${title}</div><div>${body}</div>${st.past || !d.gain ? '' : `<div class="pl-card-f">獲得 ${fmtC(d.gain)}${d.meat ? `・肉 ${d.meat.toLocaleString()}` : ''}${d.mat ? `・素材 ${d.mat.toLocaleString()}` : ''}</div>`}${!st.past && v.showIdle && d.hours > 0 && d.parts.length ? `<div class="pl-card-f" data-idle>余裕 ${Math.floor(d.idleSec / 60).toLocaleString()}分</div>` : ''}</div>`;
        }

        forwardHtml(f, R) {
            const core = this.core, fmtC = core.fmtC;
            const lines = [];
            lines.push(`<div class="pl-head-line">この条件だと、貢献度 約 ${fmtC(f.finalTotal)}${f.rank ? `（順位の目安：${f.rank.text}）` : ''}</div>`);
            lines.push(`<div class="pl-line">使う時間は、合計 <b>${this.hhmm(f.days.reduce((a, d) => a + d.hours, 0))}</b>。${f.bd.length ? `<br>難易度ごとの時間：${esc(core.hoursText(f.bd, '・'))}` : ''}<br>使う通常肉 <b>${f.use.meat.toLocaleString()}個</b>${f.use.mat ? `・250専用素材 <b>${f.use.mat.toLocaleString()}個</b>` : ''}${R.meatKnown ? '' : '（いまの肉が未入力なので、肉は足りる前提です）'}</div>`);
            lines.push(this.starHtml(R, f));
            lines.push(`<div class="pl-days">${f.days.map((d) => this.dayCard(d, R, f)).join('')}</div>`);
            if (f.checkpoints.length) lines.push(`<div class="pl-line"><b>各日の終了時の見込み</b><br>${f.checkpoints.map((c) => `${esc(c.name)}終了時：<b>${fmtC(c.total)}</b>`).join('<br>')}</div>`);
            lines.push('<div class="pl-notice">目標を入れると、そこに届くのに必要な時間・肉が出ます（①）。</div>');
            return lines.join('');
        }

        countsHtml(R) {
            const core = this.core, fmtC = core.fmtC;
            const rows = R.counts.map((c) => `<tr><td>${esc(c.name)}</td><td>${c.runs.toLocaleString()}回</td><td>${c.sec ? core.fmtTime(Math.round(c.sec)) : '―'}</td><td>${c.meat ? `${c.meat.toLocaleString()}個` : (c.mat ? `${c.mat.toLocaleString()}個（素材）` : '―')}</td><td>${c.stars != null ? `約 ${(Math.round(c.stars * 100) / 100).toLocaleString()}本` : '確率不明'}</td></tr>`).join('');
            return `<div class="pl-notice">討伐タイムがないので、<b>各難易度だけで回したとき</b>の回数の目安を出しています（あと ${fmtC(R.need0)}）。④で討伐タイムを1つでも入れると、毎日の時間と、肉の計画が出ます。</div>
<div style="overflow-x:auto"><table class="data-table"><thead><tr><th>難易度</th><th>必要回数</th><th>所要時間</th><th>必要な肉（素材）</th><th>極星器（期待）</th></tr></thead><tbody>${rows}</tbody></table></div>`;
        }
    }

    PlanPanel.runsForCount = runsForCount;
    PlanPanel.effectiveTimes = effectiveTimes;
    PlanPanel.rankEstimate = rankEstimate;
    PlanPanel.hoursOptFrom = hoursOptFrom;
    PlanPanel.dayStates = dayStates;
    PlanPanel.starStats = starStats;
    PlanPanel.compute = compute;
    PlanPanel.DEFAULTS = DEFAULTS;
    global.PlanPanel = PlanPanel;
})(window);
