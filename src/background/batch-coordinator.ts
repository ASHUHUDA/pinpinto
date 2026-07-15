import { runBatchDownload } from './batch-download';
import type { BlobJobResult } from './blob-runner';
import {
    cancelBatchJobState,
    createBatchJobState,
    isBatchCancellationError,
    isBatchJobCancelled,
    throwIfBatchJobCancelled,
    type BatchJobState
} from './batch-job';
import { buildSingleDownloadPath, buildZipDownloadPath } from './download-path';
import {
    getSettlementOutcome,
    registerExpectedDownload,
    settleDownload,
    type DownloadSettlementKind,
    type DownloadTerminalState
} from './download-settlement';
import { BatchTaskManager } from './batch-task-manager';
import { normalizeAutoBatchLimit, normalizeAutoBatchTotalBatches } from '../shared/download-batching';
import { isTerminalBatchPhase, type BatchRunResult, type BatchTaskSnapshot } from '../shared/batch-task';
import {
    type AutoBatchWindowRequest,
    type BatchCoordinatorHost,
    type CommitResponse,
    type DownloadImage,
    type StartBatchRequest,
    type TrackedDownloadInfo
} from './batch-coordinator-types';
import { applySettlement, createActiveWindow, integerOr, uniqueNumbers, windowSettlement } from './batch-window-state';
import { rememberBounded, shouldBufferEarlyTerminal } from './early-terminal-buffer';
import { cleanupOrphanBlobJobs, restoreTrackedDownloads } from './batch-recovery';
import { sendTabMessage } from './tab-messaging';

type BatchRuntime = BatchJobState & { controllers: Set<AbortController> };
export type { TrackedDownloadInfo } from './batch-coordinator-types';

export class BatchCoordinator {
    private readonly taskManager: BatchTaskManager;
    private runtime: BatchRuntime | null = null;
    private processingWindow = false;
    private readonly earlySettlements = new Map<number, DownloadTerminalState>();
    private transitionQueue: Promise<unknown> = Promise.resolve();
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
        const autoBatchTotalBatches = normalizeAutoBatchTotalBatches(request.autoBatchTotalBatches ?? settings.autoBatchTotalBatches);
        const result = await this.taskManager.start({
            mode,
            targetTabId,
            totalImages: mode === 'manual' ? images.length : 0,
            autoBatchLimit,
            autoBatchTotalBatches,
            settings
        });
        if (!result.accepted) return result;

        this.earlySettlements.clear();
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
        if (this.processingWindow || snapshot.activeWindow || isTerminalBatchPhase(snapshot.phase)) return false;

        const startIndex = integerOr(request.startOffset, request.startIndex, snapshot.batchCursor);
        const endIndex = integerOr(request.endOffset, request.endIndex, startIndex);
        const images = request.images ?? [];
        if (startIndex !== snapshot.batchCursor || endIndex < startIndex || endIndex - startIndex !== images.length) return false;
        if (images.length === 0) return false;

        void this.processWindow({
            jobId: snapshot.jobId,
            images,
            settings: request.settings ?? snapshot.settings,
            startIndex,
            endIndex,
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
        if (!snapshot.activeWindow && !this.processingWindow) await this.finalizeSuccess(snapshot.jobId);
        return true;
    }

    async cancel(jobId?: string): Promise<boolean> {
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || isTerminalBatchPhase(snapshot.phase) || (jobId && snapshot.jobId !== jobId)) return false;
        this.cancelRuntime(snapshot.jobId);
        await this.taskManager.cancel(snapshot.jobId);
        await Promise.all(snapshot.associatedDownloadIds.map((downloadId) => chrome.downloads.cancel(downloadId).catch(() => {})));
        await this.cancelBlobJobs(snapshot.jobId);
        snapshot.associatedDownloadIds.forEach((downloadId) => this.host.activeDownloads.delete(downloadId));
        if (snapshot.targetTabId !== null) {
            await sendTabMessage(snapshot.targetTabId, { action: 'cancelAutoBatchSession', jobId: snapshot.jobId });
        }
        this.runtime = null;
        this.processingWindow = false;
        return true;
    }

