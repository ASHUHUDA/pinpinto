import { buildSingleDownloadPath } from './download-path';
import { rememberBounded } from './early-terminal-buffer';
import type { BlobJobEntry, BlobJobHost } from './blob-runner';
import type { DownloadImage } from './batch-coordinator-types';
import type { DownloadTerminalState } from './download-settlement';
import type { BatchTaskSnapshot, IndividualDownloadEntry } from '../shared/batch-task';

export const INDIVIDUAL_DOWNLOAD_CONCURRENCY = 3;

export type IndividualQueueSummary = {
    jobId: string;
    total: number;
    success: number;
    failed: number;
    cancelled: number;
};

export type IndividualQueueDownloadRequest = {
    jobId: string;
    entry: IndividualDownloadEntry;
    url: string;
    requestedFilename: string;
    blobLeaseJobId: string;
};

export type IndividualQueueDownloadEvent = {
    jobId: string;
    entry: IndividualDownloadEntry;
    downloadId: number;
    requestedFilename: string;
    blobLeaseJobId: string;
};

export type IndividualQueueTerminalEvent = {
    jobId: string;
    entry: IndividualDownloadEntry;
    downloadId: number;
    state: DownloadTerminalState;
    error?: string;
};

export type IndividualQueueImageCompleteEvent = {
    jobId: string;
    imageId: string;
    downloadId: number;
};

export type IndividualDownloadQueueDependencies = {
    blobHost: BlobJobHost;
    getSnapshot: () => BatchTaskSnapshot | null;
    mutateSnapshot: (
        jobId: string,
        updater: (snapshot: BatchTaskSnapshot) => Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>
    ) => Promise<BatchTaskSnapshot | null>;
    normalizeImageUrlForDeduplication: (image: DownloadImage, settings: Record<string, unknown>) => string;
    getDownloadCandidateUrls: (rawUrl: string, highQualityEnabled: boolean) => string[];
    buildIndexedFilename: (
        sequence: number,
        timestamp: string,
        url: string,
        originalFilename?: string
    ) => string;
    extractFilenameFromUrl: (url: string) => string;
    formatLocalTimestamp: () => string;
    requestDownload: (request: IndividualQueueDownloadRequest) => Promise<number>;
    cancelDownload: (downloadId: number) => Promise<void>;
    searchDownload?: (downloadId: number) => Promise<Array<{ id?: number; state?: string; error?: string }>>;
    onDownloadRegistered?: (event: IndividualQueueDownloadEvent) => void | Promise<void>;
    onDownloadSettled?: (event: IndividualQueueTerminalEvent) => void | Promise<void>;
    onImageComplete?: (event: IndividualQueueImageCompleteEvent) => void | Promise<void>;
    onQueueFinished?: (summary: IndividualQueueSummary) => void | Promise<void>;
};

export type IndividualQueueStartRequest = {
    jobId: string;
    images: DownloadImage[];
    settings: Record<string, unknown>;
    sequenceOffset?: number;
};

type BufferedTerminal = {
    state: DownloadTerminalState;
    error?: string;
};

type PreparationFailure = {
    jobId: string;
    entry: IndividualDownloadEntry;
    downloadId?: number;
    error: string;
};

export class IndividualDownloadQueue {
    private readonly dependencies: IndividualDownloadQueueDependencies;
    private readonly earlyTerminals = new Map<number, BufferedTerminal>();
    private readonly settledDownloadIds = new Set<number>();
    private readonly cancelledDownloadIds = new Set<number>();
    private readonly releasedLeases = new Set<string>();
    private readonly cancelledJobs = new Set<string>();
    private readonly finishedJobs = new Set<string>();
    private readonly inFlightPreparations = new Map<string, Set<Promise<void>>>();
    private operationQueue: Promise<unknown> = Promise.resolve();

    constructor(dependencies: IndividualDownloadQueueDependencies) {
        this.dependencies = dependencies;
    }

