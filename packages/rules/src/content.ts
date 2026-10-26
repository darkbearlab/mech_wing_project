// 資料包：一份完整的機型、武器、駕駛、配裝與預設陣容，帶版本號。
// 每場對戰記下開場時用的版本，之後換資料也不影響進行中的對戰與重播。
import { BODY_PART_NAMES, BUILTIN_CONTENT, replaceTables, type RosterEntry } from './data';
import { MAX_DIAL_SPEED } from './config';
import { parseManeuver } from './maneuvers';
import type { ChassisDef, EquipDef, PilotDef } from './types';

export interface ContentPack {
  version: string;
  equipment: Record<string, EquipDef>;
  chassis: Record<string, ChassisDef>;
  pilots: Record<string, PilotDef>;
  loadouts: Record<string, RosterEntry['equipment'][]>;
  rosters: [RosterEntry[], RosterEntry[]];
}

export const BUILTIN_VERSION = 'builtin-1';
export const DEFAULT_CONTENT: ContentPack = { version: BUILTIN_VERSION, ...BUILTIN_CONTENT };

let active = BUILTIN_VERSION;
export const contentVersion = (): string => active;

/** 換成另一份資料包；格式有問題就丟出錯誤、不換 */
export function useContent(pack: ContentPack): void {
  const errors = validateContent(pack);
  if (errors.length) throw new Error(`資料包 ${pack.version} 有 ${errors.length} 個問題：\n${errors.join('\n')}`);
  replaceTables(pack);
  active = pack.version;
}

const BODY = Object.keys(BODY_PART_NAMES);
const KINDS = ['ranged', 'melee', 'shield', 'tank'];
const MOUNTS = ['hand', 'mounted', 'integrated', 'housed'];
const TAGS = ['quickDraw', 'secondary', 'volatile'];
const ABILITIES = ['quick_draw'];
const isNum = (v: unknown, min = -Infinity) => typeof v === 'number' && Number.isFinite(v) && v >= min;

