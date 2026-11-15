import { builtinModules } from 'node:module';
import adapter from '@sveltejs/adapter-cloudflare';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import tailwindcss from '@tailwindcss/vite';
import { esmExternalRequirePlugin } from 'vite';
import { defineConfig } from 'vitest/config';

export default defineConfig(({ command }) => ({
  resolve: {
    alias: command === 'build' ? [{ find: /^@libsql\/client$/, replacement: '@libsql/client/http' }] : []
  },
  environments: {
    ssr: {
      build: {
        rolldownOptions: {
          // The adapter rebundles SSR for Workers, where the generated createRequire shim fails.
          plugins: [esmExternalRequirePlugin({ external: [...builtinModules, /^node:/] })]
        }
      }
    }
  },
  plugins: [
    tailwindcss(),
    sveltekit({
      adapter: adapter(),

      experimental: {
        remoteFunctions: true
      },

      compilerOptions: {
        experimental: {
          async: true
        }
      },

      preprocess: vitePreprocess()
    })
  ],
  test: {
    expect: { requireAssertions: true },
    projects: [
      {
        extends: './vite.config.ts',
        test: {
          name: 'server',
          environment: 'node',
          include: ['src/**/*.{test,spec}.{js,ts}', 'tests/unit/**/*.{test,spec}.{js,ts}'],
          exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'tests/e2e/**']
        }
      }
    ]
  }
}));