    async start(request: IndividualQueueStartRequest): Promise<void> {
        const entries = indexImages(this.dependencies, request);
        let initialized = false;
        await this.enqueue(async () => {
            await this.dependencies.mutateSnapshot(request.jobId, (snapshot) => {
                if (!snapshot.activeWindow || snapshot.activeWindow.individualQueue.length > 0) return {};
                initialized = true;
                return queuePatch(snapshot, entries);
            });
        });
        if (!initialized) {
            await this.pump(request.jobId);
            await this.finishIfDrained(request.jobId);
            return;
        }
        await this.pump(request.jobId);
    }

    async recover(jobId: string): Promise<void> {
        const cleanup: Array<{ leaseJobId: string; cancel: boolean }> = [];
        const terminalEntries: IndividualDownloadEntry[] = [];
        await this.enqueue(async () => {
            await this.dependencies.mutateSnapshot(jobId, (snapshot) => {
                if (!snapshot.activeWindow) return {};
                const queue = snapshot.activeWindow.individualQueue.map((entry) => {
                    if (isTerminalEntry(entry)) {
                        if (entry.blobLeaseJobId) cleanup.push({ leaseJobId: entry.blobLeaseJobId, cancel: false });
                        terminalEntries.push(entry);
                        return entry;
                    }
                    if (entry.state === 'preparing' || (entry.state === 'pending' && !hasDownloadId(entry))) {
                        if (entry.blobLeaseJobId) cleanup.push({ leaseJobId: entry.blobLeaseJobId, cancel: true });
                        return {
                            ...entry,
                            state: 'queued' as const,
                            downloadId: undefined,
                            blobLeaseJobId: undefined,
                            error: undefined
                        };
                    }
                    return entry;
                });
                return queuePatch(snapshot, queue);
            });
        });

        for (const item of cleanup) await this.cleanupLease(item.leaseJobId, item.cancel);
        for (const entry of terminalEntries) {
            if (hasDownloadId(entry)) {
                this.settledDownloadIds.add(entry.downloadId);
                await callSafely(this.dependencies.onDownloadSettled, terminalEvent(jobId, entry, entryStateToTerminal(entry)));
            }
        }

        const pending = this.currentQueue(jobId).filter((entry) => entry.state === 'pending' && hasDownloadId(entry));
        for (const entry of pending) {
            try {
                const items = await this.searchDownload(entry.downloadId);
                const item = items[0];
                if (item?.state === 'complete' || item?.state === 'interrupted') {
                    await this.handleTerminal(entry.downloadId, item.state, item.error);
                } else if (!item) {
                    await this.handleTerminal(
                        entry.downloadId,
                        'missing',
                        'Browser download record is missing after restart.'
                    );
                }
            } catch {
                // A future browser terminal event remains authoritative if search is temporarily unavailable.
            }
        }

        await this.pump(jobId);
        await this.finishIfDrained(jobId);
    }

