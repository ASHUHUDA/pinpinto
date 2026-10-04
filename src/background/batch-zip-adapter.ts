import { runBatchDownload } from './batch-download';
import { isBatchCancellationError, throwIfBatchJobCancelled, type BatchJobState } from './batch-job';
import { BatchTaskManager } from './batch-task-manager';
import type { BatchCoordinatorHost, DownloadImage } from './batch-coordinator-types';
import { isTerminalBatchPhase } from '../shared/batch-task';

export function runCoordinatorZipWindow(context: {
    host: BatchCoordinatorHost;
    taskManager: BatchTaskManager;
    runtime: BatchJobState & { controllers: Set<AbortController> };
    requestFallbackDownload: Parameters<typeof runBatchDownload>[0]['requestFallbackDownload'];
}, images: DownloadImage[], settings: Record<string, unknown>, sequenceOffset: number) {
    const { host, taskManager, runtime } = context;
    return runBatchDownload({
        blobHost: host.blobHost,
        maxConcurrentDownloads: host.maxConcurrentDownloads,
        requestFallbackDownload: context.requestFallbackDownload,
        throwIfBatchCancelled: throwIfBatchJobCancelled,
        isBatchCancellationError,
        sendProgressUpdate: (job, progress, details) => {
            const current = taskManager.getSnapshot();
            if (!current || current.jobId !== job.id || isTerminalBatchPhase(current.phase)) return;
            const phase = progress < 60 ? 'fetching' : progress < 100 ? 'compressing' : 'downloading';
            void taskManager.mutate(job.id, (latest) => ({
                phase,
                progress,
                details,
                activeWindow: latest.activeWindow ? {
                    ...latest.activeWindow,
                    hostState: phase === 'fetching' ? 'fetching' : phase === 'compressing' ? 'compressing' : latest.activeWindow.hostState
                } : null
            }));
        },
        normalizeImageUrlForDeduplication: host.normalizeImageUrlForDeduplication,
        getDownloadCandidateUrls: host.getDownloadCandidateUrls,
        buildIndexedFilename: host.buildIndexedFilename,
        extractFilenameFromUrl: host.extractFilenameFromUrl,
        formatLocalTimestamp: host.formatLocalTimestamp,
        rememberRequestedFilename: host.rememberRequestedFilename
    }, runtime, images, settings, { sequenceOffset });
}
