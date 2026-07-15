import type { PinterestImageSource } from './image-classifier';

export type CompactableSessionRecord = {
    id: string;
    source: PinterestImageSource;
    absoluteOrdinal?: number;
    connected?: boolean;
    element?: { isConnected?: boolean } | null;
};

export type CompactAutoSessionOptions = {
    settledThroughOffset: number;
    autoBatchLimit: number;
};

function isConnected(record: CompactableSessionRecord): boolean {
    if (typeof record.connected === 'boolean') return record.connected;
    return record.element?.isConnected !== false;
}

function isProcessed(record: CompactableSessionRecord, settledThroughOffset: number): boolean {
    if (typeof record.absoluteOrdinal !== 'number') return false;
    return record.absoluteOrdinal < settledThroughOffset;
}

export function compactAutoSessionWindow<T extends CompactableSessionRecord>(
    records: readonly T[],
    options: CompactAutoSessionOptions
): { records: T[]; baseOffset: number; removedIds: string[] } {
    const settledThroughOffset = Math.max(0, Math.floor(options.settledThroughOffset));
    const recommendationLimit = Math.max(1, Math.floor(options.autoBatchLimit));
    const removedIds: string[] = [];
    const removed = new Set<string>();

    const remove = (record: T) => {
        if (removed.has(record.id)) return;
        removed.add(record.id);
        removedIds.push(record.id);
    };

    // Disconnected references are cheapest to release, but an eligible record that
    // has not crossed the settlement boundary remains retryable and is retained.
    records.forEach((record) => {
        if (!isConnected(record) && (
            record.source === 'recommendation' || isProcessed(record, settledThroughOffset)
        )) {
            remove(record);
        }
    });

    records.forEach((record) => {
        if (!removed.has(record.id) && isProcessed(record, settledThroughOffset)) {
            remove(record);
        }
    });

    const recommendations = records.filter((record) => (
        record.source === 'recommendation' && !removed.has(record.id)
    ));
    recommendations.slice(0, Math.max(0, recommendations.length - recommendationLimit))
        .forEach(remove);

    return {
        records: records.filter((record) => !removed.has(record.id)),
        baseOffset: settledThroughOffset,
        removedIds
    };
}
