import { isTerminalBatchPhase, type BatchTaskSnapshot } from '../shared/batch-task';
import type { BatchCoordinatorHost } from './batch-coordinator-types';

export function restoreTrackedDownloads(host: BatchCoordinatorHost, snapshot: BatchTaskSnapshot): void {
    const activeWindow = snapshot.activeWindow;
    if (!activeWindow) return;
    for (const download of Object.values(activeWindow.downloadStates)) {
        if (download.state !== 'pending') continue;
        host.activeDownloads.set(download.downloadId, {
            imageData: { title: `Restored ${download.kind} download`, url: 'restored' },
            settings: snapshot.settings,
            startTime: snapshot.updatedAt,
            status: 'downloading',
            isBatch: true,
            batchKind: download.kind,
            blobLeaseJobId: download.blobLeaseJobId,
            jobId: snapshot.jobId
        });
    }
}

export async function cleanupOrphanBlobJobs(
    host: BatchCoordinatorHost,
    snapshot: BatchTaskSnapshot | null
): Promise<void> {
    const referenced = snapshot && !isTerminalBatchPhase(snapshot.phase)
        ? snapshot.activeWindow?.hostJobId
        : undefined;
    const activeJobs = await host.blobHost.listActiveJobs().catch(() => []);
    await Promise.all(activeJobs.filter((jobId) => jobId !== referenced).map(async (jobId) => {
        await host.blobHost.cancel(jobId).catch(() => {});
        await host.blobHost.release(jobId).catch(() => {});
    }));
}
