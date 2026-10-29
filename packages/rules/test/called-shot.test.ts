import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEFAULT_CONTENT, useContent, type ContentPack } from '../src/content';
import { damageUnit, dealtBy, type Ctx } from '../src/damage';
import { hitChance } from '../src/combat';
import { EQUIPMENT } from '../src/data';
import * as C from '../src/config';
import { Rng } from '../src/rng';
import { makeState, rifleX00 } from './helpers';

beforeEach(() => {
  const pack: ContentPack = structuredClone({ ...DEFAULT_CONTENT, version: 'test-called' });
  pack.pilots['sniper'] = { id: 'sniper', name: 'sniper', skill: 5, maxStress: 9, recovery: 1, abilities: ['called_shot'] };
  useContent(pack);
});
afterEach(() => useContent(DEFAULT_CONTENT));

/** 讓 by 對一台很硬的機體打 n 點分散傷害，回傳打到軀幹的比例 */
function coreRate(aimed: boolean, n = 2000): number {
  const st = makeState([
    { entry: { ...rifleX00, pilot: 'sniper' }, owner: 0, x: 5, y: 5, facingDeg: 0 },
    { entry: rifleX00, owner: 1, x: 8, y: 5, facingDeg: 180 },
  ]);
  const [by, target] = st.units;
  for (const p of Object.values(target.parts)) p.durability = 1e9;
  const ctx: Ctx = { state: st, rng: new Rng(7), events: [] };
  dealtBy(ctx, by, () => damageUnit(ctx, target, n, 'scattered'), aimed);
  return target.parts.torso.damage / n;
}

it('瞄準要害：射擊與近戰生效，撞擊（沒辦法瞄準）不生效', () => {
  const aimed = coreRate(true);
  const rammed = coreRate(false);
  expect(aimed).toBeGreaterThan(rammed + 0.1);
  // 撞擊時和沒有瞄準要害的駕駛一樣
  const st = makeState([{ entry: rifleX00, owner: 1, x: 8, y: 5, facingDeg: 180 }]);
  const t = st.units[0];
  const total = Object.values(t.parts).filter((p) => p.kind === 'body' || !p.destroyed).reduce((n, p) => n + p.weight, 0);
  expect(rammed).toBeCloseTo(t.parts.torso.weight / total, 1);
});

it('估計命中率（不知道對方駕駛）和實際只差對方駕駛的閃避', () => {
  const st = makeState([
    { entry: { ...rifleX00, pilot: 'sniper' }, owner: 0, x: 5, y: 5, facingDeg: 0 },
    { entry: rifleX00, owner: 1, x: 9, y: 5, facingDeg: 180 },
  ]);
  const [a, t] = st.units;
  const base = { attacker: a, attackerSkill: 5, weapon: EQUIPMENT['beam_rifle'], target: t, relSpeed: 2, shooterMelee: false, rules: 3 } as const;
  const est = hitChance({ ...base, targetSkill: null })!.chance;
  const real = hitChance({ ...base, targetSkill: 3 })!.chance;
  expect(est - real).toBe(3 * C.EVADE_PER_SKILL);
});
