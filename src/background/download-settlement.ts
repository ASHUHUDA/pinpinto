export type DownloadSettlementKind = 'zip' | 'fallback' | 'individual';

export type DownloadTerminalState = 'complete' | 'interrupted' | 'missing';

export type DownloadSettlementEntry = {
    downloadId: number;
    kind: DownloadSettlementKind;
    state: 'pending' | DownloadTerminalState;
    blobLeaseJobId?: string;
};

export type DownloadSettlement = {
    downloads: Record<string, DownloadSettlementEntry>;
};

export type DownloadSettlementOutcome =
    | { status: 'pending'; pendingIds: number[] }
    | { status: 'complete'; pendingIds: [] }
    | { status: 'failed'; failedIds: number[]; pendingIds: number[] };

export function createDownloadSettlement(
    entries: DownloadSettlementEntry[] = []
): DownloadSettlement {
    return {
        downloads: Object.fromEntries(entries.map((entry) => [String(entry.downloadId), { ...entry }]))
    };
}

export function registerExpectedDownload(
    settlement: DownloadSettlement,
    entry: Pick<DownloadSettlementEntry, 'downloadId' | 'kind' | 'blobLeaseJobId'>
): DownloadSettlement {
    const key = String(entry.downloadId);
    const existing = settlement.downloads[key];
    if (existing) return settlement;
    return {
        downloads: {
            ...settlement.downloads,
            [key]: { ...entry, state: 'pending' }
        }
    };
}

export function settleDownload(
    settlement: DownloadSettlement,
    downloadId: number,
    state: DownloadTerminalState
): DownloadSettlement {
    const key = String(downloadId);
    const existing = settlement.downloads[key];
    if (!existing || existing.state !== 'pending') return settlement;
    return {
        downloads: {
            ...settlement.downloads,
            [key]: { ...existing, state }
        }
    };
}

export function getSettlementOutcome(settlement: DownloadSettlement): DownloadSettlementOutcome {
    const entries = Object.values(settlement.downloads).sort((left, right) => left.downloadId - right.downloadId);
    const pendingIds = entries.filter((entry) => entry.state === 'pending').map((entry) => entry.downloadId);
    const failedIds = entries.filter((entry) => entry.state === 'interrupted' || entry.state === 'missing')
        .map((entry) => entry.downloadId);
    if (failedIds.length > 0) return { status: 'failed', failedIds, pendingIds };
    if (pendingIds.length > 0) return { status: 'pending', pendingIds };
    return { status: 'complete', pendingIds: [] };
}
