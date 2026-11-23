"""
毎日の時間（最小の H）の最小性を、厳密解法（HiGHS）で確かめる。
instances*.json（画面の関数が出した問題）から、肉・素材が十分あるときの最小の H（0.05時間きざみ）について、
  (a) その H で、整数の計画が、目標に届く（厳密に最大化して、need 以上）
  (b) その H より 0.05 時間短いと、厳密には、届かない（need 未満）
を確かめる。(a) と (b) がそろえば、H は、厳密な最小。
使い方： python3 -I exact-hours-check.py instances.json [instances2.json ...]
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

def exact_max_unlimited(phases, diffs):
    vs = build(phases, diffs); n = len(vs)
    if n == 0: return 0.0
    c = -np.array([v[1]['contrib'] for v in vs], dtype=float)
    A, hi = [], []
    for ph in phases:
        if ph['hours'] <= 0: continue
        A.append([v[1]['time'] if v[0]['id'] == ph['id'] else 0 for v in vs]); hi.append(ph['hours'] * 3600 + 1e-6)
    r = milp(c, constraints=LinearConstraint(np.array(A, dtype=float), -np.inf, np.array(hi)), integrality=np.ones(n), bounds=Bounds(0, np.inf), options=OPT)
    return -r.fun if r.success else None

total = ok_a = ok_b = 0; bad = []
for path in sys.argv[1:]:
    seen = set()
    for x in json.load(open(path)):
        if not x['reachable']: continue
        key = json.dumps([x['tname'], x['pr'], x['need'], x['hours'], x['scope']])
        if key in seen: continue
        seen.add(key)
        H = x['hours']
        phases = x['phases']
        a = exact_max_unlimited(phases, x['diffs'])
        # 自動の日（時間が H の日）を 0.05 時間短くする。固定の日は、そのまま
        shorter = [dict(p, hours=(round(p['hours'] - 0.05, 4) if abs(p['hours'] - H) < 1e-9 else p['hours'])) for p in phases]
        b = exact_max_unlimited(shorter, x['diffs']) if H >= 0.05 - 1e-9 else -1
        total += 1
        fa = a is not None and a >= x['need'] - 1e-6
        fb = (b is None) or (b < x['need'] - 1e-6)
        ok_a += fa; ok_b += fb
        if not (fa and fb): bad.append((path.split('/')[-1], x['tname'], x['pr'], x['goal'], x['scope'], H, a, b, x['need']))
print(f'毎日の時間の最小性：{total} 件')
print(f'  (a) その時間で、厳密に、目標に届く：{ok_a}/{total}')
print(f'  (b) 0.05時間短いと、厳密に、届かない：{ok_b}/{total}')
print(f'  両方成り立つ（＝厳密な最小）：{total - len(bad)}/{total}')
for b in bad[:12]: print('  不一致', b)
print('結果：', 'NG' if bad else 'OK')
sys.exit(1 if bad else 0)
