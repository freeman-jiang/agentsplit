import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The dev server serves the client and sends the server's paths to
// `bun run dev:server` (src/server/server.ts) on API_PORT.
const api = `http://127.0.0.1:${process.env['API_PORT'] ?? 5181}`

export default defineConfig({
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
  server: {
    proxy: Object.fromEntries(
      ['/api/', '/.well-known/', '/robots.txt', '/sitemap.xml', '^/(groups/)?[^/]+/expenses/export/'].map((path) => [path, { target: api, xfwd: true }]),
    ),
  },
})
