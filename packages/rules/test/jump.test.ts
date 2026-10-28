import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { hitChance } from '../src/combat';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { jumpCost } from '../src/jump';
import { DEFAULT_SETTINGS } from '../src/objectives';
import { resolveMovement } from '../src/resolve';
import { validateMove } from '../src/unit';
import type { GameState, Obstacle } from '../src/types';
import { makeState, plan } from './helpers';

const jumper: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['jump_jet', 'mount', 'pack']] };
const heavy: RosterEntry = { chassis: 'X-02', pilot: 'veteran', equipment: [['machine_gun', 'right'], ['jump_jet', 'mount', 'pack']] };
const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });

function world(environment: 'space' | 'gravity', entry = jumper): GameState {
  const st = makeState([
    { entry, owner: 0, x: 5, y: 10, facingDeg: 0 },
    { entry: jumper, owner: 1, x: 15, y: 10, facingDeg: 180 },
  ]);
  st.settings = { ...DEFAULT_SETTINGS, environment };
  for (const u of st.units) u.momentum = 0;
  return st;
}

const hover = plan({ maneuver: 'hover-S-0' });

describe('垂直噴射器', () => {
  it('宇宙：先滑完動能再跳，面向任選，動能保留成新面向的方向', () => {
    const st = world('space');
    const u = st.units[0];
    u.momentum = 2;
    const p = plan({ maneuver: 'hover-S-0', jump: { to: { x: 7, y: 11 }, facing: 90 } });
    expect(validateMove(u, p, false, st)).toEqual([]);
    const r = resolveMovement(st, [{ [u.id]: p }, { [st.units[1].id]: hover }]);
    const a = r.state.units[0];
    expect(a.pos.x).toBeCloseTo(7, 5);
    expect(a.pos.y).toBeCloseTo(11, 5);
    expect(a.facing).toBeCloseTo(Math.PI / 2, 5);
    expect(a.momentum).toBe(2);
    expect(a.propellant).toBe(u.propellant - C.JUMP_PROPELLANT);
    expect(r.state.turnInfo?.jumped).toBeUndefined();
  });

  it('重力圈：推進劑三倍、落地動能歸零、跳得上 2 層樓頂，落地那回合射擊命中下降', () => {
    const st = world('gravity');
    st.obstacles = [bld('b1', 5, 11.3, 1, 0.5, 2)];
    const u = st.units[0];
    const p = plan({ maneuver: 'hover-S-0', jump: { to: { x: 5, y: 11 }, facing: 0 } });
    expect(validateMove(u, p, false, st)).toEqual([]);
    const r = resolveMovement(st, [{ [u.id]: p }, { [st.units[1].id]: hover }]);
    const a = r.state.units[0];
    expect(a.z).toBe(2);
    expect(a.momentum).toBe(0);
    expect(a.propellant).toBe(u.propellant - C.JUMP_PROPELLANT * C.JUMP_GRAVITY_MULT);
    expect(r.state.turnInfo?.jumped).toEqual([a.id]);
    const base = { attacker: a, attackerSkill: 3, weapon: EQUIPMENT.beam_rifle, target: r.state.units[1], targetSkill: null, relSpeed: 0, shooterMelee: false };
    expect(hitChance(base)!.chance - hitChance({ ...base, landing: true })!.chance).toBe(C.JUMP_LANDING_PENALTY);
  });

  it('跳不上 3 層樓、落點太遠、推進劑不夠都不行；重型機的推進劑更多', () => {
    const st = world('gravity');
    st.obstacles = [bld('b1', 5, 11.3, 1, 0.5, 3)];
    const u = st.units[0];
    expect(validateMove(u, plan({ maneuver: 'hover-S-0', jump: { to: { x: 5, y: 11 }, facing: 0 } }), false, st).join()).toContain('落不下去');
    expect(validateMove(u, plan({ maneuver: 'hover-S-0', jump: { to: { x: 7, y: 10 }, facing: 0 } }), false, st).join()).toContain('格以內');
    const h = world('gravity', heavy).units[0];
    expect(jumpCost(h, 'gravity')).toBe(C.JUMP_PROPELLANT_HEAVY * C.JUMP_GRAVITY_MULT);
    h.propellant = jumpCost(h, 'gravity') - 1;
    expect(validateMove(h, plan({ maneuver: 'hover-S-0', jump: { to: { x: 4, y: 10 }, facing: 180 } }), false, st).join()).toContain('推進劑不足');
  });
});
