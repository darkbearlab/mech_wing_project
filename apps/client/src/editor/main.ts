// 機庫：編輯內容 API 上的草稿（武器、機型、駕駛、配裝、預設陣容），檢查後發佈成新版本。
// 草稿每次修改就在本機用規則引擎檢查，並在停手一下後存回伺服器。
import {
  BODY_PART_NAMES,
  PART_ROLES,
  ROLE_NAMES,
  chassisParts,
  type PartRole,
  config as C,
  validateContent,
  type ChassisDef,
  type ContentPack,
  type EquipDef,
  type PilotDef,
  type RosterEntry,
  type UnitView,
} from '@mech/rules';
import { API } from '../content';
import { mechSilhouette } from '../silhouette';

// ---------- 小工具 ----------

type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') || k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') (el as unknown as Record<string, unknown>)[k] = v;
    else if (k === 'class') el.className = String(v);
    else el.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}
const $ = (id: string) => document.getElementById(id)!;
const nodes = (xs: Child[]) => xs.filter((x): x is Node | string => x !== null && x !== undefined && x !== false);
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const clone = <T>(v: T): T => structuredClone(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
type Obj = Record<string, unknown>;

// ---------- 狀態 ----------

type Kind = 'equipment' | 'chassis' | 'pilots' | 'loadouts' | 'rosters';
const KINDS: { id: Kind; name: string; err: string }[] = [
  { id: 'equipment', name: '武器', err: '武器' },
  { id: 'chassis', name: '機型', err: '機型' },
  { id: 'pilots', name: '駕駛', err: '駕駛' },
  { id: 'loadouts', name: '配裝', err: '配裝' },
  { id: 'rosters', name: '陣容', err: '預設陣容' },
];
const SIDES = ['A', 'B'];
const KEY_STORE = 'mech.adminKey';

let adminKey: string | null = null;
try {
  adminKey = localStorage.getItem(KEY_STORE);
} catch {}
let draft: ContentPack = { version: 'draft', equipment: {}, chassis: {}, pilots: {}, loadouts: {}, rosters: [[], []] };
let pub: ContentPack | null = null;
let releases: { version: string; note: string | null; created_at: string }[] = [];
let errors: string[] = [];
let kind: Kind = 'equipment';
let sel: string | null = null;
let search = '';
let jsonMode = false;
let showAllErrors = false;
/** 機動盤格子目前顯示到幾檔（只是畫面，沒存進資料） */
const topSpeed = new Map<string, number>();

const canEdit = () => !!adminKey;

class ApiError extends Error {
  constructor(public status: number, message: string, public errors: string[] = []) {
    super(message);
  }
}

async function api<T = Obj>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (adminKey) headers.Authorization = `Bearer ${adminKey}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(API + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = (await res.json().catch(() => ({}))) as Obj;
  if (!res.ok) throw new ApiError(res.status, String(out.error ?? `HTTP ${res.status}`), (out.errors as string[]) ?? []);
  return out as T;
}

function ids(p: ContentPack | null, k: Kind): string[] {
  if (!p) return [];
  return k === 'rosters' ? SIDES : Object.keys(p[k] ?? {});
}
function getItem(p: ContentPack | null, k: Kind, id: string): unknown {
  if (!p) return undefined;
  if (k === 'rosters') return p.rosters[SIDES.indexOf(id)];
  return (p[k] as Obj)[id];
}
function setItem(p: ContentPack, k: Kind, id: string, v: unknown): void {
  if (k === 'rosters') p.rosters[SIDES.indexOf(id)] = v as RosterEntry[];
  else (p[k] as Obj)[id] = v;
}
function delItem(p: ContentPack, k: Kind, id: string): void {
  if (k !== 'rosters') delete (p[k] as Obj)[id];
}
const isChanged = (k: Kind, id: string) => !same(getItem(draft, k, id), getItem(pub, k, id));
const deletedIds = (k: Kind) => ids(pub, k).filter((id) => getItem(draft, k, id) === undefined);

function itemErrors(k: Kind, id: string): string[] {
  const pre = `${KINDS.find((x) => x.id === k)!.err} ${id}`;
  const next = k === 'rosters' ? /^\d/ : /^[：\s]/;
  return errors.filter((e) => e.startsWith(pre) && next.test(e.slice(pre.length)));
}

// ---------- 儲存 ----------

const timers = new Map<string, number>();
const inflight = new Set<Promise<void>>();

function setSave(text: string, bad = false) {
  const el = $('saveState');
  el.textContent = text;
  el.classList.toggle('bad', bad);
}

/** 目前選取的項目改了：重新檢查、更新畫面，稍後存回伺服器 */
function changed(rerenderForm = false) {
  if (!sel) return;
  errors = validateContent(draft);
  if (rerenderForm) renderForm();
  renderList();
  renderSide();
  renderPills();
  queueSave(kind, sel);
}

function queueSave(k: Kind, id: string) {
  const key = `${k}/${id}`;
  clearTimeout(timers.get(key));
  setSave('尚未儲存…');
  timers.set(key, window.setTimeout(() => void runSave(k, id), 500));
}

function runSave(k: Kind, id: string): Promise<void> {
  timers.delete(`${k}/${id}`);
  const v = getItem(draft, k, id);
  setSave('儲存中…');
  const p = (v === undefined ? api('DELETE', `/draft/${k}/${encodeURIComponent(id)}`) : api('PUT', `/draft/${k}/${encodeURIComponent(id)}`, v))
    .then(() => {
      if (!timers.size) setSave('已儲存');
    })
    .catch((e: Error) => setSave(`儲存失敗：${e.message}`, true))
    .finally(() => inflight.delete(p));
  inflight.add(p);
  return p;
}

async function flush() {
  for (const key of [...timers.keys()]) {
    clearTimeout(timers.get(key));
    const [k, id] = key.split('/') as [Kind, string];
    void runSave(k, id);
  }
  await Promise.all([...inflight]);
}

window.addEventListener('beforeunload', (e) => {
  if (timers.size || inflight.size) e.preventDefault();
});

// ---------- 上方工具列 ----------

function renderPills() {
  let pending = 0;
  for (const k of KINDS) pending += ids(draft, k.id).filter((id) => isChanged(k.id, id)).length + deletedIds(k.id).length;
  const latest = pub?.version;
  $('pills').replaceChildren(
    h('span', { class: `pill ${pending ? 'warn' : ''}` }, pending ? `草稿：${pending} 筆未發佈` : '草稿與線上一致'),
    h('span', { class: `pill ${errors.length ? 'bad' : 'ok'}` }, errors.length ? `${errors.length} 個問題` : '檢查通過'),
    h('span', { class: 'pill ok' }, latest ? `線上 ${latest}` : '尚未發佈'),
  );
  $('lockBtn').textContent = adminKey ? '已解鎖' : '輸入金鑰';
  $('banner').hidden = !!adminKey;
  $('banner').textContent = '瀏覽模式：輸入管理金鑰後才能編輯。';
}

function popup(...kids: Child[]) {
  const el = $('popup');
  el.replaceChildren(...kids.filter((k): k is Node | string => !!k));
  el.hidden = false;
}
const closePopup = () => ($('popup').hidden = true);
document.addEventListener('keydown', (e) => e.key === 'Escape' && closePopup());

function lockPopup() {
  const input = h('input', { type: 'password', placeholder: '管理金鑰', autocomplete: 'off' });
  const msg = h('div', { class: 'msg' }, '金鑰只存在這個瀏覽器裡。');
  const ok = async () => {
    const key = input.value.trim();
    if (!key) return;
    const prev = adminKey;
    adminKey = key;
    try {
      await api('GET', '/auth');
      try {
        localStorage.setItem(KEY_STORE, key);
      } catch {}
      closePopup();
      renderAll();
    } catch (e) {
      adminKey = prev;
      msg.className = 'msg bad';
      msg.textContent = e instanceof ApiError && e.status === 401 ? '金鑰不正確。' : `連不上伺服器：${(e as Error).message}`;
    }
  };
  input.onkeydown = (e) => e.key === 'Enter' && void ok();
  popup(
    h('h4', {}, adminKey ? '管理金鑰（已解鎖）' : '輸入管理金鑰'),
    h('div', { class: 'row' }, input, h('button', { class: 'primary', onclick: ok }, '確認')),
    msg,
    adminKey &&
      h('div', { class: 'row' }, h('button', {
        onclick: () => {
          adminKey = null;
          try {
            localStorage.removeItem(KEY_STORE);
          } catch {}
          closePopup();
          renderAll();
        },
      }, '登出（清除這個瀏覽器的金鑰）')),
    h('div', { class: 'row' }, h('button', { onclick: closePopup }, '關閉')),
  );
  input.focus();
}

async function historyPopup() {
  popup(h('h4', {}, '版本紀錄'), h('div', { class: 'msg' }, '讀取中…'));
  try {
    releases = await api('GET', '/packs');
  } catch {}
  popup(
    h('h4', {}, '版本紀錄'),
    releases.length
      ? h('div', { class: 'msg' }, ...releases.map((r) => h('div', {}, h('a', { href: `./index.html?content=${encodeURIComponent(r.version)}`, target: '_blank' }, r.version), ` ${r.created_at} UTC`, r.note ? `　${r.note}` : '')))
      : h('div', { class: 'msg' }, '還沒有發佈過。'),
    h('div', { class: 'msg' }, '點版本號會用那一版開一場對戰。'),
    h('div', { class: 'row' }, h('button', { onclick: closePopup }, '關閉')),
  );
}

function publishPopup() {
  if (!adminKey) return lockPopup();
  if (errors.length) {
    return popup(
      h('h4', {}, '草稿有問題，還不能發佈'),
      h('div', { class: 'msg bad' }, errors.join('\n')),
      h('div', { class: 'row' }, h('button', { onclick: closePopup }, '關閉')),
    );
  }
  const note = h('input', { placeholder: '這次改了什麼（可留空）' });
  const msg = h('div', { class: 'msg' }, '發佈後，遊戲下次開場就會用新版本。');
  const go = h('button', { class: 'primary' }, '發佈');
  go.onclick = async () => {
    go.disabled = true;
    msg.textContent = '發佈中…';
    try {
      await flush();
      const r = await api<{ version: string }>('POST', '/publish', { note: note.value.trim() || undefined });
      pub = await api<ContentPack>('GET', `/packs/${r.version}`);
      msg.className = 'msg ok';
      msg.textContent = `已發佈 ${r.version}。`;
      renderAll();
    } catch (e) {
      msg.className = 'msg bad';
      msg.textContent = e instanceof ApiError && e.errors.length ? e.errors.join('\n') : (e as Error).message;
      go.disabled = false;
    }
  };
  popup(h('h4', {}, '發佈草稿'), h('div', { class: 'row' }, note), msg, h('div', { class: 'row' }, go, h('button', { onclick: closePopup }, '關閉')));
  note.focus();
}

$('lockBtn').onclick = lockPopup;
$('historyBtn').onclick = () => void historyPopup();
$('publishBtn').onclick = publishPopup;
$('playBtn').onclick = async () => {
  const w = window.open('about:blank', '_blank');
  await flush();
  if (w) w.location.href = './index.html?content=draft';
  if (errors.length) popup(h('h4', {}, '注意'), h('div', { class: 'msg bad' }, '草稿目前有問題，試玩會改用內建資料。'), h('div', { class: 'row' }, h('button', { onclick: closePopup }, '關閉')));
};

// ---------- 左欄：分類與清單 ----------

function label(k: Kind, id: string, p: ContentPack = draft): string {
  const v = getItem(p, k, id) as Obj | unknown[] | undefined;
  if (k === 'loadouts') return `${(draft.chassis[id] ?? pub?.chassis[id])?.name ?? id}`;
  if (k === 'rosters') return `${id} 方`;
  return String((v as Obj | undefined)?.name ?? id);
}
const MOUNT_SHORT: Record<string, string> = { hand: '手持', mounted: '外掛', integrated: '內建', housed: '內藏' };
function tail(k: Kind, id: string): string {
  const v = getItem(draft, k, id);
  if (k === 'equipment') return MOUNT_SHORT[(v as EquipDef).mount ?? 'hand'] ?? '';
  if (k === 'loadouts') return `${(v as unknown[]).length} 套`;
  if (k === 'rosters') return `${(v as unknown[]).length} 台`;
  return id;
}

function renderTabs() {
  $('tabs').replaceChildren(
    ...KINDS.map((k) =>
      h('span', {
        class: k.id === kind ? 'on' : '',
        onclick: () => {
          kind = k.id;
          sel = ids(draft, kind)[0] ?? null;
          jsonMode = false;
          renderAll();
        },
      }, k.name),
    ),
  );
}

function renderList() {
  const q = search.trim().toLowerCase();
  const rows = ids(draft, kind)
    .filter((id) => !q || id.toLowerCase().includes(q) || label(kind, id).toLowerCase().includes(q))
    .map((id) => {
      const bad = itemErrors(kind, id).length > 0;
      const dirty = isChanged(kind, id);
      return h('div', {
        class: `item ${id === sel ? 'on' : ''}`,
        onclick: () => select(id),
        title: bad ? '有問題' : dirty ? '有未發佈的修改' : '',
      },
        h('span', {}, label(kind, id)),
        h('span', { class: `dot ${bad ? 'err' : dirty ? 'warn' : 'id'}` }, bad ? '●' : dirty ? '●' : tail(kind, id)),
      );
    });
  const gone = deletedIds(kind).map((id) =>
    h('div', { class: 'item gone', title: '草稿裡刪掉了，發佈後會消失' },
      h('span', {}, label(kind, id, pub!)),
      canEdit() && h('button', {
        class: 'small',
        onclick: () => {
          setItem(draft, kind, id, clone(getItem(pub, kind, id)));
          sel = id;
          changed(true);
        },
      }, '還原'),
    ),
  );
  $('list').replaceChildren(...nodes([...rows, ...gone, rows.length ? null : h('div', { class: 'muted' }, '沒有符合的項目')]));
}

function select(id: string) {
  sel = id;
  jsonMode = false;
  renderList();
  renderListActions();
  renderForm();
  renderSide();
}

const TEMPLATES: Partial<Record<Kind | 'fighter', (id: string) => unknown>> = {
  equipment: (id) => ({ id, name: '新武器', kind: 'ranged', weight: 1, durability: 1, damage: 1, shots: 1, mode: 'focused', ranges: { 2: 0 } }),
  chassis: (id) => ({ ...clone(Object.values(draft.chassis).find((c) => c.parts.torso) ?? Object.values(draft.chassis)[0]), id, name: `${id} 新機型`, builtIn: [] }),
  fighter: (id) => ({
    id, name: `${id} 新戰機`, weightClass: 1, propellant: 14, baseThrust: 2, maxAccel: 2, power: 1, aim: 0, evasion: 20,
    radius: 0.35, minSpeed: 2, closeCombat: false, builtIn: [],
    parts: { hull: { name: '機身', role: 'core', weight: 3, durability: 4 }, engine: { name: '引擎', role: 'propulsion', weight: 2, durability: 2 }, canopy: { name: '座艙罩', role: 'sensor', weight: 1, durability: 1 } },
    dial: ['straight-S-2', 'straight-S-3', 'straight-S-4', 'straight-S-5', 'bank-L-2', 'bank-R-2', 'bank-L-3', 'bank-R-3', 'turn-L-3', 'turn-R-3'],
  }),
  pilots: (id) => ({ id, name: '新駕駛', skill: 1, maxStress: 5, recovery: 1, abilities: [] }),
};

function renderListActions() {
  const box = $('listActions');
  if (!canEdit()) return box.replaceChildren();
  if (kind === 'equipment' || kind === 'chassis' || kind === 'pilots') {
    const k = kind;
    const make = (copy: boolean, template: Kind | 'fighter' = k) => {
      const input = h('input', { placeholder: '新的 id（英數，例如 beam_gun）' });
      const msg = h('div', { class: 'err' });
      const ok = () => {
        const id = input.value.trim();
        if (!/^[A-Za-z0-9_-]+$/.test(id)) return void (msg.textContent = 'id 只能用英數、底線、連字號');
        if (getItem(draft, k, id) !== undefined) return void (msg.textContent = '這個 id 已經有了');
        const base = copy && sel ? { ...(clone(getItem(draft, k, sel)) as Obj), id } : TEMPLATES[template]!(id);
        if (copy && sel) (base as Obj).name = `${(base as Obj).name}（複製）`;
        setItem(draft, k, id, base);
        sel = id;
        renderListActions();
        changed(true);
      };
      input.onkeydown = (e) => e.key === 'Enter' && ok();
      box.replaceChildren(h('div', { class: 'row' }, input), msg, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: ok }, copy ? '複製' : template === 'fighter' ? '新增戰機' : '新增'), h('button', { onclick: renderListActions }, '取消')));
      input.focus();
    };
    box.replaceChildren(
      h('div', { class: 'row' }, h('button', { onclick: () => make(false) }, k === 'chassis' ? '＋ 人形' : '＋ 新增'), k === 'chassis' && h('button', { onclick: () => make(false, 'fighter') }, '＋ 戰機'), sel && h('button', { onclick: () => make(true) }, '複製這筆')),
    );
  } else if (kind === 'loadouts') {
    const free = Object.keys(draft.chassis).filter((c) => !draft.loadouts[c]);
    if (!free.length) return box.replaceChildren(h('div', { class: 'muted' }, '每個機型都有配裝表了'));
    const pick = h('select', {}, ...free.map((c) => h('option', { value: c }, draft.chassis[c].name)));
    box.replaceChildren(h('div', { class: 'row' }, pick, h('button', {
      onclick: () => {
        draft.loadouts[pick.value] = [[]];
        sel = pick.value;
        renderListActions();
        changed(true);
      },
    }, '＋ 新增配裝表')));
  } else box.replaceChildren();
}

$('search').oninput = (e) => {
  search = (e.target as HTMLInputElement).value;
  renderList();
};

// ---------- 中欄：表單 ----------

interface NumOpts {
  optional?: boolean;
  step?: string;
  hint?: string;
  after?: () => void;
}
function numField(obj: Obj, key: string, name: string, o: NumOpts = {}) {
  const input = h('input', { type: 'number', step: o.step ?? '1', value: obj[key] ?? '', placeholder: o.optional ? '—' : '', disabled: !canEdit(), title: o.hint });
  input.oninput = () => {
    const t = input.value.trim();
    if (t === '') {
      if (!o.optional) return;
      delete obj[key];
    } else if (Number.isFinite(Number(t))) obj[key] = Number(t);
    else return;
    changed();
    o.after?.();
  };
  return h('label', { class: 'field', title: o.hint }, h('small', {}, name), input);
}
function textField(obj: Obj, key: string, name: string) {
  const input = h('input', { value: obj[key] ?? '', disabled: !canEdit() });
  input.oninput = () => {
    obj[key] = input.value;
    changed();
  };
  return h('label', { class: 'field' }, h('small', {}, name), input);
}
/** absent：選到這個值時刪掉欄位（代表預設） */
function selField(obj: Obj, key: string, name: string, options: [string, string][], o: { absent?: string; rerender?: boolean; hint?: string } = {}) {
  const cur = obj[key] === undefined ? o.absent : String(obj[key]);
  const s = h('select', { disabled: !canEdit(), title: o.hint }, ...options.map(([v, t]) => h('option', { value: v, selected: v === cur }, t)));
  s.onchange = () => {
    if (s.value === o.absent) delete obj[key];
    else obj[key] = s.value === 'true' ? true : s.value === 'false' ? false : s.value;
    changed(o.rerender);
  };
  return h('label', { class: 'field', title: o.hint }, h('small', {}, name), s);
}
function chips(arr: string[] | undefined, options: [string, string][], set: (v: string[] | undefined) => void) {
  const cur = new Set(arr ?? []);
  return h('div', { class: 'chips' }, ...options.map(([v, t]) =>
    h('span', {
      class: `chip ${cur.has(v) ? 'on' : ''}`,
      onclick: () => {
        if (!canEdit()) return;
        cur.has(v) ? cur.delete(v) : cur.add(v);
        set(cur.size ? [...cur] : undefined);
        changed(true);
      },
    }, t),
  ));
}
const sec = (name: string, ...kids: Child[]) => h('div', { class: 'sec' }, h('div', { class: 'lbl' }, name), ...kids);
const grid = (...kids: Child[]) => h('div', { class: 'grid' }, ...kids);

function head(title: string, idText: string, extra: Child[] = []) {
  const jsonBtn = h('button', { class: 'small', onclick: () => ((jsonMode = !jsonMode), renderForm()) }, jsonMode ? '表單' : 'JSON');
  return h('div', { class: 'head' }, h('h3', {}, title), h('span', { class: 'id' }, idText), h('span', { class: 'spacer' }), ...extra, jsonBtn);
}

function deleteButton(k: Kind, id: string) {
  if (!canEdit() || k === 'rosters') return null;
  const b = h('button', { class: 'small danger' }, '刪除');
  let armed = false;
  b.onclick = () => {
    if (!armed) {
      armed = true;
      b.textContent = '再按一次確認刪除';
      setTimeout(() => {
        armed = false;
        b.textContent = '刪除';
      }, 3000);
      return;
    }
    delItem(draft, k, id);
    errors = validateContent(draft);
    void runSave(k, id);
    sel = ids(draft, k)[0] ?? null;
    renderAll();
  };
  return b;
}

const KIND_OPTS: [string, string][] = [['ranged', '射擊'], ['melee', '近戰'], ['shield', '盾牌'], ['tank', '燃料槽']];
const MOUNT_OPTS: [string, string][] = [['hand', '手持'], ['mounted', '外掛'], ['integrated', '內建（部位的一部分）'], ['housed', '內藏（藏在手臂裡）']];
const TAG_OPTS: [string, string][] = [['quickDraw', '快速拔出'], ['secondary', '副武裝'], ['volatile', '易爆'], ['overflow', '溢出傷害']];

function equipmentForm(e: EquipDef & Obj) {
  const mount = e.mount ?? 'hand';
  const out: Child[] = [
    sec('基本', grid(
      textField(e, 'name', '名稱'),
      selField(e, 'kind', '種類', KIND_OPTS, { rerender: true }),
      selField(e, 'mount', '安裝方式', MOUNT_OPTS, { absent: 'hand', rerender: true }),
      numField(e, 'weight', '受擊權重', { hint: '被打中時分到這件的機率權重；內建與內藏武器沒有自己的部位，填 0' }),
      numField(e, 'durability', '耐久', { hint: '手持與外掛裝備至少 1' }),
    )),
  ];
  if (e.kind === 'ranged') {
    e.ranges ??= {};
    const r = e.ranges as Obj;
    out.push(
      sec('射擊', grid(
        numField(e, 'damage', '傷害'),
        numField(e, 'shots', '發數', { optional: true, hint: '空白＝1' }),
        selField(e, 'mode', '傷害模式', [['focused', '集中（同一部位）'], ['scattered', '分散（每發各抽部位）']], { absent: 'focused' }),
        numField(e, 'ammo', '彈數', { optional: true, hint: '空白＝無限' }),
        numField(e, 'arc', '射界半角（度）', { optional: true, hint: '空白＝照手持規則（正面外命中 −20）；有填就是固定射界，射界外打不到' }),
        selField(e, 'pointBlank', '零距離射擊', [['true', '可以'], ['false', '不行']], { absent: 'true' }),
      )),
      sec('距離帶命中修正（空白＝那個距離不能打）', grid(numField(r, '1', '近 R1', { optional: true }), numField(r, '2', '中 R2', { optional: true }), numField(r, '3', '遠 R3', { optional: true }))),
    );
  }
  if (e.kind === 'melee') out.push(sec('近戰', grid(numField(e, 'damage', '傷害'), numField(e, 'meleeDice', '額外近戰骰', { optional: true, hint: '重武器在近戰對決多擲的骰數' }))));
  if (e.kind === 'tank') out.push(sec('燃料', grid(numField(e, 'fuel', '增加推進劑'))));
  if (e.kind === 'shield')
    out.push(sec('防護範圍', grid(
      numField(e, 'shieldOffset', '中心角度（度）', { optional: true, hint: '相對機體正面，負＝左、正＝右。空白：手持盾在持盾那側，固定盾在正前方' }),
      numField(e, 'shieldArc', '半角（度）', { optional: true, hint: `空白＝${C.SHIELD_ARC_HALF_DEG}。例如左前 90 度：中心 −45、半角 45` }),
    )));
  if (mount === 'integrated') out.push(sec('內建', grid(selField(e, 'blocksHand', '佔手', [['false', '不佔手'], ['true', '那隻手不能握持']], { absent: 'false', hint: '例如手指光束砲' }))));
  out.push(sec('標籤', chips(e.tags, TAG_OPTS, (v) => (v ? (e.tags = v as EquipDef['tags']) : delete e.tags))));
  return out;
}

const FWD: [string, string, string][] = [['arc', 'L', '弧左'], ['turn', 'L', '急左'], ['bank', 'L', '緩左'], ['straight', 'S', '直'], ['bank', 'R', '緩右'], ['turn', 'R', '急右'], ['arc', 'R', '弧右']];
const BACK: [string, string, string][] = [['rbank', 'L', '斜後左'], ['reverse', 'S', '後退'], ['rbank', 'R', '斜後右'], ['kturn', 'S', '急停反轉']];

function dialGrid(c: ChassisDef, cols: [string, string, string][], speeds: number[]) {
  const set = new Set(c.dial);
  const cell = (id: string | null) => {
    if (!id) return h('div', { class: 'c na' });
    const on = set.has(id);
    return h('div', {
      class: `c ${on ? 'on' : ''}`,
      title: id,
      onclick: () => {
        if (!canEdit()) return;
        c.dial = on ? c.dial.filter((m) => m !== id) : [...c.dial, id];
        changed(true);
      },
    }, on ? '●' : '·');
  };
  const g = h('div', { class: 'dial', style: `grid-template-columns: auto repeat(${cols.length}, auto)` }, h('div', {}), ...cols.map(([, , n]) => h('div', { class: 'h' }, n)));
  for (const s of speeds) {
    g.append(h('div', { class: 'h' }, String(s)));
    for (const [k, d] of cols) g.append(cell(s === 0 ? (k === 'straight' ? 'hover-S-0' : null) : `${k}-${d}-${s}`));
  }
  return g;
}

function chassisForm(c: ChassisDef & Obj) {
  // 機型的標準裝備：內建（和部位一體）或外掛（固定掛著、有自己的部位，例如薩克的肩盾）
  const integrated = Object.values(draft.equipment).filter((e) => e.mount === 'integrated' || e.mount === 'mounted');
  c.builtIn ??= [];
  // 格子顯示到 5 檔或機動盤上最快的那一檔，可以再往上加
  const fastest = Math.max(0, ...c.dial.map((m) => Number(m.split('-')[2])).filter((s) => Number.isInteger(s) && s <= C.MAX_DIAL_SPEED));
  const top = Math.min(C.MAX_DIAL_SPEED, Math.max(5, fastest, topSpeed.get(c.id) ?? 0));
  const up = Array.from({ length: top }, (_, i) => i + 1);
  const known = new Set<string>(['hover-S-0']);
  for (const s of up) for (const [k, d] of [...FWD, ...BACK]) known.add(`${k}-${d}-${s}`);
  const more = top < C.MAX_DIAL_SPEED && h('button', { class: 'small', onclick: () => (topSpeed.set(c.id, top + 1), renderForm()) }, `＋ 加到 ${top + 1} 檔`);
  const odd = c.dial.filter((m) => !known.has(m));
  const parts = c.parts as unknown as Record<string, Obj>;
  const hostOptions = (cur: string) => partOptions(c.id, cur);
  return [
    sec('基本', grid(
      textField(c, 'name', '名稱'),
      numField(c, 'weightClass', '重量級'),
      numField(c, 'propellant', '推進劑'),
      numField(c, 'baseThrust', '免費加速', { hint: '每回合不耗推進劑的速度變化量' }),
      numField(c, 'maxAccel', '最大加速', { hint: '一回合最多能改變的速度' }),
      numField(c, 'power', '出力'),
      numField(c, 'aim', '瞄準'),
      numField(c, 'evasion', '迴避'),
    )),
    sec('體型與限制', grid(
      radiusField(c),
      numField(c, 'minSpeed', '最低速度', { optional: true, hint: '空白＝0（可以懸停）。戰機填 2 之類：不能懸停、後退或慢於這個速度' }),
      selField(c, 'closeCombat', '近身戰鬥', [['true', '可以'], ['false', '不行（只能射擊姿態，被纏鬥只能脫離）']], { absent: 'true' }),
    )),
    sec('部位（功能決定規則效果：核心壞了退場、手壞了不能握持…）', h('table', {},
      h('tr', {}, h('th', {}, 'id'), h('th', {}, '名稱'), h('th', {}, '功能'), h('th', {}, '受擊權重'), h('th', {}, '耐久'), h('th', {})),
      ...chassisParts(c).map((info) => {
        const p = info.id;
        const num = (key: string) => {
          const i = h('input', { type: 'number', value: parts[p][key] ?? '', disabled: !canEdit() });
          i.oninput = () => {
            if (i.value.trim() === '') return;
            parts[p][key] = Number(i.value);
            changed();
          };
          return i;
        };
        const name = h('input', { value: info.name, disabled: !canEdit(), style: 'width:90px' });
        name.oninput = () => ((parts[p].name = name.value), changed());
        const role = h('select', { disabled: !canEdit() }, h('option', { value: '', selected: info.role === null }, '—'), ...PART_ROLES.map((r) => h('option', { value: r, selected: r === info.role }, ROLE_NAMES[r])));
        role.onchange = () => ((parts[p].role = (role.value || null) as PartRole | null), changed());
        const del = canEdit() && Object.keys(parts).length > 1 && h('button', { class: 'small', onclick: () => (delete parts[p], changed(true)) }, '×');
        return h('tr', {}, h('td', { class: 'muted' }, p), h('td', {}, name), h('td', {}, role), h('td', {}, num('weight')), h('td', {}, num('durability')), h('td', {}, del));
      }),
    ), canEdit() && addPartRow(c)),
    sec('機動盤：前進（點格子開關，列＝速度，上面最快）', dialGrid(c, FWD, [...up].reverse().concat(0)), h('div', {}, more)),
    sec('機動盤：後退與急停', dialGrid(c, BACK, up)),
    odd.length > 0 && sec('其他機動', h('div', { class: 'chips' }, ...odd.map((m) => h('span', { class: 'chip on', title: '點一下移除', onclick: () => canEdit() && ((c.dial = c.dial.filter((x) => x !== m)), changed(true)) }, `${m} ×`)))),
    sec('標準裝備（內建或固定外掛，每台都有）', h('div', { class: 'gear' },
      ...c.builtIn.map((b, i) => {
        const def = h('select', { disabled: !canEdit() }, ...integrated.map((e) => h('option', { value: e.id, selected: e.id === b.defId }, e.name)), !integrated.some((e) => e.id === b.defId) && h('option', { value: b.defId, selected: true }, b.defId));
        def.onchange = () => ((b.defId = def.value), changed());
        const host = h('select', { disabled: !canEdit() }, ...hostOptions(b.host));
        host.onchange = () => ((b.host = host.value as typeof b.host), changed());
        return h('div', { class: 'g' }, def, '裝在', host, canEdit() && h('button', { class: 'small', onclick: () => (c.builtIn!.splice(i, 1), changed(true)) }, '移除'));
      }),
      canEdit() && integrated.length > 0 && h('div', {}, h('button', { class: 'small', onclick: () => (c.builtIn!.push({ defId: integrated[0].id, host: Object.keys(parts)[0] }), changed(true)) }, '＋ 加標準裝備')),
      !integrated.length && h('div', { class: 'muted' }, '先在武器裡做一件安裝方式是「內建」或「外掛」的裝備'),
    )),
  ];
}

const RADIUS_PRESETS: [number, string][] = [[0.35, '小型戰機'], [0.5, 'MS'], [0.8, '大型 MA'], [1.5, '戰艦']];
function radiusField(c: ChassisDef & Obj) {
  const f = numField(c, 'radius', '底座半徑', { optional: true, step: '0.05', hint: `空白＝${C.BASE_RADIUS}（MS 大小）` });
  const pick = h('select', { disabled: !canEdit(), title: '常用大小' }, h('option', { value: '' }, '常用…'), ...RADIUS_PRESETS.map(([r, n]) => h('option', { value: String(r) }, `${n} ${r}`)));
  pick.onchange = () => {
    if (!pick.value) return;
    c.radius = Number(pick.value);
    changed(true);
  };
  f.append(pick);
  return f;
}

function addPartRow(c: ChassisDef & Obj) {
  const id = h('input', { placeholder: '新部位 id（英數）', style: 'width:130px' });
  const msg = h('span', { class: 'err' });
  const add = () => {
    const v = id.value.trim();
    if (!/^[A-Za-z0-9_-]+$/.test(v)) return void (msg.textContent = 'id 只能用英數、底線、連字號');
    if (c.parts[v]) return void (msg.textContent = '已經有這個部位');
    c.parts[v] = { name: v, role: null, weight: 1, durability: 2 };
    changed(true);
  };
  return h('div', { class: 'g', style: 'margin-top:6px' }, id, h('button', { class: 'small', onclick: add }, '＋ 加部位'), msg);
}

/** 宿主部位的選單（依機型實際的部位） */
function partOptions(chassisId: string | undefined, cur: string | undefined): HTMLOptionElement[] {
  const c = chassisId ? draft.chassis[chassisId] : undefined;
  const list = c ? chassisParts(c) : Object.entries(BODY_PART_NAMES).map(([id, name]) => ({ id, name }));
  const opts = list.map((p) => h('option', { value: p.id, selected: p.id === cur }, p.name));
  if (cur && !list.some((p) => p.id === cur)) opts.push(h('option', { value: cur, selected: true }, `${cur}（不存在）`));
  return opts;
}

function pilotForm(p: PilotDef & Obj) {
  return [
    sec('基本', grid(textField(p, 'name', '名稱'), numField(p, 'skill', '技術', { hint: `每點命中 +${C.HIT_PER_SKILL}、迴避 +${C.EVADE_PER_SKILL}` }), numField(p, 'maxStress', '壓力上限'), numField(p, 'recovery', '每回合壓力恢復'))),
    sec('能力', chips(p.abilities, [['quick_draw', '快速拔槍']], (v) => (p.abilities = (v ?? []) as PilotDef['abilities']))),
  ];
}

const LOC_OPTS: [string, string][] = [['right', '右手'], ['left', '左手'], ['stowed', '收納'], ['mount', '外掛'], ['builtin', '內建'], ['housed', '內藏']];
type Gear = RosterEntry['equipment'];

/** 一套裝備的編輯列：裝備、位置、宿主部位 */
function gearEditor(gear: Gear, chassisId: string) {
  const eqs = Object.values(draft.equipment);
  const row = (i: number) => {
    const [defId, loc, host] = gear[i];
    const put = (d: string, l: string, hh: string) => {
      gear[i] = (hh ? [d, l, hh] : [d, l]) as Gear[number];
    };
    const def = h('select', { disabled: !canEdit() }, ...eqs.map((e) => h('option', { value: e.id, selected: e.id === defId }, e.name)), !draft.equipment[defId] && h('option', { value: defId, selected: true }, `${defId}（不存在）`));
    def.onchange = () => {
      const e = draft.equipment[def.value];
      const m = e?.mount ?? 'hand';
      const used = new Set(gear.map(([, l]) => l));
      if (m === 'hand') put(def.value, e?.kind === 'shield' ? 'left' : !used.has('right') ? 'right' : !used.has('left') ? 'left' : 'stowed', '');
      const c = draft.chassis[chassisId];
      const ps = c ? chassisParts(c) : [];
      const pick = (role: PartRole | null) => ps.find((p) => p.role === role)?.id ?? ps[0]?.id ?? '';
      if (m === 'mounted') put(def.value, 'mount', e?.kind === 'tank' ? '' : pick('core'));
      else if (m === 'integrated') put(def.value, 'builtin', pick('sensor'));
      else if (m === 'housed') put(def.value, 'housed', pick('leftHand'));
      changed(true);
    };
    const l = h('select', { disabled: !canEdit() }, ...LOC_OPTS.map(([v, t]) => h('option', { value: v, selected: v === loc }, t)));
    l.onchange = () => (put(defId, l.value, host ?? ''), changed(true));
    const hs = h('select', { disabled: !canEdit(), title: '宿主部位（外掛、內建、內藏才需要）' }, h('option', { value: '', selected: !host }, '—'), ...partOptions(chassisId, host));
    hs.onchange = () => (put(defId, loc, hs.value), changed(true));
    return h('div', { class: 'g' }, def, l, hs, canEdit() && h('button', { class: 'small', onclick: () => (gear.splice(i, 1), changed(true)) }, '×'));
  };
  return h('div', { class: 'gear' }, ...gear.map((_, i) => row(i)), canEdit() && eqs.length > 0 && h('div', {}, h('button', { class: 'small', onclick: () => (gear.push([eqs[0].id, 'stowed']), changed(true)) }, '＋ 加裝備')));
}

function loadoutForm(sets: Gear[]) {
  return [
    h('div', { class: 'muted' }, '隨機陣容會從這些套裝裡抽一套給這個機型。'),
    ...sets.map((gear, i) =>
      h('div', { class: 'card' },
        h('div', { class: 'head' }, h('b', {}, `第 ${i + 1} 套`), h('span', { class: 'spacer' }),
          canEdit() && h('button', { class: 'small', onclick: () => (sets.splice(i + 1, 0, clone(gear)), changed(true)) }, '複製這套'),
          canEdit() && sets.length > 1 && h('button', { class: 'small danger', onclick: () => (sets.splice(i, 1), changed(true)) }, '刪除這套'),
        ),
        gearEditor(gear, sel ?? ''),
      ),
    ),
    canEdit() && h('button', { onclick: () => (sets.push([]), changed(true)) }, '＋ 新增一套'),
  ];
}

function rosterForm(side: RosterEntry[]) {
  const chassisIds = Object.keys(draft.chassis);
  const pilotIds = Object.keys(draft.pilots);
  return [
    h('div', { class: 'muted' }, '陣容設定為「預設」時使用的固定陣容（目前預設是隨機陣容）。'),
    ...side.map((u, i) => {
      const ch = h('select', { disabled: !canEdit() }, ...chassisIds.map((c) => h('option', { value: c, selected: c === u.chassis }, draft.chassis[c].name)));
      ch.onchange = () => {
        u.chassis = ch.value;
        const sets = draft.loadouts[ch.value];
        if (sets?.length) u.equipment = clone(sets[0]);
        changed(true);
      };
      const pl = h('select', { disabled: !canEdit() }, ...pilotIds.map((p) => h('option', { value: p, selected: p === u.pilot }, draft.pilots[p].name)));
      pl.onchange = () => ((u.pilot = pl.value), changed());
      return h('div', { class: 'card' },
        h('div', { class: 'head' }, h('b', {}, `${kindSel()}${i + 1}`), ch, pl, h('span', { class: 'spacer' }), canEdit() && h('button', { class: 'small danger', onclick: () => (side.splice(i, 1), changed(true)) }, '移除')),
        gearEditor(u.equipment, u.chassis),
      );
    }),
    canEdit() && chassisIds.length > 0 && h('button', {
      onclick: () => {
        const c = chassisIds[0];
        side.push({ chassis: c, pilot: pilotIds[0] ?? 'recruit', equipment: clone(draft.loadouts[c]?.[0] ?? []) });
        changed(true);
      },
    }, '＋ 加一台'),
  ];
}
const kindSel = () => sel ?? '';

function jsonForm(k: Kind, id: string) {
  const ta = h('textarea', { class: 'json', disabled: !canEdit() }, JSON.stringify(getItem(draft, k, id), null, 2));
  const msg = h('div', { class: 'err' });
  const apply = () => {
    let v: unknown;
    try {
      v = JSON.parse(ta.value);
    } catch (e) {
      return void (msg.textContent = `JSON 格式錯誤：${(e as Error).message}`);
    }
    if (k === 'equipment' || k === 'chassis' || k === 'pilots') {
      if (typeof v !== 'object' || v === null || Array.isArray(v)) return void (msg.textContent = '要是一個物件');
      if ((v as Obj).id !== id) return void (msg.textContent = `id 要維持 ${id}（要換 id 請用複製）`);
    } else if (!Array.isArray(v)) return void (msg.textContent = '要是一個陣列');
    setItem(draft, k, id, v);
    jsonMode = false;
    changed(true);
  };
  return [ta, msg, canEdit() && h('div', {}, h('button', { class: 'primary', onclick: apply }, '套用'))];
}

function renderForm() {
  const box = $('form');
  if (!sel || getItem(draft, kind, sel) === undefined) return box.replaceChildren(h('div', { class: 'empty' }, '從左邊選一筆，或新增一筆。'));
  const id = sel;
  history.replaceState(null, '', `#${kind}/${encodeURIComponent(id)}`);
  const v = getItem(draft, kind, id);
  const title = label(kind, id);
  const idText = kind === 'rosters' ? '' : kind === 'loadouts' ? `機型 ${id}` : `id: ${id}`;
  const body: Child[] = jsonMode
    ? jsonForm(kind, id)
    : kind === 'equipment'
      ? equipmentForm(v as EquipDef & Obj)
      : kind === 'chassis'
        ? chassisForm(v as ChassisDef & Obj)
        : kind === 'pilots'
          ? pilotForm(v as PilotDef & Obj)
          : kind === 'loadouts'
            ? loadoutForm(v as Gear[])
            : rosterForm(v as RosterEntry[]);
  box.replaceChildren(head(title, idText, [deleteButton(kind, id)]), ...nodes(body));
}

