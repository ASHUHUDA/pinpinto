export type ViewportCandidate = {
    top: number;
    bottom: number;
};

export function findViewportAnchorIndex(
    candidates: ViewportCandidate[],
    viewportHeight: number
): number {
    for (let index = 0; index < candidates.length; index++) {
        const candidate = candidates[index];
        if (candidate.bottom > 0 && candidate.top < viewportHeight) {
            return index;
        }
    }

    for (let index = 0; index < candidates.length; index++) {
        if (candidates[index].top >= 0) {
            return index;
        }
    }

    return 0;
}

export function splitOrderedIdsAtIndex<T>(
    items: T[],
    startIndex: number
): { discarded: T[]; remaining: T[] } {
    const safeStartIndex = Math.max(0, Math.floor(startIndex));
    return {
        discarded: items.slice(0, safeStartIndex),
        remaining: items.slice(safeStartIndex)
    };
}

export function sliceOrderedItems<T>(
    items: T[],
    startIndex: number,
    endIndex: number
): T[] {
    const safeStartIndex = Math.max(0, Math.floor(startIndex));
    const safeEndIndex = Math.max(safeStartIndex, Math.floor(endIndex));
    return items.slice(safeStartIndex, safeEndIndex);
}
