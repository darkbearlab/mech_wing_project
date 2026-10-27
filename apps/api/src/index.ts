// 內容 API：D1 存編輯中的草稿，發佈時打包成不可變的版本放進 KV，客戶端讀 KV。
//   GET    /packs              發佈紀錄
//   GET    /packs/latest       最新發佈的資料包
//   GET    /packs/:version     指定版本的資料包
//   GET    /draft              草稿（組成資料包）與檢查結果
//   GET    /auth               確認管理金鑰（200／401）
//   PUT    /draft/:kind/:id    新增／修改一筆（需管理金鑰）
//   DELETE /draft/:kind/:id    刪除一筆（需管理金鑰）
//   POST   /draft/import       用整個資料包取代草稿（需管理金鑰）
//   POST   /publish            檢查草稿後發佈成新版本（需管理金鑰）；body { note?, bump?: 'patch' | 'minor' | 'major' }
//   POST   /battles            上傳一場對戰紀錄（不用金鑰；只留最近 MAX_BATTLES 場）
//   GET    /battles            對戰紀錄列表（需管理金鑰）；?limit=
//   GET    /battles/:id        一場對戰的完整紀錄（需管理金鑰）
// 版本號是「大.小.修」（例如 0.1.4）；最早的 v1…v5 已改名為 0.1.0…0.1.4
import { MAX_RECORD_BYTES, checkRecord, validateContent, type BattleRecord, type ContentPack } from '@mech/rules';

export interface Env {
  DB: D1Database;
  PACKS: KVNamespace;
  /** 管理金鑰的 SHA-256（十六進位）；金鑰本身只存在管理者手上 */
  ADMIN_TOKEN_SHA256: string;
}

const KINDS = ['equipment', 'chassis', 'pilots', 'loadouts', 'rosters'] as const;
type Kind = (typeof KINDS)[number];
const SIDES = ['A', 'B'];
const MAX_BATTLES = 2000;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...headers } });
const fail = (status: number, error: string, extra: object = {}) => json({ error, ...extra }, status);

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function isAdmin(req: Request, env: Env): Promise<boolean> {
  const token = req.headers.get('Authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!token || !env.ADMIN_TOKEN_SHA256) return false;
  const a = await sha256(token);
  const b = env.ADMIN_TOKEN_SHA256.toLowerCase();
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i % b.length);
  return diff === 0;
}

/** 把草稿各列組成一個資料包 */
async function loadDraft(env: Env, version = 'draft'): Promise<ContentPack> {
  const { results } = await env.DB.prepare('SELECT kind, id, data FROM content').all<{ kind: Kind; id: string; data: string }>();
  const pack: ContentPack = { version, equipment: {}, chassis: {}, pilots: {}, loadouts: {}, rosters: [[], []] };
  for (const r of results) {
    const data = JSON.parse(r.data);
    if (r.kind === 'rosters') pack.rosters[SIDES.indexOf(r.id)] = data;
    else (pack[r.kind] as Record<string, unknown>)[r.id] = data;
  }
  return pack;
}

/** 資料包拆成草稿的各列 */
function rowsOf(pack: ContentPack): [Kind, string, string][] {
  const rows: [Kind, string, string][] = [];
  for (const kind of ['equipment', 'chassis', 'pilots', 'loadouts'] as const)
    for (const [id, v] of Object.entries(pack[kind] ?? {})) rows.push([kind, id, JSON.stringify(v)]);
  (pack.rosters ?? []).forEach((side, i) => rows.push(['rosters', SIDES[i], JSON.stringify(side)]));
  return rows;
}

/** 舊版號 vN 換成新版號 0.1.(N-1) */
const fromLegacy = (v: string): string => {
  const m = /^v(\d+)$/.exec(v);
  return m ? `0.1.${Number(m[1]) - 1}` : v;
};
/** 0.1.N 在 KV 裡可能還是舊鍵 v(N+1) */
const legacyKey = (v: string): string | null => {
  const m = /^0\.1\.(\d+)$/.exec(v);
  return m ? `v${Number(m[1]) + 1}` : null;
};

