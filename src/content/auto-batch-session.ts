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

type AutoBatchSessionDependencies = {
    scanForImages: () => void;
    getTotalImages: () => number;
    getImagesInRange: (startIndex: number, endIndex: number) => unknown[];
    getViewportAnchorIndex: () => number;
    discardImagesBeforeIndex: (startIndex: number) => unknown;
    startAutoScroll: () => void;
    stopAutoScroll: () => void;
    getAutoScrollStopReason: () => 'manual' | 'exhausted' | null;
    sendMessage: (message: Record<string, unknown>) => Promise<unknown>;
    setInterval?: (callback: () => void | Promise<void>, delay: number) => number;
    clearInterval?: (timerId: number) => void;
};

type AutoBatchSessionState = {
    jobId: string;
    cursor: number;
    limit: number;
    settings: Record<string, unknown>;
    awaitingBatch: boolean;
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
        const resumeInput = getAutoBatchResumeInput(
            response?.snapshot,
            response?.matchesTargetTab === true
        );
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
        this.dependencies.discardImagesBeforeIndex(anchorIndex);
        this.state = {
            jobId: input.jobId,
            cursor: 0,
            limit: normalizeAutoBatchLimit(input.limit),
            settings: input.settings,
            awaitingBatch: false
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
            awaitingBatch: false
        };
        this.dependencies.startAutoScroll();
        this.startPolling();
    }

    finish(jobId: string): void {
        if (this.state?.jobId !== jobId) return;
        this.stopSession();
    }

    cancel(jobId: string): void {
        if (this.state?.jobId !== jobId) return;
        this.stopSession();
    }

    getJobId(): string | null {
        return this.state?.jobId ?? null;
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
        const totalImages = this.dependencies.getTotalImages();
        const exhausted = this.dependencies.getAutoScrollStopReason() === 'exhausted';
        const plan = getAutoBatchPlan(totalImages, state.cursor, true, {
            limit: state.limit,
            autoScrollExhausted: exhausted
        });

        if (!plan.shouldStart) {
            if (exhausted && totalImages <= state.cursor) {
                const jobId = state.jobId;
                try {
                    const response = await this.dependencies.sendMessage({
                        action: 'finishAutoBatchSession',
                        jobId
                    }) as { success?: boolean } | undefined;
                    if (response?.success === true) this.stopSession();
                } catch {
                    // Keep the exhausted session alive so the next poll retries the handshake.
                }
            }
            return;
        }

        const images = this.dependencies.getImagesInRange(plan.startIndex, plan.endIndex);
        if (images.length === 0) return;

        state.awaitingBatch = true;
        this.stopPolling();
        this.dependencies.stopAutoScroll();
        try {
            const response = await this.dependencies.sendMessage({
                action: 'autoBatchWindowReady',
                jobId: state.jobId,
                images,
                settings: state.settings,
                startIndex: plan.startIndex,
                endIndex: plan.endIndex,
                finalWindow: plan.partial
            }) as { accepted?: boolean } | undefined;
            if (response?.accepted === false) {
                state.awaitingBatch = false;
                this.dependencies.startAutoScroll();
                this.startPolling();
            }
        } catch {
            state.awaitingBatch = false;
            this.dependencies.startAutoScroll();
            this.startPolling();
        }
    }
}
