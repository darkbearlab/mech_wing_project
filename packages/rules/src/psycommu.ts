// 感應武器（炮群）：新人類、強化人才能用，只能在宇宙用。
// 移動步驟放出、移動或收回炮群（不用機動盤、沒有動能、不參與碰撞）；行動步驟指揮炮群攻擊：從炮群的位置開火（繞到背後就閃過盾牌）。
// 無線炮群（艾爾美斯）：指揮佔母機的行動；每支有攻擊次數，用完要收回充能。被打中一發就少一支。
// 線控炮群（吉翁克的有線臂）：手臂本身就是炮群；指揮不佔行動，本體可以同時開火（壓力再 +1）；被打中是打那隻手臂。
import * as C from './config';
import { radiusOf } from './body';
import { hitChance, shoot, spendRounds, type TurnInfo } from './combat';
import { addStress, damageUnit, typed, dealtBy, type Ctx } from './damage';
import { EQUIPMENT } from './data';
import { add, dist, normalize, scale, sub } from './geometry';
import { lineOfFire } from './terrain';
import { canSee, sensorRange } from './vision';
import type { EquipState, GameState, MovePlan, PlayerId, PsycommuDef, UnitState, Vec } from './types';
import { equipAlive, pilotOf } from './unit';

export const psycommuOf = (e: EquipState): PsycommuDef | undefined => EQUIPMENT[e.defId]?.psycommu;

/** 駕駛能不能用感應武器：新人類或強化人 */
export const canPsycommu = (u: { pilotId: string }): boolean => pilotOf(u).abilities.some((a) => a === 'newtype' || a === 'cyber_newtype');

const spaceOnly = (state: GameState) => (state.settings?.environment ?? 'space') === 'space';

/** 這台機體的感應武器 */
export const psycommuGear = (u: UnitState): EquipState[] => u.equipment.filter((e) => !!psycommuOf(e));

/** 放出去的炮群 */
export const podsOf = (u: UnitState): EquipState[] => psycommuGear(u).filter((e) => !!e.pod);

/** 還剩幾支 */
export const bitsLeft = (e: EquipState): number => e.bits ?? psycommuOf(e)!.count;

/** 現在能不能放出這件感應武器 */
export function launchProblem(state: GameState, u: UnitState, e: EquipState, grappled: boolean): string | null {
  const ps = psycommuOf(e);
  if (!ps) return '不是感應武器';
  if (!canPsycommu(u)) return '駕駛不是新人類或強化人，不能用感應武器';
  if (!spaceOnly(state)) return '感應武器只能在宇宙使用';
  if (e.pod) return null;
  if (grappled) return '纏鬥中不能放出炮群';
  if (!equipAlive(u, e) || bitsLeft(e) <= 0) return '炮群已經沒了';
  if ((e.readyTurn ?? 0) > state.turn) return `充能中（第 ${e.readyTurn} 回合可以再放出）`;
  return null;
}

/** 從 from 往 to 走最多 step */
const toward = (from: Vec, to: Vec, step: number): Vec => {
  const d = dist(from, to);
  return d <= step ? { ...to } : add(from, scale(normalize(sub(to, from)), step));
};

/** 把 p 拉回母機的控制距離內 */
const leash = (mother: Vec, p: Vec, range: number): Vec => (dist(mother, p) <= range ? p : add(mother, scale(normalize(sub(p, mother)), range)));

/** 炮群這一步實際會走到哪：目標點拉回母機（移動後位置）的控制距離內，再從 from 走最多 move */
export const podDestination = (from: Vec, to: Vec, mother: Vec, ps: PsycommuDef): Vec => toward(from, leash(mother, to, ps.range), ps.move);

/**
 * 移動步驟（機體移動之後）：照指令放出、移動或收回炮群。目標點先拉回母機的控制距離內，炮群朝它走最多 move；
 * 走完還在控制距離外就失控（這回合不能指揮）
 */
