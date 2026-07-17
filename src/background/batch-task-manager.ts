import {
    isTerminalBatchPhase,
    type BatchStartResult,
    type BatchOutputMode,
    type BatchTaskMode,
    type BatchTaskSnapshot
} from '../shared/batch-task';
import { normalizeAutoBatchTotalBatches } from '../shared/download-batching';

export const BATCH_TASK_STORAGE_KEY = 'pinpintoBatchTask';

type SessionStorageArea = {
    get: (key?: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
    remove?: (key: string) => Promise<void>;
};

type BatchTaskManagerOptions = {
    storage?: SessionStorageArea;
    broadcast?: (snapshot: BatchTaskSnapshot) => void | Promise<void>;
    now?: () => number;
    createJobId?: () => string;
};

type StartTaskInput = {
    mode: BatchTaskMode;
    outputMode?: BatchOutputMode;
    targetTabId?: number | null;
    totalImages?: number;
    autoBatchLimit?: number;
    autoBatchTotalBatches?: number;
    settings?: Record<string, unknown>;
};

export class BatchTaskManager {
    private snapshot: BatchTaskSnapshot | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private initialized = false;
    private readonly storage: SessionStorageArea;
    private readonly broadcast: (snapshot: BatchTaskSnapshot) => void | Promise<void>;
    private readonly now: () => number;
    private readonly createJobId: () => string;

    constructor(options: BatchTaskManagerOptions = {}) {
        this.storage = options.storage ?? chrome.storage.session;
        this.broadcast = options.broadcast ?? (() => {});
        this.now = options.now ?? (() => Date.now());
        this.createJobId = options.createJobId
            ?? (() => `${Date.now()}-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`);
    }

    async initialize(): Promise<BatchTaskSnapshot | null> {
        return this.enqueue(async () => {
            if (this.initialized) return this.cloneSnapshot();
            const stored = await this.storage.get(BATCH_TASK_STORAGE_KEY);
            const candidate = stored[BATCH_TASK_STORAGE_KEY] as BatchTaskSnapshot | undefined;
            this.snapshot = candidate?.jobId ? normalizeSnapshot(candidate) : null;
            this.initialized = true;
            if (this.snapshot?.phase === 'completed') {
                await this.broadcast(this.cloneSnapshot()!);
                this.snapshot = null;
                if (this.storage.remove) await this.storage.remove(BATCH_TASK_STORAGE_KEY);
                else await this.storage.set({ [BATCH_TASK_STORAGE_KEY]: null });
            }
            return this.cloneSnapshot();
        });
    }

    async start(input: StartTaskInput): Promise<BatchStartResult> {
        return this.enqueue(async () => {
            if (this.snapshot && !isTerminalBatchPhase(this.snapshot.phase)) {
                return {
                    accepted: false,
                    jobId: this.snapshot.jobId,
                    reason: 'batch-task-running'
                };
            }

            const now = this.now();
            const jobId = this.createJobId();
            this.snapshot = {
                jobId,
                mode: input.mode,
                outputMode: input.mode === 'auto' ? 'zip' : input.outputMode === 'individual' ? 'individual' : 'zip',
                targetTabId: typeof input.targetTabId === 'number' ? input.targetTabId : null,
                phase: 'queued',
                batchCursor: 0,
                progress: 0,
                details: '任务已接受，正在准备。',
                totalImages: Math.max(0, Math.floor(input.totalImages ?? 0)),
                zippedCount: 0,
                fallbackCount: 0,
                unresolvedCount: 0,
                individualCount: 0,
                failedCount: 0,
                cancelledCount: 0,
                associatedDownloadIds: [],
                pendingFallbackDownloadIds: [],
                activeWindow: null,
                autoSessionFinished: input.mode === 'manual',
                autoBatchLimit: Math.max(1, Math.floor(input.autoBatchLimit ?? 100)),
                autoBatchTotalBatches: normalizeAutoBatchTotalBatches(input.autoBatchTotalBatches),
                autoBatchCompletedBatches: 0,
                autoStopRequested: false,
                continueAutoScrollAfterStop: false,
                settings: input.settings ?? {},
                createdAt: now,
                updatedAt: now
            };
            await this.persistAndBroadcastCurrent();
            return { accepted: true, jobId };
        });
    }

    async update(
        jobId: string,
        patch: Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>
    ): Promise<BatchTaskSnapshot | null> {
        return this.enqueue(async () => {
            if (!this.snapshot || this.snapshot.jobId !== jobId) return null;
            this.applyPatch(jobId, patch);
            await this.persistAndBroadcastCurrent();
            return this.cloneSnapshot();
        });
    }

    async mutate(
        jobId: string,
        updater: (snapshot: BatchTaskSnapshot) => Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>
    ): Promise<BatchTaskSnapshot | null> {
        return this.enqueue(async () => {
            if (!this.snapshot || this.snapshot.jobId !== jobId) return null;
            this.applyPatch(jobId, updater(this.cloneSnapshot()!));
            await this.persistAndBroadcastCurrent();
            return this.cloneSnapshot();
        });
    }

    async cancel(jobId?: string): Promise<BatchTaskSnapshot | null> {
        return this.enqueue(async () => {
            if (!this.snapshot || isTerminalBatchPhase(this.snapshot.phase)) return null;
            if (jobId && this.snapshot.jobId !== jobId) return null;
            this.applyPatch(this.snapshot.jobId, {
                phase: 'cancelled',
                progress: 100,
                details: '任务已取消。',
                autoSessionFinished: true
            });
            await this.persistAndBroadcastCurrent();
            return this.cloneSnapshot();
        });
    }

    async requestAutoStop(jobId: string | undefined, continueAutoScroll: boolean): Promise<BatchTaskSnapshot | null> {
        return this.enqueue(async () => {
            if (!this.snapshot || this.snapshot.mode !== 'auto' || isTerminalBatchPhase(this.snapshot.phase)) return null;
            if (jobId && this.snapshot.jobId !== jobId) return null;
            this.applyPatch(this.snapshot.jobId, {
                autoStopRequested: true,
                continueAutoScrollAfterStop: continueAutoScroll === true,
                details: '将在当前批次完成后停止。'
            });
            await this.persistAndBroadcastCurrent();
            return this.cloneSnapshot();
        });
    }

    async clearCompleted(
        jobId: string,
        finalPatch?: Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>,
        beforeClear?: (snapshot: BatchTaskSnapshot) => boolean | Promise<boolean>
    ): Promise<boolean> {
        return this.enqueue(async () => {
            if (!this.snapshot || this.snapshot.jobId !== jobId) return false;
            const previousSnapshot = this.cloneSnapshot();
            if (finalPatch) this.applyPatch(jobId, { ...finalPatch, phase: 'completed' });
            if (this.snapshot.phase !== 'completed') return false;
            const finalSnapshot = this.cloneSnapshot()!;
            await this.broadcast(finalSnapshot);
            try {
                if (beforeClear && await beforeClear(finalSnapshot) !== true) {
                    this.snapshot = previousSnapshot;
                    return false;
                }
            } catch {
                this.snapshot = previousSnapshot;
                return false;
            }
            this.snapshot = null;
            if (this.storage.remove) await this.storage.remove(BATCH_TASK_STORAGE_KEY);
            else await this.storage.set({ [BATCH_TASK_STORAGE_KEY]: null });
            return true;
        });
    }

    getSnapshot(): BatchTaskSnapshot | null {
        return this.cloneSnapshot();
    }

    private applyPatch(
        jobId: string,
        patch: Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>
    ): void {
        if (!this.snapshot) return;
        this.snapshot = {
            ...this.snapshot,
            ...patch,
            jobId,
            createdAt: this.snapshot.createdAt,
            updatedAt: this.now()
        };
    }

    private async persistAndBroadcastCurrent(): Promise<void> {
        const snapshot = this.cloneSnapshot();
        if (!snapshot) return;
        await this.storage.set({ [BATCH_TASK_STORAGE_KEY]: snapshot });
        await this.broadcast(snapshot);
    }

    private cloneSnapshot(): BatchTaskSnapshot | null {
        return this.snapshot ? structuredClone(this.snapshot) : null;
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}

function normalizeSnapshot(candidate: BatchTaskSnapshot): BatchTaskSnapshot {
    const mode = candidate.mode === 'auto' ? 'auto' : 'manual';
    return {
        ...candidate,
        mode,
        outputMode: mode === 'auto' ? 'zip' : candidate.outputMode === 'individual' ? 'individual' : 'zip',
        targetTabId: typeof candidate.targetTabId === 'number' ? candidate.targetTabId : null,
        associatedDownloadIds: uniqueNumbers(candidate.associatedDownloadIds),
        pendingFallbackDownloadIds: uniqueNumbers(candidate.pendingFallbackDownloadIds),
        activeWindow: candidate.activeWindow ? {
            ...candidate.activeWindow,
            individualQueue: Array.isArray(candidate.activeWindow.individualQueue)
                ? candidate.activeWindow.individualQueue
                : []
        } : null,
        individualCount: nonNegativeInteger(candidate.individualCount),
        failedCount: nonNegativeInteger(candidate.failedCount),
        cancelledCount: nonNegativeInteger(candidate.cancelledCount),
        autoBatchLimit: Math.max(1, Math.floor(candidate.autoBatchLimit ?? 100)),
        autoBatchTotalBatches: normalizeAutoBatchTotalBatches(candidate.autoBatchTotalBatches),
        autoBatchCompletedBatches: Math.max(0, Math.floor(candidate.autoBatchCompletedBatches ?? 0)),
        autoStopRequested: candidate.autoStopRequested === true,
        continueAutoScrollAfterStop: candidate.continueAutoScrollAfterStop === true,
        settings: candidate.settings ?? {}
    };
}

function nonNegativeInteger(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : 0;
}

function uniqueNumbers(values: unknown): number[] {
    return Array.isArray(values)
        ? [...new Set(values.filter((value): value is number => Number.isInteger(value)))]
        : [];
}
