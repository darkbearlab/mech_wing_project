// 部位配置：機型自訂部位，規則只看部位的功能標籤（核心、手、推進、腳、感測）。
import { BASE_RADIUS } from './config';
import { BODY_PART_NAMES, CHASSIS } from './data';
import type { ChassisDef, Hand, PartRole, PartState } from './types';

/** 人形範本：沒寫功能的部位照 id 推斷，舊資料不用改就能用 */
export const HUMANOID_ROLES: Record<string, PartRole> = { torso: 'core', rarm: 'rightHand', larm: 'leftHand', pack: 'propulsion', legs: 'legs', head: 'sensor' };
export const ROLE_NAMES: Record<PartRole, string> = { core: '核心', rightHand: '右手', leftHand: '左手', propulsion: '推進', legs: '腳', sensor: '感測' };
export const PART_ROLES = Object.keys(ROLE_NAMES) as PartRole[];

export const handRole = (hand: Hand): PartRole => (hand === 'right' ? 'rightHand' : 'leftHand');

/** 機型部位的實際名稱與功能（補上沒寫的預設值） */
export function chassisParts(c: Pick<ChassisDef, 'parts'>): { id: string; name: string; role: PartRole | null; weight: number; durability: number }[] {
  return Object.entries(c.parts ?? {}).map(([id, p]) => ({
    id,
    name: p.name || BODY_PART_NAMES[id] || id,
    role: p.role === undefined ? (HUMANOID_ROLES[id] ?? null) : p.role,
    weight: p.weight,
    durability: p.durability,
  }));
}

type HasParts = { parts: Record<string, PartState> };

export const roleParts = (u: HasParts, role: PartRole): PartState[] => Object.values(u.parts).filter((p) => p.kind === 'body' && p.role === role);

/** 有這個功能的部位全部被打壞（沒有這個功能的機型不算失去） */
export function roleLost(u: HasParts, role: PartRole): boolean {
  const ps = roleParts(u, role);
  return ps.length > 0 && ps.every((p) => p.destroyed);
}

/** 這隻手對應的部位 id；沒有手的機型回傳 null */
export const handPart = (u: HasParts, hand: Hand): string | null => roleParts(u, handRole(hand))[0]?.id ?? null;

/** 這個部位是哪隻手 */
export function handOfPart(u: HasParts, partId: string): Hand | null {
  const r = u.parts[partId]?.role;
  return r === 'rightHand' ? 'right' : r === 'leftHand' ? 'left' : null;
}

/** 核心部位（傷害沒有別處可去時落在這裡） */
export const corePart = (u: HasParts): string => roleParts(u, 'core').find((p) => !p.destroyed)?.id ?? roleParts(u, 'core')[0]?.id ?? Object.keys(u.parts)[0];

export const radiusOf = (u: { chassisId?: string }): number => (u.chassisId && CHASSIS[u.chassisId]?.radius) || BASE_RADIUS;
export const minSpeedOf = (u: { chassisId: string }): number => CHASSIS[u.chassisId]?.minSpeed ?? 0;
export const closeCombatOf = (u: { chassisId: string }): boolean => CHASSIS[u.chassisId]?.closeCombat !== false;

/** 是不是標準人形（畫面用方塊人形圖） */
export const isHumanoid = (u: HasParts): boolean => Object.keys(HUMANOID_ROLES).every((id) => u.parts[id]?.kind === 'body');
