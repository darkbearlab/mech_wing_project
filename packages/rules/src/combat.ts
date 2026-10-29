import * as C from './config';
import { bodyWeight, damageUnit, dealtBy, shotBy, typed, type Ctx } from './damage';
import { grapplePool } from './grapple';
import { asCoverInfo, coverOf, coverPenalty, insideField, type Cover, type CoverInfo } from './terrain';
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import type { EquipDef, EquipState, PartState, RangeBand, Stance, UnitState, Vec } from './types';
import { radiusOf, roleLost } from './body';
import { activeShields, chassisOf, equipDef, pilotOf, armorOf } from './unit';
import { barragePenalty, bridgeLost, isShip } from './ship';
import { ecmOf, jammed } from './ecm';
import { EQUIPMENT } from './data';

export interface Positioned {
  id: string;
  chassisId: string;
  pos: Vec;
  /** 高度（層） */
  z?: number;
  facing: number;
  parts: Record<string, PartState>;
  equipment?: EquipState[];
  /** 被敵方標定（敵方射擊命中 +MARK_BONUS） */
  mark?: { by?: string };
}

/** 高打低：射擊方比目標高幾層（只算往下打，最多 HIGH_GROUND_MAX_LEVELS） */
export const heightAdvantage = (a: { z?: number }, t: { z?: number }): number => Math.max(0, Math.min(C.HIGH_GROUND_MAX_LEVELS, (a.z ?? 0) - (t.z ?? 0)));

export function edgeDistance(a: { pos: Vec; chassisId?: string }, b: { pos: Vec; chassisId?: string }): number {
  return dist(a.pos, b.pos) - radiusOf(a) - radiusOf(b);
}

export function rangeBand(a: { pos: Vec; chassisId?: string }, b: { pos: Vec; chassisId?: string }): RangeBand | null {
  const d = edgeDistance(a, b);
  if (d <= C.RANGE_LIMITS.r0) return 0;
  if (d <= C.RANGE_LIMITS.r1) return 1;
  if (d <= C.RANGE_LIMITS.r2) return 2;
  if (d <= C.RANGE_LIMITS.r3) return 3;
  if (d <= C.RANGE_LIMITS.r4) return 4;
  return null;
}

export const bandName = (b: RangeBand): string => ['零距離', '近距離', '中距離', '遠距離', '超遠距離'][b];

/** 從 from 看 to 的方向，相對於 from 朝向的角度（絕對值，弧度） */
export function relativeAngle(from: { pos: Vec; facing: number }, to: Vec): number {
  return Math.abs(angleDiff(angleOf(sub(to, from.pos)), from.facing));
}

export interface HitInput {
  attacker: Positioned & { lockOn?: string | null; blackout?: boolean };
  attackerSkill: number;
  weapon: EquipDef;
  target: Positioned;
  /** 未知時（對手視角）為 null */
  targetSkill: number | null;
  /** 雙方本回合移動向量差的長度；不知道時（例如移動步驟）為 null */
  relSpeed: number | null;
  /** 射擊方是近戰姿態 */
  shooterMelee: boolean;
  /** 射擊線上的掩體（coverOf；舊的單一分類也收）：擋住就打不到，其他照 coverPenalty 扣；不知道時視為暢通 */
  cover?: Cover | CoverInfo;
  /** 射擊方這回合被眩光照到 */
  dazzled?: boolean;
  /** 射擊方這回合在重力圈噴射跳躍落地（落地衝擊） */
  landing?: boolean;
  /** 目標不是機體（炮群）：用這個迴避代替機型的迴避 */
  targetEvasion?: number;
  /** 目標在生效中的防禦彈幕裡：命中下降這麼多 */
  barrage?: number;
  /** 目標在它那一方的電子干擾範圍內 */
  jammed?: boolean;
  /** 這場的規則版本（沒寫是現在的規則） */
  rules?: number;
}

/** 這個規則版本的技能修正：每級命中、每級迴避、技能差每級 */
export function skillMods(rules?: number): { hit: number; evade: number; gap: number } {
  return C.rulesAtLeast({ rules }, 4)
    ? { hit: C.HIT_PER_SKILL_V4, evade: C.EVADE_PER_SKILL_V4, gap: C.SKILL_GAP_PENALTY_V4 }
    : { hit: C.HIT_PER_SKILL, evade: C.EVADE_PER_SKILL, gap: C.SKILL_GAP_PENALTY };
}

