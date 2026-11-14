export const BACKGROUND_RUNTIME_STATE_KEY = 'pinpintoBackgroundRuntimeState';

const MAX_EXTERNAL_DOWNLOAD_IDS = 128;
const MAX_REQUESTED_FILENAMES = 128;

type SessionStorageArea = {
    get: (key?: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
};

type PersistedBackgroundRuntimeState = {
    externalDownloadIds?: number[];
    requestedFilenames?: Array<[string, string]>;
};

export class BackgroundRuntimeState {
    private readonly externalDownloadIds = new Map<number, true>();
    private readonly requestedFilenames = new Map<string, string>();
    private readonly ready: Promise<void>;
    private writeQueue: Promise<void> = Promise.resolve();

    constructor(private readonly storage: SessionStorageArea = chrome.storage.session) {
        this.ready = this.restore();
    }

    async waitUntilReady(): Promise<void> {
        await this.ready;
    }

    async rememberExternalDownload(downloadId: number): Promise<void> {
        await this.ready;
        if (this.externalDownloadIds.has(downloadId)) return;
        this.externalDownloadIds.set(downloadId, true);
        this.trimMap(this.externalDownloadIds, MAX_EXTERNAL_DOWNLOAD_IDS);
        await this.persist();
    }

    async consumeExternalDownload(downloadId: number): Promise<boolean> {
        await this.ready;
        const consumed = this.externalDownloadIds.delete(downloadId);
        if (consumed) await this.persist();
        return consumed;
    }

    async rememberRequestedFilename(url: string, filename: string): Promise<void> {
        await this.ready;
        if (!url || !filename) return;
        this.requestedFilenames.delete(url);
        this.requestedFilenames.set(url, filename);
        this.trimMap(this.requestedFilenames, MAX_REQUESTED_FILENAMES);
        await this.persist();
    }

    async takeRequestedFilename(url: string): Promise<string | undefined> {
        await this.ready;
        const direct = this.requestedFilenames.get(url);
        if (direct !== undefined) {
            this.requestedFilenames.delete(url);
            await this.persist();
            return direct;
        }

        const first = this.requestedFilenames.entries().next().value as [string, string] | undefined;
        if (!first) return undefined;
        this.requestedFilenames.delete(first[0]);
        await this.persist();
        return first[1];
    }

    private async restore(): Promise<void> {
        const stored = await this.storage.get(BACKGROUND_RUNTIME_STATE_KEY);
        const state = stored[BACKGROUND_RUNTIME_STATE_KEY] as PersistedBackgroundRuntimeState | undefined;
        if (!state || typeof state !== 'object') return;

        for (const downloadId of Array.isArray(state.externalDownloadIds) ? state.externalDownloadIds : []) {
            if (Number.isInteger(downloadId) && downloadId >= 0) this.externalDownloadIds.set(downloadId, true);
        }
        for (const entry of Array.isArray(state.requestedFilenames) ? state.requestedFilenames : []) {
            if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'string' && entry[0] && entry[1]) {
                this.requestedFilenames.set(entry[0], entry[1]);
            }
        }
        this.trimMap(this.externalDownloadIds, MAX_EXTERNAL_DOWNLOAD_IDS);
        this.trimMap(this.requestedFilenames, MAX_REQUESTED_FILENAMES);
    }

    private persist(): Promise<void> {
        const operation = this.writeQueue.then(async () => {
            await this.storage.set({
                [BACKGROUND_RUNTIME_STATE_KEY]: {
                    externalDownloadIds: [...this.externalDownloadIds.keys()],
                    requestedFilenames: [...this.requestedFilenames.entries()]
                } satisfies PersistedBackgroundRuntimeState
            });
        });
        this.writeQueue = operation.catch(() => undefined);
        return operation;
    }

    private trimMap<K, V>(map: Map<K, V>, limit: number): void {
        while (map.size > limit) {
            const oldest = map.keys().next().value as K | undefined;
            if (oldest === undefined) return;
            map.delete(oldest);
        }
    }
}
