import { MAP_SIZE, ROSTER_MODE, START_MOMENTUM } from './config';
import { Rng } from './rng';
import { generateObstacles } from './terrain';
import { sighting, updateSight } from './visibility';
import { BODY_PART_NAMES, CHASSIS, DEFAULT_ROSTERS, EQUIPMENT, PILOTS, randomRoster, type RosterEntry } from './data';
import type { GameState, PartState, PlayerId, UnitState } from './types';

export function createUnit(entry: RosterEntry, owner: PlayerId, index: number, pos: { x: number; y: number }, facing: number): UnitState {
  const chassis = CHASSIS[entry.chassis];
  const pilot = PILOTS[entry.pilot];
  const id = `p${owner}u${index}`;
  const parts: Record<string, PartState> = {};
  for (const [pid, p] of Object.entries(chassis.parts)) {
    parts[pid] = { id: pid, name: BODY_PART_NAMES[pid], kind: 'body', weight: p.weight, durability: p.durability, damage: 0, destroyed: false };
  }
  let fuel = 0;
  const equipment = entry.equipment.map(([defId, location], i) => {
    const def = EQUIPMENT[defId];
    const eid = `${id}e${i}`;
    parts[eid] = { id: eid, name: def.name, kind: 'equip', weight: def.weight, durability: def.durability, damage: 0, destroyed: false };
    fuel += def.fuel ?? 0;
    return { id: eid, defId, location };
  });
  return {
    id,
    owner,
    label: `${owner === 0 ? 'A' : 'B'}${index + 1} ${chassis.id}`,
    chassisId: chassis.id,
    pilotId: pilot.id,
    pos,
    facing,
    momentum: START_MOMENTUM,
    propellant: chassis.propellant + fuel,
    maxPropellant: chassis.propellant + fuel,
    stress: 0,
    maxStress: pilot.maxStress,
    parts,
    equipment,
    lockOn: null,
    status: 'active',
    blackout: false,
  };
}

/** 依 ROSTER_MODE 決定陣容：固定、雙方各自隨機、或雙方同一套隨機陣容 */
export function pickRosters(seed: number): [RosterEntry[], RosterEntry[]] {
  if (ROSTER_MODE === 'default') return DEFAULT_ROSTERS;
  const rng = new Rng((seed ^ 0x9e3779b9) >>> 0);
  const a = randomRoster(() => rng.next());
  return [a, ROSTER_MODE === 'mirror' ? structuredClone(a) : randomRoster(() => rng.next())];
}

export function createGame(seed: number, rosters: [RosterEntry[], RosterEntry[]] = pickRosters(seed)): GameState {
  const units: UnitState[] = [];
  rosters.forEach((roster, owner) => {
    const y = owner === 0 ? 2 : MAP_SIZE - 2;
    const facing = owner === 0 ? Math.PI / 2 : -Math.PI / 2;
    roster.forEach((entry, i) => {
      const x = MAP_SIZE / 2 + (i - (roster.length - 1) / 2) * 4;
      units.push(createUnit(entry, owner as PlayerId, i, { x, y }, facing));
    });
  });
  const obstacles = generateObstacles(new Rng((seed ^ 0x5bd1e995) >>> 0));
  const state: GameState = { turn: 1, phase: 'move', turnInfo: null, obstacles, visible: [[], []], lastSeen: [{}, {}], units, grapples: [], rngState: seed >>> 0, winner: null };
  // 開場時雙方都知道對方的部署位置（第 0 回合的目擊），之後就要靠視野
  for (const u of units) state.lastSeen[(1 - u.owner) as PlayerId][u.id] = sighting(u, 0);
  updateSight(state);
  return state;
}
