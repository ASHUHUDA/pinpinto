import JSZip from 'jszip';

import { buildZipDownloadPath } from './download-path';

export const IMAGE_FETCH_MAX_RETRIES = 3;
export const IMAGE_FETCH_TIMEOUT_MS = 15000;

type BatchDownloadContext = {
    maxConcurrentDownloads: number;
    activeDownloads: Map<number, any>;
    createBatchJob: () => any;
    throwIfBatchCancelled: (batchJob: any) => void;
    isBatchCancellationError: (error: unknown) => boolean;
    sendProgressUpdate: (progress: number, details: string) => void;
    sendBatchComplete: (batchJob: any, results: any[]) => void;
    sendBatchError: (batchJob: any, error: string, results: any[]) => void;
    normalizeImageUrlForDeduplication: (image: any, settings: any) => string;
    getDownloadCandidateUrls: (rawUrl: string, highQualityEnabled: boolean) => string[];
    buildIndexedFilename: (sequence: number, timestamp: string, url: string, originalFilename?: string) => string;
    extractFilenameFromUrl: (url: string) => string;
    formatLocalTimestamp: () => string;
};

export async function runBatchDownload(
    context: BatchDownloadContext,
    images: any[],
    settings: any
) {
    const batchJob = context.createBatchJob();
    const imageList = Array.isArray(images) ? images : [];
    if (imageList.length === 0) {
        context.sendProgressUpdate(100, '未接收到可下载图片。');
        context.sendBatchComplete(batchJob, []);
        return [];
    }

    const uniqueImages = [];
    const currentBatchUrls = new Set<string>();
    let duplicateCount = 0;

    for (const image of imageList) {
        context.throwIfBatchCancelled(batchJob);
        const imageUrl = context.normalizeImageUrlForDeduplication(image, settings);
        if (!imageUrl) continue;

        if (!currentBatchUrls.has(imageUrl)) {
            currentBatchUrls.add(imageUrl);
            uniqueImages.push(image);
        } else {
            duplicateCount++;
        }
    }

    console.log(`Deduplication: Filtered out ${duplicateCount} duplicate images.`);
    images = uniqueImages;
    const totalImages = images.length;

    if (totalImages === 0) {
        context.sendProgressUpdate(100, '没有检测到新的图片，已全部去重。');
        context.sendBatchComplete(batchJob, []);
        return [];
    }

    const results = [];
    let completedImages = 0;
    let successfulImages = 0;
    let failedImages = 0;

    const batchTimestamp = context.formatLocalTimestamp();
    const zipName = `PinPinto_${batchTimestamp}.zip`;

    console.log(`Starting download of ${totalImages} images as ZIP: ${zipName}`);
    context.sendProgressUpdate(0, `开始打包 ${totalImages} 张图片，请稍候...`);

    const parsedBatchSize = Number(settings?.maxConcurrentDownloads);
    const batchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
        ? Math.floor(parsedBatchSize)
        : context.maxConcurrentDownloads;
    const zip = new JSZip();

    try {
        for (let i = 0; i < images.length; i += batchSize) {
            context.throwIfBatchCancelled(batchJob);

            const batch = images.slice(i, i + batchSize);
            const batchResults = await Promise.all(batch.map(async (image, batchIndex) => {
                try {
                    context.throwIfBatchCancelled(batchJob);

                    const sourceUrl = typeof image === 'string' ? image : image.url;
                    const candidateUrls = context.getDownloadCandidateUrls(sourceUrl, settings.highQuality !== false);
                    if (candidateUrls.length === 0) {
                        throw new Error('图片 URL 无效');
                    }

                    const { arrayBuffer, resolvedUrl } = await fetchImageArrayBuffer(
                        context,
                        batchJob,
                        candidateUrls,
                        IMAGE_FETCH_MAX_RETRIES
                    );
                    context.throwIfBatchCancelled(batchJob);

                    const imageData = {
                        url: resolvedUrl,
                        title: typeof image === 'string' ? `Image_${i + batchIndex + 1}` : (image.title || `Image_${i + batchIndex + 1}`),
                        board: typeof image === 'string' ? 'Pinterest' : (image.board || 'Pinterest'),
                        originalFilename: typeof image === 'string'
                            ? context.extractFilenameFromUrl(resolvedUrl)
                            : (image.originalFilename || context.extractFilenameFromUrl(resolvedUrl))
                    };

                    const imageSequence = successfulImages + 1;
                    const filename = context.buildIndexedFilename(
                        imageSequence,
                        batchTimestamp,
                        resolvedUrl,
                        imageData.originalFilename
                    );
                    zip.file(filename, arrayBuffer);

                    successfulImages++;
                    completedImages++;
                    const progress = (completedImages / totalImages) * 50;
                    context.sendProgressUpdate(progress, `已获取 ${completedImages}/${totalImages} 张图片`);

                    const imageId = typeof image === 'string' ? `img_${i + batchIndex}` : (image.id || `img_${i + batchIndex}`);
                    return { success: true, imageId };
                } catch (error) {
                    if (context.isBatchCancellationError(error)) {
                        throw error;
                    }

                    completedImages++;
                    failedImages++;
                    const progress = (completedImages / totalImages) * 50;
                    context.sendProgressUpdate(progress, `已处理 ${completedImages}/${totalImages} 张（失败 ${failedImages} 张）`);

                    const imageId = typeof image === 'string' ? `img_${i + batchIndex}` : (image.id || `img_${i + batchIndex}`);
                    const baseErrorMessage = error instanceof Error ? error.message : String(error);
                    return {
                        success: false,
                        error: `${baseErrorMessage}（已跳过）`,
                        imageId
                    };
                }
            }));

            results.push(...batchResults);
            context.throwIfBatchCancelled(batchJob);

            if (i + batchSize < images.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        if (successfulImages === 0) {
            const errorMessage = '图片下载全部失败，未生成压缩包。';
            context.sendProgressUpdate(100, errorMessage);
            context.sendBatchError(batchJob, errorMessage, results);
            return results;
        }

        context.sendProgressUpdate(60, '图片获取完成，正在压缩打包...');

        const zipBase64 = await zip.generateAsync(
            {
                type: 'base64',
                compression: 'STORE'
            },
            (metadata) => {
                context.throwIfBatchCancelled(batchJob);
                context.sendProgressUpdate(60 + metadata.percent * 0.35, `打包进度：${Math.round(metadata.percent)}%`);
            }
        );
        context.throwIfBatchCancelled(batchJob);

        context.sendProgressUpdate(95, '打包完成，正在触发下载...');

        const zipDataUrl = `data:application/zip;base64,${zipBase64}`;
        const zipDownloadFilename = buildZipDownloadPath(zipName);
        const downloadId = await chrome.downloads.download({
            url: zipDataUrl,
            filename: zipDownloadFilename,
            conflictAction: 'uniquify'
        });
        batchJob.activeDownloadIds.add(downloadId);

        context.activeDownloads.set(downloadId, {
            imageData: { title: zipName, url: 'local-zip' },
            settings,
            startTime: Date.now(),
            status: 'downloading',
            isBatch: true,
            jobId: batchJob.id,
            requestedFilename: zipDownloadFilename
        });
        context.throwIfBatchCancelled(batchJob);

        console.log(`ZIP download started with ID: ${downloadId}`);

        context.sendProgressUpdate(
            100,
            `ZIP 已开始下载，成功保存 ${results.filter(r => r.success).length}/${totalImages} 张图片。`
        );

        context.sendBatchComplete(batchJob, results);
        return results;
    } catch (error) {
        if (context.isBatchCancellationError(error)) {
            return [];
        }

        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error('Error generating or downloading ZIP:', error);
        context.sendProgressUpdate(100, `打包下载失败：${errorMessage}`);
        context.sendBatchError(batchJob, errorMessage, results);
        return results;
    }
}

async function fetchImageArrayBuffer(
    context: Pick<BatchDownloadContext, 'throwIfBatchCancelled' | 'isBatchCancellationError'>,
    batchJob: any,
    candidateUrls: string[],
    maxRetries = IMAGE_FETCH_MAX_RETRIES
) {
    let lastError = new Error('图片获取失败');

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        for (const url of candidateUrls) {
            try {
                context.throwIfBatchCancelled(batchJob);
                const controller = new AbortController();
                batchJob.controllers.add(controller);

                const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
                const response = await fetch(url, {
                    cache: 'no-store',
                    signal: controller.signal
                }).finally(() => {
                    clearTimeout(timeoutId);
                    batchJob.controllers.delete(controller);
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }

                const contentType = response.headers.get('content-type') || '';
                if (contentType && !contentType.startsWith('image/')) {
                    throw new Error(`非图片响应: ${contentType}`);
                }

                const arrayBuffer = await response.arrayBuffer();
                if (arrayBuffer.byteLength === 0) {
                    throw new Error('图片内容为空');
                }

                context.throwIfBatchCancelled(batchJob);
                return { arrayBuffer, resolvedUrl: url };
            } catch (error) {
                if (context.isBatchCancellationError(error) || (error instanceof Error && error.name === 'AbortError' && batchJob.cancelled === true)) {
                    throw new Error('PINPINTO_BATCH_CANCELLED');
                }
                if (error instanceof Error && error.name === 'AbortError') {
                    lastError = new Error(`请求超时（>${IMAGE_FETCH_TIMEOUT_MS / 1000}秒）：${url}`);
                } else {
                    lastError = error instanceof Error ? error : new Error(String(error));
                }
            }
        }

        if (attempt < maxRetries) {
            await new Promise((resolve) => setTimeout(resolve, attempt * 300));
        }
    }

    const lastMessage = lastError?.message || '未知错误';
    throw new Error(`图片获取失败（已重试 ${maxRetries} 次）：${lastMessage}`);
}
