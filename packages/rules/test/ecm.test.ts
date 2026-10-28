import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { hitChance } from '../src/combat';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { jammed } from '../src/ecm';
import { Match } from '../src/match';
import { updateSight, viewState } from '../src/visibility';
import type { GameEvent, GameState, UnitState } from '../src/types';
import { validateAction } from '../src/unit';
import { makeState, plan, rifleX00 } from './helpers';

const scout: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['designator', 'mount', 'head']] };
const jammer: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['ecm_pod', 'mount', 'pack']] };
const hunter: RosterEntry = { chassis: 'X-04', pilot: 'recruit', equipment: [['arm_missile', 'mount', 'torso']] };
const sapper: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['mine_layer', 'mount', 'legs'], ['barricade_kit', 'mount', 'pack']] };
const gear = (u: UnitState, defId: string) => u.equipment.find((e) => e.defId === defId)!.id;

function turn(m: Match, actions: [Record<string, unknown>, Record<string, unknown>] = [{}, {}], moves: Record<string, string> = {}) {
  const mv = (p: number) => Object.fromEntries(m.state.units.filter((u) => u.owner === p && u.status === 'active').map((u) => [u.id, plan({ maneuver: moves[u.id] ?? 'hover-S-0' })]));
  const before = m.resolvedCount;
  expect([...m.submitMoves(0, mv(0)), ...m.submitMoves(1, mv(1))]).toEqual([]);
  const events: GameEvent[] = [...m.turnResolvedEvents];
  // 有人咬住別人的背後：追擊都放棄
  if (m.phase === 'pursuit') {
    m.submitPursuits(0, {});
    m.submitPursuits(1, {});
    events.push(...m.turnResolvedEvents);
  }
  expect([...m.submitActions(0, actions[0] as never), ...m.submitActions(1, actions[1] as never)]).toEqual([]);
  expect(m.resolvedCount).toBeGreaterThan(before);
  return [...events, ...m.turnResolvedEvents];
}

describe('電子干擾', () => {
  /** A0 偵察機朝 +x；B0 干擾機、B1 在它旁邊、B2 在干擾範圍外 */
  const setup = (): GameState =>
    makeState([
      { entry: scout, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: jammer, owner: 1, x: 12, y: 10, facingDeg: 180 },
      { entry: rifleX00, owner: 1, x: 12, y: 12, facingDeg: 180 },
      { entry: rifleX00, owner: 1, x: 12, y: 10 - C.ECM_RADIUS - 1.5, facingDeg: 180 },
    ]);

  it('干擾範圍內的機體（含干擾機自己）標定不到；範圍外的照樣標定', () => {
    const m = new Match(1, setup());
    const [a, j, near, far] = m.state.units;
    expect(jammed(m.state.units, j)).toBe(true);
    expect(jammed(m.state.units, near)).toBe(true);
    expect(jammed(m.state.units, far)).toBe(false);
    turn(m, [{ [a.id]: { action: { type: 'mark', weapon: gear(a, 'designator') } } }, {}]);
    expect(m.state.units.filter((u) => u.mark).map((u) => u.id)).toEqual([far.id]);
  });

  it('干擾範圍內的我方標定不了別人', () => {
    const st = setup();
    // 偵察機換到 B 方干擾機旁邊、自己這一方：A 方標定機站進 A 方自己的干擾範圍
    st.units[1].owner = 0;
    st.units[1].pos = { x: 5, y: 12 };
    const m = new Match(1, st);
    const a = m.state.units[0];
    const events = turn(m, [{ [a.id]: { action: { type: 'mark', weapon: gear(a, 'designator') } } }, {}]);
    expect(events.some((e) => e.type === 'actionFail' && e.reason.includes('電子干擾'))).toBe(true);
    expect(m.state.units.some((u) => u.mark)).toBe(false);
  });

  it('已被標定的機體進入干擾範圍，標定就失效；干擾器壞了就沒有效果', () => {
    const st = setup();
    const [a, j, , far] = st.units;
    far.mark = { by: a.id };
    updateSight(st);
    expect(far.mark).toBeDefined();
    far.pos = { x: 12, y: 8 };
    updateSight(st);
    expect(far.mark).toBeUndefined();
    st.units[1].parts[gear(j, 'ecm_pod')].destroyed = true;
    expect(jammed(st.units, far)).toBe(false);
  });
});