    async handleTargetTabClosed(tabId: number): Promise<void> {
        await this.ready;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.mode !== 'auto' || snapshot.targetTabId !== tabId || isTerminalBatchPhase(snapshot.phase)) return;
        this.cancelRuntime(snapshot.jobId);
        await this.cancelBlobJobs(snapshot.jobId);
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
        const state = downloadDelta.state?.current;
        if (state !== 'complete' && state !== 'interrupted') return;
        const batchInfo = downloadInfo?.isBatch ? downloadInfo : undefined;
        void this.ready.then(() => this.settleBrowserDownload(downloadDelta.id, state, batchInfo));
    }

    private async initialize(): Promise<void> {
        const snapshot = await this.taskManager.initialize();
        await cleanupOrphanBlobJobs(this.host, snapshot);
        if (!snapshot || isTerminalBatchPhase(snapshot.phase)) return;
        this.runtime = createRuntime(snapshot.jobId);
        snapshot.associatedDownloadIds.forEach((id) => this.runtime?.activeDownloadIds.add(id));

        if (snapshot.activeWindow) {
            restoreTrackedDownloads(this.host, snapshot);
            if (snapshot.activeWindow.expectedDownloadIds.length > 0) {
                await this.reconcileWindowDownloads(snapshot, true);
            } else if (snapshot.activeWindow.hostState === 'fetching' || snapshot.activeWindow.hostState === 'compressing') {
                await this.recoverHostWork(snapshot);
            } else {
                await this.fail(snapshot.jobId, '后台恢复时活动窗口缺少浏览器下载记录。', 'interrupted');
            }
            return;
        }

        if (snapshot.phase === 'scrolling' || snapshot.phase === 'waiting-for-batch') {
            if (snapshot.targetTabId === null || !await this.resumeAutoSession(snapshot)) {
                await this.fail(snapshot.jobId, '目标标签页不可用，无法恢复自动批次。', 'interrupted');
            }
            return;
        }
        await this.fail(snapshot.jobId, '后台任务在未结算阶段中断，可重新开始。', 'interrupted');
    }

    private async startAutoSession(
        jobId: string,
        targetTabId: number | undefined,
        limit: number,
        settings: Record<string, unknown>
    ): Promise<void> {
        if (typeof targetTabId !== 'number') return this.fail(jobId, '无法确定 Pinterest 标签页。');
        await this.taskManager.update(jobId, {
            phase: 'scrolling',
            details: '正在扫描页面并等待完整批次。'
        });
        const response = await sendTabMessage(targetTabId, { action: 'startAutoBatchSession', jobId, limit, settings });
        if (response?.success !== true) await this.fail(jobId, '无法启动页面自动批次会话。');
    }

    private async processWindow(request: {
        jobId: string;
        images: DownloadImage[];
        settings: Record<string, unknown>;
        startIndex: number;
        endIndex: number;
        finalWindow: boolean;
    }): Promise<void> {
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== request.jobId || isTerminalBatchPhase(snapshot.phase) || this.processingWindow) return;
        this.processingWindow = true;
        const runtime = this.runtime?.id === snapshot.jobId ? this.runtime : createRuntime(snapshot.jobId);
        this.runtime = runtime;
        const activeWindow = createActiveWindow(snapshot, request);

        try {
            await this.taskManager.update(snapshot.jobId, {
                phase: request.images.length > 0 ? 'fetching' : 'downloading',
                progress: 0,
                details: request.images.length > 0
                    ? `正在处理第 ${request.startIndex + 1}-${request.endIndex} 张图片。`
                    : '未接收到可下载图片。',
                activeWindow
            });
            const runResult = await runBatchDownload({
                blobHost: this.host.blobHost,
                maxConcurrentDownloads: this.host.maxConcurrentDownloads,
                requestFallbackDownload: (fallbackRequest) => this.requestFallbackDownload(fallbackRequest),
                throwIfBatchCancelled: throwIfBatchJobCancelled,
                isBatchCancellationError,
                sendProgressUpdate: (job, progress, details) => {
                    const current = this.taskManager.getSnapshot();
                    if (!current || current.jobId !== job.id || isTerminalBatchPhase(current.phase)) return;
                    const phase = progress < 60 ? 'fetching' : progress < 100 ? 'compressing' : 'downloading';
                    void this.taskManager.mutate(job.id, (latest) => ({
                        phase,
                        progress,
                        details,
                        activeWindow: latest.activeWindow ? {
                            ...latest.activeWindow,
                            hostState: phase === 'fetching' ? 'fetching' : phase === 'compressing' ? 'compressing' : latest.activeWindow.hostState
                        } : null
                    }));
                },
                normalizeImageUrlForDeduplication: this.host.normalizeImageUrlForDeduplication,
                getDownloadCandidateUrls: this.host.getDownloadCandidateUrls,
                buildIndexedFilename: this.host.buildIndexedFilename,
                extractFilenameFromUrl: this.host.extractFilenameFromUrl,
                formatLocalTimestamp: this.host.formatLocalTimestamp
            }, runtime, request.images, request.settings, { sequenceOffset: request.startIndex });
            if (isBatchJobCancelled(runtime)) return;
            await this.recordRunResult(snapshot.jobId, runResult, request.settings);
        } catch (error) {
            if (!isBatchCancellationError(error)) {
                await this.fail(snapshot.jobId, error instanceof Error ? error.message : String(error));
            }
        } finally {
            this.processingWindow = false;
            await this.queueWindowProgress(snapshot.jobId);
        }
    }

    private async recordRunResult(jobId: string, result: BatchRunResult, settings: Record<string, unknown>): Promise<void> {
        const current = this.taskManager.getSnapshot();
        if (!current?.activeWindow || current.jobId !== jobId || isTerminalBatchPhase(current.phase)) return;
        if (typeof result.zipDownloadId === 'number') {
            await this.registerWindowDownload(
                jobId,
                result.zipDownloadId,
                'zip',
                result.zipFilename || 'PinPinto/PinPinto.zip',
                settings,
                { title: 'PinPinto batch', url: 'local-zip' },
                result.zipLeaseJobId
            );
        }
        await this.taskManager.mutate(jobId, (snapshot) => {
            if (!snapshot.activeWindow) return {};
            return {
                phase: 'downloading',
                progress: 100,
                details: '浏览器正在结算当前批次下载。',
                activeWindow: {
                    ...snapshot.activeWindow,
                    totalCount: result.totalCount,
                    zippedCount: result.zippedCount,
                    fallbackCount: result.fallbackRequestedCount,
                    unresolvedCount: result.unresolvedCount,
                    hostJobId: result.zipLeaseJobId ?? snapshot.activeWindow.hostJobId,
                    hostState: result.zipLeaseJobId ? 'blob-ready' : 'released'
                }
            };
        });
        if (result.unresolvedCount > 0) await this.fail(jobId, `${result.unresolvedCount} 张图片无法创建 ZIP 或补救下载。`);
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
            if (!current?.activeWindow || current.jobId !== request.jobId || isTerminalBatchPhase(current.phase)) {
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
            if (!latest?.activeWindow || latest.jobId !== request.jobId || isTerminalBatchPhase(latest.phase)) {
                await chrome.downloads.cancel(downloadId).catch(() => {});
                return { accepted: false, error: 'batch task was cancelled' };
            }
            await this.registerWindowDownload(
                request.jobId,
                downloadId,
                'fallback',
                requestedFilename,
                request.settings,
                request.image
            );
            return { accepted: true, downloadId };
        } catch (error) {
            return { accepted: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private async registerWindowDownload(
        jobId: string,
        downloadId: number,
        kind: DownloadSettlementKind,
        requestedFilename: string,
        settings: Record<string, unknown>,
        imageData: DownloadImage,
        blobLeaseJobId?: string
    ): Promise<void> {
        this.runtime?.activeDownloadIds.add(downloadId);
        this.host.activeDownloads.set(downloadId, {
            imageData,
            settings,
            startTime: Date.now(),
            status: 'downloading',
            isBatch: true,
            batchKind: kind,
            blobLeaseJobId,
            jobId,
            requestedFilename
        });
        await this.taskManager.mutate(jobId, (snapshot) => {
            if (!snapshot.activeWindow) return {};
            const settlement = registerExpectedDownload(windowSettlement(snapshot.activeWindow), {
                downloadId,
                kind,
                blobLeaseJobId
            });
            return {
                associatedDownloadIds: uniqueNumbers([...snapshot.associatedDownloadIds, downloadId]),
                pendingFallbackDownloadIds: kind === 'fallback'
                    ? uniqueNumbers([...snapshot.pendingFallbackDownloadIds, downloadId])
                    : snapshot.pendingFallbackDownloadIds,
                activeWindow: applySettlement(snapshot.activeWindow, settlement)
            };
        });
        const early = this.earlySettlements.get(downloadId);
        if (early) {
            this.earlySettlements.delete(downloadId);
            await this.settleBrowserDownload(downloadId, early, this.host.activeDownloads.get(downloadId));
            return;
        }
        await this.reconcileDownloadId(downloadId, false);
    }

    private async settleBrowserDownload(
        downloadId: number,
        state: DownloadTerminalState,
        downloadInfo?: TrackedDownloadInfo
    ): Promise<void> {
        const initial = this.taskManager.getSnapshot();
        const activeDownload = initial?.activeWindow?.downloadStates[String(downloadId)];
        const leaseJobId = downloadInfo?.blobLeaseJobId ?? activeDownload?.blobLeaseJobId;
        this.host.activeDownloads.delete(downloadId);
        this.runtime?.activeDownloadIds.delete(downloadId);
        if (leaseJobId) await this.host.blobHost.release(leaseJobId).catch(() => {});

        if (!initial?.activeWindow || !activeDownload || activeDownload.state !== 'pending') {
            if (shouldBufferEarlyTerminal({ registered: Boolean(activeDownload), hasActiveWindow: Boolean(initial?.activeWindow),
                terminalJob: Boolean(initial && isTerminalBatchPhase(initial.phase)), currentJobId: initial?.jobId,
                metadataJobId: downloadInfo?.jobId })) {
                rememberBounded(this.earlySettlements, downloadId, state);
            }
            return;
        }
        if (isTerminalBatchPhase(initial.phase)) return;
        await this.taskManager.mutate(initial.jobId, (snapshot) => {
            if (!snapshot.activeWindow) return {};
            const settlement = settleDownload(windowSettlement(snapshot.activeWindow), downloadId, state);
            return {
                pendingFallbackDownloadIds: snapshot.pendingFallbackDownloadIds.filter((id) => id !== downloadId),
                activeWindow: applySettlement(snapshot.activeWindow, settlement)
            };
        });
        await this.queueWindowProgress(initial.jobId);
    }

    private queueWindowProgress(jobId: string): Promise<void> {
        const operation = this.transitionQueue.then(() => this.progressWindow(jobId), () => this.progressWindow(jobId));
        this.transitionQueue = operation.then(() => undefined, () => undefined);
        return operation;
    }

    private async progressWindow(jobId: string): Promise<void> {
        if (this.processingWindow) return;
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot?.activeWindow || snapshot.jobId !== jobId || isTerminalBatchPhase(snapshot.phase)) return;
        const outcome = getSettlementOutcome(windowSettlement(snapshot.activeWindow));
        if (outcome.status === 'pending') {
            await this.taskManager.update(jobId, {
                phase: 'downloading',
                details: `等待 ${outcome.pendingIds.length} 个浏览器下载完成。`
            });
            return;
        }
        if (outcome.status === 'failed') {
            await this.fail(jobId, `浏览器下载 ${outcome.failedIds.join(', ')} 未成功完成。`);
            return;
        }
        if (snapshot.activeWindow.unresolvedCount > 0) {
            await this.fail(jobId, `${snapshot.activeWindow.unresolvedCount} 张图片未解决。`);
            return;
        }
        if (snapshot.mode === 'auto') await this.commitAutoWindow(snapshot);
        else await this.acceptSettledWindow(snapshot);
    }

    private async commitAutoWindow(snapshot: BatchTaskSnapshot): Promise<void> {
        const activeWindow = snapshot.activeWindow;
        if (!activeWindow || snapshot.targetTabId === null) return this.fail(snapshot.jobId, '目标标签页不可用。');
        const response = await sendTabMessage(snapshot.targetTabId, {
            action: 'commitAutoBatchWindow',
            jobId: snapshot.jobId,
            startOffset: activeWindow.startOffset,
            endOffset: activeWindow.endOffset
        }) as CommitResponse | null;
        const valid = response?.success === true
            && response.baseOffset === activeWindow.endOffset
            && Number.isInteger(response.retainedCount)
            && (response.retainedCount as number) >= 0
            && (response.retainedCount as number) <= 2 * snapshot.autoBatchLimit;
        if (!valid) {
            await this.taskManager.mutate(snapshot.jobId, (current) => ({
                activeWindow: current.activeWindow ? {
                    ...current.activeWindow,
                    contentCommitState: {
                        ...current.activeWindow.contentCommitState,
                        state: 'failed',
                        error: response?.error || 'Compaction acknowledgement was invalid.'
                    }
                } : null
            }));
            await this.fail(snapshot.jobId, response?.error || '页面压缩确认无效。');
            return;
        }
        await this.taskManager.mutate(snapshot.jobId, (current) => ({
            activeWindow: current.activeWindow ? {
                ...current.activeWindow,
                contentCommitState: {
                    ...current.activeWindow.contentCommitState,
                    state: 'acknowledged',
                    acknowledgedBaseOffset: response.baseOffset as number,
                    retainedCount: response.retainedCount as number
                }
            } : null
        }));
        const acknowledged = this.taskManager.getSnapshot();
        if (acknowledged) await this.acceptSettledWindow(acknowledged);
    }

    private async acceptSettledWindow(snapshot: BatchTaskSnapshot): Promise<void> {
        const activeWindow = snapshot.activeWindow;
        if (!activeWindow) return;
        const completedBatches = snapshot.mode === 'auto'
            ? snapshot.autoBatchCompletedBatches + 1
            : snapshot.autoBatchCompletedBatches;
        const reachedBatchCap = snapshot.mode === 'auto'
            && snapshot.autoBatchTotalBatches > 0
            && completedBatches >= snapshot.autoBatchTotalBatches;
        const finalWindow = activeWindow.finalWindow || reachedBatchCap;
        await this.taskManager.mutate(snapshot.jobId, (current) => {
            if (!current.activeWindow || current.activeWindow.windowId !== activeWindow.windowId) return {};
            return {
                batchCursor: current.mode === 'auto' ? activeWindow.endOffset : current.batchCursor,
                totalImages: current.mode === 'auto' ? current.totalImages + activeWindow.totalCount : current.totalImages,
                zippedCount: current.zippedCount + activeWindow.zippedCount,
                fallbackCount: current.fallbackCount + activeWindow.fallbackCount,
                unresolvedCount: current.unresolvedCount + activeWindow.unresolvedCount,
                autoBatchCompletedBatches: completedBatches,
                autoSessionFinished: current.mode === 'manual' || finalWindow,
                activeWindow: null
            };
        });
        const updated = this.taskManager.getSnapshot();
        if (!updated || updated.jobId !== snapshot.jobId) return;
        if (updated.mode === 'auto' && !finalWindow) {
            await this.taskManager.update(updated.jobId, {
                phase: 'scrolling',
                progress: 0,
                details: '当前批次已落盘并释放页面记录，继续扫描下一批。'
            });
            if (!await this.resumeAutoSession(updated)) await this.fail(updated.jobId, '目标标签页不可用，无法继续下一批。');
            return;
        }
        if (updated.mode === 'auto' && updated.targetTabId !== null) {
            await sendTabMessage(updated.targetTabId, { action: 'finishAutoBatchSession', jobId: updated.jobId });
        }
        await this.finalizeSuccess(updated.jobId);
    }

    private async finalizeSuccess(jobId: string): Promise<void> {
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== jobId || isTerminalBatchPhase(snapshot.phase)) return;
        if (snapshot.activeWindow || this.processingWindow) return;
        const cleared = await this.taskManager.clearCompleted(jobId, {
            phase: 'completed',
            progress: 100,
            details: this.summary(snapshot)
        }, async () => {
            if (snapshot.targetTabId === null) return true;
            const response = await sendTabMessage(snapshot.targetTabId, { action: 'clearAllImages', jobId });
            return response?.success === true;
        });
        if (!cleared) return this.fail(jobId, '无法清理目标页面会话。', 'interrupted');
        this.runtime = null;
        this.processingWindow = false;
    }

    private summary(snapshot: BatchTaskSnapshot): string {
        if (snapshot.zippedCount === 0 && snapshot.fallbackCount > 0 && snapshot.unresolvedCount === 0) {
            return `已由浏览器完成 ${snapshot.fallbackCount} 张单独下载。`;
        }
        return `ZIP 图片 ${snapshot.zippedCount} 张，浏览器补救成功 ${snapshot.fallbackCount} 张，未解决 ${snapshot.unresolvedCount} 张。`;
    }

    private async fail(jobId: string, error: string, phase: 'failed' | 'interrupted' = 'failed'): Promise<void> {
        const snapshot = this.taskManager.getSnapshot();
        if (!snapshot || snapshot.jobId !== jobId || isTerminalBatchPhase(snapshot.phase)) return;
        await this.taskManager.update(jobId, {
            phase,
            progress: 100,
            details: `批量任务${phase === 'failed' ? '失败' : '中断'}：${error}`,
            autoSessionFinished: true
        });
        this.runtime = null;
        this.processingWindow = false;
    }

    private async resumeAutoSession(snapshot: BatchTaskSnapshot): Promise<boolean> {
        if (snapshot.targetTabId === null) return false;
        const response = await sendTabMessage(snapshot.targetTabId, {
            action: 'resumeAutoBatchSession',
            jobId: snapshot.jobId,
            nextCursor: snapshot.batchCursor,
            limit: snapshot.autoBatchLimit,
            settings: snapshot.settings
        });
        return response?.success === true;
    }

    private async reconcileWindowDownloads(snapshot: BatchTaskSnapshot, missingIsFailure: boolean): Promise<void> {
        for (const downloadId of snapshot.activeWindow?.expectedDownloadIds ?? []) {
            await this.reconcileDownloadId(downloadId, missingIsFailure);
        }
        await this.queueWindowProgress(snapshot.jobId);
    }

    private async reconcileDownloadId(downloadId: number, missingIsFailure: boolean): Promise<void> {
        try {
            const items = await chrome.downloads.search({ id: downloadId });
            const item = items[0];
            if (item?.state === 'complete' || item?.state === 'interrupted') {
                await this.settleBrowserDownload(downloadId, item.state, this.host.activeDownloads.get(downloadId));
            } else if (!item && missingIsFailure) {
                await this.settleBrowserDownload(downloadId, 'missing', this.host.activeDownloads.get(downloadId));
            }
        } catch {
            if (missingIsFailure) await this.settleBrowserDownload(downloadId, 'missing', this.host.activeDownloads.get(downloadId));
        }
    }

    private async recoverHostWork(snapshot: BatchTaskSnapshot): Promise<void> {
        const activeWindow = snapshot.activeWindow;
        if (!activeWindow?.hostJobId) return this.fail(snapshot.jobId, '后台恢复时 Blob 主机标识缺失。', 'interrupted');
        this.processingWindow = true;
        try {
            const status = await this.host.blobHost.getStatus(activeWindow.hostJobId);
            if (status?.state !== 'completed') throw new Error('Blob host did not retain a completed result.');
            const result = await this.host.blobHost.result(activeWindow.hostJobId);
            await this.reattachHostResult(snapshot, result);
        } catch (error) {
            await this.host.blobHost.cancel(activeWindow.hostJobId).catch(() => {});
            await this.host.blobHost.release(activeWindow.hostJobId).catch(() => {});
            await this.fail(snapshot.jobId, error instanceof Error ? error.message : String(error), 'interrupted');
        } finally {
            this.processingWindow = false;
            await this.queueWindowProgress(snapshot.jobId);
        }
    }

    private async reattachHostResult(snapshot: BatchTaskSnapshot, blobResult: BlobJobResult): Promise<void> {
        const fallbackIds: number[] = [];
        let unresolvedCount = 0;
        for (const failure of blobResult.failedEntries) {
            const fallback = await this.requestFallbackDownload({
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
        await this.recordRunResult(snapshot.jobId, {
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

    private cancelRuntime(jobId: string): void {
        if (this.runtime?.id !== jobId) return;
        cancelBatchJobState(this.runtime);
        this.runtime.controllers.forEach((controller) => controller.abort());
    }

    private async cancelBlobJobs(batchJobId: string): Promise<void> {
        const blobJobIds = await this.host.blobHost.listActiveJobs().catch(() => []);
        await Promise.all(blobJobIds.filter((jobId) => jobId.startsWith(`${batchJobId}:zip:`)).map(async (jobId) => {
            await this.host.blobHost.cancel(jobId).catch(() => {});
            await this.host.blobHost.release(jobId).catch(() => {});
        }));
    }
}

function createRuntime(jobId: string): BatchRuntime {
    return { ...createBatchJobState(jobId), controllers: new Set<AbortController>() };
}
