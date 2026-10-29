import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { damageBuilding } from '../src/demolition';
import { Match } from '../src/match';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { updateSight } from '../src/visibility';
import { makeState, plan, rifleX00 } from './helpers';

// 規則第 5 版：隕石群的視野與開火暴露、化學能拆樓、散射武器的流彈
const field = (x: number, y: number, r = 2.5): Obstacle => ({ id: 'f', kind: 'field', x, y, r });

/** 雙方都懸停、照給的行動打一回合，回傳這回合的事件 */
function turn(m: Match, actions: [Record<string, unknown>, Record<string, unknown>]): GameEvent[] {
  const mv = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, plan({ maneuver: 'hover-S-0' })]));
  expect([...m.submitMoves(0, mv(0)), ...m.submitMoves(1, mv(1))]).toEqual([]);
  const events: GameEvent[] = [...m.turnResolvedEvents];
  if (m.phase === 'pursuit') {
    m.submitPursuits(0, {});
    m.submitPursuits(1, {});
    events.push(...m.turnResolvedEvents);
  }
  expect([...m.submitActions(0, actions[0] as never), ...m.submitActions(1, actions[1] as never)]).toEqual([]);
  return [...events, ...m.turnResolvedEvents];
}

describe('隕石群（第 5 版）', () => {
  it('群裡往外只看得到 FIELD_LOOK_OUT_RANGE', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 5 + C.FIELD_LOOK_OUT_RANGE + 3, y: 10, facingDeg: 180 },
    ]);
    st.obstacles = [field(5, 10)];
    st.rules = 5;
    updateSight(st);
    expect(st.visible[0]).not.toContain(st.units[1].id);
    st.rules = 4;
    updateSight(st);
    expect(st.visible[0]).toContain(st.units[1].id);
  });

  it('在群裡開火：到下一回合結束前，FIELD_FIRE_EXPOSE_RANGE 內的敵機看得到它', () => {
    const st: GameState = {
      ...makeState([
        { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
        { entry: rifleX00, owner: 1, x: 11, y: 10, facingDeg: 180 },
      ]),
      rules: 5,
    };
    st.obstacles = [field(5, 10)];
    updateSight(st);
    expect(st.visible[1]).not.toContain(st.units[0].id);
    const m = new Match(1, st);
    const [a, b] = m.state.units;
    turn(m, [{ [a.id]: { action: { type: 'shoot', weapon: a.equipment[0].id, target: b.id } } }, {}]);
    expect(m.state.units[0].exposedUntil).toBe(2);
    expect(m.state.visible[1]).toContain(a.id);
  });
});

describe('拆樓（第 5 版）', () => {
  it('化學能的倍率 CHEMICAL_BUILDING_MULT_V5', () => {
    const b = (): Obstacle => ({ id: 'b', kind: 'building', x: 5, y: 5, r: 1.5, hx: 1, hy: 1, levels: 3 });
    const o = b();
    expect(damageBuilding([o], o, 50, 'chemical', () => 1, C.CHEMICAL_BUILDING_MULT_V5).amount).toBe(125);
    const o2 = b();
    expect(damageBuilding([o2], o2, 50, 'chemical').amount).toBe(100);
  });
});

describe('流彈（第 5 版）', () => {
  const gunner: RosterEntry = { chassis: 'X-00', pilot: 'recruit', equipment: [['machine_gun', 'right']] };
  const run = (rules: number) => {
    let strays = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const st: GameState = {
        ...makeState(
          [
            { entry: gunner, owner: 0, x: 5, y: 10, facingDeg: 0 },
            { entry: rifleX00, owner: 1, x: 12, y: 10, facingDeg: 180 },
            { entry: rifleX00, owner: 1, x: 12, y: 11.6, facingDeg: 180 },
          ],
          seed,
        ),
        rules,
      };
      const m = new Match(seed, st);
      const [a, t] = m.state.units;
      const events = turn(m, [{ [a.id]: { action: { type: 'shoot', weapon: a.equipment[0].id, target: t.id } } }, {}]);
      strays += events.filter((e) => e.type === 'stray').length;
    }
    return strays;
  };
  it('散射武器沒打中的一發可能打到目標旁邊的敵機；第 4 版以前沒有', () => {
    expect(EQUIPMENT.machine_gun.shots).toBeGreaterThanOrEqual(3);
    expect(run(5)).toBeGreaterThan(0);
    expect(run(4)).toBe(0);
  });
});
