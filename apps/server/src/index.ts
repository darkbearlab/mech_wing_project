// 本機伺服器：房間邏輯在 @mech/rules 的 Room（線上版是 Cloudflare Durable Object，共用同一份）。
// 開場前讀資料包：預設是原創內建資料；PACK=檔案路徑讀那個檔案，PACK=latest 抓線上最新版（已封存的鋼彈資料）。
// 瀏覽器的出擊準備畫面送 setup 開新的一場。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { WebSocketServer, type WebSocket } from 'ws';
import { Room, contentVersion, useContent, type ContentPack } from '@mech/rules';

const API = process.env.MECH_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
try {
  const src = process.env.PACK;
  if (src) useContent((src === 'latest' ? await (await fetch(`${API}/packs/latest`)).json() : JSON.parse(readFileSync(src, 'utf-8'))) as ContentPack);
} catch (e) {
  console.warn('資料包讀取失敗，改用內建資料', e);
}
console.log(`資料 ${contentVersion()}`);

const PORT = Number(process.env.MECH_SERVER_PORT ?? 8787);
const TURN_SECONDS = Number(process.env.TURN_SECONDS ?? 0); // 0 = 不計時

const rooms = new Map<string, Room>();
const wss = new WebSocketServer({ port: PORT, path: '/ws' });

wss.on('connection', (ws: WebSocket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const roomId = url.searchParams.get('room') || 'test';
  let room = rooms.get(roomId);
  if (!room) {
    // 對戰紀錄存在 logs/battles（同一場結束後又有留言就覆寫同一個檔）
    room = new Room(
      TURN_SECONDS,
      (text) => console.log(`[${roomId}] ${text}`),
      (rec) => {
        mkdirSync('logs/battles', { recursive: true });
        writeFileSync(`logs/battles/${roomId}-${rec.startedAt.replace(/[:.]/g, '-')}.json`, JSON.stringify(rec));
      },
      roomId,
    );
    rooms.set(roomId, room);
  }
  const seatParam = url.searchParams.get('seat');
  const conn = room.connect({ send: (d) => ws.readyState === ws.OPEN && ws.send(d), close: (c, r) => ws.close(c, r) }, seatParam ?? '0');
  ws.on('message', (data) => conn.message(String(data)));
  ws.on('close', () => conn.close());
});

console.log(`mech-wing server on ws://localhost:${PORT}/ws${TURN_SECONDS ? ` (turn timer ${TURN_SECONDS}s)` : ''}`);
