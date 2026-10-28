// 文字座位：用純文字坐進連線房間的一個席位（給 Claude 這類讀文字的玩家用）。
// 用法：npm run seat -- [房間] [席位 0/1，分小隊時 0-1、1-2 這類]
//   輪到這一席下指令時，把這一方看得到的局面寫到 logs/seat/<房間>-<席位>/view.txt（原始資料在 view.json），並在標準輸出印一行 YOUR_TURN。
//   把要送的指令（和網頁送的一樣的 ClientMessage JSON）寫到同一個資料夾的 orders.json，送出後改名成 sent-<時間>.json。
//   結算結果附加到 events.txt，伺服器回的錯誤印 ERROR。
// 只讀伺服器給這一席的視角（戰爭迷霧和網頁一樣），不會看到對手的駕駛、壓力或指令。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';
import {
  CHASSIS,
  EQUIPMENT,
  LOADOUTS,
  PILOTS,
  SCALES,
  entryCost,
  ecmOf,
  jammed,
  bandName,
  bitsLeft,
  buildPath,
  config,
  contentVersion,
  controlPoints,
  supplyPoint,
  forecastMoves,
  type MovePlan,
  buildingHitChance,
  topHp,
  levelHp,
  BUILDING_TYPE_MULT,
  inFootprint,
  deployZone,
  dialOf,
  goalZone,
  grappleOptions,
  hitChance,
  lineOfFire,
  exposed,
  coverOf,
  coverParts,
  flightFire,
  screenLaunchers,
  type CoverInfo,
  wallPenetration,
  climbBlocked,
  climbLimits,
  ARMOR_NAMES,
  DAMAGE_TYPE_NAMES,
  matchupText,
  indirectFire,
  barrierBetween,
  lungeCheck,
  heightAdvantage,
  parseManeuver,
  planCost,
  psycommuOf,
  radiusOf,
  readyRanged,
  relativeSpeed,
  useContent,
  worldPose,
  canSee,
  coveringShield,
  relativeAngle,
  sensorRange,
  tailing,
  barragePenalty,
  barrageStrength,
  barrageActive,
  isShip,
  type ContentPack,
  type GameEvent,
  type PlayerView,
  type ServerMessage,
  type UnitState,
  type UnitView,
  type Vec,
} from '@mech/rules';

const [room = 'claude', seatArg = '1'] = process.argv.slice(2);
/** 席位名稱（0、1、0-1…）與所屬的一方 */
const seatName = /^[01](-\d{1,2})?$/.test(seatArg) ? seatArg.replace(/-0$/, '') : '1';
const seat = seatName.startsWith('0') ? 0 : 1;
const seatSquad = Number(seatName.split('-')[1] ?? 0);
const PORT = Number(process.env.MECH_SERVER_PORT ?? 8787);
/** 對戰伺服器：預設本機；MECH_SERVER=wss://mech-wing-api.darkbearlab.workers.dev 連線上房間 */
const SERVER = (process.env.MECH_SERVER ?? `ws://localhost:${PORT}`).replace(/\/$/, '');
const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), 'logs', 'seat', `${room}-${seatName}`);
mkdirSync(dir, { recursive: true });

