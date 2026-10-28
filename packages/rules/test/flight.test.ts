import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { hitChance } from '../src/combat';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { Match } from '../src/match';
import { coverOf, coverPenalty } from '../src/terrain';
import { dialOf, moveSpeed, validateMove } from '../src/unit';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { makeState, plan, rifleX00 } from './helpers';

const scout: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['designator', 'mount', 'head']] };
const gunner: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['mortar', 'mount', 'torso'], ['atgm', 'mount', 'torso']] };
const smoker: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['smoke_discharger', 'mount', 'torso']] };
const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });

/** 砲手 A0、偵察機 A1，帶煙幕的敵機 B 在 9 格外 */
function setup(): GameState {
  return makeState([
    { entry: gunner, owner: 0, x: 5, y: 10, facingDeg: 0 },
    { entry: scout, owner: 0, x: 5, y: 13, facingDeg: 0 },
    { entry: smoker, owner: 1, x: 14, y: 10, facingDeg: 180 },
  ]);
}

const eq = (st: GameState, unit: number, defId: string) => st.units[unit].equipment.find((e) => e.defId === defId)!.id;

/** 一整回合：moves 是各機的機動（沒寫就懸停），extra 是額外的移動選項 */
function turn(m: Match, actions: Parameters<Match['submitActions']>[0] extends never ? never : Record<string, unknown> = {}, extra: Record<string, Record<string, unknown>> = {}): GameEvent[] {
  const mine = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, plan({ maneuver: 'hover-S-0', ...(extra[u.id] ?? {}) })]));
  expect(m.submitMoves(0, mine(0))).toEqual([]);
  expect(m.submitMoves(1, mine(1))).toEqual([]);
  if (m.phase === 'pursuit') {
    m.submitPursuits(0, {});
    m.submitPursuits(1, {});
  }
  const own = (p: number) => Object.fromEntries(Object.entries(actions).filter(([id]) => m.state.units.find((u) => u.id === id)?.owner === p)) as never;
  m.submitActions(0, own(0));
  m.submitActions(1, own(1));
  return m.turnResolvedEvents;
}

describe('飛行時間', () => {
  it('迫擊砲這回合只發射，下一回合移動結束後才落下', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[1].id };
    const m = new Match(3, st);
    const [g, , t] = m.state.units;
    const first = turn(m, { [g.id]: { action: { type: 'shoot', weapon: eq(m.state, 0, 'mortar'), target: t.id } } });
    expect(first.some((e) => e.type === 'launch')).toBe(true);
    expect(first.some((e) => e.type === 'shot')).toBe(false);
    expect(m.state.inbound).toHaveLength(1);
    expect(m.viewFor(1).state.inbound).toHaveLength(1);
    const second = turn(m);
    expect(second.some((e) => e.type === 'shot' && e.inbound)).toBe(true);
    expect(m.state.inbound ?? []).toHaveLength(0);
  });

  it('來襲的那回合放煙幕：金屬粉讓標定失效，迫擊砲失去導引落空', () => {
    const st = setup();
    st.units[2].mark = { by: st.units[1].id };
    const m = new Match(3, st);
    const [g, , t] = m.state.units;
    turn(m, { [g.id]: { action: { type: 'shoot', weapon: eq(m.state, 0, 'mortar'), target: t.id } } });
    const ev = turn(m, {}, { [t.id]: { smoke: eq(m.state, 2, 'smoke_discharger') } });
    expect(ev.some((e) => e.type === 'inboundLost' && e.target === t.id)).toBe(true);
    expect(ev.some((e) => e.type === 'shot' && e.inbound)).toBe(false);
    expect(m.state.units[2].mark).toBeUndefined();
  });

  it('反戰車飛彈不用標定；下一回合發射端還看得到就命中', () => {
    const m = new Match(5, setup());
    const [g, , t] = m.state.units;
    turn(m, { [g.id]: { action: { type: 'shoot', weapon: eq(m.state, 0, 'atgm'), target: t.id } } });
    expect(m.state.inbound?.[0].defId).toBe('atgm');
    const ev = turn(m);
    expect(ev.some((e) => e.type === 'shot' && e.inbound && e.weapon === 'atgm')).toBe(true);
  });

  it('反戰車飛彈：發射端和目標中間隔著煙霧或被擋住就落空', () => {
    const m = new Match(5, setup());
    const [g, , t] = m.state.units;
    turn(m, { [g.id]: { action: { type: 'shoot', weapon: eq(m.state, 0, 'atgm'), target: t.id } } });
    const ev = turn(m, {}, { [t.id]: { smoke: eq(m.state, 2, 'smoke_discharger') } });
    expect(ev.find((e) => e.type === 'inboundLost')).toMatchObject({ reason: expect.stringContaining('煙霧') });

    const m2 = new Match(5, setup());
    turn(m2, { [g.id]: { action: { type: 'shoot', weapon: eq(m2.state, 0, 'atgm'), target: t.id } } });
    m2.state.obstacles.push({ id: 'rk', kind: 'rock', x: 9.5, y: 10, r: 1 });
    const ev2 = turn(m2);
    expect(ev2.find((e) => e.type === 'inboundLost')).toMatchObject({ reason: expect.stringContaining('擋住') });
  });
});

