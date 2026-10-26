// 遊戲資料（機型、武器、駕駛、配裝、預設陣容）。
// 內容存在 packages/rules/content/*.json；這裡的表格是「目前使用中的資料包」，啟動時載入預設資料，
// 之後可以用 content.ts 的 useContent() 換成別的版本（例如從伺服器抓下來的）。
import chassisJson from '../content/chassis.json';
import equipmentJson from '../content/equipment.json';
import loadoutsJson from '../content/loadouts.json';
import pilotsJson from '../content/pilots.json';
import rostersJson from '../content/rosters.json';
import type { ChassisDef, EquipDef, PilotDef } from './types';

export interface RosterEntry {
  chassis: string;
  pilot: string;
  /** [裝備 id, 位置, 宿主部位]（外掛、內建、內藏要寫宿主） */
  equipment: [string, 'right' | 'left' | 'stowed' | 'mount' | 'builtin' | 'housed', string?][];
}

export const EQUIPMENT: Record<string, EquipDef> = {};
export const CHASSIS: Record<string, ChassisDef> = {};
export const PILOTS: Record<string, PilotDef> = {};
/** 隨機陣容用的各機型配裝 */
export const LOADOUTS: Record<string, RosterEntry['equipment'][]> = {};
export const DEFAULT_ROSTERS: [RosterEntry[], RosterEntry[]] = [[], []];

/** 打包在程式裡的預設資料；JSON 的型別比較寬，載入時由 validateContent 檢查 */
export const BUILTIN_CONTENT = {
  equipment: equipmentJson as unknown as Record<string, EquipDef>,
  chassis: chassisJson as unknown as Record<string, ChassisDef>,
  pilots: pilotsJson as unknown as Record<string, PilotDef>,
  loadouts: loadoutsJson as unknown as Record<string, RosterEntry['equipment'][]>,
  rosters: rostersJson as unknown as [RosterEntry[], RosterEntry[]],
};

/** 把資料表換成另一份內容（原地替換，所有 import 這些表的地方都會看到新內容） */
export function replaceTables(c: typeof BUILTIN_CONTENT): void {
  const swap = <T extends object>(target: Record<string, T>, src: Record<string, T>) => {
    for (const k of Object.keys(target)) delete target[k];
    Object.assign(target, structuredClone(src));
  };
  swap(EQUIPMENT, c.equipment);
  swap(CHASSIS, c.chassis);
  swap(PILOTS, c.pilots);
  swap(LOADOUTS, c.loadouts);
  DEFAULT_ROSTERS[0] = structuredClone(c.rosters[0]);
  DEFAULT_ROSTERS[1] = structuredClone(c.rosters[1]);
}

replaceTables(BUILTIN_CONTENT);

export const BODY_PART_NAMES: Record<string, string> = {
  torso: '軀幹', rarm: '右臂', larm: '左臂', pack: '推進背包', legs: '腿部', head: '頭部',
};

export function randomRoster(next: () => number, size = 3): RosterEntry[] {
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)];
  return Array.from({ length: size }, () => {
    const chassis = pick(Object.keys(LOADOUTS));
    return { chassis, pilot: pick(Object.keys(PILOTS)), equipment: pick(LOADOUTS[chassis]).map(([id, loc, host]) => (host ? [id, loc, host] : [id, loc]) as RosterEntry['equipment'][number]) };
  });
}
