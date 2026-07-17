import { createGlobalCleanup } from './global-cleanup.mjs';

export const restoreActionRuntimeGlobals = createGlobalCleanup([
  'chrome',
  'document',
  'window',
  'fetch',
  'Date',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval'
]);

export function installMinimalDom() {
  const elements = new Map();

  globalThis.document = {
    getElementById(id) {
      if (!elements.has(id)) {
        elements.set(id, {
          id,
          style: {},
          textContent: '0'
        });
      }
      return elements.get(id);
    }
  };

  globalThis.window = globalThis;
  globalThis.setTimeout = (callback) => {
    callback();
    return 1;
  };
  globalThis.clearTimeout = () => {};
}
