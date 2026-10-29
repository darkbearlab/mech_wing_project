import { describe, expect, it } from 'vitest';
import type { RosterEntry } from '../src/data';
import { Match } from '../src/match';
import type { GameState } from '../src/types';
import { makeState, plan, rifleX00 } from './helpers';

// 規則第 6 版：勝利點數。斬首、擊墜分各 1 點，回合結束時點數多的獲勝，同分繼續打
const heavy: RosterEntry = { ...rifleX00, pilot: 'ace' };

function hold(m: Match) {
  const mv = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, plan({ maneuver: 'hover-S-0' })]));
  m.submitMoves(0, mv(0));
  m.submitMoves(1, mv(1));
  if (m.phase === 'pursuit') {
    m.submitPursuits(0, {});
    m.submitPursuits(1, {});
  }
  m.submitActions(0, {});
  m.submitActions(1, {});
}

/** A、B 各有一台旗艦（王牌）和一台僚機；lost 列出開場前就已經退場的旗艦 */
function setup(rules: number, lost: (0 | 1)[], killScore = 100): Match {
  const st: GameState = {
    ...makeState([
      { entry: heavy, owner: 0, x: 3, y: 3, facingDeg: 0 },
      { entry: rifleX00, owner: 0, x: 3, y: 6, facingDeg: 0 },
      { entry: heavy, owner: 1, x: 20, y: 20, facingDeg: 180 },
      { entry: rifleX00, owner: 1, x: 20, y: 17, facingDeg: 180 },
    ]),
    rules,
    settings: { killScore, decapitation: true, turnLimit: 25, deploy: 'fixed' },
  };
  for (const p of lost) st.units.find((u) => u.owner === p && u.chassisId && u.pilotId === 'ace')!.status = 'destroyed';
  return new Match(1, st);
}

describe('勝利點數（第 6 版）', () => {
  it('只有一方斬首：回合結束時那一方獲勝', () => {
    const m = setup(6, [1]);
    hold(m);
    expect(m.state.winner).toBe(0);
    expect(m.state.points).toEqual([1, 0]);
  });

  it('雙方都斬首（各 1 點）：同分，繼續打', () => {
    const m = setup(6, [0, 1]);
    hold(m);
    expect(m.state.winner).toBeNull();
    expect(m.state.points).toEqual([1, 1]);
  });

  it('斬首和擊墜分可以同時拿：雙方都 2 點時同分，繼續打', () => {
    // 擊墜分門檻 1：雙方的旗艦都退場，斬首與擊墜分各拿到
    const m = setup(6, [0, 1], 1);
    hold(m);
    expect(m.state.points).toEqual([2, 2]);
    expect(m.state.winner).toBeNull();
  });

  it('第 5 版以前：旗艦退場當下就判定', () => {
    const m = setup(5, [1]);
    hold(m);
    expect(m.state.winner).toBe(0);
    expect(m.state.points).toBeUndefined();
  });
});
