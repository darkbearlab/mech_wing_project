// 本機模式開場前讀資料包：預設是打包在程式裡的原創內建資料；?content=latest 抓內容 API 最新發佈的版本
// （之前的鋼彈資料，已封存），?content=<版本> 抓指定版本；抓不到或格式不對就用內建資料。
import { contentVersion, useContent, type ContentPack } from '@mech/rules';

export const API = import.meta.env.VITE_CONTENT_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
const TIMEOUT_MS = 3000;
/** 機庫草稿試玩時的整份資料包（草稿沒有固定版本，對戰紀錄要附上） */
export let draftPack: ContentPack | null = null;

/** 回傳實際使用的資料版本與來源說明 */
export async function loadContent(source: string | null): Promise<{ version: string; note: string }> {
  if (!source || source === 'builtin') return { version: contentVersion(), note: '內建資料' };
  // draft：機庫的草稿（試玩用，不會記成正式版本）
  // 開發版：?content=/@fs/… 直接讀本機的資料包檔案（測試還沒發佈的資料）
  const local = import.meta.env.DEV && source?.startsWith('/');
  const path = source === 'draft' ? '/draft' : source !== 'latest' ? `/packs/${encodeURIComponent(source)}` : '/packs/latest';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(local ? source! : API + path, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    useContent((source === 'draft' ? body.pack : body) as ContentPack);
    if (source === 'draft') draftPack = body.pack;
    return { version: contentVersion(), note: source === 'draft' ? '機庫草稿（試玩）' : '線上資料' };
  } catch (e) {
    console.warn('內容 API 讀取失敗，改用內建資料', e);
    return { version: contentVersion(), note: '內建資料（線上資料讀取失敗）' };
  }
}
