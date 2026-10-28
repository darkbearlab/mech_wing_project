// 規則式 AI：只看自己席位的可見資訊（看不到對手駕駛、壓力、推進劑），不作弊。
// 移動：對每個可用機動模擬路徑（撞上大隕石就停在撞點），依終點的火力、受威脅程度、與目標的距離、
//       隊形、邊界、下回合會不會撞上、壓力與推進劑打分。受傷越重越重視自保。
//       以多打少：終點打得到我的敵機若比「能支援我的隊友＋我」多就大扣分，所以會等隊友一起進場、
//       躲在大隕石後面只露給一台敵機；還沒交火時不衝到隊友前面。
// 王牌移動：有能力的機體一律先擱置，等其他人動完、看清楚再決定（敵機位置確定，咬尾更準）。
// 追擊：會避免把背後露給敵機（被咬住會多挨一槍），也會找能咬住敵機背後的位置；追擊步驟挑期望傷害最高的一槍。
// 勝利條件：斬首時集火敵方旗艦、自己的旗艦待在後面；達陣時派 1–2 台快的去對方達陣圈停住，敵機靠近自己的達陣圈就優先打它；
//       據點時把機體分到各據點。開戰前自由部署時，挑前方有大隕石掩護的路線一字排開，旗艦在後。
// 行動：全隊選一個集火目標（優先離它隊友最遠、我方最多台打得到的敵機），挑期望傷害最高的射擊；
//       命中率太低就先鎖定（下一發加成），沒得打就拔刀、拔槍或鎖定集火目標。
import { DEG, angleDiff, angleOf, dist, sub } from './geometry';
import { closeCombatOf, minSpeedOf, radiusOf, roleLost } from './body';
import { CHASSIS, EQUIPMENT, PILOTS } from './data';
import { hitChance, relativeSpeed } from './combat';
import { BEATS, TECHNIQUES, techniqueUse, grappleOptions, grapplePool } from './grapple';
import { parseManeuver, samplePath, worldPose, type ManeuverSpec } from './maneuvers';
import { lineOfFire, wallPenetration } from './terrain';
import { buildPath } from './movement';
import { JUMP_SLASH_MAX_BONUS, JUMP_SLASH_RANGE, LUNGE_ARC_DEG, LUNGE_RANGE, DEBRIS_SAFE_SPEED, MAP_SIZE, FACING_OFFSETS, ROCK_SAFE_SPEED, SLOW_MAX_SPEED, COUNTER_DICE, SHIP_TURN_MAX_DEG } from './config';
import { insideField } from './terrain';
import type { Rng } from './rng';
import { tailing } from './pursuit';
import { inMarkCone } from './vision';
import { lungeCheck } from './melee';
import { isShip } from './ship';
import { CONTROL_RADIUS, GOAL_RADIUS, controlPoints, deployZone, goalZone } from './objectives';
import type { Technique, ActionPlan, EquipDef, EquipState, PlayerDeploy, PlayerId, PlayerPursuits, GrappleChoice, Hand, MovePlan, Obstacle, PlayerActions, PlayerMoves, Stance, UnitState, Vec } from './types';
import { armorOf, availableManeuvers, climbBlocked, climbLimits, cruiseManeuver, equipAlive, handUsable, maneuverCost, moveSpeed, rackSide, readyRanged } from './unit';
import type { PlayerView } from './match';
import type { UnitView } from './visibility';

const RANGE_TARGET: Record<1 | 2 | 3 | 4, number> = { 1: 2, 2: 4.5, 3: 8, 4: 14 };

const armOk = (u: Pick<UnitView, "parts" | "equipment">, h: Hand) => handUsable(u, h);
const heldItems = (u: UnitView) => u.equipment.filter((e) => (e.location === 'right' || e.location === 'left') && armOk(u, e.location) && equipAlive(u, e));
/** 能用的武器：近戰要拿在手上；射擊包含外掛與內建 */
const heldOf = (u: UnitView, kind: 'ranged' | 'melee') => (kind === 'ranged' ? readyRanged(u) : heldItems(u).filter((e) => EQUIPMENT[e.defId].kind === kind));
const stowedOf = (u: UnitView, kind: 'ranged' | 'melee') =>
  u.equipment.filter((e) => (e.location === 'stowed' || e.location === 'housed') && equipAlive(u, e) && EQUIPMENT[e.defId].kind === kind);
const canHold = (u: UnitView) => (['right', 'left'] as Hand[]).some((h) => armOk(u, h));
const edge = (a: Vec, b: Vec) => dist(a, b) - 1;

/** 拔出的武器放到哪隻手：先找空手，再找沒拿盾、也不是 keep 的那隻 */
export function drawHand(u: Pick<UnitView, 'parts' | 'equipment'>, keep?: string, equip?: string): Hand {
  const v = u as UnitView;
  // 武器架在哪一側就用那一側的手拿
  const e = equip ? v.equipment.find((x) => x.id === equip) : undefined;
  const side = e && e.location !== 'right' && e.location !== 'left' ? rackSide(v, e) : null;
  if (side) return side;
  const hands = (['right', 'left'] as Hand[]).filter((h) => armOk(v, h));
  const held = (h: Hand) => v.equipment.find((e) => e.location === h && equipAlive(v, e));
  return hands.find((h) => !held(h)) ?? hands.find((h) => EQUIPMENT[held(h)!.defId].kind !== 'shield' && held(h)!.id !== keep) ?? hands[0] ?? 'right';
}

/** 這台機體想和敵人保持的底板距離：拿刀就貼上去，拿槍就待在武器最擅長的距離帶 */
function preferredRange(u: UnitView): { range: number; melee: boolean } {
  if (heldOf(u, 'melee').length) return { range: 0, melee: true };
  let best: { range: number; mod: number } | null = null;
  for (const e of heldOf(u, 'ranged')) {
    const ranges = EQUIPMENT[e.defId].ranges ?? {};
    for (const band of [1, 2, 3] as const) {
      const mod = ranges[band];
      if (mod !== undefined && (!best || mod > best.mod)) best = { range: RANGE_TARGET[band], mod };
    }
  }
  return { range: best?.range ?? 4, melee: false };
}

/** 猜敵機下一步大概會到哪：沿目前朝向照動能前進 */
/** 這回合已經動完、不會再移動的機體（王牌移動步驟時才有） */
let settled: Set<string> | null = null;
const predict = (e: UnitView): Vec => {
  if (settled?.has(e.id)) return e.pos;
  const step = Math.max(1, Math.min(4, Math.abs(e.momentum ?? 2)));
  return { x: e.pos.x + Math.cos(e.facing) * step, y: e.pos.y + Math.sin(e.facing) * step };
};

function nearest(from: Vec, enemies: UnitView[], at: (e: UnitView) => Vec = (e) => e.pos): UnitView | null {
  let best: UnitView | null = null;
  let d = Infinity;
  for (const e of enemies) {
    const dd = dist(from, at(e));
    if (dd < d) {
      d = dd;
      best = e;
    }
  }
  return best;
}

/** 受傷程度 0–1：核心剩多少為主，其他部位為輔 */
function hurtOf(u: UnitView): number {
  const body = Object.values(u.parts).filter((p) => p.kind === 'body');
  const core = body.filter((p) => p.role === 'core');
  const left = (ps: typeof body) => ps.reduce((n, p) => n + Math.max(0, p.durability - p.damage), 0) / Math.max(1, ps.reduce((n, p) => n + p.durability, 0));
  return Math.min(1, Math.max(1 - left(core), (1 - left(body)) * 0.7));
}

