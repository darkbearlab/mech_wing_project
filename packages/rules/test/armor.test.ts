import { describe, expect, it } from 'vitest';
import * as C from '../src/config';
import { DEFAULT_CONTENT, scaleContent } from '../src/content';
import { CHASSIS, EQUIPMENT } from '../src/data';
import { damageUnit, typeMultiplier, typed, type Ctx } from '../src/damage';
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
