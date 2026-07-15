import type { BlobJobHost, BlobJobRequest, BlobJobResult, BlobJobStatus } from './blob-runner';
import {
    OFFSCREEN_DOCUMENT_PATH,
    OFFSCREEN_MESSAGE_TARGET,
    type OffscreenBlobMessage,
    type OffscreenBlobResponse
} from './offscreen-protocol';

type OffscreenApi = typeof chrome.offscreen;

export class OffscreenBlobJobHost implements BlobJobHost {
    private documentPromise: Promise<void> | null = null;

    constructor(
        private readonly offscreen: OffscreenApi = chrome.offscreen,
        private readonly sendMessage: (message: OffscreenBlobMessage) => Promise<OffscreenBlobResponse> = (message) => chrome.runtime.sendMessage(message)
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
                if (await this.offscreen.hasDocument()) return;
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
}