const ASSUMED_SKILL = 3;
/** 命中率（可超過 100）換成每發的期望傷害倍率：命中機率 ×（1 ＋ 爆擊機率） */
/** 射纏鬥中的敵機：命中打到它本身的比例（其餘打到纏住它的隊友） */
function aimShare(view: PlayerView, t: UnitView): number {
  const weight = (u: UnitView) => Object.values(u.parts).filter((p) => p.kind === 'body' || !p.destroyed).reduce((n, p) => n + p.weight, 0);
  const pool = grapplePool(view.state, t);
  return pool.length > 1 ? weight(t) / pool.reduce((n, u) => n + weight(u), 0) : 1;
}

const hitValue = (chance: number) => (Math.min(chance, 100) / 100) * (1 + Math.max(0, Math.min(100, chance - 100)) / 100);
/** 命中率低於這個就先鎖定，不浪費這回合 */
const LOW_SHOT = 22;
/** 近戰機：自己射擊命中率低於這個，砍得到就改成突進 */
const LUNGE_SHOT = 60;
/** 帶標定器的機體：自己這發命中率低於這個就改成標定 */
const MARK_SHOT = 45;
/** 判斷鎖定距離用的假武器（和規則結算鎖定時一樣） */
const LOCK_PROBE: EquipDef = { id: '', name: '', kind: 'ranged', weight: 0, durability: 0, ranges: { 1: 0, 2: 0, 3: 0 } };

/** 從 from 打 target 的最佳期望傷害（attackerFacing 為 null 時假設手持武器會轉向目標） */
function expectedDamage(shooter: UnitView, from: Vec, facing: number | null, target: UnitView, at: Vec, targetFacing: number, obstacles: Obstacle[], skill: number, targetSkill: number | null): number {
  let best = 0;
  for (const w of heldOf(shooter, 'ranged')) {
    const def = EQUIPMENT[w.defId];
    if (def.tags?.includes('dazzle') || (w.ammo !== undefined && w.ammo <= 0)) continue;
    const face = def.arc === undefined && facing === null ? angleOf(sub(at, from)) : (facing ?? shooter.facing);
    const h = hitChance({
      attacker: { ...shooter, pos: from, facing: face },
      attackerSkill: skill,
      weapon: def,
      target: { ...target, pos: at, facing: targetFacing },
      targetSkill,
      relSpeed: null,
      shooterMelee: false,
      cover: lineOfFire(obstacles, from, at, shooter.z, target.z),
    });
    if (h) best = Math.max(best, hitValue(h.chance) * (def.damage ?? 1) * (def.shots ?? 1));
  }
  return best;
}

interface TeamPlan {
  enemies: UnitView[];
  allies: UnitView[];
  focus: UnitView | null;
  /** 隊友已經決定的機動：終點與路徑上各時間點的位置（同時移動，要錯開） */
  planned: { id: string; pos: Vec; facing: number; r: number; track: Vec[] }[];
  obstacles: Obstacle[];
  /** 兩隊已經在彼此射程內（交火中）；還沒交火時要整隊推進 */
  engaged: boolean;
  /** 每台敵機下回合會被哪些隊友打到（隊友用已決定的終點，還沒決定的用預測位置） */
  support: Map<string, Set<string>>;
  /** 最落後的隊友（已決定或預測）離集火目標的距離；還沒交火時不要比它近太多 */
  mateRear: number;
  /** 還沒交火時各機體的集結位置：集火目標前方、我方這一側，一字排開 */
  slots: Map<string, Vec>;
  /** 有地圖目標的機體：要去的位置、到了要不要停住（達陣要停住，據點只要在圈內） */
  objective: Map<string, { pos: Vec; r: number; stop: boolean }>;
  /** 自己的旗艦（斬首時要保護） */
  flagship: string | null;
}

/** 集結點離集火目標的距離（大約在中距離帶外緣，還沒進入對方有效射程） */
const RALLY_DIST = 8;

/** 繞過大隕石的大概路程：直線被擋住就加上繞過去的距離，讓機體知道要提早往旁邊繞 */
function navDist(a: Vec, b: Vec, r: number, obstacles: Obstacle[]): number {
  let d = dist(a, b);
  const ab = sub(b, a);
  const len2 = ab.x * ab.x + ab.y * ab.y || 1;
  for (const o of obstacles) {
    if (o.kind !== 'rock' && o.kind !== 'building') continue;
    const t = Math.max(0, Math.min(1, ((o.x - a.x) * ab.x + (o.y - a.y) * ab.y) / len2));
    const gap = dist({ x: a.x + ab.x * t, y: a.y + ab.y * t }, o) - o.r - r;
    if (gap < 0.5) d += (0.5 - gap) * 2 + o.r;
  }
  return d;
}

/** 從 pos 打集火目標的期望傷害 */
const offenseOn = (u: UnitView, pos: Vec, facing: number, team: TeamPlan, skill: number) =>
  team.focus ? expectedDamage(u, pos, facing, team.focus, predict(team.focus), team.focus.facing, team.obstacles, skill, null) : 0;

const centroid = (us: { pos: Vec }[]): Vec => ({ x: us.reduce((n, u) => n + u.pos.x, 0) / us.length, y: us.reduce((n, u) => n + u.pos.y, 0) / us.length });

/** 這台以外的隊友下回合大概在哪：已決定的用終點，還沒決定的照動能往前猜 */
function matePoses(u: UnitView, team: TeamPlan): { id: string; pos: Vec; facing: number; unit: UnitView }[] {
  return team.allies
    .filter((a) => a.id !== u.id)
    .map((a) => {
      const pl = team.planned.find((p) => p.id === a.id);
      return { id: a.id, pos: pl ? pl.pos : predict(a), facing: pl ? pl.facing : a.facing, unit: a };
    });
}

/** 輪到 u 決定機動前，算好隊友能支援哪些敵機、隊友的最前線 */
function prepareTeam(u: UnitView, team: TeamPlan): void {
  const mates = matePoses(u, team);
  team.support = new Map(
    team.enemies.map((e) => [e.id, new Set(mates.filter((m) => expectedDamage(m.unit, m.pos, m.facing, e, predict(e), e.facing, team.obstacles, ASSUMED_SKILL, null) > 0.1).map((m) => m.id))]),
  );
  const f = team.focus ? predict(team.focus) : null;
  team.mateRear = f && mates.length ? Math.max(...mates.map((m) => dist(m.pos, f))) : Infinity;
}

/**
 * 集結位置：在集火目標周圍（我方這一側 ±75°）找一個點，讓大家走得近、打得到集火目標、
 * 又盡量不被其他敵機打到（離得遠或被大隕石擋住），也就是繞到落單敵機的側翼；各機體照目前左右順序在那裡排開
 */
