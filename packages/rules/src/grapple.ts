// 纏鬥：每回合雙方暗選一種手法（劈砍、穿刺、纏繞）或脫離，一起擲近戰骰比成功數。
// 剋制環：纏繞剋劈砍、劈砍剋穿刺、穿刺剋纏繞，被剋的一方對手多 COUNTER_DICE 顆骰（軟剋制：骰運、武器與技術還能翻盤）。
// 脫離與徒手肉搏（不擅長肉搏的駕駛）永遠等於被剋。贏的一方用那種手法造成傷害，並一律把對方擊退、結束纏鬥；平手就繼續纏。
import { closeCombatOf, radiusOf, roleLost } from './body';
import * as C from './config';
import { addStress, damageUnit, dealtBy, type Ctx } from './damage';
import { EQUIPMENT } from './data';
import { add, dist, normalize, scale, sub } from './geometry';
import type { EquipState, GameState, GrappleChoice, GrappleState, PartState, Technique, UnitState } from './types';
import { alwaysReady, chassisOf, equipAlive, handUsable, heldItem, pilotOf } from './unit';

export const TECHNIQUES: Technique[] = ['cleave', 'thrust', 'entangle'];

/** 射擊纏鬥中的目標時，命中部位從這些機體的部位一起抽（目標本身排第一）；沒在纏鬥就只有目標 */
export function grapplePool<T extends { id: string; status: string }>(state: { grapples: GrappleState[]; units: T[] }, target: T): T[] {
  const ids = new Set<string>();
  for (const g of state.grapples) if (g.a === target.id || g.b === target.id) ids.add(g.a === target.id ? g.b : g.a);
  return [target, ...state.units.filter((u) => ids.has(u.id) && u.status === 'active')];
}

/** 這台目標在纏鬥中：射它有誤擊風險（Danger Close） */
export const dangerClose = (state: Pick<GameState, 'grapples'>, targetId: string): boolean => state.grapples.some((g) => g.a === targetId || g.b === targetId);
export const GRAPPLE_NAMES: Record<GrappleChoice, string> = { cleave: '劈砍', thrust: '穿刺', entangle: '纏繞', disengage: '脫離' };
/** 剋制環：key 剋 value */
export const BEATS: Record<Technique, Technique> = { entangle: 'cleave', cleave: 'thrust', thrust: 'entangle' };

type Gear = { parts: Record<string, PartState>; equipment: EquipState[]; pilotId?: string; chassisId: string };

export interface TechniqueUse {
  technique: Technique;
  /** 用的武器；null 是徒手肉搏 */
  weapon: EquipState | null;
  dice: number;
  damage: number;
}

/** 這台機體現在能用的近戰武器：手上的，加上隨時可用的（肩部尖刺） */
function meleeWeapons(u: Gear): EquipState[] {
  const held = (['right', 'left'] as const).map((h) => heldItem(u, h)).filter((e): e is EquipState => !!e && EQUIPMENT[e.defId].kind === 'melee');
  const fixed = u.equipment.filter((e) => alwaysReady(e) && equipAlive(u, e) && EQUIPMENT[e.defId].kind === 'melee');
  return [...held, ...fixed];
}

/** 武器用某種手法的修正：有寫 melee 就照寫的；沒寫的劈砍、穿刺照武器本身的傷害與額外骰，不能纏繞 */
export function weaponTechnique(defId: string, t: Technique): { dice: number; damage: number } | null {
  const def = EQUIPMENT[defId];
  const v = def.melee?.[t];
  if (v) return v;
  if (def.melee) return null;
  return t === 'entangle' ? null : { dice: def.meleeDice ?? 0, damage: def.damage ?? 1 };
}

/** 能不能徒手肉搏：有一隻能動的手，或腳還在（踢） */
const canBrawl = (u: Gear) => (['right', 'left'] as const).some((h) => handUsable(u, h)) || !roleLost(u, 'legs');

