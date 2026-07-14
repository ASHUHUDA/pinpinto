import {
    isTerminalBatchPhase,
    type BatchStartResult,
    type BatchTaskMode,
    type BatchTaskSnapshot
} from '../shared/batch-task';

export const BATCH_TASK_STORAGE_KEY = 'pinpintoBatchTask';

type SessionStorageArea = {
    get: (key?: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
};

type BatchTaskManagerOptions = {
    storage?: SessionStorageArea;
    broadcast?: (snapshot: BatchTaskSnapshot) => void | Promise<void>;
    now?: () => number;
    createJobId?: () => string;
};

type StartTaskInput = {
    mode: BatchTaskMode;
    targetTabId?: number | null;
    totalImages?: number;
    autoBatchLimit?: number;
    settings?: Record<string, unknown>;
};

const RESTART_INTERRUPTED_PHASES = new Set(['queued', 'fetching', 'compressing']);

export class BatchTaskManager {
    private snapshot: BatchTaskSnapshot | null = null;
    private persistQueue: Promise<void> = Promise.resolve();
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
        const stored = await this.storage.get(BATCH_TASK_STORAGE_KEY);
        const candidate = stored[BATCH_TASK_STORAGE_KEY] as BatchTaskSnapshot | undefined;
        this.snapshot = candidate?.jobId ? {
            ...candidate,
            targetTabId: typeof candidate.targetTabId === 'number' ? candidate.targetTabId : null,
            associatedDownloadIds: Array.isArray(candidate.associatedDownloadIds) ? candidate.associatedDownloadIds : [],
            pendingFallbackDownloadIds: Array.isArray(candidate.pendingFallbackDownloadIds) ? candidate.pendingFallbackDownloadIds : [],
            autoBatchLimit: Math.max(1, Math.floor(candidate.autoBatchLimit ?? 100)),
            settings: candidate.settings ?? {}
        } : null;

        if (this.snapshot && RESTART_INTERRUPTED_PHASES.has(this.snapshot.phase)) {
            await this.update(this.snapshot.jobId, {
                phase: 'interrupted',
                progress: 100,
                details: '后台任务在抓图或压缩阶段被中断，可重新开始。'
            });
        }

        return this.getSnapshot();
    }

    async start(input: StartTaskInput): Promise<BatchStartResult> {
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
            targetTabId: typeof input.targetTabId === 'number' ? input.targetTabId : null,
            phase: 'queued',
            batchCursor: 0,
            progress: 0,
            details: '任务已接受，正在准备。',
            totalImages: Math.max(0, Math.floor(input.totalImages ?? 0)),
            zippedCount: 0,
            fallbackCount: 0,
            unresolvedCount: 0,
            associatedDownloadIds: [],
            pendingFallbackDownloadIds: [],
            autoSessionFinished: input.mode === 'manual',
            autoBatchLimit: Math.max(1, Math.floor(input.autoBatchLimit ?? 100)),
            settings: input.settings ?? {},
            createdAt: now,
            updatedAt: now
        };
        await this.persistAndBroadcast();
        return { accepted: true, jobId };
    }

    async update(
        jobId: string,
        patch: Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>
    ): Promise<BatchTaskSnapshot | null> {
        if (!this.snapshot || this.snapshot.jobId !== jobId) {
            return null;
        }

        this.snapshot = {
            ...this.snapshot,
            ...patch,
            jobId,
            createdAt: this.snapshot.createdAt,
            updatedAt: this.now()
        };
        await this.persistAndBroadcast();
        return this.getSnapshot();
    }

    async mutate(
        jobId: string,
        updater: (snapshot: BatchTaskSnapshot) => Partial<Omit<BatchTaskSnapshot, 'jobId' | 'createdAt'>>
    ): Promise<BatchTaskSnapshot | null> {
        if (!this.snapshot || this.snapshot.jobId !== jobId) return null;
        const patch = updater(this.getSnapshot()!);
        return this.update(jobId, patch);
    }

    async cancel(jobId?: string): Promise<BatchTaskSnapshot | null> {
        if (!this.snapshot || isTerminalBatchPhase(this.snapshot.phase)) {
            return null;
        }
        if (jobId && this.snapshot.jobId !== jobId) {
            return null;
        }

        return this.update(this.snapshot.jobId, {
            phase: 'cancelled',
            progress: 100,
            details: '任务已取消。',
            autoSessionFinished: true
        });
    }

    getSnapshot(): BatchTaskSnapshot | null {
        return this.snapshot ? structuredClone(this.snapshot) : null;
    }

    private async persistAndBroadcast(): Promise<void> {
        if (!this.snapshot) return;
        const snapshot = this.getSnapshot()!;
        this.persistQueue = this.persistQueue.then(async () => {
            await this.storage.set({ [BATCH_TASK_STORAGE_KEY]: snapshot });
            await this.broadcast(snapshot);
        });
        await this.persistQueue;
    }
}
