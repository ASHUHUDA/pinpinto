import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile, unlink } from 'node:fs/promises';

import ts from 'typescript';

export async function loadTsModule(relativeSourcePath) {
  const sourcePath = path.resolve(relativeSourcePath);
  const sourceCode = await readFile(sourcePath, 'utf8');

  const transpiled = ts.transpileModule(sourceCode, {
    compilerOptions: {
      module: ts.ModuleKind.ES2022,
      target: ts.ScriptTarget.ES2022
    }
  });

  const tempPath = path.join(
    os.tmpdir(),
    `pinpinto-${path.basename(relativeSourcePath, '.ts')}-${Date.now()}-${Math.random().toString(16).slice(2)}.mjs`
  );

  await writeFile(tempPath, transpiled.outputText, 'utf8');

  try {
    return await import(`${pathToFileURL(tempPath).href}?t=${Date.now()}`);
  } finally {
    await unlink(tempPath).catch(() => {});
  }
}
