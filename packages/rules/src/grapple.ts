import { closeCombatOf, radiusOf } from './body';
import * as C from './config';
import { addStress, damageUnit, type Ctx } from './damage';
import { EQUIPMENT } from './data';
import { add, dist, normalize, scale, sub } from './geometry';
import type { GrappleChoice, GrappleState, UnitState } from './types';
import { activeShields, chassisOf, hasFreeHand, pilotOf, readyMelee } from './unit';

export const GRAPPLE_NAMES: Record<GrappleChoice, string> = { slash: '斬', parry: '架', grab: '抓', push: '推', disengage: '脫離' };

export function grappleOptions(u: UnitState): GrappleChoice[] {
  if (!closeCombatOf(u)) return ['disengage'];
  if (u.blackout) return ['push', 'disengage'];
  const out: GrappleChoice[] = [];
  if (readyMelee(u)) out.push('slash', 'parry');
  else if (activeShields(u).length) out.push('parry');
  if (hasFreeHand(u)) out.push('grab');
  out.push('push', 'disengage');
  return out;
}

export function normalizeChoice(u: UnitState, c: GrappleChoice | undefined): GrappleChoice {
  const options = grappleOptions(u);
  return c && options.includes(c) ? c : options.includes('push') ? 'push' : options[0];
}

/** 把 mover 沿圓心連線推離 anchor，使兩者底板邊緣相距 gap */
export function pushApart(ctx: Ctx, anchor: UnitState, mover: UnitState, gap: number): void {
  const dir = normalize(sub(mover.pos, anchor.pos));
  const target = radiusOf(anchor) + radiusOf(mover) + gap;
  if (dist(anchor.pos, mover.pos) >= target) return;
  mover.pos = add(anchor.pos, scale(dir, target));
  ctx.events.push({ type: 'reposition', unit: mover.id, to: { ...mover.pos } });
}

