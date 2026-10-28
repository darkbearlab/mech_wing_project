import { describe, expect, it } from 'vitest';
import { MAP_SIZE } from '../src/config';
import { DEFAULT_CONTENT, scaleContent } from '../src/content';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { DEFAULT_SETTINGS, supplyPoint } from '../src/objectives';
import { resolveTurn } from '../src/resolve';
import type { GameEvent, GameState } from '../src/types';
import { makeState, plan } from './helpers';

const gunner: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['machine_gun', 'right']] };
const hover = () => plan({ maneuver: 'hover-S-0' });
const of = <T extends GameEvent['type']>(es: GameEvent[], t: T) => es.filter((e): e is Extract<GameEvent, { type: T }> => e.type === t);

describe('彈藥以發計', () => {
  const setup = (): GameState =>
    makeState([
      { entry: gunner, owner: 0, x: 10, y: 10, facingDeg: 0 },
      { entry: gunner, owner: 1, x: 13, y: 10, facingDeg: 180 },
    ]);
  const fire = (st: GameState) => {
    const [a, b] = st.units;
    return resolveTurn(st, [{ [a.id]: hover() }, { [b.id]: hover() }], [{ [a.id]: { action: { type: 'shoot', weapon: a.equipment[0].id, target: b.id } } }, {}]);
  };

  it('每次射擊扣掉真正打出去的發數；剩的不夠一輪就只打剩下的', () => {
    const st = setup();
    expect(st.units[0].equipment[0].ammo).toBe(EQUIPMENT.machine_gun.ammo);
    const r = fire(st);
    expect(r.state.units[0].equipment[0].ammo).toBe(EQUIPMENT.machine_gun.ammo! - EQUIPMENT.machine_gun.shots!);
    r.state.units[0].equipment[0].ammo = 2;
    const r2 = fire(r.state);
    expect(of(r2.events, 'shot')[0].shots).toBe(2);
    expect(r2.state.units[0].equipment[0].ammo).toBe(0);
    const r3 = fire(r2.state);
    expect(of(r3.events, 'shot')).toEqual([]);
    expect(of(r3.events, 'actionFail').some((e) => e.reason.includes('彈藥耗盡'))).toBe(true);
  });

  it('舊格式的資料包（彈藥以次計）載入時乘上每次的發數', () => {
    const old = structuredClone(DEFAULT_CONTENT);
    delete old.ammoRounds;
    old.equipment.machine_gun.ammo = 8;
    expect(scaleContent(old).equipment.machine_gun.ammo).toBe(8 * EQUIPMENT.machine_gun.shots!);
    expect(scaleContent(DEFAULT_CONTENT)).toBe(DEFAULT_CONTENT);
  });
});

describe('補給點', () => {
  const setup = (supply = true): GameState => {
    const p = supplyPoint(0);
    const st = makeState([
      { entry: gunner, owner: 0, x: p.x, y: p.y, facingDeg: 90 },
      { entry: gunner, owner: 1, x: MAP_SIZE / 2, y: MAP_SIZE - 3, facingDeg: -90 },
    ]);
    st.settings = { ...DEFAULT_SETTINGS, ...st.settings, supply };
    const u = st.units[0];
    u.momentum = 0;
    u.equipment[0].ammo = 3;
    u.propellant = 2;
    return st;
  };
  const supply = (st: GameState, maneuver = 'hover-S-0') => {
    const [a, b] = st.units;
    return resolveTurn(st, [{ [a.id]: plan({ maneuver }) }, { [b.id]: hover() }], [{ [a.id]: { action: { type: 'resupply' } } }, {}]);
  };

  it('停在自己的補給點上用掉動作，彈藥與推進劑補滿', () => {
    const r = supply(setup());
    const u = r.state.units[0];
    expect(of(r.events, 'resupply').length).toBe(1);
    expect(u.equipment[0].ammo).toBe(EQUIPMENT.machine_gun.ammo);
    expect(u.propellant).toBe(u.maxPropellant);
  });

  it('沒開補給點、不在補給點上、沒停下來都不行', () => {
    expect(of(supply(setup(false)).events, 'resupply')).toEqual([]);
    const away = setup();
    away.units[0].pos = { x: away.units[0].pos.x + 4, y: away.units[0].pos.y };
    expect(of(supply(away).events, 'actionFail').some((e) => e.reason.includes('補給點'))).toBe(true);
    const moving = setup();
    moving.units[0].momentum = 1;
    expect(of(supply(moving, 'straight-S-1').events, 'actionFail').some((e) => e.reason.includes('停下來'))).toBe(true);
  });
});
