/*
 * 古戦場ボーダー確認パネル（BorderPanel）
 *
 * ボーダーの集計サイト（gbfdata.com / live.gbfranking.com）で見た値を入れる（またはコピーしたテキストを貼る）と、
 * 自分の貢献度から「どのボーダーに届くか」「届かせるには毎時いくつ必要で、どの難易度なら間に合うか」を表示する。
 * 「最新を取得」で gbfdata.com の API（CORS 許可あり）から各順位の現在値・直近1時間の伸び・前回の推移を読み、
 * 前回の同じ時刻→最終の伸び率から最終予想を出す。取得はボタンを押したときだけ（自動で繰り返さない）。
 *
 * 組み込み方（kosenjou.html の本体のスクリプトより後に置く）:
 *   <div id="border-panel"></div>
 *   <script src="kosenjou-border.js"></script>
 *   <script>
 *     const borderPanel = new BorderPanel(document.getElementById('border-panel'), {
 *       getDiffs: () => DIFFS,             // [{ id, name, contrib }]
 *       getKillTimes: () => killTimes,     // { [id]: 討伐秒数 }
 *       getReloadTimes: () => Object.fromEntries([...reloadEnabled].filter((id) => killTimes2[id]).map((id) => [id, killTimes2[id]])),  // 任意: リロ有の討伐秒数
 *     });
 *     // 討伐時間を変えたあとやタブを開いたときに borderPanel.refresh() を呼ぶ
 *   </script>
 * 色は親ページの CSS 変数（--accent, --text など）を使う。保存先は localStorage の gbf_kj_border。
 */
