import { getAutoBatchPlan, normalizeAutoBatchLimit } from '../shared/download-batching';
import type { BatchTaskSnapshot } from '../shared/batch-task';

type AutoBatchSessionStart = {
    jobId: string;
    limit: number;
    settings: Record<string, unknown>;
};

type AutoBatchSessionResume = AutoBatchSessionStart & {
    nextCursor: number;
};

type EligibleWindow = {
    records: unknown[];
    startOffset: number;
    endOffset: number;
    finalWindow: boolean;
    baseOffset?: number;
};

type ContentCommitResult = {
    success: boolean;
    baseOffset: number;
    retainedCount: number;
    removedIds: string[];
    error?: string;
};

type AutoBatchSessionDependencies = {
    scanForImages: () => void;
    getTotalImages: () => number;
    getImagesInRange: (startIndex: number, endIndex: number) => unknown[];
    getViewportAnchorIndex: () => number;
    discardImagesBeforeIndex: (startIndex: number) => unknown;
    prepareAutoBatchSession?: (startIndex: number) => { baseOffset?: number };
    getAutoEligibleWindow?: (cursor: number, limit: number, exhausted: boolean) => EligibleWindow;
    commitAutoBatchWindow?: (input: {
        startOffset: number;
        endOffset: number;
        autoBatchLimit: number;
    }) => ContentCommitResult;
    startAutoScroll: () => void;
    stopAutoScroll: () => void;
    getAutoScrollStopReason: () => 'manual' | 'exhausted' | null;
    sendMessage: (message: Record<string, unknown>) => Promise<unknown>;
    setInterval?: (callback: () => void | Promise<void>, delay: number) => number;
    clearInterval?: (timerId: number) => void;
};

type PendingWindow = {
    startOffset: number;
    endOffset: number;
};

type AutoBatchSessionState = {
    jobId: string;
    cursor: number;
    limit: number;
    settings: Record<string, unknown>;
    awaitingBatch: boolean;
    pendingWindow: PendingWindow | null;
    lastCommit: (PendingWindow & { result: ContentCommitResult }) | null;
};

export function getAutoBatchResumeInput(
    snapshot: BatchTaskSnapshot | null | undefined,
    matchesTargetTab: boolean
): AutoBatchSessionResume | null {
    if (!snapshot || !matchesTargetTab || snapshot.mode !== 'auto') return null;
    if (snapshot.phase !== 'scrolling' && snapshot.phase !== 'waiting-for-batch') return null;
    return {
        jobId: snapshot.jobId,
        nextCursor: snapshot.batchCursor,
        limit: snapshot.autoBatchLimit,
        settings: snapshot.settings
    };
}

export async function restoreAutoBatchSession(controller: AutoBatchSessionController): Promise<void> {
    try {
        const response = await chrome.runtime.sendMessage({ action: 'getBatchTaskState' });
        const resumeInput = getAutoBatchResumeInput(response?.snapshot, response?.matchesTargetTab === true);
        if (resumeInput) await controller.resume(resumeInput);
    } catch {
        // The background restore path also sends resume when the worker is ready.
    }
}

export class AutoBatchSessionController {
    private state: AutoBatchSessionState | null = null;
    private pollTimer: number | null = null;
    private readonly setIntervalFn: (callback: () => void | Promise<void>, delay: number) => number;
    private readonly clearIntervalFn: (timerId: number) => void;

    constructor(private readonly dependencies: AutoBatchSessionDependencies) {
        this.setIntervalFn = dependencies.setInterval ?? ((callback, delay) => window.setInterval(callback, delay));
        this.clearIntervalFn = dependencies.clearInterval ?? ((timerId) => window.clearInterval(timerId));
    }

    async start(input: AutoBatchSessionStart): Promise<void> {
        this.stopPolling();
        const anchorIndex = Math.max(0, this.dependencies.getViewportAnchorIndex());
        const preparation = this.dependencies.prepareAutoBatchSession?.(anchorIndex);
        if (!preparation) this.dependencies.discardImagesBeforeIndex(anchorIndex);
        this.state = {
            jobId: input.jobId,
            cursor: Math.max(0, Math.floor(preparation?.baseOffset ?? 0)),
            limit: normalizeAutoBatchLimit(input.limit),
            settings: input.settings,
            awaitingBatch: false,
            pendingWindow: null,
            lastCommit: null
        };
        this.dependencies.startAutoScroll();
        this.startPolling();
    }

    async resume(input: AutoBatchSessionResume): Promise<void> {
        if (this.state && this.state.jobId !== input.jobId) return;
        this.stopPolling();
        this.state = {
            jobId: input.jobId,
            cursor: Math.max(0, Math.floor(input.nextCursor)),
            limit: normalizeAutoBatchLimit(input.limit),
            settings: input.settings,
            awaitingBatch: false,
            pendingWindow: null,
            lastCommit: this.state?.lastCommit ?? null
        };
        this.dependencies.startAutoScroll();
        this.startPolling();
    }

