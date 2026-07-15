import { build as viteBuild } from 'vite';

async function main() {
  process.env.BROWSER_TARGET = 'chrome';
  process.env.PINPINTO_E2E = 'true';
  try {
    await viteBuild({
      build: {
        outDir: '.e2e-dist',
        emptyOutDir: true
      }
    });
  } finally {
    delete process.env.BROWSER_TARGET;
    delete process.env.PINPINTO_E2E;
  }
}

main().catch((error) => {
  console.error('[build:e2e] failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
