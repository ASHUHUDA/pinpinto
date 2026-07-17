import { isTerminalBatchPhase } from '../shared/batch-task';
import type { BatchCoordinatorHost } from './batch-coordinator-types';
import { BatchTaskManager } from './batch-task-manager';
import { uniqueNumbers } from './batch-window-state';
import {
    IndividualDownloadQueue,
    type IndividualQueueDownloadEvent,
    type IndividualQueueImageCompleteEvent,
    type IndividualQueueSummary,
    type IndividualQueueTerminalEvent
} from './individual-download-queue';
import { sendTabMessage } from './tab-messaging';

type BatchIndividualQueueOptions = {
    host: BatchCoordinatorHost;
    taskManager: BatchTaskManager;
    addRuntimeDownloadId: (downloadId: number) => void;
    removeRuntimeDownloadId: (downloadId: number) => void;
    markIdle: () => void;
};

export function createBatchIndividualDownloadQueue(options: BatchIndividualQueueOptions): IndividualDownloadQueue {
    return new IndividualDownloadQueue({
        blobHost: options.host.blobHost,
        getSnapshot: () => options.taskManager.getSnapshot(),
        mutateSnapshot: (jobId, updater) => options.taskManager.mutate(jobId, updater),
        normalizeImageUrlForDeduplication: options.host.normalizeImageUrlForDeduplication,
        getDownloadCandidateUrls: options.host.getDownloadCandidateUrls,
        buildIndexedFilename: options.host.buildIndexedFilename,
        extractFilenameFromUrl: options.host.extractFilenameFromUrl,
        formatLocalTimestamp: options.host.formatLocalTimestamp,
        requestDownload: ({ url, requestedFilename }) => {
            options.host.rememberRequestedFilename?.(url, requestedFilename);
            return chrome.downloads.download({ url, filename: requestedFilename, conflictAction: 'uniquify', saveAs: false });
        },
        cancelDownload: (downloadId) => chrome.downloads.cancel(downloadId),
        searchDownload: (downloadId) => chrome.downloads.search({ id: downloadId }),
        onDownloadRegistered: (event) => registerIndividualDownload(options, event),
        onDownloadSettled: (event) => removeIndividualDownload(options, event),
        onImageComplete: (event) => settleIndividualImage(options, event),
        onQueueFinished: (summary) => finalizeIndividualQueue(options, summary)
    });
}

async function registerIndividualDownload(
    options: BatchIndividualQueueOptions,
    event: IndividualQueueDownloadEvent
): Promise<void> {
    options.addRuntimeDownloadId(event.downloadId);
    const snapshot = options.taskManager.getSnapshot();
    options.host.activeDownloads.set(event.downloadId, {
        imageData: { id: event.entry.imageId, url: event.entry.sourceUrl },
        settings: snapshot?.settings ?? {},
        startTime: Date.now(),
        status: 'downloading',
        isBatch: true,
        batchKind: 'individual',
        blobLeaseJobId: event.blobLeaseJobId,
        jobId: event.jobId,
        imageId: event.entry.imageId,
        requestedFilename: event.requestedFilename
    });
    await options.taskManager.mutate(event.jobId, (current) => ({
        associatedDownloadIds: uniqueNumbers([...current.associatedDownloadIds, event.downloadId])
    }));
}

async function removeIndividualDownload(
    options: BatchIndividualQueueOptions,
    event: IndividualQueueTerminalEvent
): Promise<void> {
    options.host.activeDownloads.delete(event.downloadId);
    options.removeRuntimeDownloadId(event.downloadId);
    const snapshot = options.taskManager.getSnapshot();
    if (!snapshot) return;
    await options.taskManager.mutate(snapshot.jobId, (current) => ({
        associatedDownloadIds: current.associatedDownloadIds.filter((id) => id !== event.downloadId)
    }));
}

async function settleIndividualImage(
    options: BatchIndividualQueueOptions,
    event: IndividualQueueImageCompleteEvent
): Promise<void> {
    const snapshot = options.taskManager.getSnapshot();
    if (!snapshot || snapshot.jobId !== event.jobId || snapshot.targetTabId === null) return;
    await sendTabMessage(snapshot.targetTabId, {
        action: 'settleSingleDownload',
        imageId: event.imageId,
        state: 'complete'
    });
}

async function finalizeIndividualQueue(
    options: BatchIndividualQueueOptions,
    summary: IndividualQueueSummary
): Promise<void> {
    const snapshot = options.taskManager.getSnapshot();
    if (!snapshot || snapshot.jobId !== summary.jobId || isTerminalBatchPhase(snapshot.phase)) return;
    await options.taskManager.update(summary.jobId, { activeWindow: null, progress: 100 });
    const cleared = await options.taskManager.clearCompleted(summary.jobId, {
        progress: 100,
        details: `逐张下载完成：成功 ${summary.success}，失败 ${summary.failed}，取消 ${summary.cancelled}。`
    });
    if (cleared) options.markIdle();
}
