import { canSee, sensorRange } from './vision';
import type { EquipState, GameEvent, GameState, GrappleState, Obstacle, PartState, PlayerId, Stance, UnitState, UnitStatus, Vec } from './types';

/** 對手看得到機體，看不到駕駛 */
export interface UnitView {
  id: string;
  owner: PlayerId;
  label: string;
  chassisId: string;
  pos: Vec;
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
  // 以下只有自己的機體才有
  pilotId?: string;
  stress?: number;
  maxStress?: number;
  propellant?: number;
  maxPropellant?: number;
  lockOn?: string | null;
  blackout?: boolean;
}

export interface StateView {
  turn: number;
  obstacles: Obstacle[];
  /** 本回合擦撞、不能執行動作的機體（動作階段才有） */
  bumped: string[];
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
    label: u.label,
    chassisId: u.chassisId,
    pos: { ...u.pos },
    facing: u.facing,
    parts: structuredClone(u.parts),
    // 內藏武器第一次拿出來之前，對手看不到
    equipment: structuredClone(u.owner === viewer ? u.equipment : u.equipment.filter((e) => e.location !== 'housed' || e.revealed)),
    status: u.status === 'unconscious' && u.owner !== viewer ? 'disabled' : u.status,
    momentum: u.momentum,
    vague: u.status === 'active' && u.stress >= u.maxStress ? 'sluggish' : null,
  };
  if (u.owner !== viewer) return base;
  return { ...base, pilotId: u.pilotId, stress: u.stress, maxStress: u.maxStress, propellant: u.propellant, maxPropellant: u.maxPropellant, lockOn: u.lockOn, blackout: u.blackout };
}

/** 依目前位置重算雙方看得到哪些敵機，並更新最後目擊紀錄。revealed：這一步開火或鎖定而暴露位置的機體 */
export function updateSight(state: GameState, revealed: Set<string> = new Set()): void {
  for (const p of [0, 1] as PlayerId[]) {
    const eyes = state.units.filter((u) => u.owner === p && u.status === 'active');
    const seen = state.units.filter(
      (e) => e.owner !== p && (revealed.has(e.id) || eyes.some((o) => canSee(state.obstacles, o.pos, sensorRange(o), e.pos))),
    );
    state.visible[p] = seen.map((e) => e.id);
    for (const e of seen) state.lastSeen[p][e.id] = sighting(e, state.turn);
  }
}

export const sighting = (u: UnitState, turn: number) => ({
  turn,
  pos: { ...u.pos },
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
  for (const u of s.units) {
    if (u.owner === viewer || visible.has(u.id)) {
      units.push(viewUnit(u, viewer));
      continue;
    }
    // 看不到的敵機：用最後目擊時的樣子當殘影；擊毀之類的結果還是知道
    const seen = s.lastSeen[viewer][u.id];
    if (!seen) continue;
    const ghost = viewUnit({ ...u, pos: seen.pos, facing: seen.facing, momentum: seen.momentum, parts: seen.parts, equipment: seen.equipment, stress: 0 }, viewer);
    units.push({ ...ghost, status: u.status === 'active' ? 'active' : ghost.status, vague: null, hidden: true, seenTurn: seen.turn });
  }
  const velocity: Record<string, Vec> = {};
  for (const [id, v] of Object.entries(s.turnInfo?.velocity ?? {})) if (units.some((u) => u.id === id && !u.hidden)) velocity[id] = { ...v };
  return { turn: s.turn, obstacles: structuredClone(s.obstacles), bumped: s.turnInfo?.bumped ?? [], velocity, stance, units, grapples: structuredClone(s.grapples), winner: s.winner };
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
        if (known(e.unit)) out.push(e);
        break;
      default:
        out.push(e);
    }
  }
  return out;
}