function rallySlots(own: UnitView[], focus: UnitView | null, enemies: UnitView[], obstacles: Obstacle[]): Map<string, Vec> {
  const slots = new Map<string, Vec>();
  if (!focus || !own.length) return slots;
  const c = centroid(own);
  const rocks = obstacles.filter((o) => o.kind === 'rock');
  const toUs = angleOf(sub(c, focus.pos));
  let best: { back: number; cost: number } | null = null;
  for (let a = -75; a <= 75; a += 15) {
    const back = toUs + a * DEG;
    const r = { x: focus.pos.x + Math.cos(back) * RALLY_DIST, y: focus.pos.y + Math.sin(back) * RALLY_DIST };
    let cost = own.reduce((n, u) => n + dist(u.pos, r), 0) * 0.3;
    if (r.x < 2 || r.y < 2 || r.x > MAP_SIZE - 2 || r.y > MAP_SIZE - 2) cost += 20;
    if (rocks.some((o) => dist(r, o) < o.r + 1.5)) cost += 10;
    if (lineOfFire(obstacles, r, focus.pos) === 'blocked') cost += 8;
    for (const e of enemies) {
      if (e === focus) continue;
      const d = dist(e.pos, r);
      if (d < 11 && lineOfFire(obstacles, e.pos, r) !== 'blocked') cost += (11 - d) * 1.2;
    }
    if (!best || cost < best.cost) best = { back, cost };
  }
  const back = best!.back;
  const rally = { x: focus.pos.x + Math.cos(back) * RALLY_DIST, y: focus.pos.y + Math.sin(back) * RALLY_DIST };
  const side = back + Math.PI / 2;
  const lateral = (u: UnitView) => (u.pos.x - c.x) * Math.cos(side) + (u.pos.y - c.y) * Math.sin(side);
  [...own].sort((a, b) => lateral(a) - lateral(b)).forEach((u, i) => {
    const off = (i - (own.length - 1) / 2) * 2.6;
    slots.set(u.id, { x: rally.x + Math.cos(side) * off, y: rally.y + Math.sin(side) * off });
  });
  return slots;
}

/** 全隊的集火目標：受傷重、威脅大、落單（離它的隊友遠）、我方多台打得到或靠得近的敵機 */
interface FocusHints {
  /** 斬首：敵方旗艦 */
  flagship?: string | null;
  /** 達陣：自己的達陣圈（靠近它的敵機優先處理） */
  guard?: Vec | null;
}

function pickFocus(own: UnitView[], enemies: UnitView[], obstacles: Obstacle[], hints: FocusHints = {}): UnitView | null {
  if (!enemies.length || !own.length) return null;
  const c = centroid(own);
  let best: { e: UnitView; v: number } | null = null;
  for (const e of enemies) {
    const danger = own.reduce((n, u) => n + expectedDamage(e, e.pos, null, u, u.pos, u.facing, obstacles, ASSUMED_SKILL, null), 0);
    const reach = own.filter((u) => dist(u.pos, e.pos) < 10).length;
    const others = enemies.filter((x) => x !== e);
    const alone = others.length ? Math.min(6, Math.min(...others.map((x) => dist(x.pos, e.pos)))) : 0;
    let v = hurtOf(e) * 4 + danger * 0.6 + alone * 0.5 + reach * 0.8 - dist(c, e.pos) * 0.25 + (CHASSIS[e.chassisId]?.cost ?? 0) * 0.1;
    if (hints.flagship === e.id) v += 4;
    if (hints.guard && dist(e.pos, hints.guard) < 7) v += 6 - dist(e.pos, hints.guard) * 0.5;
    if (!best || v > best.v) best = { e, v };
  }
  return best!.e;
}