describe('反輻射飛彈', () => {
  const setup = (): GameState =>
    makeState([
      { entry: hunter, owner: 0, x: 5, y: 10, facingDeg: 0 },
      { entry: jammer, owner: 1, x: 12, y: 10, facingDeg: 180 },
      { entry: rifleX00, owner: 1, x: 12, y: 13, facingDeg: 180 },
    ]);
  const chance = (st: GameState, t: number) =>
    hitChance({ attacker: st.units[0], attackerSkill: 0, weapon: EQUIPMENT.arm_missile, target: st.units[t], targetSkill: null, relSpeed: 3, shooterMelee: false })?.chance ?? null;

  it('只打開著干擾的機體，不用標定、命中極高；干擾器壞了就打不了', () => {
    const st = setup();
    expect(chance(st, 2)).toBeNull();
    const c = chance(st, 1)!;
    const rifle = hitChance({ attacker: st.units[0], attackerSkill: 0, weapon: EQUIPMENT.beam_rifle, target: st.units[1], targetSkill: null, relSpeed: 3, shooterMelee: false })!.chance;
    expect(c).toBeGreaterThan(rifle + C.ARM_HIT_BONUS / 2);
    st.units[1].parts[gear(st.units[1], 'ecm_pod')].destroyed = true;
    expect(chance(st, 1)).toBeNull();
    // 看不到的目標一樣打不了：射擊線被擋住
    st.units[1].parts[gear(st.units[1], 'ecm_pod')].destroyed = false;
    expect(hitChance({ attacker: st.units[0], attackerSkill: 0, weapon: EQUIPMENT.arm_missile, target: st.units[1], targetSkill: null, relSpeed: 3, shooterMelee: false, cover: 'blocked' })).toBeNull();
  });

  it('打中就打在干擾器上', () => {
    let hits = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const st = setup();
      st.rngState = seed * 7919;
      const m = new Match(seed, st);
      const [a, j] = m.state.units;
      const events = turn(m, [{ [a.id]: { action: { type: 'shoot', weapon: gear(a, 'arm_missile'), target: j.id } } }, {}]);
      const shot = events.find((e) => e.type === 'shot');
      if (shot?.type !== 'shot' || !shot.hits || shot.blocked) continue;
      hits++;
      expect(events.some((e) => e.type === 'damage' && e.unit === j.id && e.part === gear(j, 'ecm_pod'))).toBe(true);
    }
    expect(hits).toBeGreaterThan(0);
  });
});

describe('工兵', () => {
  const setup = (): GameState =>
    makeState([
      { entry: sapper, owner: 0, x: 10, y: 10, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 14.5, y: 10, facingDeg: 180 },
      { entry: rifleX00, owner: 0, x: 10, y: 7.4, facingDeg: 0 },
    ]);

  it('埋地雷：對手看不到（靠近才看得到），敵方地面機體經過就引爆、打在腳上；自己人不會踩到', () => {
    const m = new Match(2, setup());
    const [s, b] = m.state.units;
    expect(validateAction(s, { action: { type: 'mine', weapon: gear(s, 'mine_layer'), at: { x: 12.3, y: 10 } } })).toEqual([]);
    const laid = turn(m, [{ [s.id]: { action: { type: 'mine', weapon: gear(s, 'mine_layer'), at: { x: 12.3, y: 10 } } } }, {}]);
    expect(laid.some((e) => e.type === 'mine')).toBe(true);
    expect(m.state.mines?.length).toBe(1);
    expect(m.state.units[0].equipment.find((e) => e.defId === 'mine_layer')!.ammo).toBe(EQUIPMENT.mine_layer.ammo! - 1);
    expect(viewState(m.state, 0).mines.length).toBe(1);
    expect(viewState(m.state, 1).mines.length).toBe(0);
    expect(m.eventsFor(1).some((e) => e.type === 'mine')).toBe(false);
    // B 往 -x 走過地雷
    const legsBefore = m.state.units[1].parts.legs.damage;
    const events = turn(m, [{}, {}], { [b.id]: 'straight-S-2' });
    expect(events.some((e) => e.type === 'mineBlast' && e.unit === b.id)).toBe(true);
    expect(m.state.units[1].parts.legs.damage).toBeGreaterThan(legsBefore);
    expect(m.state.mines?.length ?? 0).toBe(0);
  });

  it('架路障：在自己前方擋出 1 層高的矮牆；壓到機體就架不了', () => {
    const m = new Match(2, setup());
    const s = m.state.units[0];
    turn(m, [{ [s.id]: { action: { type: 'barricade', weapon: gear(s, 'barricade_kit'), at: { x: 12, y: 10 } } } }, {}]);
    const wall = m.state.obstacles.find((o) => o.id.startsWith('bar'))!;
    expect(wall).toBeDefined();
    expect(wall.levels).toBe(1);
    // 自己往 +x 看：路障沿 y 擺，橫擋在路上
    expect(wall.hy!).toBeGreaterThan(wall.hx!);
    const events = turn(m, [{ [s.id]: { action: { type: 'barricade', weapon: gear(s, 'barricade_kit'), at: { x: 10, y: 7.6 } } } }, {}]);
    expect(events.some((e) => e.type === 'actionFail' && e.reason.includes('機體'))).toBe(true);
  });
});
