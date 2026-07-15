export function rememberBounded<K, V>(map: Map<K, V>, key: K, value: V, limit = 128): void {
    if (map.has(key)) return;
    map.set(key, value);
    if (map.size <= limit) return;
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
}

export function shouldBufferEarlyTerminal(input: {
    registered: boolean;
    hasActiveWindow: boolean;
    terminalJob: boolean;
    currentJobId?: string;
    metadataJobId?: string;
}): boolean {
    return !input.registered
        && input.hasActiveWindow
        && !input.terminalJob
        && (!input.metadataJobId || input.metadataJobId === input.currentJobId);
}
