// 武裝掛點：把一台機體能裝東西的位置列成一格一格（左右手、左右與背上的武器架、外掛掛點、手臂內建、內藏），
// 給出擊準備的武裝編輯器用。配裝（RosterEntry.equipment）和掛點互相轉換；每個掛點一件。
// 機型另外限制載重（裝備重量加總）與重掛點（重型外掛幾件），有些裝備只有特定機型能裝。
import { chassisParts } from './body';
import { CHASSIS, EQUIPMENT, type RosterEntry } from './data';
import type { Hand } from './types';

export type SlotKind = 'hand' | 'rack' | 'mount' | 'builtin' | 'housed';
type Gear = RosterEntry['equipment'];
type GearItem = Gear[number];

export interface GearSlot {
  key: string;
  name: string;
  kind: SlotKind;
  /** 手、武器架、內藏是哪一側 */
  side?: Hand;
  /** 寫進配裝的宿主部位（背上的武器架沒有） */
  host?: string;
}

const SIDE_NAME: Record<Hand, string> = { right: '右', left: '左' };
/** 軀幹有兩個肩部掛點；頭和手臂不開外掛掛點 */
const MOUNT_NAMES: Record<string, string[]> = { torso: ['右肩', '左肩'], pack: ['背部'], legs: ['腿部'] };

/** 這個機型的掛點（被手臂內建武器佔住的手，連同那一側的武器架都沒有） */
export function gearSlots(chassisId: string): GearSlot[] {
  const c = CHASSIS[chassisId];
  if (!c) return [];
  const parts = chassisParts(c);
  const handPart = (h: Hand) => parts.find((p) => p.role === (h === 'right' ? 'rightHand' : 'leftHand'));
  const blocked = new Set((c.builtIn ?? []).filter((b) => EQUIPMENT[b.defId]?.blocksHand).map((b) => b.host));
  const out: GearSlot[] = [];
  const hands = (['right', 'left'] as Hand[]).filter((h) => handPart(h) && !blocked.has(handPart(h)!.id));
  for (const h of hands) out.push({ key: `hand-${h}`, name: `${SIDE_NAME[h]}手`, kind: 'hand', side: h });
  for (const h of hands) out.push({ key: `rack-${h}`, name: `${SIDE_NAME[h]}架`, kind: 'rack', side: h, host: handPart(h)!.id });
  if (hands.length) out.push({ key: 'rack-back', name: '背架', kind: 'rack' });
  for (const p of parts) {
    if (p.role === 'rightHand' || p.role === 'leftHand' || p.role === 'sensor') continue;
    const names = MOUNT_NAMES[p.id] ?? [`${p.name}掛點`];
    names.forEach((name, i) => out.push({ key: `mount-${p.id}-${i}`, name, kind: 'mount', host: p.id }));
  }
  for (const h of hands) out.push({ key: `builtin-${h}`, name: `${SIDE_NAME[h]}臂內建`, kind: 'builtin', side: h, host: handPart(h)!.id });
  for (const h of hands) out.push({ key: `housed-${h}`, name: `${SIDE_NAME[h]}臂內藏`, kind: 'housed', side: h, host: handPart(h)!.id });
  return out;
}

/** 這件裝備能不能放在這個掛點（給了機型時，也看機型能不能裝、有沒有重掛點） */
export function slotFits(slot: GearSlot, defId: string, chassisId?: string): boolean {
  const def = EQUIPMENT[defId];
  if (!def) return false;
  if (chassisId && !chassisAllows(chassisId, defId)) return false;
  if (chassisId && def.heavy && CHASSIS[chassisId]?.heavyMounts === 0) return false;
  const mount = def.mount ?? 'hand';
  if (slot.kind === 'hand') return mount === 'hand';
  if (slot.kind === 'rack') return mount === 'hand' && def.kind !== 'shield';
  if (slot.kind === 'mount') return mount === 'mounted';
  // 佔手的內建武器（手指光束砲）是機型的事，配裝不能加
  if (slot.kind === 'builtin') return mount === 'integrated' && !def.blocksHand;
  return mount === 'housed';
}