// ---------- 右欄：檢查、試算、使用處、變更 ----------

const FIELD_NAMES: Record<string, string> = {
  radius: '底座半徑', minSpeed: '最低速度', closeCombat: '近身戰鬥', shieldOffset: '盾牌中心角度', shieldArc: '盾牌半角',
  name: '名稱', kind: '種類', mount: '安裝方式', weight: '受擊權重', durability: '耐久', damage: '傷害', shots: '發數', mode: '傷害模式', ammo: '彈數', arc: '射界半角',
  pointBlank: '零距離', ranges: '距離帶修正', tags: '標籤', blocksHand: '佔手', meleeDice: '近戰骰', fuel: '燃料', weightClass: '重量級', propellant: '推進劑',
  baseThrust: '免費加速', maxAccel: '最大加速', power: '出力', aim: '瞄準', evasion: '迴避', parts: '部位', dial: '機動盤', builtIn: '內建武裝', skill: '技術',
  maxStress: '壓力上限', recovery: '壓力恢復', abilities: '能力',
};
const short = (v: unknown) => {
  if (v === undefined) return '（無）';
  const s = JSON.stringify(v);
  return s.length > 36 ? `${s.slice(0, 34)}…` : s;
};
function diffLines(before: unknown, after: unknown): string[] {
  if (before === undefined) return ['新增的項目'];
  if (same(before, after)) return [];
  if (typeof before === 'object' && !Array.isArray(before) && before && after && typeof after === 'object') {
    const a = before as Obj;
    const b = after as Obj;
    const plain = (x: unknown): x is Obj => typeof x === 'object' && x !== null && !Array.isArray(x);
    const out: string[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (same(a[k], b[k])) continue;
      const name = FIELD_NAMES[k] ?? k;
      const x = a[k];
      const y = b[k];
      // 距離帶修正、部位這類一層的子物件，逐項列出
      if (plain(x) && plain(y)) {
        for (const sub of new Set([...Object.keys(x), ...Object.keys(y)]))
          if (!same(x[sub], y[sub])) out.push(`${name} ${BODY_PART_NAMES[sub] ?? sub}：${short(x[sub])} → ${short(y[sub])}`);
      } else out.push(`${name}：${short(x)} → ${short(y)}`);
    }
    return out;
  }
  return ['內容有修改'];
}

