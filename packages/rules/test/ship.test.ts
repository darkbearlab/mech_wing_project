import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONTENT, useContent, validateContent, type ContentPack } from '../src/content';
import * as C from '../src/config';
import { hitChance } from '../src/combat';
import { damageUnit, type Ctx } from '../src/damage';
import { EQUIPMENT, type RosterEntry } from '../src/data';
import { resolveTurn } from '../src/resolve';
import { Rng } from '../src/rng';
import { barragePenalty, barrageStrength, shipPartMultiplier } from '../src/ship';
import type { GameEvent, GameState, MovePlan, PilotDef } from '../src/types';
import { validateMove } from '../src/unit';
import { sensorRange } from '../src/vision';
import { makeState as baseState, rifleX00 } from './helpers';

const makeState = (...a: Parameters<typeof baseState>): GameState => ({ ...baseState(...a), settings: { killScore: 0, decapitation: false, turnLimit: 99, deploy: 'fixed' } });
const of = <T extends GameEvent['type']>(events: GameEvent[], type: T) => events.filter((e): e is Extract<GameEvent, { type: T }> => e.type === type);

beforeEach(() => {
  const pack: ContentPack = structuredClone({ ...DEFAULT_CONTENT, version: 'test-ship' });
  const captain: PilotDef = { id: 'captain', name: '艦長', skill: 3, maxStress: 9, recovery: 2, abilities: [] };
  pack.pilots['captain'] = captain;
  pack.pilots['red'] = { id: 'red', name: 'red', skill: 5, maxStress: 9, recovery: 2, abilities: ['ship_killer'] };
  const gun = (id: string, arc: number, arcOffset?: number) => ({ id, name: id, kind: 'ranged' as const, mount: 'integrated' as const, weight: 0, durability: 0, damage: 6, shots: 1, mode: 'focused' as const, ranges: { 1: 0, 2: 5, 3: 5 }, arc, ...(arcOffset ? { arcOffset } : {}), tags: ['turret' as const] });
  pack.equipment['bow_gun'] = gun('bow_gun', 45);
  pack.equipment['port_gun'] = gun('port_gun', 60, -90);
  pack.equipment['stbd_gun'] = gun('stbd_gun', 60, 90);
  pack.chassis['SHIP'] = {
    id: 'SHIP',
    name: '測試艦',
    weightClass: 8,
    propellant: 30,
    baseThrust: 1,
    maxAccel: 1,
    power: 8,
    aim: 0,
    evasion: -20,
    crew: 'ship',
    closeCombat: false,
    radius: 2,
    sensorRange: 18,
    barrage: { range: 4, perTurret: 10, max: 40 },
    parts: {
      hull: { name: '艦體', role: 'core', weight: 6, durability: 25 },
      bridge: { name: '艦橋', role: 'sensor', weight: 1, durability: 2 },
      engine: { name: '引擎', role: 'propulsion', weight: 2, durability: 4 },
    },
    dial: ['hover-S-0', 'straight-S-1', 'straight-S-2', 'bank-L-1', 'bank-R-1'],
    builtIn: [
      { defId: 'bow_gun', host: 'hull' },
      { defId: 'port_gun', host: 'hull' },
      { defId: 'stbd_gun', host: 'hull' },
    ],
  } as never;
  useContent(pack);
});
afterEach(() => useContent(DEFAULT_CONTENT));

const ship = (pilot = 'captain'): RosterEntry => ({ chassis: 'SHIP', pilot, equipment: [] });
const hover = (extra: Partial<MovePlan> = {}): MovePlan => ({ maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false, ...extra });
const gunOf = (s: GameState, i: number, def: string) => s.units[i].equipment.find((e) => e.defId === def)!.id;