/** 這種手法這台機體最好的用法（武器或徒手）；完全不能用回傳 null */
export function techniqueUse(u: Gear, t: Technique): TechniqueUse | null {
  let best: TechniqueUse | null = null;
  for (const w of meleeWeapons(u)) {
    const v = weaponTechnique(w.defId, t);
    if (v && (!best || v.dice > best.dice || (v.dice === best.dice && v.damage > best.damage))) best = { technique: t, weapon: w, ...v };
  }
  const bare = C.BARE_HANDS[t];
  if (canBrawl(u) && (!best || bare.dice > best.dice)) best = { technique: t, weapon: null, ...bare };
  return best;
}

/** 徒手肉搏會不會吃虧：不擅長肉搏的駕駛徒手，對手當作剋制 */
const clumsyBare = (u: { pilotId?: string }, use: TechniqueUse | null) => !!use && !use.weapon && !(u.pilotId && pilotOf(u as { pilotId: string }).abilities.includes('brawler'));

export function grappleOptions(u: UnitState): GrappleChoice[] {
  if (!closeCombatOf(u)) return ['disengage'];
  return [...TECHNIQUES.filter((t) => techniqueUse(u, t)), 'disengage'];
}

/** 沒選或選了不能用的：用骰數最多的手法 */
export function normalizeChoice(u: UnitState, c: GrappleChoice | undefined | string): GrappleChoice {
  const options = grappleOptions(u);
  if (c && (options as string[]).includes(c)) return c as GrappleChoice;
  const best = TECHNIQUES.map((t) => techniqueUse(u, t)).filter((x): x is TechniqueUse => !!x && options.includes(x.technique)).sort((a, b) => b.dice - a.dice)[0];
  return best?.technique ?? 'disengage';
}

/** 纏鬥一開始誰占優：從對方側面或背後抓住的一方 */
export function clinchAdvantage(a: UnitState, b: UnitState): string | null {
  const flank = (from: UnitState, of: UnitState) => {
    const ang = Math.abs(Math.atan2(Math.sin(Math.atan2(from.pos.y - of.pos.y, from.pos.x - of.pos.x) - of.facing), Math.cos(Math.atan2(from.pos.y - of.pos.y, from.pos.x - of.pos.x) - of.facing)));
    return ang > C.FRONT_ARC_DEG * (Math.PI / 180);
  };
  const aFlank = flank(a, b);
  const bFlank = flank(b, a);
  return aFlank && !bFlank ? a.id : bFlank && !aFlank ? b.id : null;
}

/** 把 mover 沿圓心連線推離 anchor，使兩者底板邊緣相距 gap */
export function pushApart(ctx: Ctx, anchor: UnitState, mover: UnitState, gap: number): void {
  const dir = normalize(sub(mover.pos, anchor.pos));
  const target = radiusOf(anchor) + radiusOf(mover) + gap;
  if (dist(anchor.pos, mover.pos) >= target) return;
  mover.pos = add(anchor.pos, scale(dir, target));
  ctx.events.push({ type: 'reposition', unit: mover.id, to: { ...mover.pos } });
}

/** 這一方這回合擲幾顆骰：基本＋技術（上限 SKILL_CAP_CLOSE）＋手法修正＋優勢＋剋制，遲鈍或黑視扣骰 */
export function grappleDice(u: UnitState, mine: GrappleChoice, use: TechniqueUse | null, theirs: GrappleChoice, theirUse: TechniqueUse | null, advantage: boolean, opp: UnitState): number {
  let n = C.MELEE_BASE_DICE + Math.min(pilotOf(u).skill, C.SKILL_CAP_CLOSE);
  if (use) n += use.dice;
  if (advantage) n += C.GRAPPLE_ADV_DICE;
  if (u.blackout || u.stress >= u.maxStress) n -= C.MELEE_SLUGGISH_PENALTY;
  // 剋制：手法剋對方、對方脫離、對方笨拙地徒手肉搏
  if (mine !== 'disengage') {
    const countered = (theirs !== 'disengage' && BEATS[mine as Technique] === theirs) || theirs === 'disengage' || clumsyBare(opp, theirUse);
    if (countered) n += C.COUNTER_DICE;
  }
  return Math.max(1, n);
}