(function (global) {
    'use strict';

    const STORAGE_KEY = 'gbf_kj_border';
    const SOURCES = [
        { name: 'gbfdata（ボーダー推移）', url: 'https://gbfdata.com/ja/user/border' },
        { name: 'グラブルランキング速報', url: 'https://live.gbfranking.com/' },
    ];
    const DEFAULT_ROWS = [
        { label: '2000位', current: null, final: null },
        { label: '10万位', current: null, final: null },
    ];

    function parsePoint(text) {
        if (text == null) return null;
        let s = String(text).normalize('NFKC').replace(/[,\s]/g, '');
        if (!s) return null;
        let mul = 1;
        if (s.endsWith('億')) { mul = 1e8; s = s.slice(0, -1); }
        else if (s.endsWith('万')) { mul = 1e4; s = s.slice(0, -1); }
        const n = parseFloat(s);
        return Number.isFinite(n) ? Math.round(n * mul) : null;
    }

    function fmtPoint(n) {
        if (n == null || !Number.isFinite(n)) return '─';
        if (Math.abs(n) >= 1e8) return (n / 1e8).toFixed(2).replace(/\.?0+$/, '') + '億';
        if (Math.abs(n) >= 1e4) return (n / 1e4).toFixed(1).replace(/\.0$/, '') + '万';
        return Math.round(n).toLocaleString();
    }

    function fmtHours(h) {
        if (!Number.isFinite(h)) return '─';
        const total = Math.round(h * 60);
        const hh = Math.floor(total / 60);
        const mm = total % 60;
        return hh > 0 ? `${hh}時間${mm ? mm + '分' : ''}` : `${mm}分`;
    }

    function esc(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    }

    /** 「2,000位 12,345,678,901」「12万位 3.2億」のような行から順位ラベルと値を拾う */
    function parseBorderText(text) {
        const rows = [];
        for (const raw of String(text).normalize('NFKC').split(/\r?\n/)) {
            const line = raw.trim();
            if (!line) continue;
            const rank = line.match(/([\d,.]+\s*[万]?)\s*位/);
            const nums = [...line.replace(/([\d,.]+\s*[万]?)\s*位/, ' ').matchAll(/[\d][\d,.]*\s*[億万]?/g)]
                .map((m) => parsePoint(m[0]))
                .filter((n) => n != null && n >= 1e6);
            if (!rank || nums.length === 0) continue;
            rows.push({ label: rank[0].replace(/\s/g, ''), current: nums[0], final: nums.length > 1 ? nums[nums.length - 1] : null });
        }
        return rows;
    }

    const GBFDATA_API = 'https://gbfdata.com/api/users/borders';
    const BATTLE_OPEN_HOUR = 7; // 毎日 0〜7時は集計が止まる

    /** 「2000位」「12万位」「100000」→ 順位の数値 */
    function rankOf(label) {
        const m = String(label).normalize('NFKC').replace(/[,\s]/g, '').match(/^(\d+(?:\.\d+)?)(万)?位?$/);
        return m ? Math.round(parseFloat(m[1]) * (m[2] ? 1e4 : 1)) : null;
    }

    function rankLabel(rank) {
        return rank % 10000 === 0 ? `${rank / 10000}万位` : `${rank.toLocaleString()}位`;
    }

    /**
     * gbfdata の /api/users/borders の応答を順位ごとにまとめる。
     * 最終予想 = 現在値 × (前回の最終値 ÷ 前回の同じ日・同じ時刻の値)
     */
    function parseGbfdata(json) {
        const meta = json && json.meta;
        const series = (json && Array.isArray(json.data) ? json.data : []).filter((d) => d && d.type === 'rank');
        const prev = json && Array.isArray(json.additional) ? json.additional : [];
        const rows = series.map((sr) => {
            const sum = sr.summary || {};
            const points = Array.isArray(sr.points) ? sr.points : [];
            const last = points[points.length - 1] || {};
            const before = prev.find((p) => p && p.target_rank === sr.target_rank);
            let final = null;
            let ratio = null;
            if (before && Array.isArray(before.points) && last.day_of != null) {
                const same = before.points.find((p) => p.day_of === last.day_of && p.time === last.time);
                const prevFinal = before.summary && before.summary.current_point;
                if (same && same.point > 0 && prevFinal > 0 && Number.isFinite(sum.current_point)) {
                    ratio = prevFinal / same.point;
                    final = Math.round(sum.current_point * ratio);
                }
            }
            const toXY = (arr) => (Array.isArray(arr) ? arr : [])
                .filter((p) => Number.isFinite(p.point) && p.day_of != null && p.time)
                .map((p) => ({ x: (p.day_of - 1) * 24 + parseInt(p.time, 10), p: p.point }));
            return {
                rank: sr.target_rank,
                cur: toXY(points),
                prev: before ? toXY(before.points) : [],
                current: Number.isFinite(sum.current_point) ? sum.current_point : null,
                at: last.day_of != null ? `${last.day_of}日目 ${last.time}` : '',
                lastHour: Number.isFinite(sum.last_hour_point) ? sum.last_hour_point : null,
                final,
                ratio,
                prevRaid: before ? before.raid_number : null,
            };
        });
        const days = meta && Array.isArray(meta.schedules) ? meta.schedules.map((x) => x.day).filter(Boolean).sort() : [];
        return { raid: meta ? meta.raid_number : null, generatedAt: meta ? meta.generated_at : null, lastDay: days[days.length - 1] || null, rows };
    }

    /** 今から最終日の24時までのうち、毎日7〜24時（集計が動いている時間）の合計時間（日本時間で計算） */
    function remainingActiveHours(lastDay, now = new Date()) {
        if (!lastDay) return null;
        const jst = (y, mo, d, h) => Date.UTC(y, mo, d, h - 9);
        const [y, mo, d] = lastDay.split('-').map(Number);
        const end = jst(y, mo - 1, d, 24);
        let t = now.getTime();
        if (t >= end) return 0;
        let hours = 0;
        const nowJst = new Date(t + 9 * 3600e3);
        for (let day = Date.UTC(nowJst.getUTCFullYear(), nowJst.getUTCMonth(), nowJst.getUTCDate()); ; day += 86400e3) {
            const dt = new Date(day);
            const open = jst(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), BATTLE_OPEN_HOUR);
            const close = jst(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate(), 24);
            if (open >= end) break;
            hours += Math.max(0, Math.min(close, end) - Math.max(open, t)) / 3600e3;
        }
        return hours;
    }

    /** 1・2・2.5・5 × 10^n の切りのいい目盛り幅 */
    function niceStep(raw) {
        if (!(raw > 0)) return 1;
        const pow = 10 ** Math.floor(Math.log10(raw));
        return [1, 2, 2.5, 5, 10].map((m) => m * pow).find((v) => v >= raw);
    }

    class BorderPanel {
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
            const fallback = { rows: DEFAULT_ROWS.map((r) => ({ ...r })), mine: null, days: 0, hours: 0, target: 0, fetchNote: '' };
            try {
                const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
                if (!s || !Array.isArray(s.rows)) return fallback;
                const xy = (a) => (Array.isArray(a) ? a.filter((q) => q && Number.isFinite(q.x) && Number.isFinite(q.p)).slice(0, 400) : []);
                return {
                    rows: s.rows.slice(0, 8).map((r) => ({
                        label: typeof r.label === 'string' ? r.label.slice(0, 20) : '',
                        current: Number.isFinite(r.current) ? r.current : null,
                        final: Number.isFinite(r.final) ? r.final : null,
                        lastHour: Number.isFinite(r.lastHour) ? r.lastHour : null,
                        cur: xy(r.cur),
                        prev: xy(r.prev),
                        at: typeof r.at === 'string' ? r.at.slice(0, 20) : '',
                    })),
                    mine: Number.isFinite(s.mine) ? s.mine : null,
                    days: Number.isFinite(s.days) ? s.days : 0,
                    hours: Number.isFinite(s.hours) ? s.hours : 0,
                    target: Number.isInteger(s.target) ? s.target : 0,
                    fetchNote: typeof s.fetchNote === 'string' ? s.fetchNote.slice(0, 200) : '',
                };
            } catch (e) {
                return fallback;
            }
        }

        save() {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); } catch (e) { /* 保存できなくても動く */ }
        }

        injectStyle() {
            if (document.getElementById('bd-style')) return;
            const style = document.createElement('style');
            style.id = 'bd-style';
            style.textContent = `
.bd-step { display:flex; align-items:center; gap:8px; }
.bd-step b { display:inline-grid; place-items:center; width:22px; height:22px; border-radius:50%; background:var(--accent); color:var(--on-accent, #0c0800); font-size:0.8em; }
.bd-fetch { display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin:6px 0 4px; }
.bd-btn { background:transparent; border:1px solid var(--border); color:var(--text-2); border-radius:4px; padding:4px 12px; cursor:pointer; font:inherit; font-size:0.85em; }
.bd-btn:hover { border-color:var(--accent); color:var(--accent); }
.bd-btn.bd-primary { background:var(--accent); border-color:var(--accent); color:var(--on-accent, #0c0800); font-weight:700; padding:6px 16px; font-size:0.95em; }
.bd-btn.bd-primary:hover { color:var(--on-accent, #0c0800); filter:brightness(1.1); }
.bd-btn:disabled { opacity:0.5; cursor:wait; }
.bd-status { font-size:0.78em; color:var(--text-3); }
.bd-ranks { display:grid; grid-template-columns:repeat(auto-fill, minmax(210px, 1fr)); gap:8px; margin-top:8px; }
.bd-rank { display:block; border:1px solid var(--border); border-radius:6px; padding:8px 10px; cursor:pointer; background:var(--bg); }
.bd-rank.on { border-color:var(--accent); box-shadow:0 0 0 1px var(--accent) inset; }
.bd-rank input { margin-right:6px; accent-color:var(--accent); }
.bd-rank .bd-rname { font-weight:700; }
.bd-rank .bd-rline { display:flex; justify-content:space-between; font-size:0.82em; color:var(--text-2); margin-top:2px; }
.bd-rank .bd-rline strong { color:var(--text); font-variant-numeric:tabular-nums; }
.bd-details { margin-top:10px; font-size:0.85em; }
.bd-details summary { cursor:pointer; color:var(--text-2); }
.bd-grid { width:100%; border-collapse:collapse; font-size:0.85em; margin-top:6px; }
.bd-grid th, .bd-grid td { padding:4px 6px; border-bottom:1px solid var(--border); text-align:left; }
.bd-grid input[type=text] { width:100%; min-width:64px; background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); padding:4px 6px; font:inherit; }
.bd-grid td.num input { text-align:right; }
.bd-row-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.bd-paste { width:100%; min-height:64px; margin-top:6px; background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); padding:6px; font:inherit; font-size:0.85em; }
.bd-me { display:flex; gap:14px; flex-wrap:wrap; align-items:center; font-size:0.9em; }
.bd-me label { display:flex; align-items:center; gap:6px; }
.bd-me input, .bd-me select { background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); padding:5px 8px; font:inherit; }
.bd-verdict { padding:12px 14px; border-left:4px solid var(--accent); background:var(--accent-bg, rgba(192,144,48,0.08)); line-height:1.7; border-radius:0 6px 6px 0; }
.bd-verdict.ok { border-left-color:#58b858; }
.bd-verdict.ng { border-left-color:#d06868; }
.bd-verdict.warn { border-left-color:#e0a030; }
.bd-tag { display:inline-block; font-size:0.72em; padding:0 5px; margin-left:5px; border:1px solid var(--accent); color:var(--accent); border-radius:3px; }
.bd-verdict .bd-big { font-size:1.35em; font-weight:700; color:var(--text); }
.bd-verdict .bd-subline { color:var(--text-2); font-size:0.9em; }
.bd-chart { position:relative; margin-top:14px; }
.bd-chart svg { display:block; width:100%; height:auto; }
.bd-chart .g { stroke:var(--border); stroke-width:1; }
.bd-chart .t { fill:var(--text-3); font-size:11px; font-variant-numeric:tabular-nums; }
.bd-chart .l-cur { fill:none; stroke:var(--accent); stroke-width:2; stroke-linejoin:round; }
.bd-chart .l-prev { fill:none; stroke:var(--text-3); stroke-width:1.5; stroke-linejoin:round; opacity:0.8; }
.bd-chart .l-pred { fill:none; stroke:var(--accent); stroke-width:2; stroke-dasharray:5 4; opacity:0.8; }
.bd-chart .me { fill:var(--text); stroke:var(--bg); stroke-width:2; }
.bd-chart .fin { fill:var(--accent); stroke:var(--bg); stroke-width:2; }
.bd-chart .cross { stroke:var(--text-3); stroke-width:1; }
.bd-chart .lbl { fill:var(--text-2); font-size:11px; }
.bd-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:0.78em; color:var(--text-2); margin-top:4px; }
.bd-legend i { display:inline-block; width:16px; height:0; border-top:2px solid var(--accent); margin-right:5px; vertical-align:3px; }
.bd-legend i.prev { border-top-color:var(--text-3); }
.bd-legend i.pred { border-top-style:dashed; }
.bd-legend i.me { width:9px; height:9px; border:none; border-radius:50%; background:var(--text); vertical-align:0; }
.bd-tip { position:absolute; top:4px; pointer-events:none; background:var(--surface, #18181e); border:1px solid var(--border); border-radius:4px; padding:5px 8px; font-size:0.78em; line-height:1.5; white-space:nowrap; }
.bd-tip strong { font-variant-numeric:tabular-nums; }
.bd-plan { width:100%; border-collapse:collapse; font-size:0.85em; margin-top:12px; }
.bd-plan th, .bd-plan td { padding:5px 6px; border-bottom:1px solid var(--border); text-align:left; }
.bd-plan td.n { text-align:right; font-variant-numeric:tabular-nums; }
.bd-plan td.ok { color:#58b858; font-weight:700; }
.bd-plan td.ng { color:#d06868; }
.bd-plan tr.best td { background:rgba(192,144,48,0.08); }
.bd-empty { color:var(--text-3); font-size:0.9em; padding:10px 0; }
`;
            document.head.appendChild(style);
        }

        /** 討伐時間が入っている難易度の毎時貢献度 */
        /** 討伐時間が入っている難易度の毎時貢献度。リロ有の時間があれば別の行（relo: true）として足す */
        rates() {
            const times = this.getKillTimes() || {};
            const relo = this.getReloadTimes() || {};
            const out = [];
            for (const d of this.getDiffs()) {
                if (times[d.id] > 0) out.push({ id: d.id, name: d.name, relo: false, perRun: d.contrib, sec: times[d.id], perH: (d.contrib / times[d.id]) * 3600 });
                if (relo[d.id] > 0) out.push({ id: d.id, name: d.name, relo: true, perRun: d.contrib, sec: relo[d.id], perH: (d.contrib / relo[d.id]) * 3600 });
            }
            return out.sort((a, b) => b.perH - a.perH);
        }

        remainingHours() {
            return this.state.days * 24 + this.state.hours;
        }

        render() {
            const s = this.state;
            const dayOpts = [0, 1, 2, 3, 4].map((d) => `<option value="${d}" ${s.days === d ? 'selected' : ''}>${d}日</option>`).join('');
            const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.hours === h ? 'selected' : ''}>${h}時間</option>`).join('');
            const cards = s.rows.map((r, i) => {
                const v = r.final ?? r.current;
                return `<label class="bd-rank${s.target === i ? ' on' : ''}">
  <div><input type="radio" name="bd-target" data-i="${i}" ${s.target === i ? 'checked' : ''}><span class="bd-rname">${esc(r.label || `行${i + 1}`)}</span></div>
  <div class="bd-rline"><span>現在</span><strong>${fmtPoint(r.current)}</strong></div>
  <div class="bd-rline"><span>最終予想</span><strong>${fmtPoint(r.final)}</strong></div>
  ${r.lastHour != null ? `<div class="bd-rline"><span>直近1時間</span><strong>+${fmtPoint(r.lastHour)}</strong></div>` : ''}
  ${v == null ? '<div class="bd-rline"><span>値がありません</span></div>' : ''}
