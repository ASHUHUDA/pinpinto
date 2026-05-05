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

export type AutoBatchPlan = {
    shouldStart: boolean;
    startIndex: number;
    endIndex: number;
    partial: boolean;
};

export function getAutoBatchPlan(
    totalImages: number,
    nextBatchStartIndex: number,
    autoBatchEnabled: boolean,
    options: { autoScrollExhausted?: boolean; limit?: number } = {}
): AutoBatchPlan {
    const limit = options.limit ?? AUTO_BATCH_DOWNLOAD_LIMIT;
    const startIndex = Math.max(0, Math.floor(nextBatchStartIndex));

    if (autoBatchEnabled !== true || totalImages <= startIndex || limit <= 0) {
        return {
            shouldStart: false,
            startIndex,
            endIndex: startIndex,
            partial: false
        };
    }

    const fullBatchEndIndex = startIndex + limit;
    if (totalImages >= fullBatchEndIndex) {
        return {
            shouldStart: true,
            startIndex,
            endIndex: fullBatchEndIndex,
            partial: false
        };
    }

    if (options.autoScrollExhausted === true) {
        return {
            shouldStart: true,
            startIndex,
            endIndex: totalImages,
            partial: true
        };
    }

    return {
        shouldStart: false,
        startIndex,
        endIndex: startIndex,
        partial: false
    };
}

export function sliceBatchWindowFromIndex<T>(
    images: T[],
    startIndex: number,
    endIndex: number
): T[] {
    const start = Math.max(0, Math.floor(startIndex));
    const end = Math.max(start, Math.floor(endIndex));

    if (start >= images.length) {
        return [];
    }

    return images.slice(start, Math.min(end, images.length));
}
