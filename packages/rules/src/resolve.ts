import { minSpeedOf, roleLost } from './body';
import * as C from './config';
import { shoot, hitChance, type TurnInfo } from './combat';
import { addStress, spendPropellant, unitById, type Ctx } from './damage';
import { resolveGrapple } from './grapple';
import { parseManeuver } from './maneuvers';
import { simulateMovement } from './movement';
import { lineOfFire } from './terrain';
import { updateSight } from './visibility';
import { Rng } from './rng';
import type { ActionPlan, GameEvent, GameState, MovePlan, PlayerActions, PlayerId, PlayerMoves, Stance, UnitState } from './types';
import { alwaysReady, defaultAction, defaultMove, equipAlive, freeDraw, handUsable, heldItem, pilotOf, planCost, readyRanged } from './unit';

export interface TurnResult {
  state: GameState;
  events: GameEvent[];
}

export const inGrapple = (state: GameState, id: string): boolean => state.grapples.some((g) => g.a === id || g.b === id);

/** 第一步：纏鬥、同時移動。結算後進入動作階段。 */
export function resolveMovement(input: GameState, movesByPlayer: [PlayerMoves, PlayerMoves]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [{ type: 'turnStart', turn: state.turn }] };

  const plans: Record<string, MovePlan> = {};
  for (const u of state.units) {
    if (u.status !== 'active') continue;
    plans[u.id] = movesByPlayer[u.owner][u.id] ?? defaultMove(u);
  }

  const frozen = new Set(state.grapples.flatMap((g) => [g.a, g.b]));
  const stance: Record<string, Stance> = {};
  for (const u of state.units) {
    const plan = plans[u.id];
    if (!plan) continue;
    stance[u.id] = frozen.has(u.id) ? 'shoot' : plan.stance;
    if (frozen.has(u.id)) continue;
    const cost = planCost(u, plan);
    spendPropellant(ctx, u, Math.min(cost.propellant, u.propellant));
    addStress(ctx, u, cost.stress, plan.limiter ? '機動負荷（限制器解除）' : '機動負荷');
  }

  // 1. 纏鬥
  for (const g of [...state.grapples]) {
    const a = unitById(ctx, g.a);
    const b = unitById(ctx, g.b);
    if (a.status !== 'active' || b.status !== 'active') {
      state.grapples = state.grapples.filter((x) => x !== g);
      continue;
    }
    resolveGrapple(ctx, g, a, b, plans[a.id]?.grapple, plans[b.id]?.grapple);
  }

  // 2. 同時移動
  const { bumped, velocity, stopped } = simulateMovement(ctx, plans, stance, frozen);
  // 動能：照機動的終速延續到下回合；被擋停、撞開或纏鬥中歸零（有最低速度的戰機只降到最低速度，引擎還在推）
  for (const u of state.units) {
    const plan = plans[u.id];
    if (u.status !== 'active' || !plan) continue;
    const end = frozen.has(u.id) || stopped.has(u.id) ? 0 : parseManeuver(plan.maneuver).endMomentum;
    const min = minSpeedOf(u);
    u.momentum = min > 0 ? Math.max(min, end) : end;
  }
  for (const u of state.units) {
    if (u.status === 'active' && (u.pos.x < 0 || u.pos.y < 0 || u.pos.x > C.MAP_SIZE || u.pos.y > C.MAP_SIZE)) {
      u.status = 'withdrawn';
      ctx.events.push({ type: 'status', unit: u.id, status: 'withdrawn' });
    }
  }

  state.phase = 'action';
  state.turnInfo = { stance, velocity, bumped: [...bumped] };
  updateSight(state);
  checkWinner(ctx, false);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 第二步：看到移動結果後選的動作，技能高者先結算；接著回合結束。 */
