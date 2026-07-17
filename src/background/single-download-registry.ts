import type { DownloadTerminalState } from './download-settlement';
import { rememberBounded } from './early-terminal-buffer';

export const SINGLE_DOWNLOAD_STORAGE_KEY = 'pinpintoSingleDownloads';

export type SingleDownloadRecord = {
    downloadId: number;
    targetTabId: number | null;
    imageId: string | null;
    requestedFilename: string;
    blobLeaseJobId?: string;
    state: 'pending';
    createdAt: number;
};

type StorageArea = {
    get: (key?: string) => Promise<Record<string, unknown>>;
    set: (value: Record<string, unknown>) => Promise<void>;
};

type RegistryOptions = {
    storage?: StorageArea;
    search?: (query: chrome.downloads.DownloadQuery) => Promise<chrome.downloads.DownloadItem[]>;
    notify?: (record: SingleDownloadRecord, state: 'complete' | 'interrupted', error?: string) => Promise<void>;
    onRemoved?: (record: SingleDownloadRecord) => void | Promise<void>;
    now?: () => number;
};

type BufferedTerminal = { state: DownloadTerminalState; error?: string };

export class SingleDownloadRegistry {
    private readonly records = new Map<number, SingleDownloadRecord>();
    private readonly earlyTerminals = new Map<number, BufferedTerminal>();
    private readonly settledIds = new Map<number, true>();
    private readonly storage: StorageArea;
    private readonly search: (query: chrome.downloads.DownloadQuery) => Promise<chrome.downloads.DownloadItem[]>;
    private readonly notify: NonNullable<RegistryOptions['notify']>;
    private readonly onRemoved: NonNullable<RegistryOptions['onRemoved']>;
    private readonly now: () => number;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly ready: Promise<void>;

    constructor(options: RegistryOptions = {}) {
        this.storage = options.storage ?? chrome.storage.session;
        this.search = options.search ?? ((query) => chrome.downloads.search(query));
        this.notify = options.notify ?? (async () => {});
        this.onRemoved = options.onRemoved ?? (() => {});
        this.now = options.now ?? (() => Date.now());
        this.ready = this.initialize();
    }

    async register(input: Omit<SingleDownloadRecord, 'state' | 'createdAt'>): Promise<SingleDownloadRecord> {
        await this.ready;
        return this.enqueue(async () => {
            const record: SingleDownloadRecord = { ...input, state: 'pending', createdAt: this.now() };
            this.records.set(record.downloadId, record);
            try {
                await this.persist();
                const early = this.earlyTerminals.get(record.downloadId);
                if (early) {
                    this.earlyTerminals.delete(record.downloadId);
                    await this.settleKnown(record, early.state, early.error);
                    return record;
                }
                await this.reconcileKnown(record, false);
                return record;
            } catch (error) {
                if (this.records.delete(record.downloadId)) {
                    rememberBounded(this.settledIds, record.downloadId, true);
                    await this.onRemoved(record);
                }
                throw error;
            }
        });
    }

    async handleTerminal(downloadId: number, state: DownloadTerminalState, error?: string): Promise<void> {
        await this.ready;
        await this.enqueue(async () => {
            if (this.settledIds.has(downloadId)) return;
            const record = this.records.get(downloadId);
            if (!record) {
                rememberBounded(this.earlyTerminals, downloadId, { state, error });
                return;
            }
            await this.settleKnown(record, state, error);
        });
    }

    async ignoreUntrackedDownload(downloadId: number): Promise<void> {
        await this.ready;
        await this.enqueue(async () => {
            this.earlyTerminals.delete(downloadId);
            rememberBounded(this.settledIds, downloadId, true);
        });
    }

    async removeForTab(tabId: number): Promise<void> {
        await this.ready;
        await this.enqueue(async () => {
            for (const record of [...this.records.values()]) {
                if (record.targetTabId !== tabId) continue;
                this.records.delete(record.downloadId);
                rememberBounded(this.settledIds, record.downloadId, true);
                await this.onRemoved(record);
            }
            await this.persist();
        });
    }

    async getRecords(): Promise<SingleDownloadRecord[]> {
        await this.ready;
        await this.queue;
        return [...this.records.values()].map((record) => ({ ...record }));
    }

    async getActiveBlobLeaseJobIds(): Promise<string[]> {
        const records = await this.getRecords();
        return [...new Set(records
            .map((record) => record.blobLeaseJobId)
            .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0))];
    }

    private async initialize(): Promise<void> {
        const stored = await this.storage.get(SINGLE_DOWNLOAD_STORAGE_KEY);
        const candidates = stored[SINGLE_DOWNLOAD_STORAGE_KEY];
        if (Array.isArray(candidates)) {
            for (const candidate of candidates as SingleDownloadRecord[]) {
                if (Number.isInteger(candidate?.downloadId)) this.records.set(candidate.downloadId, candidate);
            }
        }
        for (const record of [...this.records.values()]) await this.reconcileKnown(record, true);
    }

    private async reconcileKnown(record: SingleDownloadRecord, missingIsInterrupted: boolean): Promise<void> {
        try {
            const items = await this.search({ id: record.downloadId });
            const item = items[0];
            if (item?.state === 'complete' || item?.state === 'interrupted') {
                await this.settleKnown(record, item.state, item.error);
            } else if (!item && missingIsInterrupted) {
                await this.settleKnown(record, 'missing', 'Browser download record is missing after restart.');
            }
        } catch {
            // A live onChanged event remains authoritative when search is temporarily unavailable.
        }
    }

    private async settleKnown(
        record: SingleDownloadRecord,
        state: DownloadTerminalState,
        error?: string
    ): Promise<void> {
        if (!this.records.has(record.downloadId)) return;
        rememberBounded(this.settledIds, record.downloadId, true);
        this.records.delete(record.downloadId);
        const contentState = state === 'complete' ? 'complete' : 'interrupted';
        if (record.targetTabId !== null && record.imageId) {
            await this.notify(record, contentState, error).catch(() => {});
        }
        try {
            await this.onRemoved(record);
        } finally {
            await this.persist();
        }
    }

    private async persist(): Promise<void> {
        await this.storage.set({ [SINGLE_DOWNLOAD_STORAGE_KEY]: [...this.records.values()] });
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.queue.then(operation, operation);
        this.queue = result.then(() => undefined, () => undefined);
        return result;
    }
}