const TRACK = 12;
function scoreManeuver(u0: UnitView, m: ManeuverSpec, team: TeamPlan, rng: Rng, climb = false): { score: number; end: Vec; facing: number; track: Vec[] } {
  let u = u0;
  const path = buildPath(u, { maneuver: m.id, limiter: false });
  const r = radiusOf(u);
  const rocks = team.obstacles.filter((o) => o.kind === 'rock');
  const blds = team.obstacles.filter((o) => o.kind === 'building');
  // 模擬路徑：撞上大隕石或比自己站的地方高的牆就停在撞點，動能歸零（戰機只降到最低速度）；
  // 攀升時爬得上去的牆就上樓頂，底板離開樓頂就掉下去
  const N = 24;
  let crashAt = -1;
  let z = u.z ?? 0;
  for (let i = 1; i <= N && crashAt < 0; i++) {
    const p = worldPose(path, i / N).pos;
    if (rocks.some((o) => dist(p, o) < o.r + r)) crashAt = i;
    for (const o of blds) {
      if (crashAt >= 0 || o.levels! <= z || wallPenetration(o, p, r) <= 0.05) continue;
      if (climb && o.levels! - z <= climbLimits(u0).levels) z = o.levels!;
      else crashAt = i;
    }
    if (z && !climb && !blds.some((o) => o.levels! >= z && wallPenetration(o, p, r) > 0)) z = Math.max(0, ...blds.filter((o) => o.levels! < z && wallPenetration(o, p, r) > 0).map((o) => o.levels!));
  }
  // 攀升（跳躍）在空中，移動結束才落下
  const endPos = worldPose(path, crashAt < 0 ? 1 : (crashAt - 1) / N).pos;
  if (z && climb && !blds.some((o) => o.levels! >= z && wallPenetration(o, endPos, r) > 0)) z = Math.max(0, ...blds.filter((o) => o.levels! < z && wallPenetration(o, endPos, r) > 0).map((o) => o.levels!));
  // 之後的火力、威脅都照終點的高度算
  if (z !== (u.z ?? 0)) u = { ...u, z: z || undefined };
  const endT = crashAt < 0 ? 1 : (crashAt - 1) / N;
  const endPose = worldPose(path, endT);
  const track = Array.from({ length: TRACK + 1 }, (_, k) => worldPose(path, Math.min(endT, k / TRACK)).pos);
  const pos = endPose.pos;
  const facing = endPose.facing;
  const endMomentum = crashAt < 0 ? m.endMomentum : minSpeedOf(u);
  const margin = 1.2;
  if (pos.x < margin || pos.y < margin || pos.x > MAP_SIZE - margin || pos.y > MAP_SIZE - margin) return { score: -1000, end: pos, facing, track };
  // 攀升多花推進劑：沒有好處就不爬
  let score = climb ? -0.5 : 0;
  if (crashAt >= 0) score -= 12 + Math.max(0, Math.round(path.length) - ROCK_SAFE_SPEED) * 8;
  // 高速穿過隕石群可能被碎石打中
  if (m.speed > DEBRIS_SAFE_SPEED && samplePath(path, 8).some((p) => insideField(team.obstacles, p))) score -= (m.speed - DEBRIS_SAFE_SPEED) * 1.5;

  // 有動能就煞不住：速度越快，離邊緣要留越多煞車距離
  const brake = margin + Math.abs(endMomentum) * 1.2;
  const edgeGap = Math.min(pos.x, pos.y, MAP_SIZE - pos.x, MAP_SIZE - pos.y);
  if (edgeGap < brake) score -= (brake - edgeGap) * 15;
  // 往前看一回合：照這個動能直直飛下去會不會撞上大隕石（停不下來的話更危險）
  const ahead = Math.max(1, Math.abs(endMomentum), minSpeedOf(u));
  const dir = endMomentum < 0 ? facing + Math.PI : facing;
  for (let k = 1; k <= 6; k++) {
    const p = { x: pos.x + Math.cos(dir) * ahead * (k / 6), y: pos.y + Math.sin(dir) * ahead * (k / 6) };
    if (rocks.some((o) => dist(p, o) < o.r + r)) {
      score -= 4 + Math.abs(endMomentum) * 1.5;
      break;
    }
  }

  const hurt = hurtOf(u);
  const pref = preferredRange(u);
  const skill = PILOTS[u.pilotId!]?.skill ?? ASSUMED_SKILL;
  const target = team.focus && !team.focus.hidden ? team.focus : nearest(pos, team.enemies, predict);
  if (target) {
    const tp = predict(target);
    const d = edge(pos, tp);
    // 受傷重的往後退：拉開到更遠的距離
    const want = pref.melee ? 0 : pref.range + hurt * 3 + (team.flagship === u.id ? 2 : 0);
    // 還沒交火時以集結為主，距離只是次要
    score -= Math.abs(d - want) * (pref.melee ? 2 : 1) * (team.engaged ? 1 : 0.4);
    const ang = Math.abs(angleDiff(angleOf(sub(tp, pos)), facing));
    if (pref.melee) score += ang < 60 * DEG ? 2 : 0;
    // 近戰機：停在突進得到的位置；站得比目標高、跳劈得到更好
    if (pref.melee && ang < LUNGE_ARC_DEG * DEG) {
      const dz = z - (target.z ?? 0);
      if (dz === 0 && d <= LUNGE_RANGE) score += 3;
      else if (dz > 0 && d <= JUMP_SLASH_RANGE) score += 3 + Math.min(dz, JUMP_SLASH_MAX_BONUS);
    }
    else score += ang < 45 * DEG ? 2 : -ang;
  }
  // 火力：從終點能打到誰、打多痛（集火目標加權）
  if (!pref.melee) {
    let offense = 0;
    for (const e of team.enemies) {
      const v = expectedDamage(u, pos, facing, e, predict(e), e.facing, team.obstacles, skill, null) * (e === team.focus ? 1.4 : 1);
      offense = Math.max(offense, v);
    }
    score += offense * 3;
  }
  // 威脅：敵機下回合從預測位置打過來的期望傷害（找掩蔽、躲射界），受傷越重越在意
  let threat = 0;
  const foes: UnitView[] = [];
  for (const e of team.enemies) {
    const t = expectedDamage(e, predict(e), null, u, pos, facing, team.obstacles, ASSUMED_SKILL, skill);
    threat += t;
    // 算落單時保守一點：敵機留在原地或照預測前進，任一種打得到就算
    if (t > 0.1 || expectedDamage(e, e.pos, null, u, pos, facing, team.obstacles, ASSUMED_SKILL, skill) > 0.1) foes.push(e);
    if (heldOf(e, 'melee').length && dist(predict(e), pos) < 4) threat += 1;
  }
  // 被咬尾：敵機在我背後又面向我，追擊步驟會多挨一槍
  for (const e of team.enemies) {
    const ep = { pos: predict(e), facing: e.facing };
    if (tailing(ep, { pos, facing })) threat += expectedDamage(e, ep.pos, e.facing, u, pos, facing, team.obstacles, ASSUMED_SKILL, skill);
  }
  score -= threat * (2 + hurt * 3) * (team.flagship === u.id ? 1.6 : 1);
  // 咬住敵機背後：追擊步驟多打一槍
  if (!pref.melee) {
    let tail = 0;
    for (const e of team.enemies) {
      const ep = { pos: predict(e), facing: e.facing };
      if (tailing({ pos, facing }, ep) && edge(pos, ep.pos) <= RANGE_TARGET[2]) tail = Math.max(tail, expectedDamage(u, pos, facing, e, ep.pos, e.facing, team.obstacles, skill, null) * (e === team.focus ? 1.4 : 1));
    }
    score += tail * 3;
  }
  // 以多打少：打得到我的敵機，比「能還擊它們的隊友＋我」多就是落單
  const backers = new Set(foes.flatMap((e) => [...(team.support.get(e.id) ?? [])]));
  const outnumbered = foes.length - (backers.size + 1);
  if (outnumbered > 0) score -= outnumbered * (6 + hurt * 4);
  // 掩蔽：能打到集火目標、又只露給一台敵機（其他被隕石擋住或在射界外）
  if (!pref.melee && foes.length <= 1 && offenseOn(u, pos, facing, team, skill) > 0.1) score += 2;
  // 打得到集火目標、而且這裡我方人多：主動進場
  const advantage = backers.size + 1 - foes.length;
  if (foes.length && advantage > 0 && offenseOn(u, pos, facing, team, skill) > 0.1) score += advantage * 2;
  // 地圖目標：往目標走；達陣要在圈裡停住（動能 0）才算，據點只要在圈裡
  const goal = team.objective.get(u.id);
  if (goal) {
    const d = navDist(pos, goal.pos, r, team.obstacles);
    score -= d * 1.4;
    if (dist(pos, goal.pos) <= goal.r) score += goal.stop ? (endMomentum === 0 ? 12 : 1) : 5;
  }
  // 還沒交火時整隊推進：先到集結位置，而且不要比最落後的隊友靠近集火目標太多
  if (!team.engaged && team.focus && !goal) {
    const slot = team.slots.get(u.id);
    if (slot) score -= navDist(pos, slot, r, team.obstacles) * 1.2;
    const ahead = team.mateRear - dist(pos, predict(team.focus));
    if (Number.isFinite(ahead) && ahead > 3) score -= (ahead - 3) * 1.5;
  }

  // 隊形：不要擠在一起（會互撞），也不要離最近的隊友超過 4.5 格
  // 撞到隊友會擦撞、這回合不能行動，代價很大
  for (const pl of team.planned) {
    if (dist(pl.pos, pos) < pl.r + r + 0.3) score -= 15;
    else if (track.some((p, k) => dist(p, pl.track[k]) < pl.r + r + 0.1)) score -= 15;
    else if (dist(pl.pos, pos) < pl.r + r + 0.8) score -= 3;
  }
  const mates = [...team.planned.map((p) => p.pos), ...team.allies.filter((a) => !team.planned.some((p) => p.id === a.id)).map((a) => a.pos)];
  if (mates.length) {
    const near = Math.min(...mates.map((p) => dist(p, pos)));
    if (near > 4.5) score -= (near - 4.5) * 0.8;
  }

  const cost = maneuverCost(u, m);
  const stress = u.stress ?? 0;
  if (stress + cost.stress > (u.maxStress ?? 5)) score -= 8;
  score -= cost.stress * 0.7;
  score -= cost.propellant * ((u.propellant ?? 0) < 6 ? 2 : 0.5);
  score += rng.next() * 1;
  return { score, end: pos, facing, track };
}

/**
 * 纏鬥選手法：估計對手最可能用的手法（它骰數最多的那種），自己每種手法的骰數加上剋制與被剋的影響、
 * 傷害與一點隨機，挑最好的；快撐不住（壓力快滿或受傷重）時有機會脫離
 */
