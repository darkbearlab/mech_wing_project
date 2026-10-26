// 本機模式開場前，從內容 API 抓最新發佈的資料包；抓不到或格式不對就用打包在程式裡的內建資料。
import { contentVersion, useContent, type ContentPack } from '@mech/rules';

const API = import.meta.env.VITE_CONTENT_API ?? 'https://mech-wing-api.darkbearlab.workers.dev';
const TIMEOUT_MS = 3000;

/** 回傳實際使用的資料版本與來源說明 */
export async function loadContent(source: string | null): Promise<{ version: string; note: string }> {
  if (source === 'builtin') return { version: contentVersion(), note: '內建資料' };
  const path = source && source !== 'latest' ? `/packs/${encodeURIComponent(source)}` : '/packs/latest';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(API + path, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    useContent((await res.json()) as ContentPack);
    return { version: contentVersion(), note: '線上資料' };
  } catch (e) {
    console.warn('內容 API 讀取失敗，改用內建資料', e);
    return { version: contentVersion(), note: '內建資料（線上資料讀取失敗）' };
  }
}
