import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const sourceSvg = resolve('./assets/icons/pinpinto-base.svg');
const targets = [16, 32, 48, 128];

async function run() {
  const svgBuffer = await readFile(sourceSvg);

  for (const size of targets) {
    // Increase density to preserve edges at small sizes like 16px.
    await sharp(svgBuffer, { density: size * 20 })
      .resize(size, size, { fit: 'cover' })
      .png({ compressionLevel: 9 })
      .toFile(resolve(`./public/icons/icon${size}.png`));

    console.log(`[icon] generated icon${size}.png`);
  }
}

run().catch((error) => {
  console.error('[icon] build failed:', error);
  process.exitCode = 1;
});
