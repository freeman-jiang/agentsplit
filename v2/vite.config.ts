import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tanstackRouter } from '@tanstack/router-plugin/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

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
    cloudflare(),
  ],
})