try {
  // 和本機伺服器一樣：預設原創內建資料，PACK=latest 抓線上版，PACK=檔案路徑讀檔
  const src = process.env.PACK;
  if (src) useContent((src === 'latest' ? await (await fetch(`${API}/packs/latest`)).json() : JSON.parse(readFileSync(src, 'utf-8'))) as ContentPack);
} catch (e) {
  console.warn('資料包讀取失敗，改用內建資料', e);
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
/** 角度（度），換算到 −180–180 */
const deg = (r: number) => {
  const d = Math.round((r * 180) / Math.PI) % 360;
  return d > 180 ? d - 360 : d <= -180 ? d + 360 : d;
};
const pt = (p: Vec) => `(${f1(p.x)},${f1(p.y)})`;
const side = (p: number) => (p === 0 ? 'A' : 'B');

let view: PlayerView | null = null;
let lastPrompt = '';
/** 第幾次提示（給 seat-wait 判斷有沒有新的一步） */
let prompts = 0;
/** 印出提示，同時記到 prompt.json */
function prompt(line: string) {
  prompts++;
  writeFileSync(resolve(dir, 'prompt.json'), JSON.stringify({ n: prompts, line, at: Date.now() }));
  console.log(line);
}
const labels = new Map<string, string>();
const L = (id: string) => labels.get(id) ?? id;

function partsText(u: UnitView): string {
  return Object.values(u.parts)
    .map((p) => `${p.name}${p.destroyed ? '✕' : `${p.durability - p.damage}/${p.durability}${exposed(p) ? '（外露）' : ''}`}`)
    .join(' ');
}

function gearText(u: UnitView): string {
  return u.equipment
    .map((e) => {
      const d = EQUIPMENT[e.defId];
      const ps = psycommuOf(e);
      const bits = ps ? `${ps.wired ? '' : ` ${bitsLeft(e)}支`}${e.pod ? ` 放出@${pt(e.pod.pos)}${e.pod.charge !== undefined ? ` 能量${e.pod.charge}` : ''}` : (e.readyTurn ?? 0) > (view?.state.turn ?? 0) ? ` 充能到T${e.readyTurn}` : ''}` : '';
      const broken = !!u.parts[e.id]?.destroyed || (!!e.host && !!u.parts[e.host]?.destroyed);
      return `[${e.id}]${d.name}@${e.location}${broken ? '（已損壞）' : e.ammo !== undefined ? ` 彈${e.ammo}` : ''}${bits}`;
    })
    .join('；');
}

function unitLine(u: UnitView): string {
  const ch = CHASSIS[u.chassisId];
  const p = u.pilotId ? PILOTS[u.pilotId] : undefined;
  const status = u.status !== 'active' ? ` 【${u.status}】` : u.hidden ? ` 【看不到，最後目擊 T${u.seenTurn}】` : u.unknown ? ' 【煙霧中不明】' : '';
  let s = `${u.id} ${u.label} ${ch?.name ?? ''}${ch?.armorType ? `・${ARMOR_NAMES[ch.armorType]}` : ''}${status}\n  位置 ${pt(u.pos)}${u.z ? ((ch?.minSpeed ?? 0) > 0 ? ` 飛行高度${u.z}層` : ` 高度${u.z}層（樓頂）`) : ''}${u.equipment.some((e) => e.deployed) ? ' 盾牆展開中' : ''}${u.mark ? ` 被標定${u.mark.by ? `（${u.mark.by} 照射中）` : ''}` : ''} 朝 ${deg(u.facing)}° 動能 ${u.momentum} 半徑 ${radiusOf(u)}`;
  if (p) s += `\n  駕駛 ${p.name} 技能${p.skill}${p.abilities.length ? ` [${p.abilities.join(',')}]` : ''} 壓力 ${u.stress}/${u.maxStress}${u.blackout ? ' 黑視' : ''} 推進劑 ${u.propellant}/${u.maxPropellant}${u.lockOn ? ` 鎖定 ${u.lockOn}` : ''}`;
  else if (u.vague) s += `  （${u.vague}）`;
  s += `\n  部位 ${partsText(u)}\n  裝備 ${gearText(u)}`;
  return s;
}

/** 移動步驟：每個機動的終點與代價 */
function maneuverTable(u: UnitView): string {
  const rows: string[] = [];
  for (const id of dialOf(u as unknown as UnitState)) {
    const c = planCost(u as unknown as UnitState, { maneuver: id, limiter: false });
    if (c.blocked) continue;
    const path = buildPath(u as unknown as UnitState, { maneuver: id, limiter: false });
    const end = worldPose(path, 1);
    // 路徑上會不會撞到大隕石、建築（只看自己，不含其他機體；和實際移動用同一個判斷）
    const w = forecastMoves([u], { [u.id]: { maneuver: id, stance: 'shoot', facingOffset: 0, limiter: false } }, view!.state.obstacles)[0];
    const hit = w?.kind === 'rock';
    const wall = w?.kind === 'wall' ? view!.state.obstacles.find((o) => o.id === w.with) : undefined;
    const canClimb = wall && !climbBlocked(u as unknown as UnitState, { maneuver: id }) && wall.levels! - (u.z ?? 0) <= climbLimits(u as unknown as UnitState).levels;
    const out = end.pos.x < 0 || end.pos.y < 0 || end.pos.x > config.MAP_SIZE || end.pos.y > config.MAP_SIZE;
    rows.push(`${id}→${pt(end.pos)}${out ? ' ⚠開出地圖（脫離戰場）' : ''}∠${deg(end.facing)} v${parseManeuver(id).endMomentum}${c.propellant ? ` 推${c.propellant}` : ''}${c.stress ? ` 壓${c.stress}` : ''}${hit ? ' ⚠撞隕石' : ''}${wall ? ` ⚠撞${wall.id}(${wall.levels}層)${canClimb ? '，攀升可上樓頂' : ''}` : ''}`);
  }
  return `    ${rows.join('；')}`;
}

/** 射擊的提示：對方的盾擋不擋得到、射擊線、自己是不是正面射界外開火 */
function shotTags(u: UnitView, from: Vec, t: UnitView, cover: CoverInfo, arc: number | undefined, indirect = false, flight = false): string {
  const tags: string[] = [];
  if (u.blackout && !indirect) tags.push(`黑視中 −${config.BLACKOUT_SHOT_PENALTY}`);
  if (view!.state.stance[u.id] === 'melee') tags.push(`自己是近戰姿態 −${config.MELEE_STANCE_SHOT_PENALTY}`);
  // 曲射、越頂：掩護、高低差、射界、盾牌都沒有作用
  if (indirect) return `（曲射越頂：不吃掩護與高低差、盾擋不到、打中照頂部攻擊表${t.mark ? '・已標定' : ''}・下回合移動結束後才落下，那時標定失效就落空）`;
  if (coveringShield({ ...t, facing: t.facing } as unknown as UnitState, from)) tags.push('對方盾弧內（可能被盾擋）');
  else if (t.equipment.some((e) => EQUIPMENT[e.defId]?.kind === 'shield')) tags.push('盾弧外');
  const bp = isShip(u) ? 0 : barragePenalty(view!.state.units as never, t as never);
  if (bp) tags.push(`目標在防禦彈幕裡 −${bp}`);
  for (const c of coverParts(cover)) tags.push(`${c.label} −${c.penalty}`);
  if (flight) tags.push(`下回合移動結束後才命中：那回合自己要速度 ${config.ATGM_GUIDE_MAX_SPEED} 以下、目標留在正面射界、看得到（沒隔著煙霧），不然落空`);
  const high = from === u.pos ? heightAdvantage(u, t) : 0;
  if (high) tags.push(`高打低 +${high * config.HIGH_GROUND_HIT}${high >= config.HIGH_GROUND_DAMAGE_FROM ? `、每發傷害 +${config.HIGH_GROUND_DAMAGE_PCT * 100}%` : ''}`);
  if (t.mark) tags.push('已標定');
  if (arc === undefined && relativeAngle({ pos: from, facing: u.facing }, t.pos) > (config.OFF_FRONT_DEG * Math.PI) / 180) tags.push(`我方正面射界外 −${config.OFF_FRONT_PENALTY}`);
  return tags.length ? `（${tags.join('・')}）` : '';
}

/** 我方這台現在被哪些敵機看到、在誰的正面射界、被誰咬住背後（追擊） */
function threatLine(u: UnitView, foes: UnitView[]): string {
  const live = foes.filter((e) => e.status === 'active' && !e.hidden);
  const sees = live.filter((e) => canSee(view!.state.obstacles, e.pos, sensorRange(e), u.pos, radiusOf(e) + radiusOf(u), e.z, u.z)).map((e) => e.id);
  const front = live.filter((e) => relativeAngle(e, u.pos) <= (config.OFF_FRONT_DEG * Math.PI) / 180).map((e) => e.id);
  const tail = live.filter((e) => tailing(e, u)).map((e) => e.id);
  return `  威脅：看得到我 [${sees.join(',') || '無'}]　我在其正面射界 [${front.join(',') || '無'}]　咬住我背後（可追擊）[${tail.join(',') || '無'}]`;
}

/** 行動步驟：每件能開火的武器對每台看得到的敵機的估計命中率 */
/** 有敵機站在樓頂的建築：各武器打那棟的命中率與每發拆掉的耐久 */
function perchTable(u: UnitView, enemies: UnitView[]): string {
  const rows: string[] = [];
  for (const o of view!.state.obstacles.filter((x) => x.kind === 'building' && x.levels && enemies.some((t) => t.z && inFootprint(x, t.pos))))
    for (const w of readyRanged(u)) {
      const def = EQUIPMENT[w.defId];
      if (w.ammo !== undefined && w.ammo <= 0) continue;
      const h = buildingHitChance(u, PILOTS[u.pilotId!].skill, def, o, view!.state.obstacles, CHASSIS[u.chassisId].aim, view!.state.stance[u.id] === 'melee');
      if (h) rows.push(`    ${w.id} ${def.name} → 建築 ${o.id}（${o.levels}層，頂層 ${topHp(o)}/${levelHp(o)}）：約 ${h.chance}%，每發 ${Math.round((def.damage ?? 0) * BUILDING_TYPE_MULT[def.damageType ?? 'kinetic'])} 點`);
    }
  return rows.length ? `\n  拆樓（敵機站在樓頂的建築）：\n${rows.join('\n')}` : '';
}

function shotTable(u: UnitView, enemies: UnitView[]): string {
  const rows: string[] = [];
  for (const w of readyRanged(u)) {
    const def = EQUIPMENT[w.defId];
    for (const t of enemies) {
      const wall = barrierBetween(view!.state.units as never[] as (UnitView & { status: string })[], u.id, u.pos, u.z, t.pos);
      const cover = { ...coverOf(view!.state.obstacles, u.pos, t.pos, u.z, t.z), barrier: !!wall && !indirectFire(def) };
      const h = hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view!.state.velocity, u.id, t.id), shooterMelee: view!.state.stance[u.id] === 'melee', cover, barrage: isShip(u) ? 0 : barragePenalty(view!.state.units as never, t as never) });
      // 打不到的不列（太多了）；彈藥用完的標出來
      if (!h) continue;
      const vs = matchupText(CHASSIS[t.chassisId]?.armorType, def.damageType ?? 'kinetic');
      rows.push(`${w.id} ${def.name} → ${t.id}：${w.ammo === 0 ? '彈藥耗盡' : `${bandName(h.band)} 約 ${h.chance}%${shotTags(u, u.pos, t, cover, def.arc, indirectFire(def), flightFire(def) && !indirectFire(def))}${vs ? `【${vs}】` : ''}`}`);
    }
  }
  // 突進／跳劈：砍得到的才列
  for (const t of enemies) {
    const r = lungeCheck(view!.state.obstacles, u as unknown as UnitState, t as unknown as UnitState, view!.state.stance[u.id]);
    if (typeof r !== 'string') rows.push(`lunge → ${t.id}：${r.jump ? `跳劈（落差 ${r.jump} 層，傷害 +${Math.min(r.jump, config.JUMP_SLASH_MAX_BONUS)}，對方不能反擊）` : '突進，砍得到'}`);
  }
  // 放出去的炮群：從炮群的位置算（炮群本身當作不動）
  for (const e of u.equipment) {
    if (!e.pod) continue;
    const def = EQUIPMENT[e.defId];
    const at = e.pod.pos;
    for (const t of enemies) {
      const cover = coverOf(view!.state.obstacles, at, t.pos);
      const h = hitChance({ attacker: { ...u, pos: at, facing: Math.atan2(t.pos.y - at.y, t.pos.x - at.x) }, attackerSkill: PILOTS[u.pilotId!].skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed({ ...view!.state.velocity, [u.id]: { x: 0, y: 0 } }, u.id, t.id), shooterMelee: false, cover });
      rows.push(`${e.id} 炮群@${pt(at)} → ${t.id}：${h ? `${bandName(h.band)} 約 ${h.chance}%（每支 ${def.shots ?? 1} 發）${shotTags(u, at, t, cover, 0)}` : '打不到'}`);
    }
  }
  return rows.map((r) => `    ${r}`).join('\n');
}

