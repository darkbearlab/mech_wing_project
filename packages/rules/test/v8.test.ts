import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { hitChance } from '../src/combat';
import { lineupProblems } from '../src/objectives';
import { Match } from '../src/match';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { updateSight } from '../src/visibility';
import { makeState, plan, rifleX00 } from './helpers';

// 規則第 8 版：區域砲擊、定時引信、爆風打腳、近炸、隕石群炸散、匿蹤塗層
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
const mortarX04: RosterEntry = { chassis: 'X-04', pilot: 'recruit', equipment: [['mortar', 'mount', 'torso']] };
const bazookaX00: RosterEntry = { chassis: 'X-00', pilot: 'recruit', equipment: [['bazooka', 'right']] };
const state = (entries: { entry: RosterEntry; owner: 0 | 1; x: number; y: number }[], rules = 8): GameState => ({
  ...makeState(entries.map((e) => ({ ...e, facingDeg: e.owner === 0 ? 0 : 180 }))),
  rules,
});
const gear = (st: GameState, i: number, defId: string) => st.units[i].equipment.find((e) => e.defId === defId)!.id;

describe('區域砲擊與定時引信（第 8 版）', () => {
  it('迫擊砲朝地點砲擊：不用目標與標定，下回合散落爆炸', () => {
    const st = state([
      { entry: mortarX04, owner: 0, x: 3, y: 10 },
      { entry: rifleX00, owner: 1, x: 12, y: 10 },
    ]);
    const m = new Match(1, st);
    const ev1 = turn(m, [{ [st.units[0].id]: { action: { type: 'barrage', weapon: gear(st, 0, 'mortar'), at: { x: 12, y: 10 } } } }, {}]);
    expect(ev1.some((e) => e.type === 'launch')).toBe(true);
    const ev2 = turn(m, [{}, {}]);
    expect(ev2.some((e) => e.type === 'blast' && e.kind === 'barrage')).toBe(true);
  });

  it('火箭砲定時引信：當下引爆，傷害大多打在腳上', () => {
    let legsHit = 0;
    for (let seed = 1; seed <= 10; seed++) {
      const st: GameState = { ...state([{ entry: bazookaX00, owner: 0, x: 3, y: 10 }, { entry: rifleX00, owner: 1, x: 8, y: 10 }]), rngState: seed };
      const m = new Match(seed, st);
      const ev = turn(m, [{ [st.units[0].id]: { action: { type: 'airburst', weapon: gear(st, 0, 'bazooka'), at: { x: 8, y: 10 } } } }, {}]);
      expect(ev.some((e) => e.type === 'blast' && e.kind === 'airburst')).toBe(true);
      legsHit += ev.filter((e) => e.type === 'damage' && e.unit === st.units[1].id && e.part === 'legs').reduce((n, e) => n + (e.type === 'damage' ? e.amount : 0), 0);
    }
    expect(legsHit).toBeGreaterThan(0);
  });

  it('第 7 版以前沒有這兩種射擊', () => {
    const st = state([{ entry: bazookaX00, owner: 0, x: 3, y: 10 }, { entry: rifleX00, owner: 1, x: 8, y: 10 }], 7);
    const m = new Match(1, st);
    const ev = turn(m, [{ [st.units[0].id]: { action: { type: 'airburst', weapon: gear(st, 0, 'bazooka'), at: { x: 8, y: 10 } } } }, {}]);
    expect(ev.some((e) => e.type === 'actionFail')).toBe(true);
  });
});

