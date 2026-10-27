// 重演戰役：照原作設定好雙方陣容、環境、地形、開場位置、增援與勝利條件；
// 電腦那一方另外有「劇本」，前幾回合照原作的打法下指令，之後交給一般 AI。結果不是寫死的。
import { aiOrders } from './ai';
import { CHASSIS, EQUIPMENT, LOADOUTS, PILOTS, type RosterEntry } from './data';
import { dist } from './geometry';
import type { PlayerView } from './match';
import { DEFAULT_SETTINGS, type BattleSettings } from './objectives';
import type { Rng } from './rng';
import type { ActionPlan, MovePlan, PlayerActions, PlayerDeploy, PlayerId, PlayerMoves, PlayerPursuits, Vec } from './types';
import type { UnitView } from './visibility';

/** 劇本：回傳要蓋掉 AI 的指令（只寫要照劇本走的機體），不想管就回傳 null */
export type Script = (view: PlayerView, rng: Rng) => PlayerMoves | PlayerActions | null;
/** 規矩：拿到 AI 這一步的完整指令，回傳修正後的指令 */
export type Rule = (view: PlayerView, orders: PlayerMoves | PlayerActions) => PlayerMoves | PlayerActions;

export interface Scenario {
  id: string;
  /** 作品 */
  series: string;
  name: string;
  summary: string;
  /** 雙方的名稱 */
  sides: [string, string];
  /** 需要的機型與駕駛（資料包沒有就不能玩） */
  requires: { chassis: string[]; pilots: string[] };
  rosters: () => [RosterEntry[], RosterEntry[]];
  settings: () => BattleSettings;
  /** 各方的劇本（電腦操作那一方才會用） */
  scripts?: [Script | null, Script | null];
  /** 各方的規矩：AI 出完移動或行動指令後再修正（例如鏈雷留給特定目標、裝甲晚點拋棄） */
  rules?: [Rule | null, Rule | null];
}

const e = (chassis: string, pilot: string, loadout = 0): RosterEntry => ({ chassis, pilot, equipment: structuredClone(LOADOUTS[chassis]?.[loadout] ?? []) });
const UP = Math.PI / 2;
const DOWN = -Math.PI / 2;
const hover: MovePlan = { maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false };
const mine = (v: PlayerView) => v.state.units.filter((u) => u.owner === v.you && u.status === 'active');
const foes = (v: PlayerView) => v.state.units.filter((u) => u.owner !== v.you && u.status === 'active' && !u.hidden);
const item = (u: UnitView, defId: string) => u.equipment.find((x) => x.defId === defId && (x.ammo === undefined || x.ammo > 0) && u.parts[x.id] && !u.parts[x.id].destroyed);
const toward = (a: Vec, b: Vec, d: number): Vec => {
  const len = dist(a, b) || 1;
  return { x: a.x + ((b.x - a.x) / len) * d, y: a.y + ((b.y - a.y) / len) * d };
};
const nearest = (from: Vec, list: UnitView[]) => [...list].sort((a, b) => dist(from, a.pos) - dist(from, b.pos))[0];

/** 第 5 話：肯普法強襲。米哈伊爾衝進森林用散彈槍各個擊破吉姆；鋼彈 NT-1 第 6 回合穿著追加裝甲趕到，鏈雷對上裝甲 */
const kampferScript: Script = (v) => {
  if (v.phase !== 'action') return null;
  const k = mine(v).find((u) => u.chassisId === 'MS-18E');
  if (!k) return null;
  const nt1 = foes(v).find((u) => u.chassisId === 'RX-78NT-1');
  const mineItem = item(k, 'chain_mine');
  // 鋼彈 NT-1 靠近就丟鏈雷（原作：鏈雷纏上去，爆在追加裝甲上）
  if (nt1 && mineItem && dist(k.pos, nt1.pos) <= 4) return { [k.id]: { action: { type: 'shoot', weapon: mineItem.id, target: nt1.id } } as ActionPlan };
  return null;
};