function render(v: PlayerView): string {
  const s = v.state;
  // 分小隊時只列自己小隊的機體，隊友另外列
  const mine = s.units.filter((u) => u.owner === v.you && (v.squad === undefined || (u.squad ?? 0) === v.squad));
  const mates = s.units.filter((u) => u.owner === v.you && !mine.includes(u));
  const foes = s.units.filter((u) => u.owner !== v.you);
  const seen = foes.filter((u) => u.status === 'active' && !u.hidden);
  for (const u of s.units) labels.set(u.id, u.label);
  const set = s.settings;
  const out: string[] = [];
  out.push(`資料 ${contentVersion()}　房間 ${room}　你是 ${side(v.you)} 方${v.squad !== undefined ? `第 ${v.squad} 小隊（席位 ${seatName}）` : ''}　第 ${s.turn} 回合　步驟 ${v.phase}　已送出 A:${v.submitted[0]} B:${v.submitted[1]}${v.squads ? `　我方各小隊 ${Object.entries(v.squads).map(([k, x]) => `${k}:${x}`).join(' ')}` : ''}`);
  out.push(`環境 ${set.environment ?? 'space'}　地形 ${set.terrain ?? '-'}　勝利條件 ${JSON.stringify({ killScore: set.killScore, decap: set.decapitation, goal: set.goal, control: set.control, turnLimit: set.turnLimit })}　擊墜分 A ${s.score[0]} / B ${s.score[1]}　旗艦 ${s.flagship.join(' / ')}`);
  out.push(`地圖 ${config.MAP_SIZE}×${config.MAP_SIZE}，y 往 B 方增加；朝向 0° = +x、90° = +y。距離帶 R1≤${config.RANGE_LIMITS.r1} R2≤${config.RANGE_LIMITS.r2} R3≤${config.RANGE_LIMITS.r3} R4≤${config.RANGE_LIMITS.r4}（底板邊緣距離；R4 只有戰艦主砲）`);
  if (set.goal) out.push(`達陣點 A 要去 ${pt(goalZone(1))}、B 要去 ${pt(goalZone(0))}`);
  if (set.control) out.push(`據點 ${controlPoints().map(pt).join(' ')}`);
  if (set.supply) out.push(`補給點（半徑 ${config.SUPPLY_RADIUS}，停在自己的上面、動能 0，用 {"type":"resupply"} 補滿彈藥、道具與推進劑）A ${pt(supplyPoint(0))}、B ${pt(supplyPoint(1))}`);
  out.push(`障礙 ${s.obstacles.filter((o) => o.kind !== 'building').map((o) => `${o.kind}${pt(o)}r${f1(o.r)}${o.until ? `到T${o.until}` : ''}`).join(' ') || '無'}`);
  const blds = s.obstacles.filter((o) => o.kind === 'building');
  if (blds.length) out.push(`建築（id 中心 x範圍×y範圍 層數；1 層約一台機體高，擋移動、射擊與視線，樓頂可站人；可以把 id 當射擊目標拆樓）${blds.map((o) => `${o.id}${pt(o)} x${f1(o.x - o.hx!)}–${f1(o.x + o.hx!)} y${f1(o.y - o.hy!)}–${f1(o.y + o.hy!)} ${o.levels}層${o.hp !== undefined ? `（頂層耐久 ${o.hp}/${levelHp(o)}）` : ''}`).join('；')}`);
  if (s.balloons.length) out.push(`氣球 ${s.balloons.map((b) => `${side(b.owner)}${pt(b.pos)}`).join(' ')}`);
  if (s.mines.length) out.push(`地雷（我方的，加上我方機體 ${config.MINE_DETECT_RANGE} 格內發現的敵方地雷）${s.mines.map((m) => `${side(m.owner)}${pt(m)}`).join(' ')}`);
  for (const x of s.inbound) {
    const def = EQUIPMENT[x.defId];
    const how = def?.fire === 'atgm' ? `發射端這回合要速度 ${config.ATGM_GUIDE_MAX_SPEED} 以下、目標留在發射端正面 ±${def.arc ?? 180}°、射擊線沒被擋住也沒隔著煙霧（發射端倒下或發射器壞了也一樣），不然落空` : '目標的標定失效（煙幕的金屬粉、電子干擾、超出標定機感測距離）就落空';
    // 上一回合發射的，這回合行動步驟一開始就落下
    const when = x.turn < s.turn ? '這回合行動步驟一開始命中' : '下回合移動結束後命中';
    out.push(x.owner === v.you ? `飛行中（我方發射）：${x.attacker} 的${def?.name ?? x.defId} ×${x.shots} → ${x.target}，${when}；${how}` : `⚠來襲警告：${L(x.attacker)} 的${def?.name ?? x.defId} ×${x.shots} 飛向 ${x.target}，${when}；${how}`);
  }
  const jammers = s.units.filter((u) => ecmOf(u as never) && !u.hidden);
  if (jammers.length) out.push(`電子干擾中（中心距離 ${config.ECM_RADIUS} 格以內，同一方的機體標定不到、也標定不了別人）${jammers.map((u) => `${u.id}${pt(u.pos)}`).join(' ')}`);
  if (s.grapples.length) out.push(`纏鬥中 ${s.grapples.map((g) => `${g.a}↔${g.b}${g.advantage ? ` 優勢${g.advantage}` : ''}`).join(' ')}`);
  if (s.reserves.length) out.push(`我方增援 ${s.reserves.map((r) => `${r.label}@T${r.turn}`).join(' ')}`);
  out.push('\n== 我方 ==');
  for (const u of mine) {
    out.push(unitLine(u));
    if (u.status !== 'active') continue;
    if (u.equipment.some((e) => EQUIPMENT[e.defId].utility === 'mark') && jammed(s.units as never, u as never)) out.push(`  ⚠在我方電子干擾範圍內，標定器現在標定不了（要離開干擾機中心 ${config.ECM_RADIUS} 格以外）`);
    out.push(threatLine(u, foes));
    if (isShip(u)) out.push(`  防禦彈幕：強度 ${barrageStrength(u as never)}${barrageActive(s.units as never, u as never) ? '（生效中）' : ''}；砲塔用 salvo 各自選目標`);
    const grappled = s.grapples.some((g) => g.a === u.id || g.b === u.id);
    if ((v.phase === 'move' || (v.phase === 'ace' && v.aceUnits?.includes(u.id))) && !grappled) {
      const screens = screenLaunchers(u as unknown as UnitState);
      if (screens.length) out.push(`  煙幕：${screens.map((e) => e.id).join('、')} 可用（移動指令加 "smoke":"發射器id"，速度 ${config.SCREEN_MAX_SPEED} 以下；在移動開始的位置放出半徑 ${config.SMOKE_RADIUS} 的煙幕，留到這回合結束；一個發射器一場一次）${s.inbound.some((x) => x.target === u.id) ? '　⚠這台有來襲的彈藥' : ''}`);
      out.push(`  可用機動：\n${maneuverTable(u)}`);
    }
    if (v.phase === 'action') {
      if (s.bumped.includes(u.id)) out.push('  本回合擦撞，不能行動');
      else if (grappled) out.push(`  纏鬥手法可選：${grappleOptions(u as unknown as UnitState).join(', ')}`);
      else out.push(`  估計命中率：\n${shotTable(u, seen) || '    （沒有能打的）'}${perchTable(u, seen)}`);
    }
    if (v.phase === 'pursuit' && v.pursuit?.[u.id]?.length) out.push(`  追擊選項：${v.pursuit[u.id].map((o) => `${o.weapon}→${o.target} ${o.chance}%`).join('；')}`);
  }
  if (v.phase === 'deploy') {
    const z = deployZone(v.you);
    out.push(`\n部署區 x ${z.x0}–${z.x1}、y ${z.y0}–${z.y1}`);
  }
  if (mates.length) {
    out.push('\n== 友軍（其他小隊指揮，你不能下令；視野共用）==');
    for (const u of mates) out.push(`${unitLine(u)}　小隊 ${u.squad ?? 0}`);
  }
  out.push('\n== 敵方 ==');
  for (const u of foes) out.push(unitLine(u));
  for (const p of s.enemyPods ?? []) out.push(`敵方炮群 [${p.id}] ${p.label} 的${p.wired ? `有線臂（${p.part ?? ''}）` : `${EQUIPMENT[p.defId].name} ×${p.bits}`} @${pt(p.pos)}（射擊目標用這個 id）`);
  out.push(`\n指令格式（寫到 ${resolve(dir, 'orders.json')}）：`);
  out.push(
    {
      deploy: `{"t":"deploy","deploy":{"<id>":{"x":..,"y":..,"facingDeg":角度（45 的倍數，-90 是朝 -y）,"momentum":..}}}`,
      move: `{"t":"moves","moves":{"<id>":{"maneuver":"straight-S-2","stance"?:"shoot|melee","facingOffset"?:0（懸停時 0/±45/±90/180，正的是右轉）,"limiter"?:false,"climb"?:true（攀升：速度 ${config.CLIMB_MAX_SPEED} 以下，撞到 ${config.CLIMB_LEVELS} 層以內的牆就爬上樓頂）,"smoke"?:"煙幕彈發射器id"（速度 ${config.SCREEN_MAX_SPEED} 以下；移動開始時在原地放煙幕，留到回合結束）,"defer"?:true,"purge"?:true,"pods"?:{"<裝備id>":{"to":{"x":..,"y":..}}|{"recall":true}}}}}（省略的欄位用預設值）`,
      ace: `{"t":"moves","moves":{"<王牌 id>":{...同上}}}  要下指令的：${(v.aceUnits ?? []).join(', ')}`,
      pursuit: `{"t":"pursuits","pursuits":{"<id>":{"weapon":"..","target":".."}|null}}`,
      action: `{"t":"actions","actions":{"<id>":{"action":{"type":"none"}|{"type":"shoot","weapon":"..","target":"..","also"?:["其他武器id"]（一起開火，全部打同一個目標）}|{"type":"lock","target":".."}|{"type":"deploy","weapon":"展開盾id"}（展開成正面寬 2 格的盾牆，再一次收起；展開中速度 1 以下，快了自動收起）|{"type":"lunge","target":".."}（突進：近戰姿態、手上有近戰武器，正面 ±60°、1.5 格內同高度的敵機；目標比自己低就是跳劈，2 格內、傷害 +落差、對方不能反擊）|{"type":"mark","weapon":"標定器id"}（掃描正面 ±60°、感測距離內的敵機，不用視線，隨機標定 markCount 台；我方看得到它們、命中 +10，持續到超出這台的感測距離；重標會先解除原本的；不暴露位置）|{"type":"smoke"|"decoy","weapon":"..","at":{"x":..,"y":..}}|{"type":"resupply"}（停在自己的補給點上補滿彈藥與推進劑）|{"type":"mine","weapon":"佈雷器id","at":{"x":..,"y":..}}（底板邊緣 ${config.MINE_LAY_RANGE} 格內的地上；對手看不到）|{"type":"barricade","weapon":"路障組id","at":{"x":..,"y":..}}（${config.BARRICADE_RANGE} 格內；1 層高的矮牆，橫擋在自己往 at 的方向上）,"swaps"?:{"right"?:"裝備id|null","left"?:".."}（和同側武器架交換，那一側這回合不能開火）,"grapple"?:"cleave|thrust|entangle|disengage","pods"?:{"<裝備id>":["目標id"]},"salvo"?:{"<砲塔id>":"目標id"}（戰艦：每座砲塔各自開火）}}}`,
      over: '對戰結束',
    }[v.phase as string] ?? '',
  );
  return out.join('\n');
}

