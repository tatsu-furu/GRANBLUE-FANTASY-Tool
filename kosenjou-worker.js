/**
 * 古戦場ツール：かんたん計画の計算を、画面とは別のスレッドで行う（Web Worker）。
 * 入力中に、画面が止まらないようにするため。計算そのものは、ページの中で行う場合（Worker が使えないとき）と、同じ関数（PlanCore.compute）。
 *
 * 受け取る：{ id, W, env }　返す：{ id, R }（失敗したときは { id, error }）
 */
importScripts('kosenjou-data.js', 'kosenjou-schedule.js', 'kosenjou-plan-core.js');

self.onmessage = (e) => {
    const { id, W, env } = e.data;
    try {
        self.postMessage({ id, R: PlanCore.compute(W, env) });
    } catch (err) {
        self.postMessage({ id, error: String((err && err.stack) || err) });
    }
};
