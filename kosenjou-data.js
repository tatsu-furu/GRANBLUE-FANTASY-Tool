/**
 * 古戦場ツール：データ（ゲームの数字と、手入力の読み取り）
 *
 * kosenjou.html・kosenjou-beta.html・計算（kosenjou-schedule.js）・かんたん計画の計算（kosenjou-plan-core.js）・Web Worker・テストが、同じ値を使う。
 * ふつうの <script src> で読み込む（定数と関数は、そのままグローバルになる）。ほかのファイルには依存しない。
 */

// 難易度ごとの獲得貢献度（contrib）と、1回で使う肉の数（chunks。250HELL は、肉ではなく 250専用素材の数）
const DIFFS = [
    { id:'vh',   name:'VH',      contrib:21400,    isMeat:false, is250:false, chunks:0  },
    { id:'ex',   name:'EX',      contrib:64000,    isMeat:false, is250:false, chunks:0  },
    { id:'exp',  name:'EX+',     contrib:126000,   isMeat:false, is250:false, chunks:0  },
    { id:'h90',  name:'90HELL',  contrib:305000,   isMeat:true,  is250:false, chunks:5  },
    { id:'h95',  name:'95HELL',  contrib:910000,   isMeat:true,  is250:false, chunks:10 },
    { id:'h100', name:'100HELL', contrib:2680000,  isMeat:true,  is250:false, chunks:20 },
    { id:'h150', name:'150HELL', contrib:4100000,  isMeat:true,  is250:false, chunks:20 },
    { id:'h200', name:'200HELL', contrib:20000000, isMeat:true,  is250:false, chunks:20 },
    { id:'h250', name:'250HELL', contrib:75000000, isMeat:false, is250:true,  chunks:20 },
];

const HELL_DIFFS = DIFFS.filter(d => d.isMeat || d.is250);
const tierOf     = d => parseInt(d.name, 10);                          // '150HELL' → 150

// 手入力の貢献度：「50億」「1億5000万」「3500万」「5,000,000,000」を数に直す（読めなければ null）
function parseGoal(text) {
    const s = String(text == null ? '' : text).normalize('NFKC').replace(/[,\s]/g, '');
    if (!s) return null;
    const m = s.match(/^(?:(\d+(?:\.\d+)?)億)?(?:(\d+(?:\.\d+)?)万)?(\d+(?:\.\d+)?)?(?:pt|ポイント)?$/i);
    if (!m || (m[1] == null && m[2] == null && m[3] == null)) return null;
    const n = (m[1] ? parseFloat(m[1]) * 1e8 : 0) + (m[2] ? parseFloat(m[2]) * 1e4 : 0) + (m[3] ? parseFloat(m[3]) : 0);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}

// 貢献度を、入力欄に入れる形に直す（万で割り切れるときは「98億7650万」、そうでなければ桁区切りの数）
function fmtGoal(n) {
    if (n >= 1e4 && n % 1e4 === 0) {
        const oku = Math.floor(n / 1e8), man = (n % 1e8) / 1e4;
        return (oku ? `${oku}億` : '') + (man ? `${man}万` : '');
    }
    return n.toLocaleString();
}
