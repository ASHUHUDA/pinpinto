import type { BatchStartResult, BatchTaskSnapshot } from './batch-task';

type SnapshotListener = (snapshot: BatchTaskSnapshot) => void;

export class BatchTaskClient {
    private currentJobId: string | null = null;

    constructor(private readonly onSnapshot: SnapshotListener) {}

    async restore(): Promise<BatchTaskSnapshot | null> {
        const response = await chrome.runtime.sendMessage({ action: 'getBatchTaskState' });
        const snapshot = response?.snapshot as BatchTaskSnapshot | null | undefined;
        if (!snapshot?.jobId) return null;
        this.applySnapshot(snapshot);
        return snapshot;
    }

    async start(request: Record<string, unknown>): Promise<BatchStartResult> {
        const response = await chrome.runtime.sendMessage({ action: 'downloadImages', ...request }) as BatchStartResult;
        if (response?.jobId) {
            this.currentJobId = response.jobId;
        }
        return response;
    }

    acceptMessage(message: { action?: string; snapshot?: BatchTaskSnapshot }): boolean {
        if (message.action !== 'batchTaskStateChanged' || !message.snapshot?.jobId) {
            return false;
        }
        if (this.currentJobId && message.snapshot.jobId !== this.currentJobId) {
            return false;
        }
        this.applySnapshot(message.snapshot);
        return true;
    }

    async cancel(): Promise<boolean> {
        if (!this.currentJobId) return false;
        const response = await chrome.runtime.sendMessage({
            action: 'cancelCurrentBatch',
            jobId: this.currentJobId
        });
        return response?.success === true;
    }

    getJobId(): string | null {
        return this.currentJobId;
    }

    private applySnapshot(snapshot: BatchTaskSnapshot): void {
        this.currentJobId = snapshot.jobId;
        this.onSnapshot(snapshot);
    }
}
