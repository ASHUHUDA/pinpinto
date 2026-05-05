export const AUTO_BATCH_DOWNLOAD_LIMIT = 100;

export function getNextBatchThreshold(
    batchCount: number,
    limit = AUTO_BATCH_DOWNLOAD_LIMIT
): number {
    return (batchCount + 1) * limit;
}

export function shouldTriggerAutoBatch(
    totalImages: number,
    batchCount: number,
    autoBatchEnabled: boolean,
    limit = AUTO_BATCH_DOWNLOAD_LIMIT
): boolean {
    return autoBatchEnabled === true && totalImages >= getNextBatchThreshold(batchCount, limit);
}

export function sliceBatchWindow<T>(
    images: T[],
    batchCount: number,
    limit = AUTO_BATCH_DOWNLOAD_LIMIT
): T[] {
    const windowStart = batchCount * limit;
    if (windowStart < images.length) {
        return images.slice(windowStart, windowStart + limit);
    }

    return images.slice(-limit);
}
