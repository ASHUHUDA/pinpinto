import sharp from 'sharp';
import { resolve } from 'path';

const source = 'C:\\Users\\ANSEL\\.gemini\\antigravity\\brain\\c8ef47d3-b86a-43db-93ba-c9d2e910db09\\pinvault_pro_logo_1772659730596.png';
const targets = [16, 32, 48, 128];

async function run() {
  for (const size of targets) {
    await sharp(source)
      .resize(size, size)
      .toFile(resolve(`./public/icons/icon${size}.png`));
    console.log(`Saved icon${size}.png`);
  }
}
run().catch(console.error);