function hitPreview(e: EquipDef) {
  const ch = draft.chassis['X-00'] ?? Object.values(draft.chassis)[0];
  const pl = draft.pilots.veteran ?? Object.values(draft.pilots)[0];
  if (!ch || !pl) return h('div', { class: 'muted' }, '需要至少一個機型和駕駛才能試算');
  const rel = (r: number) => C.RELATIVE_SPEED_HIT.find(([max]) => r <= max)![1];
  const chance = (mod: number, r: number) => Math.max(C.HIT_MIN, Math.min(C.HIT_MAX, C.HIT_BASE + ch.aim + pl.skill * C.HIT_PER_SKILL + mod - ch.evasion - pl.skill * C.EVADE_PER_SKILL + rel(r)));
  const bands: [string, number | undefined][] = [
    ['零距離', e.pointBlank === false ? undefined : C.ZERO_RANGE_BONUS],
    ['近 R1', e.ranges?.[1]],
    ['中 R2', e.ranges?.[2]],
    ['遠 R3', e.ranges?.[3]],
  ];
  const speeds = [1, 3, 5];
  const per = (e.shots ?? 1) * (e.damage ?? 0);
  return h('div', {},
    h('div', { class: 'muted' }, `${pl.name}駕駛 ${ch.name} 對打同樣的機體；欄位是雙方相對速度`),
    h('table', {},
      h('tr', {}, h('th', {}, '距離'), ...speeds.map((s) => h('th', {}, `相對 ${s}`)), h('th', {}, '期望傷害')),
      ...bands.map(([n, mod]) =>
        h('tr', {}, h('td', {}, n), ...speeds.map((s) => h('td', {}, mod === undefined ? '—' : `${chance(mod, s)}%`)), h('td', {}, mod === undefined ? '—' : (per * chance(mod, 3) / 100).toFixed(1))),
      ),
    ),
    h('div', { class: 'muted' }, `期望傷害以相對速度 3 計，每次攻擊 ${e.shots ?? 1} 發 × ${e.damage ?? 0}；未計正面外、掩蔽、盾牌。`),
  );
}