export function resolveActions(input: GameState, actionsByPlayer: [PlayerActions, PlayerActions]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const info = state.turnInfo ?? { stance: {}, velocity: {}, bumped: [] };
  const turn: TurnInfo = { stance: info.stance, velocity: info.velocity };
  const bumped = new Set(info.bumped);
  // 開火或鎖定會暴露位置
  const revealed = new Set<string>();

  const order = state.units
    .filter((u) => u.status === 'active')
    .map((u) => ({ u, skill: pilotOf(u).skill, tie: rng.next() }))
    .sort((x, y) => y.skill - x.skill || x.tie - y.tie)
    .map((x) => x.u);
  for (const u of order) {
    if (u.status !== 'active') continue;
    const plan = actionsByPlayer[u.owner][u.id] ?? defaultAction();
    if (bumped.has(u.id)) {
      if (plan.action.type !== 'none' || plan.swap) ctx.events.push({ type: 'actionFail', unit: u.id, reason: '擦撞，無法行動' });
      continue;
    }
    let actionUsed = false;
    if (plan.swap) {
      const drawn = u.equipment.find((e) => e.id === plan.swap!.equip);
      doSwap(ctx, u, plan.swap.hand, plan.swap.equip);
      actionUsed = !(drawn ? freeDraw(u, drawn) : pilotOf(u).abilities.includes('quick_draw'));
    }
    if (plan.action.type === 'none') continue;
    if (actionUsed) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '換武器用掉了動作' });
      continue;
    }
    if (doAction(ctx, turn, u, plan)) revealed.add(u.id);
  }

  // 回合結束：壓力分級、恢復
  for (const u of state.units) {
    if (u.status !== 'active') continue;
    const over = u.stress - u.maxStress;
    u.blackout = over > C.BLACKOUT_OVER;
    if (over >= C.UNCONSCIOUS_OVER) {
      u.status = 'unconscious';
      ctx.events.push({ type: 'pilot', unit: u.id, state: 'unconscious' });
      ctx.events.push({ type: 'status', unit: u.id, status: 'disabled' });
      continue;
    }
    if (over >= C.INJURED_OVER) {
      u.maxStress = Math.max(1, u.maxStress - C.INJURY_MAX_PENALTY);
      ctx.events.push({ type: 'pilot', unit: u.id, state: 'injured' });
    }
    if (u.blackout) ctx.events.push({ type: 'pilot', unit: u.id, state: 'blackout' });
    const rec = Math.min(u.stress, pilotOf(u).recovery);
    if (rec > 0) addStress(ctx, u, -rec, '恢復');
  }
  state.grapples = state.grapples.filter((g) => unitById(ctx, g.a).status === 'active' && unitById(ctx, g.b).status === 'active');

  state.phase = 'move';
  state.turnInfo = null;
  updateSight(state, revealed);
  if (!checkWinner(ctx, true)) state.turn++;
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 一方全滅（或快速勝負時先少一台）就結束；回合結束時另外檢查回合上限 */
function checkWinner(ctx: Ctx, endOfTurn: boolean): boolean {
  const { state } = ctx;
  const alive = [0, 1].map((p) => state.units.filter((u) => u.owner === p && u.status === 'active').length);
  const lost = [0, 1].map((p) => state.units.filter((u) => u.owner === p && u.status !== 'active').length);
  const firstLoss = C.WIN_ON_FIRST_LOSS && (lost[0] > 0 || lost[1] > 0);
  if (!firstLoss && alive[0] > 0 && alive[1] > 0 && !(endOfTurn && state.turn >= C.TURN_LIMIT)) return false;
  if (firstLoss) state.winner = lost[0] === lost[1] ? 'draw' : ((lost[0] < lost[1] ? 0 : 1) as PlayerId);
  else state.winner = alive[0] === alive[1] ? 'draw' : ((alive[0] > alive[1] ? 0 : 1) as PlayerId);
  ctx.events.push({ type: 'gameOver', winner: state.winner });
  return true;
}

/** 整回合（移動＋動作），測試與批次模擬用 */
export function resolveTurn(input: GameState, moves: [PlayerMoves, PlayerMoves], actions: [PlayerActions, PlayerActions] = [{}, {}]): TurnResult {
  const m = resolveMovement(input, moves);
  if (m.state.winner !== null) return m;
  const a = resolveActions(m.state, actions);
  return { state: a.state, events: [...m.events, ...a.events] };
}

function doSwap(ctx: Ctx, u: UnitState, hand: 'right' | 'left', equipId: string | null) {
  if (!handUsable(u, hand)) return;
  const current = heldItem(u, hand);
  if (current?.id === equipId) return;
  const next = equipId ? u.equipment.find((e) => e.id === equipId && !alwaysReady(e) && equipAlive(u, e)) : null;
  if (equipId && !next) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '裝備已損壞，無法換上' });
    return;
  }
  if (current) current.location = current.home ?? 'stowed';
  if (next) {
    next.location = hand;
    next.revealed = true;
  }
  ctx.events.push({ type: 'swap', unit: u.id, hand, equip: next?.id ?? null });
}

/** 回傳 true 表示有開火或鎖定（會暴露位置） */
function doAction(ctx: Ctx, turn: TurnInfo, u: UnitState, plan: ActionPlan): boolean {
  const action = plan.action;
  if (action.type === 'none') return false;
  const target = ctx.state.units.find((x) => x.id === action.target);
  if (!target || target.status !== 'active') {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標已失去戰鬥能力' });
    return false;
  }
  if (!ctx.state.visible[u.owner].includes(target.id)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '看不到目標' });
    return false;
  }
  if (action.type === 'lock') {
    if (roleLost(u, 'sensor')) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '感測部位損壞，無法鎖定' });
      return false;
    }
    const band = hitChance({ attacker: u, attackerSkill: 0, weapon: { id: '', name: '', kind: 'ranged', weight: 0, durability: 0, ranges: { 1: 0, 2: 0, 3: 0 } }, target, targetSkill: null, relSpeed: null, shooterMelee: false });
    if (!band) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '目標超出鎖定距離' });
      return false;
    }
    u.lockOn = target.id;
    ctx.events.push({ type: 'lock', unit: u.id, target: target.id });
    return true;
  }
  const weapon = readyRanged(u).find((e) => e.id === action.weapon);
  if (!weapon) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '沒有可用的射擊武器' });
    return false;
  }
  if (weapon.ammo !== undefined && weapon.ammo <= 0) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '彈藥耗盡' });
    return false;
  }
  if (shoot(ctx, turn, u, weapon, target)) return true;
  ctx.events.push({ type: 'actionFail', unit: u.id, reason: lineOfFire(ctx.state.obstacles, u.pos, target.pos) === 'blocked' ? '射擊線被隕石擋住' : '目標不在射程內' });
  return false;
}
