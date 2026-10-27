// 出擊準備：開戰前選雙方陣容（機型、駕駛、配裝）、隊伍規模（預算）、勝利條件與對手，帶進本機對戰。
import {
  CHASSIS,
  DEFAULT_ROSTERS,
  EQUIPMENT,
  FLAGSHIP_MIN_COST,
  LOADOUTS,
  PILOTS,
  SCALES,
  entryCost,
  lineupProblems,
  randomRoster,
  rosterCost,
  type BattleSettings,
  type RosterEntry,
  type Scale,
} from '@mech/rules';
import type { Opponent } from './local';
import { setUploadEnabled, uploadEnabled } from './record';

type Rosters = [RosterEntry[], RosterEntry[]];
const KEY = 'mech-wing-lineup';
const SETTINGS_KEY = 'mech-wing-settings';
const SIDES = ['A', 'B'] as const;
const OPPONENTS: [Opponent, string][] = [['ai', '對戰電腦'], ['hotseat', '同機輪流'], ['aivai', '電腦對戰電腦（觀戰）']];
const SIDE_ROLE: Record<Opponent, [string, string]> = { ai: ['你', '電腦'], aiA: ['電腦', '你'], hotseat: ['玩家一', '玩家二'], aivai: ['電腦', '電腦'] };
const TURN_LIMITS = [8, 12, 16];
const CONTROL_TARGET = 6;

/** 出擊準備的選項：規模加上勝利條件（擊墜分門檻跟著規模） */
interface LineupSettings {
  scale: Scale;
  killScore: boolean;
  decapitation: boolean;
  goal: boolean;
  control: boolean;
  turnLimit: number;
  deploy: 'fixed' | 'free';
  environment: 'space' | 'gravity';
  terrain: 'asteroid' | 'forest' | 'town';
}
const DEFAULTS: LineupSettings = { scale: 'standard', killScore: true, decapitation: true, goal: false, control: false, turnLimit: 12, deploy: 'fixed', environment: 'space', terrain: 'asteroid' };

const VICTORY_TIPS: Record<'killScore' | 'decapitation' | 'goal' | 'control', string> = {
  killScore: '擊墜敵機的費用加總到門檻就獲勝（飛出地圖也算）',
  decapitation: `擊墜對方費用最高的機體（旗艦 ♛）就獲勝；旗艦至少要 ${FLAGSHIP_MIN_COST} 分`,
  goal: '進入對方部署區的達陣圈、停住（動能 0）並撐過下一回合；圈裡有敵機就不算',
  control: `中線上三個據點，每回合結束時單獨佔住的各得 1 分，先到 ${CONTROL_TARGET} 分獲勝`,
};

const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const usable = (e: RosterEntry) => !!CHASSIS[e.chassis] && !!PILOTS[e.pilot] && e.equipment.every(([d]) => !!EQUIPMENT[d]);
const usableRosters = (r: unknown): r is Rosters =>
  Array.isArray(r) && r.length === 2 && r.every((side) => Array.isArray(side) && side.length >= 1 && side.length <= SCALES.large.maxUnits && side.every(usable));

const WHERE: Record<string, string> = { stowed: '（收）', housed: '（藏）', mount: '（掛）', builtin: '' };
const gearCost = (gear: RosterEntry['equipment']) => gear.reduce((n, [d]) => n + (EQUIPMENT[d]?.cost ?? 0), 0);
function gearLabel(gear: RosterEntry['equipment']): string {
  const names = gear.length ? gear.map(([d, loc]) => `${EQUIPMENT[d]?.name ?? d}${WHERE[loc] ?? ''}`).join('・') : '只有標準裝備';
  const c = gearCost(gear);
  return c ? `${names}（+${c}）` : names;
}

const loadoutsOf = (chassis: string): RosterEntry['equipment'][] => (LOADOUTS[chassis]?.length ? LOADOUTS[chassis] : [[]]);

/** 隨機陣容：盡量挑在預算內、具名駕駛不重複的一組 */
function randomEntries(n: number, budget: number, keep: RosterEntry[] = []): RosterEntry[] {
  let best: RosterEntry[] | null = null;
  for (let i = 0; i < 40; i++) {
    const r = randomRoster(Math.random, n);
    const names = r.map((e) => e.pilot).filter((p) => PILOTS[p]?.unique);
    if (new Set(names).size !== names.length) continue;
    if (rosterCost([...keep, ...r]) <= budget) return r;
    if (!best || rosterCost(r) < rosterCost(best)) best = r;
  }
  return best ?? randomRoster(Math.random, n);
}

function loadSaved(): Rosters | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return usableRosters(r) ? r : null;
  } catch {
    return null;
  }
}