function eventText(e: GameEvent): string {
  switch (e.type) {
    case 'shot':
      return `${L(e.attacker)}${e.pod ? '（炮群）' : ''} 以${EQUIPMENT[e.weapon]?.name ?? e.weapon}射擊 ${L(e.target)} ${bandName(e.band)}${e.chance !== undefined ? ` ${e.chance}%` : ''}：${e.hits}/${e.shots} 命中${e.crits ? ` 爆擊${e.crits}` : ''}${e.blocked ? ` 盾擋${e.blocked}` : ''}${e.strays ? ` 誤擊${e.strays}` : ''}`;
    case 'damage':
      return `${L(e.unit)} ${e.part} 受 ${e.amount}${e.exposed ? '（外露）' : e.typed === 'weak' ? '（弱點）' : e.typed === 'resist' ? '（抵抗）' : ''}${e.destroyed ? ' 破壞' : ''}`;
    case 'status':
      return `${L(e.unit)} ${e.status}${e.by ? `（${L(e.by)}）` : ''}`;
    case 'stress':
      return `${L(e.unit)} 壓力 ${e.amount > 0 ? '+' : ''}${e.amount} → ${e.total}（${e.reason}）`;
    case 'move':
      return '';
    case 'actionFail':
      return `${L(e.unit)} 落空：${e.reason}`;
    case 'blast':
      return `${L(e.by)} 的迫擊砲散布，落在 ${pt(e.at)}${e.units.length ? `，炸到 ${e.units.map(L).join('、')}` : ''}`;
    case 'deploy':
      return `${L(e.unit)} ${e.up ? '展開' : '收起'}盾牆`;
    case 'launch':
      return `${L(e.attacker)} 發射${EQUIPMENT[e.weapon]?.name ?? e.weapon} ×${e.shots} → ${L(e.target)}（下回合移動結束後命中）`;
    case 'inboundLost':
      return `${L(e.attacker)} 的${EQUIPMENT[e.weapon]?.name ?? e.weapon}（→ ${L(e.target)}）落空：${e.reason}`;
    case 'smoke':
      return `${e.unit ? L(e.unit) : '看不到的敵機'} 在 ${pt(e.at)} ${e.screen ? '放出煙幕（留到這回合結束）' : '丟出煙霧彈'}`;
    case 'lunge':
      return `${L(e.unit)} ${e.jump ? `從 ${e.jump} 層高跳劈` : '突進'} ${L(e.target)}`;
    case 'mine':
      return `${L(e.unit)} 在 ${pt(e.at)} 埋下地雷`;
    case 'mineBlast':
      return `${L(e.unit)} 在 ${pt(e.at)} 踩到地雷`;
    case 'resupply':
      return `${L(e.unit)} 在補給點補滿彈藥與推進劑`;
    case 'buildingShot':
      return `${e.attacker ? L(e.attacker) : '看不到的敵機'} 以${EQUIPMENT[e.weapon]?.name ?? e.weapon}射擊建築 ${e.obstacle}：${e.hits}/${e.shots} 命中${e.amount ? ` ${e.amount} 點` : ''}${e.chain ? `，連帶塌了 ${e.chain} 層` : ''}${e.collapsed ? '，整棟打平變成瓦礫' : e.amount ? `，剩 ${e.levels} 層` : ''}`;
    case 'barricade':
      return `${L(e.unit)} 架起路障 ${e.obstacle}`;
    case 'mark':
      return `${e.unit ? L(e.unit) : '看不到的敵機'} 標定 ${L(e.target)}（標定方看得到它、命中 +${config.MARK_BONUS}，持續到超出標定機的感測距離）`;
    case 'contact':
      return `接觸 ${L(e.a)}×${L(e.b)} ${e.result} 相對速度 ${e.vc}`;
    case 'grapple':
      return `纏鬥 ${L(e.a)} ${e.choiceA} vs ${L(e.b)} ${e.choiceB}：${e.summary}`;
    case 'gameOver':
      return `對戰結束：${e.winner === 'draw' ? '平手' : `${side(e.winner)} 方勝`}${e.reason ? `（${e.reason}）` : ''}`;
    default:
      return JSON.stringify(e);
  }
}

