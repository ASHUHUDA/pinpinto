import type { BlobJobRequest } from './blob-runner';

export const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
export const OFFSCREEN_MESSAGE_TARGET = 'pinpinto-blob-offscreen';

export type OffscreenBlobMessage =
    | { target: typeof OFFSCREEN_MESSAGE_TARGET; operation: 'start'; request: BlobJobRequest }
    | { target: typeof OFFSCREEN_MESSAGE_TARGET; operation: 'getStatus' | 'result' | 'cancel' | 'release'; jobId: string }
    | { target: typeof OFFSCREEN_MESSAGE_TARGET; operation: 'listActiveJobs' };

export type OffscreenBlobResponse = {
    ok: boolean;
    value?: unknown;
    error?: string;
};