    commitWindow(input: {
        jobId: string;
        startOffset: number;
        endOffset: number;
    }): ContentCommitResult {
        const state = this.state;
        if (!Number.isInteger(input.startOffset)
            || !Number.isInteger(input.endOffset)
            || input.startOffset < 0
            || input.endOffset <= input.startOffset) {
            return this.failedCommit('Compaction acknowledgement has an invalid absolute range.');
        }
        const range = {
            startOffset: input.startOffset,
            endOffset: input.endOffset
        };
        if (!state || state.jobId !== input.jobId || !this.dependencies.commitAutoBatchWindow) {
            return this.failedCommit('No matching automatic batch session is active.');
        }
        if (state.lastCommit
            && state.lastCommit.startOffset === range.startOffset
            && state.lastCommit.endOffset === range.endOffset) {
            return state.lastCommit.result;
        }
        if (!state.pendingWindow
            || state.pendingWindow.startOffset !== range.startOffset
            || state.pendingWindow.endOffset !== range.endOffset) {
            return this.failedCommit('Compaction acknowledgement does not match the pending window.');
        }

        const result = this.dependencies.commitAutoBatchWindow({
            ...range,
            autoBatchLimit: state.limit
        });
        if (result.success) {
            state.cursor = range.endOffset;
            state.lastCommit = { ...range, result };
        }
        return result;
    }

    finish(jobId: string): void {
        if (this.state?.jobId === jobId) this.stopSession();
    }

    cancel(jobId: string): void {
        if (this.state?.jobId === jobId) this.stopSession();
    }

    getJobId(): string | null {
        return this.state?.jobId ?? null;
    }

    reset(): void {
        this.stopSession();
    }

    private failedCommit(error: string): ContentCommitResult {
        return { success: false, baseOffset: -1, retainedCount: -1, removedIds: [], error };
    }

    private startPolling(): void {
        this.pollTimer = this.setIntervalFn(() => this.poll(), 1000);
    }

    private stopPolling(): void {
        if (this.pollTimer === null) return;
        this.clearIntervalFn(this.pollTimer);
        this.pollTimer = null;
    }

    private stopSession(): void {
        this.stopPolling();
        this.dependencies.stopAutoScroll();
        this.state = null;
    }

    private async poll(): Promise<void> {
        const state = this.state;
        if (!state || state.awaitingBatch) return;

        this.dependencies.scanForImages();
        const exhausted = this.dependencies.getAutoScrollStopReason() === 'exhausted';
        if (this.dependencies.getAutoEligibleWindow) {
            const window = this.dependencies.getAutoEligibleWindow(state.cursor, state.limit, exhausted);
            if (window.records.length === 0) {
                if (exhausted) await this.finishExhaustedSession(state);
                return;
            }
            await this.sendWindow(state, window, true);
            return;
        }

        const totalImages = this.dependencies.getTotalImages();
        const plan = getAutoBatchPlan(totalImages, state.cursor, true, {
            limit: state.limit,
            autoScrollExhausted: exhausted
        });
        if (!plan.shouldStart) {
            if (exhausted && totalImages <= state.cursor) await this.finishExhaustedSession(state);
            return;
        }
        const images = this.dependencies.getImagesInRange(plan.startIndex, plan.endIndex);
        if (images.length === 0) return;
        await this.sendWindow(state, {
            records: images,
            startOffset: plan.startIndex,
            endOffset: plan.endIndex,
            finalWindow: plan.partial
        }, false);
    }

    private async sendWindow(
        state: AutoBatchSessionState,
        window: EligibleWindow,
        absoluteContract: boolean
    ): Promise<void> {
        state.awaitingBatch = true;
        state.pendingWindow = {
            startOffset: window.startOffset,
            endOffset: window.endOffset
        };
        this.stopPolling();
        this.dependencies.stopAutoScroll();
        const message: Record<string, unknown> = {
            action: 'autoBatchWindowReady',
            jobId: state.jobId,
            images: window.records,
            settings: state.settings,
            startIndex: window.startOffset,
            endIndex: window.endOffset,
            finalWindow: window.finalWindow
        };
        if (absoluteContract) {
            message.startOffset = window.startOffset;
            message.endOffset = window.endOffset;
            message.baseOffset = window.baseOffset;
        }
        try {
            const response = await this.dependencies.sendMessage(message) as { accepted?: boolean } | undefined;
            if (response?.accepted === false) this.retryWindow(state);
        } catch {
            this.retryWindow(state);
        }
    }

    private retryWindow(state: AutoBatchSessionState): void {
        state.awaitingBatch = false;
        state.pendingWindow = null;
        this.dependencies.startAutoScroll();
        this.startPolling();
    }

    private async finishExhaustedSession(state: AutoBatchSessionState): Promise<void> {
        try {
            const response = await this.dependencies.sendMessage({
                action: 'finishAutoBatchSession',
                jobId: state.jobId
            }) as { success?: boolean } | undefined;
            if (response?.success === true) this.stopSession();
        } catch {
            // Keep the session alive so the next poll retries the handshake.
        }
    }
}