</label>`;
            }).join('');
            this.root.innerHTML = `
<div class="card">
  <div class="card-title bd-step"><b>1</b>ボーダーを取得して目標を選ぶ</div>
  <div class="bd-fetch">
    <button type="button" class="bd-btn bd-primary" data-act="fetch">gbfdata から最新を取得</button>
    <a href="${SOURCES[0].url}" target="_blank" rel="noopener noreferrer" style="font-size:0.82em;color:var(--accent)">gbfdata を開く ↗</a>
    <a href="${SOURCES[1].url}" target="_blank" rel="noopener noreferrer" style="font-size:0.82em;color:var(--accent)">ランキング速報を開く ↗</a>
  </div>
  <div class="bd-status" data-fetch-status>${esc(s.fetchNote || 'ボタンを押すと、下の順位のボーダーと最終予想・残り時間が入ります。')}</div>
  <div class="bd-ranks">${cards}</div>
  <details class="bd-details">
    <summary>順位を変える・手で入力する</summary>
    <table class="bd-grid">
      <thead><tr><th>順位</th><th>現在のボーダー</th><th>最終予想</th><th></th></tr></thead>
      <tbody>${s.rows.map((r, i) => `
        <tr>
          <td><input type="text" data-f="label" data-i="${i}" value="${esc(r.label)}" placeholder="例: 2000位"></td>
          <td class="num"><input type="text" inputmode="decimal" data-f="current" data-i="${i}" value="${r.current == null ? '' : fmtPoint(r.current)}" placeholder="例: 12.5億"></td>
          <td class="num"><input type="text" inputmode="decimal" data-f="final" data-i="${i}" value="${r.final == null ? '' : fmtPoint(r.final)}" placeholder="任意"></td>
          <td><button type="button" class="bd-btn" data-del="${i}" aria-label="この行を削除">✕</button></td>
        </tr>`).join('')}
      </tbody>
    </table>
    <div class="bd-row-actions">
      <button type="button" class="bd-btn" data-act="add">＋ 順位を追加</button>
    </div>
    <textarea class="bd-paste" placeholder="集計サイトの表をコピーして貼り付け（例: 2000位 1,250,000,000）"></textarea>
    <button type="button" class="bd-btn" data-act="paste">貼り付けたテキストを読み込む</button>
  </details>