function pickGrapple(u: UnitView, opp: UnitView | undefined, rng: Rng): GrappleChoice {
  const opts = grappleOptions(u as unknown as UnitState);
  if (opts.length === 1) return opts[0];
  const tired = (u.stress ?? 0) >= (u.maxStress ?? 5) - 1 || hurtOf(u) > 0.7;
  if (tired && rng.next() < 0.5) return 'disengage';
  const oppUse = (t: Technique) => (opp ? techniqueUse(opp, t) : null);
  const oppBest = TECHNIQUES.map((t) => oppUse(t)).filter((x): x is NonNullable<typeof x> => !!x).sort((a, b) => b.dice - a.dice)[0]?.technique;
  const brawler = !!PILOTS[u.pilotId!]?.abilities.includes('brawler');
  let best: { c: GrappleChoice; v: number } | null = null;
  for (const c of opts) {
    if (c === 'disengage') continue;
    const use = techniqueUse(u, c)!;
    let v = use.dice + use.damage * 0.4 + rng.next() * 1.5;
    if (oppBest && BEATS[c] === oppBest) v += COUNTER_DICE;
    if (oppBest && BEATS[oppBest] === c) v -= COUNTER_DICE;
    if (!use.weapon && !brawler) v -= COUNTER_DICE;
    if (!best || v > best.v) best = { c, v };
  }
  return best?.c ?? 'disengage';
}

/**
 * 分派地圖目標：達陣時派最快的 1 台（5 台以上派 2 台；斬首時不派旗艦）去對方達陣圈；
 * 據點時每台去最近、還沒滿兩台的據點
 */
function assignObjectives(view: PlayerView, own: UnitView[]): TeamPlan['objective'] {
  const out: TeamPlan['objective'] = new Map();
  const s = view.state.settings;
  const enemy = (1 - view.you) as PlayerId;
  const free = own.filter((u) => !(s.decapitation && view.state.flagship[view.you] === u.id) && !view.state.grapples.some((g) => g.a === u.id || g.b === u.id));
  if (s.goal) {
    const zone = goalZone(enemy);
    // 已經在圈裡停著的先留著，其餘挑快的、離得近的
    const holder = view.state.objectives.goalHold[view.you]?.unit;
    const runners = [...free].sort((a, b) => (b.id === holder ? 99 : 0) - (a.id === holder ? 99 : 0) || CHASSIS[b.chassisId].maxAccel - CHASSIS[a.chassisId].maxAccel || dist(a.pos, zone) - dist(b.pos, zone));
    for (const u of runners.slice(0, own.length >= 5 ? 2 : 1)) out.set(u.id, { pos: zone, r: GOAL_RADIUS, stop: true });
  }
  if (s.control) {
    const load = new Map<number, number>();
    const pts = controlPoints();
    for (const u of free.filter((x) => !out.has(x.id))) {
      const order = pts.map((p, i) => ({ i, d: dist(u.pos, p) })).sort((a, b) => a.d - b.d);
      const pick = order.find((o) => (load.get(o.i) ?? 0) < 2) ?? order[0];
      load.set(pick.i, (load.get(pick.i) ?? 0) + 1);
      out.set(u.id, { pos: pts[pick.i], r: CONTROL_RADIUS * 0.8, stop: false });
    }
  }
  return out;
}

/**
 * 開戰前的自由部署：左中右三條路線挑一條（前方有大隕石可以掩護的優先），在部署區前緣一字排開、面向敵方；
 * 旗艦放在後排；有達陣時留一台最便宜的守在自己的達陣圈前
 */
