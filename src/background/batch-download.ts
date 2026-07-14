import JSZip from 'jszip';

import { buildZipDownloadPath } from './download-path';
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

type FallbackDownloadResponse = {
    accepted: boolean;
    downloadId?: number;
    error?: string;
};

type BatchDownloadContext = {
    maxConcurrentDownloads: number;
    fetchImpl?: typeof fetch;
    requestFallbackDownload: (request: FallbackDownloadRequest) => Promise<FallbackDownloadResponse>;
    throwIfBatchCancelled: (batchJob: BatchRuntime) => void;
    isBatchCancellationError: (error: unknown) => boolean;
    sendProgressUpdate: (batchJob: BatchRuntime, progress: number, details: string) => void;
    normalizeImageUrlForDeduplication: (image: BatchImage, settings: Record<string, unknown>) => string;
    getDownloadCandidateUrls: (rawUrl: string, highQualityEnabled: boolean) => string[];
    buildIndexedFilename: (sequence: number, timestamp: string, url: string, originalFilename?: string) => string;
    extractFilenameFromUrl: (url: string) => string;
    formatLocalTimestamp: () => string;
};

type IndexedImage = {
    image: BatchImage;
    sequence: number;
    sourceUrl: string;
    imageId: string;
};

export async function runBatchDownload(
    context: BatchDownloadContext,
    batchJob: BatchRuntime,
    images: BatchImage[],
    settings: Record<string, unknown>,
    options: { sequenceOffset?: number } = {}
): Promise<BatchRunResult> {
    const imageList = Array.isArray(images) ? images : [];
    const indexedImages = deduplicateImages(
        context,
        batchJob,
        imageList,
        settings,
        Math.max(0, Math.floor(options.sequenceOffset ?? 0))
    );
    const totalImages = indexedImages.length;
    const results: BatchImageResult[] = [];
    const zip = new JSZip();
    const batchTimestamp = context.formatLocalTimestamp();
    const zipName = `PinPinto_${batchTimestamp}.zip`;
    const fetchImpl = context.fetchImpl ?? fetch;
    let completedImages = 0;

    if (totalImages === 0) {
        context.sendProgressUpdate(batchJob, 100, '未接收到可下载图片。');
        return emptyRunResult();
    }

    context.sendProgressUpdate(batchJob, 0, `开始处理 ${totalImages} 张图片。`);
    const parsedBatchSize = Number(settings.maxConcurrentDownloads);
    const batchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
        ? Math.floor(parsedBatchSize)
        : context.maxConcurrentDownloads;

    for (let index = 0; index < indexedImages.length; index += batchSize) {
        context.throwIfBatchCancelled(batchJob);
        const chunk = indexedImages.slice(index, index + batchSize);
        const chunkResults = await Promise.all(chunk.map(async (entry): Promise<BatchImageResult> => {
            const originalFilename = typeof entry.image === 'string'
                ? context.extractFilenameFromUrl(entry.sourceUrl)
                : entry.image.originalFilename || context.extractFilenameFromUrl(entry.sourceUrl);
            const filename = context.buildIndexedFilename(
                entry.sequence,
                batchTimestamp,
                entry.sourceUrl,
                originalFilename
            );

            try {
                const candidateUrls = context.getDownloadCandidateUrls(
                    entry.sourceUrl,
                    settings.highQuality !== false
                );
                const fetched = await fetchImageArrayBuffer(
                    context,
                    batchJob,
                    candidateUrls,
                    fetchImpl
                );
                context.throwIfBatchCancelled(batchJob);
                zip.file(filename, fetched.arrayBuffer);
                return {
                    imageId: entry.imageId,
                    sequence: entry.sequence,
                    sourceUrl: entry.sourceUrl,
                    resolvedUrl: fetched.resolvedUrl,
                    filename,
                    status: 'zip'
                };
            } catch (error) {
                if (context.isBatchCancellationError(error)) throw error;
                context.throwIfBatchCancelled(batchJob);

                try {
                    context.throwIfBatchCancelled(batchJob);
                    const fallback = await context.requestFallbackDownload({
                        jobId: batchJob.id,
                        image: entry.image,
                        sourceUrl: entry.sourceUrl,
                        filename,
                        settings
                    });
                    if (fallback.accepted && typeof fallback.downloadId === 'number') {
                        return {
                            imageId: entry.imageId,
                            sequence: entry.sequence,
                            sourceUrl: entry.sourceUrl,
                            filename,
                            downloadId: fallback.downloadId,
                            status: 'fallback-pending',
                            error: errorMessage(error)
                        };
                    }
                    return {
                        imageId: entry.imageId,
                        sequence: entry.sequence,
                        sourceUrl: entry.sourceUrl,
                        filename,
                        status: 'unresolved',
                        error: fallback.error || errorMessage(error)
                    };
                } catch (fallbackError) {
                    return {
                        imageId: entry.imageId,
                        sequence: entry.sequence,
                        sourceUrl: entry.sourceUrl,
                        filename,
                        status: 'unresolved',
                        error: errorMessage(fallbackError)
                    };
                }
            } finally {
                completedImages++;
                context.sendProgressUpdate(
                    batchJob,
                    (completedImages / totalImages) * 55,
                    `已处理 ${completedImages}/${totalImages} 张图片。`
                );
            }
        }));
        results.push(...chunkResults);
    }

    const zippedCount = results.filter((result) => result.status === 'zip').length;
    const fallbackResults = results.filter((result) => result.status === 'fallback-pending');
    const unresolvedCount = results.filter((result) => result.status === 'unresolved').length;
    let zipDownloadId: number | undefined;
    let zipFilename: string | undefined;

    if (zippedCount > 0) {
        context.sendProgressUpdate(batchJob, 60, '图片获取完成，正在压缩打包。');
        const zipBase64 = await zip.generateAsync(
            { type: 'base64', compression: 'STORE' },
            (metadata) => {
                context.throwIfBatchCancelled(batchJob);
                context.sendProgressUpdate(
                    batchJob,
                    60 + metadata.percent * 0.35,
                    `打包进度：${Math.round(metadata.percent)}%`
                );
            }
        );
        context.throwIfBatchCancelled(batchJob);
        zipFilename = buildZipDownloadPath(zipName);
        zipDownloadId = await chrome.downloads.download({
            url: `data:application/zip;base64,${zipBase64}`,
            filename: zipFilename,
            conflictAction: 'uniquify',
            saveAs: false
        });
        try {
            context.throwIfBatchCancelled(batchJob);
        } catch (error) {
            await chrome.downloads.cancel(zipDownloadId).catch(() => {});
            throw error;
        }
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
        fallbackDownloadIds: fallbackResults
            .map((result) => result.downloadId)
            .filter((downloadId): downloadId is number => typeof downloadId === 'number')
    };
}

