import { describe, expect, it } from 'vitest';
import type { RosterEntry } from '../src/data';
import { Match } from '../src/match';
import type { GameState } from '../src/types';
import { updateSight } from '../src/visibility';
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

// 規則第 7 版：開著的干擾器只暴露位置
describe('干擾器只暴露位置（第 7 版）', () => {
  const jammer: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['ecm_pod', 'mount', 'pack']] };
  const gunner: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['mortar', 'mount', 'torso']] };
  const at = (rules: number) => {
    const st: GameState = {
      ...makeState([
        { entry: gunner, owner: 0, x: 3, y: 10, facingDeg: 0 },
        // 超出 X-04 的感測距離 10、在干擾暴露距離 12 內
        { entry: jammer, owner: 1, x: 14.5, y: 10, facingDeg: 180 },
      ]),
      rules,
    };
    updateSight(st);
    return st;
  };
  it('看得到位置但標成 located；直射打不到，迫擊砲不用標定可以打', () => {
    const st = at(7);
    const [a, j] = st.units;
    expect(st.visible[0]).toContain(j.id);
    expect(st.located?.[0]).toContain(j.id);
    const m = new Match(1, st);
    const mv = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p).map((u) => [u.id, plan({ maneuver: 'hover-S-0' })]));
    m.submitMoves(0, mv(0));
    m.submitMoves(1, mv(1));
    if (m.phase === 'pursuit') m.submitPursuits(0, {}), m.submitPursuits(1, {});
    const gun = a.equipment.find((e) => e.defId === 'machine_gun')!.id;
    const mortar = a.equipment.find((e) => e.defId === 'mortar')!.id;
    m.submitActions(0, { [a.id]: plan({ maneuver: 'hover-S-0', action: { type: 'shoot', weapon: gun, also: [mortar], target: j.id } }) } as never);
    m.submitActions(1, {});
    const ev = m.turnResolvedEvents;
    expect(ev.some((e) => e.type === 'actionFail' && e.reason.includes('只知道位置'))).toBe(true);
    expect(ev.some((e) => e.type === 'launch' || (e.type === 'shot' && e.weapon === 'mortar'))).toBe(true);
  });
  it('第 6 版以前：干擾機算看得見，沒有 located', () => {
    const st = at(6);
    expect(st.visible[0]).toContain(st.units[1].id);
    expect(st.located?.[0] ?? []).toEqual([]);
  });
});
