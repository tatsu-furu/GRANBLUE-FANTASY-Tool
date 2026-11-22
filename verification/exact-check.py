"""
画面の計算（回数の割り振り・必要な肉）を、厳密解法（HiGHS：scipy の milp、gap 0）と比べる。
instances*.json は、dump-instances*.mjs が、画面の関数から取り出した問題。
  max … 肉の数ごとの、取れる貢献度（JS が厳密解を超えたら異常）
  cap … 素材の予定数あり（素材 → 肉の変換つき）の、取れる貢献度（同上）
  req … 目標に届くのに必要な肉の数（JS が厳密解より少なかったら異常）
使い方： python3 exact-check.py instances.json [--strict-req]
  --strict-req … 必要な肉が、厳密解と、完全に一致することも求める（問題の集合1で使う）
終了コード： 異常があれば 1
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

def exact_max(phases, diffs, stock, mat=None):
    vs = build(phases, diffs); n = len(vs)
    if n == 0: return 0.0
    has_y = mat is not None
    N = n + (1 if has_y else 0)
    c = -np.array([v[1]['contrib'] for v in vs] + ([0] if has_y else []), dtype=float)
    A, hi = [], []
    for ph in phases:
        if ph['hours'] <= 0: continue
        A.append([v[1]['time'] if v[0]['id'] == ph['id'] else 0 for v in vs] + ([0] if has_y else [])); hi.append(ph['hours'] * 3600 + 1e-6)
    A.append([0 if v[1]['is250'] else v[1]['chunks'] for v in vs] + ([-2] if has_y else [])); hi.append(max(0, stock))
    ub = [np.inf] * n
    if has_y:
        A.append([v[1]['chunks'] if v[1]['is250'] else 0 for v in vs] + [1]); hi.append(max(0, mat))
        ub = ub + [500]
    r = milp(c, constraints=LinearConstraint(np.array(A, dtype=float), -np.inf, np.array(hi)), integrality=np.ones(N), bounds=Bounds(0, ub), options=OPT)
    return -r.fun if r.success else None

def exact_min_meat(phases, diffs, need):
    vs = build(phases, diffs); n = len(vs)
    if n == 0: return None
    c = np.array([0 if v[1]['is250'] else v[1]['chunks'] for v in vs], dtype=float)
    A, lo, hi = [], [], []
    for ph in phases:
        if ph['hours'] <= 0: continue
        A.append([v[1]['time'] if v[0]['id'] == ph['id'] else 0 for v in vs]); lo.append(-np.inf); hi.append(ph['hours'] * 3600 + 1e-6)
    A.append([v[1]['contrib'] for v in vs]); lo.append(need); hi.append(np.inf)
    r = milp(c, constraints=LinearConstraint(np.array(A, dtype=float), np.array(lo), np.array(hi)), integrality=np.ones(n), bounds=Bounds(0, np.inf), options=OPT)
    return r.fun if r.success else None

args = [a for a in sys.argv[1:] if not a.startswith('--')]
STRICT_REQ = '--strict-req' in sys.argv
data = json.load(open(args[0]))
seen = set()
st = {'max': [0, 1.0, None, 0], 'cap': [0, 1.0, None, 0], 'req': [0, 1.0, None, 0]}
bad = []
inexact_req = []
for x in data:
    key = json.dumps([x['tname'], x['pr'], x['need'], x['hours'], x['scope']])
    if key in seen: continue
    seen.add(key)
    for m in x['maxes']:
        ex = exact_max(x['phases'], x['diffs'], m['S'])
        if not ex: continue
        r = m['total'] / ex; st['max'][0] += 1
        if r > 1 + 1e-9: bad.append(('JSが厳密解を超えた', key, m, ex))
        if r < st['max'][1]: st['max'][1] = r; st['max'][2] = (x['tname'], x['pr'], x['goal'], x['scope'], m['S'])
        if r < 0.999: st['max'][3] += 1
    for m in x.get('maxesCap', []):
        ex = exact_max(x['phases'], x['diffs'], m['S'], m['M'])
        if not ex: continue
        r = m['total'] / ex; st['cap'][0] += 1
        if r > 1 + 1e-9: bad.append(('JSが厳密解を超えた（変換あり）', key, m, ex))
        if r < st['cap'][1]: st['cap'][1] = r; st['cap'][2] = (x['tname'], x['pr'], x['goal'], x['scope'], m['S'], m['M'])
        if r < 0.999: st['cap'][3] += 1
    if x['reachable'] and x['req'] is not None:
        ex = exact_min_meat(x['phases'], x['diffs'], x['need'])
        if ex is None: continue
        st['req'][0] += 1
        if x['req'] < ex - 1e-6: bad.append(('JSの必要な肉が厳密より少ない', key, x['req'], ex))
        r = ex / x['req'] if x['req'] else 1.0
        if r < st['req'][1]: st['req'][1] = r; st['req'][2] = (x['tname'], x['pr'], x['goal'], x['scope'], x['req'], ex)
        if x['req'] - ex > 0.0005 * max(1, ex): st['req'][3] += 1
        if abs(x['req'] - ex) > 1e-6: inexact_req.append((x['tname'], x['pr'], x['goal'], x['scope'], x['req'], ex))
for k, (n, w, case, cnt) in st.items():
    print(f'{k:4s} {n}件  最低 {w*100:.3f}%  {case}  （{"99.9%未満" if k != "req" else "0.05%超"} {cnt}件）')
print('異常:', len(bad)); [print('  ', b) for b in bad[:10]]
print(f'必要な肉が、厳密解と完全に一致：{st["req"][0] - len(inexact_req)}/{st["req"][0]} 件')
if STRICT_REQ: [print('  不一致', b) for b in inexact_req[:10]]
failed = len(bad) > 0 or (STRICT_REQ and len(inexact_req) > 0)
print('結果：', 'NG' if failed else 'OK')
sys.exit(1 if failed else 0)