function deduplicateImages(
    context: Pick<BatchDownloadContext, 'normalizeImageUrlForDeduplication' | 'throwIfBatchCancelled'>,
    batchJob: BatchRuntime,
    images: BatchImage[],
    settings: Record<string, unknown>,
    sequenceOffset: number
): IndexedImage[] {
    const seen = new Set<string>();
    const unique: IndexedImage[] = [];

    images.forEach((image, index) => {
        context.throwIfBatchCancelled(batchJob);
        const normalizedUrl = context.normalizeImageUrlForDeduplication(image, settings);
        const sourceUrl = typeof image === 'string' ? image : image?.url;
        if (!normalizedUrl || typeof sourceUrl !== 'string' || !sourceUrl || seen.has(normalizedUrl)) return;
        seen.add(normalizedUrl);
        unique.push({
            image,
            sequence: sequenceOffset + index + 1,
            sourceUrl,
            imageId: typeof image === 'string' ? `img_${index}` : image.id || `img_${index}`
        });
    });

    return unique;
}

async function fetchImageArrayBuffer(
    context: Pick<BatchDownloadContext, 'throwIfBatchCancelled' | 'isBatchCancellationError'>,
    batchJob: BatchRuntime,
    candidateUrls: string[],
    fetchImpl: typeof fetch
): Promise<{ arrayBuffer: ArrayBuffer; resolvedUrl: string }> {
    if (candidateUrls.length === 0) throw new Error('图片 URL 无效');
    let lastError: unknown = new Error('图片获取失败');

    for (const url of candidateUrls) {
        const controller = new AbortController();
        batchJob.controllers.add(controller);
        const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
        try {
            context.throwIfBatchCancelled(batchJob);
            const response = await fetchImpl(url, { cache: 'no-store', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const contentType = response.headers.get('content-type') || '';
            if (contentType && !contentType.startsWith('image/')) {
                throw new Error(`非图片响应: ${contentType}`);
            }
            const arrayBuffer = await response.arrayBuffer();
            if (arrayBuffer.byteLength === 0) throw new Error('图片内容为空');
            context.throwIfBatchCancelled(batchJob);
            return { arrayBuffer, resolvedUrl: url };
        } catch (error) {
            context.throwIfBatchCancelled(batchJob);
            if (context.isBatchCancellationError(error)) throw error;
            lastError = error instanceof Error && error.name === 'AbortError'
                ? new Error(`请求超时（>${IMAGE_FETCH_TIMEOUT_MS / 1000}秒）：${url}`)
                : error;
        } finally {
            clearTimeout(timeoutId);
            batchJob.controllers.delete(controller);
        }
    }

    throw new Error(`图片获取失败：${errorMessage(lastError)}`);
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