/** 配裝放進掛點：放不進去的（掛點不夠、位置不對）放在 extra，不會弄丟 */
export function gearToSlots(chassisId: string, gear: Gear): { filled: Record<string, string>; extra: Gear } {
  const slots = gearSlots(chassisId);
  const filled: Record<string, string> = {};
  const extra: Gear = [];
  const free = (pred: (s: GearSlot) => boolean) => slots.find((s) => !filled[s.key] && pred(s));
  const sideOf = (host?: string) => (host ? slots.find((s) => s.host === host && s.side)?.side : undefined);
  for (const item of gear) {
    const [defId, loc, host] = item;
    let slot: GearSlot | undefined;
    if (loc === 'right' || loc === 'left') slot = free((s) => s.kind === 'hand' && s.side === loc);
    else if (loc === 'stowed') {
      const side = sideOf(host);
      slot = side ? free((s) => s.kind === 'rack' && s.side === side) : (free((s) => s.key === 'rack-back') ?? free((s) => s.kind === 'rack'));
    } else if (loc === 'mount') slot = (host ? free((s) => s.kind === 'mount' && s.host === host) : undefined) ?? free((s) => s.kind === 'mount' && s.host === 'pack') ?? free((s) => s.kind === 'mount');
    else if (loc === 'builtin') slot = free((s) => s.kind === 'builtin' && s.host === host);
    else if (loc === 'housed') slot = free((s) => s.kind === 'housed' && s.host === host) ?? free((s) => s.kind === 'housed');
    if (slot && slotFits(slot, defId, chassisId)) filled[slot.key] = defId;
    else extra.push(item);
  }
  return { filled, extra };
}

/** 掛點換回配裝（照掛點的順序，最後接上放不進掛點的） */
export function slotsToGear(chassisId: string, filled: Record<string, string>, extra: Gear = []): Gear {
  const out: Gear = [];
  for (const s of gearSlots(chassisId)) {
    const id = filled[s.key];
    if (!id) continue;
    const item: GearItem =
      s.kind === 'hand' ? [id, s.side!] : s.kind === 'rack' ? (s.host ? [id, 'stowed', s.host] : [id, 'stowed']) : s.kind === 'mount' ? [id, 'mount', s.host!] : s.kind === 'builtin' ? [id, 'builtin', s.host!] : [id, 'housed', s.host!];
    out.push(item);
  }
  return [...out, ...extra];
}

/** 這個機型能不能裝這件裝備（專用裝備） */
export function chassisAllows(chassisId: string, defId: string): boolean {
  const only = EQUIPMENT[defId]?.chassisOnly;
  return !only || only.includes(chassisId);
}

/** 這套配裝的載重與重掛點用量（機型沒寫上限的是 null） */
export function gearLoad(chassisId: string, gear: Gear): { load: number; maxLoad: number | null; heavy: number; maxHeavy: number | null } {
  const c = CHASSIS[chassisId];
  const defs = gear.map(([d]) => EQUIPMENT[d]).filter(Boolean);
  return {
    load: defs.reduce((n, d) => n + (d.weight ?? 0), 0),
    maxLoad: c?.load ?? null,
    heavy: defs.filter((d) => d.heavy).length,
    maxHeavy: c?.heavyMounts ?? null,
  };
}

/** 配裝的問題：放不進掛點、超過載重、重掛點不夠、機型不能裝 */
export function gearProblems(chassisId: string, gear: Gear): string[] {
  const out: string[] = [];
  const only = gear.filter(([d]) => EQUIPMENT[d] && !chassisAllows(chassisId, d));
  if (only.length) out.push(`${only.map(([d]) => EQUIPMENT[d].name).join('、')}不能裝在這個機型上`);
  const { load, maxLoad, heavy, maxHeavy } = gearLoad(chassisId, gear);
  if (maxHeavy !== null && heavy > maxHeavy) out.push(maxHeavy ? `重型外掛 ${heavy} 件，這個機型只有 ${maxHeavy} 個重掛點` : '這個機型沒有重掛點，不能裝重型外掛');
  if (maxLoad !== null && load > maxLoad) out.push(`載重 ${load} 超過上限 ${maxLoad}`);
  const extra = gearToSlots(chassisId, gear).extra.filter(([d]) => EQUIPMENT[d] && chassisAllows(chassisId, d) && !(EQUIPMENT[d].heavy && maxHeavy === 0));
  if (extra.length) out.push(`${extra.map(([d, loc, host]) => `${EQUIPMENT[d].name}@${loc}${host ? `/${host}` : ''}`).join('、')} 放不進掛點`);
  return out;
}