describe('煙幕彈發射器', () => {
  it('速度太快不能放；一個發射器只能用一次', () => {
    const st = setup();
    const u = st.units[2];
    const id = eq(st, 2, 'smoke_discharger');
    const fast = dialOf(u).find((x) => moveSpeed({ maneuver: x }) > C.SCREEN_MAX_SPEED)!;
    expect(validateMove(u, plan({ maneuver: fast, smoke: id }), false).join()).toContain('速度');
    expect(validateMove(u, plan({ maneuver: 'hover-S-0', smoke: id }), false)).toEqual([]);
    const m = new Match(3, st);
    turn(m, {}, { [u.id]: { smoke: id } });
    expect(validateMove(m.state.units[2], plan({ maneuver: 'hover-S-0', smoke: id }), false).join()).toContain('用過');
  });

  it('煙幕在原地、留到回合結束；煙裡的機體標定不到也不能被鎖定', () => {
    const st = setup();
    const m = new Match(3, st);
    const [g, s, t] = m.state.units;
    t.mark = { by: s.id };
    g.lockOn = t.id;
    const at = { ...t.pos };
    // 移動完、動作前：煙還在，標定和鎖定都沒了
    m.submitMoves(0, { [g.id]: plan({ maneuver: 'hover-S-0' }), [s.id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [t.id]: plan({ maneuver: 'hover-S-0', smoke: eq(m.state, 2, 'smoke_discharger') }) });
    const smoke = m.state.obstacles.find((o) => o.kind === 'smoke')!;
    expect({ x: smoke.x, y: smoke.y }).toEqual(at);
    expect(m.state.units[2].mark).toBeUndefined();
    expect(m.state.units[0].lockOn).toBeNull();
    if (m.phase === 'pursuit') {
      m.submitPursuits(0, {});
      m.submitPursuits(1, {});
    }
    m.submitActions(0, { [s.id]: { action: { type: 'mark', weapon: eq(m.state, 1, 'designator') } } });
    m.submitActions(1, {});
    expect(m.turnResolvedEvents.some((e) => e.type === 'mark')).toBe(false);
    expect(m.state.obstacles.some((o) => o.kind === 'smoke')).toBe(false);
  });
});

describe('掩體疊加', () => {
  const base = () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 12, y: 5, facingDeg: 180 },
    ]);
    return { st, h: (obstacles: Obstacle[]) => hitChance({ attacker: st.units[0], attackerSkill: 3, weapon: EQUIPMENT.beam_rifle, target: st.units[1], targetSkill: null, relSpeed: 0, shooterMelee: false, cover: coverOf(obstacles, st.units[0].pos, st.units[1].pos) })!.chance };
  };
  const smoke: Obstacle = { id: 's', kind: 'smoke', x: 9, y: 5, r: 1 };
  const field: Obstacle = { id: 'f', kind: 'field', x: 8, y: 5, r: 1 };
  // 只擋住目標下半身的矮牆
  const wall = bld('w', 11, 5.2, 0.15, 0.5, 1);

  it('遮蔽類只取最重的一種、硬掩護另外加', () => {
    const { st, h } = base();
    const clear = h([]);
    expect(coverOf([wall], st.units[0].pos, st.units[1].pos).building).toBe(true);
    expect(clear - h([smoke, field])).toBe(C.SMOKE_SHOT_PENALTY);
    expect(clear - h([field, wall])).toBe(C.FIELD_SHOT_PENALTY + C.BUILDING_COVER_PENALTY);
    expect(clear - h([smoke, wall])).toBe(C.SMOKE_SHOT_PENALTY + C.BUILDING_COVER_PENALTY);
    expect(coverPenalty({ blocked: false, smoke: true, field: false, building: false, barrier: true })).toBe(C.SMOKE_SHOT_PENALTY + C.BUILDING_COVER_PENALTY);
  });
});
