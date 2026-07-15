import type { BlobJobHost } from './blob-runner';

export type DownloadImage = string | {
    id?: string;
    url?: string;
    title?: string;
    board?: string;
    originalFilename?: string;
};

export type TrackedDownloadInfo = {
    imageData: DownloadImage;
    settings: Record<string, unknown>;
    startTime: number;
    status: string;
    isBatch: boolean;
    batchKind?: 'zip' | 'fallback';
    blobLeaseJobId?: string;
    jobId?: string;
    targetTabId?: number | null;
    imageId?: string | null;
    requestedFilename?: string;
    endTime?: number;
    duration?: number;
    error?: unknown;
    bytesReceived?: number;
};

export type BatchCoordinatorHost = {
    blobHost: BlobJobHost;
    activeDownloads: Map<number, TrackedDownloadInfo>;
    maxConcurrentDownloads: number;
    normalizeImageUrlForDeduplication: (image: DownloadImage, settings: Record<string, unknown>) => string;
    getDownloadCandidateUrls: (rawUrl: string, highQualityEnabled: boolean) => string[];
    buildIndexedFilename: (sequence: number, timestamp: string, url: string, originalFilename?: string) => string;
    extractFilenameFromUrl: (url: string) => string;
    formatLocalTimestamp: () => string;
    broadcast: (message: Record<string, unknown>) => void | Promise<void>;
};

export type StartBatchRequest = {
    mode?: 'manual' | 'auto';
    images?: DownloadImage[];
    urls?: DownloadImage[];
    settings?: Record<string, unknown>;
    targetTabId?: number;
    autoBatchLimit?: number;
    autoBatchTotalBatches?: number;
};

export type AutoBatchWindowRequest = {
    jobId?: string;
    images?: DownloadImage[];
    settings?: Record<string, unknown>;
    startIndex?: number;
    endIndex?: number;
    startOffset?: number;
    endOffset?: number;
    finalWindow?: boolean;
};

export type CommitResponse = {
    success?: boolean;
    baseOffset?: number;
    retainedCount?: number;
    error?: string;
};
