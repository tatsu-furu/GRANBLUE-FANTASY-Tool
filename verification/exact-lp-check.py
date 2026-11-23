"""
単体法（2段階法を含む）の答えを、scipy の linprog（HiGHS）と比べる。
  ・状態（解あり / 解なし / 上限なし）が一致する
  ・解ありのとき、最適値が一致し、JS の x が、すべての式を守っている
使い方： python3 exact-lp-check.py lp-instances.json
終了コード： 食い違いがあれば 1
"""
import json, sys
import numpy as np
from scipy.optimize import linprog

data = json.load(open(sys.argv[1]))
bad = []; kinds = {'optimal': 0, 'infeasible': 0, 'unbounded': 0}
for k, p in enumerate(data):
    c, A, b = np.array(p['c'], float), np.array(p['A'], float), np.array(p['b'], float)
    r = linprog(-c, A_ub=A, b_ub=b, bounds=(0, None), method='highs')
    st = {0: 'optimal', 2: 'infeasible', 3: 'unbounded'}.get(r.status, 'other')
    kinds[p['status']] = kinds.get(p['status'], 0) + 1
    if st != p['status']:
        # 上限なしと解なしは、HiGHS が「どちらか」と答えることがある（解なしの上に上限なし）。そのときは、JS が解なしなら、実行可能な点がないことを確かめる
        bad.append((k, '状態', p['status'], st)); continue
    if st == 'optimal':
        if abs(-r.fun - p['value']) > 1e-6 * max(1, abs(r.fun)): bad.append((k, '最適値', p['value'], -r.fun)); continue
        x = np.array(p['x'], float)
        if (x < -1e-7).any() or (A @ x > b + 1e-6).any(): bad.append((k, 'x が式を守っていない', p['x']))
print(f'線形計画 {len(data)}問：JS の状態  解あり {kinds["optimal"]}・解なし {kinds["infeasible"]}・上限なし {kinds["unbounded"]}')
print(f'HiGHS と一致：{len(data) - len(bad)}/{len(data)}')
for b_ in bad[:10]: print('  不一致', b_)
print('結果：', 'NG' if bad else 'OK')
sys.exit(1 if bad else 0)