/** 命中率超過 HIT_SOFT_CAP 的部分只算一半（規則第 4 版起） */
export const softCap = (chance: number, rules?: number): number =>
  C.rulesAtLeast({ rules }, 4) && chance > C.HIT_SOFT_CAP ? Math.round(C.HIT_SOFT_CAP + (chance - C.HIT_SOFT_CAP) / 2) : chance;

/** 扣掉這次要打的發數，回傳實際打得出去的發數（沒有彈數的武器不扣） */
export function spendRounds(weapon: EquipState, want: number): number {
  if (weapon.ammo === undefined) return want;
  const n = Math.min(want, weapon.ammo);
  weapon.ammo -= n;
  return n;
}

/** 曲射、越頂的武器：不用射擊線、不吃掩護與高低差、沒有射界，打中照頂部攻擊表，盾擋不到 */
export const indirectFire = (d: EquipDef): boolean => d.fire === 'mortar' || d.fire === 'vls';
/** 有導引的飛彈：相對速度的命中懲罰不算 */
export const guidedFire = (d: EquipDef): boolean => d.fire === 'vls' || d.fire === 'missile' || d.fire === 'antiRadiation' || d.fire === 'atgm';
/** 有飛行時間的武器：發射的下一回合、移動結束後才命中 */
export const flightFire = (d: EquipDef): boolean => d.fire === 'mortar' || d.fire === 'vls' || d.fire === 'atgm';
/** 要先標定才能打的武器（反輻射追干擾電波、反戰車飛彈靠發射端瞄準，不用標定） */
export const needsMark = (d: EquipDef): boolean => !!d.fire && d.fire !== 'antiRadiation' && d.fire !== 'atgm';

/** 展開中的盾牆：機體正面、寬 BARRIER_WIDTH 的線段 */
export function barrierOf(u: Positioned & { status?: string }): { a: Vec; b: Vec; equip: EquipState } | null {
  const e = (u.equipment ?? []).find((x) => x.deployed && (x.location === 'right' || x.location === 'left') && !u.parts[x.id]?.destroyed);
  if (!e || (u.status && u.status !== 'active')) return null;
  const off = radiusOf(u) + 0.15;
  const c = { x: u.pos.x + Math.cos(u.facing) * off, y: u.pos.y + Math.sin(u.facing) * off };
  const px = (-Math.sin(u.facing) * C.BARRIER_WIDTH) / 2;
  const py = (Math.cos(u.facing) * C.BARRIER_WIDTH) / 2;
  return { a: { x: c.x + px, y: c.y + py }, b: { x: c.x - px, y: c.y - py }, equip: e };
}

const cross = (o: Vec, a: Vec, b: Vec) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const segmentsCross = (p: Vec, q: Vec, a: Vec, b: Vec) => cross(p, q, a) * cross(p, q, b) < 0 && cross(a, b, p) * cross(a, b, q) < 0;

/** 從 from（高度 fromZ）打到 to 的射擊線穿過誰的盾牆（射手自己的除外；比盾牆高 1 層以上就從上面打過去） */
export function barrierBetween<T extends Positioned & { status?: string }>(units: T[], shooter: string, from: Vec, fromZ: number | undefined, to: Vec): { unit: T; equip: EquipState } | null {
  for (const u of units) {
    if (u.id === shooter) continue;
    const w = barrierOf(u);
    if (!w || (fromZ ?? 0) > (u.z ?? 0) + C.BARRIER_LEVELS) continue;
    if (segmentsCross(from, to, w.a, w.b)) return { unit: u, equip: w.equip };
  }
  return null;
}