/** 開房模式：選隊用的目錄（機型、駕駛、配裝與費用）和房主的條件 */
function renderLobby(msg: Extract<ServerMessage, { t: 'lobby' }>): string {
  const out: string[] = [];
  out.push(`房間 ${room}　你是 ${side(seat)} 方${seatSquad ? `第 ${seatSquad} 小隊` : ''}（席位 ${seatName}）　開房模式：還沒開打　已加入 A:${msg.joined[0]} B:${msg.joined[1]}　連線 A:${msg.connected[0]} B:${msg.connected[1]}`);
  if (msg.seats) out.push(`席位 ${msg.seats.map((s) => `${s.key}${s.ai ? '(電腦)' : ''}:${s.joined ? '已加入' : '未加入'}`).join('　')}；一方的費用與台數上限是各小隊加起來算`);
  out.push(msg.terms ? `房主條件：規模 ${msg.terms.scale}（預算 ${SCALES[msg.terms.scale].budget}、最多 ${SCALES[msg.terms.scale].maxUnits} 台）　${JSON.stringify(msg.terms.settings)}` : '房主還沒選條件');
  out.push(`規模：${Object.entries(SCALES).map(([k, s]) => `${k}=${s.budget}分/${s.maxUnits}台`).join('　')}；斬首時旗艦（最貴的那台）至少 15 分；具名駕駛（unique）一隊只能一次`);
  out.push('', '== 機型（id 名稱 費用 環境；下面是可選的配裝）==');
  for (const c of Object.values(CHASSIS)) {
    const sets = LOADOUTS[c.id]?.length ? LOADOUTS[c.id] : [[]];
    out.push(`${c.id} ${c.name} ${c.cost ?? 0} [${(c.envs ?? ['space', 'gravity']).join(',')}]`);
    sets.forEach((g, i) => out.push(`    配裝${i}：${JSON.stringify(g)}（${g.map(([d, loc]) => `${EQUIPMENT[d]?.name ?? d}@${loc}`).join('・') || '只有標準裝備'}；配裝費 +${g.reduce((n, [d]) => n + (EQUIPMENT[d]?.cost ?? 0), 0)}）`));
  }
  out.push('', '== 駕駛（id 名稱 技能 費用 能力）==');
  for (const p of Object.values(PILOTS)) out.push(`${p.id} ${p.name} 技能${p.skill} ${p.cost ?? 0}${p.unique ? ' unique' : ''} [${p.abilities.join(',')}]`);
  out.push('', `一台的費用 = 機型 + 駕駛 + 配裝（例：${(() => { const c = Object.values(CHASSIS)[0]; const e = { chassis: c.id, pilot: 'veteran', equipment: (LOADOUTS[c.id] ?? [[]])[0] ?? [] }; return `${c.id}+veteran+配裝0 = ${entryCost(e)}`; })()}）`);
  out.push('', `指令（寫到 ${resolve(dir, 'orders.json')}）：`);
  out.push(
    seatName === '0'
      ? `{"t":"join","roster":[{"chassis":"..","pilot":"..","equipment":[["裝備id","位置"],...]}],"terms":{"scale":"standard","settings":{"killScore":50,"decapitation":true,"turnLimit":12,"deploy":"fixed","environment":"space","terrain":"asteroid"},"squads"?:[2,2]（每方幾個小隊，各一個席位 0、0-1…；省略是一方一個）,"ai"?:{"1-1":[隊伍]}（交給電腦指揮的小隊和它的隊伍）}}`
      : `{"t":"join","roster":[{"chassis":"..","pilot":"..","equipment":[["裝備id","位置"],...]}]}  （equipment 直接抄配裝選項的 JSON）`,
  );
  return out.join('\n');
}

/** 這一席現在要不要下指令 */
function needsOrders(v: PlayerView): boolean {
  if (v.phase === 'over' || v.submitted[v.you]) return false;
  if (v.phase === 'ace') return !!v.aceUnits?.length;
  if (v.phase === 'pursuit') return !!Object.keys(v.pursuit ?? {}).length;
  return true;
}

/** 送出前整理指令：部署朝向可以用角度（facingDeg），弧度對齊到 45° 的倍數；移動指令省略的欄位補預設值 */
/** 移動指令裡自己機體之間的擦撞預測；沒有就回傳空字串 */
function allyWarnings(msg: any): string {
  if (msg?.t !== 'moves' || msg.force || !view) return '';
  const mine = view.state.units.filter((u) => u.owner === view!.you && u.status === 'active' && !u.hidden && (view!.squad === undefined || (u.squad ?? 0) === view!.squad));
  const plans = msg.moves as Record<string, MovePlan>;
  const seen = new Set<string>();
  return forecastMoves(mine, plans, view.state.obstacles)
    .filter((w) => w.kind === 'ally' && !seen.has([w.unit, w.with].sort().join()) && seen.add([w.unit, w.with].sort().join()))
    .map((w) => `${w.unit} 和 ${w.with} 在移動 ${Math.round(w.t * 100)}% 時碰在 ${pt(w.at)}`)
    .join('；');
}

