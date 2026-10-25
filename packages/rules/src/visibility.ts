import type { EquipState, GameEvent, GameState, GrappleState, PartState, PlayerId, UnitState, UnitStatus, Vec } from './types';

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
  /** 對手唯一看得到的駕駛狀態 */
  vague: 'sluggish' | null;
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
    equipment: structuredClone(u.equipment),
    status: u.status === 'unconscious' && u.owner !== viewer ? 'disabled' : u.status,
    vague: u.status === 'active' && u.stress >= u.maxStress ? 'sluggish' : null,
  };
  if (u.owner !== viewer) return base;
  return { ...base, pilotId: u.pilotId, stress: u.stress, maxStress: u.maxStress, propellant: u.propellant, maxPropellant: u.maxPropellant, lockOn: u.lockOn, blackout: u.blackout };
}

export function viewState(s: GameState, viewer: PlayerId): StateView {
  return { turn: s.turn, units: s.units.map((u) => viewUnit(u, viewer)), grapples: structuredClone(s.grapples), winner: s.winner };
}

export function filterEvents(events: GameEvent[], state: GameState, viewer: PlayerId): GameEvent[] {
  const owner = new Map(state.units.map((u) => [u.id, u.owner]));
  const mine = (id: string) => owner.get(id) === viewer;
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
        else if (e.state === 'blackout') out.push({ type: 'pilot', unit: e.unit, state: 'sluggish' });
        break;
      case 'shot': {
        const { chance, ...rest } = e;
        out.push(mine(e.attacker) && mine(e.target) ? e : rest);
        break;
      }
      case 'strike': {
        const { chance, ...rest } = e;
        out.push(mine(e.attacker) && mine(e.defender) ? e : rest);
        break;
      }
      default:
        out.push(e);
    }
  }
  return out;
}