</div>
<div class="card">
  <div class="card-title bd-step"><b>2</b>自分の状況</div>
  <div class="bd-me">
    <label>自分の貢献度 <input type="text" inputmode="decimal" data-me value="${s.mine == null ? '' : fmtPoint(s.mine)}" placeholder="例: 300億" style="width:120px"></label>
    <label>残り時間 <select data-days>${dayOpts}</select><select data-hours>${hourOpts}</select></label>
  </div>
</div>
<div class="card">
  <div class="card-title bd-step"><b>3</b>届くかどうか</div>
  <div data-out></div>
</div>`;
            this.bind();
            this.update();
        }

        bind() {
            const root = this.root;
            root.querySelectorAll('input[data-f]').forEach((el) => {
                el.addEventListener('change', () => {
                    const row = this.state.rows[+el.dataset.i];
                    if (!row) return;
                    if (el.dataset.f === 'label') row.label = el.value.slice(0, 20);
                    else row[el.dataset.f] = parsePoint(el.value);
                    this.save();
                    this.render();
                });
            });
            root.querySelectorAll('input[name=bd-target]').forEach((el) =>
                el.addEventListener('change', () => { this.state.target = +el.dataset.i; this.save(); this.render(); }));
            root.querySelectorAll('[data-del]').forEach((el) =>
                el.addEventListener('click', () => {
                    this.state.rows.splice(+el.dataset.del, 1);
                    if (this.state.rows.length === 0) this.state.rows.push({ label: '', current: null, final: null });
                    if (this.state.target >= this.state.rows.length) this.state.target = 0;
                    this.save();
                    this.render();
                }));
            root.querySelector('[data-act=add]').addEventListener('click', () => {
                if (this.state.rows.length >= 8) return;
                this.state.rows.push({ label: '', current: null, final: null });
                this.save();
                this.render();
                const d = this.root.querySelector('.bd-details');
                if (d) d.open = true;
            });
            root.querySelector('[data-act=paste]').addEventListener('click', () => {
                const rows = parseBorderText(root.querySelector('.bd-paste').value);
                if (rows.length === 0) { alert('「○○位 数値」の形の行が見つかりませんでした'); return; }
                this.state.rows = rows.slice(0, 8);
                this.state.target = 0;
                this.save();
                this.render();
            });
            root.querySelector('[data-act=fetch]').addEventListener('click', (e) => this.fetchLatest(e.currentTarget));
            root.querySelector('[data-me]').addEventListener('input', (e) => { this.state.mine = parsePoint(e.target.value); this.save(); this.update(); });
            root.querySelector('[data-days]').addEventListener('change', (e) => { this.state.days = +e.target.value; this.save(); this.update(); });
            root.querySelector('[data-hours]').addEventListener('change', (e) => { this.state.hours = +e.target.value; this.save(); this.update(); });
        }

        /** gbfdata から、入力されている順位のボーダーと前回の推移を取得する */
        async fetchLatest(button) {
            const status = this.root.querySelector('[data-fetch-status]');
            const ranks = [...new Set(this.state.rows.map((r) => rankOf(r.label)).filter((r) => r && r > 0))].slice(0, 8);
            if (ranks.length === 0) { status.textContent = '「順位を変える・手で入力する」で、順位を「2000位」「10万位」のように入れてください'; return; }
            button.disabled = true;
            status.textContent = '取得しています…';
            try {
                const first = await this.request(ranks, null);
                const prevRaid = first.meta && first.meta.raid_number ? first.meta.raid_number - 1 : null;
                const json = prevRaid ? await this.request(ranks, prevRaid) : first;
                const parsed = parseGbfdata(json);
                for (const r of parsed.rows) {
                    const row = this.state.rows.find((x) => rankOf(x.label) === r.rank);
                    if (!row) continue;
                    Object.assign(row, { current: r.current, final: r.final, lastHour: r.lastHour, cur: r.cur, prev: r.prev, at: r.at });
                }
                const hours = remainingActiveHours(parsed.lastDay);
                if (hours != null) {
                    const h = Math.floor(hours);
                    this.state.days = Math.min(4, Math.floor(h / 24));
                    this.state.hours = Math.min(23, h - this.state.days * 24);
                }
                const at = parsed.rows[0] ? parsed.rows[0].at : '';
                const prevRow = parsed.rows.find((r) => r.prevRaid);
                this.state.fetchNote = `第${parsed.raid}回 ${at} 時点（gbfdata）。最終予想は${prevRow ? `前回（第${prevRow.prevRaid}回）の同じ時刻からの伸び率` : '前回のデータが無いため未計算'}。残り時間は 0〜7時を除いて自動で入れました`;
                this.save();
                this.render();
            } catch (err) {
                status.textContent = `取得できませんでした（${err && err.message ? err.message : err}）。「順位を変える・手で入力する」から値を入れてください`;
                button.disabled = false;
            }
        }

        async request(ranks, prevRaid) {
            const q = new URLSearchParams();
            for (const r of ranks) q.append('ranks[]', String(r));
            if (prevRaid) for (const r of ranks) q.append('additional_targets[]', `rank:${prevRaid}:${r}`);
            const res = await fetch(`${GBFDATA_API}?${q}`, { headers: { Accept: 'application/json' } });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        }

        /** 討伐時間の変更などを反映する */
        refresh() {
            this.update();
        }

        update() {
            const out = this.root.querySelector('[data-out]');
            if (!out) return;
            const s = this.state;
            const row = s.rows[s.target];
            const value = row ? row.final ?? row.current : null;
            if (!row || value == null) {
                out.innerHTML = '<div class="bd-empty">1 でボーダーを取得（または入力）して、目標の順位を選んでください</div>';
                return;
            }
            const label = row.label || `行${s.target + 1}`;
            const basis = row.final != null ? '最終予想' : '現在のボーダー';
            const mine = s.mine;
            const remH = this.remainingHours();
            const rates = this.rates();
            const best = rates[0];

            let verdict;
            if (mine == null) {
                verdict = `<div class="bd-verdict"><div class="bd-big">${esc(label)}の${basis}は ${fmtPoint(value)}</div><div class="bd-subline">2 に自分の貢献度を入れると、あといくつ必要かを出します</div></div>`;
            } else {
                const need = value - mine;
                if (need <= 0) {
                    verdict = `<div class="bd-verdict ok"><div class="bd-big">✓ ${esc(label)}（${basis} ${fmtPoint(value)}）を超えています</div><div class="bd-subline">+${fmtPoint(-need)} の余裕</div></div>`;
                } else if (remH <= 0) {
                    verdict = `<div class="bd-verdict"><div class="bd-big">あと ${fmtPoint(need)}</div><div class="bd-subline">${esc(label)}（${basis} ${fmtPoint(value)}）まで。残り時間を入れると必要なペースを出します</div></div>`;
                } else {
                    const perH = need / remH;
                    const noRelo = rates.find((r) => !r.relo);
                    const withRelo = rates.find((r) => r.relo);
                    const name = (r) => `${esc(r.name)}${r.relo ? '（リロ有）' : ''}`;
                    const reach = (r) => `${name(r)}（毎時 ${fmtPoint(r.perH)}）なら <strong>${fmtHours(need / r.perH)}</strong> で届く`;
                    const short = (r) => `${name(r)}（毎時 ${fmtPoint(r.perH)}）だと ${fmtPoint(need - r.perH * remH)} 足りない`;
                    let cls = '';
                    let mark = '';
                    let lines = [];
                    if (!noRelo && !withRelo) {
                        lines = ['「討伐効率」タブで討伐時間を入れると、どの難易度なら間に合うかを出します'];
                    } else if (noRelo && noRelo.perH >= perH) {
                        cls = 'ok'; mark = '✓ ';
                        lines = [`リロ無しでも ${reach(noRelo)}`];
                        if (withRelo && withRelo.perH > noRelo.perH) lines.push(`リロ有なら ${reach(withRelo)}`);
                    } else if (withRelo && withRelo.perH >= perH) {
                        cls = 'warn'; mark = '△ ';
                        lines = [`<strong>リロ有なら届く</strong>: ${reach(withRelo)}`, noRelo ? `リロ無し: ${short(noRelo)}` : ''];
                    } else {
                        cls = 'ng'; mark = '✗ ';
                        lines = [noRelo ? `リロ無し: ${short(noRelo)}` : '', withRelo ? `リロ有: ${short(withRelo)}` : ''];
                    }
                    verdict = `<div class="bd-verdict ${cls}">