/** 克莉絲的追加裝甲：撐到裝甲吃了傷害（原作是鏈雷炸在裝甲上）、或肯普法的鏈雷用掉了才拋棄 */
const chrisRules: Rule = (v, all) => {
  if (v.phase !== 'move') return all;
  const orders = all as PlayerMoves;
  const nt1 = mine(v).find((u) => u.chassisId === 'RX-78NT-1');
  const plan = nt1 ? orders[nt1.id] : undefined;
  if (!nt1 || !plan?.purge) return orders;
  const armor = nt1.equipment.find((x) => EQUIPMENT[x.defId]?.kind === 'armor');
  const hurt = armor ? nt1.parts[armor.id].damage >= 3 : true;
  const mineLeft = foes(v).some((u) => u.chassisId === 'MS-18E' && !!item(u, 'chain_mine'));
  return hurt || !mineLeft ? orders : { ...orders, [nt1.id]: { ...plan, purge: false } };
};

/** 肯普法的武器使用規矩：鏈雷留給鋼彈 NT-1，鐵拳火箭只在近距離用；違反時改用散彈槍或巨型火箭砲 */
const kampferRules: Rule = (v, all) => {
  if (v.phase !== 'action') return all;
  const orders = all as PlayerActions;
  const k = mine(v).find((u) => u.chassisId === 'MS-18E');
  const a = k ? orders[k.id]?.action : undefined;
  if (!k || !a || a.type !== 'shoot') return orders;
  const w = k.equipment.find((x) => x.id === a.weapon);
  const t = v.state.units.find((u) => u.id === a.target);
  const misuse = (w?.defId === 'chain_mine' && t?.chassisId !== 'RX-78NT-1') || (w?.defId === 'schturm_faust' && t && dist(k.pos, t.pos) > 4);
  if (!misuse) return orders;
  const alt = item(k, 'shotgun') ?? item(k, 'giant_bazooka');
  const held = alt && (alt.location === 'right' || alt.location === 'left');
  return { ...orders, [k.id]: held ? { action: { type: 'shoot', weapon: alt!.id, target: a.target } } : { action: { type: 'lock', target: a.target } } };
};

/** 最終話：聖誕節的對決。伯尼放煙霧、在煙霧裡擺氣球，等克莉絲被氣球引開，再從煙霧裡衝出來近身用熱能斧 */
const bernieScript: Script = (v) => {
  const z = mine(v).find((u) => u.chassisId === 'MS-06FZ');
  if (!z) return null;
  const alex = nearest(z.pos, foes(v));
  const smokes = v.state.obstacles.filter((o) => o.kind === 'smoke');
  const inSmoke = smokes.some((s) => dist(z.pos, s) <= s.r);
  const close = alex && dist(z.pos, alex.pos) <= 5;
  if (v.phase === 'move') {
    // 還沒近身前躲在煙霧裡不動
    if (!close && (inSmoke || !smokes.length) && Math.abs(z.momentum) <= 1) return { [z.id]: { ...hover } };
    return null;
  }
  if (v.phase !== 'action') return null;
  // 近身就拔熱能斧（原作最後的近身戰）
  const axe = z.equipment.find((x) => x.defId === 'heat_axe' && x.location === 'stowed');
  if (close && axe && alex && dist(z.pos, alex.pos) <= 4) return { [z.id]: { action: { type: 'none' }, swap: { hand: 'right', equip: axe.id } } as ActionPlan };
  if (close) return null;
  // 還沒近身就不開火（開火會暴露位置），能做的事做完就靜靜等

  const smoke = item(z, 'smoke_grenade');
  const balloon = item(z, 'decoy_balloon');
  const target = alex?.pos ?? { x: z.pos.x, y: 0 };
  // 沒有煙霧（或快散了）就丟在自己面前，把自己罩住
  const fading = smokes.every((s) => (s.until ?? 0) <= v.state.turn);
  if (smoke && (!smokes.length || fading)) return { [z.id]: { action: { type: 'smoke', weapon: smoke.id, at: toward(z.pos, target, 1) } } as ActionPlan };
  // 煙霧裡擺氣球：左右各一個
  if (balloon && inSmoke) {
    const side = (balloon.ammo ?? 1) % 2 ? 1 : -1;
    const dir = Math.atan2(target.y - z.pos.y, target.x - z.pos.x) + (side * Math.PI) / 2;
    return { [z.id]: { action: { type: 'decoy', weapon: balloon.id, at: { x: z.pos.x + Math.cos(dir) * 1.8, y: z.pos.y + Math.sin(dir) * 1.8 } } } as ActionPlan };
  }
  return { [z.id]: { action: { type: 'none' } } as ActionPlan };
};

