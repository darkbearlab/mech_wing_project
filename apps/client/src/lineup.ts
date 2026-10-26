// 出擊準備：開戰前選雙方陣容（機型、駕駛、配裝）與對手，帶進本機對戰。
import { CHASSIS, DEFAULT_ROSTERS, EQUIPMENT, LOADOUTS, PILOTS, randomRoster, type RosterEntry } from '@mech/rules';
import type { Opponent } from './local';
import { setUploadEnabled, uploadEnabled } from './record';

type Rosters = [RosterEntry[], RosterEntry[]];
const KEY = 'mech-wing-lineup';
const MAX_UNITS = 5;
const SIDES = ['A', 'B'] as const;
const OPPONENTS: [Opponent, string][] = [['ai', '對戰電腦'], ['hotseat', '同機輪流'], ['aivai', '電腦對戰電腦（觀戰）']];
const SIDE_ROLE: Record<Opponent, [string, string]> = { ai: ['你', '電腦'], hotseat: ['玩家一', '玩家二'], aivai: ['電腦', '電腦'] };

const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const usable = (e: RosterEntry) => !!CHASSIS[e.chassis] && !!PILOTS[e.pilot] && e.equipment.every(([d]) => !!EQUIPMENT[d]);
const usableRosters = (r: unknown): r is Rosters =>
  Array.isArray(r) && r.length === 2 && r.every((side) => Array.isArray(side) && side.length >= 1 && side.length <= MAX_UNITS && side.every(usable));

const WHERE: Record<string, string> = { stowed: '（收）', housed: '（藏）', mount: '（掛）', builtin: '' };
function gearLabel(gear: RosterEntry['equipment']): string {
  return gear.length ? gear.map(([d, loc]) => `${EQUIPMENT[d]?.name ?? d}${WHERE[loc] ?? ''}`).join('・') : '只有標準裝備';
}

const loadoutsOf = (chassis: string): RosterEntry['equipment'][] => LOADOUTS[chassis]?.length ? LOADOUTS[chassis] : [[]];
const randomEntries = (n: number): RosterEntry[] => randomRoster(Math.random, n);

function loadSaved(): Rosters | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return usableRosters(r) ? r : null;
  } catch {
    return null;
  }
}

/** 顯示出擊準備畫面；按下開始戰鬥時回呼 */
export function openLineup(opponent: Opponent, onStart: (rosters: Rosters, opponent: Opponent) => void): void {
  const box = document.getElementById('lineup')!;
  const saved = loadSaved();
  let rosters: Rosters = saved ?? (usableRosters(DEFAULT_ROSTERS) ? clone(DEFAULT_ROSTERS) : [randomEntries(3), randomEntries(3)]);
  let opp = opponent;

  const render = () => {
    const sideHtml = (s: 0 | 1) => {
      const units = rosters[s]
        .map((u, i) => {
          const sets = loadoutsOf(u.chassis);
          const cur = sets.findIndex((g) => same(g, u.equipment));
          const loadOpts =
            sets.map((g, j) => `<option value="${j}" ${j === cur ? 'selected' : ''}>${esc(gearLabel(g))}</option>`).join('') +
            (cur < 0 ? `<option value="cur" selected>${esc(gearLabel(u.equipment))}</option>` : '');
          return `<div class="luSlot">
            <b>${SIDES[s]}${i + 1}</b>
            <select data-s="${s}" data-i="${i}" data-f="chassis">${Object.values(CHASSIS).map((c) => `<option value="${esc(c.id)}" ${c.id === u.chassis ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
            <select data-s="${s}" data-i="${i}" data-f="pilot">${Object.values(PILOTS).map((p) => `<option value="${esc(p.id)}" ${p.id === u.pilot ? 'selected' : ''}>${esc(p.name)}（技能 ${p.skill}）</option>`).join('')}</select>
            <button class="x" data-s="${s}" data-i="${i}" data-act="remove" title="移除這台" ${rosters[s].length <= 1 ? 'disabled' : ''}>×</button>
            <span></span>
            <select class="load" data-s="${s}" data-i="${i}" data-f="load" title="配裝">${loadOpts}</select>
          </div>`;
        })
        .join('');
      return `<div class="luSide luSide${s}">
        <div class="luHead"><span class="tag">${SIDES[s]} 方</span><span class="muted">${SIDE_ROLE[opp][s]}</span><span class="spacer"></span><button data-s="${s}" data-act="random">隨機</button></div>
        ${units}
        <div class="luAdd"><button data-s="${s}" data-act="add" ${rosters[s].length >= MAX_UNITS ? 'disabled' : ''}>＋ 加一台</button></div>
      </div>`;
    };
    box.innerHTML = `<div class="luBox">
      <div class="luBar"><b>出擊準備</b><span class="muted">${esc(document.getElementById('contentTag')?.textContent ?? '')}</span><span class="spacer"></span>
        <button data-act="default">載入預設陣容</button><button data-act="last" ${saved ? '' : 'disabled'}>上次的陣容</button></div>
      <div class="luCols">${sideHtml(0)}${sideHtml(1)}</div>
      <div class="luFoot"><span class="muted">對手</span><select data-f="opponent">${OPPONENTS.map(([v, t]) => `<option value="${v}" ${v === opp ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span class="muted">每方 1–${MAX_UNITS} 台</span><span class="spacer"></span>
        <label class="muted" title="只有種子、陣容和雙方指令，用來檢討 AI 與平衡"><input type="checkbox" data-f="upload" ${uploadEnabled() ? 'checked' : ''}> 上傳對戰紀錄</label><button class="primary big" data-act="start">開始戰鬥</button></div>
    </div>`;
  };

  box.onchange = (ev) => {
    const el = ev.target as HTMLSelectElement;
    const f = el.dataset.f;
    if (f === 'upload') return setUploadEnabled((el as unknown as HTMLInputElement).checked);
    if (f === 'opponent') opp = el.value as Opponent;
    else if (f) {
      const u = rosters[Number(el.dataset.s) as 0 | 1][Number(el.dataset.i)];
      if (f === 'chassis') {
        u.chassis = el.value;
        u.equipment = clone(loadoutsOf(el.value)[0]);
      } else if (f === 'pilot') u.pilot = el.value;
      else if (f === 'load' && el.value !== 'cur') u.equipment = clone(loadoutsOf(u.chassis)[Number(el.value)]);
    }
    render();
  };
  box.onclick = (ev) => {
    const el = (ev.target as HTMLElement).closest('button');
    const act = el?.dataset.act;
    if (!el || !act || el.disabled) return;
    const s = Number(el.dataset.s) as 0 | 1;
    if (act === 'remove') rosters[s].splice(Number(el.dataset.i), 1);
    else if (act === 'add') rosters[s].push(randomEntries(1)[0]);
    else if (act === 'random') rosters[s] = randomEntries(rosters[s].length);
    else if (act === 'default') rosters = clone(DEFAULT_ROSTERS);
    else if (act === 'last' && saved) rosters = clone(saved);
    else if (act === 'start') {
      try {
        localStorage.setItem(KEY, JSON.stringify(rosters));
      } catch {}
      box.hidden = true;
      onStart(clone(rosters), opp);
      return;
    }
    render();
  };
  render();
  box.hidden = false;
}
