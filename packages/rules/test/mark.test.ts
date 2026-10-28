import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { hitChance } from '../src/combat';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { Match } from '../src/match';
import { filterEvents, updateSight, viewState } from '../src/visibility';
import type { GameState, Obstacle, UnitState } from '../src/types';
import { validateAction } from '../src/unit';
import { makeState, plan, rifleX00 } from './helpers';

const scout: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['designator', 'mount', 'head']] };
const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });
const designatorOf = (u: UnitState) => u.equipment.find((e) => e.defId === 'designator')!.id;

/** 偵察機 A0、隊友 A1、敵機 B */
function setup(): GameState {
  return makeState([
    { entry: scout, owner: 0, x: 5, y: 5, facingDeg: 0 },
    { entry: rifleX00, owner: 0, x: 5, y: 9, facingDeg: 0 },
    { entry: rifleX00, owner: 1, x: 13, y: 5, facingDeg: 180 },
  ]);
}

/** 全部懸停，A0 做 action */
function turn(m: Match, action?: Parameters<Match['submitActions']>[1][string]['action']) {
  const [a0, a1, b] = m.state.units;
  m.submitMoves(0, { [a0.id]: plan({ maneuver: 'hover-S-0' }), [a1.id]: plan({ maneuver: 'hover-S-0' }) });
  m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
  m.submitActions(0, action ? { [a0.id]: { action } } : {});
  m.submitActions(1, {});
}

describe('標定', () => {
  it('標定器是戰術道具；偵察型感測距離比較遠', () => {
    expect(EQUIPMENT.designator.utility).toBe('mark');
    const st = setup();
    expect(validateAction(st.units[0], { action: { type: 'mark', weapon: designatorOf(st.units[0]), target: st.units[2].id } })).toEqual([]);
    // 沒有標定器的機體不能標定
    expect(validateAction(st.units[1], { action: { type: 'mark', weapon: designatorOf(st.units[0]), target: st.units[2].id } }).length).toBeGreaterThan(0);
  });

  it('標定後我方射擊命中 +MARK_BONUS，回合過去也不會消失', () => {
    const m = new Match(3, setup());
    const [a0, , b] = m.state.units;
    turn(m, { type: 'mark', weapon: designatorOf(a0), target: b.id });
    const target = m.state.units[2];
    expect(target.mark).toEqual({ by: a0.id });
    const ally = m.state.units[1];
    const base = { attacker: ally, attackerSkill: 0, weapon: EQUIPMENT.beam_rifle, targetSkill: null, relSpeed: null, shooterMelee: false };
    const marked = hitChance({ ...base, target })!.chance;
    const plain = hitChance({ ...base, target: { ...target, mark: undefined } })!.chance;
    expect(marked - plain).toBe(C.MARK_BONUS);
    expect(m.eventsFor(1).some((e) => e.type === 'mark')).toBe(true);
    for (let k = 0; k < 3; k++) turn(m);
    expect(m.state.turn).toBe(5);
    expect(m.state.units[2].mark).toEqual({ by: a0.id });
  });

  it('標定機失去視線就解除', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[0].id };
    updateSight(st);
    expect(st.units[2].mark).toBeDefined();
    st.obstacles = [bld('w', 9, 5, 0.5, 1.2, 4)];
    updateSight(st);
    expect(st.units[2].mark).toBeUndefined();
  });

  it('超出感測距離、頭部壞掉都會解除', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[0].id };
    st.units[2].pos = { x: 5 + 14 + 3, y: 5 };
    updateSight(st);
    expect(st.units[2].mark).toBeUndefined();
    const st2 = setup();
    st2.units[2].mark = { by: st2.units[0].id };
    st2.units[0].parts.head.destroyed = true;
    updateSight(st2);
    expect(st2.units[2].mark).toBeUndefined();
  });

  it('不疊加：已經被標定的不能再標；改照別台，原本的解除', () => {
    const st = makeState([
      { entry: scout, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: scout, owner: 0, x: 5, y: 9, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 13, y: 5, facingDeg: 180 },
      { entry: rifleX00, owner: 1, x: 13, y: 9, facingDeg: 180 },
    ]);
    const [a0, a1, b0, b1] = st.units;
    st.units[2].mark = { by: a0.id };
    const m = new Match(3, st);
    m.submitMoves(0, { [a0.id]: plan({ maneuver: 'hover-S-0' }), [a1.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [b0.id]: plan({ maneuver: 'hover-S-0' }), [b1.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitActions(0, { [a1.id]: { action: { type: 'mark', weapon: designatorOf(a1), target: b0.id } }, [a0.id]: { action: { type: 'mark', weapon: designatorOf(a0), target: b1.id } } });
    m.submitActions(1, {});
    // 行動順序不固定：a1 先動就是「不疊加」失敗；a0 先改照 b1，a1 就標得到 b0
    const fails = m.eventsFor(0).some((e) => e.type === 'actionFail' && e.reason.includes('不疊加'));
    expect(m.state.units[3].mark).toEqual({ by: a0.id });
    expect(m.state.units[2].mark).toEqual(fails ? undefined : { by: a1.id });
  });

  it('被標定的一方看不到是誰在照', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[0].id };
    expect(viewState(st, 1).units.find((u) => u.id === st.units[2].id)!.mark).toEqual({});
    expect(viewState(st, 0).units.find((u) => u.id === st.units[2].id)!.mark).toEqual({ by: st.units[0].id });
  });

  it('要自己看得到才能標定（隊友看得到不算）', () => {
    const st = setup();
    // 牆只擋住偵察機和敵機之間
    st.obstacles = [bld('w', 9, 5, 0.5, 1.2, 4)];
    const m = new Match(3, st);
    const [a0, , b] = m.state.units;
    turn(m, { type: 'mark', weapon: designatorOf(a0), target: b.id });
    expect(m.state.units[2].mark).toBeUndefined();
    expect(m.eventsFor(0).some((e) => e.type === 'actionFail' && e.reason.includes('自己看得到'))).toBe(true);
  });

  it('照射不會暴露位置：對方看不到標定的機體時，不知道是誰標定的', () => {
    const st = setup();
    st.visible[1] = [st.units[1].id];
    const out = filterEvents([{ type: 'mark', unit: st.units[0].id, target: st.units[2].id }], st, 1);
    expect(out).toEqual([{ type: 'mark', unit: '', target: st.units[2].id }]);
  });
});
