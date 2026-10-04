import { Aria2RpcError, type Aria2SubmitClient } from './aria2-client';
import { createConfiguredAria2Client } from './aria2-config';
import { throwIfBatchJobCancelled, type BatchJobState } from './batch-job';
import type { BatchCoordinatorHost, DownloadImage } from './batch-coordinator-types';
import { BatchTaskManager } from './batch-task-manager';
import { isTerminalBatchPhase, type Aria2WindowSubmission } from '../shared/batch-task';

export async function submitAria2Window(context: {
    taskManager: BatchTaskManager;
    host: BatchCoordinatorHost;
    runtime: BatchJobState & { controllers: Set<AbortController> };
    images: DownloadImage[];
    settings: Record<string, unknown>;
    sequenceOffset: number;
}): Promise<void> {
    const { taskManager, host, runtime, settings } = context;
    const seen = new Set<string>();
    const timestamp = host.formatLocalTimestamp();
    const entries = context.images.flatMap((image, index) => {
        const url = host.normalizeImageUrlForDeduplication(image, settings);
        if (url && seen.has(url)) return [];
        if (url) seen.add(url);
        return [{ url, filename: host.buildIndexedFilename(context.sequenceOffset + index + 1, timestamp, url,
            typeof image === 'string' ? undefined : image.originalFilename) }];
    });
    let state: Aria2WindowSubmission = {
        submittedCount: 0, rejectedCount: 0, uncertainCount: 0,
        remainingCount: entries.length, inFlight: false, done: false
    };
    const assertActive = () => {
        const latest = taskManager.getSnapshot();
        if (!latest || latest.jobId !== runtime.id || isTerminalBatchPhase(latest.phase)) runtime.cancelled = true;
        throwIfBatchJobCancelled(runtime);
    };
    const persist = async () => {
        const latest = taskManager.getSnapshot();
        if (!latest?.activeWindow || latest.jobId !== runtime.id || runtime.cancelled || isTerminalBatchPhase(latest.phase)) return;
        await taskManager.update(runtime.id, {
            phase: 'downloading',
            progress: entries.length ? 100 * (entries.length - state.remainingCount) / entries.length : 100,
            details: aria2WindowSummary(state),
            activeWindow: { ...latest.activeWindow, aria2Submission: { ...state } }
        });
    };
    await persist();
    const client: Aria2SubmitClient = await (host.createAria2Client ?? createConfiguredAria2Client)();
    for (const entry of entries) {
        assertActive();
        state.inFlight = true;
        await persist();
        assertActive();
        const controller = new AbortController();
        runtime.controllers.add(controller);
        try {
            await client.addUri(entry.url, entry.filename, controller.signal);
            state.submittedCount++;
        } catch (error) {
            if (error instanceof Aria2RpcError && error.kind === 'rejected') {
                state.rejectedCount++;
            } else {
                if (!(error instanceof Aria2RpcError) || error.kind === 'uncertain') state.uncertainCount++;
                state.remainingCount -= state.uncertainCount > 0 ? 1 : 0;
                state.inFlight = false;
                await persist();
                throw error;
            }
        } finally {
            runtime.controllers.delete(controller);
        }
        state.remainingCount--;
        state.inFlight = false;
        await persist();
        assertActive();
    }
    state.done = true;
    await persist();
}

export function markAria2InFlightUncertain(state?: Aria2WindowSubmission): Aria2WindowSubmission | undefined {
    if (!state?.inFlight) return state;
    return { ...state, uncertainCount: state.uncertainCount + 1,
        remainingCount: Math.max(0, state.remainingCount - 1), inFlight: false };
}

export function aria2WindowSummary(state?: Aria2WindowSubmission): string {
    return `aria2 提交：已接收 ${state?.submittedCount ?? 0} 张，明确拒绝并跳过 ${state?.rejectedCount ?? 0} 张，状态不明 ${state?.uncertainCount ?? 0} 张，未提交 ${state?.remainingCount ?? 0} 张。文件下载由下载器负责。`;
}
