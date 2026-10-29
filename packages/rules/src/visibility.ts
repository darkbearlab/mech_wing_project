import { dist } from './geometry';
import { segmentHitsCircle } from './terrain';
import * as C from './config';
import { DEFAULT_SETTINGS, flagshipOf, killScoreOf, newObjectives, type BattleSettings, type ObjectiveState, type WinReason } from './objectives';
import { radiusOf, roleLost } from './body';
import { equipAlive } from './unit';
import { canSee, sensorRange } from './vision';
import { podSeen } from './psycommu';
import { EQUIPMENT } from './data';
import { chaffed, ecmOf, jammed, knownMines } from './ecm';

/** 看得到的敵方炮群 */
export interface EnemyPod {
  /** 那件感應武器的 id（射擊時當目標） */
  id: string;
  owner: PlayerId;
  mother: string;
  label: string;
  defId: string;
  wired: boolean;
  /** 線控：是哪隻手臂 */
  part?: string;
  pos: Vec;
  bits: number;
}
import type { EquipState, GameEvent, GameState, GrappleState, Inbound, Obstacle, PartState, PlayerId, Stance, UnitState, UnitStatus, Vec } from './types';

/** 對手看得到機體，看不到駕駛 */
export interface UnitView {
  id: string;
  owner: PlayerId;
  /** 自己這一方的機體歸哪個小隊（敵機不顯示） */
  squad?: number;
  label: string;
  chassisId: string;
  pos: Vec;
  /** 高度（層），地面沒寫 */
  z?: number;
  /** 被敵方標定（雙方都知道；被標定的一方看不到 by） */
  mark?: { by?: string };
  facing: number;
  parts: Record<string, PartState>;
  equipment: EquipState[];
  status: UnitStatus | 'disabled';
  /** 動能：上回合實際的速度，看得到 */
  momentum: number;
  /** 對手唯一看得到的駕駛狀態 */
  vague: 'sluggish' | null;
  /** 目前看不到：位置與外觀是最後目擊時的樣子 */
  hidden?: boolean;
  /** 最後目擊的回合（hidden 時才有） */
  seenTurn?: number;
  /** 隔著煙霧看到的不明機體（可能是氣球） */
  unknown?: boolean;
  // 以下只有自己的機體才有
  pilotId?: string;
  stress?: number;
  maxStress?: number;
  propellant?: number;
  maxPropellant?: number;
  lockOn?: string | null;
  /** 不適合目前環境：機動盤最高速度減掉這麼多 */
  speedCut?: number;
  /** 在重力圈：腳斷了就動不了 */
  grounded?: boolean;
  /** 出擊費用（只看得到自己的；對手的駕駛不明） */
  cost?: number;
  blackout?: boolean;
}

export interface StateView {
  turn: number;
  obstacles: Obstacle[];
  /** 本回合擦撞、不能執行動作的機體（動作階段才有） */
  bumped: string[];
  /** 重力圈裡這回合噴射跳躍落地的機體（射擊命中下降） */
  jumped: string[];
  /** 擱置移動、還在等王牌移動步驟的機體 */
  deferred: string[];
  /** 看得出是氣球的欺敵氣球（自己的全部看得到） */
  balloons: { id: string; owner: PlayerId; pos: Vec }[];
  /** 知道的地雷：自己埋的，加上我方機體附近的敵方地雷 */
  mines: { id: string; owner: PlayerId; x: number; y: number }[];
  /** 飛行中的彈藥（雙方都看得到：自己發射的，和瞄準自己機體的來襲警告） */
  inbound: Inbound[];
  /** 看得到的敵方炮群（和母機看不看得到無關；母機藏著也可能看到它放出來的手臂或感應炮） */
  enemyPods: EnemyPod[];
  /** 自己還沒進場的增援 */
  reserves: { id: string; label: string; turn: number }[];
  /** 勝利條件與部署方式 */
  settings: BattleSettings;
  /** 達陣、據點進度 */
  objectives: ObjectiveState;
  /** 雙方的旗艦（斬首用，雙方都知道） */
  flagship: [string | null, string | null];
  /** 雙方的擊墜分 */
  score: [number, number];
  /** 規則第 6 版起：勝利點數（上一回合結束時） */
  points?: [number, number];
  winReason?: WinReason;
  /** 本回合各機的移動向量（動作階段才有；看不到的敵機不列） */
  velocity: Record<string, Vec>;
  /** 自己機體本回合的姿態（動作階段才有） */
  stance: Record<string, Stance>;
  units: UnitView[];
  grapples: GrappleState[];
  winner: GameState['winner'];
}