export function hitChance(h: HitInput): { band: RangeBand; chance: number; high: number } | null {
  // 反輻射飛彈只打開著電子干擾的機體；其他導引武器只能打被標定的目標（有視線也一樣）
  const antiRadiation = h.weapon.fire === 'antiRadiation';
  if (antiRadiation ? !ecmOf(h.target) : needsMark(h.weapon) && !h.target.mark) return null;
  const indirect = indirectFire(h.weapon);
  const machine = !!h.weapon.fire;
  const band = rangeBand(h.attacker, h.target);
  if (band === null) return null;
  if (band === 0 && h.weapon.pointBlank === false) return null;
  // 固定射界：射界外打不到
  const rel = relativeAngle(h.attacker, h.target.pos);
  // 固定射界：中心可以偏離正面（戰艦的舷側、艦尾砲塔）
  const arcRel = h.weapon.arcOffset ? Math.abs(angleDiff(angleOf(sub(h.target.pos, h.attacker.pos)), h.attacker.facing + h.weapon.arcOffset * DEG)) : rel;
  if (!indirect && h.weapon.arc !== undefined && arcRel > h.weapon.arc * DEG) return null;
  const rangeMod = band === 0 ? C.ZERO_RANGE_BONUS : h.weapon.ranges?.[band];
  if (rangeMod === undefined) return null;
  const atk = chassisOf(h.attacker);
  const evasion = h.targetEvasion ?? chassisOf(h.target).evasion;
  // 穿著外裝甲：迴避下降
  // 導引武器只看機器：射手駕駛的技能不算
  const sk = skillMods(h.rules);
  const v4 = C.rulesAtLeast({ rules: h.rules }, 4);
  let chance = C.HIT_BASE + atk.aim + (machine ? 0 : h.attackerSkill * sk.hit) + rangeMod - evasion + (armorOf(h.target)?.evasionPenalty ?? 0);
  if (h.targetSkill !== null) {
    chance -= h.targetSkill * sk.evade;
    // 技能差距太大：只有身手相當的人才打得到
    const gap = machine ? 0 : h.targetSkill - h.attackerSkill - C.SKILL_GAP_FREE;
    if (gap > 0) chance -= gap * sk.gap;
  }
  if (h.relSpeed !== null) chance += guidedFire(h.weapon) ? Math.max(0, relativeSpeedMod(h.relSpeed)) : relativeSpeedMod(h.relSpeed);
  if (h.shooterMelee) chance -= C.MELEE_STANCE_SHOT_PENALTY;
  if (!machine && h.attacker.blackout) chance -= C.BLACKOUT_SHOT_PENALTY;
  if (h.dazzled) chance -= C.DAZZLE_PENALTY;
  if (!machine && h.landing) chance -= C.JUMP_LANDING_PENALTY;
  // 反輻射飛彈追干擾電波：第 4 版起不用射擊線、不吃掩護
  if (!indirect && !(antiRadiation && v4)) {
    const cover = asCoverInfo(h.cover);
    if (cover.blocked) return null;
    chance -= coverPenalty(cover);
  }
  const high = indirect ? 0 : heightAdvantage(h.attacker, h.target);
  const v5 = C.rulesAtLeast({ rules: h.rules }, 5);
  // 第 5 版起：高打低只算一層（固定加成）；目標比自己高 HIGH_TARGET_COVER_FROM 層以上算半掩護
  chance += v5 ? (high > 0 ? C.HIGH_GROUND_HIT : 0) : high * C.HIGH_GROUND_HIT;
  if (v5 && !indirect && (h.target.z ?? 0) - (h.attacker.z ?? 0) >= C.HIGH_TARGET_COVER_FROM) chance -= C.BUILDING_COVER_PENALTY;
  if (!indirect && h.weapon.arc === undefined && band > 0 && rel > C.OFF_FRONT_DEG * DEG) chance -= C.OFF_FRONT_PENALTY;
  if (!indirect && h.attacker.lockOn === h.target.id) chance += C.LOCK_BONUS;
  // 目標在它那一方的干擾範圍內（第 4 版起）：導引武器命中下降，標定的加成也不算
  const jam = v4 && !!h.jammed;
  if (!machine && h.target.mark && !jam) chance += C.MARK_BONUS;
  if (jam && needsMark(h.weapon)) chance -= C.ECM_GUIDED_PENALTY;
  if (antiRadiation) chance += C.ARM_HIT_BONUS;
  if (band >= 3 && roleLost(h.attacker, 'sensor')) chance -= C.HEAD_LONG_PENALTY;
  if (bridgeLost(h.attacker)) chance -= C.SHIP_NO_BRIDGE_PENALTY;
  if (h.barrage) chance -= h.barrage;
  return { band, chance: Math.max(C.HIT_MIN, Math.min(C.HIT_MAX, softCap(chance, h.rules))), high };
}