    async handleTerminal(
        downloadId: number,
        state: DownloadTerminalState,
        error?: string
    ): Promise<void> {
        const settled = await this.enqueue(async () => {
            if (this.settledDownloadIds.has(downloadId)) return null;
            const snapshot = this.dependencies.getSnapshot();
            const entry = snapshot?.activeWindow?.individualQueue.find((candidate) =>
                candidate.downloadId === downloadId && candidate.state === 'pending');
            if (!snapshot || !entry) {
                rememberBounded(this.earlyTerminals, downloadId, { state, error });
                return null;
            }

            this.settledDownloadIds.add(downloadId);
            const nextState = state === 'complete' ? 'complete' : 'failed';
            let updatedEntry: IndividualDownloadEntry | null = null;
            await this.dependencies.mutateSnapshot(snapshot.jobId, (current) => {
                if (!current.activeWindow) return {};
                const queue = current.activeWindow.individualQueue.map((candidate) => {
                    if (candidate.downloadId !== downloadId || candidate.state !== 'pending') return candidate;
                    updatedEntry = {
                        ...candidate,
                        state: nextState,
                        error: nextState === 'failed' ? error || terminalError(state) : undefined
                    };
                    return updatedEntry;
                });
                return queuePatch(current, queue);
            });
            return updatedEntry ? { jobId: snapshot.jobId, entry: updatedEntry, state, error } : null;
        });
        if (!settled) return;

        if (settled.entry.blobLeaseJobId) await this.cleanupLease(settled.entry.blobLeaseJobId, false);
        await callSafely(this.dependencies.onDownloadSettled, {
            jobId: settled.jobId,
            entry: settled.entry,
            downloadId,
            state,
            error
        });
        if (state === 'complete') {
            await callSafely(this.dependencies.onImageComplete, {
                jobId: settled.jobId,
                imageId: settled.entry.imageId,
                downloadId
            });
        }
        await this.pump(settled.jobId);
        await this.finishIfDrained(settled.jobId);
    }

    async cancel(jobId: string, finalize = true): Promise<void> {
        this.cancelledJobs.add(jobId);
        const downloads: Array<IndividualDownloadEntry & { downloadId: number }> = [];
        const leases = new Set<string>();
        await this.enqueue(async () => {
            await this.dependencies.mutateSnapshot(jobId, (snapshot) => {
                if (!snapshot.activeWindow) return {};
                const queue = snapshot.activeWindow.individualQueue.map((entry) => {
                    if (isTerminalEntry(entry)) return entry;
                    if (hasDownloadId(entry)) {
                        downloads.push(entry);
                        this.settledDownloadIds.add(entry.downloadId);
                    }
                    if (entry.blobLeaseJobId) leases.add(entry.blobLeaseJobId);
                    return { ...entry, state: 'cancelled' as const, error: undefined };
                });
                return queuePatch(snapshot, queue);
            });
        });

        await Promise.allSettled(downloads.map(async (entry) => {
            await this.cancelDownload(entry.downloadId);
            await callSafely(this.dependencies.onDownloadSettled, terminalEvent(jobId, entry, 'missing'));
        }));
        await Promise.allSettled([...leases].map((leaseJobId) => this.cleanupLease(leaseJobId, true)));
        await Promise.allSettled([...this.currentPreparations(jobId)]);
        await this.cleanupCancelledRemainders(jobId);
        if (finalize) await this.finishIfDrained(jobId);
    }

    private async pump(jobId: string): Promise<void> {
        if (this.cancelledJobs.has(jobId) || this.finishedJobs.has(jobId)) return;
        const selected = await this.enqueue(async () => {
            if (this.cancelledJobs.has(jobId)) return [];
            const snapshot = this.dependencies.getSnapshot();
            if (!snapshot?.activeWindow || snapshot.jobId !== jobId) return [];
            const queue = snapshot.activeWindow.individualQueue;
            const occupied = queue.filter((entry) => entry.state === 'preparing' || entry.state === 'pending').length;
            const capacity = Math.max(0, INDIVIDUAL_DOWNLOAD_CONCURRENCY - occupied);
            if (capacity === 0) return [];
            const selectedSequences = new Set(
                queue.filter((entry) => entry.state === 'queued').slice(0, capacity).map((entry) => entry.sequence)
            );
            if (selectedSequences.size === 0) return [];
            let selectedEntries: IndividualDownloadEntry[] = [];
            await this.dependencies.mutateSnapshot(jobId, (current) => {
                if (!current.activeWindow) return {};
                const nextQueue = current.activeWindow.individualQueue.map((entry) => {
                    if (!selectedSequences.has(entry.sequence) || entry.state !== 'queued') return entry;
                    const preparing = {
                        ...entry,
                        state: 'preparing' as const,
                        blobLeaseJobId: fileJobId(jobId, entry.sequence),
                        downloadId: undefined,
                        error: undefined
                    };
                    selectedEntries.push(preparing);
                    return preparing;
                });
                return queuePatch(current, nextQueue);
            });
            return selectedEntries;
        });

        for (const entry of selected) this.launchPreparation(jobId, entry);
        await this.finishIfDrained(jobId);
    }

