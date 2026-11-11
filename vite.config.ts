import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import electron from 'vite-plugin-electron';

export default defineConfig({
  // relative asset paths so dist/index.html works via file:// (Electron loadFile)
  base: './',
  plugins: [
    react(),
    electron([
      {
        entry: 'electron/main.ts',
        onstart(options) { options.startup(); },
        vite: { build: { outDir: 'dist-electron', rollupOptions: { external: ['electron'] } } },
      },
      {
        entry: 'electron/preload.ts',
        onstart(options) { options.reload(); },
        vite: { build: { outDir: 'dist-electron', rollupOptions: { external: ['electron'] } } },
      },
    ]),
  ],
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
