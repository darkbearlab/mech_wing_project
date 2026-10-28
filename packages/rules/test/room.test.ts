import { describe, expect, it } from 'vitest';
import { Room, Rng, aiOrders, pickRosters, replayRecord, DEFAULT_SETTINGS, type BattleRecord, type PlayerView, type ServerMessage } from '../src/index';

/** 假連線：記下收到的訊息 */
function socket() {
  const got: ServerMessage[] = [];
  return { got, ws: { send: (d: string) => got.push(JSON.parse(d)), close: () => {} }, last: () => [...got].reverse().find((m) => m.t === 'state' || m.t === 'lobby')! };
}

/** 人類席位：用電腦的判斷，只送自己小隊的機體 */
function humanOrders(view: PlayerView, rng: Rng) {
  const all = aiOrders(view, rng) as Record<string, unknown>;
  if (view.squad === undefined) return all;
  const mine = new Set(view.state.units.filter((u) => u.owner === view.you && (u.squad ?? 0) === view.squad).map((u) => u.id));
  return Object.fromEntries(Object.entries(all).filter(([id]) => mine.has(id)));
}

const msgFor = (view: PlayerView, orders: Record<string, unknown>) =>
  JSON.stringify(view.phase === 'pursuit' ? { t: 'pursuits', pursuits: orders } : view.phase === 'deploy' ? { t: 'deploy', deploy: orders } : view.phase === 'action' ? { t: 'actions', actions: orders } : { t: 'moves', moves: orders });

/** 人類席位一直下指令到打完 */
function playOut(room: Room, seats: [ReturnType<typeof socket>, { message(t: string): void }][], rng: Rng) {
  for (let i = 0; i < 400 && room.match && room.match.phase !== 'over'; i++) {
    let acted = false;
    for (const [s, conn] of seats) {
      const m = s.last();
      if (m.t !== 'state' || m.view.phase === 'over' || m.view.submitted[m.view.you]) continue;
      conn.message(msgFor(m.view, humanOrders(m.view, rng)));
      acted = true;
    }
    if (!acted) break;
  }
}

