import { createUnit } from '../src/setup';
import type { ActionPlan, GameState, MovePlan, PlayerId } from '../src/types';
import type { RosterEntry } from '../src/data';

export const saberX00: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_saber', 'right'], ['shield', 'left']] };
export const rifleX00: RosterEntry = { chassis: 'X-00', pilot: 'veteran', equipment: [['beam_rifle', 'right']] };

export function makeState(defs: { entry: RosterEntry; owner: PlayerId; x: number; y: number; facingDeg: number }[], seed = 1): GameState {
  const units = defs.map((d, i) => createUnit(d.entry, d.owner, i, { x: d.x, y: d.y }, (d.facingDeg * Math.PI) / 180));
  return { turn: 1, phase: 'move', turnInfo: null, obstacles: [], visible: [units.filter((u) => u.owner === 1).map((u) => u.id), units.filter((u) => u.owner === 0).map((u) => u.id)], lastSeen: [{}, {}], units, grapples: [], rngState: seed, contentVersion: 'test', winner: null };
}

/** 測試用：同一個物件同時當移動與動作指令 */
export type UnitPlan = MovePlan & ActionPlan;

export function plan(p: Partial<UnitPlan> & { maneuver: string }): UnitPlan {
  return { stance: 'shoot', facingOffset: 0, limiter: false, action: { type: 'none' }, ...p };
}
