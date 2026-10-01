import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:4174' },
    watch: {
      // 编辑器的原子保存会在仓库里留下 .<file>.<pid>.<uuid>.tmpdir/ 临时目录；
      // Windows 上 chokidar 去 watch 这些被占用的文件会以 EBUSY 直接打死 dev server
      ignored: ['**/.*tmpdir/**', '**/*.tmp'],
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
});