export function movePods(ctx: Ctx, plans: Record<string, MovePlan>, units: Iterable<string>, grappled: (id: string) => boolean): void {
  for (const id of units) {
    const u = ctx.state.units.find((x) => x.id === id);
    if (!u || u.status !== 'active') continue;
    for (const [equipId, order] of Object.entries(plans[id]?.pods ?? {})) {
      const e = u.equipment.find((x) => x.id === equipId);
      if (!e) continue;
      const ps = psycommuOf(e);
      if (!ps) continue;
      if ('recall' in order) {
        if (!e.pod) continue;
        recall(ctx, u, e);
        continue;
      }
      const problem = launchProblem(ctx.state, u, e, grappled(u.id));
      if (problem) {
        ctx.events.push({ type: 'actionFail', unit: u.id, reason: problem });
        continue;
      }
      const pos = podDestination(e.pod?.pos ?? u.pos, order.to, u.pos, ps);
      if (!e.pod) {
        e.pod = { pos, ...(ps.charge !== undefined ? { charge: ps.charge } : {}) };
        ctx.events.push({ type: 'pod', unit: u.id, equip: e.id, what: 'launch', at: { ...pos } });
      } else e.pod.pos = pos;
    }
  }
}

/** 收回炮群：無線的要充能，線控的手臂裝回去就能再用 */
export function recall(ctx: Ctx, u: UnitState, e: EquipState): void {
  const ps = psycommuOf(e)!;
  delete e.pod;
  e.readyTurn = ps.wired ? ctx.state.turn : ctx.state.turn + 1 + C.PSYCOMMU_RECHARGE_TURNS;
  ctx.events.push({ type: 'pod', unit: u.id, equip: e.id, what: 'recall' });
}

/** 這個炮群現在能不能指揮；不能就回傳原因 */
export function podProblem(u: UnitState, e: EquipState): string | null {
  const ps = psycommuOf(e);
  if (!ps || !e.pod) return '炮群沒有放出去';
  if (u.blackout) return '駕駛黑視，無法指揮炮群';
  if (dist(u.pos, e.pod.pos) > ps.range + 1e-6) return '炮群離母機太遠，失去控制';
  if (e.pod.charge !== undefined && e.pod.charge <= 0) return '炮群能量用完，要收回充能';
  return null;
}

/**
 * 指揮炮群攻擊（行動步驟，輪到母機時）。每個炮群可以分給 1–2 個目標，支數平均分配；每支照武器的 shots 開火。
 * 回傳有沒有開火（會暴露位置）
 */
export function commandPods(ctx: Ctx, turn: TurnInfo, u: UnitState, orders: Record<string, string[]>): { fired: boolean; wired: boolean } {
  let fired = false;
  let wired = false;
  for (const [equipId, targets] of Object.entries(orders)) {
    const e = u.equipment.find((x) => x.id === equipId);
    if (!e) continue;
    const problem = podProblem(u, e);
    if (problem) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: problem });
      continue;
    }
    const ps = psycommuOf(e)!;
    const def = EQUIPMENT[e.defId];
    const list = targets.slice(0, 2);
    const bits = bitsLeft(e);
    let any = false;
    list.forEach((tid, i) => {
      const n = Math.floor(bits / list.length) + (i < bits % list.length ? 1 : 0);
      const target = ctx.state.units.find((x) => x.id === tid);
      if (!n || !target || target.status !== 'active' || target.owner === u.owner) return;
      if (!ctx.state.visible[u.owner].includes(target.id)) {
        ctx.events.push({ type: 'actionFail', unit: u.id, reason: '看不到目標' });
        return;
      }
      // 從炮群的位置、面向目標開火：沒有射界外懲罰，也不吃母機的移動與姿態
      const at = e.pod!.pos;
      const shooter: UnitState = { ...u, pos: at, facing: Math.atan2(target.pos.y - at.y, target.pos.x - at.x) };
      const podTurn: TurnInfo = { ...turn, stance: { ...turn.stance, [u.id]: 'shoot' }, velocity: { ...turn.velocity, [u.id]: { x: 0, y: 0 } } };
      if (shoot(ctx, podTurn, shooter, e, target, { shots: n * (def.shots ?? 1), pod: e.id, from: at })) any = true;
      else ctx.events.push({ type: 'actionFail', unit: u.id, reason: lineOfFire(ctx.state.obstacles, at, target.pos) === 'blocked' ? '炮群的射擊線被隕石擋住' : '目標不在炮群射程內' });
      u.lockOn = shooter.lockOn;
    });
    if (any) {
      fired = true;
      if (ps.wired) wired = true;
      if (e.pod && e.pod.charge !== undefined) e.pod.charge--;
    }
  }
  return { fired, wired };
}

