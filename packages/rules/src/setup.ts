import { MAP_SIZE } from './config';
import { BODY_PART_NAMES, CHASSIS, DEFAULT_ROSTERS, EQUIPMENT, PILOTS, type RosterEntry } from './data';
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

export function createGame(seed: number, rosters: [RosterEntry[], RosterEntry[]] = DEFAULT_ROSTERS): GameState {
  const units: UnitState[] = [];
  rosters.forEach((roster, owner) => {
    const y = owner === 0 ? 2 : MAP_SIZE - 2;
    const facing = owner === 0 ? Math.PI / 2 : -Math.PI / 2;
    roster.forEach((entry, i) => {
      const x = MAP_SIZE / 2 + (i - (roster.length - 1) / 2) * 4;
      units.push(createUnit(entry, owner as PlayerId, i, { x, y }, facing));
    });
  });
  return { turn: 1, units, grapples: [], rngState: seed >>> 0, winner: null };
}