function chassisPreview(c: ChassisDef) {
  const parts = Object.fromEntries(chassisParts(c).map((p) => [p.id, { ...p, kind: 'body', damage: 0, destroyed: false }]));
  const svg = mechSilhouette({ label: esc(c.name), parts, equipment: [] } as unknown as UnitView).replace('width="64" height="60"', 'width="120" height="112"');
  const speeds = c.dial.map((m) => m.split('-')).filter(([k]) => k !== 'reverse' && k !== 'rbank').map(([, , s]) => Number(s));
  const back = c.dial.filter((m) => m.startsWith('reverse') || m.startsWith('rbank')).length;
  const total = Object.values(c.parts).reduce((s, p) => s + p.durability, 0);
  const radius = c.radius ?? C.BASE_RADIUS;
  const wrap = h('div', {});
  wrap.innerHTML = svg;
  return h('div', {},
    wrap,
    h('div', {}, `最快前進 ${Math.max(0, ...speeds)}、${back ? `後退機動 ${back} 種` : '不能後退'}${c.dial.some((m) => m.startsWith('kturn')) ? '、可急停反轉' : ''}`),
    h('div', {}, `機體總耐久 ${total}（武器另計）`),
    h('div', {}, `底座半徑 ${radius}${c.minSpeed ? `、最低速度 ${c.minSpeed}` : ''}${c.closeCombat === false ? '、不能近身戰鬥' : ''}`),
    h('div', {}, `內建：${c.builtIn?.length ? c.builtIn.map((b) => draft.equipment[b.defId]?.name ?? b.defId).join('、') : '無'}`),
  );
}

