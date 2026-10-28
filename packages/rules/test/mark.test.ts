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

/** 偵察機 A0（朝 +x）、隊友 A1，敵機 B0、B1、B2 都在前方 */
function setup(): GameState {
  return makeState([
    { entry: scout, owner: 0, x: 5, y: 10, facingDeg: 0 },
    { entry: rifleX00, owner: 0, x: 5, y: 14, facingDeg: 0 },
    { entry: rifleX00, owner: 1, x: 13, y: 8, facingDeg: 180 },
    { entry: rifleX00, owner: 1, x: 13, y: 10, facingDeg: 180 },
    { entry: rifleX00, owner: 1, x: 13, y: 12, facingDeg: 180 },
  ]);
}

/** 全部懸停，A0 做 action */
function turn(m: Match, action?: Parameters<Match['submitActions']>[1][string]['action']) {
  const mine = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p).map((u) => [u.id, plan({ maneuver: 'hover-S-0' })]));
  m.submitMoves(0, mine(0));
  m.submitMoves(1, mine(1));
  m.submitActions(0, action ? { [m.state.units[0].id]: { action } } : {});
  m.submitActions(1, {});
}

const markedBy = (st: GameState, id: string) => st.units.filter((u) => u.mark?.by === id).map((u) => u.id);

describe('標定', () => {
  it('標定器是戰術道具；沒有標定器的機體不能標定', () => {
    expect(EQUIPMENT.designator.utility).toBe('mark');
    const st = setup();
    expect(validateAction(st.units[0], { action: { type: 'mark', weapon: designatorOf(st.units[0]) } })).toEqual([]);
    expect(validateAction(st.units[1], { action: { type: 'mark', weapon: designatorOf(st.units[0]) } }).length).toBeGreaterThan(0);
  });

  it('前方隨機標定 markCount 台，不用視線；被標定的我方看得到、命中 +MARK_BONUS', () => {
    const st = setup();
    // 牆把偵察機和敵機完全隔開：看不到也一樣標得到
    st.obstacles = [bld('w', 9, 10, 0.5, 6, 4)];
    const m = new Match(3, st);
    turn(m, { type: 'mark', weapon: designatorOf(m.state.units[0]) });
    const marked = markedBy(m.state, m.state.units[0].id);
    expect(marked.length).toBe(EQUIPMENT.designator.markCount);
    for (const id of marked) expect(m.state.visible[0]).toContain(id);
    const target = m.state.units.find((u) => u.id === marked[0])!;
    const base = { attacker: m.state.units[1], attackerSkill: 0, weapon: EQUIPMENT.beam_rifle, targetSkill: null, relSpeed: null, shooterMelee: false };
    expect(hitChance({ ...base, target })!.chance - hitChance({ ...base, target: { ...target, mark: undefined } })!.chance).toBe(C.MARK_BONUS);
  });

  it('後方的敵機標定不到', () => {
    const st = setup();
    st.units[0].facing = Math.PI;
    const m = new Match(3, st);
    turn(m, { type: 'mark', weapon: designatorOf(m.state.units[0]) });
    expect(markedBy(m.state, m.state.units[0].id)).toEqual([]);
    expect(m.eventsFor(0).some((e) => e.type === 'actionFail' && e.reason.includes('沒有可以標定'))).toBe(true);
  });

  it('回合過去不會消失；超出感測距離才解除', () => {
    const m = new Match(3, setup());
    turn(m, { type: 'mark', weapon: designatorOf(m.state.units[0]) });
    for (let k = 0; k < 3; k++) turn(m);
    const marked = markedBy(m.state, m.state.units[0].id);
    expect(marked.length).toBe(2);
    const t = m.state.units.find((u) => u.id === marked[0])!;
    t.pos = { x: 5 + 14 + 3, y: 10 };
    updateSight(m.state);
    expect(t.mark).toBeUndefined();
  });

  it('頭部或標定器壞了就解除', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[0].id };
    st.units[0].parts.head.destroyed = true;
    updateSight(st);
    expect(st.units[2].mark).toBeUndefined();
  });

  it('不疊加：已經被標定的不會再被挑到；重新標定先解除原本的', () => {
    const st = setup();
    // 另一台標定機已經標了 B0、B1，只剩 B2 可以挑
    st.units.push({ ...structuredClone(st.units[0]), id: 'other', pos: { x: 5, y: 6 } });
    st.units[2].mark = { by: 'other' };
    st.units[3].mark = { by: 'other' };
    const m = new Match(3, st);
    turn(m, { type: 'mark', weapon: designatorOf(m.state.units[0]) });
    expect(markedBy(m.state, m.state.units[0].id)).toEqual([m.state.units[4].id]);
    expect(m.state.units[2].mark).toEqual({ by: 'other' });
  });

  it('不暴露位置：被標定的一方看不到是誰在標', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[0].id };
    st.visible[1] = [st.units[1].id];
    expect(filterEvents([{ type: 'mark', unit: st.units[0].id, target: st.units[2].id }], st, 1)).toEqual([{ type: 'mark', unit: '', target: st.units[2].id }]);
    expect(viewState(st, 1).units.find((u) => u.id === st.units[2].id)!.mark).toEqual({});
    expect(viewState(st, 0).units.find((u) => u.id === st.units[2].id)!.mark).toEqual({ by: st.units[0].id });
  });
});
