import { minSpeedOf, roleLost } from './body';
import * as C from './config';
import { shoot, hitChance, type TurnInfo } from './combat';
import { addStress, spendPropellant, unitById, type Ctx } from './damage';
import { resolveGrapple } from './grapple';
import { parseManeuver } from './maneuvers';
import { simulateMovement } from './movement';
import { CHASSIS, EQUIPMENT } from './data';
import { lineOfFire } from './terrain';
import { updateSight } from './visibility';
import { Rng } from './rng';
import type { ActionPlan, GameEvent, GameState, MovePlan, PlayerActions, PlayerId, PlayerMoves, PlayerPursuits, PursuitPlan, Stance, UnitState } from './types';
import { anyPursuit, runPursuits } from './pursuit';
import { DEFAULT_SETTINGS, byScore, deployZone, flagshipOf, killScoreOf, scoreObjectives, settleBoth, type WinReason } from './objectives';
import { radiusOf } from './body';
import { DEG, dist } from './geometry';
import type { DeployPlan, PlayerDeploy } from './types';
import { alwaysReady, defaultAction, defaultMove, equipAlive, freeDraw, handUsable, heldItem, pilotOf, planCost, readyRanged } from './unit';

export interface TurnResult {
  state: GameState;
  events: GameEvent[];
}

export const inGrapple = (state: GameState, id: string): boolean => state.grapples.some((g) => g.a === id || g.b === id);

/** 這台能不能擱置移動（王牌移動）：要有能力、不在纏鬥中 */
export const canDefer = (state: GameState, u: UnitState): boolean => pilotOf(u).abilities.includes('ace_move') && !inGrapple(state, u.id);

const isNewtype = (u: UnitState) => pilotOf(u).abilities.includes('newtype');

/** 移動全部結束後：有人能追擊就進追擊步驟，否則直接到動作 */
function afterMovement(ctx: Ctx): void {
  const { state } = ctx;
  state.phase = state.winner === null && anyPursuit(state) ? 'pursuit' : 'action';
  if (state.phase === 'pursuit') ctx.events.push({ type: 'phase', phase: 'pursuit' });
}

/** 拋棄外裝甲（免費）：裝甲部位標成脫落，機體恢復輕快、武器解鎖 */
function purgeArmor(ctx: Ctx, u: UnitState): void {
  const armor = u.equipment.find((e) => EQUIPMENT[e.defId]?.kind === 'armor' && e.location === 'mount' && u.parts[e.id] && !u.parts[e.id].destroyed);
  if (!armor) return;
  u.parts[armor.id].destroyed = true;
  ctx.events.push({ type: 'purge', unit: u.id });
}

/** 敵機靠太近的氣球被識破 */
function exposeDecoys(ctx: Ctx): void {
  const { state } = ctx;
  for (const d of [...(state.decoys ?? [])]) {
    const near = state.units.find((u) => u.owner !== d.owner && u.status === 'active' && dist(u.pos, d.pos) <= C.DECOY_EXPOSE_RANGE + radiusOf(u));
    if (near) popDecoy(ctx, d.id, near.id, '被靠近識破');
  }
}

function popDecoy(ctx: Ctx, id: string, by: string | undefined, reason: string): void {
  ctx.state.decoys = (ctx.state.decoys ?? []).filter((d) => d.id !== id);
  ctx.events.push({ type: 'decoyPop', decoy: id, by, reason });
}

/** 機動的推進劑與壓力 */
function payForMove(ctx: Ctx, u: UnitState, plan: MovePlan): void {
  const cost = planCost(u, plan);
  spendPropellant(ctx, u, Math.min(cost.propellant, u.propellant));
  addStress(ctx, u, cost.stress, plan.limiter ? '機動負荷（限制器解除）' : '機動負荷');
}

/** 移動結算後的動能與出界 */
function settleMomentum(ctx: Ctx, plans: Record<string, MovePlan>, movers: Set<string>, frozen: Set<string>, stopped: Set<string>): void {
  // 動能：照機動的終速延續到下回合；被擋停、撞開或纏鬥中歸零（有最低速度的戰機只降到最低速度，引擎還在推）
  for (const u of ctx.state.units) {
    const plan = plans[u.id];
    if (u.status !== 'active' || !plan || !movers.has(u.id)) continue;
    const end = frozen.has(u.id) || stopped.has(u.id) ? 0 : parseManeuver(plan.maneuver).endMomentum;
    const min = minSpeedOf(u);
    u.momentum = min > 0 ? Math.max(min, end) : end;
  }
  for (const u of ctx.state.units) {
    if (u.status === 'active' && (u.pos.x < 0 || u.pos.y < 0 || u.pos.x > C.MAP_SIZE || u.pos.y > C.MAP_SIZE)) {
      u.status = 'withdrawn';
      ctx.events.push({ type: 'status', unit: u.id, status: 'withdrawn' });
    }
  }
}