/** 每面盾牌的防護範圍（弧度）：手持盾預設在持盾那側，固定盾照資料的角度 */
export function shieldArcs(u: { parts: Record<string, PartState>; equipment: EquipState[] }, facing: number): { equip: EquipState; center: number; half: number }[] {
  return activeShields(u).map(({ equip, hand }) => {
    const def = equipDef(equip);
    const offset = def.shieldOffset ?? (hand ? (hand === 'right' ? 1 : -1) * C.SHIELD_ARC_OFFSET_DEG : 0);
    return { equip, center: facing + offset * DEG, half: (def.shieldArc ?? C.SHIELD_ARC_HALF_DEG) * DEG };
  });
}

/** 從 from 打過來時擋得到的盾牌（沒有就 null） */
export function coveringShield(def: UnitState, from: Vec): EquipState | null {
  const dir = angleOf(sub(from, def.pos));
  return shieldArcs(def, def.facing).find((s) => Math.abs(angleDiff(dir, s.center)) <= s.half)?.equip ?? null;
}

export const inShieldArc = (def: UnitState, from: Vec): boolean => coveringShield(def, from) !== null;

const blockChance = (def: UnitState): number => C.SHIELD_BLOCK_BASE + Math.min(pilotOf(def).skill, C.SKILL_CAP_CLOSE) * C.SHIELD_BLOCK_PER_SKILL;

export const relativeSpeedMod = (r: number): number => C.RELATIVE_SPEED_HIT.find(([max]) => r <= max)![1];

export function relativeSpeed(velocity: Record<string, Vec>, a: string, b: string): number {
  const va = velocity[a] ?? { x: 0, y: 0 };
  const vb = velocity[b] ?? { x: 0, y: 0 };
  return Math.hypot(va.x - vb.x, va.y - vb.y);
}

export interface TurnInfo {
  stance: Record<string, Stance>;
  velocity: Record<string, Vec>;
  /** 這回合被眩光照到的機體 */
  dazzled?: Set<string>;
  /** 這回合機動的速度 */
  speed?: Record<string, number>;
  /** 重力圈裡噴射跳躍、這回合剛落地的機體 */
  jumped?: Set<string>;
}

/**
 * 開火。opts.pursuit 標記為追擊射擊；opts.later 有給的話，命中的傷害先放進去、由呼叫端一起結算（同時開火用）
 */
