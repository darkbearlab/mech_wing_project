// 主選單：自由對戰、重演戰役、機庫編輯器、玩法說明。重演戰役依作品分組，選劇本與扮演哪一方後直接開打。
import { SCENARIOS, scenarioAvailable, type Scenario } from '@mech/rules';

/** 扮演哪一方：0 聯邦（A 方）、1 對手（B 方）、watch 觀戰 */
export type Side = 0 | 1 | 'watch';

export interface MenuActions {
  free(): void;
  scenario(s: Scenario, side: Side): void;
  help(): void;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const SIDE_KEY = 'mech-wing-scenario-side';

function savedSide(id: string): Side {
  try {
    const v = JSON.parse(localStorage.getItem(SIDE_KEY) ?? '{}')[id];
    return v === 0 || v === 1 || v === 'watch' ? v : 0;
  } catch {
    return 0;
  }
}
function saveSide(id: string, side: Side) {
  try {
    const all = JSON.parse(localStorage.getItem(SIDE_KEY) ?? '{}');
    all[id] = side;
    localStorage.setItem(SIDE_KEY, JSON.stringify(all));
  } catch {}
}

/** 顯示主選單 */
export function openMenu(actions: MenuActions): void {
  const box = document.getElementById('menu')!;
  const version = document.getElementById('contentTag')?.textContent ?? '';
  let page: 'main' | 'scenarios' = 'main';
  const sides = new Map(SCENARIOS.map((s) => [s.id, savedSide(s.id)]));

  const render = () => {
    if (page === 'main') {
      box.innerHTML = `<div class="mnBox">
        <h1>機器人戰術對戰</h1><div class="muted small">${esc(version)}</div>
        <div class="mnGrid">
          <button class="mnBig" data-act="free"><b>自由對戰</b><span>出擊準備：自己挑陣容、勝利條件</span></button>
          <button class="mnBig" data-act="scenarios"><b>重演戰役</b><span>照原作設定的劇本</span></button>
          <a class="mnBig" href="editor.html"><b>機庫編輯器</b><span>編輯機型、武器、駕駛</span></a>
          <button class="mnBig" data-act="help"><b>玩法說明</b><span>規則一覽</span></button>
        </div></div>`;
      return;
    }
    const groups = new Map<string, Scenario[]>();
    for (const s of SCENARIOS) groups.set(s.series, [...(groups.get(s.series) ?? []), s]);
    let html = `<div class="mnBox mnWide"><div class="mnHead"><button data-act="back">‹ 主選單</button><b>重演戰役</b></div>`;
    for (const [series, list] of groups) {
      html += `<div class="muted mnSeries">${esc(series)}</div>`;
      for (const s of list) {
        const ok = scenarioAvailable(s);
        const side = sides.get(s.id)!;
        const chip = (v: Side, label: string) => `<button class="chip ${side === v ? 'on' : ''}" data-side="${v}" data-sc="${s.id}">${esc(label)}</button>`;
        html += `<div class="mnSc ${ok ? '' : 'off'}"><div><b>${esc(s.name)}</b><div class="muted small">${esc(s.summary)}</div></div>
          <div class="mnSide"><span class="muted small">你扮演</span>${chip(0, s.sides[0])}${chip(1, s.sides[1])}${chip('watch', '觀戰')}
          <button class="primary" data-start="${s.id}" ${ok ? '' : 'disabled title="目前的資料包缺少這個劇本需要的機體或駕駛"'}>開始 ›</button></div></div>`;
      }
    }
    box.innerHTML = html + '</div>';
  };

  box.onclick = (ev) => {
    const el = (ev.target as HTMLElement).closest('button');
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === 'free' || act === 'help') {
      box.hidden = act === 'free' ? true : box.hidden;
      if (act === 'free') actions.free();
      else actions.help();
      return;
    }
    if (act === 'scenarios' || act === 'back') {
      page = act === 'scenarios' ? 'scenarios' : 'main';
      return render();
    }
    if (el.dataset.side !== undefined) {
      const v = el.dataset.side === 'watch' ? 'watch' : (Number(el.dataset.side) as 0 | 1);
      sides.set(el.dataset.sc!, v);
      saveSide(el.dataset.sc!, v);
      return render();
    }
    const id = el.dataset.start;
    const s = SCENARIOS.find((x) => x.id === id);
    if (s) {
      box.hidden = true;
      actions.scenario(s, sides.get(s.id)!);
    }
  };
  render();
  box.hidden = false;
}
