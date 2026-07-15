export type BatchTaskMode = 'manual' | 'auto';

export type BatchTaskPhase =
    | 'queued'
    | 'scrolling'
    | 'waiting-for-batch'
    | 'fetching'
    | 'compressing'
    | 'downloading'
    | 'completed'
    | 'failed'
    | 'cancelled'
    | 'interrupted';

export type BatchImageStatus =
    | 'zip'
    | 'fallback-pending'
    | 'fallback-complete'
    | 'unresolved';

export type BatchImageResult = {
    imageId: string;
    sequence: number;
    sourceUrl: string;
    status: BatchImageStatus;
    filename?: string;
    resolvedUrl?: string;
    downloadId?: number;
    error?: string;
};

export type BatchRunResult = {
    results: BatchImageResult[];
    totalCount: number;
    zippedCount: number;
    fallbackRequestedCount: number;
    unresolvedCount: number;
    zipDownloadId?: number;
    zipFilename?: string;
    zipLeaseJobId?: string;
    fallbackDownloadIds: number[];
};

export type ActiveWindowDownload = {
    downloadId: number;
    kind: 'zip' | 'fallback';
    state: 'pending' | 'complete' | 'interrupted' | 'missing';
    blobLeaseJobId?: string;
};

export type ActiveBatchWindow = {
    windowId: string;
    startOffset: number;
    endOffset: number;
    finalWindow: boolean;
    expectedDownloadIds: number[];
    downloadStates: Record<string, ActiveWindowDownload>;
    totalCount: number;
    zippedCount: number;
    fallbackCount: number;
    unresolvedCount: number;
    hostJobId: string | null;
    hostState: 'idle' | 'fetching' | 'compressing' | 'blob-ready' | 'released';
    contentCommitState: {
        state: 'pending' | 'acknowledged' | 'failed';
        startOffset: number;
        endOffset: number;
        acknowledgedBaseOffset: number | null;
        retainedCount: number | null;
        error?: string;
    };
};

export type BatchTaskSnapshot = {
    jobId: string;
    mode: BatchTaskMode;
    targetTabId: number | null;
    phase: BatchTaskPhase;
    batchCursor: number;
    progress: number;
    details: string;
    totalImages: number;
    zippedCount: number;
    fallbackCount: number;
    unresolvedCount: number;
    associatedDownloadIds: number[];
    pendingFallbackDownloadIds: number[];
    activeWindow: ActiveBatchWindow | null;
    autoSessionFinished: boolean;
    autoBatchLimit: number;
    settings: Record<string, unknown>;
    createdAt: number;
    updatedAt: number;
};

export type BatchStartResult = {
    accepted: boolean;
    jobId: string;
    reason?: 'batch-task-running';
};

export function isTerminalBatchPhase(phase: BatchTaskPhase): boolean {
    return phase === 'completed'
        || phase === 'failed'
        || phase === 'cancelled'
        || phase === 'interrupted';
}