function usage(k: Kind, id: string): string[] {
  const out: string[] = [];
  const sides = draft.rosters.map((side, s) => side.map((u, i) => ({ u, tag: `${SIDES[s]}${i + 1}` }))).flat();
  if (k === 'equipment') {
    for (const c of Object.values(draft.chassis)) if (c.builtIn?.some((b) => b.defId === id)) out.push(`${c.name} 的內建武裝`);
    for (const [c, sets] of Object.entries(draft.loadouts)) {
      const n = sets.map((g, i) => (g.some(([d]) => d === id) ? i + 1 : 0)).filter(Boolean);
      if (n.length) out.push(`配裝 ${draft.chassis[c]?.name ?? c} 第 ${n.join('、')} 套`);
    }
    const r = sides.filter(({ u }) => u.equipment.some(([d]) => d === id)).map((x) => x.tag);
    if (r.length) out.push(`預設陣容 ${r.join('、')}`);
  } else if (k === 'chassis') {
    if (draft.loadouts[id]) out.push(`配裝 ${draft.loadouts[id].length} 套`);
    const r = sides.filter(({ u }) => u.chassis === id).map((x) => x.tag);
    if (r.length) out.push(`預設陣容 ${r.join('、')}`);
  } else if (k === 'pilots') {
    const r = sides.filter(({ u }) => u.pilot === id).map((x) => x.tag);
    if (r.length) out.push(`預設陣容 ${r.join('、')}`);
  }
  return out;
}

