import vue from '@vitejs/plugin-vue'
import basicSsl from '@vitejs/plugin-basic-ssl'
import { defineConfig } from 'vite'

export default defineConfig({
  // A phone app refuses the development certificate, so `npm run dev:phone` serves plain http
  // instead; the phone reaches it as localhost, where the camera and microphone are still allowed.
  plugins: [vue(), ...(process.env.DEV_HTTP ? [] : [basicSsl()])],
  // The call screen, which carries LiveKit, is its own chunk loaded only when someone joins a call.
  build: { chunkSizeWarningLimit: 600 },
  server: {
    port: 5173,
    host: true,
    proxy: {
      '/api': 'http://localhost:3001',
      '/uploads': 'http://localhost:3001',
      '/socket.io': {
        target: 'http://localhost:3001',
        ws: true,
      },
    },
  },
})
