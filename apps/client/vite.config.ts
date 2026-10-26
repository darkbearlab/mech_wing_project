import { defineConfig } from 'vite';

export default defineConfig({
  // 相對路徑，GitHub Pages 的子目錄也能載入
  base: './',
  build: { rollupOptions: { input: { main: 'index.html', editor: 'editor.html' } } },
  server: {
    proxy: { '/ws': { target: 'ws://localhost:8787', ws: true } },
  },
});
