// 追擊：移動全部結束、動作之前，咬住敵機背後的機體可以多開一槍。
// 條件：射擊方在目標背後 ±PURSUIT_ARC_DEG 內、面向目標 ±PURSUIT_ARC_DEG 內、距離帶不超過 PURSUIT_MAX_BAND。
// 咬在最後面的先結算（沒有被別人咬住的先開火），被打壞武器或擊墜就失去自己的追擊；繞成一圈互咬的同時結算。
import { DEG } from './geometry';
import * as C from './config';
import { hitChance, relativeAngle, relativeSpeed, shoot, type TurnInfo } from './combat';
import { EQUIPMENT } from './data';
import { lineOfFire } from './terrain';
import { readyRanged, pilotOf } from './unit';
import type { Ctx } from './damage';
import type { EquipState, GameState, PlayerPursuits, PursuitPlan, UnitState } from './types';

export interface PursuitOption {
  target: string;
  weapon: string;
  /** 命中率（不知道對手駕駛技能，照 null 算；實際結算用真正的數值） */
  chance: number;
  band: number;
}

type Pos = Pick<UnitState, 'pos' | 'facing'>;

/** 位置與朝向上，shooter 是否咬住 target 的背後 */
export function tailing(shooter: Pos, target: Pos): boolean {
  const arc = C.PURSUIT_ARC_DEG * DEG;
  return relativeAngle(target, shooter.pos) >= Math.PI - arc - 1e-9 && relativeAngle(shooter, target.pos) <= arc + 1e-9;
}

const grappled = (state: GameState, id: string) => state.grapples.some((g) => g.a === id || g.b === id);

/** u 這回合能做的追擊射擊（目標 × 武器）；不能追擊時回傳空陣列 */
export function pursuitOptions(state: GameState, u: UnitState): PursuitOption[] {
  const info = state.turnInfo;
  if (u.status !== 'active' || grappled(state, u.id) || info?.bumped.includes(u.id)) return [];
  const out: PursuitOption[] = [];
  for (const t of state.units) {
    if (t.owner === u.owner || t.status !== 'active' || grappled(state, t.id) || !state.visible[u.owner].includes(t.id)) continue;
    if (!tailing(u, t)) continue;
    for (const w of readyRanged(u)) {
      if (w.ammo !== undefined && w.ammo <= 0) continue;
      const h = hitChance({
        attacker: u,
        attackerSkill: pilotOf(u).skill,
        weapon: EQUIPMENT[w.defId],
        target: t,
        targetSkill: null,
        relSpeed: relativeSpeed(info?.velocity ?? {}, u.id, t.id),
        shooterMelee: info?.stance[u.id] === 'melee',
        cover: lineOfFire(state.obstacles, u.pos, t.pos, u.z, t.z),
      });
      if (h && h.band <= C.PURSUIT_MAX_BAND) out.push({ target: t.id, weapon: w.id, chance: h.chance, band: h.band });
    }
  }
  return out;
}

/** 這一步有沒有任何機體能追擊（沒有就直接跳過追擊步驟） */
export const anyPursuit = (state: GameState): boolean => state.units.some((u) => pursuitOptions(state, u).length > 0);

/** 檢查一方送出的追擊：只能用自己能追擊的機體、而且要是列出來的選項 */
export function validatePursuits(state: GameState, player: number, plans: PlayerPursuits): string[] {
  const errors: string[] = [];
  for (const [id, plan] of Object.entries(plans)) {
    if (!plan) continue;
    const u = state.units.find((x) => x.id === id);
    if (!u || u.owner !== player) {
      errors.push(`${id}：不是你的機體`);
      continue;
    }
    if (!pursuitOptions(state, u).some((o) => o.target === plan.target && o.weapon === plan.weapon)) errors.push(`${u.label}：不能這樣追擊`);
  }
  return errors;
}

/** 結算追擊射擊；回傳有開火的機體（會暴露位置） */
export function runPursuits(ctx: Ctx, plans: Record<string, PursuitPlan>): Set<string> {
  const { state } = ctx;
  const info = state.turnInfo;
  const turn: TurnInfo = { stance: info?.stance ?? {}, velocity: info?.velocity ?? {}, dazzled: new Set() };
  const fired = new Set<string>();
  let pending = Object.entries(plans).map(([id, plan]) => ({ u: state.units.find((x) => x.id === id)!, plan }));

  const fire = (u: UnitState, plan: PursuitPlan, later?: (() => void)[]) => {
    if (u.status !== 'active') return;
    const target = state.units.find((x) => x.id === plan.target);
    const weapon: EquipState | undefined = readyRanged(u).find((w) => w.id === plan.weapon);
    if (!target || target.status !== 'active') {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '追擊目標已失去戰鬥能力' });
      return;
    }
    if (!weapon) {
      ctx.events.push({ type: 'actionFail', unit: u.id, reason: '追擊用的武器已經不能用' });
      return;
    }
    if (shoot(ctx, turn, u, weapon, target, { pursuit: true, later })) fired.add(u.id);
  };

  while (pending.length) {
    // 沒有被還沒開火的追擊者咬住的，先開火
    const ready = pending.filter((p) => !pending.some((q) => q !== p && q.plan.target === p.u.id));
    if (ready.length) {
      for (const p of ready) fire(p.u, p.plan);
      pending = pending.filter((p) => !ready.includes(p));
      continue;
    }
    // 剩下的繞成一圈互咬：同時開火，傷害最後一起算
    const later: (() => void)[] = [];
    for (const p of pending) fire(p.u, p.plan, later);
    for (const f of later) f();
    pending = [];
  }
  return fired;
}
