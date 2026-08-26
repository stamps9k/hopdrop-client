import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const config_dir = path.dirname(fileURLToPath(import.meta.url));
const repo_root = path.resolve(config_dir, '..');

export default defineConfig({
  root: repo_root,
  server: {
    host: true,
    port: 7421,
  },
  build: {
    target: 'es2022',
    outDir: path.resolve(repo_root, 'dist'),
  },
});
