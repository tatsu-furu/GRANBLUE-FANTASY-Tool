"""
極星器の本数の制約つきの計算を、厳密解法（HiGHS：scipy の milp、gap 0）と比べる。
  Σ_{日, 難易度} q[難易度] × 回数 ≥ n（平均の制約）。難易度を指定したときは、ほかの難易度の回数に上限（caps）がある。
instances-stars.json は、dump-stars.mjs が、計算の関数から取り出した問題。
  ・必要な肉：JS の値が、厳密解（目標に届く中で、肉が最小）と完全に一致する（JS が少ないのは異常）
  ・毎日の時間：その時間で、厳密に届き、0.05時間短いと、厳密には届かない（＝厳密な最小）。届かない問題は、17時間でも厳密に届かない
使い方： python3 exact-star-check.py instances-stars.json [--lenient]
  --lenient … 必要な肉が、厳密解より多いだけの問題（JS が少ない異常ではない）は、許す（毎日の時間の最小性・届かない問題の確認は、厳密に求める）
終了コード： 食い違いがあれば 1
"""
import json, sys
import numpy as np
from scipy.optimize import milp, LinearConstraint, Bounds
OPT = {'mip_rel_gap': 0.0, 'presolve': True}

def build(phases, diffs):
    vs = []
    for ph in phases:
        if ph['hours'] <= 0: continue
        for d in diffs:
            if d.get('time') and d['time'] > 0 and d['tier'] <= ph['maxTier'] and (not d.get('only') or ph['id'] in d['only']):
                vs.append((ph, d))
    return vs

def rows(phases, vs, star, caps):
    A, lo, hi = [], [], []
    for ph in phases:
        if ph['hours'] <= 0: continue
        A.append([v[1]['time'] if v[0]['id'] == ph['id'] else 0 for v in vs]); lo.append(-np.inf); hi.append(ph['hours'] * 3600 + 1e-6)
    if star and star['n'] > 0:
        A.append([star['q'].get(v[1]['id'], 0) for v in vs]); lo.append(star['n'] - 1e-9); hi.append(np.inf)
    ub = [np.inf] * len(vs)
    if caps:
        for k, v in enumerate(vs):
            key = f"{v[0]['id']}|{v[1]['id']}"
            if key in caps: ub[k] = caps[key]
    return A, lo, hi, ub

def exact_min_meat(phases, diffs, need, star, caps):
    vs = build(phases, diffs); n = len(vs)
    if n == 0: return None
    A, lo, hi, ub = rows(phases, vs, star, caps)
    A.append([v[1]['contrib'] for v in vs]); lo.append(need); hi.append(np.inf)
    c = np.array([0 if v[1]['is250'] else v[1]['chunks'] for v in vs], dtype=float)
    r = milp(c, constraints=LinearConstraint(np.array(A, dtype=float), np.array(lo), np.array(hi)), integrality=np.ones(n), bounds=Bounds(0, ub), options=OPT)
    return r.fun if r.success else None

def exact_max(phases, diffs, star, caps):
    """肉・素材が十分あるときの、取れる貢献度の最大（極星器の制約つき）。制約を守れなければ None"""
    vs = build(phases, diffs); n = len(vs)
    if n == 0: return None
    A, lo, hi, ub = rows(phases, vs, star, caps)
    c = -np.array([v[1]['contrib'] for v in vs], dtype=float)
    r = milp(c, constraints=LinearConstraint(np.array(A, dtype=float), np.array(lo), np.array(hi)), integrality=np.ones(n), bounds=Bounds(0, ub), options=OPT)
    return -r.fun if r.success else None

data = json.load(open(sys.argv[1]))
bad = []; nreq = nexact = nhours = nhours_ok = nunreach = nunreach_ok = 0; kinds = {}
for x in data:
    key = (x['tname'], x['goal'], x['scope'], x['pr'], x['n'], x['extra'])
    phases, diffs, need, star, caps = x['phases'], x['diffs'], x['need'], x['star'], x['caps']
    tag = f"{x['n']}本・{x['extra'] or 'おまかせ'}"
    kinds.setdefault(tag, [0, 0])
    kinds[tag][1] += 1
    if x['reachable'] and x['req'] is not None:
        # 毎日の時間の最小性（自動の日 = 時間が H の日）：その時間で厳密に届き、0.05時間短いと厳密には届かない
        H = x['hours']
        a = exact_max(phases, diffs, star, caps)
        shorter = [dict(p, hours=(round(p['hours'] - 0.05, 4) if abs(p['hours'] - H) < 1e-9 and H > 0 else p['hours'])) for p in phases]
        b = exact_max(shorter, diffs, star, caps) if H >= 0.05 - 1e-9 else None
        fa = a is not None and a >= need - 1e-6
        fb = b is None or b < need - 1e-6
        nhours += 1
        if fa and fb: nhours_ok += 1
        else: bad.append(('毎日の時間が、厳密な最小でない', key, H, a, b))
        # 必要な肉
        nreq += 1
        ex = exact_min_meat(phases, diffs, need, star, caps)
        if ex is None: bad.append(('厳密解が見つからない', key, x['req']))
        elif x['req'] < ex - 1e-6: bad.append(('JSの必要な肉が、厳密より少ない（異常）', key, x['req'], ex))
        elif abs(x['req'] - ex) > 1e-6: bad.append(('必要な肉が、厳密解と一致しない（JS が多い）', key, x['req'], round(ex, 3)))
        else: nexact += 1; kinds[tag][0] += 1 if (fa and fb) else 0
    else:
        nunreach += 1
        a = exact_max(phases, diffs, star, caps)
        if a is not None and a >= need - 1e-6 and x['hours'] >= 17 - 1e-9: bad.append(('届かないとされたが、17時間で厳密には届く', key, a, need))
        else: nunreach_ok += 1; kinds[tag][0] += 1
anomalies = [b for b in bad if '異常' in b[0] or '届かないとされた' in b[0]]
print(f'極星器つき {len(data)}問：届く {nreq}・届かない {nunreach}')
print(f'  必要な肉が、厳密解と完全に一致：{nexact}/{nreq}（JS が少ない異常：{sum(1 for b in bad if "異常" in b[0])}件）')
print(f'  毎日の時間が、厳密な最小（その時間で届き、0.05時間短いと届かない）：{nhours_ok}/{nhours}')
print(f'  届かない問題が、17時間でも厳密に届かない：{nunreach_ok}/{nunreach}')
for k, (a, b) in kinds.items(): print(f'    {k}：{a}/{b}')
for b_ in bad[:14]: print('  不一致', b_)
strict = '--lenient' not in sys.argv
failed = bool(bad) if strict else bool(anomalies) or nhours_ok < nhours
print('結果：', 'NG' if failed else 'OK', '' if strict else '（--lenient：必要な肉が、厳密解より多いだけの問題は、許す）')
sys.exit(1 if failed else 0)