function normalizeOrders(msg: any): any {
  const snap = (r: number) => Math.round(r / (Math.PI / 4)) * (Math.PI / 4);
  if (msg?.t === 'deploy')
    for (const d of Object.values(msg.deploy ?? {}) as any[]) {
      if (typeof d.facingDeg === 'number') d.facing = (d.facingDeg * Math.PI) / 180;
      delete d.facingDeg;
      if (typeof d.facing === 'number') d.facing = snap(d.facing);
    }
  if (msg?.t === 'moves')
    for (const [id, m] of Object.entries(msg.moves ?? {}) as [string, any][]) msg.moves[id] = { stance: 'shoot', facingOffset: 0, limiter: false, ...m };
  return msg;
}

/** 開場寫一份目錄：機型、武器、駕駛的數值（選隊和對戰時查） */
function writeCatalog() {
  const out: string[] = ['== 機型（id 名稱 費用｜重量級 瞄準 迴避 半徑 環境｜部位 耐久/權重｜機動盤最高速）=='];
  for (const c of Object.values(CHASSIS)) {
    const parts = Object.entries(c.parts).map(([id, p]) => `${p.name}${p.durability}/${p.weight}${p.role === 'core' ? '核心' : ''}`).join(' ');
    const top = Math.max(...c.dial.map((d) => parseManeuver(d).speed));
    out.push(`${c.id} ${c.name} ${c.cost ?? 0}｜${c.armorType ? ARMOR_NAMES[c.armorType] : '無裝甲屬性'} 重${c.weightClass} 瞄${c.aim} 迴避${c.evasion} 感測${c.sensorRange ?? config.SENSOR_RANGE} 半徑${c.radius ?? config.BASE_RADIUS} [${(c.envs ?? ['space', 'gravity']).join(',')}]${c.closeCombat === false ? ' 不能近戰' : ''}｜${parts}｜最高速${top}${c.builtIn?.length ? `｜內建 ${c.builtIn.map((b) => EQUIPMENT[b.defId]?.name).join('、')}` : ''}`);
  }
  out.push('', '== 裝備（id 名稱 費用｜傷害×發數 模式｜距離修正 R1/R2/R3｜其他）==');
  for (const e of Object.values(EQUIPMENT)) {
    const r = e.ranges ? `R1 ${e.ranges[1] ?? '—'} R2 ${e.ranges[2] ?? '—'} R3 ${e.ranges[3] ?? '—'} R4 ${e.ranges[4] ?? '—'}` : '';
    const fireText = { mortar: '迫擊砲（曲射越頂、沒中會散布、下回合落下）', vls: '垂直飛彈（越頂、導引、下回合落下）', missile: '平射飛彈（導引、要射擊線）', antiRadiation: '反輻射飛彈（要射擊線）', atgm: '反戰車飛彈（要射擊線、下回合命中、發射端要一直看得到目標）' } as const;
    const extra = [e.fire ? `${fireText[e.fire]}・只能打${e.fire === 'antiRadiation' ? '開著電子干擾的機體' : e.fire === 'atgm' ? '看得到的目標（不用標定）' : '被標定的目標'}` : '', e.utility === 'screen' ? `煙幕彈發射器：移動時放、速度 ${config.SCREEN_MAX_SPEED} 以下、一場一次` : '', e.utility === 'mark' ? `標定器：一次標定 ${e.markCount ?? config.MARK_COUNT} 台` : '', e.utility === 'ecm' ? `電子干擾器：半徑 ${config.ECM_RADIUS} 格` : '', e.utility === 'mine' ? '佈雷器' : '', e.utility === 'barricade' ? '路障組' : '', e.deployable ? '展開盾' : '', e.climbBoost ? `攀升 +${e.climbBoost.levels} 層・速度上限 +${e.climbBoost.speed}` : '', e.arc !== undefined ? `射界±${e.arc}°` : '', e.ammo !== undefined ? `彈${e.ammo}` : '', e.pointBlank === false ? '不能零距離' : '', e.meleeDice ? `近戰骰+${e.meleeDice}` : '', e.psycommu ? `感應武器 ${JSON.stringify(e.psycommu)}` : '', e.tags?.length ? e.tags.join(',') : ''].filter(Boolean).join(' ');
    out.push(`${e.id} ${e.name} ${e.cost ?? 0}｜${e.kind}${e.damage ? ` ${DAMAGE_TYPE_NAMES[e.damageType ?? 'kinetic']} ${e.damage}×${e.shots ?? 1} ${e.mode ?? 'focused'}` : ''}${e.armorType ? ` ${ARMOR_NAMES[e.armorType]}` : ''}｜${r}｜耐久${e.durability}${extra ? ` ${extra}` : ''}`);
  }
  out.push('', '== 駕駛（id 名稱 技能 費用 能力）==');
  for (const p of Object.values(PILOTS)) out.push(`${p.id} ${p.name} 技能${p.skill} 壓力上限${p.maxStress} 恢復${p.recovery} ${p.cost ?? 0}${p.unique ? ' unique' : ''} [${p.abilities.join(',')}]`);
  out.push('', `命中率 = ${config.HIT_BASE} + 機型瞄準 + 自己技能×${config.HIT_PER_SKILL} + 距離修正 − 目標迴避 − 目標駕駛技能×${config.EVADE_PER_SKILL}（技能差超過 ${config.SKILL_GAP_FREE} 每點再 −${config.SKILL_GAP_PENALTY}）＋相對速度修正 ＋鎖定 +${config.LOCK_BONUS} −正面射界外 ${config.OFF_FRONT_PENALTY} −掩體（遮蔽類：煙霧 ${config.SMOKE_SHOT_PENALTY}、隕石群／瓦礫 ${config.FIELD_SHOT_PENALTY}，只取最重的一種；硬掩護類：建築或路障半掩護、盾牆 ${config.BUILDING_COVER_PENALTY}；兩類相加）＋高打低每層 ${config.HIGH_GROUND_HIT}（最多 ${config.HIGH_GROUND_MAX_LEVELS} 層；高 ${config.HIGH_GROUND_DAMAGE_FROM} 層以上每發傷害 +${config.HIGH_GROUND_DAMAGE_PCT * 100}%）＋被標定 +${config.MARK_BONUS} −自己是近戰姿態 ${config.MELEE_STANCE_SHOT_PENALTY} −黑視中 ${config.BLACKOUT_SHOT_PENALTY}；超過 100 的部分是爆擊`);
  out.push(
    '',
    '== 回合流程 ==',
    `每回合依序：①移動（雙方同時暗選、一起結算）→②王牌移動（只有選了擱置的王牌駕駛：看完其他人的移動才動；技能低的一批先動）→③追擊（只有咬住敵機背後的機體才會出現這一步）→④行動（射擊、標定、突進等，每台一個動作）。沒有要下指令的步驟會自動跳過。`,
    `追擊：移動結算後，射擊方在目標背後 ±${config.PURSUIT_ARC_DEG}°、而且自己面向目標 ±${config.PURSUIT_ARC_DEG}°，距離在${['零距離', '近距離', '中距離'][config.PURSUIT_MAX_BAND]}以內，就可以用一件射擊武器多開一槍（不算這回合的動作，行動步驟照常行動）。這是繞到背後的獎勵；腳斷了動不了的機體也能追擊，只要有敵機停在它面前、背對著它。追擊用 {"t":"pursuits","pursuits":{"<id>":{"weapon":"..","target":".."}|null}}，null 是放棄；可以選的會列在 view.txt 的「追擊選項」。最靠後咬住的先結算。`,
    '',
    '== 城市戰的規則 ==',
    `機械外露：機體部位的耐久剩三分之一以下（含）就標「外露」，被打中一律算弱點 +${config.TYPE_MULT * 100}%，不管裝甲與屬性（武器、盾、外掛裝備不算）。`,
    `傷害屬性與裝甲（三角相剋，±${config.TYPE_MULT * 100}%）：複合裝甲擋動能、怕化學能；反射裝甲擋能量、怕動能；陶瓷裝甲擋化學能、怕能量。機體部位照機型的裝甲，盾牌照盾牌的裝甲；武器和其他裝備不剋也不被剋。耐久與傷害的刻度是舊版的 10 倍（基本數值是 10 的倍數；相剋、高打低算完四捨五入，所以會有 8、13、38 這種零頭）。`,
    `命中部位看攻擊方向（照目標的朝向：正面 ±${config.FRONT_ARC_DEG}°、背後 ${config.BACK_ARC_DEG}° 以外、其餘側面）：正面打背包權重 ×${config.HIT_DIRECTION_WEIGHT.front.propulsion}、軀幹 ×${config.HIT_DIRECTION_WEIGHT.front.core}；背後打背包 ×${config.HIT_DIRECTION_WEIGHT.back.propulsion}、頭 ×${config.HIT_DIRECTION_WEIGHT.back.sensor}；側面打靠近的那隻手 ×${config.HIT_DIRECTION_WEIGHT.side.near}、另一隻 ×${config.HIT_DIRECTION_WEIGHT.side.far}、背包 ×${config.HIT_DIRECTION_WEIGHT.side.propulsion}。外掛裝備照掛的部位、手上的武器照那隻手。近戰、撞擊照出手那台的位置；從上方打下來的（迫擊砲、垂直飛彈、跳劈）照頂部攻擊表；樓塌、地雷、墜落不看方向。從正面打過來的傷害 ×${config.FRONT_DAMAGE_MULT}（正面裝甲最厚；從上方打下來的不算），所以繞到側面、背後打比較划算。`,
    `零距離開火（底板邊緣 ${config.RANGE_LIMITS.r0} 格內）：有 ${config.ZERO_RANGE_SELF_DAMAGE}% 機率傷到自己這件武器 ${config.DAMAGE_SCALE} 點（內建武器傷到所在部位）。`,
    `斬首：旗艦是隊上費用最高的那一台（同分取先排的），被擊墜就輸；配陣容時注意別讓又慢又脆的機體變成旗艦。`,
    `視野：感測距離內、視線沒被建築擋住就看得到（全隊共用）；看得到是雙向的。`,
    `攀升：速度 ${config.CLIMB_MAX_SPEED} 以下的機動加 climb:true，撞到「比自己現在站的高度高 ${config.CLIMB_LEVELS} 層以內」的牆就爬上樓頂（在空中，移動結束才落下，跳得過街道），每爬一次推進劑 −${config.CLIMB_PROPELLANT}。錨鉤加層數與速度上限。走出樓頂邊緣會落下（自己走下來不受傷；樓被打塌、跟著掉下來才會受傷）。`,
    `標定（行動 {"type":"mark","weapon":"標定器id"}）：掃描正面 ±${config.MARK_ARC_DEG}°、感測距離內的敵機，不用視線，隨機標定 ${config.MARK_COUNT} 台（不重複已被標定的）。被標定的我方一直看得到、命中 +${config.MARK_BONUS}；超出標定機的感測距離、或標定機的頭部／標定器壞了才解除。再標一次會先解除自己原本標的。不暴露位置；被標定的一方知道自己被標，但不知道是誰。`,
    `行動步驟的結算順序：標定最先（這回合標定、隊友這回合就能用導引武器打），再來是用眩光武器射擊的，其餘照駕駛技能高的先，同分抽籤。順序在前的先打，打倒或打壞了，後面的人可能就打不到了。`,
    `電子干擾器：一直開著（干擾器被打壞或機體退場才停）；干擾機中心到機體中心 ${config.ECM_RADIUS} 格以內（剛好 ${config.ECM_RADIUS} 格也算）同一方的機體（含自己）標定不到，也標定不了別人——所以標定機要離開自己的干擾機 ${config.ECM_RADIUS} 格以外才能標定；已被標定的機體走進範圍，標定就失效。反輻射飛彈只打開著干擾器的機體：要射擊線、看得到，不用標定，命中只看機器、另外 +${config.ARM_HIT_BONUS}，打中就打在干擾器上。`,
    `拆樓：射擊的目標可以填建築 id（明確選它才會打到，流彈不會）。建築不會閃，命中只看射手 +${config.BUILDING_TARGET_BONUS}；導引武器打不了建築，要射擊線。每層耐久 ${config.BUILDING_LEVEL_HP}（路障 ${config.BARRICADE_HP}），傷害倍率化學能 ×${BUILDING_TYPE_MULT.chemical}、動能 ×${BUILDING_TYPE_MULT.kinetic}、能量 ×${BUILDING_TYPE_MULT.energy}；打光一層就少一層，而且下面那層有 ${config.COLLAPSE_CHAIN * 100}% 機率跟著塌（可以一路塌下去）；樓頂上的機體跟著掉下來，每掉一層受 ${config.COLLAPSE_DAMAGE} 點（${config.COLLAPSE_LEGS_SHARE * 100}% 打在腳上）；整棟打平變成瓦礫區（像隕石群：穿過射擊命中下降）。`,
    `重力圈（與水中）裡腳部全壞的機體（地面滑行、會飛的除外）：不能移動也不能轉向，只能原地懸停（hover-S-0、facingOffset 0），動能直接歸零。宇宙裡腳斷了照樣飄得動（只是不能急轉急停）。`,
    `彈藥：射擊武器的彈數以「發」計，每次射擊扣掉真正打出去的發數，剩的不夠一輪就只打剩下的（目錄的「彈N」）。開房勾選補給點時，雙方後方各一個補給點，停在自己的補給點上（動能 0、地面）用掉動作就補滿彈藥、道具與推進劑。`,
    `地雷：佈雷器在底板邊緣 ${config.MINE_LAY_RANGE} 格內的地上埋雷，對手看不到（對方機體 ${config.MINE_DETECT_RANGE} 格內才看得到）；敵方的地面機體移動經過就引爆，${config.MINE_DAMAGE} 點化學能傷害打在腳上（樓頂上、會飛的不會踩到；自己這一方不會觸發）。路障：${config.BARRICADE_RANGE} 格內架一道長 ${config.BARRICADE_HALF_LENGTH * 2}、高 1 層的矮牆，和建築一樣擋移動、射擊與視線。`,
    `飛行時間：迫擊砲、垂直飛彈、反戰車飛彈這回合只是發射（扣彈、暴露位置），下一回合移動結束後、行動步驟一開始才命中。雙方都看得到飛行中的彈藥（被瞄準的一方有來襲警告）。迫擊砲、垂直飛彈從發射的位置算、要目標那時還被標定，不然失去導引落空；反戰車飛彈不用標定，從發射端那時的位置算：發射端要還能操作、發射器沒壞、那回合機動速度 ${config.ATGM_GUIDE_MAX_SPEED} 以下、目標還在發射器的正面射界內、射擊線沒被擋住也沒隔著煙霧，不然落空。命中時照一般射擊算，盾擋得到。`,
    `煙幕彈發射器：移動指令加 "smoke":"發射器id"（速度 ${config.SCREEN_MAX_SPEED} 以下），移動開始時在原地放出半徑 ${config.SMOKE_RADIUS} 的煙幕，留到這回合結束；從移動開始就生效（這回合的追擊、行動都吃得到）。射擊線穿過或目標在裡面命中 −${config.SMOKE_SHOT_PENALTY}（自己從裡面往外打也一樣），隔著煙霧認不出是哪台。煙霧裡有金屬粉：目標在煙裡、或標定機到目標的連線穿過煙霧，標定與鎖定都失效，也標定、鎖定不了；煙裡的機體也標定不了別人。一個發射器一場只能用一次。反輻射飛彈追的是干擾電波，煙擋不住。`,
    `導引武器（迫擊砲、垂直飛彈、飛彈莢艙）：只能打被標定的目標（沒被標定的，看得到也不能打）；命中只看機器：不算射手技能、沒有技能差懲罰、沒有標定加成、黑視不影響；目標駕駛的閃避照算。迫擊砲與垂直飛彈越過建築、不吃掩護與高低差、沒有射界、盾擋不到，打中照頂部攻擊表（腿 ×0.2，頭、軀幹、背包 ×1.5）。迫擊砲沒打中會偏離 ${config.MORTAR_SCATTER_MIN}～${config.MORTAR_SCATTER_MAX} 格落地，落點 ${config.MORTAR_SPLASH_RADIUS} 格內（底板邊緣）的機體不分敵我受 ${config.MORTAR_SPLASH_DAMAGE} 點。垂直飛彈與飛彈莢艙不吃相對速度的命中懲罰；飛彈莢艙要射擊線。`,
    `突進（行動 {"type":"lunge","target":".."}）：近戰姿態、手上有近戰武器；目標在正面 ±${config.LUNGE_ARC_DEG}°、底板邊緣 ${config.LUNGE_RANGE} 格內、同一個高度，中間沒被建築擋住。衝到目標身邊照近戰對決結算（對方可盾擋、閃避、反擊），推進劑 −${config.LUNGE_PROPELLANT}、壓力 +${config.LUNGE_STRESS}。`,
    `跳劈：突進的目標比自己低時；${config.JUMP_SLASH_RANGE} 格內，每落下 1 層傷害 +${config.DAMAGE_SCALE}（最多 +${config.JUMP_SLASH_MAX_BONUS * config.DAMAGE_SCALE}），對方不能反擊，打中照頂部攻擊表；落差 ${config.JUMP_SLASH_LEG_FROM} 層以上自己腿部受 ${config.DAMAGE_SCALE} 點。比自己高的目標要先攀升。`,
    `展開盾（行動 {"type":"deploy","weapon":"展開盾id"}，再一次收起）：正面寬 ${config.BARRIER_WIDTH} 格、高 ${config.BARRIER_LEVELS} 層的盾牆。穿過盾牆的射擊算半掩護 −${config.BUILDING_COVER_PENALTY}，命中一律打在盾上（後面的隊友也受保護）；比盾牆高 ${config.BARRIER_LEVELS} 層以上或曲射越頂的擋不到。展開中只能用速度 ${config.DEPLOYED_MAX_SPEED} 以下的機動，選更快的會自動收起。`,
    `擦撞：移動路線碰到別的機體（包括隊友）就停下，雙方這回合都不能行動。`,
  );
  writeFileSync(resolve(dir, 'catalog.txt'), out.join('\n'));
}
writeCatalog();

