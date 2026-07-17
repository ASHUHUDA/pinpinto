import { buildZipDownloadPath } from './download-path';
import type { BlobJobEntry, BlobJobHost } from './blob-runner';
import type { BatchImageResult, BatchRunResult } from '../shared/batch-task';

export const IMAGE_FETCH_TIMEOUT_MS = 8000;

type BatchImage = string | {
    id?: string;
    url?: string;
    title?: string;
    board?: string;
    originalFilename?: string;
};

type BatchRuntime = {
    id: string;
    cancelled: boolean;
    notified: boolean;
    activeDownloadIds: Set<number>;
    controllers: Set<AbortController>;
};

type FallbackDownloadRequest = {
    jobId: string;
    image: BatchImage;
    sourceUrl: string;
    filename: string;
    settings: Record<string, unknown>;
};

type BatchDownloadContext = {
    blobHost: BlobJobHost;
    maxConcurrentDownloads: number;
    requestFallbackDownload: (request: FallbackDownloadRequest) => Promise<{
        accepted: boolean;
        downloadId?: number;
        error?: string;
    }>;
    throwIfBatchCancelled: (batchJob: BatchRuntime) => void;
    isBatchCancellationError: (error: unknown) => boolean;
    sendProgressUpdate: (batchJob: BatchRuntime, progress: number, details: string) => void;
    normalizeImageUrlForDeduplication: (image: BatchImage, settings: Record<string, unknown>) => string;
    getDownloadCandidateUrls: (rawUrl: string, highQualityEnabled: boolean) => string[];
    buildIndexedFilename: (sequence: number, timestamp: string, url: string, originalFilename?: string) => string;
    extractFilenameFromUrl: (url: string) => string;
    formatLocalTimestamp: () => string;
    rememberRequestedFilename?: (url: string, requestedFilename: string) => void;
};

type IndexedImage = BlobJobEntry & { image: BatchImage };

export async function runBatchDownload(
    context: BatchDownloadContext,
    batchJob: BatchRuntime,
    images: BatchImage[],
    settings: Record<string, unknown>,
    options: { sequenceOffset?: number } = {}
): Promise<BatchRunResult> {
    const sequenceOffset = Math.max(0, Math.floor(options.sequenceOffset ?? 0));
    const batchTimestamp = context.formatLocalTimestamp();
    const indexedImages = indexImages(context, batchJob, Array.isArray(images) ? images : [], settings, sequenceOffset, batchTimestamp);
    const totalImages = indexedImages.length;

    if (totalImages === 0) {
        context.sendProgressUpdate(batchJob, 100, '未接收到可下载图片。');
        return emptyRunResult();
    }

    context.sendProgressUpdate(batchJob, 0, `开始处理 ${totalImages} 张图片。`);
    const parsedBatchSize = Number(settings.maxConcurrentDownloads);
    const maxConcurrency = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
        ? Math.floor(parsedBatchSize)
        : context.maxConcurrentDownloads;
    const blobJobId = `${batchJob.id}:zip:${sequenceOffset}:${totalImages}`;

    try {
        await context.blobHost.start({
            jobId: blobJobId,
            output: 'zip',
            entries: indexedImages.map(({ image: _image, ...entry }) => entry),
            maxConcurrency,
            fetchTimeoutMs: IMAGE_FETCH_TIMEOUT_MS
        });
        const blobResult = await waitForBlobResult(context, batchJob, blobJobId, totalImages);
        context.throwIfBatchCancelled(batchJob);

        const imageById = new Map(indexedImages.map((entry) => [entry.imageId, entry]));
        const results: BatchImageResult[] = blobResult.zippedEntries.map((entry) => ({
            imageId: entry.imageId,
            sequence: entry.sequence,
            sourceUrl: entry.sourceUrl,
            resolvedUrl: entry.resolvedUrl,
            filename: entry.filename,
            status: 'zip'
        }));

        for (const failure of blobResult.failedEntries) {
            context.throwIfBatchCancelled(batchJob);
            const indexed = imageById.get(failure.imageId);
            const fallback = await requestFallback(context, batchJob, indexed?.image ?? failure.sourceUrl, failure, settings);
            results.push(fallback);
        }
        results.sort((left, right) => left.sequence - right.sequence);

        const zippedCount = blobResult.zippedEntries.length;
        const fallbackResults = results.filter((result) => result.status === 'fallback-pending');
        const unresolvedCount = results.filter((result) => result.status === 'unresolved').length;
        let zipDownloadId: number | undefined;
        let zipFilename: string | undefined;

        if (zippedCount > 0) {
            if (!blobResult.objectUrl) throw new Error('Blob host completed without an object URL.');
            context.sendProgressUpdate(batchJob, 95, '图片获取完成，正在创建浏览器下载。');
            zipFilename = buildZipDownloadPath(`PinPinto_${batchTimestamp}.zip`);
            try {
                context.rememberRequestedFilename?.(blobResult.objectUrl, zipFilename);
                zipDownloadId = await chrome.downloads.download({
                    url: blobResult.objectUrl,
                    filename: zipFilename,
                    conflictAction: 'uniquify',
                    saveAs: false
                });
                context.throwIfBatchCancelled(batchJob);
            } catch (error) {
                if (typeof zipDownloadId === 'number') await chrome.downloads.cancel(zipDownloadId).catch(() => {});
                await context.blobHost.cancel(blobJobId).catch(() => {});
                await context.blobHost.release(blobJobId).catch(() => {});
                throw error;
            }
        } else {
            await context.blobHost.release(blobJobId);
        }

        const summary = zippedCount === 0 && fallbackResults.length > 0 && unresolvedCount === 0
            ? `全部 ${fallbackResults.length} 张图片已交给浏览器单独下载。`
            : `ZIP 图片 ${zippedCount} 张，浏览器补救 ${fallbackResults.length} 张，未解决 ${unresolvedCount} 张。`;
        context.sendProgressUpdate(batchJob, 100, summary);

        return {
            results,
            totalCount: totalImages,
            zippedCount,
            fallbackRequestedCount: fallbackResults.length,
            unresolvedCount,
            zipDownloadId,
            zipFilename,
            zipLeaseJobId: zipDownloadId === undefined ? undefined : blobJobId,
            fallbackDownloadIds: fallbackResults
                .map((result) => result.downloadId)
                .filter((downloadId): downloadId is number => typeof downloadId === 'number')
        };
    } catch (error) {
        await context.blobHost.cancel(blobJobId).catch(() => {});
        await context.blobHost.release(blobJobId).catch(() => {});
        context.throwIfBatchCancelled(batchJob);
        throw error;
    }
}

