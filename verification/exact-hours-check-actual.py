"""
実際の肉・素材（足りないときも含む）での「毎日の時間」の最小性を、厳密解法（HiGHS）で確かめる。
instances3.json（画面の関数が出した問題）から：
  届く問題：(a) その時間で厳密に届く  (b) 0.05時間短いと厳密には届かない  → 両方そろえば、厳密な最小
  届かない問題：17時間でも、厳密に届かない
素材の予定数（mat250）があれば、素材から肉への変換（0〜500）も入れて解く。
使い方： python3 -I exact-hours-check-actual.py instances3.json
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
        A.append([v[1]['chunks'] if v[1]['is250'] else 0 for v in vs] + [1]); hi.append(max(0, mat)); ub = ub + [500]
    r = milp(c, constraints=LinearConstraint(np.array(A, dtype=float), -np.inf, np.array(hi)), integrality=np.ones(N), bounds=Bounds(0, ub), options=OPT)
    return -r.fun if r.success else None

total = good = 0; kinds = {'届く': [0, 0], '届かない': [0, 0]}; bad = []; byhv = {}
seen = set()
for x in json.load(open(sys.argv[1])):
    key = json.dumps([x['tname'], x.get('hv'), x['pr'], x['need'], x['stock'], x['mat250'], x['hours']])
    if key in seen: continue
    seen.add(key)
    H, need, stock, mat = x['hours'], x['need'], x['stock'], x['mat250']
    total += 1
    if x['reachable']:
        a = exact_max(x['phases'], x['diffs'], stock, mat)
        shorter = [dict(p, hours=(round(p['hours'] - 0.05, 4) if (x['fixedHours'][i] is None and p['hours'] > 0) else p['hours'])) for i, p in enumerate(x['phases'])]
        b = exact_max(shorter, x['diffs'], stock, mat) if H >= 0.05 - 1e-9 else -1
        fa = a is not None and a >= need - 1e-6
        fb = (b is None) or (b < need - 1e-6)
        kinds['届く'][0] += 1; ok = fa and fb
    else:
        a = exact_max(x['phases'], x['diffs'], stock, mat); b = None
        ok = a is not None and a < need - 1e-6
        kinds['届かない'][0] += 1
    byhv.setdefault(x.get('hv'), [0, 0]); byhv[x.get('hv')][0] += 1; byhv[x.get('hv')][1] += 1 if ok else 0
    if ok: good += 1; kinds['届く' if x['reachable'] else '届かない'][1] += 1
    else: bad.append((x['tname'], x.get('hv'), x['pr'], x['goal'], x['meat'], x['mat'], H, a, b, need))
print(f'実際の肉・素材での毎日の時間：{total} 件')
for k, (n, g) in kinds.items(): print(f'  {k}問題：{g}/{n} 件 厳密解と一致' + ('（届く = その時間で届き、0.05時間短いと届かない）' if k == '届く' else '（17時間でも、厳密に届かない）'))
print(f'  全体：{good}/{total}')
for k, (n, g) in byhv.items(): print(f'    日ごとの時間の指定 {k}：{g}/{n}')
for b in bad[:12]: print('  不一致', b)
print('結果：', 'NG' if bad else 'OK')
sys.exit(1 if bad else 0)
