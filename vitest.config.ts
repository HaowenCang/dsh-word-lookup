import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // The pure parts of both halves are plain functions over values and
    // minimal structural interfaces; nothing here needs a DOM implementation.
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    reporters: ['default'],
  },
})