    private launchPreparation(jobId: string, entry: IndividualDownloadEntry): void {
        const preparations = this.inFlightPreparations.get(jobId) ?? new Set<Promise<void>>();
        this.inFlightPreparations.set(jobId, preparations);
        let operation: Promise<void>;
        operation = this.prepare(jobId, entry).finally(() => {
            preparations.delete(operation);
            if (preparations.size === 0) this.inFlightPreparations.delete(jobId);
        });
        preparations.add(operation);
    }

    private async prepare(jobId: string, entry: IndividualDownloadEntry): Promise<void> {
        const leaseJobId = entry.blobLeaseJobId ?? fileJobId(jobId, entry.sequence);
        let downloadId: number | undefined;
        try {
            await this.dependencies.blobHost.start({
                jobId: leaseJobId,
                output: 'file',
                entries: [toBlobEntry(entry)],
                maxConcurrency: 1
            });
            const result = await this.dependencies.blobHost.result(leaseJobId);
            if (this.cancelledJobs.has(jobId)) return;
            const failure = result.failedEntries[0];
            if (failure) throw new Error(failure.error);
            if (!result.objectUrl || result.zippedEntries.length !== 1) {
                throw new Error('File Blob job completed without one downloadable image.');
            }

            const requestedFilename = buildSingleDownloadPath(entry.filename);
            downloadId = await this.dependencies.requestDownload({
                jobId,
                entry,
                url: result.objectUrl,
                requestedFilename,
                blobLeaseJobId: leaseJobId
            });
            if (!Number.isInteger(downloadId)) throw new Error('Browser download did not return a valid ID.');
            if (this.cancelledJobs.has(jobId)) {
                await this.cancelDownload(downloadId);
                return;
            }

            const pending = await this.markPending(jobId, entry.sequence, downloadId, leaseJobId);
            if (!pending) {
                await this.cancelDownload(downloadId);
                return;
            }
            await this.dependencies.onDownloadRegistered?.({
                jobId,
                entry: pending,
                downloadId,
                requestedFilename,
                blobLeaseJobId: leaseJobId
            });
            const early = this.earlyTerminals.get(downloadId);
            if (early) {
                this.earlyTerminals.delete(downloadId);
                await this.handleTerminal(downloadId, early.state, early.error);
            }
        } catch (error) {
            await this.handlePreparationFailure({ jobId, entry, downloadId, error: errorMessage(error) });
        } finally {
            if (this.cancelledJobs.has(jobId)) await this.cleanupLease(leaseJobId, true);
        }
    }

    private async markPending(
        jobId: string,
        sequence: number,
        downloadId: number,
        leaseJobId: string
    ): Promise<IndividualDownloadEntry | null> {
        return this.enqueue(async () => {
            if (this.cancelledJobs.has(jobId)) return null;
            let pending: IndividualDownloadEntry | null = null;
            await this.dependencies.mutateSnapshot(jobId, (snapshot) => {
                if (!snapshot.activeWindow) return {};
                const queue = snapshot.activeWindow.individualQueue.map((entry) => {
                    if (entry.sequence !== sequence || entry.state !== 'preparing') return entry;
                    pending = { ...entry, state: 'pending', downloadId, blobLeaseJobId: leaseJobId };
                    return pending;
                });
                return queuePatch(snapshot, queue);
            });
            return pending;
        });
    }

