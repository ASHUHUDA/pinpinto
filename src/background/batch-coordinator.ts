import { runBatchDownload } from './batch-download';
import {
    cancelBatchJobState,
    createBatchJobState,
    isBatchCancellationError,
    isBatchJobCancelled,
    throwIfBatchJobCancelled,
    type BatchJobState
} from './batch-job';
import { buildSingleDownloadPath } from './download-path';
import { BatchTaskManager } from './batch-task-manager';
import { normalizeAutoBatchLimit } from '../shared/download-batching';
import { isTerminalBatchPhase, type BatchRunResult, type BatchTaskSnapshot } from '../shared/batch-task';

type BatchRuntime = BatchJobState & {
    controllers: Set<AbortController>;
};

export type TrackedDownloadInfo = {
    imageData: string | { title?: string; url?: string };
    settings: Record<string, unknown>;
    startTime: number;
    status: string;
    isBatch: boolean;
    batchKind?: 'zip' | 'fallback';
    jobId?: string;
    requestedFilename?: string;
    endTime?: number;
    duration?: number;
    error?: unknown;
    bytesReceived?: number;
};

type DownloadImage = string | {
    id?: string;
    url?: string;
    title?: string;
    board?: string;
    originalFilename?: string;
};

type BatchCoordinatorHost = {
    activeDownloads: Map<number, TrackedDownloadInfo>;
    maxConcurrentDownloads: number;
    normalizeImageUrlForDeduplication: (image: DownloadImage, settings: Record<string, unknown>) => string;
    getDownloadCandidateUrls: (rawUrl: string, highQualityEnabled: boolean) => string[];
    buildIndexedFilename: (sequence: number, timestamp: string, url: string, originalFilename?: string) => string;
    extractFilenameFromUrl: (url: string) => string;
    formatLocalTimestamp: () => string;
    broadcast: (message: Record<string, unknown>) => void | Promise<void>;
};

type StartBatchRequest = {
    mode?: 'manual' | 'auto';
    images?: DownloadImage[];
    urls?: DownloadImage[];
    settings?: Record<string, unknown>;
    targetTabId?: number;
    autoBatchLimit?: number;
};

type AutoBatchWindowRequest = {
    jobId?: string;
    images?: DownloadImage[];
    settings?: Record<string, unknown>;
    startIndex?: number;
    endIndex?: number;
    finalWindow?: boolean;
};

export class BatchCoordinator {
    private readonly taskManager: BatchTaskManager;
    private runtime: BatchRuntime | null = null;
    private processingWindow = false;
    private readonly settledFallbackIds = new Set<number>();
    private readonly earlyFallbackSettlements = new Map<number, 'complete' | 'interrupted'>();
    private readonly ready: Promise<void>;

    constructor(private readonly host: BatchCoordinatorHost) {
        this.taskManager = new BatchTaskManager({
            broadcast: (snapshot) => this.host.broadcast({
                action: 'batchTaskStateChanged',
                jobId: snapshot.jobId,
                snapshot
            })
        });
        this.ready = this.initialize();
    }

    async start(request: StartBatchRequest, senderTabId?: number): Promise<{ accepted: boolean; jobId: string; reason?: string }> {
        await this.ready;
        const mode = request.mode === 'auto' ? 'auto' : 'manual';
        const images = request.images || request.urls || [];
        const settings = request.settings ?? {};
        const targetTabId = typeof request.targetTabId === 'number' ? request.targetTabId : senderTabId;
        const autoBatchLimit = normalizeAutoBatchLimit(request.autoBatchLimit ?? settings.autoBatchLimit);
        const result = await this.taskManager.start({
            mode,
            targetTabId,
            totalImages: mode === 'manual' ? images.length : 0,
            autoBatchLimit,
            settings
        });

        if (!result.accepted) return result;
        this.settledFallbackIds.clear();
        this.earlyFallbackSettlements.clear();
        this.runtime = createRuntime(result.jobId);

        if (mode === 'auto') {
            void this.startAutoSession(result.jobId, targetTabId, autoBatchLimit, settings);
        } else {
            void this.processWindow({
                jobId: result.jobId,
                images,
                settings,
                startIndex: 0,
                endIndex: images.length,
                finalWindow: true
            });
        }
        return result;
    }

