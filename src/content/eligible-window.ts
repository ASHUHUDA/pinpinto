import type { PinterestImageSource } from './image-classifier';

export type AutoEligibleRecord = {
    source: PinterestImageSource;
    absoluteOrdinal?: number;
};

export type AutoEligibleWindowOptions = {
    pageUrl: string;
    baseOffset: number;
    cursor: number;
    limit: number;
    exhausted: boolean;
};

export type AutoEligibleWindow<T> = {
    records: T[];
    startOffset: number;
    endOffset: number;
    finalWindow: boolean;
    availableCount: number;
};

function isSearchPage(pageUrl: string): boolean {
    try {
        return new URL(pageUrl).pathname.startsWith('/search/pins/');
    } catch {
        return /^\/search\/pins\/(?:[?#]|$)/.test(pageUrl);
    }
}

export function buildAutoEligibleWindow<T extends AutoEligibleRecord>(
    records: readonly T[],
    options: AutoEligibleWindowOptions
): AutoEligibleWindow<T> {
    const baseOffset = Math.max(0, Math.floor(options.baseOffset));
    const cursor = Math.max(baseOffset, Math.floor(options.cursor));
    const limit = Math.max(1, Math.floor(options.limit));
    const searchPage = isSearchPage(options.pageUrl);
    const eligible = records.filter((record) => (
        searchPage ? record.source === 'search-result' : record.source !== 'recommendation'
    ));
    const available = eligible.filter((record, index) => (
        (record.absoluteOrdinal ?? baseOffset + index) >= cursor
    ));

    if (available.length < limit && !options.exhausted) {
        return {
            records: [],
            startOffset: cursor,
            endOffset: cursor,
            finalWindow: false,
            availableCount: available.length
        };
    }

    const windowRecords = available.slice(0, limit);
    return {
        records: windowRecords,
        startOffset: cursor,
        endOffset: cursor + windowRecords.length,
        finalWindow: options.exhausted && windowRecords.length < limit,
        availableCount: available.length
    };
}