/** 檢查資料包，回傳所有問題（空陣列代表沒問題） */
export function validateContent(pack: ContentPack): string[] {
  const errs: string[] = [];
  const err = (where: string, msg: string) => errs.push(`${where}：${msg}`);
  if (!pack.version) err('資料包', '沒有版本號');

  for (const [key, e] of Object.entries(pack.equipment ?? {})) {
    const w = `武器 ${key}`;
    if (e.id !== key) err(w, `id（${e.id}）要和鍵名一致`);
    if (!e.name) err(w, '沒有名稱');
    if (!KINDS.includes(e.kind)) err(w, `kind 不正確（${e.kind}）`);
    const mount = e.mount ?? 'hand';
    if (!MOUNTS.includes(mount)) err(w, `mount 不正確（${mount}）`);
    const hasBody = mount === 'hand' || mount === 'mounted';
    if (!isNum(e.weight, 0)) err(w, 'weight 要是 0 以上的數字');
    if (hasBody && !isNum(e.durability, 1)) err(w, '手持與外掛裝備的 durability 至少 1');
    if ((e.kind === 'ranged' || e.kind === 'melee') && !isNum(e.damage, 1)) err(w, '武器的 damage 至少 1');
    if (e.kind === 'ranged') {
      if (!isNum(e.shots ?? 1, 1)) err(w, 'shots 至少 1');
      const bands = Object.keys(e.ranges ?? {});
      if (!bands.length) err(w, '射擊武器至少要有一個距離帶修正（ranges）');
      for (const b of bands) if (!['1', '2', '3'].includes(b) || !isNum(e.ranges![b as unknown as 1])) err(w, `ranges 的距離帶 ${b} 不正確`);
    }
    if (e.mode !== undefined && e.mode !== 'focused' && e.mode !== 'scattered') err(w, `mode 不正確（${e.mode}）`);
    if (e.arc !== undefined && !(isNum(e.arc, 1) && e.arc <= 180)) err(w, 'arc 要在 1–180 度之間');
    if (e.ammo !== undefined && !(Number.isInteger(e.ammo) && e.ammo >= 1)) err(w, 'ammo 要是 1 以上的整數');
    for (const t of e.tags ?? []) if (!TAGS.includes(t)) err(w, `不認得的標籤 ${t}`);
    if (e.blocksHand && mount !== 'integrated') err(w, 'blocksHand 只能用在內建武器');
  }

  for (const [key, c] of Object.entries(pack.chassis ?? {})) {
    const w = `機型 ${key}`;
    if (c.id !== key) err(w, `id（${c.id}）要和鍵名一致`);
    for (const f of ['weightClass', 'propellant', 'baseThrust', 'maxAccel', 'power'] as const) if (!isNum(c[f], 0)) err(w, `${f} 要是 0 以上的數字`);
    for (const f of ['aim', 'evasion'] as const) if (!isNum(c[f])) err(w, `${f} 要是數字`);
    for (const p of BODY) {
      const part = c.parts?.[p as keyof ChassisDef['parts']];
      if (!part) err(w, `缺少部位 ${p}`);
      else if (!isNum(part.weight, 0) || !isNum(part.durability, 1)) err(w, `部位 ${p} 的權重要 ≥ 0、耐久要 ≥ 1`);
    }
    if (!c.dial?.length) err(w, '機動盤是空的');
    if (new Set(c.dial).size !== c.dial?.length) err(w, '機動盤有重複的機動');
    for (const m of c.dial ?? []) {
      try {
        const spec = parseManeuver(m);
        const min = spec.kind === 'hover' ? 0 : 1;
        if (!Number.isInteger(spec.speed) || spec.speed < min || spec.speed > MAX_DIAL_SPEED || (spec.kind === 'hover' && spec.speed !== 0))
          err(w, `機動 ${m} 的速度要是 ${min}–${MAX_DIAL_SPEED} 的整數${spec.kind === 'hover' ? '（懸停是 0）' : ''}`);
      } catch {
        err(w, `不認得的機動 ${m}`);
      }
    }
    for (const b of c.builtIn ?? []) {
      const def = pack.equipment[b.defId];
      if (!def) err(w, `內建武裝 ${b.defId} 不存在`);
      else if ((def.mount ?? 'hand') !== 'integrated') err(w, `內建武裝 ${b.defId} 的 mount 要是 integrated`);
      if (!BODY.includes(b.host)) err(w, `內建武裝 ${b.defId} 的宿主部位 ${b.host} 不正確`);
    }
  }

  for (const [key, p] of Object.entries(pack.pilots ?? {})) {
    const w = `駕駛 ${key}`;
    if (p.id !== key) err(w, `id（${p.id}）要和鍵名一致`);
    if (!isNum(p.skill, 0)) err(w, 'skill 要是 0 以上的數字');
    if (!isNum(p.maxStress, 1)) err(w, 'maxStress 至少 1');
    if (!isNum(p.recovery, 0)) err(w, 'recovery 要是 0 以上的數字');
    for (const a of p.abilities ?? []) if (!ABILITIES.includes(a)) err(w, `不認得的能力 ${a}`);
  }

  /** 檢查一套配裝（裝備存在、位置和安裝方式相符、宿主正確、佔手衝突） */
  const checkGear = (w: string, chassisId: string, gear: RosterEntry['equipment']) => {
    const c = pack.chassis[chassisId];
    const blocked = new Set((c?.builtIn ?? []).filter((b) => pack.equipment[b.defId]?.blocksHand).map((b) => (b.host === 'rarm' ? 'right' : 'left')));
    for (const [defId, loc, host] of gear) {
      const def = pack.equipment[defId];
      if (!def) {
        err(w, `裝備 ${defId} 不存在`);
        continue;
      }
      const mount = def.mount ?? 'hand';
      const allowed: Record<string, string[]> = { hand: ['right', 'left', 'stowed'], mounted: ['mount'], integrated: ['builtin'], housed: ['housed'] };
      if (def.kind === 'shield' && loc === 'stowed') err(w, `${defId} 盾牌不能收納`);
      if (!allowed[mount]?.includes(loc)) err(w, `${defId}（${mount}）不能放在 ${loc}`);
      if (mount !== 'hand' && def.kind !== 'tank' && !host) err(w, `${defId} 要寫宿主部位`);
      if (host && !BODY.includes(host)) err(w, `${defId} 的宿主部位 ${host} 不正確`);
      if (mount === 'housed' && host !== 'rarm' && host !== 'larm') err(w, `${defId} 內藏武器要藏在手臂裡`);
      if ((loc === 'right' || loc === 'left') && blocked.has(loc)) err(w, `${defId} 拿在被佔住的手上（手指光束砲那隻手不能握持）`);
    }
    const hands = gear.filter(([, loc]) => loc === 'right' || loc === 'left').map(([, loc]) => loc);
    if (new Set(hands).size !== hands.length) err(w, '同一隻手拿了兩件東西');
  };

  for (const [chassisId, sets] of Object.entries(pack.loadouts ?? {})) {
    if (!pack.chassis[chassisId]) err(`配裝 ${chassisId}`, '沒有這個機型');
    sets.forEach((gear, i) => checkGear(`配裝 ${chassisId} 第 ${i + 1} 套`, chassisId, gear));
  }
  if (!Array.isArray(pack.rosters) || pack.rosters.length !== 2) err('預設陣容', '要有 A、B 兩方');
  else
    pack.rosters.forEach((side, s) =>
      side.forEach((entry, i) => {
        const w = `預設陣容 ${s === 0 ? 'A' : 'B'}${i + 1}`;
        if (!pack.chassis[entry.chassis]) err(w, `沒有機型 ${entry.chassis}`);
        if (!pack.pilots[entry.pilot]) err(w, `沒有駕駛 ${entry.pilot}`);
        checkGear(w, entry.chassis, entry.equipment);
      }),
    );
  return errs;
}
