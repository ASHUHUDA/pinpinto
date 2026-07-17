import type { BlobJobHost, BlobJobRequest, BlobJobResult, BlobJobStatus } from './blob-runner';
import {
    OFFSCREEN_DOCUMENT_PATH,
    OFFSCREEN_MESSAGE_TARGET,
    type OffscreenBlobMessage,
    type OffscreenBlobResponse
} from './offscreen-protocol';

type OffscreenApi = typeof chrome.offscreen;

type ExtensionRuntimeWithContexts = typeof chrome.runtime & {
    getContexts?: (filter: {
        contextTypes?: string[];
        documentUrls?: string[];
    }) => Promise<Array<{ contextType?: string; documentUrl?: string }>>;
};

type ClientsApi = {
    matchAll?: () => Promise<Array<{ url?: string }>>;
};

type GlobalWithClients = typeof globalThis & {
    clients?: ClientsApi;
};

const OFFSCREEN_CONTEXT_TYPE = 'OFFSCREEN_DOCUMENT';

export class OffscreenBlobJobHost implements BlobJobHost {
    private documentPromise: Promise<void> | null = null;

    constructor(
        private readonly offscreen: OffscreenApi = chrome.offscreen,
        private readonly sendMessage: (message: OffscreenBlobMessage) => Promise<OffscreenBlobResponse> = (message) => chrome.runtime.sendMessage(message),
        private readonly runtime: ExtensionRuntimeWithContexts = chrome.runtime as ExtensionRuntimeWithContexts,
        private readonly clientsApi: ClientsApi = (globalThis as GlobalWithClients).clients ?? {}
    ) {}

    async start(request: BlobJobRequest): Promise<BlobJobStatus> {
        return this.request<BlobJobStatus>({ target: OFFSCREEN_MESSAGE_TARGET, operation: 'start', request });
    }

    async getStatus(jobId: string): Promise<BlobJobStatus | null> {
        return this.request<BlobJobStatus | null>({ target: OFFSCREEN_MESSAGE_TARGET, operation: 'getStatus', jobId });
    }

    async result(jobId: string): Promise<BlobJobResult> {
        return this.request<BlobJobResult>({ target: OFFSCREEN_MESSAGE_TARGET, operation: 'result', jobId });
    }

    async cancel(jobId: string): Promise<boolean> {
        return this.request<boolean>({ target: OFFSCREEN_MESSAGE_TARGET, operation: 'cancel', jobId });
    }

    async release(jobId: string): Promise<boolean> {
        return this.request<boolean>({ target: OFFSCREEN_MESSAGE_TARGET, operation: 'release', jobId });
    }

    async listActiveJobs(): Promise<string[]> {
        return this.request<string[]>({ target: OFFSCREEN_MESSAGE_TARGET, operation: 'listActiveJobs' });
    }

    private async request<T>(message: OffscreenBlobMessage): Promise<T> {
        await this.ensureDocument();
        const response = await this.sendMessage(message);
        if (!response?.ok) throw new Error(response?.error || 'Offscreen Blob host did not respond.');
        return response.value as T;
    }

    private async ensureDocument(): Promise<void> {
        if (!this.documentPromise) {
            this.documentPromise = (async () => {
                if (await this.hasExistingDocument()) return;
                await this.offscreen.createDocument({
                    url: OFFSCREEN_DOCUMENT_PATH,
                    reasons: [chrome.offscreen.Reason.BLOBS],
                    justification: 'Fetch Pinterest images, create ZIP Blobs, and retain object URL leases until downloads settle.'
                });
            })().catch((error) => {
                this.documentPromise = null;
                throw error;
            });
        }
        await this.documentPromise;
    }

    private async hasExistingDocument(): Promise<boolean> {
        const offscreenUrl = this.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

        if (typeof this.runtime.getContexts === 'function') {
            const contexts = await this.runtime.getContexts({
                contextTypes: [OFFSCREEN_CONTEXT_TYPE],
                documentUrls: [offscreenUrl]
            });
            return contexts.some((context) => context.documentUrl === offscreenUrl);
        }

        if (typeof this.offscreen.hasDocument === 'function') {
            return this.offscreen.hasDocument();
        }

        if (typeof this.clientsApi.matchAll === 'function') {
            const matchedClients = await this.clientsApi.matchAll();
            return matchedClients.some((client) => client.url === offscreenUrl);
        }

        return false;
    }
}
