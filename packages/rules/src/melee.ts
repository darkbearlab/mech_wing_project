// 一擊脫離時的近戰對決：雙方擲骰池比成功數，贏越多傷害越大。
// 擲了幾顆骰會公開，對手可以從骰數推測駕駛等級（「交鋒後才看得出來」）。
import * as C from './config';
import { contactAngle, inShieldArc, relativeAngle } from './combat';
import { minSpeedOf, radiusOf } from './body';
import { DEG, dist } from './geometry';
import { isShip } from './ship';
import { lineOfFire, wallPenetration } from './terrain';
import { addStress, damageUnit, dealtBy, typed, type Ctx } from './damage';
import { EQUIPMENT } from './data';
import type { Obstacle, Stance, UnitState, Vec } from './types';
import { chassisOf, pilotOf, readyMelee } from './unit';

export type ClashDefense = 'blade' | 'shield' | 'dodge' | 'none';

/** 這台機體在對決中的骰數（防守方沒拿近戰武器時另外處理） */
export function meleePool(u: UnitState, charging: boolean, sidePenalty: boolean): number {
  const weapon = readyMelee(u);
  let n = C.MELEE_BASE_DICE + Math.min(pilotOf(u).skill, C.SKILL_CAP_CLOSE);
  if (charging) n += C.MELEE_CHARGE_DIE;
  if (weapon) n += EQUIPMENT[weapon.defId].meleeDice ?? 0;
  if (sidePenalty) n -= C.MELEE_SIDE_PENALTY;
  if (u.blackout || u.stress >= u.maxStress) n -= C.MELEE_SLUGGISH_PENALTY;
  return Math.max(1, n);
}

/**
 * 回傳 true 表示承受衝擊的防守方把攻擊方拖住了（贏或平手）。
 * jump：跳劈的落差（層）。對方只能盾擋或閃避、不能反擊；贏了傷害 +落差（最多 JUMP_SLASH_MAX_BONUS），部位照頂部攻擊表
 */
export function meleeClash(ctx: Ctx, att: UnitState, def: UnitState, t: number, defCharging: boolean, defBracing = false, jump = 0): boolean {
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
    defense = defWeapon && !jump ? 'blade' : inShieldArc(def, att.pos) ? 'shield' : 'dodge';
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
    damage = (EQUIPMENT[attWeapon.defId].damage ?? C.DAMAGE_SCALE) + (Math.max(0, margin - 1) + Math.min(C.JUMP_SLASH_MAX_BONUS, jump)) * C.DAMAGE_SCALE;
  } else if (margin < 0) {
    winner = def.id;
    if (defense === 'blade' && defWeapon) {
      victim = att;
      damage = (EQUIPMENT[defWeapon.defId].damage ?? C.DAMAGE_SCALE) + (-margin - 1) * C.DAMAGE_SCALE;
    }
  }
  const caught = defBracing && defense !== 'none' && margin <= 0;
  ctx.events.push({ type: 'clash', t, attacker: att.id, defender: def.id, angle, defense, attDice, defDice, attHits, defHits, winner, damage, caught });

  if (defense === 'none') addStress(ctx, def, C.BACKSTAB_STRESS, '背後偷襲');
  if (winner === null) {
    addStress(ctx, att, C.MELEE_TIE_STRESS, '刀刃相抵');
    addStress(ctx, def, C.MELEE_TIE_STRESS, '刀刃相抵');
  }
  if (victim && damage > 0) {
    const top = ctx.topAttack;
    ctx.topAttack = jump > 0 && victim === def;
    try {
      const blade = victim === def ? attWeapon : defWeapon;
      dealtBy(ctx, victim === def ? att : def, () => typed(ctx, (blade && EQUIPMENT[blade.defId].damageType) || 'kinetic', () => damageUnit(ctx, victim!, damage, 'focused')));
    } finally {
      ctx.topAttack = top;
    }
  }
  return caught;
}

/** 突進要檢查的機體資料（UnitState 或自己看到的 UnitView 都可以） */
type LungeUnit = Pick<UnitState, 'id' | 'chassisId' | 'pos' | 'facing' | 'z' | 'parts' | 'equipment'> & { propellant?: number };

/**
 * 突進能不能出手：可以就回傳落點、落差（jump > 0 是跳劈）；不行就回傳原因。
 * 條件：近戰姿態、手上有近戰武器、推進劑夠；目標在正面 ±LUNGE_ARC_DEG 內、中間沒被建築擋住；
 * 同一個高度要在 LUNGE_RANGE 格內，比自己低（跳劈）放寬到 JUMP_SLASH_RANGE；比自己高的要先攀升
 */
export function lungeCheck(obstacles: Obstacle[], u: LungeUnit, t: LungeUnit, stance: Stance | undefined): { to: Vec; jump: number } | string {
  if (isShip(u) || minSpeedOf(u) > 0) return '這種機體不能突進';
  if (stance !== 'melee') return '要近戰姿態才能突進';
  if (!readyMelee(u as UnitState)) return '手上沒有近戰武器';
  if ((u.propellant ?? Infinity) < C.LUNGE_PROPELLANT) return '推進劑不夠';
  const jump = (u.z ?? 0) - (t.z ?? 0);
  if (jump < 0) return '目標比自己高，要先攀升上去';
  const ru = radiusOf(u);
  const rt = radiusOf(t);
  const limit = jump > 0 ? C.JUMP_SLASH_RANGE : C.LUNGE_RANGE;
  const d = dist(u.pos, t.pos);
  if (d - ru - rt > limit) return `太遠了（底板邊緣 ${limit} 格內才${jump > 0 ? '跳劈' : '突進'}得到）`;
  if (relativeAngle(u, t.pos) > C.LUNGE_ARC_DEG * DEG) return `目標不在正面 ±${C.LUNGE_ARC_DEG}° 內`;
  if (lineOfFire(obstacles, u.pos, t.pos, u.z, t.z) === 'blocked') return '中間被建築擋住';
  // 落點：貼著目標、在自己這一側
  const gap = ru + rt + 0.05;
  const k = d > gap ? (d - gap) / d : 0;
  const to = { x: u.pos.x + (t.pos.x - u.pos.x) * k, y: u.pos.y + (t.pos.y - u.pos.y) * k };
  const z = t.z ?? 0;
  if (obstacles.some((o) => o.kind === 'building' && o.levels! > z && wallPenetration(o, to, ru) > 1e-6)) return '落點被建築擋住';
  return { to, jump };
}