<div class="bd-big">${mark}あと ${fmtPoint(need)}（毎時 ${fmtPoint(perH)}）</div>
<div class="bd-subline">${esc(label)}の${basis} ${fmtPoint(value)} まで、残り${fmtHours(remH)}。</div>
${lines.filter(Boolean).map((l) => `<div class="bd-subline">${l}</div>`).join('')}</div>`;
                }
            }

            const chart = this.chartHtml(row, label);

            let plan = '';
            if (mine != null && value > mine && rates.length > 0) {
                const need = value - mine;
                plan = `<table class="bd-plan"><thead><tr><th>難易度</th><th>毎時</th><th>必要回数</th><th>必要時間</th>${remH > 0 ? '<th>残り時間内</th>' : ''}</tr></thead><tbody>${rates
                    .map((r, k) => {
                        const hours = need / r.perH;
                        const fits = remH > 0 ? hours <= remH : null;
                        return `<tr class="${k === 0 ? 'best' : ''}"><td>${esc(r.name)}${r.relo ? '<span class="bd-tag">リロ有</span>' : ''}</td><td class="n">${fmtPoint(r.perH)}</td><td class="n">${Math.ceil(need / r.perRun).toLocaleString()}回</td><td class="n">${fmtHours(hours)}</td>${fits === null ? '' : `<td class="${fits ? 'ok' : 'ng'}">${fits ? '✓ 間に合う' : '✗ 足りない'}</td>`}</tr>`;
                    })
                    .join('')}</tbody></table>`;
            }
            out.innerHTML = verdict + chart + plan;
            this.bindChart(out, row);
        }

        /** 今回と前回のボーダー推移の折れ線（横軸は開催日数、縦軸は貢献度） */
        chartHtml(row, label) {
            const cur = row.cur || [];
            const prev = row.prev || [];
            if (cur.length < 2 && prev.length < 2) {
                return '<div class="bd-empty">「gbfdata から最新を取得」を押すと、ボーダーの推移グラフが出ます</div>';
            }
            // 表示幅に合わせて描く（スマホで縮小されて文字が小さくならないように）
            const W = Math.max(320, Math.min(640, Math.round((this.root.clientWidth || 640) - 32)));
            const H = W < 480 ? 220 : 240, L = W < 480 ? 46 : 56, R = W < 480 ? 84 : 104, T = 12, B = 28;
            const last = cur[cur.length - 1];
            const endX = Math.max(prev.length ? prev[prev.length - 1].x : 0, last ? last.x : 0);
            const mine = this.state.mine;
            const yMaxRaw = Math.max(...cur.map((q) => q.p), ...prev.map((q) => q.p), row.final || 0, mine || 0);
            const yStep = niceStep(yMaxRaw / 4);
            const yMax = Math.ceil((yMaxRaw * 1.05) / yStep) * yStep;
            const sx = (x) => L + (x / endX) * (W - L - R);
            const sy = (y) => T + (1 - y / yMax) * (H - T - B);
            const path = (pts) => pts.map((q, i) => `${i ? 'L' : 'M'}${sx(q.x).toFixed(1)},${sy(q.p).toFixed(1)}`).join('');
            let g = '';
            for (let v = 0; v <= yMax + 1; v += yStep) g += `<line class="g" x1="${L}" x2="${W - R}" y1="${sy(v)}" y2="${sy(v)}"/><text class="t" x="${L - 6}" y="${sy(v) + 4}" text-anchor="end">${fmtPoint(v)}</text>`;
            for (let d = 0; d * 24 < endX; d++) g += `<text class="t" x="${sx(d * 24 + 12)}" y="${H - 8}" text-anchor="middle">${d + 1}${W < 480 ? '日' : '日目'}</text>`;
            let marks = '';
            if (row.final != null && last) {
                marks += `<path class="l-pred" d="M${sx(last.x)},${sy(last.p)}L${sx(endX)},${sy(row.final)}"/><circle class="fin" cx="${sx(endX)}" cy="${sy(row.final)}" r="4.5"/><text class="lbl" x="${sx(endX) + 7}" y="${sy(row.final) + 4}">予想 ${fmtPoint(row.final)}</text>`;
            }
            if (prev.length > 1) {
                const pe = prev[prev.length - 1];
                marks += `<text class="lbl" x="${sx(pe.x) + 7}" y="${sy(pe.p) + 14}" style="fill:var(--text-3)">前回 ${fmtPoint(pe.p)}</text>`;
            }
            if (mine != null && last) marks += `<circle class="me" cx="${sx(last.x)}" cy="${sy(mine)}" r="5"/><text class="lbl" x="${sx(last.x) - 8}" y="${sy(mine) + 4}" text-anchor="end">自分 ${fmtPoint(mine)}</text>`;
            this.chartGeom = { W, H, L, R, T, B, endX, sx, sy };
            return `<div class="bd-chart">