function renderSide() {
  const box = $('side');
  if (!sel || getItem(draft, kind, sel) === undefined) return box.replaceChildren();
  const id = sel;
  const v = getItem(draft, kind, id);
  const mine = itemErrors(kind, id);
  const others = errors.length - mine.length;
  const out: Child[] = [
    sec('檢查',
      mine.length ? h('ul', { class: 'err' }, ...mine.map((e) => h('li', {}, e.slice(e.indexOf('：') + 1)))) : h('div', { class: 'ok' }, '這筆沒有問題'),
      others > 0 && h('div', { class: 'err', style: 'cursor:pointer', onclick: () => ((showAllErrors = !showAllErrors), renderSide()) }, `其他地方還有 ${others} 個問題 ${showAllErrors ? '▴' : '▾'}`),
      showAllErrors && others > 0 && h('ul', { class: 'err' }, ...errors.filter((e) => !mine.includes(e)).map((e) => h('li', {}, e))),
    ),
  ];
  if (kind === 'equipment') {
    const e = v as EquipDef;
    if (e.kind === 'ranged') out.push(sec('命中試算', hitPreview(e)));
    if (e.kind === 'melee') out.push(sec('近戰', h('div', {}, `命中傷害 ${e.damage ?? 0}；近戰對決額外 ${e.meleeDice ?? 0} 顆骰`)));
  }
  if (kind === 'chassis') out.push(sec('外觀與機動', chassisPreview(v as ChassisDef)));
  if (kind === 'pilots') {
    const p = v as PilotDef;
    out.push(sec('效果', h('div', {}, `命中 +${p.skill * C.HIT_PER_SKILL}、被瞄準時對方命中 −${p.skill * C.EVADE_PER_SKILL}`)));
  }
  if (kind === 'equipment' || kind === 'chassis' || kind === 'pilots') {
    const u = usage(kind, id);
    out.push(sec('被使用於', u.length ? h('ul', {}, ...u.map((x) => h('li', {}, x))) : h('div', { class: 'muted' }, '沒有地方用到')));
  }
  const before = getItem(pub, kind, id);
  const d = diffLines(before, v);
  out.push(sec('和線上版比較',
    d.length ? h('div', { class: 'diff warn' }, ...d.map((x) => h('div', {}, x))) : h('div', { class: 'muted' }, pub ? '沒有修改' : '還沒有發佈過'),
    d.length > 0 && canEdit() && h('button', {
      class: 'small',
      style: 'margin-top:6px',
      onclick: () => {
        if (before === undefined) {
          delItem(draft, kind, id);
          errors = validateContent(draft);
          void runSave(kind, id);
          sel = ids(draft, kind)[0] ?? null;
          renderAll();
        } else {
          setItem(draft, kind, id, clone(before));
          changed(true);
        }
      },
    }, before === undefined ? '捨棄這筆新增' : '還原成線上版'),
  ));
  box.replaceChildren(...nodes(out));
}