export function shoot(ctx: Ctx, turn: TurnInfo, attacker: UnitState, weapon: EquipState, target: UnitState, opts: { pursuit?: boolean; later?: (() => void)[]; shots?: number; pod?: string; from?: Vec; landing?: string } = {}): boolean {
  const def = equipDef(weapon);
  const indirect = indirectFire(def);
  // 射擊線穿過展開的盾牆：算半掩護，命中一律打在盾上（曲射的從上面打過去）
  const wall = indirect ? null : barrierBetween(ctx.state.units, attacker.id, opts.from ?? attacker.pos, attacker.z, target.pos);
  const los = coverOf(ctx.state.obstacles, attacker.pos, target.pos, attacker.z, target.z);
  const h = hitChance({
    attacker,
    attackerSkill: pilotOf(attacker).skill,
    weapon: def,
    target,
    targetSkill: pilotOf(target).skill,
    relSpeed: relativeSpeed(turn.velocity, attacker.id, target.id),
    shooterMelee: turn.stance[attacker.id] === 'melee',
    cover: { ...los, barrier: !!wall },
    dazzled: turn.dazzled?.has(attacker.id),
    landing: turn.jumped?.has(attacker.id),
    // 戰艦自己的射擊不受彈幕影響
    barrage: isShip(attacker) ? 0 : barragePenalty(ctx.state.units, target),
    jammed: jammed(ctx.state.units, target),
    rules: ctx.state.rules,
  });
  if (!h) return false;
  // 彈藥以發計：打出幾發扣幾發，剩的不夠一輪就只打剩下的（落下的飛行彈藥發射時已經扣過）
  const shots = opts.landing ? (opts.shots ?? 1) : spendRounds(weapon, opts.shots ?? def.shots ?? 1);
  if (shots <= 0) return false;
  // 有飛行時間的武器：這回合只是發射，下一回合移動結束後才命中
  if (flightFire(def) && !opts.landing) {
    const { state } = ctx;
    const id = `in${state.turn}-${attacker.id}-${(state.inbound ?? []).length}`;
    (state.inbound ??= []).push({ id, owner: attacker.owner, attacker: attacker.id, weapon: weapon.id, defId: def.id, target: target.id, shots, from: { ...attacker.pos }, ...(attacker.z ? { z: attacker.z } : {}), turn: state.turn });
    ctx.events.push({ type: 'launch', id, attacker: attacker.id, target: target.id, weapon: def.id, shots });
    return true;
  }
  if (attacker.lockOn === target.id) attacker.lockOn = null;
  const overflow = !!def.tags?.includes('overflow');
  let hits = 0;
  let blocked = 0;
  let crits = 0;
  let strays = 0;
  const pending: (() => void)[] = [];
  // 目標在纏鬥中：每發命中照部位權重從纏在一起的機體裡抽打到誰（可能誤擊友軍）
  const pool = grapplePool(ctx.state, target);
  const aimBonus = pilotOf(attacker).abilities.includes('called_shot') ? C.CALLED_SHOT_CORE_BONUS : 0;
  // 曲射、越頂：從上方打下來，部位照頂部攻擊表
  const top = (fn: () => void) => () => {
    const prev = ctx.topAttack;
    ctx.topAttack = indirect;
    try {
      typed(ctx, def.damageType ?? 'kinetic', fn);
    } finally {
      ctx.topAttack = prev;
    }
  };
  for (let i = 0; i < shots; i++) {
    // 同一顆骰子：≤ 命中率就命中，≤ 命中率 − 100 就是爆擊（傷害加倍）
    const roll = ctx.rng.d100();
    if (roll > h.chance) {
      // 迫擊砲沒打中：砲彈散布，炸到落點附近（敵我不分）
      if (def.fire === 'mortar') {
        const ang = ctx.rng.next() * Math.PI * 2;
        const off = C.MORTAR_SCATTER_MIN + ctx.rng.next() * (C.MORTAR_SCATTER_MAX - C.MORTAR_SCATTER_MIN);
        const at = { x: target.pos.x + Math.cos(ang) * off, y: target.pos.y + Math.sin(ang) * off };
        pending.push(top(() => mortarBlast(ctx, attacker, at)));
      }
      // 散射武器沒打中：可能打到目標旁邊的敵機（第 5 版起）
      const stray = strayVictim(ctx, attacker, def, target, indirect);
      if (stray) {
        strays++;
        const dmg = Math.round((def.damage ?? C.DAMAGE_SCALE) * C.STRAY_DAMAGE_SHARE);
        ctx.events.push({ type: 'stray', attacker: attacker.id, target: target.id, unit: stray.id });
        pending.push(top(() => shotBy(ctx, attacker, stray, () => damageUnit(ctx, stray, dmg, 'focused', undefined, overflow), opts.from)));
      }
      continue;
    }
    hits++;
    const crit = roll <= h.chance - 100;
    if (crit) crits++;
    // 高打低（高出 HIGH_GROUND_DAMAGE_FROM 層以上）：每發命中傷害 +HIGH_GROUND_DAMAGE_PCT（爆擊加倍之後才算）
    const base = (def.damage ?? C.DAMAGE_SCALE) * (crit ? C.CRIT_MULTIPLIER : 1);
    // 第 5 版起沒有高打低的傷害加成
    const dmg = h.high >= C.HIGH_GROUND_DAMAGE_FROM && !C.rulesAtLeast(ctx.state, 5) ? Math.round(base * (1 + C.HIGH_GROUND_DAMAGE_PCT)) : base;
    const victim = pool.length > 1 ? ctx.rng.pickWeighted(pool, (u) => bodyWeight(u, u === target ? aimBonus : 0)) : target;
    if (victim !== target) strays++;
    const shield = indirect ? undefined : coveringShield(victim, attacker.pos)?.id;
    if (wall) {
      // 盾牆擋在中間：一律打在盾上
      blocked++;
      const holder = wall.unit;
      pending.push(top(() => shotBy(ctx, attacker, target, () => damageUnit(ctx, holder, dmg, 'focused', wall.equip.id, overflow), opts.from)));
    } else if (shield && ctx.rng.d100() <= blockChance(victim)) {
      blocked++;
      pending.push(top(() => shotBy(ctx, attacker, target, () => damageUnit(ctx, victim, dmg, 'focused', shield, overflow), opts.from)));
    } else {
      // 反輻射飛彈循著干擾電波打在干擾器上
      const homing = def.fire === 'antiRadiation' ? ecmOf(victim)?.id : undefined;
      pending.push(top(() => shotBy(ctx, attacker, target, () => damageUnit(ctx, victim, dmg, def.mode ?? 'focused', homing, overflow), opts.from)));
    }
  }
  ctx.events.push({ type: 'shot', attacker: attacker.id, target: target.id, weapon: def.id, band: h.band, shots, hits, blocked, chance: h.chance, ...(crits ? { crits } : {}), ...(strays ? { strays } : {}), ...(opts.pursuit ? { pursuit: true } : {}), ...(opts.pod ? { pod: opts.pod, from: { ...opts.from! } } : {}), ...(opts.landing ? { inbound: opts.landing } : {}) });
  if (hits > blocked && def.tags?.includes('dazzle') && !turn.dazzled?.has(target.id)) {
    turn.dazzled?.add(target.id);
    ctx.events.push({ type: 'dazzle', unit: target.id, by: attacker.id });
  }
  if (opts.later) opts.later.push(...pending);
  else for (const p of pending) p();
  // 零距離開火可能傷到自己的武器；內建武器沒有自己的部位，傷到宿主
  const selfPart = attacker.parts[weapon.id] ? weapon.id : weapon.host;
  if (!opts.pod && !opts.landing && h.band === 0 && selfPart && ctx.rng.d100() <= C.ZERO_RANGE_SELF_DAMAGE) damageUnit(ctx, attacker, C.DAMAGE_SCALE, 'focused', selfPart);
  return true;
}

