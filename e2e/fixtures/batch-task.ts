import type { Page } from '@playwright/test';
import type { BatchTaskSnapshot } from '../../src/shared/batch-task';

export async function getBatchTaskSnapshot(controlPage: Page): Promise<BatchTaskSnapshot | null> {
  return controlPage.evaluate(async () => (
    (await chrome.runtime.sendMessage({ action: 'getBatchTaskState' })).snapshot ?? null
  ));
}

export async function waitForTaskSnapshot(
  controlPage: Page,
  predicate: (snapshot: BatchTaskSnapshot | null) => boolean,
  timeoutMs: number
): Promise<BatchTaskSnapshot | null> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot: BatchTaskSnapshot | null = null;

  while (Date.now() < deadline) {
    lastSnapshot = await getBatchTaskSnapshot(controlPage);
    if (predicate(lastSnapshot)) return lastSnapshot;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for task snapshot: ${JSON.stringify(lastSnapshot)}`);
}
