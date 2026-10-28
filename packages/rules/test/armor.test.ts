import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { DEFAULT_CONTENT, scaleContent } from '../src/content';
import { CHASSIS, EQUIPMENT } from '../src/data';
import { damageUnit, directionWeight, typeMultiplier, typed, type Ctx } from '../src/damage';
import { Rng } from '../src/rng';
import { makeState, rifleX00 } from './helpers';

describe('傷害屬性與裝甲', () => {
  it('三角相剋：複合擋動能怕化學、反射擋能量怕動能、陶瓷擋化學怕能量', () => {
    expect(typeMultiplier('composite', 'kinetic')).toBe(0.75);
    expect(typeMultiplier('composite', 'chemical')).toBe(1.25);
    expect(typeMultiplier('composite', 'energy')).toBe(1);
    expect(typeMultiplier('reflective', 'energy')).toBe(0.75);
    expect(typeMultiplier('reflective', 'kinetic')).toBe(1.25);
    expect(typeMultiplier('ceramic', 'chemical')).toBe(0.75);
    expect(typeMultiplier('ceramic', 'energy')).toBe(1.25);
    expect(typeMultiplier(undefined, 'energy')).toBe(1);
  });

  it('每個機型都有一種裝甲；武器都有屬性', () => {
    for (const c of Object.values(CHASSIS)) expect(c.armorType, c.id).toBeDefined();
    for (const e of Object.values(EQUIPMENT)) if (e.kind === 'ranged' || e.kind === 'melee') expect(e.damageType, e.id).toBeDefined();
  });

  it('打在機體上照機型的裝甲加減傷；打在武器上不剋也不被剋', () => {
    // X-00 是複合裝甲
    const st = makeState([{ entry: rifleX00, owner: 0, x: 5, y: 5, facingDeg: 0 }]);
    const u = st.units[0];
    const ctx: Ctx = { state: st, rng: new Rng(1), events: [] };
    typed(ctx, 'chemical', () => damageUnit(ctx, u, 20, 'focused', 'torso'));
    expect(u.parts.torso.damage).toBe(25);
    typed(ctx, 'kinetic', () => damageUnit(ctx, u, 20, 'focused', 'legs'));
    expect(u.parts.legs.damage).toBe(15);
    const rifle = u.equipment.find((e) => e.defId === 'beam_rifle')!;
    typed(ctx, 'chemical', () => damageUnit(ctx, u, 10, 'focused', rifle.id));
    expect(u.parts[rifle.id].damage).toBe(10);
    expect(ctx.events.filter((e) => e.type === 'damage').map((e) => (e.type === 'damage' ? e.typed : null))).toEqual(['weak', 'resist', undefined]);
  });

  it('盾牌有自己的裝甲種類', () => {
    expect(EQUIPMENT.shield.armorType).toBe('composite');
    expect(EQUIPMENT.riot_shield.armorType).toBe('reflective');
  });

  it('舊格式的資料包（沒寫刻度）載入時耐久與傷害放大到 DAMAGE_SCALE', () => {
    const old = structuredClone(DEFAULT_CONTENT);
    delete old.damageScale;
    old.equipment.beam_rifle.damage = 3;
    old.chassis['X-00'].parts.torso.durability = 10;
    const p = scaleContent(old);
    expect(p.equipment.beam_rifle.damage).toBe(3 * C.DAMAGE_SCALE);
    expect(p.chassis['X-00'].parts.torso.durability).toBe(10 * C.DAMAGE_SCALE);
    expect(scaleContent(DEFAULT_CONTENT)).toBe(DEFAULT_CONTENT);
  });
});

describe('攻擊方向的部位權重', () => {
  const unit = () => makeState([{ entry: rifleX00, owner: 0, x: 10, y: 10, facingDeg: 0 }]).units[0];
  const weightOf = (u: ReturnType<typeof unit>, from: { x: number; y: number }, part: string) => directionWeight(u, from)(u.parts[part]);

  it('正面打不太到背包、多打軀幹；背後容易打到背包；側面多打靠近的那隻手', () => {
    const u = unit();
    // 朝 +x：前方是 x 大，背後是 x 小；y 大是順時針那一側（右手邊）
    expect(weightOf(u, { x: 15, y: 10 }, 'pack')).toBe(C.HIT_DIRECTION_WEIGHT.front.propulsion);
    expect(weightOf(u, { x: 15, y: 10 }, 'torso')).toBe(C.HIT_DIRECTION_WEIGHT.front.core);
    expect(weightOf(u, { x: 5, y: 10 }, 'pack')).toBe(C.HIT_DIRECTION_WEIGHT.back.propulsion);
    expect(weightOf(u, { x: 10, y: 15 }, 'rarm')).toBe(C.HIT_DIRECTION_WEIGHT.side.near);
    expect(weightOf(u, { x: 10, y: 15 }, 'larm')).toBe(C.HIT_DIRECTION_WEIGHT.side.far);
    // 手上拿的武器照那隻手
    const rifle = u.equipment.find((e) => e.location === 'right')!;
    expect(weightOf(u, { x: 10, y: 15 }, rifle.id)).toBe(C.HIT_DIRECTION_WEIGHT.side.near);
  });

  it('從正面打過來的傷害打折；背後、從上方打下來的不打折', () => {
    const hit = (from: { x: number; y: number }, top = false) => {
      const u = unit();
      const ctx: Ctx = { state: { units: [u] } as never, rng: new Rng(1), events: [], from, topAttack: top };
      damageUnit(ctx, u, 30, 'focused', 'torso');
      return u.parts.torso.damage;
    };
    expect(hit({ x: 15, y: 10 })).toBe(Math.round(30 * C.FRONT_DAMAGE_MULT));
    expect(hit({ x: 5, y: 10 })).toBe(30);
    expect(hit({ x: 15, y: 10 }, true)).toBe(30);
  });
});
