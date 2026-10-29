import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { hitChance } from '../src/combat';
import type { RosterEntry } from '../src/data';
import { EQUIPMENT } from '../src/data';
import { Match } from '../src/match';
import { resolveActions } from '../src/resolve';
import { Rng } from '../src/rng';
import { buildingBlocks, generateCity, inFootprint, lineOfFire, supportAt, wallPenetration } from '../src/terrain';
import { damageUnit, type Ctx } from '../src/damage';
import { filterEvents } from '../src/visibility';
import { createGame, pickRosters } from '../src/setup';
import { DEFAULT_SETTINGS } from '../src/objectives';
import type { GameEvent, GameState, Obstacle } from '../src/types';
import { busyHands, validateAction, validateMove } from '../src/unit';
import { canSee } from '../src/vision';
import { makeState, plan, rifleX00, withFighter } from './helpers';
import { DEFAULT_CONTENT, useContent } from '../src/content';

const bld = (id: string, x: number, y: number, hx: number, hy: number, levels: number): Obstacle => ({ id, kind: 'building', x, y, hx, hy, levels, r: Math.hypot(hx, hy) });

function withCity(st: GameState, obstacles: Obstacle[]): GameState {
  st.obstacles = obstacles;
  return st;
}

/** 雙方都懸停，只有 A 開火 */
function fire(st: GameState, action: Parameters<Match['submitActions']>[1][string]): { m: Match; events: GameEvent[] } {
  const [a, b] = st.units;
  const m = new Match(7, st);
  m.submitMoves(0, { [a.id]: plan({ maneuver: 'hover-S-0' }) });
  m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
  m.submitActions(0, { [a.id]: action });
  m.submitActions(1, {});
  return { m, events: m.eventsFor(0) };
}

/** 只有 A 移動 */
function move(st: GameState, maneuver: string, climb = false): Match {
  const [a, b] = st.units;
  const m = new Match(7, st);
  m.submitMoves(0, { [a.id]: plan({ maneuver, climb }) });
  m.submitMoves(1, { [b.id]: plan({ maneuver: 'hover-S-0' }) });
  return m;
}

describe('建築：射擊線與視野', () => {
  const wall = bld('w', 10, 5, 0.5, 2, 2);

  it('建築擋在中間：打不到也看不到；站上比它高的樓頂就打得到', () => {
    expect(lineOfFire([wall], { x: 6, y: 5 }, { x: 14, y: 5 })).toBe('blocked');
    expect(canSee([wall], { x: 6, y: 5 }, 20, { x: 14, y: 5 })).toBe(false);
    // 視野是雙向的：從另一邊看也一樣
    expect(canSee([wall], { x: 14, y: 5 }, 20, { x: 6, y: 5 })).toBe(false);
    expect(lineOfFire([wall], { x: 6, y: 5 }, { x: 14, y: 5 }, 4, 0)).toBe('clear');
    expect(canSee([wall], { x: 14, y: 5 }, 20, { x: 6, y: 5 }, 1, 0, 4)).toBe(true);
  });

  it('從牆角露出一部分：半掩護，命中下降', () => {
    // 目標站在牆角旁邊，只有半個身子露出來
    const cover = lineOfFire([wall], { x: 6, y: 5 }, { x: 11.2, y: 7.7 });
    expect(cover).toBe('cover');
    expect(buildingBlocks([wall], { x: 6, y: 5 }, { x: 11.2, y: 7.7 })).toBe('some');
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 6, y: 5, facingDeg: 30 },
      { entry: rifleX00, owner: 1, x: 11.2, y: 7.7, facingDeg: 180 },
    ]);
    const [a, b] = st.units;
    const base = { attacker: a, attackerSkill: 3, weapon: EQUIPMENT.beam_rifle, target: b, targetSkill: null, relSpeed: null, shooterMelee: false } as const;
    expect(hitChance({ ...base, cover: 'clear' })!.chance - hitChance({ ...base, cover })!.chance).toBe(C.BUILDING_COVER_PENALTY);
  });

  it('站在樓頂中間往下打貼著牆腳的目標：被自己的樓頂擋住', () => {
    const roof = bld('r', 10, 5, 2, 2, 3);
    expect(lineOfFire([roof], { x: 10, y: 5 }, { x: 12.6, y: 5 }, 3, 0)).toBe('blocked');
    // 走到樓頂邊緣就打得到
    expect(lineOfFire([roof], { x: 11.8, y: 5 }, { x: 13.5, y: 5 }, 3, 0)).not.toBe('blocked');
  });
});

