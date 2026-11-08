import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// /v1 يُحوَّل إلى خادم الـ API في التطوير وفي وضع المعاينة (Docker)
const proxy = { '/v1': { target: process.env.VITE_API_PROXY ?? 'http://localhost:4000', changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy },
  preview: { port: 5173, proxy, allowedHosts: true },
});
