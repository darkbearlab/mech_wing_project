import type { ChassisDef, EquipDef, PilotDef } from './types';

export const EQUIPMENT: Record<string, EquipDef> = {
  beam_rifle: { id: 'beam_rifle', name: '光束步槍', kind: 'ranged', weight: 2, durability: 2, damage: 3, shots: 1, mode: 'focused', ranges: { 1: -5, 2: 10, 3: -15 } },
  machine_gun: { id: 'machine_gun', name: '機槍', kind: 'ranged', weight: 2, durability: 2, damage: 1, shots: 4, mode: 'scattered', ranges: { 1: 10, 2: 0 } },
  sniper: { id: 'sniper', name: '狙擊步槍', kind: 'ranged', weight: 2, durability: 2, damage: 4, shots: 1, mode: 'focused', ranges: { 2: -10, 3: 10 } },
  bazooka: { id: 'bazooka', name: '火箭砲', kind: 'ranged', weight: 2, durability: 2, damage: 5, shots: 1, mode: 'focused', ranges: { 1: 0, 2: -5 } },
  beam_saber: { id: 'beam_saber', name: '光劍', kind: 'melee', weight: 1, durability: 1, damage: 3, mode: 'focused' },
  heat_axe: { id: 'heat_axe', name: '熱能斧', kind: 'melee', weight: 1, durability: 2, damage: 4, mode: 'focused', meleeDice: 1 },
  shield: { id: 'shield', name: '盾牌', kind: 'shield', weight: 4, durability: 6 },
  fuel_tank: { id: 'fuel_tank', name: '外掛燃料槽', kind: 'tank', weight: 2, durability: 1, fuel: 4 },
};

export const CHASSIS: Record<string, ChassisDef> = {
  'X-00': {
    id: 'X-00', name: 'X-00 量產型', weightClass: 2, propellant: 10, power: 2, aim: 0, evasion: 10,
    parts: { torso: { weight: 3, durability: 8 }, rarm: { weight: 2, durability: 4 }, larm: { weight: 2, durability: 4 }, pack: { weight: 2, durability: 4 }, legs: { weight: 2, durability: 4 }, head: { weight: 1, durability: 2 } },
    dial: ['hover-S-0', 'straight-S-1', 'straight-S-2', 'straight-S-3', 'straight-S-4', 'bank-L-1', 'bank-R-1', 'bank-L-2', 'bank-R-2', 'bank-L-3', 'bank-R-3', 'turn-L-1', 'turn-R-1', 'turn-L-2', 'turn-R-2', 'arc-L-4', 'arc-R-4', 'kturn-S-3'],
  },
  'X-01': {
    id: 'X-01', name: 'X-01 高機動型', weightClass: 1, propellant: 12, power: 1, aim: 5, evasion: 20,
    parts: { torso: { weight: 3, durability: 6 }, rarm: { weight: 2, durability: 3 }, larm: { weight: 2, durability: 3 }, pack: { weight: 3, durability: 3 }, legs: { weight: 2, durability: 3 }, head: { weight: 1, durability: 2 } },
    dial: ['hover-S-0', 'straight-S-1', 'straight-S-2', 'straight-S-3', 'straight-S-4', 'straight-S-5', 'bank-L-1', 'bank-R-1', 'bank-L-2', 'bank-R-2', 'bank-L-3', 'bank-R-3', 'turn-L-1', 'turn-R-1', 'turn-L-2', 'turn-R-2', 'turn-L-3', 'turn-R-3', 'arc-L-4', 'arc-R-4', 'arc-L-5', 'arc-R-5', 'kturn-S-2', 'kturn-S-3', 'kturn-S-4'],
  },
  'X-02': {
    id: 'X-02', name: 'X-02 重裝型', weightClass: 3, propellant: 8, power: 4, aim: 0, evasion: 0,
    parts: { torso: { weight: 3, durability: 12 }, rarm: { weight: 2, durability: 6 }, larm: { weight: 2, durability: 6 }, pack: { weight: 2, durability: 5 }, legs: { weight: 2, durability: 6 }, head: { weight: 1, durability: 3 } },
    dial: ['hover-S-0', 'straight-S-1', 'straight-S-2', 'straight-S-3', 'bank-L-1', 'bank-R-1', 'bank-L-2', 'bank-R-2', 'turn-L-1', 'turn-R-1', 'kturn-S-2'],
  },
};

export const PILOTS: Record<string, PilotDef> = {
  recruit: { id: 'recruit', name: '徵招兵', skill: 1, maxStress: 5, recovery: 1, abilities: [] },
  veteran: { id: 'veteran', name: '老兵', skill: 3, maxStress: 7, recovery: 2, abilities: [] },
  ace: { id: 'ace', name: '王牌', skill: 5, maxStress: 8, recovery: 2, abilities: ['quick_draw'] },
};

export const BODY_PART_NAMES: Record<string, string> = {
  torso: '軀幹', rarm: '右臂', larm: '左臂', pack: '推進背包', legs: '腿部', head: '頭部',
};

export interface RosterEntry {
  chassis: string;
  pilot: string;
  /** [裝備 id, 位置] */
  equipment: [string, 'right' | 'left' | 'stowed' | 'mount'][];
}

export const DEFAULT_ROSTERS: [RosterEntry[], RosterEntry[]] = [
  [
    { chassis: 'X-00', pilot: 'recruit', equipment: [['beam_rifle', 'right'], ['shield', 'left'], ['beam_saber', 'stowed']] },
    { chassis: 'X-01', pilot: 'ace', equipment: [['beam_saber', 'right'], ['machine_gun', 'stowed']] },
    { chassis: 'X-02', pilot: 'veteran', equipment: [['bazooka', 'right'], ['shield', 'left'], ['heat_axe', 'stowed'], ['fuel_tank', 'mount']] },
  ],
  [
    { chassis: 'X-00', pilot: 'ace', equipment: [['beam_rifle', 'right'], ['shield', 'left'], ['beam_saber', 'stowed']] },
    { chassis: 'X-00', pilot: 'recruit', equipment: [['machine_gun', 'right'], ['beam_saber', 'stowed']] },
    { chassis: 'X-01', pilot: 'veteran', equipment: [['sniper', 'right'], ['beam_saber', 'stowed'], ['fuel_tank', 'mount']] },
  ],
];
