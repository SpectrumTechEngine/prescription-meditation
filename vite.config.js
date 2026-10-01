import { defineConfig } from 'vite';

// Published at https://thespectrumtechengine.com/prescription-meditation/ (GitHub Pages).
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/prescription-meditation/' : '/',
}));
