import { createUnit } from '../src/setup';
import type { GameState, PlayerId, UnitPlan } from '../src/types';
import type { RosterEntry } from '../src/data';

export const saberX00: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_saber', 'right'], ['shield', 'left']] };
export const rifleX00: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right']] };

export function makeState(defs: { entry: RosterEntry; owner: PlayerId; x: number; y: number; facingDeg: number }[], seed = 1): GameState {
  const units = defs.map((d, i) => createUnit(d.entry, d.owner, i, { x: d.x, y: d.y }, (d.facingDeg * Math.PI) / 180));
  return { turn: 1, units, grapples: [], rngState: seed, winner: null };
}

export function plan(p: Partial<UnitPlan> & { maneuver: string }): UnitPlan {
  return { stance: 'normal', facingOffset: 0, limiter: false, soften: false, action: { type: 'none' }, ...p };
}