export function viewUnit(u: UnitState, viewer: PlayerId): UnitView {
  const base: UnitView = {
    id: u.id,
    owner: u.owner,
    ...(u.squad !== undefined && u.owner === viewer ? { squad: u.squad } : {}),
    label: u.label,
    chassisId: u.chassisId,
    pos: { ...u.pos },
    ...(u.z ? { z: u.z } : {}),
    ...(u.mark ? { mark: u.owner === viewer ? {} : { ...u.mark } } : {}),
    facing: u.facing,
    parts: structuredClone(u.parts),
    // 內藏武器第一次拿出來之前，對手看不到
    equipment: structuredClone(u.owner === viewer ? u.equipment : u.equipment.filter((e) => e.location !== 'housed' || e.revealed)),
    status: u.status === 'unconscious' && u.owner !== viewer ? 'disabled' : u.status,
    momentum: u.momentum,
    speedCut: u.speedCut,
    ...(u.grounded ? { grounded: true } : {}),
    vague: u.status === 'active' && u.stress >= u.maxStress ? 'sluggish' : null,
  };
  if (u.owner !== viewer) return base;
  return { ...base, pilotId: u.pilotId, cost: u.cost, stress: u.stress, maxStress: u.maxStress, propellant: u.propellant, maxPropellant: u.maxPropellant, lockOn: u.lockOn, blackout: u.blackout };
}

/** 依目前位置重算雙方看得到哪些敵機，並更新最後目擊紀錄。revealed：這一步開火或鎖定而暴露位置的機體 */
export function updateSight(state: GameState, revealed: Set<string> = new Set()): void {
  checkMarks(state);
  const obscured: [string[], string[]] = [[], []];
  for (const p of [0, 1] as PlayerId[]) {
    const eyes = state.units.filter((u) => u.owner === p && u.status === 'active');
    const lookOut = C.rulesAtLeast(state, 5) ? C.FIELD_LOOK_OUT_RANGE : undefined;
    const seen = state.units.filter(
      // 被標定的敵機不用視線也看得到
      // 開著的干擾器會暴露位置（第 4 版起）：ECM_REVEAL_RANGE 內不用視線也看得到
      // 在隕石群裡開火的，暴露到下一回合結束（第 5 版起）
      (e) =>
        e.owner !== p &&
        (revealed.has(e.id) ||
          !!e.mark ||
          (C.rulesAtLeast(state, 4) && !!ecmOf(e) && eyes.some((o) => dist(o.pos, e.pos) <= C.ECM_REVEAL_RANGE)) ||
          ((e.exposedUntil ?? -1) >= state.turn && eyes.some((o) => dist(o.pos, e.pos) <= C.FIELD_FIRE_EXPOSE_RANGE)) ||
          eyes.some((o) => canSee(state.obstacles, o.pos, sensorRange(o), e.pos, radiusOf(o) + radiusOf(e), o.z, e.z, lookOut))),
    );
    state.visible[p] = seen.map((e) => e.id);
    for (const e of seen) state.lastSeen[p][e.id] = sighting(e, state.turn);
    // 隔著煙霧（或在煙霧裡）只看得到有東西，認不出是什麼；開火的會暴露
    for (const e of seen) if (!revealed.has(e.id) && !e.mark && smokeHides(state, eyes, e.pos, radiusOf(e))) obscured[p].push(e.id);
  }
  state.obscured = obscured;
}

/** 標定機失去戰鬥能力、標定器或頭部壞了、目標超出它的感測距離：標定解除（視線、射界都不影響） */
export function checkMarks(state: GameState): void {
  for (const t of state.units) {
    if (!t.mark) continue;
    const by = state.units.find((x) => x.id === t.mark!.by);
    const ok =
      t.status === 'active' &&
      !!by &&
      by.status === 'active' &&
      !roleLost(by, 'sensor') &&
      by.equipment.some((e) => EQUIPMENT[e.defId].utility === 'mark' && equipAlive(by, e)) &&
      // 進入自己這一方的電子干擾範圍，或被煙霧裡的金屬粉隔開，標定就失效
      (C.rulesAtLeast(state, 4) || !jammed(state.units, t)) &&
      !chaffed(state.obstacles, by.pos, t.pos) &&
      dist(by.pos, t.pos) - radiusOf(by) - radiusOf(t) <= sensorRange(by);
    if (!ok) delete t.mark;
  }
  // 鎖定也一樣：目標在煙霧裡或隔著煙霧就失效
  for (const u of state.units) {
    const t = u.lockOn ? state.units.find((x) => x.id === u.lockOn) : undefined;
    if (t && chaffed(state.obstacles, u.pos, t.pos)) u.lockOn = null;
  }
}

