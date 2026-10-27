// 一擊脫離時的近戰對決：雙方擲骰池比成功數，贏越多傷害越大。
// 擲了幾顆骰會公開，對手可以從骰數推測駕駛等級（「交鋒後才看得出來」）。
import * as C from './config';
import { contactAngle, inShieldArc } from './combat';
import { addStress, damageUnit, dealtBy, type Ctx } from './damage';
import { EQUIPMENT } from './data';
import type { UnitState } from './types';
import { chassisOf, pilotOf, readyMelee } from './unit';

export type ClashDefense = 'blade' | 'shield' | 'dodge' | 'none';

/** 這台機體在對決中的骰數（防守方沒拿近戰武器時另外處理） */
export function meleePool(u: UnitState, charging: boolean, sidePenalty: boolean): number {
  const weapon = readyMelee(u);
  let n = C.MELEE_BASE_DICE + pilotOf(u).skill;
  if (charging) n += C.MELEE_CHARGE_DIE;
  if (weapon) n += EQUIPMENT[weapon.defId].meleeDice ?? 0;
  if (sidePenalty) n -= C.MELEE_SIDE_PENALTY;
  if (u.blackout || u.stress >= u.maxStress) n -= C.MELEE_SLUGGISH_PENALTY;
  return Math.max(1, n);
}

/** 回傳 true 表示承受衝擊的防守方把攻擊方拖住了（贏或平手） */
export function meleeClash(ctx: Ctx, att: UnitState, def: UnitState, t: number, defCharging: boolean, defBracing = false): boolean {
  const attWeapon = readyMelee(att);
  if (!attWeapon) return false;
  const angle = contactAngle(def, att.pos);
  const defWeapon = readyMelee(def);
  const roll = (n: number) => Array.from({ length: n }, () => ctx.rng.die(6));
  const hits = (dice: number[]) => dice.filter((d) => d >= C.MELEE_SUCCESS_ON).length;

  const attDice = roll(meleePool(att, true, false));
  let defense: ClashDefense;
  let defDice: number[] = [];
  if (angle === 'back') {
    defense = 'none';
  } else {
    defense = defWeapon ? 'blade' : inShieldArc(def, att.pos) ? 'shield' : 'dodge';
    let pool = meleePool(def, defCharging, angle === 'side');
    if (defense === 'dodge') pool = Math.max(1, Math.floor(pool / 2));
    // 承受衝擊：站穩接人，重機比較接得住
    if (defBracing) pool = Math.max(1, pool + C.BRACE_DIE + chassisOf(def).weightClass - chassisOf(att).weightClass);
    defDice = roll(pool);
  }
  const attHits = hits(attDice);
  const defHits = defense === 'none' ? 0 : hits(defDice);
  const margin = attHits - defHits;

  let winner: string | null = null;
  let damage = 0;
  let victim: UnitState | null = null;
  if (defense === 'none' || margin > 0) {
    winner = att.id;
    victim = def;
    damage = (EQUIPMENT[attWeapon.defId].damage ?? 1) + Math.max(0, margin - 1);
  } else if (margin < 0) {
    winner = def.id;
    if (defense === 'blade' && defWeapon) {
      victim = att;
      damage = (EQUIPMENT[defWeapon.defId].damage ?? 1) + (-margin - 1);
    }
  }
  const caught = defBracing && defense !== 'none' && margin <= 0;
  ctx.events.push({ type: 'clash', t, attacker: att.id, defender: def.id, angle, defense, attDice, defDice, attHits, defHits, winner, damage, caught });

  if (defense === 'none') addStress(ctx, def, C.BACKSTAB_STRESS, '背後偷襲');
  if (winner === null) {
    addStress(ctx, att, C.MELEE_TIE_STRESS, '刀刃相抵');
    addStress(ctx, def, C.MELEE_TIE_STRESS, '刀刃相抵');
  }
  if (victim && damage > 0) dealtBy(ctx, victim === def ? att : def, () => damageUnit(ctx, victim!, damage, 'focused'));
  return caught;
}
