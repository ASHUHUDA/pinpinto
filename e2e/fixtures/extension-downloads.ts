import type { Page } from '@playwright/test';

export type DownloadCheckpoint = ReadonlySet<number>;

type CompletedDownloadOptions = {
  count: number;
  timeoutMs: number;
  matches: (download: chrome.downloads.DownloadItem) => boolean;
};

export async function captureDownloadCheckpoint(controlPage: Page): Promise<DownloadCheckpoint> {
  const downloads = await controlPage.evaluate(async () => chrome.downloads.search({ limit: 1_000 }));
  return new Set(downloads.map((download) => download.id));
}

export async function listDownloadsSince(
  controlPage: Page,
  checkpoint: DownloadCheckpoint
): Promise<chrome.downloads.DownloadItem[]> {
  const downloads = await controlPage.evaluate(async () => chrome.downloads.search({ limit: 1_000 }));
  return downloads
    .filter((download) => !checkpoint.has(download.id))
    .sort((left, right) => left.id - right.id);
}

export async function waitForNewCompletedDownloads(
  controlPage: Page,
  checkpoint: DownloadCheckpoint,
  options: CompletedDownloadOptions
): Promise<chrome.downloads.DownloadItem[]> {
  const deadline = Date.now() + options.timeoutMs;
  let lastDownloads: chrome.downloads.DownloadItem[] = [];

  while (Date.now() < deadline) {
    lastDownloads = await listDownloadsSince(controlPage, checkpoint);
    const interrupted = lastDownloads.find((download) => (
      options.matches(download) && download.state === 'interrupted'
    ));
    if (interrupted) {
      throw new Error(`New download ${interrupted.id} was interrupted: ${JSON.stringify(interrupted)}`);
    }

    const completed = lastDownloads.filter((download) => (
      options.matches(download)
      && download.state === 'complete'
      && download.exists === true
      && download.fileSize > 0
    ));
    if (completed.length === options.count) return completed;
    if (completed.length > options.count) {
      throw new Error(`Expected ${options.count} new downloads, received ${completed.length}: ${JSON.stringify(completed)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for new completed downloads: ${JSON.stringify(lastDownloads)}`);
}