/** 從這些機體看過去，p 位置的東西是不是都隔著煙霧（又沒有近到認得出來） */
export function smokeHides(state: GameState, eyes: UnitState[], at: Vec, r: number): boolean {
  const smoke = state.obstacles.filter((o) => o.kind === 'smoke');
  if (!smoke.length) return false;
  return eyes.every((o) => dist(o.pos, at) - radiusOf(o) - r <= C.SMOKE_ID_RANGE ? false : smoke.some((s) => dist(at, s) <= s.r || segmentHitsCircle(o.pos, at, s, s.r)));
}

export const sighting = (u: UnitState, turn: number) => ({
  turn,
  pos: { ...u.pos },
  ...(u.z ? { z: u.z } : {}),
  facing: u.facing,
  momentum: u.momentum,
  parts: structuredClone(u.parts),
  equipment: structuredClone(u.equipment),
  status: u.status,
});

export function viewState(s: GameState, viewer: PlayerId): StateView {
  const stance: Record<string, Stance> = {};
  for (const u of s.units) if (u.owner === viewer && s.turnInfo?.stance[u.id]) stance[u.id] = s.turnInfo.stance[u.id];
  const visible = new Set(s.visible[viewer]);
  const units: UnitView[] = [];
  const obscured = new Set(s.obscured?.[viewer] ?? []);
  for (const u of s.units) {
    if (u.owner === viewer || visible.has(u.id)) {
      const v = viewUnit(u, viewer);
      units.push(obscured.has(u.id) ? { ...v, label: '不明機體', unknown: true, vague: null } : v);
      continue;
    }
    // 看不到的敵機：用最後目擊時的樣子當殘影；擊毀之類的結果還是知道
    const seen = s.lastSeen[viewer][u.id];
    if (!seen) continue;
    const ghost = viewUnit({ ...u, pos: seen.pos, z: seen.z, facing: seen.facing, momentum: seen.momentum, parts: seen.parts, equipment: seen.equipment, stress: 0 }, viewer);
    units.push({ ...ghost, status: u.status === 'active' ? 'active' : ghost.status, vague: null, hidden: true, seenTurn: seen.turn });
  }
  // 欺敵氣球：在煙霧裡、對手又認不出來時看起來就像一台機體；不然就是一顆氣球
  const eyes = s.units.filter((u) => u.owner === viewer && u.status === 'active');
  const balloons: { id: string; owner: PlayerId; pos: Vec }[] = [];
  for (const d of s.decoys ?? []) {
    if (d.owner === viewer) {
      balloons.push({ id: d.id, owner: d.owner, pos: { ...d.pos } });
      continue;
    }
    const inRange = eyes.some((o) => canSee(s.obstacles.filter((x) => x.kind !== 'smoke'), o.pos, sensorRange(o), d.pos, radiusOf(o) + C.BASE_RADIUS));
    if (!inRange) continue;
    if (smokeHides(s, eyes, d.pos, C.BASE_RADIUS))
      units.push({ id: d.id, owner: d.owner, label: '不明機體', chassisId: d.chassisId, pos: { ...d.pos }, facing: d.facing, parts: structuredClone(d.parts), equipment: structuredClone(d.equipment.filter((e) => e.location !== 'housed' || e.revealed)), status: 'active', momentum: 0, vague: null, unknown: true });
    else balloons.push({ id: d.id, owner: d.owner, pos: { ...d.pos } });
  }
  // 對手的炮群：機體資料裡不放（母機可能看不到），看得到的另外列在 enemyPods
  for (const v of units) if (v.owner !== viewer) for (const e of v.equipment) delete e.pod;
  const enemyPods: EnemyPod[] = [];
  for (const u of s.units) {
    if (u.owner === viewer || u.status !== 'active') continue;
    for (const e of u.equipment) {
      if (!e.pod || !podSeen(s, u, e, viewer)) continue;
      const def = EQUIPMENT[e.defId];
      enemyPods.push({ id: e.id, owner: u.owner, mother: u.id, label: u.label, defId: e.defId, wired: !!def.psycommu?.wired, part: e.host ? u.parts[e.host]?.name : undefined, pos: { ...e.pod.pos }, bits: e.bits ?? def.psycommu!.count });
    }
  }
  const velocity: Record<string, Vec> = {};
  for (const [id, v] of Object.entries(s.turnInfo?.velocity ?? {})) if (units.some((u) => u.id === id && !u.hidden)) velocity[id] = { ...v };
  return { turn: s.turn, balloons, mines: structuredClone(knownMines(s.mines ?? [], s.units, viewer)), inbound: structuredClone(s.inbound ?? []), enemyPods, reserves: (s.reserves ?? []).filter((r) => r.unit.owner === viewer).map((r) => ({ id: r.unit.id, label: r.unit.label, turn: r.turn })), settings: structuredClone(s.settings ?? DEFAULT_SETTINGS), objectives: structuredClone(s.objectives ?? newObjectives()), flagship: [flagshipOf(s, 0)?.id ?? null, flagshipOf(s, 1)?.id ?? null], score: [killScoreOf(s, 0), killScoreOf(s, 1)], ...(s.points ? { points: [...s.points] as [number, number] } : {}), winReason: s.winReason, obstacles: structuredClone(s.obstacles), bumped: s.turnInfo?.bumped ?? [], jumped: (s.turnInfo?.jumped ?? []).filter((id) => units.some((u) => u.id === id && !u.hidden)), deferred: (s.turnInfo?.deferred ?? []).filter((id) => units.some((u) => u.id === id && !u.hidden)), velocity, stance, units, grapples: structuredClone(s.grapples), winner: s.winner };
}

