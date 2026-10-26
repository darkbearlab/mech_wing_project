import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑，GitHub Pages 的子目錄也能載入
  base: './',
  // 對戰紀錄附上建置版本，重播對不上時知道是哪一版規則
  define: { __BUILD__: JSON.stringify(process.env.GITHUB_SHA?.slice(0, 7) ?? 'dev') },
  build: { rollupOptions: { input: { main: 'index.html', editor: 'editor.html' } } },
  server: {
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