/** 第一步：同時移動（擱置的王牌、纏鬥中的機體不動）。之後依序進王牌移動、追擊或動作。 */
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
  // 王牌移動：擱置的機體這一步原地不動，等其他人動完再決定
  const deferred = new Set(state.units.filter((u) => plans[u.id]?.defer && canDefer(state, u)).map((u) => u.id));
  const ntOnSide = (p: PlayerId) => state.units.some((x) => x.owner === p && x.status === 'active' && isNewtype(x));
  const stance: Record<string, Stance> = {};
  for (const u of state.units) {
    const plan = plans[u.id];
    if (!plan) continue;
    stance[u.id] = frozen.has(u.id) || deferred.has(u.id) ? 'shoot' : plan.stance;
    if (deferred.has(u.id)) {
      ctx.events.push({ type: 'defer', unit: u.id });
      // 對方也有新人類在場：互相感應干擾，擱置要付壓力
      if (isNewtype(u) && ntOnSide((1 - u.owner) as PlayerId)) addStress(ctx, u, C.ACE_DEFER_STRESS, '王牌移動（被敵方新人類干擾）');
      continue;
    }
    if (plan.purge) purgeArmor(ctx, u);
    if (frozen.has(u.id)) continue;
    payForMove(ctx, u, plan);
  }

  // 同時移動（纏鬥中的機體不動；纏鬥在動作步驟最後才結算）
  const { bumped, velocity, stopped } = simulateMovement(ctx, plans, stance, new Set([...frozen, ...deferred]));
  const movers = new Set(Object.keys(plans).filter((id) => !deferred.has(id)));
  settleMomentum(ctx, plans, movers, frozen, stopped);

  // 第一步裡被碰撞（擦撞、撞擊、近戰、咬住）的王牌就失去這次王牌移動：敵人已經在眼前，看穿也來不及反應
  exposeDecoys(ctx);
  const hit = new Set([...bumped, ...ctx.events.flatMap((e) => (e.type === 'contact' && e.result !== 'none' ? [e.a, e.b] : []))]);
  for (const id of deferred) if (hit.has(id) && unitById(ctx, id).status === 'active') ctx.events.push({ type: 'actionFail', unit: id, reason: '被碰撞，失去王牌移動' });
  const waiting = [...deferred].filter((id) => unitById(ctx, id).status === 'active' && !hit.has(id) && !inGrapple(state, id));
  state.turnInfo = { stance, velocity, bumped: [...bumped], deferred: waiting };
  updateSight(state);
  checkWinner(ctx, false);
  if (state.winner === null && waiting.length) {
    state.phase = 'ace';
    ctx.events.push({ type: 'phase', phase: 'ace' });
  } else afterMovement(ctx);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 王牌移動步驟：擱置的機體看過其他人的移動結果後再動，其他機體原地不動 */
