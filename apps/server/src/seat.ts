// 文字座位：用純文字坐進連線房間的一個席位（給 Claude 這類讀文字的玩家用）。
// 用法：npm run seat -- [房間] [席位 0/1]
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
  PILOTS,
  bandName,
  bitsLeft,
  buildPath,
  config,
  contentVersion,
  controlPoints,
  deployZone,
  dialOf,
  goalZone,
  grappleOptions,
  hitChance,
  lineOfFire,
  parseManeuver,
  planCost,
  psycommuOf,
  radiusOf,
  readyRanged,
  relativeSpeed,
  useContent,
  worldPose,
  type ContentPack,
  type GameEvent,
  type PlayerView,
  type ServerMessage,
  type UnitState,
  type UnitView,
  type Vec,
} from '@mech/rules';

const [room = 'claude', seatArg = '1'] = process.argv.slice(2);
const seat = seatArg === '0' ? 0 : 1;
const PORT = Number(process.env.MECH_SERVER_PORT ?? 8787);
const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), 'logs', 'seat', `${room}-${seat}`);
mkdirSync(dir, { recursive: true });

try {
  const pack = process.env.PACK ? JSON.parse(readFileSync(process.env.PACK, 'utf-8')) : await (await fetch(`${API}/packs/latest`)).json();
  useContent(pack as ContentPack);
} catch (e) {
  console.warn('資料包讀取失敗，改用內建資料', e);
}

const f1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const deg = (r: number) => Math.round((r * 180) / Math.PI);
const pt = (p: Vec) => `(${f1(p.x)},${f1(p.y)})`;
const side = (p: number) => (p === 0 ? 'A' : 'B');

let view: PlayerView | null = null;
let lastPrompt = '';
const labels = new Map<string, string>();
const L = (id: string) => labels.get(id) ?? id;

function partsText(u: UnitView): string {
  return Object.values(u.parts)
    .map((p) => `${p.name}${p.destroyed ? '✕' : `${p.durability - p.damage}/${p.durability}`}`)
    .join(' ');
}

function gearText(u: UnitView): string {
  return u.equipment
    .map((e) => {
      const d = EQUIPMENT[e.defId];
      const ps = psycommuOf(e);
      const bits = ps ? `${ps.wired ? '' : ` ${bitsLeft(e)}支`}${e.pod ? ` 放出@${pt(e.pod.pos)}${e.pod.charge !== undefined ? ` 能量${e.pod.charge}` : ''}` : (e.readyTurn ?? 0) > (view?.state.turn ?? 0) ? ` 充能到T${e.readyTurn}` : ''}` : '';
      return `[${e.id}]${d.name}@${e.location}${e.ammo !== undefined ? ` 彈${e.ammo}` : ''}${bits}`;
    })
    .join('；');
}

function unitLine(u: UnitView): string {
  const ch = CHASSIS[u.chassisId];
  const p = u.pilotId ? PILOTS[u.pilotId] : undefined;
  const status = u.status !== 'active' ? ` 【${u.status}】` : u.hidden ? ` 【看不到，最後目擊 T${u.seenTurn}】` : u.unknown ? ' 【煙霧中不明】' : '';
  let s = `${u.id} ${u.label} ${ch?.name ?? ''}${status}\n  位置 ${pt(u.pos)} 朝 ${deg(u.facing)}° 動能 ${u.momentum} 半徑 ${radiusOf(u)}`;
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
    const end = worldPose(buildPath(u as unknown as UnitState, { maneuver: id, limiter: false }), 1);
    rows.push(`${id}(${parseManeuver(id).name}) → ${pt(end.pos)} 朝${deg(end.facing)}° 終速${parseManeuver(id).endMomentum} 推-${c.propellant} 壓+${c.stress}`);
  }
  return rows.map((r) => `    ${r}`).join('\n');
}

/** 行動步驟：每件能開火的武器對每台看得到的敵機的估計命中率 */
function shotTable(u: UnitView, enemies: UnitView[]): string {
  const rows: string[] = [];
  for (const w of readyRanged(u)) {
    const def = EQUIPMENT[w.defId];
    for (const t of enemies) {
      const h = hitChance({ attacker: u, attackerSkill: PILOTS[u.pilotId!].skill, weapon: def, target: t, targetSkill: null, relSpeed: relativeSpeed(view!.state.velocity, u.id, t.id), shooterMelee: view!.state.stance[u.id] === 'melee', cover: lineOfFire(view!.state.obstacles, u.pos, t.pos) });
      rows.push(`${w.id} ${def.name} → ${t.id}：${h ? `${bandName(h.band)} 約 ${h.chance}%` : '打不到'}`);
    }
  }
  return rows.map((r) => `    ${r}`).join('\n');
}

