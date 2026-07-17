import { normalizeSingleImageDownloadMethod, type SingleImageDownloadMethod } from '../shared/download-settings';
import { buildSingleDownloadPath } from './download-path';
import { BLOB_FETCH_TIMEOUT_MS, type BlobJobHost } from './blob-runner';
import { buildSingleFilename, formatLocalTimestamp } from './filename';
import { getDownloadCandidateUrls } from './image-url';

export type SingleImageData = {
    id?: string;
    url?: string;
    title?: string;
    board?: string;
    originalFilename?: string;
};

export type SingleImageSettings = Record<string, unknown> & {
    highQuality?: boolean;
    singleImageDownloadMethod?: unknown;
};

export type BrowserSingleDownloadRegistration = {
    downloadId: number;
    blobLeaseJobId: string;
    targetTabId: number | null;
    imageId: string | null;
    requestedFilename: string;
    imageData: SingleImageData;
    settings: SingleImageSettings;
};

export type SingleImageDownloadResult =
    | { success: true; method: 'browser'; state: 'pending'; downloadId: number }
    | { success: true; method: 'external'; state: 'submitted'; downloadId: number }
    | { success: false; method: SingleImageDownloadMethod; state: 'rejected'; error: string };

type SingleImageDownloadDependencies = {
    blobHost: BlobJobHost;
    registerBrowserDownload: (registration: BrowserSingleDownloadRegistration) => Promise<void>;
    removeTrackedDownload: (downloadId: number) => void;
    download?: (options: chrome.downloads.DownloadOptions) => Promise<number>;
    cancelDownload?: (downloadId: number) => Promise<void>;
    rememberRequestedFilename?: (url: string, requestedFilename: string) => void;
    createRequestId?: () => string;
};

export class SingleImageDownloadService {
    private readonly download: (options: chrome.downloads.DownloadOptions) => Promise<number>;
    private readonly cancelDownload: (downloadId: number) => Promise<void>;
    private readonly createRequestId: () => string;

    constructor(private readonly dependencies: SingleImageDownloadDependencies) {
        this.download = dependencies.download ?? ((options) => chrome.downloads.download(options));
        this.cancelDownload = dependencies.cancelDownload ?? ((downloadId) => chrome.downloads.cancel(downloadId));
        this.createRequestId = dependencies.createRequestId ?? createRequestId;
    }

    async start(input: {
        imageData: SingleImageData;
        settings?: SingleImageSettings;
        targetTabId?: number | null;
        imageId?: string | null;
    }): Promise<SingleImageDownloadResult> {
        const settings = input.settings ?? {};
        const method = normalizeSingleImageDownloadMethod(settings.singleImageDownloadMethod);
        const sourceUrl = typeof input.imageData?.url === 'string' ? input.imageData.url : '';
        const candidateUrls = getDownloadCandidateUrls(sourceUrl, settings.highQuality !== false);
        if (candidateUrls.length === 0) {
            return rejected(method, 'Image URL is missing.');
        }

        if (method === 'external') {
            return this.submitExternal(candidateUrls[0], input.imageData);
        }
        return this.submitBrowserBlob({ ...input, settings, sourceUrl, candidateUrls });
    }

    private async submitExternal(
        url: string,
        imageData: SingleImageData
    ): Promise<SingleImageDownloadResult> {
        try {
            const requestedFilename = buildRequestedFilename(url, imageData.originalFilename);
            this.dependencies.rememberRequestedFilename?.(url, requestedFilename);
            const downloadId = await this.download({
                url,
                filename: requestedFilename,
                conflictAction: 'uniquify',
                saveAs: false
            });
            return { success: true, method: 'external', state: 'submitted', downloadId };
        } catch {
            return rejected('external', 'Not accepted. Switch to Browser');
        }
    }

    private async submitBrowserBlob(input: {
        imageData: SingleImageData;
        settings: SingleImageSettings;
        targetTabId?: number | null;
        imageId?: string | null;
        sourceUrl: string;
        candidateUrls: string[];
    }): Promise<SingleImageDownloadResult> {
        const requestId = this.createRequestId();
        const blobLeaseJobId = `single:${requestId}:file`;
        const requestedFilename = buildRequestedFilename(input.candidateUrls[0], input.imageData.originalFilename);
        const entryFilename = requestedFilename.slice(requestedFilename.lastIndexOf('/') + 1);

        try {
            await this.dependencies.blobHost.start({
                jobId: blobLeaseJobId,
                output: 'file',
                entries: [{
                    imageId: typeof input.imageId === 'string' && input.imageId
                        ? input.imageId
                        : `single-${requestId}`,
                    sequence: 1,
                    sourceUrl: input.sourceUrl,
                    candidateUrls: input.candidateUrls,
                    filename: entryFilename
                }],
                maxConcurrency: 1,
                fetchTimeoutMs: BLOB_FETCH_TIMEOUT_MS
            });
            const result = await this.dependencies.blobHost.result(blobLeaseJobId);
            const validContentType = result.contentType?.startsWith('image/') === true;
            if (result.output !== 'file' || !result.objectUrl || !validContentType || result.failedEntries.length > 0) {
                const reason = result.failedEntries[0]?.error || 'File Blob host did not return an image object URL.';
                await this.discardBlobJob(blobLeaseJobId);
                return rejected('browser', reason);
            }

            let downloadId: number;
            try {
                this.dependencies.rememberRequestedFilename?.(result.objectUrl, requestedFilename);
                downloadId = await this.download({
                    url: result.objectUrl,
                    filename: requestedFilename,
                    conflictAction: 'uniquify',
                    saveAs: false
                });
            } catch (error) {
                await this.dependencies.blobHost.release(blobLeaseJobId).catch(() => {});
                return rejected('browser', errorMessage(error));
            }

            try {
                await this.dependencies.registerBrowserDownload({
                    downloadId,
                    blobLeaseJobId,
                    targetTabId: typeof input.targetTabId === 'number' ? input.targetTabId : null,
                    imageId: typeof input.imageId === 'string' && input.imageId ? input.imageId : null,
                    requestedFilename,
                    imageData: input.imageData,
                    settings: input.settings
                });
            } catch (error) {
                await this.cancelDownload(downloadId).catch(() => {});
                this.dependencies.removeTrackedDownload(downloadId);
                return rejected('browser', errorMessage(error));
            }

            return { success: true, method: 'browser', state: 'pending', downloadId };
        } catch (error) {
            await this.discardBlobJob(blobLeaseJobId);
            return rejected('browser', errorMessage(error));
        }
    }

    private async discardBlobJob(jobId: string): Promise<void> {
        await this.dependencies.blobHost.cancel(jobId).catch(() => {});
        await this.dependencies.blobHost.release(jobId).catch(() => {});
    }
}

function buildRequestedFilename(url: string, originalFilename: unknown): string {
    const filename = buildSingleFilename(
        formatLocalTimestamp(),
        url,
        typeof originalFilename === 'string' ? originalFilename : undefined
    );
    return buildSingleDownloadPath(filename);
}

function createRequestId(): string {
    return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function rejected(method: SingleImageDownloadMethod, error: string): SingleImageDownloadResult {
    return { success: false, method, state: 'rejected', error };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
