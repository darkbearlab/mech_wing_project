// 機體受損圖：矮方塊拼成的人形，旁邊上下排列推進器和燃料槽，只用顏色表示受傷程度。
import type { PartState, UnitView } from '@mech/rules';

type Level = 'ok' | 'light' | 'heavy' | 'broken';

const FILL: Record<Level, string> = { ok: '#3B8F4E', light: '#C9B03A', heavy: '#D9772B', broken: '#C0392B' };

/** 剩餘耐久：滿血完好、過半輕傷、一半以下重傷、歸零破壞 */
export function damageLevel(p: PartState): Level {
  if (p.destroyed) return 'broken';
  if (p.damage === 0) return 'ok';
  return p.durability - p.damage > p.durability / 2 ? 'light' : 'heavy';
}

const style = (k: Level) =>
  k === 'broken' ? `fill="${FILL[k]}" fill-opacity="0.35" stroke="#C0392B" stroke-dasharray="3 2" stroke-width="1"` : `fill="${FILL[k]}" stroke="rgba(0,0,0,0.35)" stroke-width="1"`;
const cross = (x: number, y: number, w: number, h: number) =>
  `<path d="M${x + 2} ${y + 2} L${x + w - 2} ${y + h - 2} M${x + w - 2} ${y + 2} L${x + 2} ${y + h - 2}" stroke="#C0392B" stroke-width="1.5"/>`;
const block = (x: number, y: number, w: number, h: number, k: Level, rx = 2) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${rx}" ${style(k)}/>` + (k === 'broken' ? cross(x, y, w, h) : '');

/** 推進器：矮寬的背包加兩個分開的小噴嘴 */
function thruster(x: number, y: number, k: Level): string {
  const w = 26;
  const h = 20;
  const nozzle = (cx: number) => `<path d="M${cx - 2.5} ${y + h} L${cx + 2.5} ${y + h} L${cx + 4} ${y + h + 6} L${cx - 4} ${y + h + 6} Z" ${style(k)}/>`;
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="3" ${style(k)}/>` + nozzle(x + 6) + nozzle(x + w - 6) + (k === 'broken' ? cross(x, y, w, h) : '');
}

/** 燃料槽：兩顆並排的電池；沒帶就畫虛線空殼 */
function tank(x: number, y: number, k: Level | null): string {
  const cw = 11;
  const ch = 18;
  const cell = (cx: number) => {
    if (!k) {
      const empty = 'fill="none" stroke="#5a6878" stroke-dasharray="2 2"';
      return `<rect x="${cx - 3}" y="${y}" width="6" height="3" rx="1" ${empty}/><rect x="${cx - cw / 2}" y="${y + 3}" width="${cw}" height="${ch}" rx="2" ${empty}/>`;
    }
    return `<rect x="${cx - 3}" y="${y}" width="6" height="3" rx="1" ${style(k)}/><rect x="${cx - cw / 2}" y="${y + 3}" width="${cw}" height="${ch}" rx="2" ${style(k)}/>` + (k === 'broken' ? cross(cx - cw / 2, y + 3, cw, ch) : '');
  };
  return cell(x + 6.5) + cell(x + 19.5);
}

export function mechSilhouette(u: UnitView): string {
  const lv = (id: string) => (u.parts[id] ? damageLevel(u.parts[id]) : 'ok');
  const tankEq = u.equipment.find((e) => e.defId === 'fuel_tank');
  const tankLv = tankEq ? damageLevel(u.parts[tankEq.id]) : null;
  // 外掛武裝：肩上（宿主軀幹）、背上（推進背包）、腿旁（腿部）的小方塊，各自依耐久上色
  const pods = u.equipment.filter((e) => e.location === 'mount' && e.defId !== 'fuel_tank' && u.parts[e.id]);
  const slots: Record<string, [number, number, number, number][]> = {
    torso: [[20, 12, 10, 9], [54, 12, 10, 9]],
    pack: [[82, 10, 22, 7]],
    legs: [[57, 70, 9, 12], [18, 70, 9, 12]],
  };
  const used: Record<string, number> = {};
  const podBlocks = pods
    .map((e) => {
      const host = e.host ?? 'torso';
      const n = used[host] ?? 0;
      used[host] = n + 1;
      const at = slots[host]?.[n];
      return at ? block(at[0], at[1], at[2], at[3], damageLevel(u.parts[e.id])) : '';
    })
    .join('');
  return `<svg viewBox="0 0 112 104" width="64" height="60" role="img" aria-label="${u.label} 受損狀況">
    ${podBlocks}
    ${block(34, 4, 16, 14, lv('head'))}
    ${block(28, 21, 28, 36, lv('torso'))}
    ${block(14, 28, 11, 32, lv('larm'))}
    ${block(59, 28, 11, 32, lv('rarm'))}
    ${block(29, 60, 11, 40, lv('legs'))}
    ${block(44, 60, 11, 40, lv('legs'))}
    ${thruster(80, 22, lv('pack'))}
    ${tank(80, 58, tankLv)}
  </svg>`;
}