// ---------- 啟動 ----------

function renderAll() {
  renderPills();
  renderTabs();
  renderList();
  renderListActions();
  renderForm();
  renderSide();
}

async function boot() {
  setSave('讀取中…');
  try {
    const [d, latest] = await Promise.all([
      api<{ pack: ContentPack }>('GET', '/draft'),
      api<ContentPack>('GET', '/packs/latest').catch(() => null),
    ]);
    draft = d.pack;
    pub = latest;
    errors = validateContent(draft);
    setSave('');
  } catch (e) {
    setSave(`連不上內容 API：${(e as Error).message}`, true);
  }
  const [k, id] = location.hash.slice(1).split('/');
  if (KINDS.some((x) => x.id === k)) kind = k as Kind;
  sel = id && getItem(draft, kind, decodeURIComponent(id)) !== undefined ? decodeURIComponent(id) : (ids(draft, kind)[0] ?? null);
  renderAll();
}
window.addEventListener('hashchange', () => {
  const [k, id] = location.hash.slice(1).split('/');
  if (!KINDS.some((x) => x.id === k) || !id) return;
  const target = decodeURIComponent(id);
  if (k === kind && target === sel) return;
  if (getItem(draft, k as Kind, target) === undefined) return;
  kind = k as Kind;
  sel = target;
  jsonMode = false;
  renderAll();
});
void boot();
