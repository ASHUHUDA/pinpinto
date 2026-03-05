import { promises as fs } from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--')) continue;
    const [key, value] = entry.slice(2).split('=');
    args[key] = value ?? 'true';
  }
  return args;
}

async function listFilesRecursively(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath, baseDir)));
      continue;
    }

    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
    files.push({ fullPath, relativePath });
  }

  return files;
}

async function zipDirectory(sourceDir, outputFile) {
  const zip = new JSZip();
  const files = await listFilesRecursively(sourceDir);

  for (const file of files) {
    const content = await fs.readFile(file.fullPath);
    zip.file(file.relativePath, content);
  }

  const buffer = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 }
  });

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  await fs.writeFile(outputFile, buffer);
  return files.length;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const browser = (args.browser || 'chrome').toLowerCase();
  const sourceDir = path.resolve(args.source || 'dist');
  const format = (args.format || 'zip').toLowerCase();

  if (format !== 'zip' && format !== 'xpi') {
    throw new Error(`Unsupported format: ${format}`);
  }

  const packageJsonPath = path.resolve('package.json');
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
  const version = packageJson.version;

  const extension = format === 'xpi' ? 'xpi' : 'zip';
  const fileName = `pinpinto-${browser}-v${version}.${extension}`;
  const outputFile = path.resolve('artifacts', fileName);

  const fileCount = await zipDirectory(sourceDir, outputFile);
  console.log(`[pack] browser=${browser} format=${format} files=${fileCount}`);
  console.log(`[pack] output=${outputFile}`);
}

main().catch((error) => {
  console.error('[pack] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});

