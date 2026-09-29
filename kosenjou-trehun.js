/**
 * 古戦場ツール：トレハン（ドロップ率）タブ
 *
 * 計算式はリリエルさん「[グラブル]トレハン計算機」（http://liliel.web.fc2.com/gbf/）と同じ：
 *   倍率(%) = 100 ×（1+トレハン）×（1+雫×雫の倍率）×（1+団サポ）×（1+キャラ・武器・召喚石）×（1+大事なもの※独立枠のとき）
 *             ※同じ枠の中は足し算、枠どうしは掛け算
 *   箱(%)   = 箱の基本率 × min(倍率, 300%)
 *   アイテム(%) = min(箱, 100%) × 箱からアイテムが落ちる確率
 * これに、古戦場ツールの討伐時間から「落ちるまでの時間の目安」を足している。
 *
 * 使い方：new TrehunPanel(要素, { getDiffs, getKillTimes, getReloadTimes })
 * 保存先は localStorage の gbf_kj_trehun。
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'gbf_kj_trehun';
    const TOTAL_RATE_MAX = 300;
    const SOURCE_URL = 'http://liliel.web.fc2.com/gbf/index.html';

    // 選択肢（[値(%), 表示]）
    const OPT = {
        trehun: [[0, 'なし'], [20, 'Lv1（20%）'], [22, 'Lv2（22%）'], [24, 'Lv3（24%）'], [26, 'Lv4（26%）'], [28, 'Lv5（28%）'], [31, 'Lv6（31%）'], [35, 'Lv7（35%）'], [40, 'Lv8（40%）'], [50, 'Lv9（50%）'], [70, 'Lv10（70%）']],
        tears: [[0, 'なし'], [2, 'Lv1（2%・1雫）'], [5, 'Lv2（5%・3雫）'], [7, 'Lv3（7%・5雫）'], [10, 'Lv4（10%・10雫）'], [15, 'Lv5（15%・10雫）※プレミアムパス']],
        tearsOdds: [[1, '通常'], [2, '雫2倍'], [3, '雫3倍'], [4, '雫4倍']],
        weathercock: [[0, 'なし'], [10, '10%'], [15, '15%'], [20, '20%']],
        essel: [[0, 'なし'], [5, '4凸エッセル（5%）'], [10, '最終エッセル（10%）']],
        character: [[0, 'なし'], [1, 'リチャード（1%）'], [3, 'ミニック（3%）']],
        weapon: [[0, 'なし'], [2, 'セプティアンバーナー（2%）'], [2, 'スノーフレーク（2%）'], [5, 'オリバー（5%）'], [5, '浄瑠璃（5%）'], [10, 'ダマスカスナイフ（10%）']],
        mainStone: [[0, 'なし'], [3, 'ゴッドラビット[サブ]（3%）'], [10, 'ノビヨ3凸（10%）'], [15, 'ノビヨ4凸（15%）'], [15, 'ホワイトラビット3凸（15%）'], [15, 'ブラックラビット3凸（15%）'], [20, 'カグヤ無凸（20%）'], [20, 'ゴッドラビット[メイン]（20%）'], [25, 'カグヤ3凸（25%）'], [30, 'カグヤ4凸（30%）']],
        friendStone: [[0, 'なし'], [10, 'ノビヨ3凸（10%）'], [15, 'ノビヨ4凸（15%）'], [15, 'ホワイトラビット3凸（15%）'], [15, 'ブラックラビット3凸（15%）'], [20, 'カグヤ無凸（20%）'], [20, 'ゴッドラビット[メイン]（20%）'], [25, 'カグヤ3凸（25%）'], [30, 'カグヤ4凸（30%）']],
        artifact: [[0, 'なし'], [0.5, 'Lv1（0.5%）'], [1, 'Lv2（1%）'], [1.5, 'Lv3（1.5%）'], [2, 'Lv4（2%）'], [2.5, 'Lv5（2.5%）']],
        preciousFrame: [[0, 'トレハン枠'], [1, '雫枠'], [2, '団サポ枠'], [3, 'キャラ・武器・召喚石枠'], [4, '独立枠']],
    };
    // 箱の基本ドロップ率（推定値、リリエルさんのページより）
    const BOX_BASE_BY_DIFF = { h90: 2, h95: 2.5, h100: 3, h150: 3.5, h200: 4 };
    const RICHARD = 1;
    const MINIC = 3;
    const DBEE = 3;
    const PRECIOUS = 3;

    const DEFAULTS = {
        diff: 'h200', boxBase: 4, itemRate: 8,
        trehun: 0, tears: 0, tearsOdds: 0, weathercock: 3, essel: 0, character: 0, coexist: false, richard: false, minic: false,
        weapon: 0, dbee: false, mainStone: 0, friendStone: 0, artifact: 0, precious: false, preciousFrame: 3,
    };

    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const r4 = (v) => Math.round(v * 10000) / 10000;
    const pct = (v) => `${r4(v)}%`;

    /** 計算（UI と切り離してテストできるように） */
    function calc(s) {
        const val = (key) => (OPT[key][s[key]] || OPT[key][0])[0];
        // 枠：0 トレハン / 1 雫 / 2 団サポ / 3 キャラ・武器・召喚石 / 4 大事なもの（独立）
        const frames = [0, 0, 0, 0, 0];
        frames[0] = val('trehun');
        frames[1] = val('tears') * val('tearsOdds');
        frames[2] = val('weathercock');
        let weapon = val('weapon') + (s.dbee ? DBEE : 0) + val('mainStone') + val('friendStone') + val('essel') + val('artifact');
        if (s.coexist) weapon += (s.richard ? RICHARD : 0) + (s.minic ? MINIC : 0);
        else weapon += val('character');
        frames[3] = weapon;
        if (s.precious) frames[val('preciousFrame')] += PRECIOUS;
        const total = frames.reduce((acc, f) => acc * (1 + f / 100), 100);
        const capped = Math.min(total, TOTAL_RATE_MAX);
        const box = (Number(s.boxBase) || 0) * capped / 100;
        const item = Math.min(box, 100) * (Number(s.itemRate) || 0) / 100;
        return { frames, total, capped, box, item };
    }

    /** 1回以上落ちる確率が p になるまでの周回数（1回あたり rate%） */
    function runsFor(ratePct, p) {
        const q = Math.min(ratePct, 100) / 100;
        if (q <= 0) return Infinity;
        if (q >= 1) return 1;
        return Math.ceil(Math.log(1 - p) / Math.log(1 - q));
    }

    function fmtDuration(sec) {
        if (!Number.isFinite(sec)) return '—';
        const m = Math.round(sec / 60);
        if (m < 60) return `${m}分`;
        const h = Math.floor(m / 60);
        return `${h}時間${m % 60 ? `${m % 60}分` : ''}`;
    }

    class TrehunPanel {
        constructor(root, opts) {
            this.root = root;
            this.getDiffs = opts.getDiffs;
            this.getKillTimes = opts.getKillTimes;
            this.getReloadTimes = opts.getReloadTimes || (() => ({}));
            this.state = this.load();
            this.injectStyle();
            this.render();
        }

        load() {
            try {
                const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
                if (!s || typeof s !== 'object') return { ...DEFAULTS };
                const out = { ...DEFAULTS };
                for (const k of Object.keys(DEFAULTS)) {
                    if (typeof DEFAULTS[k] === typeof s[k]) out[k] = s[k];
                }
                return out;
            } catch (e) {
                return { ...DEFAULTS };
            }
        }

        save() {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (e) { /* 保存できなくても動く */ }
        }

        injectStyle() {
            if (document.getElementById('th-style')) return;
            const style = document.createElement('style');
            style.id = 'th-style';
            style.textContent = `
.th-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(230px, 1fr)); gap:8px 16px; }
.th-field { display:flex; flex-direction:column; gap:3px; font-size:0.85em; color:var(--text-2); }
.th-field select, .th-field input[type=number] { font:inherit; font-size:1em; padding:5px 6px; background:var(--bg); color:var(--text); border:1px solid var(--border); border-radius:4px; }
.th-check { display:flex; align-items:center; gap:6px; font-size:0.85em; color:var(--text-2); cursor:pointer; }
.th-sub { font-size:0.8em; font-weight:700; color:var(--accent); margin:12px 0 6px; }
.th-sub:first-child { margin-top:0; }
.th-result { display:grid; gap:10px; }
.th-big { font-size:1.35em; font-weight:700; color:var(--text); }
.th-big small { font-size:0.6em; color:var(--text-2); font-weight:400; margin-left:6px; }
.th-line { font-size:0.85em; color:var(--text-2); line-height:1.7; }
.th-line b { color:var(--text); }
.th-cap { color:#e07070; font-weight:700; }
.th-table { width:100%; border-collapse:collapse; font-size:0.85em; }
.th-table th, .th-table td { padding:5px 8px; border-bottom:1px solid var(--border); text-align:right; white-space:nowrap; }
.th-table th:first-child, .th-table td:first-child { text-align:left; }
.th-table th { color:var(--text-2); font-weight:400; }
.th-credit { font-size:0.76em; color:var(--text-2); margin-top:8px; }
.th-credit a { color:var(--accent); }
`;
            document.head.appendChild(style);
        }

        select(key, label) {
            const opts = OPT[key].map(([, text], i) => `<option value="${i}"${this.state[key] === i ? ' selected' : ''}>${esc(text)}</option>`).join('');
            return `<label class="th-field">${esc(label)}<select data-k="${key}">${opts}</select></label>`;
        }

        check(key, label) {
            return `<label class="th-check"><input type="checkbox" data-c="${key}"${this.state[key] ? ' checked' : ''}> ${esc(label)}</label>`;
        }

        render() {
            const s = this.state;
            const diffs = this.getDiffs();
            const diffOpts = diffs.map((d) => `<option value="${d.id}"${s.diff === d.id ? ' selected' : ''}>${esc(d.name)}${BOX_BASE_BY_DIFF[d.id] ? `（箱 ${BOX_BASE_BY_DIFF[d.id]}%）` : ''}</option>`).join('');
            this.root.innerHTML = `
<div class="card">
  <div class="card-title">周回する難易度とドロップ率</div>
  <div class="th-grid">
    <label class="th-field">難易度<select data-diff>${diffOpts}</select></label>
    <label class="th-field">箱の基本ドロップ率（%）<input type="number" data-n="boxBase" min="0" max="100" step="0.1" value="${s.boxBase}"></label>
    <label class="th-field">箱からアイテムが落ちる確率（%）<input type="number" data-n="itemRate" min="0" max="100" step="0.1" value="${s.itemRate}"></label>
  </div>
  <p class="note" style="margin-top:6px;">箱の基本ドロップ率は難易度を選ぶと推定値（90HELL 2% 〜 200HELL 4%）が入ります。アイテム（極星器など）は 90HELL 8%・95HELL〜 4% が目安です。</p>
</div>
<div class="card">
  <div class="card-title">ドロップ率アップ</div>
  <div class="th-sub">トレハン・雫・団サポ（それぞれ別の枠で掛け算）</div>
  <div class="th-grid">
    ${this.select('trehun', 'トレジャーハント')}
    ${this.select('tears', '雫')}
    ${this.select('tearsOdds', '雫の倍率')}
    ${this.select('weathercock', '団サポ（風見鶏）')}
  </div>
  <div class="th-sub">キャラ・武器・召喚石（この枠の中は足し算）</div>
  <div class="th-grid">
    ${this.select('essel', 'エッセル')}
    <div class="th-field">
      ${s.coexist ? `キャラ${this.check('richard', 'リチャード（1%）')}${this.check('minic', 'ミニック（3%）')}` : this.select('character', 'リチャード・ミニック')}
    </div>
    ${this.select('weapon', 'メイン武器')}
    <div class="th-field">サブ武器${this.check('dbee', 'Dビィ（3%）')}</div>
    ${this.select('mainStone', 'メイン・サブ召喚石')}
    ${this.select('friendStone', 'フレンド召喚石')}
    ${this.select('artifact', 'アーティファクト')}
  </div>
  <div class="th-sub">大事なもの</div>
  <div class="th-grid">
    <div class="th-field">${this.check('precious', 'リーベル・イニティス（3%）')}</div>
    ${this.select('preciousFrame', '入る枠')}
    <div class="th-field">${this.check('coexist', 'リチャード・ミニックを両方使う（共存する）')}</div>
  </div>
</div>
<div class="card">
  <div class="card-title">結果</div>
  <div data-out></div>
  <div class="th-credit">計算式はリリエルさんの「<a href="${SOURCE_URL}" target="_blank" rel="noopener noreferrer">[グラブル]トレハン計算機</a>」を参考にしています。</div>
</div>`;
            this.bind();
            this.update();
        }

        bind() {
            const root = this.root;
            root.querySelectorAll('select[data-k]').forEach((el) => el.addEventListener('change', () => { this.state[el.dataset.k] = +el.value; this.save(); this.update(); }));
            root.querySelectorAll('input[data-c]').forEach((el) => el.addEventListener('change', () => {
                this.state[el.dataset.c] = el.checked;
                this.save();
                if (el.dataset.c === 'coexist') this.render(); else this.update();
            }));
            root.querySelectorAll('input[data-n]').forEach((el) => el.addEventListener('input', () => {
                const v = parseFloat(el.value);
                this.state[el.dataset.n] = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
                this.save();
                this.update();
            }));
            root.querySelector('[data-diff]').addEventListener('change', (e) => {
                this.state.diff = e.target.value;
                if (BOX_BASE_BY_DIFF[this.state.diff]) {
                    this.state.boxBase = BOX_BASE_BY_DIFF[this.state.diff];
                    root.querySelector('input[data-n=boxBase]').value = this.state.boxBase;
                }
                this.save();
                this.update();
            });
        }

        /** 討伐時間の変更などを反映する */
        refresh() {
            this.update();
        }

        update() {
            const out = this.root.querySelector('[data-out]');
            if (!out) return;
            const s = this.state;
            const r = calc(s);
            const names = ['トレハン', '雫', '団サポ', '(キャラ＋武器＋石)', '大事なもの'];
            const parts = r.frames.map((f, i) => (i === 4 && !f ? '' : `${names[i]} ${pct(f)}`)).filter(Boolean).join(' × ');
            const over = r.total >= TOTAL_RATE_MAX;
            const diff = this.getDiffs().find((d) => d.id === s.diff);
            const t1 = this.getKillTimes()[s.diff];
            const t2 = this.getReloadTimes()[s.diff];
            const rows = [['箱', r.box], ['アイテム', r.item]].map(([label, rate]) => {
                const avg = rate > 0 ? 100 / Math.min(rate, 100) : Infinity;
                const n90 = runsFor(rate, 0.9);
                const time = (t) => (t ? `${fmtDuration(avg * t)} ／ ${fmtDuration(n90 * t)}` : '—');
                return `<tr><td>${label}</td><td><b>${pct(Math.min(rate, 100))}</b>${rate >= 100 ? '（確定）' : ''}</td><td>${Number.isFinite(avg) ? `${r4(avg)}周` : '—'}</td><td>${Number.isFinite(n90) ? `${n90}周` : '—'}</td><td>${time(t1)}</td>${t2 ? `<td>${time(t2)}</td>` : ''}</tr>`;
            }).join('');
            out.innerHTML = `
<div class="th-result">
  <div class="th-big">アイテム ${pct(Math.min(r.item, 100))}<small>箱 ${pct(Math.min(r.box, 100))}</small></div>
  <div class="th-line">倍率：${parts} ＝ <b class="${over ? 'th-cap' : ''}">${pct(r.capped)}${over ? `（上限。計算上は ${pct(r.total)}）` : ''}</b></div>
  <div class="th-line">箱：基本 ${pct(s.boxBase)} × ${pct(r.capped)} ＝ <b>${pct(r.box)}</b> ／ アイテム：箱 ${pct(Math.min(r.box, 100))} × ${pct(s.itemRate)} ＝ <b>${pct(r.item)}</b></div>
  <table class="th-table">
    <thead><tr><th></th><th>1回あたり</th><th>平均</th><th>90%で1回は</th><th>${esc(diff ? diff.name : '')} 平均／90%</th>${t2 ? '<th>リロ有 平均／90%</th>' : ''}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="th-line">${t1 ? '時間は「討伐効率」タブの討伐時間から計算しています。' : '「討伐効率」タブでこの難易度の討伐時間を入れると、落ちるまでの時間の目安も出ます。'}${over ? ' 倍率が上限（300%）を超えているので、キャラ・武器・石を減らしても結果は変わりません。' : ''}</div>
</div>`;
        }
    }

    TrehunPanel.calc = calc;
    TrehunPanel.runsFor = runsFor;
    global.TrehunPanel = TrehunPanel;
})(window);