    private async handlePreparationFailure(failure: PreparationFailure): Promise<void> {
        const jobId = failure.jobId;
        let failedEntry: IndividualDownloadEntry | null = null;
        await this.enqueue(async () => {
            await this.dependencies.mutateSnapshot(jobId, (current) => {
                if (!current.activeWindow) return {};
                const queue = current.activeWindow.individualQueue.map((entry) => {
                    if (entry.sequence !== failure.entry.sequence || isTerminalEntry(entry)) return entry;
                    failedEntry = {
                        ...entry,
                        state: this.cancelledJobs.has(jobId) ? 'cancelled' : 'failed',
                        downloadId: failure.downloadId ?? entry.downloadId,
                        error: this.cancelledJobs.has(jobId) ? undefined : failure.error
                    };
                    return failedEntry;
                });
                return queuePatch(current, queue);
            });
        });
        if (!failedEntry) return;
        if (hasDownloadId(failedEntry)) {
            this.settledDownloadIds.add(failedEntry.downloadId);
            await this.cancelDownload(failedEntry.downloadId);
            await callSafely(this.dependencies.onDownloadSettled, terminalEvent(jobId, failedEntry, 'interrupted'));
        }
        if (failedEntry.blobLeaseJobId) await this.cleanupLease(failedEntry.blobLeaseJobId, false);
        await this.pump(jobId);
        await this.finishIfDrained(jobId);
    }

    private async cleanupCancelledRemainders(jobId: string): Promise<void> {
        const entries = this.currentQueue(jobId);
        await Promise.allSettled(entries.map(async (entry) => {
            if (hasDownloadId(entry)) await this.cancelDownload(entry.downloadId);
            if (entry.blobLeaseJobId) await this.cleanupLease(entry.blobLeaseJobId, true);
        }));
    }

    private async cleanupLease(leaseJobId: string, cancel: boolean): Promise<void> {
        if (this.releasedLeases.has(leaseJobId)) return;
        this.releasedLeases.add(leaseJobId);
        if (cancel) await this.dependencies.blobHost.cancel(leaseJobId).catch(() => {});
        await this.dependencies.blobHost.release(leaseJobId).catch(() => {});
    }

    private async finishIfDrained(jobId: string): Promise<void> {
        if (this.finishedJobs.has(jobId)) return;
        const snapshot = this.dependencies.getSnapshot();
        if (!snapshot?.activeWindow || snapshot.jobId !== jobId) return;
        const queue = snapshot.activeWindow.individualQueue;
        if (queue.some((entry) => !isTerminalEntry(entry))) return;
        this.finishedJobs.add(jobId);
        await callSafely(this.dependencies.onQueueFinished, summary(jobId, queue));
    }

    private currentQueue(jobId: string): IndividualDownloadEntry[] {
        const snapshot = this.dependencies.getSnapshot();
        if (!snapshot?.activeWindow || snapshot.jobId !== jobId) return [];
        return snapshot.activeWindow.individualQueue;
    }

    private currentPreparations(jobId: string): Set<Promise<void>> {
        return this.inFlightPreparations.get(jobId) ?? new Set();
    }

    private cancelDownload(downloadId: number): Promise<void> {
        if (this.cancelledDownloadIds.has(downloadId)) return Promise.resolve();
        this.cancelledDownloadIds.add(downloadId);
        return this.dependencies.cancelDownload(downloadId).catch(() => {});
    }

    private searchDownload(downloadId: number): Promise<Array<{ id?: number; state?: string; error?: string }>> {
        if (this.dependencies.searchDownload) return this.dependencies.searchDownload(downloadId);
        return chrome.downloads.search({ id: downloadId });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.operationQueue.then(operation, operation);
        this.operationQueue = result.then(() => undefined, () => undefined);
        return result;
    }
}

