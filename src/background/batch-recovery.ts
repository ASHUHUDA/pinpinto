import { isTerminalBatchPhase, type BatchTaskSnapshot } from '../shared/batch-task';
import type { BatchCoordinatorHost } from './batch-coordinator-types';
import type { BlobJobHost } from './blob-runner';

const SINGLE_BLOB_JOB_PREFIX = 'single:';

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
    const referenced = collectReferencedBatchBlobJobs(snapshot);
    const activeJobs = await host.blobHost.listActiveJobs().catch(() => []);
    await Promise.all(activeJobs.filter((jobId) => (
        !jobId.startsWith(SINGLE_BLOB_JOB_PREFIX) && !referenced.has(jobId)
    )).map(async (jobId) => {
        await host.blobHost.cancel(jobId).catch(() => {});
        await host.blobHost.release(jobId).catch(() => {});
    }));
}

export async function cleanupOrphanSingleBlobJobs(
    blobHost: BlobJobHost,
    referencedJobIds: Iterable<string>
): Promise<void> {
    const referenced = new Set(referencedJobIds);
    const activeJobs = await blobHost.listActiveJobs().catch(() => []);
    await Promise.all(activeJobs.filter((jobId) => (
        jobId.startsWith(SINGLE_BLOB_JOB_PREFIX) && !referenced.has(jobId)
    )).map(async (jobId) => {
        await blobHost.cancel(jobId).catch(() => {});
        await blobHost.release(jobId).catch(() => {});
    }));
}

function collectReferencedBatchBlobJobs(snapshot: BatchTaskSnapshot | null): Set<string> {
    const referenced = new Set<string>();
    if (!snapshot || isTerminalBatchPhase(snapshot.phase) || !snapshot.activeWindow) return referenced;

    if (snapshot.activeWindow.hostJobId) referenced.add(snapshot.activeWindow.hostJobId);
    for (const download of Object.values(snapshot.activeWindow.downloadStates)) {
        if (download.state === 'pending' && download.blobLeaseJobId) {
            referenced.add(download.blobLeaseJobId);
        }
    }
    for (const entry of snapshot.activeWindow.individualQueue ?? []) {
        if ((entry.state === 'preparing' || entry.state === 'pending') && entry.blobLeaseJobId) {
            referenced.add(entry.blobLeaseJobId);
        }
    }
    return referenced;
}
