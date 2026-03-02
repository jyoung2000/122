import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:1353',
      '/ws': {
        target: 'ws://localhost:1353',
        ws: true,
      },
    },
  },
});