function indexImages(
    dependencies: Pick<
        IndividualDownloadQueueDependencies,
        | 'normalizeImageUrlForDeduplication'
        | 'getDownloadCandidateUrls'
        | 'buildIndexedFilename'
        | 'extractFilenameFromUrl'
        | 'formatLocalTimestamp'
    >,
    request: IndividualQueueStartRequest
): IndividualDownloadEntry[] {
    const seen = new Set<string>();
    const timestamp = dependencies.formatLocalTimestamp();
    const sequenceOffset = Math.max(0, Math.floor(request.sequenceOffset ?? 0));
    const entries: IndividualDownloadEntry[] = [];
    request.images.forEach((image, index) => {
        const normalizedUrl = dependencies.normalizeImageUrlForDeduplication(image, request.settings);
        const sourceUrl = typeof image === 'string' ? image : image?.url;
        if (!normalizedUrl || !sourceUrl || seen.has(normalizedUrl)) return;
        seen.add(normalizedUrl);
        const sequence = sequenceOffset + index + 1;
        const originalFilename = typeof image === 'string'
            ? dependencies.extractFilenameFromUrl(sourceUrl)
            : image.originalFilename || dependencies.extractFilenameFromUrl(sourceUrl);
        entries.push({
            imageId: typeof image === 'string' ? `img_${index}` : image.id || `img_${index}`,
            sequence,
            sourceUrl,
            candidateUrls: dependencies.getDownloadCandidateUrls(sourceUrl, request.settings.highQuality !== false),
            filename: dependencies.buildIndexedFilename(sequence, timestamp, sourceUrl, originalFilename),
            state: 'queued'
        });
    });
    return entries;
}

function queuePatch(
    snapshot: BatchTaskSnapshot,
    queue: IndividualDownloadEntry[]
): Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>> {
    const counts = countEntries(queue);
    return {
        activeWindow: snapshot.activeWindow ? { ...snapshot.activeWindow, individualQueue: queue } : null,
        individualCount: counts.success,
        failedCount: counts.failed,
        cancelledCount: counts.cancelled
    };
}

function countEntries(entries: IndividualDownloadEntry[]): Omit<IndividualQueueSummary, 'jobId' | 'total'> {
    return {
        success: entries.filter((entry) => entry.state === 'complete').length,
        failed: entries.filter((entry) => entry.state === 'failed').length,
        cancelled: entries.filter((entry) => entry.state === 'cancelled').length
    };
}

function summary(jobId: string, entries: IndividualDownloadEntry[]): IndividualQueueSummary {
    return { jobId, total: entries.length, ...countEntries(entries) };
}

function toBlobEntry(entry: IndividualDownloadEntry): BlobJobEntry {
    return {
        imageId: entry.imageId,
        sequence: entry.sequence,
        sourceUrl: entry.sourceUrl,
        candidateUrls: entry.candidateUrls,
        filename: entry.filename
    };
}

function isTerminalEntry(entry: IndividualDownloadEntry): boolean {
    return entry.state === 'complete' || entry.state === 'failed' || entry.state === 'cancelled';
}

function hasDownloadId(entry: IndividualDownloadEntry): entry is IndividualDownloadEntry & { downloadId: number } {
    return typeof entry.downloadId === 'number' && Number.isInteger(entry.downloadId);
}

function fileJobId(jobId: string, sequence: number): string {
    return `${jobId}:file:${sequence}`;
}

function terminalError(state: DownloadTerminalState): string {
    return state === 'missing'
        ? 'Browser download record is missing.'
        : 'Browser download was interrupted.';
}

function entryStateToTerminal(entry: IndividualDownloadEntry): DownloadTerminalState {
    return entry.state === 'complete' ? 'complete' : 'interrupted';
}

function terminalEvent(
    jobId: string,
    entry: IndividualDownloadEntry & { downloadId: number },
    state: DownloadTerminalState
): IndividualQueueTerminalEvent {
    return {
        jobId,
        entry,
        downloadId: entry.downloadId,
        state,
        error: entry.error
    };
}

async function callSafely<T>(
    callback: ((value: T) => void | Promise<void>) | undefined,
    value: T
): Promise<void> {
    if (!callback) return;
    await Promise.resolve(callback(value)).catch(() => {});
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