export function resolveAceMovement(input: GameState, movesByPlayer: [PlayerMoves, PlayerMoves]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const info = state.turnInfo ?? { stance: {}, velocity: {}, bumped: [] };
  const aces = new Set((info.deferred ?? []).filter((id) => unitById(ctx, id).status === 'active'));
  const plans: Record<string, MovePlan> = {};
  const stance: Record<string, Stance> = { ...info.stance };
  for (const id of aces) {
    const u = unitById(ctx, id);
    const plan = { ...(movesByPlayer[u.owner][id] ?? defaultMove(u)), defer: false };
    plans[id] = plan;
    stance[id] = plan.stance;
    if (plan.purge) purgeArmor(ctx, u);
    payForMove(ctx, u, plan);
  }
  const frozen = new Set(state.units.filter((u) => u.status === 'active' && !aces.has(u.id)).map((u) => u.id));
  const result = simulateMovement(ctx, plans, stance, frozen);
  settleMomentum(ctx, plans, aces, new Set(), result.stopped);
  const velocity = { ...info.velocity };
  for (const id of aces) velocity[id] = result.velocity[id] ?? { x: 0, y: 0 };
  exposeDecoys(ctx);
  state.turnInfo = { stance, velocity, bumped: [...new Set([...info.bumped, ...result.bumped])], deferred: [] };
  updateSight(state);
  checkWinner(ctx, false);
  afterMovement(ctx);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 追擊步驟：結算雙方送出的追擊射擊，之後進入動作 */
export function resolvePursuit(input: GameState, byPlayer: [PlayerPursuits, PlayerPursuits]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const plans: Record<string, PursuitPlan> = {};
  for (const p of [0, 1] as PlayerId[])
    for (const [id, plan] of Object.entries(byPlayer[p])) if (plan && state.units.find((u) => u.id === id)?.owner === p) plans[id] = plan;
  const fired = runPursuits(ctx, plans);
  state.phase = 'action';
  updateSight(state, fired);
  checkWinner(ctx, false);
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 第二步：看到移動結果後選的動作，技能高者先結算；所有射擊之後結算纏鬥；接著回合結束。 */
export function resolveActions(input: GameState, actionsByPlayer: [PlayerActions, PlayerActions]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  const info = state.turnInfo ?? { stance: {}, velocity: {}, bumped: [] };
  const turn: TurnInfo = { stance: info.stance, velocity: info.velocity, dazzled: new Set() };
  const bumped = new Set(info.bumped);
  // 開火或鎖定會暴露位置
  const revealed = new Set<string>();

  // 用眩光武器射擊的最先結算，其餘技能高者先
  const dazzles = (u: UnitState) => {
    const a = actionsByPlayer[u.owner][u.id]?.action;
    const w = a?.type === 'shoot' ? u.equipment.find((e) => e.id === a.weapon) : undefined;
    return w && EQUIPMENT[w.defId].tags?.includes('dazzle') ? 1 : 0;
  };
  const order = state.units
    .filter((u) => u.status === 'active')
    .map((u) => ({ u, first: dazzles(u), skill: pilotOf(u).skill, tie: rng.next() }))
    .sort((x, y) => y.first - x.first || y.skill - x.skill || x.tie - y.tie)
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
    if (inGrapple(state, u.id)) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '纏鬥中不能射擊、鎖定或用道具' });
      continue;
    }
    if (actionUsed) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '換武器用掉了動作' });
      continue;
    }
    if (doAction(ctx, turn, u, plan)) revealed.add(u.id);
  }

  // 所有射擊結算完才結算纏鬥（射進纏鬥的人不會因為順序晚而佔便宜）
  for (const g of [...state.grapples]) {
    const a = unitById(ctx, g.a);
    const b = unitById(ctx, g.b);
    if (a.status !== 'active' || b.status !== 'active') {
      state.grapples = state.grapples.filter((x) => x !== g);
      continue;
    }
    resolveGrapple(ctx, g, a, b, actionsByPlayer[a.owner][a.id]?.grapple, actionsByPlayer[b.owner][b.id]?.grapple);
  }

  // 回合結束：重力圈或水中動能往 0 回正（地面滑行的機體在重力圈不受影響；戰機不低於最低速度）
  const env = state.settings?.environment ?? 'space';
  const decay = env === 'gravity' ? C.GRAVITY_DECAY : env === 'water' ? C.WATER_DECAY : 0;
  if (decay)
    for (const u of state.units) {
      if (u.status !== 'active' || inGrapple(state, u.id) || (env === 'gravity' && CHASSIS[u.chassisId].hover)) continue;
      const min = minSpeedOf(u);
      const m = u.momentum;
      const next = m > 0 ? Math.max(0, m - decay) : Math.min(0, m + decay);
      u.momentum = min > 0 ? Math.max(min, next) : next;
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
  // 回合結束：煙霧散掉（散了以後氣球就藏不住了）
  state.obstacles = state.obstacles.filter((o) => o.kind !== 'smoke' || (o.until ?? 0) > state.turn);
  // 回合結束：達陣與據點
  const settings = state.settings ?? DEFAULT_SETTINGS;
  const done = scoreObjectives(state, settings, (text, side) => ctx.events.push({ type: 'objective', side, text }));
  if (state.winner === null && done.goal.length) finish(ctx, settleBoth(state, done.goal), 'goal');
  if (state.winner === null && done.control.length) finish(ctx, settleBoth(state, done.control, state.objectives!.control), 'control');
  if (!checkWinner(ctx, true)) {
    state.turn++;
    // 增援進場
    const arriving = (state.reserves ?? []).filter((r) => r.turn <= state.turn);
    if (arriving.length) {
      state.reserves = (state.reserves ?? []).filter((r) => r.turn > state.turn);
      for (const r of arriving) {
        state.units.push(r.unit);
        ctx.events.push({ type: 'arrive', unit: r.unit.id });
      }
      updateSight(state);
    }
  }
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

function finish(ctx: Ctx, winner: PlayerId | 'draw', reason: WinReason): void {
  ctx.state.winner = winner;
  ctx.state.winReason = reason;
  ctx.events.push({ type: 'gameOver', winner, reason });
}

/**
 * 勝負：一方全滅；斬首（旗艦退場）；擊墜分到門檻（同時到就比分數）；
 * 回合結束時另外檢查回合上限（比據點分再比擊墜分）。達陣與據點在回合結束時另外結算。
 */
function checkWinner(ctx: Ctx, endOfTurn: boolean): boolean {
  const { state } = ctx;
  if (state.winner !== null) return true;
  const s = state.settings ?? DEFAULT_SETTINGS;
  const alive = [0, 1].map((p) => state.units.filter((u) => u.owner === p && u.status === 'active').length + (state.reserves ?? []).filter((r) => r.unit.owner === p).length);
  if (!alive[0] || !alive[1]) {
    finish(ctx, alive[0] === alive[1] ? 'draw' : alive[0] ? 0 : 1, 'annihilation');
    return true;
  }
  if (s.decapitation) {
    const lost = ([0, 1] as PlayerId[]).filter((p) => flagshipOf(state, p)?.status !== 'active');
    if (lost.length) {
      finish(ctx, lost.length === 2 ? byScore(state) : ((1 - lost[0]) as PlayerId), 'decapitation');
      return true;
    }
  }
  if (s.killScore) {
    const hit = ([0, 1] as PlayerId[]).filter((p) => killScoreOf(state, p) >= s.killScore!);
    if (hit.length) {
      finish(ctx, settleBoth(state, hit), 'killScore');
      return true;
    }
  }
  if (endOfTurn && state.turn >= s.turnLimit) {
    finish(ctx, byScore(state, s.control ? state.objectives?.control : undefined), 'turnLimit');
    return true;
  }
  return false;
}

/** 開戰前的部署：雙方暗中擺好，一起公布；沒給的機體留在原本排開的位置 */
export function resolveDeploy(input: GameState, byPlayer: [PlayerDeploy, PlayerDeploy]): TurnResult {
  const state: GameState = structuredClone(input);
  const rng = new Rng(state.rngState);
  const ctx: Ctx = { state, rng, events: [] };
  for (const u of state.units) {
    const d = byPlayer[u.owner][u.id];
    if (!d) continue;
    u.pos = { x: d.x, y: d.y };
    u.facing = d.facing;
    u.momentum = d.momentum;
  }
  state.phase = 'move';
  state.lastSeen = [{}, {}];
  updateSight(state);
  ctx.events.push({ type: 'phase', phase: 'move' });
  state.rngState = rng.state;
  return { state, events: ctx.events };
}

/** 檢查一方的部署：要在自己的部署區、不壓到隊友或大隕石、朝向 45° 的倍數、起始動能 0–2（戰機至少最低速度） */
export function validateDeploy(state: GameState, player: PlayerId, plans: PlayerDeploy): string[] {
  const errors: string[] = [];
  const z = deployZone(player);
  const placed: { id: string; d: DeployPlan; r: number }[] = [];
  for (const u of state.units.filter((x) => x.owner === player)) {
    const d = plans[u.id];
    if (!d) continue;
    const r = radiusOf(u);
    if (![d.x, d.y, d.facing, d.momentum].every(Number.isFinite)) errors.push(`${u.label}：部署資料不正確`);
    else if (d.x < z.x0 || d.x > z.x1 || d.y < z.y0 || d.y > z.y1) errors.push(`${u.label}：要放在自己的部署區`);
    else if (state.obstacles.some((o) => o.kind === 'rock' && Math.hypot(d.x - o.x, d.y - o.y) < o.r + r)) errors.push(`${u.label}：壓到大隕石`);
    else if (placed.some((q) => Math.hypot(q.d.x - d.x, q.d.y - d.y) < q.r + r + 0.1)) errors.push(`${u.label}：和隊友重疊`);
    const step = Math.round(d.facing / (45 * DEG));
    if (Math.abs(d.facing - step * 45 * DEG) > 1e-6) errors.push(`${u.label}：朝向要是 45° 的倍數`);
    const min = minSpeedOf(u);
    if (!Number.isInteger(d.momentum) || d.momentum < Math.min(min, 2) || d.momentum > Math.max(2, min)) errors.push(`${u.label}：起始動能要在 ${Math.min(min, 2)}–${Math.max(2, min)}`);
    placed.push({ id: u.id, d, r });
  }
  return errors;
}

/** 整回合（移動＋動作），測試與批次模擬用；王牌移動用同一份移動指令、不追擊 */
export function resolveTurn(input: GameState, moves: [PlayerMoves, PlayerMoves], actions: [PlayerActions, PlayerActions] = [{}, {}]): TurnResult {
  let r = resolveMovement(input, moves);
  const events = [...r.events];
  const next = (f: (s: GameState) => TurnResult) => {
    r = f(r.state);
    events.push(...r.events);
  };
  if (r.state.winner === null && r.state.phase === 'ace') next((s) => resolveAceMovement(s, moves));
  if (r.state.winner === null && r.state.phase === 'pursuit') next((s) => resolvePursuit(s, [{}, {}]));
  if (r.state.winner === null) next((s) => resolveActions(s, actions));
  return { state: r.state, events };
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

/** 煙霧彈、欺敵氣球：丟到指定位置 */
function useUtility(ctx: Ctx, u: UnitState, action: Extract<ActionPlan['action'], { type: 'smoke' | 'decoy' }>): boolean {
  const { state } = ctx;
  const item = u.equipment.find((e) => e.id === action.weapon && equipAlive(u, e) && EQUIPMENT[e.defId].utility === action.type);
  if (!item || (item.ammo !== undefined && item.ammo <= 0)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: action.type === 'smoke' ? '沒有煙霧彈了' : '沒有氣球了' });
    return false;
  }
  const reach = dist(u.pos, action.at) - radiusOf(u);
  const limit = action.type === 'smoke' ? C.SMOKE_THROW_RANGE : C.DECOY_PLACE_RANGE;
  if (reach > limit || !Number.isFinite(reach)) {
    ctx.events.push({ type: 'actionFail', unit: u.id, reason: '太遠了' });
    return false;
  }
  if (item.ammo !== undefined) item.ammo--;
  if (action.type === 'smoke') {
    const turns = (state.settings?.environment ?? 'space') === 'space' ? C.SMOKE_TURNS_SPACE : C.SMOKE_TURNS_GRAVITY;
    const n = state.obstacles.filter((o) => o.kind === 'smoke').length;
    state.obstacles.push({ id: `smoke${state.turn}-${u.id}-${n}`, kind: 'smoke', x: action.at.x, y: action.at.y, r: C.SMOKE_RADIUS, until: state.turn + turns - 1 });
    ctx.events.push({ type: 'smoke', unit: u.id, at: { ...action.at }, r: C.SMOKE_RADIUS });
    return false;
  }
  const id = `d${u.owner}-${state.turn}-${(state.decoys ?? []).length}-${u.id}`;
  (state.decoys ??= []).push({ id, owner: u.owner, pos: { ...action.at }, facing: u.facing, chassisId: u.chassisId, parts: structuredClone(u.parts), equipment: structuredClone(u.equipment) });
  ctx.events.push({ type: 'decoy', unit: u.id, decoy: id });
  return false;
}

/** 回傳 true 表示有開火或鎖定（會暴露位置） */
function doAction(ctx: Ctx, turn: TurnInfo, u: UnitState, plan: ActionPlan): boolean {
  const action = plan.action;
  if (action.type === 'none') return false;
  if (action.type === 'smoke' || action.type === 'decoy') return useUtility(ctx, u, action);
  // 打到或鎖定的是氣球：氣球破掉，這個動作就浪費了
  if ((ctx.state.decoys ?? []).some((d) => d.id === action.target)) {
    const w = action.type === 'shoot' ? u.equipment.find((e) => e.id === action.weapon) : undefined;
    if (w && w.ammo !== undefined) w.ammo = Math.max(0, w.ammo - 1);
    popDecoy(ctx, action.target, u.id, action.type === 'shoot' ? '被擊中，原來是氣球' : '鎖定後發現是氣球');
    return true;
  }
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
