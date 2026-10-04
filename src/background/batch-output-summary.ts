import type { BatchTaskSnapshot } from '../shared/batch-task';

export function formatBatchOutputSummary(snapshot: BatchTaskSnapshot): string {
    if (snapshot.outputMode === 'aria2') {
        return `aria2 提交结束：已接收 ${snapshot.aria2SubmittedCount ?? 0} 张，明确拒绝并跳过 ${snapshot.aria2RejectedCount ?? 0} 张。文件下载由下载器负责，并非下载完成。`;
    }
    if (snapshot.zippedCount === 0 && snapshot.fallbackCount > 0 && snapshot.unresolvedCount === 0) {
        return `已由浏览器完成 ${snapshot.fallbackCount} 张单独下载。`;
    }
    return `ZIP 图片 ${snapshot.zippedCount} 张，浏览器补救成功 ${snapshot.fallbackCount} 张，未解决 ${snapshot.unresolvedCount} 张。`;
}
