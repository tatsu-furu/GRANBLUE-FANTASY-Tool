# 古戦場ツールのテストと検証

サイトの表示には使いません（開発用）。リポジトリのルートで、次のように動かします。

## ブラウザテスト（Chromium）

```
npm ci                              # 初回だけ（playwright を入れる）
npx playwright install chromium     # 初回だけ（ブラウザを入れる）
npm test                            # すべて（下の順に走る）
npm run test:sources                # ソースの決まりごと（ドロップ率の定義が1か所、など）（ブラウザなし）
npm run test:engine                 # 計算（kosenjou-schedule.js）：同じ入力は同じ答え・整数の検算（ブラウザなし）
npm run test:worker                 # かんたん計画の計算を Web Worker で行う仕組み（結果の一致・CPU 4倍遅くしても一致・入力中に止まらない・Worker が使えないとき）
npm run test:kosenjou               # 古戦場ツール本体（kosenjou.html・kosenjou-beta.html の2つ）
npm run test:plan                   # かんたん計画タブ（同じく2つ。計算はページの中）
npm run test:plan:worker            # 同じテストを、計算を Worker にして通す
```

- 失敗があると、終了コードが 1 になります。
- 外への通信は止めて動かします（このサイトは、外部の通信をしない前提）。
- スクリーンショットを撮りたいときは、`SHOTS_DIR=/保存先 npm test`（指定しなければ撮りません）。
- push とプルリクエストでは、`.github/workflows/test.yml` が、同じテストを自動で走らせます。

## 厳密解法（HiGHS）との照合

画面の計算（回数の割り振り・必要な肉・毎日の時間）を、厳密解法と比べます。時間がかかるので、手動で動かします。

```
pip install -r verification/requirements.txt
npm run verify                      # PYTHON=… で Python を指定できます
```

- `verification/dump-instances*.mjs` が、画面の関数を呼んで、問題（討伐時間・目標・肉・素材・日ごとの時間）と答えを `verification/out/` に出します。
- `verification/exact-*.py` が、同じ問題を scipy の `milp`（HiGHS、gap 0）で厳密に解いて比べます。異常があると、終了コードが 1 になります。
- GitHub では、Actions タブの「厳密解法（HiGHS）との照合」→ Run workflow で動かせます。

| 集合 | 中身 | 見るもの |
| --- | --- | --- |
| 1 | 討伐時間5通り × 目標5通り × 範囲2通り × 優先2通り（100問） | 取れる貢献度、必要な肉（厳密解と**完全に一致**） |
| 2 | 1 に加えて、ランダムな討伐時間14通り・素材の変換つき（216問） | 取れる貢献度、必要な肉（厳密解より少なくならない） |
| 毎日の時間（十分） | 集合1・2の「届く」問題 | その時間で届き、0.05時間短いと届かない |
| 毎日の時間（実際） | 実際の肉・素材・日ごとの指定つき（540問） | 同上、と「17時間でも届かない」ことの確認 |

## ファイル

- `tests/lib.mjs` … 静的サーバー・ブラウザの起動・スクリーンショット（テストと検証が共有）
- `tests/engine.mjs` … 計算を、ブラウザなしで読み込む部品（Node の vm）
- `tests/test-sources.mjs`・`tests/test-engine.mjs`・`tests/test-worker.mjs` … 上のとおり
- `tests/test-kosenjou.mjs` … 古戦場ツール本体（肉計算・目標・スケジュールなど）
- `tests/test-plan.mjs` … かんたん計画タブ（`--worker` で、Worker 計算のまま通す）
- `verification/run.mjs` … 照合の入口
