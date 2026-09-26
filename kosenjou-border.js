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
            return {
                rank: sr.target_rank,
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

    class BorderPanel {
        constructor(root, opts) {
            this.root = root;
            this.getDiffs = opts.getDiffs;
            this.getKillTimes = opts.getKillTimes;
            this.state = this.load();
            this.injectStyle();
            this.render();
        }

        load() {
            const fallback = { rows: DEFAULT_ROWS.map((r) => ({ ...r })), mine: null, days: 0, hours: 0, target: 0, fetchNote: '' };
            try {
                const s = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
                if (!s || !Array.isArray(s.rows)) return fallback;
                return {
                    rows: s.rows.slice(0, 8).map((r) => ({
                        label: typeof r.label === 'string' ? r.label.slice(0, 20) : '',
                        current: Number.isFinite(r.current) ? r.current : null,
                        final: Number.isFinite(r.final) ? r.final : null,
                        lastHour: Number.isFinite(r.lastHour) ? r.lastHour : null,
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
.bd-links { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:10px; }
.bd-links a { color:var(--accent); font-size:0.85em; }
.bd-grid { width:100%; border-collapse:collapse; font-size:0.85em; }
.bd-grid th, .bd-grid td { padding:4px 6px; border-bottom:1px solid var(--border); text-align:left; }
.bd-grid input[type=text] { width:100%; min-width:70px; background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); padding:4px 6px; font:inherit; }
.bd-grid td.num input { text-align:right; }
.bd-sub { font-size:0.72em; color:var(--text-3); text-align:right; margin-top:2px; }
.bd-row-actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:8px; }
.bd-btn { background:transparent; border:1px solid var(--border); color:var(--text-2); border-radius:4px; padding:3px 10px; cursor:pointer; font:inherit; font-size:0.85em; }
.bd-btn:hover { border-color:var(--accent); color:var(--accent); }
.bd-btn.bd-primary { border-color:var(--accent); color:var(--accent); font-weight:700; }
.bd-btn:disabled { opacity:0.5; cursor:wait; }
.bd-paste { width:100%; min-height:70px; margin-top:6px; background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); padding:6px; font:inherit; font-size:0.85em; }
.bd-me { display:flex; gap:10px; flex-wrap:wrap; align-items:center; margin:8px 0; font-size:0.9em; }
.bd-me input, .bd-me select { background:var(--bg); border:1px solid var(--border); border-radius:4px; color:var(--text); padding:4px 6px; font:inherit; }
.bd-meter { position:relative; height:34px; margin:28px 0 34px; background:var(--bg-2, var(--surface-2)); border:1px solid var(--border); border-radius:4px; }
.bd-fill { position:absolute; left:0; top:0; bottom:0; background:var(--accent); border-radius:3px 0 0 3px; }
.bd-proj { position:absolute; top:0; bottom:0; background:var(--accent); opacity:0.3; }
.bd-mark { position:absolute; top:-6px; bottom:-6px; width:2px; background:var(--text); }
.bd-mark span { position:absolute; top:-20px; transform:translateX(-50%); white-space:nowrap; font-size:0.72em; color:var(--text-2); }
.bd-mark.bd-target { background:#e0c060; }
.bd-mark.bd-target span { color:var(--text); font-weight:700; }
.bd-scale { position:absolute; bottom:-22px; font-size:0.72em; color:var(--text-3); }
.bd-legend { display:flex; gap:14px; flex-wrap:wrap; font-size:0.78em; color:var(--text-2); }
.bd-legend i { display:inline-block; width:14px; height:10px; margin-right:4px; vertical-align:-1px; background:var(--accent); }
.bd-legend i.proj { opacity:0.3; }
.bd-verdict { padding:10px 12px; border-left:3px solid var(--accent); background:var(--accent-bg, rgba(192,144,48,0.08)); margin:10px 0; line-height:1.7; }
.bd-verdict.ng { border-left-color:#d06868; }
.bd-verdict.ok { border-left-color:#58b858; }
.bd-verdict strong { color:var(--text); }
.bd-plan td.ok { color:#58b858; font-weight:700; }
.bd-plan td.ng { color:#d06868; }
.bd-plan tr.best td { background:rgba(192,144,48,0.08); }
`;
            document.head.appendChild(style);
        }

        /** 討伐時間が入っている難易度の毎時貢献度 */
        rates() {
            const times = this.getKillTimes() || {};
            return this.getDiffs()
                .filter((d) => times[d.id] > 0)
                .map((d) => ({ id: d.id, name: d.name, perRun: d.contrib, sec: times[d.id], perH: (d.contrib / times[d.id]) * 3600 }))
                .sort((a, b) => b.perH - a.perH);
        }

        render() {
            const s = this.state;
            const dayOpts = [0, 1, 2, 3, 4].map((d) => `<option value="${d}" ${s.days === d ? 'selected' : ''}>${d}日</option>`).join('');
            const hourOpts = Array.from({ length: 24 }, (_, h) => `<option value="${h}" ${s.hours === h ? 'selected' : ''}>${h}時間</option>`).join('');
            this.root.innerHTML = `
<div class="card">
  <div class="card-title">ボーダー（gbfdata から取得、または入力）</div>
  <div class="bd-links">${SOURCES.map((x) => `<a href="${x.url}" target="_blank" rel="noopener noreferrer">${esc(x.name)} ↗</a>`).join('')}</div>
  <p class="note" style="margin-bottom:8px;">「最新を取得」で gbfdata の値を読み込みます（手で入力・修正も可。億・万も使えます）。目標にする行を左の丸で選びます。</p>
  <table class="bd-grid">
    <thead><tr><th>目標</th><th>順位</th><th>現在のボーダー</th><th>最終予想</th><th></th></tr></thead>
    <tbody>${s.rows.map((r, i) => `
      <tr>
        <td><input type="radio" name="bd-target" data-i="${i}" ${s.target === i ? 'checked' : ''} aria-label="この行を目標にする"></td>
        <td><input type="text" data-f="label" data-i="${i}" value="${esc(r.label)}" placeholder="例: 2000位"></td>
        <td class="num"><input type="text" inputmode="decimal" data-f="current" data-i="${i}" value="${r.current == null ? '' : fmtPoint(r.current)}" placeholder="例: 12.5億"></td>
        <td class="num"><input type="text" inputmode="decimal" data-f="final" data-i="${i}" value="${r.final == null ? '' : fmtPoint(r.final)}" placeholder="任意">${r.lastHour != null ? `<div class="bd-sub">直近1時間 +${fmtPoint(r.lastHour)}</div>` : ''}</td>
        <td><button type="button" class="bd-btn" data-del="${i}" aria-label="この行を削除">✕</button></td>
      </tr>`).join('')}
    </tbody>
  </table>
  <div class="bd-row-actions">
    <button type="button" class="bd-btn bd-primary" data-act="fetch">gbfdata から最新を取得</button>
    <button type="button" class="bd-btn" data-act="add">＋ 行を追加</button>
    <button type="button" class="bd-btn" data-act="toggle-paste">テキストを貼って読み込む</button>
  </div>
  <p class="note" data-fetch-status style="margin-top:6px;">${esc(s.fetchNote || '順位の欄（例: 2000位、10万位）を入れてから取得すると、その順位のボーダーを読み込みます。')}</p>
  <div data-paste hidden>
    <textarea class="bd-paste" placeholder="集計サイトの表をコピーして貼り付け（例: 2000位 1,250,000,000）"></textarea>
    <button type="button" class="bd-btn" data-act="paste">読み込む</button>
  </div>
</div>
<div class="card">
  <div class="card-title">届くかどうか</div>
  <div class="bd-me">
    <label>自分の貢献度 <input type="text" inputmode="decimal" data-me value="${s.mine == null ? '' : fmtPoint(s.mine)}" placeholder="例: 8.3億" style="width:110px"></label>
    <label>残り時間 <select data-days>${dayOpts}</select> <select data-hours>${hourOpts}</select></label>
  </div>
  <div data-out></div>
</div>`;
            this.bind();
            this.update();
        }

        bind() {
            const root = this.root;
            root.querySelectorAll('input[data-f]').forEach((el) => {
                el.addEventListener('input', () => {
                    const row = this.state.rows[+el.dataset.i];
                    if (!row) return;
                    if (el.dataset.f === 'label') row.label = el.value.slice(0, 20);
                    else row[el.dataset.f] = parsePoint(el.value);
                    this.save();
                    this.update();
                });
            });
            root.querySelectorAll('input[name=bd-target]').forEach((el) =>
                el.addEventListener('change', () => { this.state.target = +el.dataset.i; this.save(); this.update(); }));
            root.querySelectorAll('[data-del]').forEach((el) =>
                el.addEventListener('click', () => {
                    const i = +el.dataset.del;
                    this.state.rows.splice(i, 1);
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
            });
            root.querySelector('[data-act=toggle-paste]').addEventListener('click', () => {
                const box = root.querySelector('[data-paste]');
                box.hidden = !box.hidden;
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
            if (ranks.length === 0) { status.textContent = '順位の欄に「2000位」「10万位」のように入れてください'; return; }
            button.disabled = true;
            status.textContent = '取得しています…';
            try {
                const first = await this.request(ranks, null);
                const prevRaid = first.meta && first.meta.raid_number ? first.meta.raid_number - 1 : null;
                const json = prevRaid ? await this.request(ranks, prevRaid) : first;
                const parsed = parseGbfdata(json);
                for (const r of parsed.rows) {
                    let row = this.state.rows.find((x) => rankOf(x.label) === r.rank);
                    if (!row) continue;
                    row.current = r.current;
                    row.final = r.final;
                    row.lastHour = r.lastHour;
                }
                const hours = remainingActiveHours(parsed.lastDay);
                if (hours != null) {
                    const h = Math.floor(hours);
                    this.state.days = Math.min(4, Math.floor(h / 24));
                    this.state.hours = Math.min(23, h - this.state.days * 24);
                }
                const at = parsed.rows[0] ? parsed.rows[0].at : '';
                const prevNo = parsed.rows.find((r) => r.prevRaid) ? parsed.rows.find((r) => r.prevRaid).prevRaid : null;
                this.state.fetchNote = `第${parsed.raid}回 ${at} 時点（gbfdata）。最終予想は${prevNo ? `前回（第${prevNo}回）の同じ時刻からの伸び率で計算` : '前回のデータが無いため空欄'}。残り時間は集計の止まる 0〜7時を除いて自動設定`;
                this.save();
                this.render();
            } catch (err) {
                status.textContent = `取得できませんでした（${err && err.message ? err.message : err}）。サイトを開いて値を入力してください`;
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
            const borders = s.rows
                .map((r, i) => ({ i, label: r.label || `行${i + 1}`, value: r.final ?? r.current, isFinal: r.final != null }))
                .filter((b) => b.value != null && b.value > 0);
            const target = borders.find((b) => b.i === s.target) ?? null;
            const mine = s.mine ?? 0;
            const remH = s.days * 24 + s.hours;
            const rates = this.rates();
            const best = rates[0];

            if (borders.length === 0) {
                out.innerHTML = '<div class="no-data">ボーダーの値を入れると、ここに届くかどうかを表示します</div>';
                return;
            }

            // メーター: 自分の貢献度と各ボーダーの位置。目標までの残りを薄い帯で示す
            const max = Math.max(...borders.map((b) => b.value), mine) * 1.08;
            const pos = (v) => `${Math.min(100, (v / max) * 100).toFixed(2)}%`;
            const gapTo = target && target.value > mine ? target.value : mine;
            // ラベルは値の順に上下交互に置き、両端では内側に寄せる（近い値でも重ならないように）
            const marks = [...borders]
                .sort((a, b) => a.value - b.value)
                .map((b, k) => {
                    const frac = b.value / max;
                    const align = frac > 0.8 ? 'translateX(-100%)' : frac < 0.2 ? 'translateX(0)' : 'translateX(-50%)';
                    const place = k % 2 === 0 ? 'top:-20px' : 'top:calc(100% + 6px)';
                    return `<div class="bd-mark${target && b.i === target.i ? ' bd-target' : ''}" style="left:${pos(b.value)}"><span style="${place};transform:${align}">${esc(b.label)} ${fmtPoint(b.value)}</span></div>`;
                })
                .join('');
            const meter = `
<div class="bd-meter" role="img" aria-label="自分の貢献度 ${fmtPoint(mine)}${target ? `、目標 ${fmtPoint(target.value)}` : ''}">
  <div class="bd-proj" style="left:${pos(mine)};width:calc(${pos(gapTo)} - ${pos(mine)})"></div>
  <div class="bd-fill" style="width:${pos(mine)}"></div>
  ${marks}
</div>
<div class="bd-legend"><span><i></i>現在 ${fmtPoint(mine)}</span>${target && target.value > mine ? `<span><i class="proj"></i>目標までの残り ${fmtPoint(target.value - mine)}</span>` : ''}</div>`;

            // 判定
            let verdict = '';
            if (!target) {
                verdict = '<div class="bd-verdict">目標にする行（左の丸）を選んでください</div>';
            } else {
                const need = target.value - mine;
                const basis = target.isFinal ? '最終予想' : '現在のボーダー（今後さらに上がります）';
                if (need <= 0) {
                    verdict = `<div class="bd-verdict ok">✓ <strong>${esc(target.label)}</strong> の${basis}（${fmtPoint(target.value)}）はすでに超えています（+${fmtPoint(-need)}）</div>`;
                } else if (remH <= 0) {
                    verdict = `<div class="bd-verdict">あと <strong>${fmtPoint(need)}</strong> 必要です（${esc(target.label)}・${basis}）。残り時間を入れると必要なペースを出します</div>`;
                } else {
                    const perH = need / remH;
                    const ok = best && best.perH >= perH;
                    verdict = `<div class="bd-verdict ${ok ? 'ok' : 'ng'}">${ok ? '✓' : '✗'} ${esc(target.label)}（${basis} ${fmtPoint(target.value)}）まで あと <strong>${fmtPoint(need)}</strong>。
残り${fmtHours(remH)}なら <strong>毎時 ${fmtPoint(perH)}</strong> 必要です。
${best ? (ok ? `最速の ${esc(best.name)}（毎時 ${fmtPoint(best.perH)}）なら <strong>${fmtHours(need / best.perH)}</strong> で届きます。` : `最速の ${esc(best.name)} でも毎時 ${fmtPoint(best.perH)} で、${fmtPoint(need - best.perH * remH)} 足りません。`) : '「討伐効率」タブで討伐時間を入れると、どの難易度なら間に合うかを出します。'}</div>`;
                }
            }

            // 難易度ごとの必要回数・時間
            let plan = '';
            if (target && target.value > mine && rates.length > 0) {
                const need = target.value - mine;
                plan = `<div style="overflow-x:auto"><table class="bd-grid bd-plan"><thead><tr><th>難易度</th><th>毎時</th><th>必要回数</th><th>必要時間</th>${remH > 0 ? '<th>残り時間内</th>' : ''}</tr></thead><tbody>${rates
                    .map((r, k) => {
                        const runs = Math.ceil(need / r.perRun);
                        const hours = need / r.perH;
                        const fits = remH > 0 ? hours <= remH : null;
                        return `<tr class="${k === 0 ? 'best' : ''}"><td>${esc(r.name)}</td><td>${fmtPoint(r.perH)}</td><td>${runs.toLocaleString()}回</td><td>${fmtHours(hours)}</td>${fits === null ? '' : `<td class="${fits ? 'ok' : 'ng'}">${fits ? '✓ 間に合う' : '✗ 足りない'}</td>`}</tr>`;
                    })
                    .join('')}</tbody></table></div>`;
            }
            out.innerHTML = meter + verdict + plan;
        }
    }

    BorderPanel.parseBorderText = parseBorderText;
    BorderPanel.parsePoint = parsePoint;
    BorderPanel.parseGbfdata = parseGbfdata;
    BorderPanel.remainingActiveHours = remainingActiveHours;
    BorderPanel.rankOf = rankOf;
    global.BorderPanel = BorderPanel;
})(window);