let ws: WebSocket;
function connect() {
  ws = new WebSocket(`${SERVER}/ws?room=${encodeURIComponent(room)}&seat=${seatName}`);
  ws.on('open', () => console.log(`CONNECTED room=${room} seat=${seatName} 資料 ${contentVersion()} 資料夾 ${dir}`));
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    if (msg.t === 'lobby') {
      view = null;
      writeFileSync(resolve(dir, 'view.txt'), renderLobby(msg));
      const joined = msg.seats ? !!msg.seats.find((s) => s.key === seatName)?.joined : msg.joined[seat];
      const key = `lobby-${msg.game}-${joined}-${!!msg.terms}`;
      if (!joined && key !== lastPrompt) {
        lastPrompt = key;
        prompt(`YOUR_TURN lobby（選隊加入）${msg.terms ? '' : ' 房主還沒選條件'}`);
      }
    } else if (msg.t === 'state') {
      view = msg.view;
      writeFileSync(resolve(dir, 'view.json'), JSON.stringify(msg.view));
      writeFileSync(resolve(dir, 'view.txt'), render(msg.view));
      // 重開一場也要再提示一次
      const key = `${msg.game ?? 0}-${msg.view.state.turn}-${msg.view.phase}-${msg.view.submitted[seat]}`;
      if (needsOrders(msg.view) && key !== lastPrompt) {
        lastPrompt = key;
        prompt(`YOUR_TURN turn=${msg.view.state.turn} phase=${msg.view.phase}`);
      } else if (msg.view.phase === 'over' && lastPrompt !== key) {
        lastPrompt = key;
        prompt('GAME_OVER');
      }
    } else if (msg.t === 'resolved') {
      const text = msg.events.map(eventText).filter(Boolean).join('\n');
      appendFileSync(resolve(dir, 'events.txt'), `\n--- ${new Date().toISOString()} ---\n${text}\n`);
      console.log(`RESOLVED ${msg.events.length} events`);
    } else if (msg.t === 'error') prompt(`ERROR ${msg.errors.join('；')}`);
  });
  ws.on('close', (code) => {
    // 同一席位有新的連線：讓出來，不要互踢
    if (code === 4000) {
      console.log('REPLACED 這個席位被別的連線接手，文字座位結束');
      process.exit(0);
    }
    console.log('DISCONNECTED，1 秒後重連');
    setTimeout(connect, 1000);
  });
  ws.on('error', () => {});
}
connect();