export function resolveGrapple(ctx: Ctx, g: GrappleState, a: UnitState, b: UnitState, rawA?: GrappleChoice, rawB?: GrappleChoice): void {
  const ca = normalizeChoice(a, rawA);
  const cb = normalizeChoice(b, rawB);
  const notes: string[] = [];
  let ended = false;
  let advantage: string | null = null;
  const end = () => {
    ended = true;
  };

  if (ca === 'disengage' && cb === 'disengage') {
    notes.push('雙方分開');
    addStress(ctx, a, C.DISENGAGE_STRESS, '脫離纏鬥');
    addStress(ctx, b, C.DISENGAGE_STRESS, '脫離纏鬥');
    pushApart(ctx, a, b, C.DISENGAGE_GAP);
    end();
  } else {
    const ua = ca === 'disengage' ? null : techniqueUse(a, ca);
    const ub = cb === 'disengage' ? null : techniqueUse(b, cb);
    const na = grappleDice(a, ca, ua, cb, ub, g.advantage === a.id, b);
    const nb = grappleDice(b, cb, ub, ca, ua, g.advantage === b.id, a);
    const roll = (n: number) => Array.from({ length: n }, () => ctx.rng.die(6));
    const da = roll(na);
    const db = roll(nb);
    const ha = da.filter((d) => d >= C.MELEE_SUCCESS_ON).length;
    const hb = db.filter((d) => d >= C.MELEE_SUCCESS_ON).length;
    notes.push(`${a.label} ${GRAPPLE_NAMES[ca]} ${ha} 成功（${na} 骰） vs ${b.label} ${GRAPPLE_NAMES[cb]} ${hb} 成功（${nb} 骰）`);
    if (ha === hb) {
      notes.push('僵持');
      addStress(ctx, a, 1, '纏鬥僵持');
      addStress(ctx, b, 1, '纏鬥僵持');
      // 互相纏繞僵持：重的一方壓住對方，下回合占優
      if (ca === 'entangle' && cb === 'entangle') {
        const wa = chassisOf(a).weightClass;
        const wb = chassisOf(b).weightClass;
        advantage = wa > wb ? a.id : wb > wa ? b.id : null;
      }
    } else {
      const [w, l, wc, wu, lc] = ha > hb ? [a, b, ca, ua, cb] : [b, a, cb, ub, ca];
      if (wc === 'disengage') {
        notes.push(`${w.label} 脫離成功`);
        addStress(ctx, w, C.DISENGAGE_STRESS, '脫離纏鬥');
        pushApart(ctx, l, w, C.DISENGAGE_GAP);
      } else {
        const use = wu!;
        const how = use.weapon ? EQUIPMENT[use.weapon.defId].name : '徒手';
        notes.push(`${w.label} 以${how}${GRAPPLE_NAMES[wc]}得手，擊退 ${l.label}`);
        dealtBy(ctx, w, () => damageUnit(ctx, l, use.damage, 'focused'));
        if (wc === 'entangle') addStress(ctx, l, C.THROW_STRESS, '被摔出去');
        if (lc === 'disengage') addStress(ctx, l, C.DISENGAGE_STRESS, '脫離纏鬥');
        if (l.status === 'active') pushApart(ctx, w, l, wc === 'entangle' ? C.THROW_DISTANCE : C.KNOCKBACK_GAP);
      }
      end();
    }
  }

  g.advantage = ended ? null : advantage;
  ctx.events.push({ type: 'grapple', a: a.id, b: b.id, choiceA: ca, choiceB: cb, summary: notes.join('；'), advantage: g.advantage, ended });
  if (ended || a.status !== 'active' || b.status !== 'active') ctx.state.grapples = ctx.state.grapples.filter((x) => x !== g);
}
