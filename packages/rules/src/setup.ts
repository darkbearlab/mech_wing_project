import { MAP_SIZE, ROSTER_MODE, START_MOMENTUM } from './config';
import { contentVersion } from './content';
import { Rng } from './rng';
import { generateObstacles } from './terrain';
import { sighting, updateSight } from './visibility';
import { chassisParts } from './body';
import { CHASSIS, DEFAULT_ROSTERS, EQUIPMENT, PILOTS, randomRoster, type RosterEntry } from './data';
import { DEFAULT_SETTINGS, controlPoints, entryCost, newObjectives, type BattleSettings } from './objectives';
import type { EquipState, GameState, PartState, PlayerId, UnitState } from './types';

export function createUnit(entry: RosterEntry, owner: PlayerId, index: number, pos: { x: number; y: number }, facing: number): UnitState {
  const chassis = CHASSIS[entry.chassis];
  const pilot = PILOTS[entry.pilot];
  const id = `p${owner}u${index}`;
  const parts: Record<string, PartState> = {};
  for (const p of chassisParts(chassis)) {
    parts[p.id] = { id: p.id, name: p.name, kind: 'body', role: p.role, weight: p.weight, durability: p.durability, damage: 0, destroyed: false };
  }
  let fuel = 0;
  const gear: RosterEntry['equipment'] = [...entry.equipment, ...(chassis.builtIn ?? []).map((b) => [b.defId, EQUIPMENT[b.defId].mount === 'mounted' ? 'mount' : 'builtin', b.host] as RosterEntry['equipment'][number])];
  const equipment = gear.map(([defId, location, host], i): EquipState => {
    const def = EQUIPMENT[defId];
    const eid = `${id}e${i}`;
    // 內建與內藏的武器沒有自己的部位，和宿主共存亡
    if (location !== 'builtin' && location !== 'housed') parts[eid] = { id: eid, name: def.name, kind: 'equip', weight: def.weight, durability: def.durability, damage: 0, destroyed: false };
    fuel += def.fuel ?? 0;
    const e: EquipState = { id: eid, defId, location };
    if (host) e.host = host;
    if (location === 'housed') e.home = 'housed';
    if (def.ammo !== undefined) e.ammo = def.ammo;
    return e;
  });
  return {
    id,
    owner,
    label: `${owner === 0 ? 'A' : 'B'}${index + 1} ${chassis.id}`,
    chassisId: chassis.id,
    pilotId: pilot.id,
    cost: entryCost(entry),
    pos,
    facing,
    momentum: Math.max(START_MOMENTUM, chassis.minSpeed ?? 0),
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

export function createGame(seed: number, rosters: [RosterEntry[], RosterEntry[]] = pickRosters(seed), settings: BattleSettings = DEFAULT_SETTINGS): GameState {
  const units: UnitState[] = [];
  rosters.forEach((roster, owner) => {
    const y = owner === 0 ? 2 : MAP_SIZE - 2;
    const facing = owner === 0 ? Math.PI / 2 : -Math.PI / 2;
    roster.forEach((entry, i) => {
      const x = MAP_SIZE / 2 + (i - (roster.length - 1) / 2) * 4;
      units.push(createUnit(entry, owner as PlayerId, i, { x, y }, facing));
    });
  });
  // 有據點時，大隕石與隕石群要避開據點
  const obstacles = generateObstacles(new Rng((seed ^ 0x5bd1e995) >>> 0), settings.control ? controlPoints() : []);
  const free = settings.deploy === 'free';
  const state: GameState = { turn: 1, phase: free ? 'deploy' : 'move', turnInfo: null, obstacles, visible: [[], []], lastSeen: [{}, {}], units, grapples: [], rngState: seed >>> 0, contentVersion: contentVersion(), winner: null, settings: structuredClone(settings), objectives: newObjectives() };
  // 固定排開時雙方都知道對方的部署位置（第 0 回合的目擊），之後就要靠視野；自由部署則看不到
  if (!free) for (const u of units) state.lastSeen[(1 - u.owner) as PlayerId][u.id] = sighting(u, 0);
  updateSight(state);
  return state;
}
