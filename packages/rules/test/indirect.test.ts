import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { barrierBetween, hitChance } from '../src/combat';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { Match } from '../src/match';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { makeState, plan, rifleX00 } from './helpers';

const scout: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['designator', 'mount', 'head']] };
const gunner: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['mortar', 'mount', 'torso'], ['missile_pod', 'mount', 'torso']] };
const riot: RosterEntry = { chassis: 'X-02', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['riot_shield', 'left']] };
const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });

/** 砲手 A0、偵察機 A1，敵機 B 在 9 格外 */
function setup(): GameState {
  return makeState([
    { entry: gunner, owner: 0, x: 5, y: 10, facingDeg: 0 },
    { entry: scout, owner: 0, x: 5, y: 13, facingDeg: 0 },
    { entry: rifleX00, owner: 1, x: 14, y: 10, facingDeg: 180 },
  ]);
}

const chance = (st: GameState, weapon: string, skill = 3, cover?: 'blocked' | 'clear') =>
  hitChance({ attacker: st.units[0], attackerSkill: skill, weapon: EQUIPMENT[weapon], target: st.units[2], targetSkill: null, relSpeed: 3, shooterMelee: false, cover })?.chance ?? null;

function turn(m: Match, actions: Parameters<Match['submitActions']>[1] = {}, moves: Record<string, string> = {}) {
  const mine = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, plan({ maneuver: moves[u.id] ?? 'hover-S-0' })]));
  m.submitMoves(0, mine(0));
  m.submitMoves(1, mine(1));
  m.submitActions(0, actions);
  m.submitActions(1, {});
}

describe('導引武器', () => {
  it('只能打被標定的目標', () => {
    const st = setup();
    expect(chance(st, 'mortar')).toBeNull();
    expect(chance(st, 'vls')).toBeNull();
    expect(chance(st, 'missile_pod')).toBeNull();
    st.units[2].mark = { by: st.units[1].id };
    expect(chance(st, 'mortar')).not.toBeNull();
    expect(chance(st, 'vls')).not.toBeNull();
    expect(chance(st, 'missile_pod')).not.toBeNull();
  });

  it('只看機器：射手駕駛的技能不算；導引飛彈不吃相對速度懲罰', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[1].id };
    expect(chance(st, 'vls', 0)).toBe(chance(st, 'vls', 5));
    expect(chance(st, 'mortar', 0)).toBe(chance(st, 'mortar', 5));
    const at = (weapon: string, relSpeed: number) => hitChance({ attacker: st.units[0], attackerSkill: 0, weapon: EQUIPMENT[weapon], target: st.units[2], targetSkill: null, relSpeed, shooterMelee: false })!.chance;
    // 飛彈：再快都不扣；迫擊砲（沒有導引）照扣
    expect(at('vls', 20)).toBe(at('vls', 4));
    expect(at('mortar', 20)).toBeLessThan(at('mortar', 4));
  });

  it('迫擊砲、垂直飛彈越過建築；平射飛彈被擋住', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[1].id };
    expect(chance(st, 'mortar', 3, 'blocked')).not.toBeNull();
    expect(chance(st, 'vls', 3, 'blocked')).not.toBeNull();
    expect(chance(st, 'missile_pod', 3, 'blocked')).toBeNull();
  });

  it('迫擊砲隔著大樓打標定的目標；沒打中的會散布爆炸', () => {
    const st = setup();
    st.obstacles = [bld('w', 9.5, 10, 1, 1.5, 4)];
    const m = new Match(9, st);
    const [a0, a1, b] = m.state.units;
    const mortar = a0.equipment.find((e) => e.defId === 'mortar')!.id;
    const designator = a1.equipment.find((e) => e.defId === 'designator')!.id;
    turn(m, { [a1.id]: { action: { type: 'mark', weapon: designator } } });
    expect(m.state.units[2].mark).toBeDefined();
    const events: GameEvent[] = [];
    for (let k = 0; k < 4 && m.state.winner === null; k++) {
      turn(m, { [a0.id]: { action: { type: 'shoot', weapon: mortar, target: b.id } } });
      events.push(...m.eventsFor(0));
    }
    const shots = events.filter((e): e is Extract<GameEvent, { type: 'shot' }> => e.type === 'shot');
    expect(shots.length).toBeGreaterThan(0);
    const misses = shots.reduce((n, s) => n + s.shots - s.hits, 0);
    expect(events.filter((e) => e.type === 'blast').length).toBe(misses);
  });
});

describe('展開盾', () => {
  function wallSetup(): GameState {
    return makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: riot, owner: 1, x: 10, y: 10, facingDeg: 180 },
    ]);
  }

  it('展開後正面成一道盾牆；正面打來的命中都打在盾上', () => {
    const m = new Match(4, wallSetup());
    const [a, b] = m.state.units;
    const shield = b.equipment.find((e) => e.defId === 'riot_shield')!.id;
    m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitActions(0, {});
    m.submitActions(1, { [b.id]: { action: { type: 'deploy', weapon: shield } } });
    expect(m.state.units[1].equipment.find((e) => e.id === shield)!.deployed).toBe(true);
    expect(barrierBetween(m.state.units, a.id, a.pos, 0, m.state.units[1].pos)?.unit.id).toBe(b.id);
    const rifle = a.equipment.find((e) => e.defId === 'beam_rifle')!.id;
    for (let k = 0; k < 3; k++) {
      m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0' }) });
      m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
      m.submitActions(0, { [a.id]: { action: { type: 'shoot', weapon: rifle, target: b.id } } });
      m.submitActions(1, {});
    }
    const u = m.state.units[1];
    const body = Object.values(u.parts).filter((p) => p.kind === 'body');
    expect(body.every((p) => p.damage === 0)).toBe(true);
    expect(u.parts[shield].damage).toBeGreaterThan(0);
  });

  it('展開中選太快的機動會自動收起', () => {
    const st = wallSetup();
    const shield = st.units[1].equipment.find((e) => e.defId === 'riot_shield')!;
    shield.deployed = true;
    const m = new Match(4, st);
    m.submitMoves(0, { [st.units[0].id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [st.units[1].id]: plan({ maneuver: 'straight-S-2' }) });
    expect(m.state.units[1].equipment.find((e) => e.id === shield.id)!.deployed).toBe(false);
  });
});

describe('黑視中開火', () => {
  it('一般武器命中 −BLACKOUT_SHOT_PENALTY；導引武器只看機器，不受影響', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[1].id };
    const at = (weapon: string, blackout: boolean) =>
      hitChance({ attacker: { ...st.units[0], blackout }, attackerSkill: 3, weapon: EQUIPMENT[weapon], target: st.units[2], targetSkill: null, relSpeed: 3, shooterMelee: false })!.chance;
    expect(at('beam_rifle', false) - at('beam_rifle', true)).toBe(C.BLACKOUT_SHOT_PENALTY);
    expect(at('vls', true)).toBe(at('vls', false));
  });
});