describe('房間', () => {
  it('一方一個席位：和以前一樣打得完', () => {
    const room = new Room();
    const a = socket();
    const b = socket();
    const ca = room.connect(a.ws, 0);
    const cb = room.connect(b.ws, '1');
    ca.message(JSON.stringify({ t: 'setup', rosters: pickRosters(3), settings: DEFAULT_SETTINGS }));
    expect((a.last() as Extract<ServerMessage, { t: 'state' }>).view.squad).toBeUndefined();
    playOut(room, [[a, ca], [b, cb]], new Rng(9));
    expect(room.match!.phase).toBe('over');
  }, 30_000);

  it('對戰紀錄：每回合與結束時存下種子、陣容、每一步指令與留言；照紀錄重播結果一樣，結束後的留言會再存一次', () => {
    const saved: BattleRecord[] = [];
    const room = new Room(0, () => {}, (r) => saved.push(r), 'rec-test');
    const a = socket();
    const b = socket();
    const ca = room.connect(a.ws, 0);
    const cb = room.connect(b.ws, '1');
    ca.message(JSON.stringify({ t: 'setup', rosters: pickRosters(5), settings: DEFAULT_SETTINGS }));
    // 第一步帶一段話
    const v = (a.last() as Extract<ServerMessage, { t: 'state' }>).view;
    ca.message(JSON.stringify({ ...JSON.parse(msgFor(v, aiOrders(v, new Rng(3)) as Record<string, unknown>)), note: '先觀察對手' }));
    playOut(room, [[a, ca], [b, cb]], new Rng(9));
    expect(room.match!.phase).toBe('over');
    // 每回合存一次進度，最後一份是結束時的
    expect(saved.length).toBeGreaterThan(1);
    expect(saved.slice(0, -1).every((r) => r.winner === null)).toBe(true);
    const rec = saved.at(-1)!;
    expect(rec.room).toBe('rec-test');
    expect(rec.notes).toEqual([{ seat: 0, turn: 1, phase: v.phase, text: '先觀察對手' }]);
    const r = replayRecord(rec);
    expect(r.errors).toEqual([]);
    expect(r.match.state.winner).toBe(room.match!.state.winner);
    const before = saved.length;
    cb.message(JSON.stringify({ t: 'note', text: '打得不錯' }));
    expect(saved).toHaveLength(before + 1);
    expect(saved.at(-1)!.notes!.at(-1)).toMatchObject({ seat: 1, phase: 'over', text: '打得不錯' });
  }, 30_000);

  it('房間重啟：照存下的進度接著打到結束', () => {
    const saved: { rec: BattleRecord; live: boolean }[] = [];
    const room = new Room(0, () => {}, (rec, live) => saved.push({ rec, live }), 'restore-test');
    const a = socket();
    const b = socket();
    const ca = room.connect(a.ws, 0);
    const cb = room.connect(b.ws, '1');
    ca.message(JSON.stringify({ t: 'setup', rosters: pickRosters(6), settings: DEFAULT_SETTINGS }));
    // 打幾步就「重啟」
    const rng = new Rng(4);
    for (let i = 0; i < 9; i++)
      for (const [s, c] of [[a, ca], [b, cb]] as const) {
        const m = s.last() as Extract<ServerMessage, { t: 'state' }>;
        if (!m.view.submitted[m.view.you]) c.message(msgFor(m.view, aiOrders(m.view, rng) as Record<string, unknown>));
      }
    const live = saved.filter((x) => x.live).at(-1)!.rec;
    expect(live.steps.length).toBeGreaterThan(0);
    const room2 = new Room(0, () => {}, () => {}, 'restore-test');
    expect(room2.restore(live)).toBe(true);
    expect(room2.match!.resolvedCount).toBeGreaterThan(0);
    const a2 = socket();
    const b2 = socket();
    const ca2 = room2.connect(a2.ws, 0);
    const cb2 = room2.connect(b2.ws, '1');
    playOut(room2, [[a2, ca2], [b2, cb2]], new Rng(5));
    expect(room2.match!.phase).toBe('over');
  }, 30_000);

  it('一方分幾個小隊：人指揮自己的小隊，其他小隊交給電腦', () => {
    const room = new Room();
    const a = socket();
    const ca = room.connect(a.ws, '0');
    const rosters = pickRosters(4);
    for (const r of rosters) r.forEach((e, i) => (e.squad = i % 2));
    ca.message(JSON.stringify({ t: 'setup', rosters, settings: DEFAULT_SETTINGS, ai: ['0-1', '1', '1-1'] }));
    const st = a.last() as Extract<ServerMessage, { t: 'state' }>;
    expect(st.view.squad).toBe(0);
    expect(st.seats?.map((s) => [s.key, s.ai])).toEqual([['0', false], ['0-1', true], ['1', true], ['1-1', true]]);
    // 電腦已經替其他三個小隊送出，只等人
    expect(st.view.squads).toEqual({ 0: false, 1: true });
    // 指揮隊友的機體會被擋
    const teammate = st.view.state.units.find((u) => u.owner === 0 && u.squad === 1)!;
    ca.message(JSON.stringify({ t: 'moves', moves: { [teammate.id]: { maneuver: 'hover-S-0', stance: 'shoot', facingOffset: 0, limiter: false } } }));
    expect(a.got.some((m) => m.t === 'error' && m.errors.some((e) => e.includes('不是你指揮的機體')))).toBe(true);
    playOut(room, [[a, ca]], new Rng(9));
    expect(room.match!.phase).toBe('over');
  }, 30_000);

  it('開房：房主定小隊數與電腦小隊，人都加入就開打', () => {
    const room = new Room();
    const host = socket();
    const mate = socket();
    const guest = socket();
    const ch = room.connect(host.ws, '0');
    const cm = room.connect(mate.ws, '0-1');
    const cg = room.connect(guest.ws, '1');
    const [ra, rb] = pickRosters(6);
    const terms = { settings: { ...DEFAULT_SETTINGS, decapitation: false }, scale: 'large', squads: [2, 2], ai: { '1-1': rb.slice(0, 2) } };
    ch.message(JSON.stringify({ t: 'join', roster: ra.slice(0, 2), terms }));
    const lobby = host.last() as Extract<ServerMessage, { t: 'lobby' }>;
    expect(lobby.seats?.map((s) => [s.key, s.joined, s.ai])).toEqual([['0', true, false], ['0-1', false, false], ['1', false, false], ['1-1', true, true]]);
    cm.message(JSON.stringify({ t: 'join', roster: ra.slice(2, 3) }));
    expect(room.match).toBeNull();
    cg.message(JSON.stringify({ t: 'join', roster: rb.slice(2, 3) }));
    expect([host, mate, guest].flatMap((s) => s.got.filter((m) => m.t === 'error'))).toEqual([]);
    expect(room.match).not.toBeNull();
    const units = room.match!.state.units.map((u) => [u.owner, u.squad]);
    expect(units).toEqual([[0, 0], [0, 0], [0, 1], [1, 0], [1, 1], [1, 1]]);
    playOut(room, [[host, ch], [mate, cm], [guest, cg]], new Rng(2));
    expect(room.match!.phase).toBe('over');
  }, 30_000);

  it('開房分小隊：預算與台數平均分，超出這一隊的份就退回；電腦小隊的隊伍不給對手看', () => {
    const room = new Room();
    const host = socket();
    const guest = socket();
    const ch = room.connect(host.ws, '0');
    const cg = room.connect(guest.ws, '1');
    const [r0, rb] = pickRosters(6);
    const ra = [...r0, ...r0];
    // 標準 85 分、6 台分兩隊：每隊 42 分、3 台
    const terms = { settings: { ...DEFAULT_SETTINGS, decapitation: false }, scale: 'standard', squads: [2, 1], ai: { '0-1': ra.slice(3, 4) } };
    ch.message(JSON.stringify({ t: 'join', roster: ra.slice(0, 4), terms }));
    expect(host.got.some((m) => m.t === 'error' && m.errors.some((e) => e.includes('這一隊最多 3 台')))).toBe(true);
    ch.message(JSON.stringify({ t: 'join', roster: ra.slice(0, 1), terms }));
    const lobby = guest.last() as Extract<ServerMessage, { t: 'lobby' }>;
    expect(lobby.terms?.ai).toBeUndefined();
    expect(lobby.mates).toEqual({});
    expect(Object.keys((host.last() as Extract<ServerMessage, { t: 'lobby' }>).mates ?? {})).toEqual(['0-1']);
    cg.message(JSON.stringify({ t: 'join', roster: rb.slice(0, 2) }));
    expect(room.match).not.toBeNull();
  });
});
