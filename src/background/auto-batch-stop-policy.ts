import type { BatchTaskSnapshot } from '../shared/batch-task';
import { BatchTaskManager } from './batch-task-manager';
import { sendTabMessage } from './tab-messaging';

export function shouldStopAutoBatch(snapshot: BatchTaskSnapshot): boolean {
    return snapshot.mode === 'auto' && snapshot.autoStopRequested === true;
}

export async function finalizeStoppedAutoBatch(
    taskManager: BatchTaskManager,
    snapshot: BatchTaskSnapshot
): Promise<boolean> {
    return taskManager.clearCompleted(snapshot.jobId, {
        progress: 100,
        details: '当前批次已完成，自动下载已停止。',
        autoSessionFinished: true
    }, async () => {
        if (snapshot.targetTabId === null) return true;
        const response = await sendTabMessage(snapshot.targetTabId, {
            action: 'finishAutoBatchSession',
            jobId: snapshot.jobId,
            continueAutoScroll: snapshot.continueAutoScrollAfterStop
        });
        return response?.success === true;
    });
}
