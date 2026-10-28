// 出擊準備：開戰前選雙方陣容（機型、駕駛、配裝）、隊伍規模（預算）、勝利條件與對手，帶進本機對戰。
// 開房模式只選自己這一方：房主（A 方）決定對戰條件，客人照房主的條件選隊。
import {
  ARMOR_NAMES,
  DAMAGE_TYPE_NAMES,
  CHASSIS,
  DEFAULT_ROSTERS,
  EQUIPMENT,
  FLAGSHIP_MIN_COST,
  LOADOUTS,
  PILOTS,
  SCALES,
  entryCost,
  gearSlots,
  gearToSlots,
  lineupProblems,
  squadShare,
  slotFits,
  slotsToGear,
  type GearSlot,
  randomRoster,
  rosterCost,
  type BattleSettings,
  type RosterEntry,
  type Scale,
  type SeatInfo,
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
export interface LineupSettings {
  scale: Scale;
  killScore: boolean;
  decapitation: boolean;
  goal: boolean;
  control: boolean;
  turnLimit: number;
  deploy: 'fixed' | 'free';
  environment: 'space' | 'gravity';
  terrain: 'asteroid' | 'forest' | 'town' | 'city';
  /** 雙方後方各一個補給點 */
  supply?: boolean;
  /** 開房：每方幾個小隊（各一個席位） */
  squads?: [number, number];
  /** 開房：交給電腦指揮的小隊席位 */
  aiSeats?: string[];
}
const DEFAULTS: LineupSettings = { scale: 'standard', killScore: true, decapitation: true, goal: false, control: false, turnLimit: 12, deploy: 'fixed', environment: 'space', terrain: 'asteroid' };
const MAX_SQUADS = 4;

/** 席位名稱（0、0-1…）的一方與小隊 */
const seatSide = (key: string): 0 | 1 => (key.startsWith('1') ? 1 : 0);
const seatSquad = (key: string): number => Number(key.split('-')[1] ?? 0);
const seatKeyOf = (side: 0 | 1, squad: number) => (squad ? `${side}-${squad}` : `${side}`);
/** 畫面上的席位名稱：A・0、B・1… */
export const seatLabel = (key: string) => `${SIDES[seatSide(key)]}・${seatSquad(key)}`;

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

// ---- 我的配裝：武裝編輯器存下來的，記在這台電腦（依機型） ----
const MY_KEY = 'mech-wing-my-loadouts';
type MyLoadouts = Record<string, RosterEntry['equipment'][]>;
function loadMine(): MyLoadouts {
  try {
    const m = JSON.parse(localStorage.getItem(MY_KEY) ?? '{}');
    return m && typeof m === 'object' ? m : {};
  } catch {
    return {};
  }
}
function saveMine(m: MyLoadouts) {
  try {
    localStorage.setItem(MY_KEY, JSON.stringify(m));
  } catch {}
}
/** 我的配裝裡這個機型還能用的（資料包換了、裝備不存在的不列） */
const mineOf = (chassis: string): RosterEntry['equipment'][] => (loadMine()[chassis] ?? []).filter((g) => g.every(([d]) => !!EQUIPMENT[d]));

// ---- 武裝編輯器 ----
/** 人形機掛點在機體圖上的位置（px，圖 240×300） */
const SLOT_POS: Record<string, [number, number]> = {
  'hand-right': [2, 150],
  'hand-left': [178, 150],
  'rack-right': [2, 84],
  'rack-left': [178, 84],
  'rack-back': [98, 112],
  'mount-torso-0': [70, 50],
  'mount-torso-1': [136, 50],
  'mount-pack-0': [102, 84],
  'mount-legs-0': [102, 246],
  'builtin-right': [2, 117],
  'builtin-left': [178, 117],
  'housed-right': [2, 184],
  'housed-left': [178, 184],
};
const BAND = { 1: '近', 2: '中', 3: '遠', 4: '超遠' } as const;

/** 武器清單上的一行說明：傷害×發數、各距離修正、費用 */
function equipBrief(id: string): string {
  const d = EQUIPMENT[id];
  const parts: string[] = [];
  if (d.kind === 'ranged') {
    parts.push(`${DAMAGE_TYPE_NAMES[d.damageType ?? 'kinetic']} ${d.damage}×${d.shots ?? 1}`);
    parts.push(([1, 2, 3, 4] as const).filter((b) => d.ranges?.[b] !== undefined).map((b) => `${BAND[b]} ${d.ranges![b]! >= 0 ? '+' : ''}${d.ranges![b]}`).join(' '));
    if (d.arc !== undefined) parts.push(`射界 ±${d.arc}°`);
    if (d.ammo !== undefined) parts.push(`彈 ${d.ammo}`);
  } else if (d.kind === 'melee') parts.push(`近戰 ${DAMAGE_TYPE_NAMES[d.damageType ?? 'kinetic']} ${d.damage}`);
  if (d.armorType) parts.push(ARMOR_NAMES[d.armorType]);
  else if (d.kind === 'shield') parts.push(`盾 耐久 ${d.durability}`);
  else if (d.kind === 'tank') parts.push(`推進劑 +${d.fuel ?? 0}`);
  else if (d.kind === 'armor') parts.push('外裝甲');
  else if (d.kind === 'utility') parts.push(d.utility === 'smoke' ? '煙霧彈' : '欺敵氣球');
  else if (d.climbBoost) parts.push(`攀升 +${d.climbBoost.levels} 層・速度上限 +${d.climbBoost.speed}`);
  if (d.tags?.includes('quickDraw')) parts.push('快拔');
  if (d.tags?.includes('volatile')) parts.push('會引爆');
  parts.push(`費用 ${d.cost ?? 0}`);
  return parts.filter(Boolean).join('・');
}

const KIND_TEXT: Record<GearSlot['kind'], string> = {
  hand: '手持武器、盾牌',
  rack: '收著的手持武器（盾牌不能收）',
  mount: '外掛武器、燃料槽、輔助模組',
  builtin: '手臂內建武器',
  housed: '藏在手臂裡的武器',
};

function editorHtml(u: RosterEntry, label: string, slot: string, teamCost: number, budget: number): string {
  const slots = gearSlots(u.chassis);
  const { filled, extra } = gearToSlots(u.chassis, u.equipment);
  const ch = CHASSIS[u.chassis];
  const cur = slots.find((x) => x.key === slot) ?? slots[0];
  const humanoid = slots.some((x) => x.kind === 'hand');
  const fixed = (ch.builtIn ?? []).map((b) => EQUIPMENT[b.defId]?.name ?? b.defId);
  const name = (id?: string) => (id ? esc(EQUIPMENT[id]?.name ?? id) : '<span class="muted">空</span>');
  const figure = humanoid
    ? `<div class="ldFig"><svg viewBox="-20 0 240 300" width="240" height="300" aria-hidden="true"><g fill="none" stroke="#5a6675" stroke-width="1.5">
        <rect x="82" y="40" width="36" height="28" rx="4"/><rect x="70" y="72" width="60" height="70" rx="6"/>
        <rect x="44" y="76" width="22" height="70" rx="4"/><rect x="134" y="76" width="22" height="70" rx="4"/>
        <rect x="76" y="146" width="20" height="90" rx="4"/><rect x="104" y="146" width="20" height="90" rx="4"/></g></svg>
        ${slots
          .filter((x) => SLOT_POS[x.key])
          .map(
            (x) =>
              `<button class="ldDot ${x.key === cur?.key ? 'on' : ''} ${filled[x.key] ? 'full' : ''}" data-slot="${x.key}" style="left:${SLOT_POS[x.key][0]}px;top:${SLOT_POS[x.key][1]}px" title="${esc(x.name)}：${filled[x.key] ? esc(EQUIPMENT[filled[x.key]].name) : '空'}">${esc(x.name)}</button>`,
          )
          .join('')}
      </div>`
    : '';
  const rows = slots
    .map(
      (x) =>
        `<button class="ldRow ${x.key === cur?.key ? 'on' : ''}" data-slot="${x.key}"><span class="muted">${esc(x.name)}</span><b>${name(filled[x.key])}</b><span class="muted">${filled[x.key] ? (EQUIPMENT[filled[x.key]].cost ?? 0) : ''}</span></button>`,
    )
    .join('');
  const picks = cur
    ? Object.keys(EQUIPMENT)
        .filter((id) => slotFits(cur, id))
        .map(
          (id) =>
            `<button class="ldPick ${filled[cur.key] === id ? 'on' : ''}" data-pick="${esc(id)}"><b>${esc(EQUIPMENT[id].name)}${filled[cur.key] === id ? ' <i class="tagOn">裝著</i>' : ''}</b><span>${esc(equipBrief(id))}</span></button>`,
        )
        .join('') + `<button class="ldPick ${filled[cur.key] ? '' : 'on'}" data-pick=""><b>空</b><span>不裝東西・費用 0</span></button>`
    : '';
  const presets = loadoutsOf(u.chassis)
    .map((g, j) => `<option value="p${j}">${esc(gearLabel(g))}</option>`)
    .join('');
  const mine = mineOf(u.chassis)
    .map((g, j) => `<option value="m${j}">我的：${esc(gearLabel(g))}</option>`)
    .join('');
  const isMine = mineOf(u.chassis).some((g) => same(g, u.equipment));
  return `<div class="luBox ldBox">
    <div class="luBar"><b>${esc(label)}・${esc(ch.name)}・${esc(PILOTS[u.pilot]?.name ?? u.pilot)}</b><span class="spacer"></span>
      <span class="muted">機體 ${ch.cost ?? 0} + 駕駛 ${PILOTS[u.pilot]?.cost ?? 0} + 裝備 <b>${gearCost(u.equipment)}</b> = <b>${entryCost(u)}</b>　隊伍 <b class="${teamCost > budget ? 'err' : ''}">${teamCost} / ${budget}</b></span></div>
    <div class="ldBody">${figure}<div class="ldRows">${rows}
      ${fixed.length ? `<div class="ldFixed muted">機型固定：${fixed.map(esc).join('、')}</div>` : ''}
      ${extra.length ? `<div class="ldFixed warn">放不進掛點的裝備（保留）：${extra.map(([d], k) => `${esc(EQUIPMENT[d]?.name ?? d)} <button data-drop="${k}" title="拿掉">×</button>`).join('、')}</div>` : ''}
    </div></div>
    ${cur ? `<div class="sec ldCap">${esc(cur.name)}可以裝：${KIND_TEXT[cur.kind]}（點一件就換上）</div><div class="ldPicks">${picks}</div>` : '<div class="sec ldCap">這個機型沒有可以改的掛點</div>'}
    <div class="luFoot"><select data-ed="apply"><option value="">套用配裝…</option>${presets}${mine}</select>
      <button data-ed="save" ${isMine ? 'disabled title="已經存過了"' : ''}>存成我的配裝</button>
      ${isMine ? '<button data-ed="forget" title="從我的配裝裡刪掉">刪除這套</button>' : ''}
      <span class="spacer"></span><button class="primary" data-ed="done">完成</button></div>
  </div>`;
}

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
    supply: !!s.supply,
  };
}