async function waitForBlobResult(
    context: Pick<BatchDownloadContext, 'blobHost' | 'throwIfBatchCancelled' | 'sendProgressUpdate'>,
    batchJob: BatchRuntime,
    blobJobId: string,
    totalImages: number
) {
    const pendingResult = context.blobHost.result(blobJobId).then(
        (value) => ({ done: true as const, value }),
        (error) => Promise.reject(error)
    );
    while (true) {
        const outcome = await Promise.race([
            pendingResult,
            delay(100).then(() => ({ done: false as const }))
        ]);
        if (outcome.done) return outcome.value;
        context.throwIfBatchCancelled(batchJob);
        const status = await context.blobHost.getStatus(blobJobId);
        if (!status) throw new Error(`Blob host lost active job: ${blobJobId}`);
        const fetchProgress = totalImages === 0 ? 0 : (status.completedEntries / totalImages) * 55;
        const progress = status.zipProgress > 0 ? 60 + status.zipProgress * 0.35 : fetchProgress;
        const details = status.zipProgress > 0
            ? `打包进度：${Math.round(status.zipProgress)}%`
            : `已处理 ${status.completedEntries}/${totalImages} 张图片。`;
        context.sendProgressUpdate(batchJob, progress, details);
    }
}

function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function indexImages(
    context: Pick<BatchDownloadContext, 'normalizeImageUrlForDeduplication' | 'throwIfBatchCancelled' | 'getDownloadCandidateUrls' | 'buildIndexedFilename' | 'extractFilenameFromUrl'>,
    batchJob: BatchRuntime,
    images: BatchImage[],
    settings: Record<string, unknown>,
    sequenceOffset: number,
    timestamp: string
): IndexedImage[] {
    const seen = new Set<string>();
    const unique: IndexedImage[] = [];
    images.forEach((image, index) => {
        context.throwIfBatchCancelled(batchJob);
        const normalizedUrl = context.normalizeImageUrlForDeduplication(image, settings);
        const sourceUrl = typeof image === 'string' ? image : image?.url;
        if (!normalizedUrl || typeof sourceUrl !== 'string' || !sourceUrl || seen.has(normalizedUrl)) return;
        seen.add(normalizedUrl);
        const sequence = sequenceOffset + index + 1;
        const originalFilename = typeof image === 'string'
            ? context.extractFilenameFromUrl(sourceUrl)
            : image.originalFilename || context.extractFilenameFromUrl(sourceUrl);
        unique.push({
            image,
            imageId: typeof image === 'string' ? `img_${index}` : image.id || `img_${index}`,
            sequence,
            sourceUrl,
            candidateUrls: context.getDownloadCandidateUrls(sourceUrl, settings.highQuality !== false),
            filename: context.buildIndexedFilename(sequence, timestamp, sourceUrl, originalFilename)
        });
    });
    return unique;
}

async function requestFallback(
    context: Pick<BatchDownloadContext, 'requestFallbackDownload' | 'throwIfBatchCancelled'>,
    batchJob: BatchRuntime,
    image: BatchImage,
    failure: Pick<BlobJobEntry, 'imageId' | 'sequence' | 'sourceUrl' | 'filename'> & { error: string },
    settings: Record<string, unknown>
): Promise<BatchImageResult> {
    try {
        const fallback = await context.requestFallbackDownload({
            jobId: batchJob.id,
            image,
            sourceUrl: failure.sourceUrl,
            filename: failure.filename,
            settings
        });
        if (fallback.accepted && typeof fallback.downloadId === 'number') {
            return { ...failure, downloadId: fallback.downloadId, status: 'fallback-pending' };
        }
        return { ...failure, status: 'unresolved', error: fallback.error || failure.error };
    } catch (error) {
        context.throwIfBatchCancelled(batchJob);
        return { ...failure, status: 'unresolved', error: errorMessage(error) };
    }
}

function emptyRunResult(): BatchRunResult {
    return {
        results: [],
        totalCount: 0,
        zippedCount: 0,
        fallbackRequestedCount: 0,
        unresolvedCount: 0,
        fallbackDownloadIds: []
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
