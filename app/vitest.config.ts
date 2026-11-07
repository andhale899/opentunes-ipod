import { defineConfig } from 'vitest/config';

// The app's tests cover pure code (the converter's argument builders and job logic), so they run
// in Node without the Preact plugin from vite.config.ts.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
  },
});
