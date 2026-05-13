export const PINPINTO_BATCH_CANCELLED = 'PINPINTO_BATCH_CANCELLED';

export type BatchJobState = {
    id: number;
    cancelled: boolean;
    notified: boolean;
    activeDownloadIds: Set<number>;
};

export function createBatchJobState(id: number): BatchJobState {
    return {
        id,
        cancelled: false,
        notified: false,
        activeDownloadIds: new Set()
    };
}

export function cancelBatchJobState(job: BatchJobState) {
    job.cancelled = true;
}

export function markBatchJobNotified(job: BatchJobState) {
    job.notified = true;
}

export function isBatchJobCancelled(job: BatchJobState | null | undefined): boolean {
    return job?.cancelled === true;
}

export function shouldSkipBatchOutcome(job: BatchJobState | null | undefined): boolean {
    return job?.cancelled === true;
}

export function throwIfBatchJobCancelled(job: BatchJobState | null | undefined) {
    if (isBatchJobCancelled(job)) {
        throw new Error(PINPINTO_BATCH_CANCELLED);
    }
}

export function isBatchCancellationError(error: unknown): boolean {
    return error instanceof Error && error.message === PINPINTO_BATCH_CANCELLED;
}