describe('高打低', () => {
  it('每高一層命中 +HIGH_GROUND_HIT（最多 HIGH_GROUND_MAX_LEVELS 層），往上打沒有加成', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 10, y: 5, facingDeg: 180 },
    ]);
    const [a, b] = st.units;
    const at = (za: number, zb: number) => hitChance({ attacker: { ...a, z: za }, attackerSkill: 3, weapon: EQUIPMENT.beam_rifle, target: { ...b, z: zb }, targetSkill: null, relSpeed: null, shooterMelee: false, rules: 3 })!;
    expect(at(2, 0).chance - at(0, 0).chance).toBe(2 * C.HIGH_GROUND_HIT);
    expect(at(4, 0).high).toBe(C.HIGH_GROUND_MAX_LEVELS);
    expect(at(0, 2).chance).toBe(at(0, 0).chance);
  });

  it('高出 HIGH_GROUND_DAMAGE_FROM 層以上命中：每發傷害 +HIGH_GROUND_DAMAGE_PCT', () => {
    const run = (z: number, rules = 3) => {
      const st = makeState([
        { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 },
        { entry: rifleX00, owner: 1, x: 9, y: 5, facingDeg: 180 },
      ], 3);
      st.rules = rules;
      st.units[0].z = z;
      if (z) st.obstacles = [bld('r', 5, 5, 1, 1, z)];
      const { events } = fire(st, { action: { type: 'shoot', weapon: st.units[0].equipment[0].id, target: st.units[1].id } });
      return events.filter((e): e is Extract<GameEvent, { type: 'damage' }> => e.type === 'damage').reduce((n, e) => n + e.amount, 0);
    };
    // 同一個種子：命中與否一樣，高處多出傷害
    const low = run(0);
    const high = run(C.HIGH_GROUND_DAMAGE_FROM);
    expect(run(C.HIGH_GROUND_DAMAGE_FROM - 1)).toBe(low);
    expect(low).toBeGreaterThan(0);
    expect(high).toBe(Math.round(low * (1 + C.HIGH_GROUND_DAMAGE_PCT)));
    // 第 5 版起沒有傷害加成
    expect(run(C.HIGH_GROUND_DAMAGE_FROM, 5)).toBe(run(0, 5));
  });

  it('第 5 版起：高打低只有固定 +HIGH_GROUND_HIT；目標高 HIGH_TARGET_COVER_FROM 層以上算半掩護', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 10, y: 5, facingDeg: 180 },
    ]);
    const [a, b] = st.units;
    const at = (za: number, zb: number) => hitChance({ attacker: { ...a, z: za }, attackerSkill: 0, weapon: EQUIPMENT.beam_rifle, target: { ...b, z: zb }, targetSkill: null, relSpeed: 3, shooterMelee: false, rules: 5 })!.chance;
    expect(at(1, 0) - at(0, 0)).toBe(C.HIGH_GROUND_HIT);
    expect(at(3, 0)).toBe(at(1, 0));
    expect(at(0, 1)).toBe(at(0, 0));
    expect(at(0, 0) - at(0, 2)).toBe(C.BUILDING_COVER_PENALTY);
  });
});