// 指令檔：出現就送出，然後改名留底
let badText = '';
let badSince = 0;
setInterval(() => {
  const file = resolve(dir, 'orders.json');
  if (!existsSync(file) || ws.readyState !== WebSocket.OPEN) return;
  const text = readFileSync(file, 'utf-8');
  try {
    const msg = normalizeOrders(JSON.parse(text));
    const warn = allyWarnings(msg);
    if (warn) {
      // 會和隊友擦撞：先不送，讓下指令的人確認（加 "force":true 照送）
      renameSync(file, resolve(dir, `held-${Date.now()}.json`));
      prompt(`ERROR 預測會和隊友擦撞，這份指令還沒送出：${warn}。改機動避開；確定要這樣走就在指令加 "force":true 再送一次`);
      return;
    }
    delete msg.force;
    ws.send(JSON.stringify(msg));
    renameSync(file, resolve(dir, `sent-${Date.now()}.json`));
    console.log(`SENT ${msg.t}`);
    badSince = 0;
  } catch (e) {
    // 檔案可能還在寫：內容有變就再等等，同一份內容讀不懂超過 3 秒才當成壞掉
    if (text !== badText) {
      badText = text;
      badSince = Date.now();
      return;
    }
    if (Date.now() - badSince < 3000) return;
    console.log(`ERROR 指令檔讀不懂：${(e as Error).message}`);
    renameSync(file, resolve(dir, `bad-${Date.now()}.json`));
    badText = '';
  }
}, 500);