<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}のボーダー推移。今回と前回">
${g}
${prev.length > 1 ? `<path class="l-prev" d="${path(prev)}"/>` : ''}
${cur.length > 1 ? `<path class="l-cur" d="${path(cur)}"/>` : ''}
${marks}
<line class="cross" data-cross x1="0" x2="0" y1="${T}" y2="${H - B}" visibility="hidden"/>
<rect data-hit x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>
</svg>
<div class="bd-tip" data-tip hidden></div>
</div>
<div class="bd-legend"><span><i></i>今回（${esc(label)}）</span>${prev.length > 1 ? '<span><i class="prev"></i>前回</span>' : ''}${row.final != null ? '<span><i class="pred"></i>最終予想まで</span>' : ''}${mine != null ? '<span><i class="me"></i>自分</span>' : ''}</div>`;
        }

        bindChart(out, row) {
            const hit = out.querySelector('[data-hit]');
            const tip = out.querySelector('[data-tip]');
            const cross = out.querySelector('[data-cross]');
            const g = this.chartGeom;
            if (!hit || !g) return;
            const at = (pts, x) => {
                let best = null;
                for (const q of pts || []) if (q.x <= x && (!best || q.x > best.x)) best = q;
                return best;
            };
            hit.addEventListener('pointermove', (e) => {
                const box = hit.getBoundingClientRect();
                const x = ((e.clientX - box.left) / box.width) * g.endX;
                const c = at(row.cur, x);
                const p = at(row.prev, x);
                const ref = c || p;
                if (!ref) return;
                const hx = g.sx(ref.x);
                cross.setAttribute('x1', hx);
                cross.setAttribute('x2', hx);
                cross.setAttribute('visibility', 'visible');
                // 24時は翌日の0時ではなくその日の24時として表示する
                const day = Math.ceil(ref.x / 24) || 1;
                const hh = ref.x - (day - 1) * 24;
                tip.innerHTML = `${day}日目 ${hh}:00<br>${c ? `今回 <strong>${fmtPoint(c.p)}</strong><br>` : ''}${p ? `前回 <strong>${fmtPoint(p.p)}</strong>` : ''}`;
                tip.hidden = false;
                const pct = (hx / g.W) * 100;
                tip.style.left = pct > 60 ? '' : `calc(${pct}% + 10px)`;
                tip.style.right = pct > 60 ? `calc(${100 - pct}% + 10px)` : '';
            });
            hit.addEventListener('pointerleave', () => {
                tip.hidden = true;
                cross.setAttribute('visibility', 'hidden');
            });
        }
    }

    BorderPanel.parseBorderText = parseBorderText;
    BorderPanel.parsePoint = parsePoint;
    BorderPanel.parseGbfdata = parseGbfdata;
    BorderPanel.remainingActiveHours = remainingActiveHours;
    BorderPanel.rankOf = rankOf;
    global.BorderPanel = BorderPanel;
})(window);
