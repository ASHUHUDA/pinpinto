// Minimal single-request transaction harness. Browser E2E owns real IndexedDB
// persistence, origin isolation and restart behavior.
export function installIndexedDb() {
  const records = new Map();
  const failures = { open: false, write: false };
  let created = false;
  let opens = 0;
  let closes = 0;
  globalThis.indexedDB = {
    open(name, version) {
      opens++;
      const request = {};
      const database = {
        createObjectStore() { created = true; },
        close() { closes++; },
        transaction(storeName, mode) {
          const transaction = {
            objectStore() {
              const operation = (key, value, write) => {
                const result = {};
                queueMicrotask(() => {
                  if (write && failures.write) {
                    failures.write = false;
                    transaction.onabort?.();
                    return;
                  }
                  result.result = write ? key : records.get(key);
                  result.onsuccess?.();
                  queueMicrotask(() => {
                    if (write) records.set(key, value);
                    transaction.oncomplete?.();
                  });
                });
                return result;
              };
              return {
                get(key) { return operation(key, undefined, false); },
                put(value, key) { return operation(key, value, true); }
              };
            }
          };
          return transaction;
        }
      };
      queueMicrotask(() => {
        if (failures.open) {
          failures.open = false;
          request.onerror?.();
          return;
        }
        request.result = database;
        if (!created) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    }
  };
  return { records, failures, get opens() { return opens; }, get closes() { return closes; } };
}