describe('移動：撞牆、攀升、落下', () => {
  const unitAt = (x: number, z = 0) => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 20, y: 20, facingDeg: 180 },
    ]);
    if (z) st.units[0].z = z;
    return st;
  };

  it('沒攀升：撞上建築就停下', () => {
    const st = withCity(unitAt(2), [bld('b', 6, 5, 1, 2, 1)]);
    const m = move(st, 'straight-S-3');
    const u = m.state.units[0];
    expect(u.pos.x).toBeLessThan(4.6);
    expect(u.z ?? 0).toBe(0);
    expect(m.eventsFor(0).some((e) => e.type === 'obstacle' && e.obstacle === 'b')).toBe(true);
  });

  it('攀升：撞上 CLIMB_LEVELS 層以內的建築就爬上樓頂、花推進劑', () => {
    const st = withCity(unitAt(2), [bld('b', 6, 5, 1, 2, 2)]);
    const before = st.units[0].propellant;
    const m = move(st, 'straight-S-3', true);
    const u = m.state.units[0];
    expect(u.z).toBe(2);
    expect(u.pos.x).toBeCloseTo(5, 3);
    expect(before - u.propellant).toBeGreaterThanOrEqual(C.CLIMB_PROPELLANT);
    expect(m.eventsFor(0).some((e) => e.type === 'elevate' && e.how === 'climb')).toBe(true);
  });

  it('太高爬不上去：一樣撞牆停下', () => {
    const st = withCity(unitAt(2), [bld('b', 6, 5, 1, 2, C.CLIMB_LEVELS + 1)]);
    const m = move(st, 'straight-S-3', true);
    expect(m.state.units[0].z ?? 0).toBe(0);
    expect(m.state.units[0].pos.x).toBeLessThan(4.6);
  });

  it('速度太快不能攀升', () => {
    const st = unitAt(2);
    const fast = plan({ maneuver: `straight-S-${C.CLIMB_MAX_SPEED + 1}`, climb: true });
    expect(validateMove(st.units[0], fast, false).join()).toContain('才能攀升');
    expect(validateMove(st.units[0], plan({ maneuver: `straight-S-${C.CLIMB_MAX_SPEED}`, climb: true }), false)).toEqual([]);
  });

  it('走出樓頂邊緣就掉下去（不受速度限制、不用攀升）', () => {
    const st = withCity(unitAt(5, 2), [bld('b', 5, 5, 1, 2, 2)]);
    const m = move(st, 'straight-S-3');
    const u = m.state.units[0];
    expect(u.z ?? 0).toBe(0);
    expect(u.pos.x).toBeCloseTo(8, 3);
    expect(m.eventsFor(0).some((e) => e.type === 'elevate' && e.how === 'drop')).toBe(true);
  });

  it('樓頂和街上的機體不會接觸', () => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x: 4.8, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 6.4, y: 5, facingDeg: 180 },
    ]);
    st.units[0].z = 1;
    st.obstacles = [bld('b', 4, 5, 1, 2, 1)];
    const m = new Match(7, st);
    m.submitMoves(0, { [st.units[0].id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [st.units[1].id]: plan({ maneuver: 'hover-S-0' }) });
    expect(m.eventsFor(0).some((e) => e.type === 'contact')).toBe(false);
  });
});

