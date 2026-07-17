const ABSENT = Symbol('absent-global');

export function createGlobalCleanup(names) {
  const originals = new Map(names.map((name) => [
    name,
    Object.prototype.hasOwnProperty.call(globalThis, name) ? globalThis[name] : ABSENT
  ]));

  return function restoreGlobals() {
    for (const [name, value] of originals) {
      if (value === ABSENT) Reflect.deleteProperty(globalThis, name);
      else globalThis[name] = value;
    }
  };
}