async function readPack(env: Env, version: string): Promise<string | null> {
  const body = await env.PACKS.get(`pack:${version}`);
  if (body) return body;
  const old = legacyKey(version);
  const legacy = old && (await env.PACKS.get(`pack:${old}`));
  return legacy ? JSON.stringify({ ...JSON.parse(legacy), version }) : null;
}

const BUMPS = ['patch', 'minor', 'major'] as const;
function nextVersion(last: string | null, bump: (typeof BUMPS)[number]): string {
  const [major, minor, patch] = (last ?? '').split('.').map(Number);
  if (!last || [major, minor, patch].some((n) => !Number.isInteger(n))) return '0.1.0';
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

async function readBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

const SITE = 'https://darkbearlab.github.io/mech_wing_project/';

/** 入口頁：連到遊戲與機庫編輯器 */
function landingPage(latest: string | null): string {
  return `<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>機器人戰術對戰</title><style>
:root{color-scheme:dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#10151b;color:#dfe6ee;font-family:system-ui,"Noto Sans TC",sans-serif}
main{width:min(420px,100% - 32px)}h1{font-size:22px;font-weight:600;margin:0 0 4px}p{color:#8a97a5;font-size:14px;margin:0 0 20px}
a{display:block;padding:14px 16px;margin:10px 0;border:1px solid #2c3743;border-radius:10px;color:#dfe6ee;text-decoration:none;background:#17202a}
a:hover{border-color:#ffcf4a}a b{display:block;font-size:16px}a span{color:#8a97a5;font-size:13px}
</style></head><body><main><h1>機器人戰術對戰</h1><p>內容 API${latest ? `・目前資料版本 ${latest}` : ''}</p>
<a href="${SITE}"><b>進入遊戲</b><span>出擊準備、對戰電腦、同機輪流、電腦對戰電腦</span></a>
<a href="${SITE}editor.html"><b>機庫編輯器</b><span>編輯機型、武器、駕駛與陣容，發佈新版本（需要管理金鑰）</span></a>
</main></body></html>`;
}

async function handle(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const method = req.method;
  if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const latest = async () => {
    const v = await env.PACKS.get('latest');
    return v && fromLegacy(v);
  };
  if (method === 'GET' && parts.length === 0) {
    // 用瀏覽器開啟時給入口頁，程式讀取時照舊回 JSON
    if (req.headers.get('Accept')?.includes('text/html')) return new Response(landingPage(await latest()), { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    return json({ name: 'mech-wing content api', latest: await latest() });
  }

  if (parts[0] === 'packs' && method === 'GET') {
    if (parts.length === 1) {
      const { results } = await env.DB.prepare('SELECT version, note, created_at FROM releases ORDER BY seq DESC').all();
      return json(results);
    }
    const version = parts[1] === 'latest' ? await latest() : fromLegacy(parts[1]);
    const body = version && (await readPack(env, version));
    if (!body) return fail(404, '找不到這個版本');
    const cache = parts[1] === 'latest' ? 'public, max-age=30' : 'public, max-age=31536000, immutable';
    return new Response(body, { headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': cache, ...CORS } });
  }

  if (parts[0] === 'draft' && method === 'GET' && parts.length === 1) {
    const pack = await loadDraft(env);
    return json({ pack, errors: validateContent(pack) });
  }

  if (parts[0] === 'auth' && method === 'GET') return (await isAdmin(req, env)) ? json({ ok: true }) : fail(401, '管理金鑰不正確');

  if (parts[0] === 'battles' && parts.length === 1 && method === 'POST') {
    const text = await req.text();
    if (text.length > MAX_RECORD_BYTES) return fail(413, '紀錄太大');
    let rec: BattleRecord;
    try {
      rec = JSON.parse(text);
    } catch {
      return fail(400, '內容不是 JSON');
    }
    const problem = checkRecord(rec);
    if (problem) return fail(400, problem);
    const winner = rec.winner === null ? null : rec.winner === 'draw' ? 'draw' : 'AB'[rec.winner];
    const row = await env.DB.prepare('INSERT INTO battles (content_version, opponent, winner, turns, data) VALUES (?, ?, ?, ?, ?) RETURNING id')
      .bind(rec.contentVersion, rec.seats.join('/'), winner, rec.turns, text)
      .first<{ id: number }>();
    await env.DB.prepare('DELETE FROM battles WHERE id <= ?').bind((row?.id ?? 0) - MAX_BATTLES).run();
    return json({ ok: true, id: row?.id });
  }

  // 以下都要管理金鑰
  const writes = (parts[0] === 'draft' && ['PUT', 'DELETE', 'POST'].includes(method)) || (parts[0] === 'publish' && method === 'POST') || (parts[0] === 'battles' && method === 'GET');
  if (!writes) return fail(404, '沒有這個路徑');
  if (!(await isAdmin(req, env))) return fail(401, '需要管理金鑰');

  if (parts[0] === 'battles') {
    if (parts.length === 1) {
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
      const { results } = await env.DB.prepare('SELECT id, created_at, content_version, opponent, winner, turns FROM battles ORDER BY id DESC LIMIT ?').bind(limit).all();
      return json(results);
    }
    const row = await env.DB.prepare('SELECT data FROM battles WHERE id = ?').bind(Number(parts[1])).first<{ data: string }>();
    if (!row) return fail(404, '找不到這場對戰');
    return new Response(row.data, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } });
  }

  if (parts[0] === 'draft' && parts[1] === 'import' && method === 'POST') {
    const pack = (await readBody(req)) as ContentPack | undefined;
    if (!pack) return fail(400, '內容不是 JSON');
    const errors = validateContent({ ...pack, version: pack.version || 'import' });
    if (errors.length) return fail(422, '資料包有問題', { errors });
    const insert = env.DB.prepare("INSERT INTO content (kind, id, data, updated_at) VALUES (?, ?, ?, datetime('now'))");
    const rows = rowsOf(pack);
    await env.DB.batch([env.DB.prepare('DELETE FROM content'), ...rows.map((r) => insert.bind(...r))]);
    return json({ ok: true, rows: rows.length });
  }

  if (parts[0] === 'draft' && parts.length === 3) {
    const [, kind, id] = parts as [string, Kind, string];
    if (!KINDS.includes(kind)) return fail(400, `種類要是 ${KINDS.join('／')}`);
    if (kind === 'rosters' && !SIDES.includes(id)) return fail(400, '預設陣容的 id 要是 A 或 B');
    if (method === 'DELETE') {
      await env.DB.prepare('DELETE FROM content WHERE kind = ? AND id = ?').bind(kind, id).run();
      return json({ ok: true });
    }
    if (method === 'PUT') {
      const data = await readBody(req);
      if (data === undefined) return fail(400, '內容不是 JSON');
      await env.DB.prepare("INSERT INTO content (kind, id, data, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
        .bind(kind, id, JSON.stringify(data))
        .run();
      // 單筆存檔不擋，草稿允許暫時不完整；回傳整份草稿的檢查結果給編輯器顯示
      return json({ ok: true, errors: validateContent(await loadDraft(env)) });
    }
  }

  if (parts[0] === 'publish') {
    const body = ((await readBody(req)) ?? {}) as { note?: string; bump?: string };
    const bump = BUMPS.find((b) => b === (body.bump ?? 'patch'));
    if (!bump) return fail(400, `bump 要是 ${BUMPS.join('／')}`);
    const last = await env.DB.prepare('SELECT version, seq FROM releases ORDER BY seq DESC LIMIT 1').first<{ version: string; seq: number }>();
    const seq = (last?.seq ?? 0) + 1;
    const version = nextVersion(last ? fromLegacy(last.version) : null, bump);
    const pack = await loadDraft(env, version);
    const errors = validateContent(pack);
    if (errors.length) return fail(422, '草稿有問題，不能發佈', { errors });
    await env.PACKS.put(`pack:${version}`, JSON.stringify(pack));
    await env.DB.prepare('INSERT INTO releases (version, seq, note) VALUES (?, ?, ?)').bind(version, seq, body.note ?? null).run();
    await env.PACKS.put('latest', version);
    return json({ ok: true, version });
  }

  return fail(404, '沒有這個路徑');
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await handle(req, env);
    } catch (e) {
      return fail(500, e instanceof Error ? e.message : String(e));
    }
  },
} satisfies ExportedHandler<Env>;