/** 散射武器（直射、一次 STRAY 3 發以上）：沒打中的那一發可能打到目標 STRAY_RANGE 內的另一台敵機（不會打進隕石群、不會繞過建築） */
export const scatterWeapon = (d: EquipDef): boolean => d.kind === 'ranged' && !d.fire && (d.shots ?? 1) >= 3;

function strayVictim(ctx: Ctx, attacker: UnitState, def: EquipDef, target: UnitState, indirect: boolean): UnitState | null {
  if (indirect || !scatterWeapon(def) || !C.rulesAtLeast(ctx.state, 5)) return null;
  const near = ctx.state.units.filter(
    (u) =>
      u !== target &&
      u.owner === target.owner &&
      u.status === 'active' &&
      edgeDistance(u, target) <= C.STRAY_RANGE &&
      !insideField(ctx.state.obstacles, u.pos) &&
      !asCoverInfo(coverOf(ctx.state.obstacles, attacker.pos, u.pos, attacker.z, u.z)).blocked,
  );
  if (!near.length || ctx.rng.d100() > C.STRAY_CHANCE) return null;
  return near.reduce((a, b) => (edgeDistance(a, target) <= edgeDistance(b, target) ? a : b));
}

/** 迫擊砲的砲彈落在 at：落點附近的機體都受破片傷害 */
function mortarBlast(ctx: Ctx, attacker: UnitState, at: Vec): void {
  const hit = ctx.state.units.filter((u) => u.status === 'active' && dist(u.pos, at) - radiusOf(u) <= C.MORTAR_SPLASH_RADIUS);
  ctx.events.push({ type: 'blast', by: attacker.id, at: { ...at }, units: hit.map((u) => u.id) });
  for (const u of hit) dealtBy(ctx, attacker, () => typed(ctx, 'chemical', () => damageUnit(ctx, u, C.MORTAR_SPLASH_DAMAGE, 'focused')));
}

