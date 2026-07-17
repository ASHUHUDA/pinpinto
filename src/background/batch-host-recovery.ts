import type { BatchRunResult, BatchTaskSnapshot } from '../shared/batch-task';
import type { BlobJobHost, BlobJobResult } from './blob-runner';
import { buildZipDownloadPath } from './download-path';
import type { DownloadImage } from './batch-coordinator-types';

type FallbackResult = { accepted: boolean; downloadId?: number; error?: string };

type RecoveryContext = {
    blobHost: BlobJobHost;
    requestFallbackDownload: (request: {
        jobId: string;
        image: DownloadImage;
        sourceUrl: string;
        filename: string;
        settings: Record<string, unknown>;
    }) => Promise<FallbackResult>;
    recordRunResult: (jobId: string, result: BatchRunResult, settings: Record<string, unknown>) => Promise<void>;
};

export async function recoverCompletedHostWork(
    context: RecoveryContext,
    snapshot: BatchTaskSnapshot
): Promise<void> {
    const hostJobId = snapshot.activeWindow?.hostJobId;
    if (!hostJobId) throw new Error('后台恢复时 Blob 主机标识缺失。');
    const status = await context.blobHost.getStatus(hostJobId);
    if (status?.state !== 'completed') throw new Error('Blob host did not retain a completed result.');
    const result = await context.blobHost.result(hostJobId);
    await reattachHostResult(context, snapshot, result);
}

async function reattachHostResult(
    context: RecoveryContext,
    snapshot: BatchTaskSnapshot,
    blobResult: BlobJobResult
): Promise<void> {
    const fallbackIds: number[] = [];
    let unresolvedCount = 0;
    for (const failure of blobResult.failedEntries) {
        const fallback = await context.requestFallbackDownload({
            jobId: snapshot.jobId,
            image: failure.sourceUrl,
            sourceUrl: failure.sourceUrl,
            filename: failure.filename,
            settings: snapshot.settings
        });
        if (fallback.accepted && typeof fallback.downloadId === 'number') fallbackIds.push(fallback.downloadId);
        else unresolvedCount++;
    }

    let zipDownloadId: number | undefined;
    let zipFilename: string | undefined;
    if (blobResult.zippedEntries.length > 0) {
        if (!blobResult.objectUrl) throw new Error('Recovered Blob result has no object URL.');
        zipFilename = buildZipDownloadPath('PinPinto_recovered.zip');
        zipDownloadId = await chrome.downloads.download({
            url: blobResult.objectUrl,
            filename: zipFilename,
            conflictAction: 'uniquify',
            saveAs: false
        });
    }

    await context.recordRunResult(snapshot.jobId, {
        results: [],
        totalCount: blobResult.zippedEntries.length + blobResult.failedEntries.length,
        zippedCount: blobResult.zippedEntries.length,
        fallbackRequestedCount: fallbackIds.length,
        unresolvedCount,
        zipDownloadId,
        zipFilename,
        zipLeaseJobId: zipDownloadId === undefined ? undefined : blobResult.jobId,
        fallbackDownloadIds: fallbackIds
    }, snapshot.settings);
}
