import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import type { RosterEntry } from '../src/data';
import { damageUnit, type Ctx } from '../src/damage';
import { Match } from '../src/match';
import { Rng } from '../src/rng';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { makeState, plan, rifleX00 } from './helpers';

const fencer: RosterEntry = { chassis: 'X-01', pilot: 'veteran', equipment: [['beam_saber', 'right']] };
const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });

/** A 懸停（姿態可選），B 懸停；A 突進 B */
function lunge(st: GameState, stance: 'melee' | 'shoot' = 'melee'): { m: Match; events: GameEvent[] } {
  const [a, b] = st.units;
  const m = new Match(5, st);
  m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0', stance }) });
  m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
  m.submitActions(0, { [a.id]: { action: { type: 'lunge', target: b.id } } });
  m.submitActions(1, {});
  return { m, events: m.eventsFor(0) };
}

const fail = (events: GameEvent[]) => events.find((e): e is Extract<GameEvent, { type: 'actionFail' }> => e.type === 'actionFail')?.reason;

describe('突進', () => {
  it('1.5 格內：衝到目標身邊砍一刀，推進劑 −1', () => {
    const st = makeState([
      { entry: fencer, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 7.4, y: 5, facingDeg: 180 },
    ]);
    const fuel = st.units[0].propellant;
    const { m, events } = lunge(st);
    expect(fail(events)).toBeUndefined();
    expect(events.some((e) => e.type === 'lunge' && e.jump === 0)).toBe(true);
    expect(events.some((e) => e.type === 'clash')).toBe(true);
    const a = m.state.units[0];
    expect(a.pos.x).toBeGreaterThan(5.5);
    expect(a.propellant).toBe(fuel - C.LUNGE_PROPELLANT);
  });

  it('太遠、不是近戰姿態、在側面、比自己高：都不能突進', () => {
    const at = (x: number, facingDeg = 0) =>
      makeState([
        { entry: fencer, owner: 0, x: 5, y: 5, facingDeg },
        { entry: rifleX00, owner: 1, x, y: 5, facingDeg: 180 },
      ]);
    expect(fail(lunge(at(8.5)).events)).toContain('太遠');
    expect(fail(lunge(at(7.4), 'shoot').events)).toContain('近戰姿態');
    expect(fail(lunge(at(7.4, 90)).events)).toContain('正面');
    const high = at(7.4);
    high.obstacles = [bld('b', 9, 5, 1.5, 2, 1)];
    high.units[1].pos = { x: 8, y: 5 };
    high.units[1].z = 1;
    expect(fail(lunge(high).events)).toContain('攀升');
  });

  it('跳劈：從樓頂跳到街上，對方不能反擊，自己落到地面', () => {
    const st = makeState([
      { entry: fencer, owner: 0, x: 6.2, y: 5, facingDeg: 0 },
      { entry: fencer, owner: 1, x: 8.8, y: 5, facingDeg: 180 },
    ]);
    st.obstacles = [bld('roof', 5, 5, 2, 2, 2)];
    st.units[0].z = 2;
    const { m, events } = lunge(st);
    expect(fail(events)).toBeUndefined();
    expect(events.some((e) => e.type === 'lunge' && e.jump === 2)).toBe(true);
    const clash = events.find((e): e is Extract<GameEvent, { type: 'clash' }> => e.type === 'clash')!;
    expect(clash.defense).not.toBe('blade');
    expect(m.state.units[0].z ?? 0).toBe(0);
  });

  it('頂部攻擊表：腿部很難被打中', () => {
    const st = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const count = (top: boolean) => {
      const rng = new Rng(11);
      let legs = 0;
      for (let i = 0; i < 2000; i++) {
        const u = structuredClone(st.units[0]);
        const ctx: Ctx = { state: { ...st, units: [u] }, rng, events: [], topAttack: top };
        damageUnit(ctx, u, 1, 'focused');
        if (u.parts.legs.damage > 0) legs++;
      }
      return legs;
    };
    expect(count(true)).toBeLessThan(count(false) * 0.4);
  });
});
