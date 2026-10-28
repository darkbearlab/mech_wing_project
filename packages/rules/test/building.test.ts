import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { BUILDING_TYPE_MULT, buildingHitChance, damageBuilding } from '../src/demolition';
import { resolveTurn } from '../src/resolve';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { availableManeuvers, validateMove } from '../src/unit';
import { makeState, plan, rifleX00 } from './helpers';

const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });
const bazooka: RosterEntry = { chassis: 'X-02', pilot: 'veteran', equipment: [['bazooka', 'right']] };
const of = <T extends GameEvent['type']>(es: GameEvent[], t: T) => es.filter((e): e is Extract<GameEvent, { type: T }> => e.type === t);

/** A0 火箭砲在建築西邊；B0 站在 1 層建築的樓頂 */
function setup(): GameState {
  const st = makeState([
    { entry: bazooka, owner: 0, x: 6, y: 10, facingDeg: 0 },
    { entry: rifleX00, owner: 1, x: 10, y: 10, facingDeg: 180 },
  ]);
  st.obstacles = [bld('b0', 10, 10, 1.5, 1.5, 1)];
  st.units[1].z = 1;
  return st;
}

describe('破壞建築', () => {
  it('屬性倍率：化學能 ×2、動能 ×1、能量 ×0.5；打光一層就少一層，打平變成瓦礫', () => {
    const obs = [bld('b1', 10, 10, 1, 1, 2)];
    const o = obs[0];
    expect(damageBuilding(obs, o, 50, 'energy').amount).toBe(50 * BUILDING_TYPE_MULT.energy);
    expect(o.levels).toBe(2);
    expect(o.hp).toBe(C.BUILDING_LEVEL_HP - 25);
    const r = damageBuilding(obs, o, C.BUILDING_LEVEL_HP / 2, 'chemical');
    expect(r.lost).toBe(1);
    expect(o.levels).toBe(1);
    const last = damageBuilding(obs, o, C.BUILDING_LEVEL_HP, 'kinetic');
    expect(last.collapsed).toBe(true);
    expect(obs.map((x) => x.kind)).toEqual(['field']);
  });

  it('直射武器才打得到；被別的建築擋住就打不到', () => {
    const st = setup();
    const [a] = st.units;
    const o = st.obstacles[0];
    expect(buildingHitChance(a, 3, EQUIPMENT.bazooka, o, st.obstacles, 0, false)).not.toBeNull();
    expect(buildingHitChance(a, 3, EQUIPMENT.mortar, o, st.obstacles, 0, false)).toBeNull();
    st.obstacles.push(bld('wall', 7.5, 10, 0.3, 3, 3));
    expect(buildingHitChance(a, 3, EQUIPMENT.bazooka, o, st.obstacles, 0, false)).toBeNull();
  });

  it('打塌樓頂那層：上面的機體掉下來、腳受傷；彈藥照發數扣', () => {
    let st = setup();
    const roofLegs = st.units[1].parts.legs.damage;
    let fell = false;
    for (let k = 0; k < 4 && st.obstacles.some((o) => o.id === 'b0'); k++) {
      st.rngState = 100 + k;
      const [a, b] = st.units;
      const r = resolveTurn(st, [{ [a.id]: plan({ maneuver: 'hover-S-0' }) }, { [b.id]: plan({ maneuver: 'hover-S-0' }) }], [{ [a.id]: { action: { type: 'shoot', weapon: a.equipment[0].id, target: 'b0' } } }, {}]);
      expect(of(r.events, 'buildingShot').length).toBe(1);
      fell ||= of(r.events, 'elevate').some((e) => e.unit === b.id && e.how === 'drop');
      st = r.state;
    }
    expect(st.obstacles.some((o) => o.id === 'b0')).toBe(false);
    expect(st.obstacles.some((o) => o.id === 'rubble-b0')).toBe(true);
    expect(fell).toBe(true);
    expect(st.units[1].z ?? 0).toBe(0);
    expect(st.units[1].parts.legs.damage).toBeGreaterThan(roofLegs);
    expect(st.units[0].equipment[0].ammo).toBeLessThan(EQUIPMENT.bazooka.ammo!);
  });

  it('塌一層時下面那層可能跟著塌，可以一路塌到底', () => {
    const obs = [bld('b2', 10, 10, 1, 1, 4)];
    const o = obs[0];
    // 擲骰都低於 COLLAPSE_CHAIN：一路塌到底
    const r = damageBuilding(obs, o, C.BUILDING_LEVEL_HP, 'kinetic', () => 0);
    expect(r).toMatchObject({ lost: 4, chain: 3, collapsed: true });
    const obs2 = [bld('b3', 10, 10, 1, 1, 4)];
    expect(damageBuilding(obs2, obs2[0], C.BUILDING_LEVEL_HP, 'kinetic', () => 0.99)).toMatchObject({ lost: 1, chain: 0 });
    expect(obs2[0].levels).toBe(3);
  });
});

describe('重力圈裡腳斷了', () => {
  const broken = (grounded: boolean) => {
    const st = makeState([{ entry: rifleX00, owner: 0, x: 10, y: 10, facingDeg: 0 }]);
    const u = st.units[0];
    if (grounded) u.grounded = true;
    u.momentum = 2;
    u.parts.legs.destroyed = true;
    return u;
  };

  it('不能移動也不能轉向，只能原地懸停（動能直接歸零）', () => {
    const u = broken(true);
    expect(availableManeuvers(u).map((m) => m.id)).toEqual(['hover-S-0']);
    expect(validateMove(u, plan({ maneuver: 'hover-S-0' }), false)).toEqual([]);
    expect(validateMove(u, plan({ maneuver: 'hover-S-0', facingOffset: 90 }), false).some((e) => e.includes('不能轉向'))).toBe(true);
    expect(validateMove(u, plan({ maneuver: 'straight-S-2' }), false).length).toBeGreaterThan(0);
  });

  it('宇宙裡腳斷了還飄得動', () => {
    const u = broken(false);
    expect(availableManeuvers(u).length).toBeGreaterThan(1);
  });
});