export function aiDeploy(view: PlayerView, rng: Rng): PlayerDeploy {
  const out: PlayerDeploy = {};
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active');
  const z = deployZone(view.you);
  const s = view.state.settings;
  const up = view.you === 0 ? 1 : -1;
  const facing = view.you === 0 ? Math.PI / 2 : -Math.PI / 2;
  const front = view.you === 0 ? z.y1 - 0.8 : z.y0 + 0.8;
  const back = front - up * 2.2;
  const rocks = view.state.obstacles.filter((o) => o.kind === 'rock');
  const ahead = front + up * 5;
  const lanes = [MAP_SIZE * 0.25, MAP_SIZE * 0.5, MAP_SIZE * 0.75].map((x) => ({
    x,
    v: rocks.filter((o) => Math.abs(o.x - x) < 4 && Math.abs(o.y - ahead) < 4).length * 2 + (s.goal && x === MAP_SIZE / 2 ? 1 : 0) + rng.next() * 1.5,
  }));
  const lane = lanes.sort((a, b) => b.v - a.v)[0].x;
  const flag = s.decapitation ? view.state.flagship[view.you] : null;
  const guard = s.goal && own.length >= 4 ? [...own].filter((u) => u.id !== flag).sort((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0]?.id : undefined;
  const momentum = (u: UnitView) => Math.max(1, minSpeedOf(u));
  const clampX = (x: number) => Math.max(z.x0 + 0.8, Math.min(z.x1 - 0.8, x));
  const line = own.filter((u) => u.id !== flag && u.id !== guard);
  line.forEach((u, i) => {
    const k = i === 0 ? 0 : Math.ceil(i / 2) * (i % 2 ? -1 : 1);
    out[u.id] = { x: clampX(lane + k * 2.8), y: front, facing, momentum: momentum(u) };
  });
  const flagU = own.find((u) => u.id === flag);
  if (flagU) out[flagU.id] = { x: clampX(lane), y: back, facing, momentum: momentum(flagU) };
  const guardU = own.find((u) => u.id === guard);
  if (guardU) {
    const gz = goalZone(view.you);
    out[guardU.id] = { x: clampX(gz.x + (lane < gz.x ? 2 : -2)), y: back, facing, momentum: momentum(guardU) };
  }
  // 擠到一起時在附近找空位：左右錯開、或往後一排（有限次數，找不到就留在原地）
  const placed: { x: number; y: number; r: number }[] = [];
  for (const u of own) {
    const d = out[u.id];
    const r = radiusOf(u);
    // 間隔照實際底板半徑，留一點空隙
    const free = (x: number, y: number) => !placed.some((q) => Math.hypot(q.x - x, q.y - y) < q.r + r + 0.4);
    if (!free(d.x, d.y)) {
      // 部署區切成格子，挑離原本位置最近的空格
      const spots: { x: number; y: number }[] = [];
      for (let x = z.x0 + 0.8; x <= z.x1 - 0.8; x += 1.3) for (let y = z.y0 + 0.6; y <= z.y1 - 0.6; y += 1.3) spots.push({ x, y });
      const spot = spots.filter((q) => free(q.x, q.y)).sort((a, b) => Math.hypot(a.x - d.x, a.y - d.y) - Math.hypot(b.x - d.x, b.y - d.y))[0];
      if (spot) {
        d.x = Math.round(spot.x * 10) / 10;
        d.y = Math.round(spot.y * 10) / 10;
      }
    }
    placed.push({ x: d.x, y: d.y, r });
  }
  return out;
}

/** 該不該拋棄外裝甲：最近的敵機進到 4 格內，或裝甲只剩 2 以下 */
function shouldPurge(u: UnitView, enemies: UnitView[]): boolean {
  if (!armorOf(u)) return false;
  const armor = u.equipment.find((e) => EQUIPMENT[e.defId]?.kind === 'armor' && u.parts[e.id] && !u.parts[e.id].destroyed)!;
  const left = u.parts[armor.id].durability - u.parts[armor.id].damage;
  const near = enemies.length ? Math.min(...enemies.map((e) => edge(u.pos, e.pos))) : Infinity;
  return left <= 2 || near <= 4;
}

/** 依勝利條件給集火的提示 */
function focusHints(view: PlayerView): FocusHints {
  const s = view.state.settings;
  const enemy = (1 - view.you) as PlayerId;
  return { flagship: s.decapitation ? view.state.flagship[enemy] : null, guard: s.goal ? goalZone(view.you) : null };
}

/** 依目前的步驟出指令（部署、移動、王牌移動、追擊、動作） */
export function aiOrders(view: PlayerView, rng: Rng): PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy {
  if (view.phase === 'deploy') return aiDeploy(view, rng);
  if (view.phase === 'move') return aiMoves(view, rng);
  if (view.phase === 'ace') return aiAceMoves(view, rng);
  if (view.phase === 'pursuit') return aiPursuits(view);
  return aiActions(view, rng);
}

/** 自己的駕駛有沒有王牌移動、會不會因為擱置付壓力而太危險 */
function shouldDefer(u: UnitView, grappled: boolean): boolean {
  const p = PILOTS[u.pilotId!];
  if (!p?.abilities.includes('ace_move') || grappled) return false;
  // 新人類擱置可能要付壓力：快到上限就不冒險
  return !(p.abilities.includes('newtype') && (u.stress ?? 0) + 1 >= (u.maxStress ?? 5));
}

export function aiMoves(view: PlayerView, rng: Rng): PlayerMoves {
  return planMoves(view, rng, 'move');
}

/** 王牌移動步驟：其他人都已經動完，只剩擱置的機體（雙方的王牌同時下指令） */
export function aiAceMoves(view: PlayerView, rng: Rng): PlayerMoves {
  settled = new Set(view.state.units.filter((u) => !view.state.deferred.includes(u.id)).map((u) => u.id));
  try {
    return planMoves(view, rng, 'ace');
  } finally {
    settled = null;
  }
}

function planMoves(view: PlayerView, rng: Rng, step: 'move' | 'ace'): PlayerMoves {
  const active = view.state.units.filter((u) => u.owner === view.you && u.status === 'active');
  const deciding = new Set(step === 'ace' ? (view.aceUnits ?? []) : active.map((u) => u.id));
  const own = active;
  const seen = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active' && !u.hidden);
  const enemies = seen.length ? seen : view.state.units.filter((u) => u.owner !== view.you && u.status === 'active');
  const grappled = new Set(view.state.grapples.flatMap((g) => [g.a, g.b]));
  // 交火中：任一台敵機下回合打得到我方任一台
  const engaged = enemies.some((e) => own.some((u) => expectedDamage(e, predict(e), null, u, u.pos, u.facing, view.state.obstacles, ASSUMED_SKILL, null) > 0.1));
  const team: TeamPlan = {
    enemies,
    allies: own,
    focus: pickFocus(own, enemies, view.state.obstacles, focusHints(view)),
    planned: [],
    obstacles: view.state.obstacles,
    engaged,
    support: new Map(),
    mateRear: Infinity,
    slots: new Map(),
    objective: assignObjectives(view, own),
    flagship: view.state.settings.decapitation ? view.state.flagship[view.you] : null,
  };
  team.slots = rallySlots(own.filter((u) => !team.objective.has(u.id)), team.focus, enemies, view.state.obstacles);
  // 完全不知道敵人在哪（自由部署後還沒發現）：保持隊形往對面推進搜索
  if (!enemies.length)
    for (const u of own)
      if (!team.objective.has(u.id)) team.objective.set(u.id, { pos: { x: MAP_SIZE / 2 + (u.pos.x - MAP_SIZE / 2) * 0.6, y: view.you === 0 ? MAP_SIZE * 0.62 : MAP_SIZE * 0.38 }, r: 2, stop: false });
  const out: PlayerMoves = {};
  const base: MovePlan = { maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false };
  // 受傷重的先決定位置（讓它先找好掩蔽），其餘照順序
  const order = [...own].sort((a, b) => hurtOf(b) - hurtOf(a));
  const chosen = new Map<string, ManeuverSpec>();
  const climbing = new Set<string>();
  const choose = (u: UnitView) => {
    team.planned = team.planned.filter((p) => p.id !== u.id);
    prepareTeam(u, team);
    const options = availableManeuvers(u);
    let best: { score: number; end: Vec; facing: number; track?: Vec[]; m: ManeuverSpec; climb?: boolean } = { score: -Infinity, end: u.pos, facing: u.facing, m: options[0] ?? parseManeuver(cruiseManeuver(u)) };
    for (const m of options) {
      const s = scoreManeuver(u, m, team, rng);
      if (s.score > best.score) best = { ...s, m, climb: false };
      // 慢速時也試試攀升（城市裡上樓頂居高臨下）
      if (team.obstacles.some((o) => o.kind === 'building') && !climbBlocked(u as unknown as UnitState, { maneuver: m.id })) {
        const c = scoreManeuver(u, m, team, rng, true);
        if (c.score > best.score) best = { ...c, m, climb: true };
      }
    }
    if (best.climb) climbing.add(u.id);
    else climbing.delete(u.id);
    team.planned.push({ id: u.id, pos: best.end, facing: best.facing, r: radiusOf(u), track: best.track ?? [u.pos] });
    chosen.set(u.id, best.m);
  };
  // 留在原地的隊友（纏鬥中、這一步擱置的王牌、王牌移動步驟裡已經動完的）：隊友要繞開
  const deferNow = new Set(step === 'move' ? order.filter((u) => shouldDefer(u, grappled.has(u.id))).map((u) => u.id) : []);
  const still = (u: UnitView) => grappled.has(u.id) || deferNow.has(u.id) || !deciding.has(u.id);
  for (const u of order.filter(still)) team.planned.push({ id: u.id, pos: u.pos, facing: u.facing, r: radiusOf(u), track: Array.from({ length: TRACK + 1 }, () => u.pos) });
  // 想兩輪：第一輪先決定的機體只能猜後面的隊友會去哪；第二輪每台都知道隊友實際的打算，再重新決定一次
  const free = order.filter((x) => !still(x));
  for (let round = 0; round < 2; round++) for (const u of free) choose(u);

  for (const u of order) {
    if (!deciding.has(u.id)) continue;
    if (grappled.has(u.id)) {
      out[u.id] = { ...base };
      continue;
    }
    if (deferNow.has(u.id)) {
      out[u.id] = { ...base, defer: true };
      continue;
    }
    const best = { m: chosen.get(u.id)! };
    const plan: MovePlan = { ...base, maneuver: best.m.id, ...(climbing.has(u.id) ? { climb: true } : {}) };
    // 外裝甲：穿著只能用頭部火神砲；敵機靠近要開打、或裝甲快被打光時就拋棄
    if (shouldPurge(u, enemies)) plan.purge = true;
    const target = nearest(u.pos, enemies);
    const d = target ? edge(u.pos, target.pos) : Infinity;
    // 懸停時轉身面向最近的敵人
    if (best.m.kind === 'hover' && target) {
      const want = angleOf(sub(target.pos, u.pos));
      plan.facingOffset = [...FACING_OFFSETS].filter((f) => !isShip(u) || Math.abs(f) <= SHIP_TURN_MAX_DEG).sort((a, b) => Math.abs(angleDiff(want, u.facing + a * DEG)) - Math.abs(angleDiff(want, u.facing + b * DEG)))[0];
    }
    // 拿刀且敵人在 8 格內就近戰；沒拿刀、附近有拿刀的敵人、而且這回合走得慢，有機會改近戰姿態站穩承受衝擊（重機比較愛用）
    const swordsman = enemies.some((e) => heldOf(e, 'melee').length && edge(u.pos, e.pos) < 8);
    const braceChance = 0.35 + 0.15 * (CHASSIS[u.chassisId].weightClass - 2);
    let stance: Stance = 'shoot';
    if (heldOf(u, 'melee').length && d < 8) stance = 'melee';
    else if (swordsman && moveSpeed(plan) <= SLOW_MAX_SPEED && rng.next() < braceChance) stance = 'melee';
    plan.stance = closeCombatOf(u) ? stance : 'shoot';
    const pods = aiPodMoves(view, u, team.focus ?? target, enemies);
    if (pods) plan.pods = pods;
    out[u.id] = plan;
  }
  return out;
}

/** 炮群的攻擊位置：目標背後近距離（閃過正面的盾） */
const podSpot = (t: UnitView): Vec => ({ x: t.pos.x - Math.cos(t.facing) * (radiusOf(t) + 2.5), y: t.pos.y - Math.sin(t.facing) * (radiusOf(t) + 2.5) });

/** 感應武器的移動指令：敵人夠近就放出去繞到目標背後；無線炮群能量用完就收回 */
function aiPodMoves(view: PlayerView, u: UnitView, focus: UnitView | null, enemies: UnitView[]): MovePlan['pods'] | null {
  const pilot = PILOTS[u.pilotId!];
  if (!pilot?.abilities.some((a) => a === 'newtype' || a === 'cyber_newtype') || (view.state.settings.environment ?? 'space') !== 'space') return null;
  const out: NonNullable<MovePlan['pods']> = {};
  for (const e of u.equipment) {
    const ps = EQUIPMENT[e.defId]?.psycommu;
    if (!ps || !equipAlive(u, e)) continue;
    if (e.pod) {
      if (e.pod.charge !== undefined && e.pod.charge <= 0) out[e.id] = { recall: true };
      else if (focus) out[e.id] = { to: podSpot(focus) };
      continue;
    }
    if ((e.readyTurn ?? 0) > view.state.turn || (e.bits ?? ps.count) <= 0 || !focus) continue;
    if (dist(u.pos, focus.pos) <= ps.range + ps.move) out[e.id] = { to: podSpot(focus) };
  }
  return Object.keys(out).length ? out : null;
}

/** 指揮炮群：每個炮群挑命中期望最高的敵機；回傳線控與無線的指令，以及無線炮群的期望值 */
function aiPodActions(view: PlayerView, u: UnitView, enemies: UnitView[], focus: UnitView | null): { wired: Record<string, string[]>; wireless: Record<string, string[]>; value: number } {
  const res = { wired: {} as Record<string, string[]>, wireless: {} as Record<string, string[]>, value: 0 };
  const skill = PILOTS[u.pilotId!]?.skill ?? 1;
  for (const e of u.equipment) {
    const ps = EQUIPMENT[e.defId]?.psycommu;
    if (!ps || !e.pod || (e.pod.charge !== undefined && e.pod.charge <= 0) || dist(u.pos, e.pod.pos) > ps.range || u.blackout) continue;
    const def = EQUIPMENT[e.defId];
    let best: { t: UnitView; v: number } | null = null;
    for (const t of enemies) {
      const at = e.pod.pos;
      const h = hitChance({ attacker: { ...u, pos: at, facing: angleOf(sub(t.pos, at)) }, attackerSkill: skill, weapon: def, target: t, targetSkill: null, relSpeed: null, shooterMelee: false, cover: lineOfFire(view.state.obstacles, at, t.pos) });
      if (!h || h.chance < 10) continue;
      const v = hitValue(h.chance) * (def.damage ?? 1) * (def.shots ?? 1) * (e.bits ?? ps.count) * (t === focus ? 1.4 : 1) * (1 + hurtOf(t) * 0.8);
      if (!best || v > best.v) best = { t, v };
    }
    if (!best) continue;
    if (ps.wired) res.wired[e.id] = [best.t.id];
    else {
      res.wireless[e.id] = [best.t.id];
      res.value += best.v;
    }
  }
  return res;
}

/** 追擊步驟：每台能追擊的機體挑期望傷害最高的一槍（集火目標、受傷的敵機加權） */
export function aiPursuits(view: PlayerView): PlayerPursuits {
  const out: PlayerPursuits = {};
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active');
  const enemies = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active' && !u.hidden);
  const focus = pickFocus(own, enemies, view.state.obstacles, focusHints(view));
  for (const [id, opts] of Object.entries(view.pursuit ?? {})) {
    let best: { o: (typeof opts)[number]; v: number } | null = null;
    for (const o of opts) {
      const u = own.find((x) => x.id === id);
      const t = enemies.find((x) => x.id === o.target);
      const w = u?.equipment.find((e) => e.id === o.weapon);
      if (!u || !t || !w) continue;
      const def = EQUIPMENT[w.defId];
      const v = hitValue(o.chance) * (def.damage ?? 1) * (def.shots ?? 1) * (t === focus ? 1.4 : 1) * (1 + hurtOf(t) * 0.8);
      if (!best || v > best.v) best = { o, v };
    }
    out[id] = best && best.o.chance >= 10 ? { weapon: best.o.weapon, target: best.o.target } : null;
  }
  return out;
}

export function aiActions(view: PlayerView, rng: Rng): PlayerActions {
  const own = view.state.units.filter((u) => u.owner === view.you && u.status === 'active' && !view.state.bumped.includes(u.id));
  const enemies = view.state.units.filter((u) => u.owner !== view.you && u.status === 'active' && !u.hidden);
  const out: PlayerActions = {};
  const focus = pickFocus(own, enemies, view.state.obstacles, focusHints(view));
  const aimed: Record<string, number> = {};
  for (const u of own) {
    // 戰艦：每座砲塔各自挑期望傷害最高的目標（集火目標、受傷的加權）
    if (isShip(u)) {
      const salvo: Record<string, string> = {};
      const skill = PILOTS[u.pilotId!]?.skill ?? 1;
      for (const w of readyRanged(u as unknown as UnitState)) {
        const def = EQUIPMENT[w.defId];
        if (!def.tags?.includes('turret') || (w.ammo !== undefined && w.ammo <= 0)) continue;
        let best: { t: UnitView; v: number } | null = null;
        for (const t of enemies) {
          const h = hitChance({ attacker: u, attackerSkill: skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view.state.velocity, u.id, t.id), shooterMelee: false, cover: lineOfFire(view.state.obstacles, u.pos, t.pos, u.z, t.z) });
          if (!h || h.chance < 10) continue;
          const v = hitValue(h.chance) * (def.damage ?? 1) * (def.shots ?? 1) * (t === focus ? 1.4 : 1) * (1 + hurtOf(t) * 0.8);
          if (!best || v > best.v) best = { t, v };
        }
        if (best) salvo[w.id] = best.t.id;
      }
      out[u.id] = { action: { type: 'none' }, ...(Object.keys(salvo).length ? { salvo } : {}) };
      continue;
    }
    // 纏鬥中：不能射擊，手上沒近戰武器就拔出來，再選手法（所有射擊之後才結算）
    const g = view.state.grapples.find((x) => x.a === u.id || x.b === u.id);
    if (g) {
      const opp = view.state.units.find((x) => x.id === (g.a === u.id ? g.b : g.a));
      const plan: ActionPlan = { action: { type: 'none' }, grapple: pickGrapple(u, opp, rng) };
      const blade = stowedOf(u, 'melee')[0];
      if (canHold(u) && !heldOf(u, 'melee').length && blade) plan.swaps = { [drawHand(u, undefined, blade.id)]: blade.id };
      out[u.id] = plan;
      continue;
    }
    const skill = PILOTS[u.pilotId!]?.skill ?? 1;
    let shot: { weapon: EquipState; target: UnitView; value: number; chance: number } | null = null;
    for (const w of heldOf(u, 'ranged')) {
      const def = EQUIPMENT[w.defId];
      // 眩光要靠隊友接著開火才划算；AI 還不會整體協調，先不用
      if (def.tags?.includes('dazzle')) continue;
      for (const t of enemies) {
        const h = hitChance({ attacker: u, attackerSkill: skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view.state.velocity, u.id, t.id), shooterMelee: view.state.stance[u.id] === 'melee', cover: lineOfFire(view.state.obstacles, u.pos, t.pos, u.z, t.z) });
        if (!h || (w.ammo !== undefined && w.ammo <= 0)) continue;
        // 集火：集火目標、受傷的、隊友已經瞄準的敵機加權
        // 誤擊風險：打到隊友的部分要倒扣，太容易打到隊友就不開火
        const risk = 2 * aimShare(view, t) - 1;
        if (risk < 0.2) continue;
        const weight = (t === focus ? 1.4 : 1) * (1 + hurtOf(t) * 0.8) * (1 + (aimed[t.id] ?? 0) * 0.2) * risk;
        const value = hitValue(h.chance) * (def.damage ?? 1) * (def.shots ?? 1) * weight + rng.next() * 0.2;
        if (!shot || value > shot.value) shot = { weapon: w, target: t, value, chance: h.chance };
      }
    }
    const plan: ActionPlan = { action: { type: 'none' } };
    const near = nearest(u.pos, enemies);
    const d = near ? edge(u.pos, near.pos) : Infinity;
    // 鎖定對象：集火目標優先，其次最近的；要在鎖定距離內、還沒鎖上
    const lockable = (t: UnitView | null) =>
      !!t && !roleLost(u, 'sensor') && u.lockOn !== t.id && !!hitChance({ attacker: u, attackerSkill: 0, weapon: LOCK_PROBE, target: t, targetSkill: null, relSpeed: null, shooterMelee: false });
    const lockTarget = [focus, near].find(lockable) ?? null;
    // 標定：帶標定器、自己這發不好打（或沒槍）時，掃描前方標定敵機讓隊友打；不會暴露位置。
    // 已經標著敵機就不重來（標定會一直持續到超出距離）；看不到的敵機用殘影估計在不在前方
    const designator = roleLost(u, 'sensor') ? undefined : u.equipment.find((e) => EQUIPMENT[e.defId].utility === 'mark' && equipAlive(u, e));
    const holding = view.state.units.some((t) => t.mark?.by === u.id);
    const markable = view.state.units.filter((t) => t.owner !== view.you && t.status === 'active' && !t.mark && inMarkCone(u, t.pos, radiusOf(u) + radiusOf(t))).length;
    const allies = view.state.units.some((x) => x.owner === view.you && x.id !== u.id && x.status === 'active');
    // 突進／跳劈：近戰姿態、手上有近戰武器，砍得到就砍（槍不太好打時）；集火目標、跳劈優先
    const inClinch = (id: string) => view.state.grapples.some((g) => g.a === id || g.b === id);
    const lunge = enemies
      .filter((t) => !inClinch(t.id))
      .map((t) => ({ t, r: lungeCheck(view.state.obstacles, u as unknown as UnitState, t as unknown as UnitState, view.state.stance[u.id]) }))
      .flatMap((x) => (typeof x.r === 'string' ? [] : [{ t: x.t, score: (x.t === focus ? 2 : 1) + x.r.jump + hurtOf(x.t) }]))
      .sort((a, b) => b.score - a.score)[0];
    if (lunge && (!shot || shot.chance < LUNGE_SHOT)) {
      plan.action = { type: 'lunge', target: lunge.t.id };
    } else if (designator && !holding && markable && allies && (!shot || shot.chance < MARK_SHOT)) {
      plan.action = { type: 'mark', weapon: designator.id };
    } else if (shot && shot.chance < LOW_SHOT && lockTarget && u.lockOn !== shot.target.id) {
      // 命中率太低就先鎖定：這發大概打不中，鎖定後下一發 +LOCK_BONUS
      plan.action = { type: 'lock', target: lockTarget.id };
    } else if (shot && shot.chance >= 12) {
      plan.action = { type: 'shoot', weapon: shot.weapon.id, target: shot.target.id };
      aimed[shot.target.id] = (aimed[shot.target.id] ?? 0) + 1;
    } else if (lockTarget && !(canHold(u) && stowedOf(u, 'melee').length && d < 7)) {
      plan.action = { type: 'lock', target: lockTarget.id };
    }
    // 換武器只佔那一側的手：近身了拔近戰武器，手上沒武器就拔射擊武器
    const melee = stowedOf(u, 'melee')[0];
    const gun = stowedOf(u, 'ranged')[0];
    if (canHold(u) && !heldOf(u, 'melee').length && melee && d < 7) plan.swaps = { [drawHand(u, shot?.weapon.id, melee.id)]: melee.id };
    else if (canHold(u) && !heldOf(u, 'ranged').length && !heldOf(u, 'melee').length && gun) plan.swaps = { [drawHand(u, undefined, gun.id)]: gun.id };
    if (plan.action.type === 'shoot') {
      // 同一個目標：其他打得到的武器一起開火（換武器那隻手上的除外）
      const t = shot!.target;
      const benched = new Set(Object.keys(plan.swaps ?? {}).map((h) => u.equipment.find((e) => e.location === h)?.id));
      const guns = heldOf(u, 'ranged').filter((w) => !benched.has(w.id) && (w.ammo === undefined || w.ammo > 0) && !EQUIPMENT[w.defId].tags?.includes('dazzle'));
      const ok = guns.filter((w) => (hitChance({ attacker: u, attackerSkill: skill, weapon: EQUIPMENT[w.defId], target: t, targetSkill: null, relSpeed: relativeSpeed(view.state.velocity, u.id, t.id), shooterMelee: view.state.stance[u.id] === 'melee', cover: lineOfFire(view.state.obstacles, u.pos, t.pos, u.z, t.z) })?.chance ?? 0) >= 12);
      if (!ok.length) plan.action = { type: 'none' };
      else plan.action = { type: 'shoot', weapon: ok[0].id, target: t.id, ...(ok.length > 1 ? { also: ok.slice(1).map((w) => w.id) } : {}) };
    }
    // 炮群：線控的一律一起開火；無線的比自己開火划算才指揮（會用掉行動）
    const pods = aiPodActions(view, u, enemies, focus);
    const orders: Record<string, string[]> = { ...pods.wired };
    if (Object.keys(pods.wireless).length && pods.value > (plan.action.type === 'shoot' ? (shot?.value ?? 0) : 0)) {
      Object.assign(orders, pods.wireless);
      plan.action = { type: 'none' };
      if (plan.swaps) delete plan.swaps;
    }
    if (Object.keys(orders).length) plan.pods = orders;
    out[u.id] = plan;
  }
  return out;
}
