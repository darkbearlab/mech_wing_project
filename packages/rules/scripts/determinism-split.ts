import { ordersBySquad, type Match, type Orders, type PlayerId } from '../src';

/** 照目前的步驟送出一方（或一個小隊）的指令 */
export function submitOrders(m: Match, p: PlayerId, orders: Orders, squad?: number): void {
  const ph = m.phase;
  const o = orders as never;
  const errs = ph === 'move' || ph === 'ace' ? m.submitMoves(p, o, squad) : ph === 'pursuit' ? m.submitPursuits(p, o, squad) : ph === 'deploy' ? m.submitDeploy(p, o, squad) : m.submitActions(p, o, squad);
  if (errs.length) throw new Error(errs.join('；'));
}

/** 整方的指令拆給各小隊，從後面的小隊開始送（順序反過來也要一樣） */
export function splitOrders(m: Match, p: PlayerId, orders: Orders): void {
  const parts = Object.entries(ordersBySquad(m.state, p, orders)).reverse();
  const step = m.resolvedCount;
  for (const [s, o] of parts) {
    // 其他小隊沒事做時，最後一個送出就結算了，剩下的指令是上一步的
    if (m.resolvedCount !== step || m.isSubmitted(p, Number(s))) continue;
    submitOrders(m, p, o, Number(s));
  }
}