describe('戰艦', () => {
  it('資料檢查認得戰艦、砲塔與對艦特效', () => {
    const pack = structuredClone({ ...DEFAULT_CONTENT, version: 'x' });
    pack.pilots['red'] = { id: 'red', name: 'red', skill: 5, maxStress: 9, recovery: 2, abilities: ['ship_killer'] };
    pack.equipment['g'] = { id: 'g', name: 'g', kind: 'ranged', mount: 'integrated', weight: 0, durability: 0, damage: 6, shots: 1, ranges: { 2: 0 }, arc: 60, arcOffset: -90, tags: ['turret'] };
    expect(validateContent(pack)).toEqual([]);
  });

  it('原地轉身最多 45°', () => {
    const s = makeState([{ entry: ship(), owner: 0, x: 12, y: 6, facingDeg: 90 }]);
    s.units[0].momentum = 0;
    expect(validateMove(s.units[0], hover({ facingOffset: 90 }), false)).toHaveLength(1);
    expect(validateMove(s.units[0], hover({ facingOffset: 45 }), false)).toEqual([]);
  });

  it('齊射：每座砲塔各自照射界選目標，同一回合都開火；射界外打不到', () => {
    // 戰艦朝 +y（90°）：艦首是 +y，左舷（−90°）是 +x，右舷（+90°）是 −x
    const s = makeState([
      { entry: ship(), owner: 0, x: 12, y: 6, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 12, y: 13, facingDeg: -90 },
      { entry: rifleX00, owner: 1, x: 19, y: 6, facingDeg: 180 },
    ]);
    const [sh, ahead, port] = s.units;
    const act = { action: { type: 'none' as const }, salvo: { [gunOf(s, 0, 'bow_gun')]: ahead.id, [gunOf(s, 0, 'port_gun')]: port.id, [gunOf(s, 0, 'stbd_gun')]: port.id } };
    const r = resolveTurn(s, [{ [sh.id]: hover() }, { [ahead.id]: hover(), [port.id]: hover() }], [{ [sh.id]: act }, {}]);
    const shots = of(r.events, 'shot').filter((e) => e.attacker === sh.id);
    expect(shots.map((e) => e.target).sort()).toEqual([ahead.id, port.id].sort());
    expect(of(r.events, 'actionFail').some((e) => e.unit === sh.id && e.reason.includes('射界'))).toBe(true);
  });

  it('防禦彈幕：有敵機進來才生效，只扣打彈幕裡目標的命中（戰艦自己不受影響、艦尾沒有），艦橋被打掉就沒了', () => {
    const s = makeState([
      { entry: ship(), owner: 0, x: 12, y: 6, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 12, y: 11, facingDeg: -90 },
      { entry: rifleX00, owner: 0, x: 15, y: 8, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 12, y: 1.5, facingDeg: 90 },
    ]);
    const [sh, inFront, mate, behind] = s.units;
    expect(barrageStrength(sh)).toBe(30);
    expect(barragePenalty(s.units, inFront)).toBe(30);
    expect(barragePenalty(s.units, mate)).toBe(30); // 生效時友軍也在彈幕裡
    expect(barragePenalty(s.units, behind)).toBe(0); // 艦尾沒有彈幕
    expect(barragePenalty(s.units, sh)).toBe(0);
    // 沒有敵機在範圍內就不生效
    inFront.pos = { x: 12, y: 20 };
    expect(barragePenalty(s.units, mate)).toBe(0);
    inFront.pos = { x: 12, y: 11 };
    sh.parts.bridge.destroyed = true;
    expect(barrageStrength(sh)).toBe(0);
    // 艦橋被打掉：戰艦射擊命中大降
    const base = { attacker: sh, attackerSkill: 3, weapon: EQUIPMENT['bow_gun'], target: inFront, targetSkill: null, relSpeed: 2, shooterMelee: false } as const;
    sh.parts.bridge.destroyed = false;
    const ok = hitChance(base)!.chance;
    sh.parts.bridge.destroyed = true;
    expect(ok - hitChance(base)!.chance).toBe(C.SHIP_NO_BRIDGE_PENALTY);
  });

  it('防禦彈幕每回合有機會打傷彈幕裡的單位（友軍也會）', () => {
    let enemy = 0;
    let friend = 0;
    for (let seed = 1; seed <= 40; seed++) {
      const s = makeState(
        [
          { entry: ship(), owner: 0, x: 12, y: 6, facingDeg: 90 },
          { entry: rifleX00, owner: 1, x: 12, y: 11, facingDeg: -90 },
          { entry: rifleX00, owner: 0, x: 15, y: 8, facingDeg: 90 },
        ],
        seed,
      );
      const [sh, foe, mate] = s.units;
      const r = resolveTurn(s, [{ [sh.id]: hover(), [mate.id]: hover() }, { [foe.id]: hover() }]);
      enemy += of(r.events, 'barrage').filter((e) => e.unit === foe.id).length;
      friend += of(r.events, 'barrage').filter((e) => e.unit === mate.id).length;
    }
    expect(enemy).toBeGreaterThan(3);
    expect(friend).toBeGreaterThan(3);
  });

  it('引擎全毀時擲殉爆，大約一半直接擊沉', () => {
    let sunk = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const s = makeState([{ entry: ship(), owner: 0, x: 12, y: 6, facingDeg: 90 }], seed);
      const ctx: Ctx = { state: s, rng: new Rng(seed), events: [] };
      damageUnit(ctx, s.units[0], 4, 'focused', 'engine');
      if (s.units[0].status === 'destroyed') sunk++;
    }
    expect(sunk).toBeGreaterThan(70);
    expect(sunk).toBeLessThan(130);
  });

  it('超遠距離（R4）只有列出 ranges[4] 的武器打得到；戰艦的感測距離照機型', () => {
    const s = makeState([
      { entry: ship(), owner: 0, x: 12, y: 2.5, facingDeg: 90 },
      { entry: rifleX00, owner: 1, x: 12, y: 18, facingDeg: -90 },
    ]);
    const [sh, t] = s.units;
    const far = { ...EQUIPMENT['bow_gun'], ranges: { 2: 0, 3: 5, 4: 0 } };
    const base = { attacker: sh, attackerSkill: 3, target: t, targetSkill: null, relSpeed: 2, shooterMelee: false } as const;
    expect(hitChance({ ...base, weapon: far })!.band).toBe(4);
    expect(hitChance({ ...base, weapon: EQUIPMENT['bow_gun'] })).toBeNull();
    expect(sensorRange(sh)).toBe(18);
    expect(sensorRange(t)).toBe(C.SENSOR_RANGE);
  });

  it('命中部位看方位：從艦尾打引擎、貼近打艦橋，對艦特效再加重', () => {
    const s = makeState([{ entry: ship(), owner: 0, x: 12, y: 12, facingDeg: 90 }]);
    const sh = s.units[0];
    const engine = sh.parts.engine;
    const bridge = sh.parts.bridge;
    expect(shipPartMultiplier(sh, { x: 12, y: 2 }, false)(engine)).toBe(C.SHIP_REAR_ENGINE_MULT); // 艦尾（−y）
    expect(shipPartMultiplier(sh, { x: 12, y: 22 }, false)(engine)).toBe(1); // 艦首遠處
    expect(shipPartMultiplier(sh, { x: 12, y: 16 }, false)(bridge)).toBe(C.SHIP_CLOSE_BRIDGE_MULT); // 貼近
    expect(shipPartMultiplier(sh, { x: 12, y: 22 }, true)(bridge)).toBe(C.SHIP_WEAK_AIM_MULT);
    expect(shipPartMultiplier(sh, { x: 12, y: 22 }, false)(sh.parts.hull)).toBe(1);
  });
});