function render(v: PlayerView): string {
  const s = v.state;
  const mine = s.units.filter((u) => u.owner === v.you);
  const foes = s.units.filter((u) => u.owner !== v.you);
  const seen = foes.filter((u) => u.status === 'active' && !u.hidden);
  for (const u of s.units) labels.set(u.id, u.label);
  const set = s.settings;
  const out: string[] = [];
  out.push(`資料 ${contentVersion()}　房間 ${room}　你是 ${side(v.you)} 方　第 ${s.turn} 回合　步驟 ${v.phase}　已送出 A:${v.submitted[0]} B:${v.submitted[1]}`);
  out.push(`環境 ${set.environment ?? 'space'}　地形 ${set.terrain ?? '-'}　勝利條件 ${JSON.stringify({ killScore: set.killScore, decap: set.decapitation, goal: set.goal, control: set.control, turnLimit: set.turnLimit })}　擊墜分 A ${s.score[0]} / B ${s.score[1]}　旗艦 ${s.flagship.join(' / ')}`);
  out.push(`地圖 ${config.MAP_SIZE}×${config.MAP_SIZE}，y 往 B 方增加；朝向 0° = +x、90° = +y。距離帶 R1≤${config.RANGE_LIMITS.r1} R2≤${config.RANGE_LIMITS.r2} R3≤${config.RANGE_LIMITS.r3}（底板邊緣距離）`);
  if (set.goal) out.push(`達陣點 A 要去 ${pt(goalZone(1))}、B 要去 ${pt(goalZone(0))}`);
  if (set.control) out.push(`據點 ${controlPoints().map(pt).join(' ')}`);
  out.push(`障礙 ${s.obstacles.map((o) => `${o.kind}${pt(o)}r${f1(o.r)}${o.until ? `到T${o.until}` : ''}`).join(' ') || '無'}`);
  if (s.balloons.length) out.push(`氣球 ${s.balloons.map((b) => `${side(b.owner)}${pt(b.pos)}`).join(' ')}`);
  if (s.grapples.length) out.push(`纏鬥中 ${s.grapples.map((g) => `${g.a}↔${g.b}${g.advantage ? ` 優勢${g.advantage}` : ''}`).join(' ')}`);
  if (s.reserves.length) out.push(`我方增援 ${s.reserves.map((r) => `${r.label}@T${r.turn}`).join(' ')}`);
  out.push('\n== 我方 ==');
  for (const u of mine) {
    out.push(unitLine(u));
    if (u.status !== 'active') continue;
    const grappled = s.grapples.some((g) => g.a === u.id || g.b === u.id);
    if ((v.phase === 'move' || (v.phase === 'ace' && v.aceUnits?.includes(u.id))) && !grappled) out.push(`  可用機動：\n${maneuverTable(u)}`);
    if (v.phase === 'action') {
      if (s.bumped.includes(u.id)) out.push('  本回合擦撞，不能行動');
      else if (grappled) out.push(`  纏鬥手法可選：${grappleOptions(u as unknown as UnitState).join(', ')}`);
      else out.push(`  估計命中率：\n${shotTable(u, seen) || '    （沒有能打的）'}`);
    }
    if (v.phase === 'pursuit' && v.pursuit?.[u.id]?.length) out.push(`  追擊選項：${v.pursuit[u.id].map((o) => `${o.weapon}→${o.target} ${o.chance}%`).join('；')}`);
  }
  if (v.phase === 'deploy') {
    const z = deployZone(v.you);
    out.push(`\n部署區 x ${z.x0}–${z.x1}、y ${z.y0}–${z.y1}`);
  }
  out.push('\n== 敵方 ==');
  for (const u of foes) out.push(unitLine(u));
  out.push(`\n指令格式（寫到 ${resolve(dir, 'orders.json')}）：`);
  out.push(
    {
      deploy: `{"t":"deploy","deploy":{"<id>":{"x":..,"y":..,"facing":弧度,"momentum":..}}}`,
      move: `{"t":"moves","moves":{"<id>":{"maneuver":"straight-S-2","stance":"shoot|melee","facingOffset":0,"limiter":false,"defer"?:true,"purge"?:true,"pods"?:{"<裝備id>":{"to":{"x":..,"y":..}}|{"recall":true}}}}}`,
      ace: `{"t":"moves","moves":{"<王牌 id>":{...同上}}}  要下指令的：${(v.aceUnits ?? []).join(', ')}`,
      pursuit: `{"t":"pursuits","pursuits":{"<id>":{"weapon":"..","target":".."}|null}}`,
      action: `{"t":"actions","actions":{"<id>":{"action":{"type":"none"}|{"type":"shoot","weapon":"..","target":".."}|{"type":"lock","target":".."}|{"type":"smoke"|"decoy","weapon":"..","at":{"x":..,"y":..}},"swap"?:{"hand":"right|left","equip":"..|null"},"grapple"?:"cleave|thrust|entangle|disengage","pods"?:{"<裝備id>":["目標id"]}}}}`,
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
      return `${L(e.unit)} ${e.part} 受 ${e.amount}${e.destroyed ? ' 破壞' : ''}`;
    case 'status':
      return `${L(e.unit)} ${e.status}${e.by ? `（${L(e.by)}）` : ''}`;
    case 'stress':
      return `${L(e.unit)} 壓力 ${e.amount > 0 ? '+' : ''}${e.amount} → ${e.total}（${e.reason}）`;
    case 'move':
      return '';
    case 'actionFail':
      return `${L(e.unit)} 落空：${e.reason}`;
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

/** 這一席現在要不要下指令 */
function needsOrders(v: PlayerView): boolean {
  if (v.phase === 'over' || v.submitted[v.you]) return false;
  if (v.phase === 'ace') return !!v.aceUnits?.length;
  if (v.phase === 'pursuit') return !!Object.keys(v.pursuit ?? {}).length;
  return true;
}

let ws: WebSocket;
function connect() {
  ws = new WebSocket(`ws://localhost:${PORT}/ws?room=${encodeURIComponent(room)}&seat=${seat}`);
  ws.on('open', () => console.log(`CONNECTED room=${room} seat=${seat} 資料 ${contentVersion()} 資料夾 ${dir}`));
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data)) as ServerMessage;
    if (msg.t === 'state') {
      view = msg.view;
      writeFileSync(resolve(dir, 'view.json'), JSON.stringify(msg.view));
      writeFileSync(resolve(dir, 'view.txt'), render(msg.view));
      // 重開一場也要再提示一次
      const key = `${msg.game ?? 0}-${msg.view.state.turn}-${msg.view.phase}-${msg.view.submitted[seat]}`;
      if (needsOrders(msg.view) && key !== lastPrompt) {
        lastPrompt = key;
        console.log(`YOUR_TURN turn=${msg.view.state.turn} phase=${msg.view.phase}`);
      } else if (msg.view.phase === 'over' && lastPrompt !== key) {
        lastPrompt = key;
        console.log('GAME_OVER');
      }
    } else if (msg.t === 'resolved') {
      const text = msg.events.map(eventText).filter(Boolean).join('\n');
      appendFileSync(resolve(dir, 'events.txt'), `\n--- ${new Date().toISOString()} ---\n${text}\n`);
      console.log(`RESOLVED ${msg.events.length} events`);
    } else if (msg.t === 'error') console.log(`ERROR ${msg.errors.join('；')}`);
  });
  ws.on('close', () => {
    console.log('DISCONNECTED，1 秒後重連');
    setTimeout(connect, 1000);
  });
  ws.on('error', () => {});
}
connect();

// 指令檔：出現就送出，然後改名留底
setInterval(() => {
  const file = resolve(dir, 'orders.json');
  if (!existsSync(file) || ws.readyState !== WebSocket.OPEN) return;
  try {
    const msg = JSON.parse(readFileSync(file, 'utf-8'));
    ws.send(JSON.stringify(msg));
    renameSync(file, resolve(dir, `sent-${Date.now()}.json`));
    console.log(`SENT ${msg.t}`);
  } catch (e) {
    console.log(`ERROR 指令檔讀不懂：${(e as Error).message}`);
    renameSync(file, resolve(dir, `bad-${Date.now()}.json`));
  }
}, 500);