export type AngleClass = 'front' | 'side' | 'back';

export function contactAngle(def: UnitState, from: Vec): AngleClass {
  const rel = relativeAngle(def, from);
  if (rel <= C.FRONT_ARC_DEG * DEG) return 'front';
  if (rel >= C.BACK_ARC_DEG * DEG) return 'back';
  return 'side';
}

/** 落下時打不到的原因：太遠、貼得太近（最小射程內）、射界外 */
function landingMiss(def: EquipDef, shooter: UnitState, target: UnitState): string {
  const band = rangeBand(shooter, target);
  if (band === null) return '目標跑出最遠射程，落空';
  const bands = Object.keys(def.ranges ?? {}).map(Number);
  const nearest = Math.min(...bands);
  if (bands.length && band < nearest) return `目標貼近到${bandName(band)}（最小射程是${bandName(nearest as RangeBand)}），落空`;
  if (def.arc !== undefined && !indirectFire(def) && relativeAngle(shooter, target.pos) > def.arc * DEG) return '目標離開正面射界，落空';
  return '打不到目標，落空';
}

/**
 * 上一回合發射的彈藥命中（動作步驟一開始、移動結束後）：
 * 迫擊砲、垂直飛彈照發射位置算、要目標的標定還在；反戰車飛彈照發射端現在的位置算、發射端要還能操作而且射擊線沒被擋住或隔著煙霧
 */
export function landInbound(ctx: Ctx, turn: TurnInfo): void {
  const { state } = ctx;
  const due = (state.inbound ?? []).filter((x) => x.turn < state.turn);
  if (!due.length) return;
  state.inbound = (state.inbound ?? []).filter((x) => x.turn >= state.turn);
  for (const inb of due) {
    const lost = (reason: string) => ctx.events.push({ type: 'inboundLost', id: inb.id, attacker: inb.attacker, target: inb.target, weapon: inb.defId, reason });
    const target = state.units.find((u) => u.id === inb.target);
    const attacker = state.units.find((u) => u.id === inb.attacker);
    const def = EQUIPMENT[inb.defId];
    if (!target || target.status !== 'active' || !attacker || !def) {
      lost('目標已經不在戰場上');
      continue;
    }
    const weapon = attacker.equipment.find((e) => e.id === inb.weapon) ?? { id: inb.weapon, defId: inb.defId, location: 'mount' as const };
    let shooter: UnitState;
    let velocity = turn.velocity;
    if (def.fire === 'atgm') {
      // 反戰車飛彈：發射端要一路瞄著目標
      if (attacker.status !== 'active') {
        lost('發射端失去戰鬥能力，飛彈失去導引');
        continue;
      }
      if (attacker.parts[weapon.id]?.destroyed) {
        lost('發射器被打壞，飛彈失去導引');
        continue;
      }
      if ((turn.speed?.[attacker.id] ?? 0) > C.ATGM_GUIDE_MAX_SPEED) {
        lost(`發射端這回合速度超過 ${C.ATGM_GUIDE_MAX_SPEED}，瞄不住目標`);
        continue;
      }
      if (def.arc !== undefined && relativeAngle(attacker, target.pos) > def.arc * DEG) {
        lost('目標離開發射端的正面射界');
        continue;
      }
      const c = coverOf(state.obstacles, attacker.pos, target.pos, attacker.z, target.z);
      if (c.blocked || c.smoke) {
        lost(c.smoke ? '隔著煙霧，發射端看不到目標' : '發射端的射擊線被擋住');
        continue;
      }
      shooter = attacker;
    } else {
      if (!target.mark) {
        lost('目標的標定失效，失去導引');
        continue;
      }
      // 從發射的位置打過去（發射端之後怎麼動都不影響；只算目標自己的速度）
      shooter = { ...attacker, pos: { ...inb.from }, z: inb.z, facing: angleOf(sub(target.pos, inb.from)) };
      velocity = { ...turn.velocity, [attacker.id]: { x: 0, y: 0 } };
    }
    if (!shoot(ctx, { ...turn, velocity }, shooter, weapon, target, { landing: inb.id, shots: inb.shots })) lost(landingMiss(def, shooter, target));
  }
}