/** 開房模式：只選自己這一方（自己這個小隊）的隊伍加入房間 */
export interface OnlineLineup {
  side: 0 | 1;
  /** 席位名稱：0 是房主，分小隊時還有 0-1、1-2 這類 */
  seat: string;
  /** 客人：房主已經選好的條件（照這個選隊，不能改）；還沒有就先照自己的選，開打前會再檢查 */
  hostPrefs?: LineupSettings | null;
  /** 房間連結（邀請小隊席位用，後面接 &seat=） */
  roomUrl: string;
  /** ai：房主替電腦小隊選的隊伍（席位名稱 → 隊伍） */
  onJoin(roster: RosterEntry[], settings: BattleSettings, scale: Scale, prefs: LineupSettings, ai: Record<string, RosterEntry[]>): void;
}

/** 大廳的最新狀況（席位、同一方隊友的隊伍）；選隊畫面開著時會跟著更新 */
let lobbySeats: SeatInfo[] = [];
let lobbyMates: Record<string, RosterEntry[]> = {};
let rerender: (() => void) | null = null;
export function lobbyUpdate(seats: SeatInfo[], mates: Record<string, RosterEntry[]>): void {
  lobbySeats = seats;
  lobbyMates = mates;
  rerender?.();
}

/** 顯示出擊準備畫面；按下開始戰鬥時回呼（開房模式按加入房間時呼叫 online.onJoin） */
export function openLineup(opponent: Opponent, onStart: (rosters: Rosters, opponent: Opponent, settings: BattleSettings) => void, online?: OnlineLineup): void {
  const box = document.getElementById('lineup')!;
  const saved = loadSaved();
  let rosters: Rosters = saved ?? (usableRosters(DEFAULT_ROSTERS) ? clone(DEFAULT_ROSTERS) : [randomEntries(5, 85), randomEntries(5, 85)]);
  let opp = opponent;
  const set = online?.hostPrefs ? { ...DEFAULTS, ...online.hostPrefs } : loadSettings();
  /** 客人照房主的條件，不能改 */
  const locked = !!online?.hostPrefs;
  const off = locked ? 'disabled title="房主決定"' : '';

  /** 房主：決定小隊數與哪些小隊交給電腦，並替電腦小隊選隊 */
  const host = online?.seat === '0';
  // 客人在房主定好條件前：小隊數還不知道，先當一方一隊
  if (online && !host && !locked) delete set.squads;
  if (host) {
    set.squads ??= [1, 1];
    set.aiSeats ??= [];
  }
  /** 電腦小隊的隊伍（席位名稱 → 隊伍），只有房主有 */
  const aiRosters: Record<string, RosterEntry[]> = {};
  const squadsOf = (side: 0 | 1): number => (online ? (set.squads?.[side] ?? 1) : 1);
  /** 一個小隊的預算與台數：一方分成幾隊就平均分 */
  const limitOf = (side: 0 | 1) => (squadsOf(side) > 1 ? squadShare(set.scale, squadsOf(side)) : SCALES[set.scale]);
  /** 房主這邊所有的席位 */
  const hostSeats = () => ([0, 1] as const).flatMap((side) => Array.from({ length: squadsOf(side) }, (_, q) => seatKeyOf(side, q)));
  const aiKeys = () => (host ? hostSeats().filter((k) => k !== '0' && set.aiSeats!.includes(k)) : []);
  const aiRoster = (k: string) => (aiRosters[k] ??= randomEntries(Math.min(3, limitOf(seatSide(k)).maxUnits), limitOf(seatSide(k)).budget));

  /** 畫面上的一組隊伍：本機是 A、B 兩方；開房是自己這一隊，房主再加上各個電腦小隊 */
  interface Block {
    key: string;
    side: 0 | 1;
    list: RosterEntry[];
    title: string;
    role: string;
  }
  const blocks = (): Block[] =>
    online
      ? [
          { key: online.seat, side: online.side, list: rosters[online.side], title: squadsOf(online.side) > 1 ? seatLabel(online.seat) : `${SIDES[online.side]} 方`, role: '你' },
          ...aiKeys().map((k) => ({ key: k, side: seatSide(k), list: aiRoster(k), title: seatLabel(k), role: '電腦小隊' })),
        ]
      : ([0, 1] as const).map((s) => ({ key: `${s}`, side: s, list: rosters[s], title: `${SIDES[s]} 方`, role: SIDE_ROLE[opp][s] }));
  const setList = (b: Block, list: RosterEntry[]) => {
    if (online && b.key !== online.seat) aiRosters[b.key] = list;
    else rosters[b.side] = list;
  };

  // 舊版資料沒有費用：不檢查預算與旗艦門檻
  const priced = Object.values(CHASSIS).some((c) => c.cost);
  const problemsOf = (b: Block) =>
    lineupProblems(b.list, set.scale, set, squadsOf(b.side) > 1 ? limitOf(b.side) : undefined).filter((p) => priced || !/預算|旗艦/.test(p));

  /** 正在編輯武裝的機體與選中的掛點（s 是第幾組隊伍） */
  let editing: { s: number; i: number; slot: string } | null = null;

  /** 開房：席位表（房主可以改小隊數、指定電腦小隊、複製邀請連結） */
  const seatsHtml = () => {
    if (!online) return '';
    const keys = host
      ? hostSeats()
      : [...new Set([...lobbySeats.map((s) => s.key), online.seat])].sort((a, b) => seatSide(a) - seatSide(b) || seatSquad(a) - seatSquad(b));
    if (!host && keys.length <= 2) return '';
    const info = (k: string) => lobbySeats.find((s) => s.key === k);
    const rows = keys
      .map((k) => {
        const side = seatSide(k);
        const lim = limitOf(side);
        const ai = host ? set.aiSeats!.includes(k) : !!info(k)?.ai;
        const who =
          k === online.seat
            ? `<span class="tag me">你${host ? '（房主）' : ''}</span>`
            : host
              ? `<select data-ctrl="${k}"><option value="human" ${ai ? '' : 'selected'}>玩家</option><option value="ai" ${ai ? 'selected' : ''}>電腦</option></select>`
              : `<span class="muted">${ai ? '電腦' : k === '0' ? '房主' : '玩家'}</span>`;
        const mine = side === online.side;
        const state =
          k === online.seat
            ? '選隊中'
            : ai
              ? `<span class="tag ai">電腦</span>${host ? ' <span class="muted small">隊伍在下面</span>' : ''}`
              : info(k)?.joined
                ? `<span class="tag ok">已加入</span>${mine && lobbyMates[k] ? ` <span class="muted small">${lobbyMates[k].map((e) => esc(e.chassis)).join('・')}</span>` : ''}`
                : `<span class="tag wait">${info(k)?.connected ? '選隊中' : '等人加入'}</span>${host ? ` <button data-invite="${k}" title="複製這個席位的連結，傳給要坐這一隊的人">複製邀請連結</button>` : ''}`;
        return `<div class="luSeat"><b class="luSeat${side}">${seatLabel(k)}</b>${who}<span>${state}</span><span class="muted">${squadsOf(side) > 1 ? `${lim.budget} 分・${lim.maxUnits} 台` : `${lim.budget} 分`}</span></div>`;
      })
      .join('');
    const counts = host
      ? ([0, 1] as const)
          .map((side) => `<span class="muted">${SIDES[side]} 方</span><select data-squads="${side}">${Array.from({ length: MAX_SQUADS }, (_, i) => `<option value="${i + 1}" ${i + 1 === squadsOf(side) ? 'selected' : ''}>${i + 1} 隊</option>`).join('')}</select>`)
          .join('')
      : '';
    return `<div class="luSeats"><div class="luHead"><b>小隊</b><span class="muted small">每隊一個席位，只指揮自己的機體；一方的預算與台數平均分給各隊</span><span class="spacer"></span>${counts}</div>${rows}</div>`;
  };

  const render = () => {
    const scale = SCALES[set.scale];
    if (editing) {
      const b = blocks()[editing.s];
      const u = b.list[editing.i];
      box.innerHTML = editorHtml(u, `${b.title} ${editing.i + 1}`, editing.slot, rosterCost(b.list), limitOf(b.side).budget);
      return;
    }
    const sideHtml = (s: number) => {
      const b = blocks()[s];
      const lim = limitOf(b.side);
      const costs = b.list.map(entryCost);
      const flag = set.decapitation && squadsOf(b.side) === 1 ? costs.indexOf(Math.max(...costs)) : -1;
      const total = rosterCost(b.list);
      const over = total > lim.budget;
      const units = b.list
        .map((u, i) => {
          const sets = loadoutsOf(u.chassis);
          const mine = mineOf(u.chassis);
          const cur = sets.findIndex((g) => same(g, u.equipment));
          const curMine = cur < 0 ? mine.findIndex((g) => same(g, u.equipment)) : -1;
          const loadOpts =
            sets.map((g, j) => `<option value="${j}" ${j === cur ? 'selected' : ''}>${esc(gearLabel(g))}</option>`).join('') +
            mine.map((g, j) => `<option value="m${j}" ${j === curMine ? 'selected' : ''}>我的：${esc(gearLabel(g))}</option>`).join('') +
            (cur < 0 && curMine < 0 ? `<option value="cur" selected>${esc(gearLabel(u.equipment))}</option>` : '');
          return `<div class="luSlot">
            <b ${i === flag ? 'class="crown" title="旗艦：被擊墜就輸（斬首）"' : ''}>${i === flag ? '♛' : `${SIDES[b.side]}${i + 1}`}</b>
            <select data-s="${s}" data-i="${i}" data-f="chassis">${Object.values(CHASSIS).map((c) => `<option value="${esc(c.id)}" ${c.id === u.chassis ? 'selected' : ''}>${esc(c.name)}（${c.cost ?? 0}${c.armorType ? `・${ARMOR_NAMES[c.armorType].replace('裝甲', '')}` : ''}）${(c.envs ?? ['space', 'gravity']).includes(set.environment) ? '' : '・不適合'}</option>`).join('')}</select>
            <select data-s="${s}" data-i="${i}" data-f="pilot">${Object.values(PILOTS).map((p) => `<option value="${esc(p.id)}" ${p.id === u.pilot ? 'selected' : ''}>${esc(p.name)}（技能 ${p.skill}・${p.cost ?? 0}）</option>`).join('')}</select>
            <span class="cost" title="機型＋駕駛＋裝備">${costs[i]}</span>
            <button class="x" data-s="${s}" data-i="${i}" data-act="remove" title="移除這台" ${b.list.length <= 1 ? 'disabled' : ''}>×</button>
            <span></span>
            <select class="load" data-s="${s}" data-i="${i}" data-f="load" title="配裝">${loadOpts}</select>
            <button class="edit" data-s="${s}" data-i="${i}" data-act="edit" title="逐個掛點編輯武裝">編輯武裝</button>
          </div>`;
        })
        .join('');
      const problems = problemsOf(b);
      return `<div class="luSide luSide${b.side}">
        <div class="luHead"><span class="tag">${esc(b.title)}</span><span class="muted">${b.role}</span><span class="spacer"></span>
          <span class="${over ? 'err' : ''}">${total} / ${lim.budget}${squadsOf(b.side) > 1 ? `・${b.list.length} / ${lim.maxUnits} 台` : ''}</span><button data-s="${s}" data-act="random">隨機</button></div>
        <div class="luBudget"><i style="width:${Math.min(100, (total / lim.budget) * 100)}%" class="${over ? 'over' : ''}"></i></div>
        ${units}
        <div class="luAdd"><button data-s="${s}" data-act="add" ${b.list.length >= lim.maxUnits ? 'disabled' : ''}>＋ 加一台</button></div>
        ${problems.length ? `<div class="err small">${problems.map(esc).join('<br>')}</div>` : ''}
      </div>`;
    };
    const chip = (key: keyof typeof VICTORY_TIPS, label: string) =>
      `<button class="chip ${set[key] ? 'on' : ''}" data-v="${key}" title="${esc(VICTORY_TIPS[key])}" ${locked ? 'disabled' : ''}>${label}</button>`;
    const ok = blocks().every((b) => !problemsOf(b).length);
    box.innerHTML = `<div class="luBox">
      <div class="luBar"><b>出擊準備</b><span class="muted">${esc(document.getElementById('contentTag')?.textContent ?? '')}</span><span class="spacer"></span>
        <span class="muted">環境</span><select data-f="environment" ${off} title="重力圈：每回合結束時動能往 0 回正 1（地面滑行的機體例外）；不適合這個環境的機體機動盤最高速度 −1">
          <option value="space" ${set.environment === 'space' ? 'selected' : ''}>宇宙</option><option value="gravity" ${set.environment === 'gravity' ? 'selected' : ''}>重力圈</option></select>
        <span class="muted">地形</span><select data-f="terrain" ${off} title="隕石帶：大隕石與隕石群；森林：大片森林（擋視線、穿越命中下降）；城鎮：幾棟圓形建築；城市：棋盤狀街道與 1–4 層的高樓（有高度、可以攀升上樓頂）">
          ${(['asteroid', 'forest', 'town', 'city'] as const).map((t) => `<option value="${t}" ${set.terrain === t ? 'selected' : ''}>${{ asteroid: '隕石帶', forest: '森林', town: '城鎮', city: '城市' }[t]}</option>`).join('')}</select>
        <span class="muted">規模</span><select data-f="scale" ${off}>${(Object.keys(SCALES) as Scale[]).map((k) => `<option value="${k}" ${k === set.scale ? 'selected' : ''}>${SCALES[k].name}（${SCALES[k].budget} 分、最多 ${SCALES[k].maxUnits} 台）</option>`).join('')}</select>
        <button data-act="default">載入預設陣容</button><button data-act="last" ${saved ? '' : 'disabled'}>上次的陣容</button></div>
      ${seatsHtml()}
      <div class="luCols">${blocks()
        .map((_, i) => sideHtml(i))
        .join('')}</div>
      <div class="luFoot luWrap"><span class="muted">勝利條件</span>
        ${chip('killScore', `擊墜分 ${SCALES[set.scale].killScore}`)}${chip('decapitation', '斬首')}${chip('goal', '達陣')}${chip('control', `據點 ${CONTROL_TARGET}`)}
        <span class="muted small" title="一方全滅一定算輸；回合上限到了比分數">可複選，先達成者勝</span>
        <span class="spacer"></span><span class="muted">部署</span>
        <button class="chip ${set.deploy === 'fixed' ? 'on' : ''}" data-deploy="fixed" ${locked ? 'disabled' : ''} title="照順序在自己那一側排一列">固定排開</button>
        <button class="chip ${set.deploy === 'free' ? 'on' : ''}" data-deploy="free" ${locked ? 'disabled' : ''} title="開戰前雙方暗中在自己的部署區擺好位置、朝向與起始動能，一起公布">自由部署</button>
        <button class="chip ${set.supply ? 'on' : ''}" data-supply="1" ${locked ? 'disabled' : ''} title="雙方後方各一個補給點：停在自己的補給點上（動能 0）用掉動作，補滿彈藥、道具與推進劑">補給點</button>
        <span class="muted">回合上限</span><select data-f="turnLimit" ${off}>${TURN_LIMITS.map((t) => `<option value="${t}" ${t === set.turnLimit ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      ${
        online
          ? `<div class="luFoot"><span class="muted">${host ? '你是房主（A 方）：對戰條件由你決定。對手看不到你的隊伍，所有席位都加入就開打。' : squadsOf(online.side) > 1 ? `照房主的條件選隊。你是 ${seatLabel(online.seat)}，${set.decapitation ? '斬首時全方最貴的那台是旗艦（可能不在你這隊）；' : ''}所有席位都加入就開打。` : locked ? '照房主的條件選隊。對手看不到你的隊伍，雙方都加入就開打。' : '房主還沒選好條件，先照這些選；開打前會照房主的條件再檢查一次。'}</span>
        <span class="spacer"></span><button class="primary big" data-act="start" ${ok ? '' : 'disabled title="陣容有問題，先修正再出擊"'}>加入房間</button></div>`
          : `<div class="luFoot"><span class="muted">對手</span><select data-f="opponent">${OPPONENTS.map(([v, t]) => `<option value="${v}" ${v === opp ? 'selected' : ''}>${t}</option>`).join('')}</select>
        <span class="spacer"></span>
        <label class="muted" title="只有種子、陣容和雙方指令，用來檢討 AI 與平衡"><input type="checkbox" data-f="upload" ${uploadEnabled() ? 'checked' : ''}> 上傳對戰紀錄</label>
        <button class="primary big" data-act="start" ${ok ? '' : 'disabled title="陣容有問題，先修正再出擊"'}>開始戰鬥</button></div>`
      }
    </div>`;
  };

  const saveSettings = () => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(set));
    } catch {}
  };

  box.onchange = (ev) => {
    const el = ev.target as HTMLSelectElement;
    if (editing && el.dataset.ed === 'apply' && el.value) {
      const u = blocks()[editing.s].list[editing.i];
      u.equipment = clone(el.value.startsWith('m') ? mineOf(u.chassis)[Number(el.value.slice(1))] : loadoutsOf(u.chassis)[Number(el.value.slice(1))]);
      return render();
    }
    if (host && el.dataset.squads) {
      set.squads![Number(el.dataset.squads)] = Number(el.value);
      // 小隊數變了：電腦小隊照新的額度重選
      for (const k of Object.keys(aiRosters)) delete aiRosters[k];
      saveSettings();
      return render();
    }
    if (host && el.dataset.ctrl) {
      const k = el.dataset.ctrl;
      set.aiSeats = el.value === 'ai' ? [...set.aiSeats!.filter((x) => x !== k), k] : set.aiSeats!.filter((x) => x !== k);
      saveSettings();
      return render();
    }
    const f = el.dataset.f;
    if (f === 'upload') return setUploadEnabled((el as unknown as HTMLInputElement).checked);
    if (f === 'opponent') opp = el.value as Opponent;
    else if (f === 'scale') {
      set.scale = el.value as Scale;
      for (const k of Object.keys(aiRosters)) delete aiRosters[k];
      saveSettings();
    } else if (f === 'terrain') {
      set.terrain = el.value as LineupSettings['terrain'];
      // 城市在地面上
      if (set.terrain === 'city') set.environment = 'gravity';
      saveSettings();
    } else if (f === 'environment') {
      set.environment = el.value as LineupSettings['environment'];
      saveSettings();
    } else if (f === 'turnLimit') {
      set.turnLimit = Number(el.value);
      saveSettings();
    } else if (f) {
      const u = blocks()[Number(el.dataset.s)].list[Number(el.dataset.i)];
      if (f === 'chassis') {
        u.chassis = el.value;
        u.equipment = clone(loadoutsOf(el.value)[0]);
      } else if (f === 'pilot') u.pilot = el.value;
      else if (f === 'load' && el.value.startsWith('m')) u.equipment = clone(mineOf(u.chassis)[Number(el.value.slice(1))]);
      else if (f === 'load' && el.value !== 'cur') u.equipment = clone(loadoutsOf(u.chassis)[Number(el.value)]);
    }
    render();
  };
  box.onclick = (ev) => {
    const el = (ev.target as HTMLElement).closest('button');
    if (!el || el.disabled) return;
    if (editing) return editorClick(el);
    if (online && el.dataset.invite) {
      const url = `${online.roomUrl}&seat=${el.dataset.invite}`;
      navigator.clipboard?.writeText(url).then(
        () => (el.textContent = '已複製'),
        () => window.prompt('邀請連結', url),
      );
      return;
    }
    if (el.dataset.supply) {
      set.supply = !set.supply;
      saveSettings();
      return render();
    }
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
    const s = Number(el.dataset.s);
    const b = blocks()[s];
    const budget = b ? limitOf(b.side).budget : SCALES[set.scale].budget;
    if (act === 'edit') editing = { s, i: Number(el.dataset.i), slot: gearSlots(b.list[Number(el.dataset.i)].chassis)[0]?.key ?? '' };
    else if (act === 'remove') b.list.splice(Number(el.dataset.i), 1);
    else if (act === 'add') b.list.push(randomEntries(1, budget, b.list)[0]);
    else if (act === 'random') setList(b, randomEntries(Math.min(b.list.length, limitOf(b.side).maxUnits), budget));
    else if (act === 'default') rosters = clone(DEFAULT_ROSTERS);
    else if (act === 'last' && saved) rosters = clone(saved);
    else if (act === 'start') {
      try {
        localStorage.setItem(KEY, JSON.stringify(rosters));
      } catch {}
      if (!locked) saveSettings();
      box.hidden = true;
      rerender = null;
      if (online) online.onJoin(clone(rosters[online.side]), toBattleSettings(set), set.scale, { ...set }, Object.fromEntries(aiKeys().map((k) => [k, clone(aiRoster(k))])));
      else onStart(clone(rosters), opp, toBattleSettings(set));
      return;
    }
    render();
  };
  /** 武裝編輯器裡的按鈕：選掛點、換裝備、存成我的配裝、完成 */
  function editorClick(el: HTMLButtonElement) {
    const ed = editing!;
    const u = blocks()[ed.s].list[ed.i];
    const { filled, extra } = gearToSlots(u.chassis, u.equipment);
    if (el.dataset.slot) ed.slot = el.dataset.slot;
    else if (el.dataset.pick !== undefined) {
      if (el.dataset.pick) filled[ed.slot] = el.dataset.pick;
      else delete filled[ed.slot];
      u.equipment = slotsToGear(u.chassis, filled, extra);
    } else if (el.dataset.drop !== undefined) {
      extra.splice(Number(el.dataset.drop), 1);
      u.equipment = slotsToGear(u.chassis, filled, extra);
    } else if (el.dataset.ed === 'save') {
      const m = loadMine();
      m[u.chassis] = [...(m[u.chassis] ?? []), clone(u.equipment)];
      saveMine(m);
    } else if (el.dataset.ed === 'forget') {
      const m = loadMine();
      m[u.chassis] = (m[u.chassis] ?? []).filter((g) => !same(g, u.equipment));
      saveMine(m);
    } else if (el.dataset.ed === 'done') editing = null;
    render();
  }

  rerender = online ? () => !editing && !box.hidden && render() : null;
  render();
  box.hidden = false;
}