describe('行動：多武器一起開火、同側換武器', () => {
  const x04: RosterEntry = { chassis: 'X-04', pilot: 'veteran', equipment: [['shoulder_cannon', 'mount', 'torso'], ['beam_rifle', 'right'], ['shield', 'left']] };
  const racked: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['machine_gun', 'left'], ['bazooka', 'stowed', 'larm']] };
  const pair = (entry: RosterEntry) =>
    makeState([
      { entry, owner: 0, x: 5, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 10, y: 5, facingDeg: 180 },
    ]);
  const id = (st: GameState, defId: string) => st.units[0].equipment.find((e) => e.defId === defId)!.id;

  it('勾選的武器全部對同一個目標開火', () => {
    const st = pair(x04);
    const { events } = fire(st, { action: { type: 'shoot', weapon: id(st, 'beam_rifle'), target: st.units[1].id, also: [id(st, 'shoulder_cannon')] } });
    const shots = events.filter((e): e is Extract<GameEvent, { type: 'shot' }> => e.type === 'shot' && e.attacker === st.units[0].id);
    expect(shots.map((e) => e.weapon).sort()).toEqual(['beam_rifle', 'shoulder_cannon']);
  });

  it('左手和左邊武器架換武器，右手照常開火；換武器那隻手不能開火', () => {
    const st = pair(racked);
    const swaps = { left: id(st, 'bazooka') };
    expect(validateAction(st.units[0], { action: { type: 'none' }, swaps })).toEqual([]);
    expect([...busyHands(st.units[0], { swaps })]).toEqual(['left']);
    const { m, events } = fire(st, { action: { type: 'shoot', weapon: id(st, 'beam_rifle'), target: st.units[1].id, also: [id(st, 'machine_gun')] }, swaps });
    const shots = events.filter((e) => e.type === 'shot' && e.attacker === st.units[0].id);
    expect(shots.map((e) => (e as { weapon: string }).weapon)).toEqual(['beam_rifle']);
    expect(events.some((e) => e.type === 'actionFail' && e.reason.includes('換武器'))).toBe(true);
    const u = m.state.units[0];
    expect(u.equipment.find((e) => e.defId === 'bazooka')!.location).toBe('left');
    expect(u.equipment.find((e) => e.defId === 'machine_gun')!.location).toBe('stowed');
  });

  it('兩隻手不能換成同一件裝備；結算時也只換第一隻手', () => {
    const blade: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['machine_gun', 'left'], ['beam_saber', 'stowed']] };
    const st = pair(blade);
    const swaps = { right: id(st, 'beam_saber'), left: id(st, 'beam_saber') };
    expect(validateAction(st.units[0], { action: { type: 'none' }, swaps }).join()).toContain('同一件');
    // 規則結算端的保險：就算指令沒被擋下，也只換第一隻手
    const m = new Match(7, st);
    m.submitMoves(0, { [st.units[0].id]: plan({ maneuver: 'hover-S-0' }) });
    m.submitMoves(1, { [st.units[1].id]: plan({ maneuver: 'hover-S-0' }) });
    const u = resolveActions(m.state, [{ [st.units[0].id]: { action: { type: 'none' }, swaps } }, {}]).state.units[0];
    expect(u.equipment.find((e) => e.defId === 'beam_saber')!.location).toBe('right');
    expect(u.equipment.find((e) => e.defId === 'machine_gun')!.location).toBe('left');
  });

  it('另一側武器架上的武器拿不到', () => {
    const st = pair(racked);
    expect(validateAction(st.units[0], { action: { type: 'none' }, swaps: { right: id(st, 'bazooka') } }).join()).toContain('另一側');
  });
});

describe('城市地圖', () => {
  it('以中心點對稱、建築不互相重疊、部署區空著', () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const city = generateCity(new Rng(seed));
      expect(city.length).toBeGreaterThan(6);
      for (const o of city) {
        expect(city.some((m) => Math.abs(m.x - (C.MAP_SIZE - o.x)) < 1e-9 && Math.abs(m.y - (C.MAP_SIZE - o.y)) < 1e-9 && m.levels === o.levels)).toBe(true);
        expect(o.y - o.hy!).toBeGreaterThan(C.DEPLOY_CLEAR - 1.5);
        expect(o.y + o.hy!).toBeLessThan(C.MAP_SIZE - C.DEPLOY_CLEAR + 1.5);
        for (const p of city) if (p !== o) expect(inFootprint(p, o) && inFootprint(o, p)).toBe(false);
      }
      expect(supportAt(city, { x: 12, y: 1 })).toBe(0);
    }
  });
});