export function resolveGrapple(ctx: Ctx, g: GrappleState, a: UnitState, b: UnitState, rawA?: GrappleChoice, rawB?: GrappleChoice): void {
  const ca = normalizeChoice(a, rawA);
  const cb = normalizeChoice(b, rawB);
  const adv = (u: UnitState) => g.advantage === u.id;
  let advantage: string | null = null;
  let ended = false;
  const notes: string[] = [];

  const pushTotal = (u: UnitState) => chassisOf(u).power + chassisOf(u).weightClass + Math.floor(pilotOf(u).skill / 2) + ctx.rng.die(6) + (adv(u) ? C.ADVANTAGE_PUSH : 0);
  const pushCheck = (): { winner: UnitState | null; loser: UnitState | null; margin: number } => {
    const ta = pushTotal(a);
    const tb = pushTotal(b);
    if (ta === tb) return { winner: null, loser: null, margin: 0 };
    return ta > tb ? { winner: a, loser: b, margin: ta - tb } : { winner: b, loser: a, margin: tb - ta };
  };
  const slashDamage = (u: UnitState) => (EQUIPMENT[readyMelee(u)!.defId].damage ?? 1) + (adv(u) ? C.ADVANTAGE_SLASH : 0);
  const slash = (from: UnitState, to: UnitState, half = false) => {
    const dmg = half ? Math.ceil(slashDamage(from) / 2) : slashDamage(from);
    notes.push(`${from.label} 斬中 ${to.label}${half ? '（追擊）' : ''}`);
    damageUnit(ctx, to, dmg, 'focused');
  };
  const throwUnit = (thrower: UnitState, victim: UnitState) => {
    notes.push(`${thrower.label} 把 ${victim.label} 甩了出去`);
    pushApart(ctx, thrower, victim, C.THROW_DISTANCE);
    damageUnit(ctx, victim, C.THROW_DAMAGE, 'focused');
    addStress(ctx, victim, C.THROW_STRESS, '被投擲');
    ended = true;
  };
  const pushAway = (winner: UnitState, loser: UnitState) => {
    notes.push(`${winner.label} 把 ${loser.label} 推開`);
    pushApart(ctx, winner, loser, 1);
    ended = true;
  };
  const pushContest = () => {
    const r = pushCheck();
    if (!r.winner || !r.loser) {
      notes.push('推擠僵持');
      return;
    }
    advantage = r.winner.id;
    if (r.margin >= C.PUSH_AWAY_MARGIN) pushAway(r.winner, r.loser);
    else notes.push(`${r.winner.label} 推擠占優`);
  };
  /** 若 (ca, cb) 是 {x, y} 的組合，回傳 [選 x 的機體, 選 y 的機體] */
  const match = (x: GrappleChoice, y: GrappleChoice): [UnitState, UnitState] | null => {
    if (ca === x && cb === y) return [a, b];
    if (ca === y && cb === x) return [b, a];
    return null;
  };

  let m: [UnitState, UnitState] | null;
  if (ca === 'disengage' && cb === 'disengage') {
    notes.push('雙方分開');
    addStress(ctx, a, C.DISENGAGE_STRESS, '脫離纏鬥');
    addStress(ctx, b, C.DISENGAGE_STRESS, '脫離纏鬥');
    pushApart(ctx, a, b, C.DISENGAGE_GAP);
    ended = true;
  } else if (ca === 'disengage' || cb === 'disengage') {
    const [d, o] = ca === 'disengage' ? [a, b] : [b, a];
    const oc = ca === 'disengage' ? cb : ca;
    addStress(ctx, d, C.DISENGAGE_STRESS, '脫離纏鬥');
    if (oc === 'grab') {
      notes.push(`${d.label} 脫離失敗`);
      throwUnit(o, d);
    } else {
      notes.push(`${d.label} 脫離`);
      if (oc === 'slash') slash(o, d, true);
      pushApart(ctx, o, d, oc === 'push' ? C.DISENGAGE_GAP + 1 : C.DISENGAGE_GAP);
      ended = true;
    }
  } else if (ca === 'slash' && cb === 'slash') {
    const r = pushCheck();
    if (r.winner && r.loser) slash(r.winner, r.loser);
    else notes.push('鍔迫り合い僵持，雙方落空');
  } else if ((m = match('slash', 'parry'))) {
    notes.push(`${m[1].label} 架開斬擊`);
    addStress(ctx, m[0], 1, '斬擊被架開');
    advantage = m[1].id;
  } else if ((m = match('slash', 'grab'))) {
    slash(m[0], m[1]);
    notes.push(`${m[1].label} 抓取失敗`);
  } else if ((m = match('slash', 'push'))) {
    slash(m[0], m[1]);
    pushContest();
  } else if (ca === 'parry' && cb === 'parry') {
    notes.push('雙方僵持');
    addStress(ctx, a, 1, '纏鬥僵持');
    addStress(ctx, b, 1, '纏鬥僵持');
  } else if ((m = match('parry', 'grab'))) {
    throwUnit(m[1], m[0]);
  } else if ((m = match('parry', 'push'))) {
    notes.push(`${m[1].label} 推擠占優`);
    advantage = m[1].id;
  } else if (ca === 'grab' && cb === 'grab') {
    const r = pushCheck();
    if (r.winner && r.loser) throwUnit(r.winner, r.loser);
    else notes.push('互抓僵持');
  } else if ((m = match('grab', 'push'))) {
    const [grabber, pusher] = m;
    const r = pushCheck();
    if (r.winner === grabber) throwUnit(grabber, pusher);
    else if (r.winner === pusher) {
      notes.push(`${pusher.label} 掙脫並占優`);
      advantage = pusher.id;
    } else notes.push('推擠僵持');
  } else {
    pushContest();
  }

  g.advantage = ended ? null : advantage;
  ctx.events.push({ type: 'grapple', a: a.id, b: b.id, choiceA: ca, choiceB: cb, summary: notes.join('；'), advantage: g.advantage, ended });
  if (ended || a.status !== 'active' || b.status !== 'active') {
    ctx.state.grapples = ctx.state.grapples.filter((x) => x !== g);
  }
}