/** 被射擊的目標是不是一個炮群：回傳母機與那件感應武器 */
export function findPod(state: GameState, id: string): { mother: UnitState; equip: EquipState } | null {
  for (const u of state.units) {
    const e = u.equipment.find((x) => x.id === id && !!x.pod);
    if (e && u.status === 'active') return { mother: u, equip: e };
  }
  return null;
}

/**
 * 這個炮群 viewer 看不看得到（和母機看不看得到無關）：
 * 線控的手臂跟機體一樣大，照一般視野（感測距離、視線）；無線的只有很近才看得到，新人類感應得到
 */
export function podSeen(state: GameState, mother: UnitState, e: EquipState, viewer: PlayerId): boolean {
  if (mother.owner === viewer) return true;
  const ps = psycommuOf(e);
  if (!ps || !e.pod) return false;
  if (ps.wired) return state.units.some((o) => o.owner === viewer && o.status === 'active' && canSee(state.obstacles, o.pos, sensorRange(o), e.pod!.pos, radiusOf(o) + C.BASE_RADIUS));
  return state.units.some(
    (o) => o.owner === viewer && o.status === 'active' && dist(o.pos, e.pod!.pos) - radiusOf(o) <= (pilotOf(o).abilities.includes('newtype') || pilotOf(o).abilities.includes('cyber_newtype') ? C.POD_SIGHT_NEWTYPE : C.POD_SIGHT),
  );
}

/** 射擊炮群：無線的每發命中打掉一支，線控的打那隻手臂。回傳有沒有開火 */
export function shootPod(ctx: Ctx, turn: TurnInfo, attacker: UnitState, weapon: EquipState, mother: UnitState, e: EquipState): boolean {
  const def = EQUIPMENT[weapon.defId];
  const ps = psycommuOf(e)!;
  const target = { id: e.id, chassisId: '', pos: e.pod!.pos, facing: 0, parts: {}, equipment: [] };
  const h = hitChance({
    attacker,
    attackerSkill: pilotOf(attacker).skill,
    weapon: def,
    target,
    targetSkill: pilotOf(mother).skill,
    relSpeed: null,
    shooterMelee: turn.stance[attacker.id] === 'melee',
    cover: lineOfFire(ctx.state.obstacles, attacker.pos, e.pod!.pos),
    dazzled: turn.dazzled?.has(attacker.id),
    targetEvasion: ps.evasion ?? 0,
  });
  if (!h) return false;
  const shots = spendRounds(weapon, def.shots ?? 1);
  let hits = 0;
  for (let i = 0; i < shots && e.pod; i++) {
    if (ctx.rng.d100() > h.chance) continue;
    hits++;
    if (ps.wired) {
      dealtBy(ctx, attacker, () => typed(ctx, def.damageType ?? 'kinetic', () => damageUnit(ctx, mother, def.damage ?? C.DAMAGE_SCALE, 'focused', e.host)));
      if (!equipAlive(mother, e)) loseBits(ctx, mother, e, attacker.id);
    } else {
      e.bits = bitsLeft(e) - 1;
      ctx.events.push({ type: 'podHit', unit: mother.id, equip: e.id, by: attacker.id, bits: e.bits });
      if (e.bits <= 0) loseBits(ctx, mother, e, attacker.id);
    }
  }
  ctx.events.push({ type: 'shot', attacker: attacker.id, target: e.id, weapon: def.id, band: h.band, shots, hits, blocked: 0, chance: h.chance });
  return true;
}

function loseBits(ctx: Ctx, mother: UnitState, e: EquipState, by?: string): void {
  if (!e.pod) return;
  delete e.pod;
  e.bits = psycommuOf(e)!.wired ? e.bits : 0;
  ctx.events.push({ type: 'pod', unit: mother.id, equip: e.id, what: 'destroyed', ...(by ? { reason: by } : {}) });
}

/** 回合結束：母機退場的炮群消失、線控臂被打壞的消失；放著炮群的駕駛壓力 +1 */
export function podUpkeep(ctx: Ctx): void {
  for (const u of ctx.state.units) {
    const out = podsOf(u);
    if (!out.length) continue;
    if (u.status !== 'active') {
      for (const e of out) loseBits(ctx, u, e);
      continue;
    }
    for (const e of out) if (!equipAlive(u, e)) loseBits(ctx, u, e);
    if (podsOf(u).length) addStress(ctx, u, C.PSYCOMMU_STRESS, '感應炮負荷');
  }
}
