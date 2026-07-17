import type { BlobJobHost } from './blob-runner';
import { createDirectBlobJobHost } from './direct-blob-host';
import { OffscreenBlobJobHost } from './offscreen-blob-host';

export function createBlobJobHost(): BlobJobHost {
    const browserTarget = typeof __PINPINTO_BROWSER_TARGET__ === 'undefined'
        ? 'chrome'
        : __PINPINTO_BROWSER_TARGET__;
    if (browserTarget === 'chrome' && chrome.offscreen?.createDocument) {
        return new OffscreenBlobJobHost();
    }
    try {
        return createDirectBlobJobHost();
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`No Blob ZIP host is available: ${reason}`);
    }
}
