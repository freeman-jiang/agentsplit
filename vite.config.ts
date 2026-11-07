import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { SERVER_PATHS } from './src/shared/paths'

// The dev server serves the client and sends the server's paths to
// `bun run dev:server` (src/server/main/server.ts) on API_PORT.
export default defineConfig(({ command }) => {
  const apiPort = process.env['API_PORT']
  if (command === 'serve' && !apiPort) throw new Error('Set API_PORT to the port of `bun run dev:server`')
  const api = `http://127.0.0.1:${apiPort}`
  return {
    resolve: { tsconfigPaths: true },
    plugins: [
      tanstackRouter({
        target: 'react',
        routesDirectory: './src/client/routes',
        generatedRouteTree: './src/client/routeTree.gen.ts',
        autoCodeSplitting: true,
      }),
      react(),
      tailwindcss(),
    ],
    build: { outDir: 'dist/client', emptyOutDir: true },
    server: { proxy: Object.fromEntries(SERVER_PATHS.map((path) => [path, { target: api, xfwd: true }])) },
  }
})