export const SCENARIOS: Scenario[] = [
  {
    id: '0080-ep5',
    series: '機動戰士鋼彈 0080 口袋裡的戰爭',
    name: '第 5 話：肯普法強襲',
    summary: '中立殖民地裡的森林。米哈伊爾的肯普法突襲聯邦的寒冷地型吉姆與量產型鋼加農；克莉絲的鋼彈 NT-1 第 6 回合穿著追加裝甲趕到。全滅對方獲勝。',
    sides: ['地球聯邦軍', '吉翁公國軍（獨眼巨人隊）'],
    requires: { chassis: ['RGM-79D', 'RX-77D', 'RX-78NT-1', 'MS-18E'], pilots: ['chris', 'mikhail'] },
    rosters: () => [[e('RGM-79D', 'recruit'), e('RGM-79D', 'recruit'), e('RGM-79D', 'recruit'), e('RX-77D', 'recruit')], [e('MS-18E', 'mikhail')]],
    settings: () => ({
      ...DEFAULT_SETTINGS,
      killScore: undefined,
      decapitation: false,
      turnLimit: 16,
      environment: 'gravity',
      terrain: 'forest',
      placements: [
        { owner: 0, index: 0, x: 9, y: 9, facing: UP, momentum: 0 },
        { owner: 0, index: 1, x: 13, y: 8, facing: UP, momentum: 0 },
        { owner: 0, index: 2, x: 16, y: 10, facing: UP, momentum: 0 },
        { owner: 0, index: 3, x: 11, y: 5, facing: UP, momentum: 0 },
        { owner: 1, index: 0, x: 12, y: 21, facing: DOWN, momentum: 2 },
      ],
      reinforcements: [{ owner: 0, entry: e('RX-78NT-1', 'chris', 0), turn: 6, x: 12, y: 1.5, facing: UP }],
    }),
    scripts: [null, kampferScript],
    rules: [chrisRules, kampferRules],
  },
  {
    id: '0080-ep6',
    series: '機動戰士鋼彈 0080 口袋裡的戰爭',
    name: '最終話：聖誕節的對決',
    summary: '殖民地的街區。伯尼的薩克 II 改帶著煙霧彈與欺敵氣球埋伏，克莉絲的鋼彈 NT-1（已經沒有追加裝甲）進入街區。擊墜對方獲勝。',
    sides: ['地球聯邦軍', '吉翁公國軍'],
    requires: { chassis: ['RX-78NT-1', 'MS-06FZ'], pilots: ['chris', 'bernie'] },
    rosters: () => [[e('RX-78NT-1', 'chris', 1)], [e('MS-06FZ', 'bernie', 0)]],
    settings: () => ({
      ...DEFAULT_SETTINGS,
      killScore: undefined,
      decapitation: true,
      turnLimit: 16,
      environment: 'gravity',
      terrain: 'town',
      placements: [
        { owner: 0, index: 0, x: 12, y: 3, facing: UP, momentum: 1 },
        { owner: 1, index: 0, x: 12, y: 15, facing: DOWN, momentum: 0 },
      ],
      // 伯尼事先布好的陷阱：街口一片煙霧，裡面左右兩顆氣球
      prepared: { smokes: [{ x: 12, y: 14 }], decoys: [{ owner: 1, index: 0, x: 10.4, y: 14.2 }, { owner: 1, index: 0, x: 13.6, y: 14.2 }] },
    }),
    scripts: [null, bernieScript],
  },
];

/** 這份資料包能不能玩這個劇本 */
export const scenarioAvailable = (s: Scenario): boolean => s.requires.chassis.every((c) => !!CHASSIS[c]) && s.requires.pilots.every((p) => !!PILOTS[p]) && Object.keys(EQUIPMENT).length > 0;

/** 電腦照劇本出指令：先讓一般 AI 出完整的指令，再用劇本蓋掉劇本要管的機體 */
export function scriptedOrders(scenario: Scenario | undefined, view: PlayerView, rng: Rng): PlayerMoves | PlayerActions | PlayerPursuits | PlayerDeploy {
  let base = aiOrders(view, rng);
  const rule = scenario?.rules?.[view.you];
  if (rule && (view.phase === 'move' || view.phase === 'action')) base = rule(view, base as PlayerMoves | PlayerActions);
  const script = scenario?.scripts?.[view.you];
  if (!script || (view.phase !== 'move' && view.phase !== 'action')) return base;
  const over = script(view, rng);
  return over ? ({ ...base, ...over } as typeof base) : base;
}