    async getSnapshot(): Promise<BatchTaskSnapshot | null> {
        await this.ready;
        return this.taskManager.getSnapshot();
    }

    async acceptAutoBatchWindow(request: AutoBatchWindowRequest, senderTabId?: number): Promise<boolean> {
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.mode !== 'auto' || snapshot.jobId !== request.jobId) return false;
        if (snapshot.targetTabId !== null && senderTabId !== undefined && snapshot.targetTabId !== senderTabId) return false;
        if (this.processingWindow || isTerminalBatchPhase(snapshot.phase)) return false;

        void this.processWindow({
            jobId: snapshot.jobId,
            images: request.images ?? [],
            settings: request.settings ?? snapshot.settings,
            startIndex: Math.max(0, Math.floor(request.startIndex ?? snapshot.batchCursor)),
            endIndex: Math.max(0, Math.floor(request.endIndex ?? snapshot.batchCursor)),
            finalWindow: request.finalWindow === true
        });
        return true;
    }

    async finishAutoSession(jobId?: string, senderTabId?: number): Promise<boolean> {
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.mode !== 'auto' || snapshot.jobId !== jobId) return false;
        if (snapshot.targetTabId !== null && senderTabId !== undefined && snapshot.targetTabId !== senderTabId) return false;
        await this.taskManager.update(snapshot.jobId, { autoSessionFinished: true });
        await this.maybeComplete(snapshot.jobId);
        return true;
    }

    async cancel(jobId?: string): Promise<boolean> {
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || isTerminalBatchPhase(snapshot.phase) || (jobId && snapshot.jobId !== jobId)) return false;

        if (this.runtime?.id === snapshot.jobId) {
            cancelBatchJobState(this.runtime);
            this.runtime.controllers.forEach((controller) => controller.abort());
        }
        await this.taskManager.cancel(snapshot.jobId);
        await Promise.all(snapshot.associatedDownloadIds.map(async (downloadId) => {
            try {
                await chrome.downloads.cancel(downloadId);
            } catch {
                // Already completed or removed.
            }
        }));
        if (snapshot.targetTabId !== null) {
            await this.sendToTab(snapshot.targetTabId, {
                action: 'cancelAutoBatchSession',
                jobId: snapshot.jobId
            });
        }
        this.runtime = null;
        this.processingWindow = false;
        return true;
    }

    async handleTargetTabClosed(tabId: number): Promise<void> {
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.mode !== 'auto' || snapshot.targetTabId !== tabId || isTerminalBatchPhase(snapshot.phase)) {
            return;
        }
        if (this.runtime?.id === snapshot.jobId) {
            cancelBatchJobState(this.runtime);
            this.runtime.controllers.forEach((controller) => controller.abort());
        }
        await this.taskManager.update(snapshot.jobId, {
            phase: 'interrupted',
            progress: 100,
            details: '目标标签页已关闭，自动批次已中断，可重新开始。',
            autoSessionFinished: true
        });
        this.runtime = null;
        this.processingWindow = false;
    }

    handleDownloadChange(downloadDelta: chrome.downloads.DownloadDelta, downloadInfo?: TrackedDownloadInfo): void {
        if (!downloadDelta.state) return;
        const state = downloadDelta.state.current;
        if (state !== 'complete' && state !== 'interrupted') return;
        const snapshot = this.taskManager.getSnapshot();
        const isTrackedFallback = downloadInfo?.isBatch && downloadInfo.batchKind === 'fallback';
        const isRestoredFallback = snapshot?.pendingFallbackDownloadIds.includes(downloadDelta.id) === true;
        if (!isTrackedFallback && !isRestoredFallback) return;
        const jobId = downloadInfo?.jobId || snapshot?.jobId;
        if (jobId) void this.settleFallbackDownload(jobId, downloadDelta.id, state);
    }

    private async initialize(): Promise<void> {
        const snapshot = await this.taskManager.initialize();
        if (!snapshot || isTerminalBatchPhase(snapshot.phase)) return;
        this.runtime = createRuntime(snapshot.jobId);
        snapshot.associatedDownloadIds.forEach((id) => this.runtime?.activeDownloadIds.add(id));

        if (snapshot.phase === 'scrolling' || snapshot.phase === 'waiting-for-batch') {
            if (snapshot.targetTabId !== null) {
                await this.sendToTab(snapshot.targetTabId, {
                    action: 'resumeAutoBatchSession',
                    jobId: snapshot.jobId,
                    nextCursor: snapshot.batchCursor,
                    limit: snapshot.autoBatchLimit,
                    settings: snapshot.settings
                });
            }
        } else if (snapshot.phase === 'downloading') {
            await this.reconcileFallbackDownloads(snapshot);
        }
    }

    private async startAutoSession(
        jobId: string,
        targetTabId: number | undefined,
        limit: number,
        settings: Record<string, unknown>
    ): Promise<void> {
        if (typeof targetTabId !== 'number') {
            await this.fail(jobId, '无法确定 Pinterest 标签页。');
            return;
        }
        await this.taskManager.update(jobId, {
            phase: 'scrolling',
            details: '正在扫描页面并等待完整批次。'
        });
        const response = await this.sendToTab(targetTabId, {
            action: 'startAutoBatchSession',
            jobId,
            limit,
            settings
        });
        if (response?.success !== true) {
            await this.fail(jobId, '无法启动页面自动批次会话。');
        }
    }

    private async processWindow(request: Required<Pick<AutoBatchWindowRequest, 'jobId' | 'images' | 'settings' | 'startIndex' | 'endIndex' | 'finalWindow'>>): Promise<void> {
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== request.jobId || isTerminalBatchPhase(snapshot.phase)) return;
        if (this.processingWindow) return;
        this.processingWindow = true;
        const runtime = this.runtime?.id === snapshot.jobId ? this.runtime : createRuntime(snapshot.jobId);
        this.runtime = runtime;

        try {
            await this.taskManager.update(snapshot.jobId, {
                phase: 'fetching',
                progress: 0,
                details: `正在处理第 ${request.startIndex + 1}-${request.endIndex} 张图片。`,
                totalImages: snapshot.mode === 'auto'
                    ? snapshot.totalImages + request.images.length
                    : request.images.length
            });
            const runResult = await runBatchDownload({
                maxConcurrentDownloads: this.host.maxConcurrentDownloads,
                requestFallbackDownload: (fallbackRequest) => this.requestFallbackDownload(fallbackRequest),
                throwIfBatchCancelled: throwIfBatchJobCancelled,
                isBatchCancellationError,
                sendProgressUpdate: (job, progress, details) => {
                    const current = this.taskManager.getSnapshot();
                    if (!current || current.jobId !== job.id || isTerminalBatchPhase(current.phase)) return;
                    const phase = progress < 60 ? 'fetching' : 'compressing';
                    void this.taskManager.update(job.id, { phase, progress, details });
                },
                normalizeImageUrlForDeduplication: this.host.normalizeImageUrlForDeduplication,
                getDownloadCandidateUrls: this.host.getDownloadCandidateUrls,
                buildIndexedFilename: this.host.buildIndexedFilename,
                extractFilenameFromUrl: this.host.extractFilenameFromUrl,
                formatLocalTimestamp: this.host.formatLocalTimestamp
            }, runtime, request.images, request.settings, { sequenceOffset: request.startIndex });
            if (isBatchJobCancelled(runtime)) return;
            await this.recordRunResult(snapshot.jobId, request.endIndex, request.finalWindow, runResult, request.settings);
        } catch (error) {
            if (!isBatchCancellationError(error)) {
                await this.fail(snapshot.jobId, error instanceof Error ? error.message : String(error));
            }
        } finally {
            this.processingWindow = false;
            await this.maybeComplete(snapshot.jobId);
        }
    }

    private async recordRunResult(
        jobId: string,
        nextCursor: number,
        finalWindow: boolean,
        result: BatchRunResult,
        settings: Record<string, unknown>
    ): Promise<void> {
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== jobId || isTerminalBatchPhase(snapshot.phase)) return;
        if (typeof result.zipDownloadId === 'number') {
            this.trackDownload(result.zipDownloadId, jobId, 'zip', result.zipFilename || 'PinPinto/PinPinto.zip', settings);
        }
        await this.taskManager.mutate(jobId, (current) => ({
            batchCursor: nextCursor,
            zippedCount: current.zippedCount + result.zippedCount,
            unresolvedCount: current.unresolvedCount + result.unresolvedCount,
            associatedDownloadIds: uniqueNumbers([
                ...current.associatedDownloadIds,
                ...(typeof result.zipDownloadId === 'number' ? [result.zipDownloadId] : []),
                ...result.fallbackDownloadIds
            ]),
            pendingFallbackDownloadIds: uniqueNumbers([
                ...current.pendingFallbackDownloadIds,
                ...result.fallbackDownloadIds.filter((downloadId) => !this.settledFallbackIds.has(downloadId))
            ]),
            autoSessionFinished: current.mode === 'manual' || finalWindow
        }));

        const updated = this.taskManager.getSnapshot();
        if (!updated) return;
        if (updated.mode === 'auto' && !finalWindow) {
            await this.taskManager.update(jobId, {
                phase: 'scrolling',
                progress: 0,
                details: '当前批次已创建下载，继续扫描下一批。'
            });
            if (updated.targetTabId !== null) {
                const response = await this.sendToTab(updated.targetTabId, {
                    action: 'resumeAutoBatchSession',
                    jobId,
                    nextCursor,
                    limit: updated.autoBatchLimit,
                    settings: updated.settings
                });
                if (response?.success !== true) {
                    await this.fail(jobId, '目标标签页不可用，无法继续下一批。');
                }
            }
            return;
        }

        if (updated.mode === 'auto' && updated.targetTabId !== null) {
            await this.sendToTab(updated.targetTabId, { action: 'finishAutoBatchSession', jobId });
        }
        await this.maybeComplete(jobId);
    }

    private async requestFallbackDownload(request: {
        jobId: string;
        image: DownloadImage;
        sourceUrl: string;
        filename: string;
        settings: Record<string, unknown>;
    }): Promise<{ accepted: boolean; downloadId?: number; error?: string }> {
        try {
            const current = this.taskManager.getSnapshot();
            if (!current || current.jobId !== request.jobId || isTerminalBatchPhase(current.phase)) {
                return { accepted: false, error: 'batch task is no longer active' };
            }
            const requestedFilename = buildSingleDownloadPath(request.filename);
            const downloadId = await chrome.downloads.download({
                url: request.sourceUrl,
                filename: requestedFilename,
                conflictAction: 'uniquify',
                saveAs: false
            });
            const latest = this.taskManager.getSnapshot();
            if (!latest || latest.jobId !== request.jobId || isTerminalBatchPhase(latest.phase)) {
                await chrome.downloads.cancel(downloadId).catch(() => {});
                return { accepted: false, error: 'batch task was cancelled' };
            }
            this.runtime?.activeDownloadIds.add(downloadId);
            this.trackDownload(downloadId, request.jobId, 'fallback', requestedFilename, request.settings, request.image);
            await this.taskManager.mutate(request.jobId, (current) => ({
                associatedDownloadIds: uniqueNumbers([...current.associatedDownloadIds, downloadId]),
                pendingFallbackDownloadIds: uniqueNumbers([...current.pendingFallbackDownloadIds, downloadId])
            }));
            const earlyState = this.earlyFallbackSettlements.get(downloadId);
            if (earlyState) await this.settleFallbackDownload(request.jobId, downloadId, earlyState);
            try {
                const [downloadItem] = await chrome.downloads.search({ id: downloadId });
                if (downloadItem?.state === 'complete' || downloadItem?.state === 'interrupted') {
                    await this.settleFallbackDownload(request.jobId, downloadId, downloadItem.state);
                }
            } catch {
                // onChanged remains the authoritative fallback completion signal.
            }
            return { accepted: true, downloadId };
        } catch (error) {
            return { accepted: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private trackDownload(
        downloadId: number,
        jobId: string,
        batchKind: 'zip' | 'fallback',
        requestedFilename: string,
        settings: Record<string, unknown>,
        imageData: DownloadImage = { title: 'PinPinto batch', url: 'local-zip' }
    ): void {
        this.host.activeDownloads.set(downloadId, {
            imageData,
            settings,
            startTime: Date.now(),
            status: 'downloading',
            isBatch: true,
            batchKind,
            jobId,
            requestedFilename
        });
    }

    private async settleFallbackDownload(jobId: string, downloadId: number, state: 'complete' | 'interrupted'): Promise<void> {
        const wasAlreadySettled = this.settledFallbackIds.has(downloadId);
        this.settledFallbackIds.add(downloadId);
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== jobId) return;
        if (!snapshot.pendingFallbackDownloadIds.includes(downloadId)) {
            if (!wasAlreadySettled) this.earlyFallbackSettlements.set(downloadId, state);
            return;
        }
        this.earlyFallbackSettlements.delete(downloadId);
        await this.taskManager.mutate(jobId, (current) => {
            if (!current.pendingFallbackDownloadIds.includes(downloadId)) return {};
            return {
                pendingFallbackDownloadIds: current.pendingFallbackDownloadIds.filter((id) => id !== downloadId),
                fallbackCount: current.fallbackCount + (state === 'complete' ? 1 : 0),
                unresolvedCount: current.unresolvedCount + (state === 'interrupted' ? 1 : 0)
            };
        });
        await this.maybeComplete(jobId);
    }

    private async maybeComplete(jobId: string): Promise<void> {
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== jobId || isTerminalBatchPhase(snapshot.phase)) return;
        if (this.runtime?.id === jobId && isBatchJobCancelled(this.runtime)) return;
        if (!snapshot.autoSessionFinished) return;
        if (snapshot.pendingFallbackDownloadIds.length > 0 || this.processingWindow) {
            await this.taskManager.update(jobId, {
                phase: 'downloading',
                progress: 100,
                details: this.summary(snapshot, true)
            });
            return;
        }
        await this.taskManager.update(jobId, {
            phase: 'completed',
            progress: 100,
            details: this.summary(snapshot, false)
        });
        this.runtime = null;
    }

    private summary(snapshot: BatchTaskSnapshot, pending: boolean): string {
        const pendingText = pending && snapshot.pendingFallbackDownloadIds.length > 0
            ? `，等待 ${snapshot.pendingFallbackDownloadIds.length} 张浏览器补救下载`
            : '';
        if (snapshot.zippedCount === 0 && snapshot.fallbackCount > 0 && snapshot.unresolvedCount === 0 && !pending) {
            return `已交给浏览器单独下载 ${snapshot.fallbackCount} 张图片。`;
        }
        return `ZIP 图片 ${snapshot.zippedCount} 张，浏览器补救成功 ${snapshot.fallbackCount} 张，未解决 ${snapshot.unresolvedCount} 张${pendingText}。`;
    }

    private async fail(jobId: string, error: string): Promise<void> {
        await this.taskManager.update(jobId, {
            phase: 'failed',
            progress: 100,
            details: `批量任务失败：${error}`,
            autoSessionFinished: true
        });
        this.runtime = null;
        this.processingWindow = false;
    }

    private async reconcileFallbackDownloads(snapshot: BatchTaskSnapshot): Promise<void> {
        for (const downloadId of snapshot.pendingFallbackDownloadIds) {
            try {
                const [item] = await chrome.downloads.search({ id: downloadId });
                if (item?.state === 'complete' || item?.state === 'interrupted') {
                    await this.settleFallbackDownload(snapshot.jobId, downloadId, item.state);
                }
            } catch {
                // Keep the persisted ID pending for a later onChanged event.
            }
        }
        await this.maybeComplete(snapshot.jobId);
    }

    private async sendToTab(
        tabId: number,
        message: Record<string, unknown>
    ): Promise<{ success?: boolean } | null> {
        try {
            return await chrome.tabs.sendMessage(tabId, message);
        } catch {
            return null;
        }
    }
}

function createRuntime(jobId: string): BatchRuntime {
    return {
        ...createBatchJobState(jobId),
        controllers: new Set<AbortController>()
    };
}

function uniqueNumbers(values: number[]): number[] {
    return [...new Set(values.filter((value) => Number.isInteger(value)))];
}