describe('隕石群炸散（第 8 版）', () => {
  it(`化學能爆風落在群裡扣 FIELD_BLAST_DAMAGE，扣光變稀薄碎石`, () => {
    const st = state([
      { entry: bazookaX00, owner: 0, x: 3, y: 10 },
      { entry: rifleX00, owner: 1, x: 20, y: 20 },
    ]);
    const f: Obstacle = { id: 'f', kind: 'field', x: 8, y: 10, r: 2.5 };
    st.obstacles = [f];
    const m = new Match(1, st);
    st.units[0].equipment.find((e) => e.defId === 'bazooka')!.ammo = 99;
    const need = Math.ceil(C.FIELD_HP / C.FIELD_BLAST_DAMAGE);
    let thin = false;
    for (let i = 0; i < need + 2 && !thin; i++) {
      const ev = turn(m, [{ [st.units[0].id]: { action: { type: 'airburst', weapon: gear(st, 0, 'bazooka'), at: { x: 8, y: 10 } } } }, {}]);
      thin = ev.some((e) => e.type === 'fieldThin');
    }
    expect(thin).toBe(true);
    expect(m.state.obstacles[0].thin).toBe(true);
  });
});

describe('近炸武器與匿蹤塗層（第 8 版）', () => {
  it('近炸武器命中 +PROXIMITY_HIT_BONUS', () => {
    const st = state([{ entry: rifleX00, owner: 0, x: 3, y: 10 }, { entry: rifleX00, owner: 1, x: 7, y: 10 }]);
    const [a, t] = st.units;
    const c = (w: string, rules: number) => hitChance({ attacker: a, attackerSkill: 0, weapon: EQUIPMENT[w], target: t, targetSkill: null, relSpeed: 3, shooterMelee: false, rules })!.chance;
    expect(c('flak_gun', 8) - c('machine_gun', 8)).toBe(C.PROXIMITY_HIT_BONUS);
    expect(c('flak_gun', 7)).toBe(c('machine_gun', 7));
  });

  it('匿蹤塗層：STEALTH_SPOT_RANGE 外看不到；只有 X-09 能裝', () => {
    const ghost: RosterEntry = { chassis: 'X-09', pilot: 'recruit', equipment: [['flak_gun', 'right'], ['stealth_coat', 'mount', 'pack']] };
    expect(lineupProblems([ghost], 'expanded', { decapitation: false })).toEqual([]);
    expect(lineupProblems([{ chassis: 'X-07', pilot: 'recruit', equipment: [['stealth_coat', 'mount', 'pack']] }], 'expanded', { decapitation: false }).join()).toContain('不能裝');
    const st = state([{ entry: rifleX00, owner: 0, x: 3, y: 10 }, { entry: ghost, owner: 1, x: 3 + C.STEALTH_SPOT_RANGE + 4, y: 10 }]);
    updateSight(st);
    expect(st.visible[0]).not.toContain(st.units[1].id);
    st.rules = 7;
    updateSight(st);
    expect(st.visible[0]).toContain(st.units[1].id);
  });
});

describe('標定會暴露自己（第 9 版）', () => {
  const scout: RosterEntry = { chassis: 'X-07', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['designator', 'mount', 'head']] };
  const run = (rules: number) => {
    // 標定機在 14 格外、隔著一棟高樓：平常敵方看不到它
    const st = state([
      { entry: scout, owner: 0, x: 3, y: 10 },
      { entry: rifleX00, owner: 1, x: 16, y: 10 },
    ], rules);
    st.obstacles = [{ id: 'w', kind: 'building', x: 9, y: 13, r: 1.5, hx: 0.5, hy: 1, levels: 9 }];
    updateSight(st);
    const m = new Match(1, st);
    turn(m, [{ [st.units[0].id]: { action: { type: 'mark', weapon: gear(st, 0, 'designator') } } }, {}]);
    return m.state;
  };
  it('標定成功：到下一回合結束前敵方看得到標定機', () => {
    const s9 = run(9);
    expect(s9.units[1].mark).toBeDefined();
    expect(s9.units[0].markExposedUntil).toBe(2);
    expect(s9.visible[1]).toContain(s9.units[0].id);
    const s8 = run(8);
    expect(s8.visible[1]).not.toContain(s8.units[0].id);
  });
});
