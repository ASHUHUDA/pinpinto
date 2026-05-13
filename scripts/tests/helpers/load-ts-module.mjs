import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import ts from 'typescript';

export async function loadTsModule(relativeSourcePath) {
  const workspaceRoot = process.cwd();
  const tempBaseDir = path.join(workspaceRoot, '.omx', 'tmp-tests');
  await mkdir(tempBaseDir, { recursive: true });
  const tempRoot = await mkdtemp(path.join(tempBaseDir, 'pinpinto-test-'));
  const emitted = new Map();

  async function emitModule(sourcePath) {
    const normalizedSourcePath = path.resolve(sourcePath);
    if (emitted.has(normalizedSourcePath)) {
      return emitted.get(normalizedSourcePath);
    }

    const sourceCode = await readFile(normalizedSourcePath, 'utf8');
    const sourceDir = path.dirname(normalizedSourcePath);
    const rewrittenSource = sourceCode.replace(
      /(from\s+['"])(\.[^'"]+)(['"])/g,
      (_, prefix, specifier, suffix) => `${prefix}${specifier}.mjs${suffix}`
    );

    const dependencySpecifiers = [...sourceCode.matchAll(/from\s+['"](\.[^'"]+)['"]/g)]
      .map((match) => match[1]);

    for (const specifier of dependencySpecifiers) {
      const dependencyPath = path.resolve(sourceDir, `${specifier}.ts`);
      await emitModule(dependencyPath);
    }

    const transpiled = ts.transpileModule(rewrittenSource, {
      compilerOptions: {
        module: ts.ModuleKind.ES2022,
        target: ts.ScriptTarget.ES2022
      }
    });

    const relativeFromWorkspace = path.relative(workspaceRoot, normalizedSourcePath);
    const outputPath = path.join(
      tempRoot,
      relativeFromWorkspace.replace(/\.ts$/, '.mjs')
    );

    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, transpiled.outputText, 'utf8');
    emitted.set(normalizedSourcePath, outputPath);
    return outputPath;
  }

  try {
    const entryPath = await emitModule(path.resolve(relativeSourcePath));
    return await import(`${pathToFileURL(entryPath).href}?t=${Date.now()}`);
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}