/** 依視野過濾事件：看不到的敵機在移動中只留下看得到的那幾段，其他與它相關的細節不送出 */
export function filterEvents(events: GameEvent[], state: GameState, viewer: PlayerId): GameEvent[] {
  const owner = new Map(state.units.map((u) => [u.id, u.owner]));
  const mine = (id: string) => owner.get(id) === viewer;
  const visibleNow = new Set(state.visible[viewer]);
  const known = (id: string) => mine(id) || visibleNow.has(id);
  // 自己機體在移動途中每個時間點的位置，用來判斷那一刻看不看得到敵機
  const ownSamples = events.flatMap((e) => (e.type === 'move' && mine(e.unit) ? [{ unit: state.units.find((u) => u.id === e.unit)!, samples: e.samples }] : []));
  const seenAt = (k: number, x: number, y: number) =>
    ownSamples.some(({ unit, samples }) => {
      const s = samples[Math.min(k, samples.length - 1)];
      return !!s && canSee(state.obstacles, { x: s[0], y: s[1] }, sensorRange(unit), { x, y });
    });
  const out: GameEvent[] = [];
  for (const e of events) {
    switch (e.type) {
      case 'stress':
      case 'propellant':
      case 'actionFail':
        if (mine(e.unit)) out.push(e);
        break;
      case 'pilot':
        if (mine(e.unit)) out.push(e);
        else if (e.state === 'blackout' && known(e.unit)) out.push({ type: 'pilot', unit: e.unit, state: 'sluggish' });
        break;
      case 'shot': {
        const { chance, ...rest } = e;
        out.push(mine(e.attacker) && mine(e.target) ? e : rest);
        break;
      }
      case 'move':
        if (mine(e.unit)) out.push(e);
        else out.push({ ...e, samples: e.samples.map((s, k) => (s && seenAt(k, s[0], s[1]) ? s : null)) });
        break;
      case 'damage':
      case 'debris':
      case 'obstacle':
      case 'knockback':
      case 'reposition':
      case 'swap':
      case 'pod':
      case 'elevate':
        if (known(e.unit)) out.push(e);
        break;
      case 'podHit':
        if (mine(e.unit) || mine(e.by)) out.push(e);
        break;
      case 'mine':
        // 埋地雷是暗中的
        if (mine(e.unit)) out.push(e);
        break;
      case 'resupply':
        if (known(e.unit)) out.push(e);
        break;
      case 'buildingShot':
        // 建築被打大家都看得到；看不到的射手不知道是誰
        out.push(known(e.attacker) ? e : { ...e, attacker: '', chance: 0 });
        break;
      case 'jump':
        if (known(e.unit)) out.push(e);
        break;
      case 'smoke':
        // 煙霧大家都看得到；看不到是誰放的
        out.push(known(e.unit) ? e : { ...e, unit: '' });
        break;
      case 'mark':
        // 被標定的一方知道自己被照到，但看不到的話不知道是誰
        out.push(known(e.unit) ? e : { ...e, unit: '' });
        break;
      default:
        out.push(e);
    }
  }
  return out;
}