function loadSettings(): LineupSettings {
  try {
    const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null');
    return s && s.scale in SCALES ? { ...DEFAULTS, ...s } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

/** 出擊準備的選項換成規則用的勝利條件 */
export function toBattleSettings(s: LineupSettings): BattleSettings {
  return {
    killScore: s.killScore ? SCALES[s.scale].killScore : undefined,
    decapitation: s.decapitation,
    goal: s.goal,
    control: s.control ? CONTROL_TARGET : undefined,
    turnLimit: s.turnLimit,
    deploy: s.deploy,
    environment: s.environment,
    terrain: s.terrain,
  };
}

/** 顯示出擊準備畫面；按下開始戰鬥時回呼 */
export function openLineup(opponent: Opponent, onStart: (rosters: Rosters, opponent: Opponent, settings: BattleSettings) => void): void {
  const box = document.getElementById('lineup')!;
  const saved = loadSaved();
  let rosters: Rosters = saved ?? (usableRosters(DEFAULT_ROSTERS) ? clone(DEFAULT_ROSTERS) : [randomEntries(5, 85), randomEntries(5, 85)]);
  let opp = opponent;
  const set = loadSettings();

  // 舊版資料沒有費用：不檢查預算與旗艦門檻
  const priced = Object.values(CHASSIS).some((c) => c.cost);
  const problemsOf = (s: 0 | 1) => lineupProblems(rosters[s], set.scale, set).filter((p) => priced || !/預算|旗艦/.test(p));

  const render = () => {
    const scale = SCALES[set.scale];
    const sideHtml = (s: 0 | 1) => {
      const costs = rosters[s].map(entryCost);
      const flag = set.decapitation ? costs.indexOf(Math.max(...costs)) : -1;
      const total = rosterCost(rosters[s]);
      const over = total > scale.budget;
      const units = rosters[s]
        .map((u, i) => {
          const sets = loadoutsOf(u.chassis);
          const cur = sets.findIndex((g) => same(g, u.equipment));
          const loadOpts =
            sets.map((g, j) => `<option value="${j}" ${j === cur ? 'selected' : ''}>${esc(gearLabel(g))}</option>`).join('') +
            (cur < 0 ? `<option value="cur" selected>${esc(gearLabel(u.equipment))}</option>` : '');
          return `<div class="luSlot">
            <b ${i === flag ? 'class="crown" title="旗艦：被擊墜就輸（斬首）"' : ''}>${i === flag ? '♛' : `${SIDES[s]}${i + 1}`}</b>
            <select data-s="${s}" data-i="${i}" data-f="chassis">${Object.values(CHASSIS).map((c) => `<option value="${esc(c.id)}" ${c.id === u.chassis ? 'selected' : ''}>${esc(c.name)}（${c.cost ?? 0}）${(c.envs ?? ['space', 'gravity']).includes(set.environment) ? '' : '・不適合'}</option>`).join('')}</select>
            <select data-s="${s}" data-i="${i}" data-f="pilot">${Object.values(PILOTS).map((p) => `<option value="${esc(p.id)}" ${p.id === u.pilot ? 'selected' : ''}>${esc(p.name)}（技能 ${p.skill}・${p.cost ?? 0}）</option>`).join('')}</select>
            <span class="cost" title="機型＋駕駛＋裝備">${costs[i]}</span>
            <button class="x" data-s="${s}" data-i="${i}" data-act="remove" title="移除這台" ${rosters[s].length <= 1 ? 'disabled' : ''}>×</button>
            <span></span>
            <select class="load" data-s="${s}" data-i="${i}" data-f="load" title="配裝">${loadOpts}</select>
          </div>`;
        })
        .join('');
      const problems = problemsOf(s);
      return `<div class="luSide luSide${s}">
        <div class="luHead"><span class="tag">${SIDES[s]} 方</span><span class="muted">${SIDE_ROLE[opp][s]}</span><span class="spacer"></span>
          <span class="${over ? 'err' : ''}">${total} / ${scale.budget}</span><button data-s="${s}" data-act="random">隨機</button></div>
        <div class="luBudget"><i style="width:${Math.min(100, (total / scale.budget) * 100)}%" class="${over ? 'over' : ''}"></i></div>
        ${units}
        <div class="luAdd"><button data-s="${s}" data-act="add" ${rosters[s].length >= scale.maxUnits ? 'disabled' : ''}>＋ 加一台</button></div>
        ${problems.length ? `<div class="err small">${problems.map(esc).join('<br>')}</div>` : ''}
      </div>`;
    };
    const chip = (key: keyof typeof VICTORY_TIPS, label: string) =>
      `<button class="chip ${set[key] ? 'on' : ''}" data-v="${key}" title="${esc(VICTORY_TIPS[key])}">${label}</button>`;
    const ok = !problemsOf(0).length && !problemsOf(1).length;
    box.innerHTML = `<div class="luBox">
      <div class="luBar"><b>出擊準備</b><span class="muted">${esc(document.getElementById('contentTag')?.textContent ?? '')}</span><span class="spacer"></span>
        <span class="muted">環境</span><select data-f="environment" title="重力圈：每回合結束時動能往 0 回正 1（地面滑行的機體例外）；不適合這個環境的機體機動盤最高速度 −1">
          <option value="space" ${set.environment === 'space' ? 'selected' : ''}>宇宙</option><option value="gravity" ${set.environment === 'gravity' ? 'selected' : ''}>重力圈</option></select>
        <span class="muted">地形</span><select data-f="terrain" title="隕石帶：大隕石與隕石群；森林：大片森林（擋視線、穿越命中下降）；城鎮：很多建築（擋移動、射擊與視線）">
          ${(['asteroid', 'forest', 'town'] as const).map((t) => `<option value="${t}" ${set.terrain === t ? 'selected' : ''}>${{ asteroid: '隕石帶', forest: '森林', town: '城鎮' }[t]}</option>`).join('')}</select>
        <span class="muted">規模</span><select data-f="scale">${(Object.keys(SCALES) as Scale[]).map((k) => `<option value="${k}" ${k === set.scale ? 'selected' : ''}>${SCALES[k].name}（${SCALES[k].budget} 分、最多 ${SCALES[k].maxUnits} 台）</option>`).join('')}</select>
        <button data-act="default">載入預設陣容</button><button data-act="last" ${saved ? '' : 'disabled'}>上次的陣容</button></div>
      <div class="luCols">${sideHtml(0)}${sideHtml(1)}</div>
      <div class="luFoot luWrap"><span class="muted">勝利條件</span>
        ${chip('killScore', `擊墜分 ${SCALES[set.scale].killScore}`)}${chip('decapitation', '斬首')}${chip('goal', '達陣')}${chip('control', `據點 ${CONTROL_TARGET}`)}
        <span class="muted small" title="一方全滅一定算輸；回合上限到了比分數">可複選，先達成者勝</span>
        <span class="spacer"></span><span class="muted">部署</span>
        <button class="chip ${set.deploy === 'fixed' ? 'on' : ''}" data-deploy="fixed" title="照順序在自己那一側排一列">固定排開</button>
        <button class="chip ${set.deploy === 'free' ? 'on' : ''}" data-deploy="free" title="開戰前雙方暗中在自己的部署區擺好位置、朝向與起始動能，一起公布">自由部署</button>
        <span class="muted">回合上限</span><select data-f="turnLimit">${TURN_LIMITS.map((t) => `<option value="${t}" ${t === set.turnLimit ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="luFoot"><span class="muted">對手</span><select data-f="opponent">${OPPONENTS.map(([v, t]) => `<option value="${v}" ${v === opp ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span class="spacer"></span>
        <label class="muted" title="只有種子、陣容和雙方指令，用來檢討 AI 與平衡"><input type="checkbox" data-f="upload" ${uploadEnabled() ? 'checked' : ''}> 上傳對戰紀錄</label>
        <button class="primary big" data-act="start" ${ok ? '' : 'disabled title="陣容有問題，先修正再出擊"'}>開始戰鬥</button></div>
    </div>`;
  };

  const saveSettings = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(set));
    } catch {}
  };

  box.onchange = (ev) => {
    const el = ev.target as HTMLSelectElement;
    const f = el.dataset.f;
    if (f === 'upload') return setUploadEnabled((el as unknown as HTMLInputElement).checked);
    if (f === 'opponent') opp = el.value as Opponent;
    else if (f === 'scale') {
      set.scale = el.value as Scale;
      saveSettings();
    } else if (f === 'terrain') {
      set.terrain = el.value as LineupSettings['terrain'];
      saveSettings();
    } else if (f === 'environment') {
      set.environment = el.value as LineupSettings['environment'];
      saveSettings();
    } else if (f === 'turnLimit') {
      set.turnLimit = Number(el.value);
      saveSettings();
    } else if (f) {
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
    if (!el || el.disabled) return;
    if (el.dataset.deploy) {
      set.deploy = el.dataset.deploy as LineupSettings['deploy'];
      saveSettings();
      return render();
    }
    const v = el.dataset.v as keyof typeof VICTORY_TIPS | undefined;
    if (v) {
      set[v] = !set[v];
      saveSettings();
      return render();
    }
    const act = el.dataset.act;
    if (!act) return;
    const s = Number(el.dataset.s) as 0 | 1;
    const budget = SCALES[set.scale].budget;
    if (act === 'remove') rosters[s].splice(Number(el.dataset.i), 1);
    else if (act === 'add') rosters[s].push(randomEntries(1, budget, rosters[s])[0]);
    else if (act === 'random') rosters[s] = randomEntries(rosters[s].length, budget);
    else if (act === 'default') rosters = clone(DEFAULT_ROSTERS);
    else if (act === 'last' && saved) rosters = clone(saved);
    else if (act === 'start') {
      try {
        localStorage.setItem(KEY, JSON.stringify(rosters));
      } catch {}
      saveSettings();
      box.hidden = true;
      onStart(clone(rosters), opp, toBattleSettings(set));
      return;
    }
    render();
  };
  render();
  box.hidden = false;
}
