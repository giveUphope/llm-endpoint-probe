import '@testing-library/jest-dom/vitest';

if (!globalThis.crypto.randomUUID) {
  Object.defineProperty(globalThis.crypto, 'randomUUID', { value: () => `test-${Math.random().toString(16).slice(2)}` });
}
