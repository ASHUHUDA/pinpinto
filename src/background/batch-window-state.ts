import { createDownloadSettlement, type DownloadSettlement } from './download-settlement';
import type { DownloadImage } from './batch-coordinator-types';
import type { ActiveBatchWindow, BatchTaskSnapshot } from '../shared/batch-task';

export function createActiveWindow(snapshot: BatchTaskSnapshot, request: {
    images: DownloadImage[];
    startIndex: number;
    endIndex: number;
    finalWindow: boolean;
}): ActiveBatchWindow {
    const hostJobId = request.images.length > 0
        ? `${snapshot.jobId}:zip:${request.startIndex}:${request.images.length}`
        : null;
    return {
        windowId: `${snapshot.jobId}:${request.startIndex}:${request.endIndex}`,
        startOffset: request.startIndex,
        endOffset: request.endIndex,
        finalWindow: request.finalWindow,
        expectedDownloadIds: [],
        downloadStates: {},
        totalCount: request.images.length,
        zippedCount: 0,
        fallbackCount: 0,
        unresolvedCount: 0,
        hostJobId,
        hostState: hostJobId ? 'fetching' : 'idle',
        contentCommitState: {
            state: snapshot.mode === 'auto' ? 'pending' : 'acknowledged',
            startOffset: request.startIndex,
            endOffset: request.endIndex,
            acknowledgedBaseOffset: snapshot.mode === 'auto' ? null : request.endIndex,
            retainedCount: null
        }
    };
}

export function windowSettlement(window: ActiveBatchWindow): DownloadSettlement {
    return createDownloadSettlement(Object.values(window.downloadStates));
}

export function applySettlement(window: ActiveBatchWindow, settlement: DownloadSettlement): ActiveBatchWindow {
    return {
        ...window,
        expectedDownloadIds: Object.values(settlement.downloads)
            .map((entry) => entry.downloadId)
            .sort((left, right) => left - right),
        downloadStates: settlement.downloads
    };
}

export function uniqueNumbers(values: number[]): number[] {
    return [...new Set(values.filter((value) => Number.isInteger(value)))];
}

export function integerOr(...values: Array<number | undefined>): number {
    const value = values.find((candidate) => Number.isFinite(candidate));
    return Math.max(0, Math.floor(value ?? 0));
}