describe('試玩回饋的修正', () => {
  const at = (x: number, y = 5, z = 0, facingDeg = 0) => {
    const st = makeState([
      { entry: rifleX00, owner: 0, x, y, facingDeg },
      { entry: rifleX00, owner: 1, x: 20, y: 20, facingDeg: 180 },
    ]);
    if (z) st.units[0].z = z;
    return st;
  };

  it('撞牆後彈開、機頭轉成沿著牆，下回合不會卡在牆上', () => {
    const st = withCity(at(2), [bld('b', 6, 5, 1, 2, 3)]);
    const m = move(st, 'straight-S-3');
    const u = m.state.units[0];
    expect(wallPenetration(st.obstacles[0], u.pos, 0.5)).toBeLessThan(-0.2);
    const next = new Match(8, m.state);
    next.submitMoves(0, { [u.id]: plan({ maneuver: 'straight-S-2' }) });
    next.submitMoves(1, { [m.state.units[1].id]: plan({ maneuver: 'hover-S-0' }) });
    expect(next.eventsFor(0).some((e) => e.type === 'obstacle')).toBe(false);
  });

  it('攀升是跳躍：從樓頂跳過街道，撞上對面高 2 層以內的樓就爬上去', () => {
    // 樓頂 2 層 → 隔 1.6 格街道 → 4 層樓
    const st = withCity(at(4.5, 5, 2), [bld('a', 4, 5, 1, 2, 2), bld('b', 7.6, 5, 1, 2, 4)]);
    const m = move(st, 'straight-S-3', true);
    expect(m.state.units[0].z).toBe(4);
    expect(m.eventsFor(0).some((e) => e.type === 'obstacle')).toBe(false);
  });

  it('沒攀升走出樓頂一樣當場落下', () => {
    const st = withCity(at(4.5, 5, 2), [bld('a', 4, 5, 1, 2, 2), bld('b', 7.6, 5, 1, 2, 4)]);
    const m = move(st, 'straight-S-3');
    expect(m.state.units[0].z ?? 0).toBe(0);
    expect(m.eventsFor(0).some((e) => e.type === 'obstacle')).toBe(true);
  });

  it('武器被打穿：多出來的傷害打進拿著它的手臂', () => {
    const st = at(5);
    const u = st.units[0];
    const rifle = u.equipment.find((e) => e.defId === 'beam_rifle')!;
    const ctx: Ctx = { state: st, rng: new Rng(1), events: [] };
    damageUnit(ctx, u, EQUIPMENT.beam_rifle.durability + 2, 'focused', rifle.id);
    expect(u.parts[rifle.id].destroyed).toBe(true);
    expect(u.parts.rarm.damage).toBe(2);
  });

  it('城市地圖：戰機在 FLIGHT_LEVEL 層飛，不會落下', () => {
    withFighter();
    const roster = [{ chassis: 'CF-01', pilot: 'veteran', equipment: [] }, ...pickRosters(1)[0].slice(1)] as RosterEntry[];
    const st = createGame(5, [roster, pickRosters(1)[1]], { ...DEFAULT_SETTINGS, terrain: 'city', environment: 'gravity' });
    const jet = st.units.find((u) => u.chassisId === 'CF-01')!;
    expect(jet.z).toBe(C.FLIGHT_LEVEL);
    useContent(DEFAULT_CONTENT);
  });

  it('戰爭迷霧：看不到的敵機爬樓、落下的事件不送給對手', () => {
    const st = at(5);
    st.visible = [[], []];
    const ev = filterEvents([{ type: 'elevate', t: 0.5, unit: st.units[1].id, z: 2, how: 'climb' }], st, 0);
    expect(ev).toEqual([]);
  });

  it('纏鬥中的機體沒給移動指令也可以', () => {
    const st = at(5);
    st.units[1].pos = { x: 6, y: 5 };
    st.grapples.push({ a: st.units[0].id, b: st.units[1].id, advantage: null });
    const m = new Match(9, st);
    expect(m.submitMoves(0, {})).toEqual([]);
  });

  it('錨鉤：攀升多爬 1 層、速度上限 +2', () => {
    const hooked: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right'], ['grapnel', 'mount', 'legs']] };
    const st = makeState([
      { entry: hooked, owner: 0, x: 2, y: 5, facingDeg: 0 },
      { entry: rifleX00, owner: 1, x: 20, y: 20, facingDeg: 180 },
    ]);
    st.obstacles = [bld('b', 6, 5, 1, 2, C.CLIMB_LEVELS + 1)];
    expect(validateMove(st.units[0], plan({ maneuver: `straight-S-${C.CLIMB_MAX_SPEED + 1}`, climb: true }), false)).toEqual([]);
    const m = move(st, 'straight-S-3', true);
    expect(m.state.units[0].z).toBe(C.CLIMB_LEVELS + 1);
  });
});
