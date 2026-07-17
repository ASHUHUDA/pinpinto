import JSZip from 'jszip';

export const BLOB_FETCH_TIMEOUT_MS = 8000;

export type BlobJobEntry = {
    imageId: string;
    sequence: number;
    sourceUrl: string;
    candidateUrls: string[];
    filename: string;
};

export type BlobJobOutput = 'zip' | 'file';

export type BlobJobRequest = {
    jobId: string;
    entries: BlobJobEntry[];
    maxConcurrency: number;
    fetchTimeoutMs?: number;
    output?: BlobJobOutput;
};

export type BlobJobState = 'running' | 'completed' | 'failed' | 'cancelled';

export type BlobJobStatus = {
    jobId: string;
    state: BlobJobState;
    completedEntries: number;
    totalEntries: number;
    zipProgress: number;
    error?: string;
};

export type BlobJobSuccess = Pick<BlobJobEntry, 'imageId' | 'sequence' | 'sourceUrl' | 'filename'> & {
    resolvedUrl: string;
};

export type BlobJobFailure = Pick<BlobJobEntry, 'imageId' | 'sequence' | 'sourceUrl' | 'filename'> & {
    error: string;
};

export type BlobJobResult = {
    jobId: string;
    output: BlobJobOutput;
    objectUrl?: string;
    contentType?: string;
    zippedEntries: BlobJobSuccess[];
    failedEntries: BlobJobFailure[];
};

export interface BlobJobHost {
    start(request: BlobJobRequest): Promise<BlobJobStatus>;
    getStatus(jobId: string): Promise<BlobJobStatus | null>;
    result(jobId: string): Promise<BlobJobResult>;
    cancel(jobId: string): Promise<boolean>;
    release(jobId: string): Promise<boolean>;
    listActiveJobs(): Promise<string[]>;
}

type ZipLike = {
    file: (filename: string, data: ArrayBuffer | Uint8Array) => unknown;
    generateAsync: (
        options: { type: 'blob'; streamFiles: true; compression: 'STORE' },
        onUpdate?: (metadata: { percent: number }) => void
    ) => Promise<Blob>;
};

type BlobRunnerDependencies = {
    fetchImpl?: typeof fetch;
    createZip?: () => ZipLike;
    createObjectURL?: (blob: Blob) => string;
    revokeObjectURL?: (url: string) => void;
};

type JobRecord = {
    request: BlobJobRequest;
    status: BlobJobStatus;
    controllers: Set<AbortController>;
    objectUrl?: string;
    promise: Promise<BlobJobResult>;
};

export async function buildZipBlob(
    files: Array<{ filename: string; bytes: ArrayBuffer | Uint8Array }>,
    dependencies: Pick<BlobRunnerDependencies, 'createZip'> = {}
): Promise<Blob> {
    const zip = dependencies.createZip?.() ?? new JSZip();
    for (const file of files) zip.file(file.filename, file.bytes);
    return zip.generateAsync({ type: 'blob', streamFiles: true, compression: 'STORE' });
}

export class BlobJobRunner implements BlobJobHost {
    private readonly jobs = new Map<string, JobRecord>();
    private readonly fetchImpl: typeof fetch;
    private readonly createZip: () => ZipLike;
    private readonly createObjectURL: (blob: Blob) => string;
    private readonly revokeObjectURL: (url: string) => void;

    constructor(dependencies: BlobRunnerDependencies = {}) {
        this.fetchImpl = dependencies.fetchImpl ?? globalThis.fetch.bind(globalThis);
        this.createZip = dependencies.createZip ?? (() => new JSZip());
        this.createObjectURL = dependencies.createObjectURL ?? ((blob) => URL.createObjectURL(blob));
        this.revokeObjectURL = dependencies.revokeObjectURL ?? ((url) => URL.revokeObjectURL(url));
    }

    async start(request: BlobJobRequest): Promise<BlobJobStatus> {
        const existing = this.jobs.get(request.jobId);
        if (existing) return cloneStatus(existing.status);

        const status: BlobJobStatus = {
            jobId: request.jobId,
            state: 'running',
            completedEntries: 0,
            totalEntries: request.entries.length,
            zipProgress: 0
        };
        const record = {
            request,
            status,
            controllers: new Set<AbortController>(),
            promise: Promise.resolve(null as unknown as BlobJobResult)
        } satisfies JobRecord;
        record.promise = this.run(record);
        this.jobs.set(request.jobId, record);
        return cloneStatus(status);
    }

    async getStatus(jobId: string): Promise<BlobJobStatus | null> {
        const record = this.jobs.get(jobId);
        return record ? cloneStatus(record.status) : null;
    }

    async result(jobId: string): Promise<BlobJobResult> {
        const record = this.jobs.get(jobId);
        if (!record) throw new Error(`Unknown Blob job: ${jobId}`);
        return record.promise;
    }

    async cancel(jobId: string): Promise<boolean> {
        const record = this.jobs.get(jobId);
        if (!record) return false;
        if (record.status.state === 'cancelled') return true;
        record.status.state = 'cancelled';
        record.controllers.forEach((controller) => controller.abort());
        this.revoke(record);
        return true;
    }

    async release(jobId: string): Promise<boolean> {
        const record = this.jobs.get(jobId);
        if (!record) return false;
        record.controllers.forEach((controller) => controller.abort());
        this.revoke(record);
        this.jobs.delete(jobId);
        return true;
    }

    async listActiveJobs(): Promise<string[]> {
        return [...this.jobs.values()]
            .filter((record) => record.status.state === 'running' || Boolean(record.objectUrl))
            .map((record) => record.request.jobId);
    }

    private async run(record: JobRecord): Promise<BlobJobResult> {
        try {
            const output = normalizeBlobJobOutput(record.request.output);
            if (output === 'file' && record.request.entries.length !== 1) {
                throw new Error('File Blob jobs require exactly one entry.');
            }

            const zippedEntries: BlobJobSuccess[] = [];
            const failedEntries: BlobJobFailure[] = [];
            const files: Array<{ filename: string; bytes: ArrayBuffer; contentType: string }> = [];
            const concurrency = Math.max(1, Math.floor(record.request.maxConcurrency || 1));

            for (let index = 0; index < record.request.entries.length; index += concurrency) {
                this.throwIfCancelled(record);
                const chunk = record.request.entries.slice(index, index + concurrency);
                await Promise.all(chunk.map(async (entry) => {
                    try {
                        const fetched = await this.fetchEntry(record, entry);
                        files.push({
                            filename: entry.filename,
                            bytes: fetched.bytes,
                            contentType: fetched.contentType
                        });
                        zippedEntries.push({
                            imageId: entry.imageId,
                            sequence: entry.sequence,
                            sourceUrl: entry.sourceUrl,
                            filename: entry.filename,
                            resolvedUrl: fetched.resolvedUrl
                        });
                    } catch (error) {
                        this.throwIfCancelled(record);
                        failedEntries.push({
                            imageId: entry.imageId,
                            sequence: entry.sequence,
                            sourceUrl: entry.sourceUrl,
                            filename: entry.filename,
                            error: errorMessage(error)
                        });
                    } finally {
                        record.status.completedEntries++;
                    }
                }));
            }

            this.throwIfCancelled(record);
            let objectUrl: string | undefined;
            let contentType: string | undefined;
            if (files.length > 0) {
                const blob = output === 'file'
                    ? new Blob([files[0].bytes], { type: files[0].contentType })
                    : await this.buildJobZip(record, files);
                this.throwIfCancelled(record);
                objectUrl = this.createObjectURL(blob);
                record.objectUrl = objectUrl;
                contentType = blob.type || undefined;
            }

            record.status.state = 'completed';
            record.status.zipProgress = 100;
            return {
                jobId: record.request.jobId,
                output,
                objectUrl,
                contentType,
                zippedEntries,
                failedEntries
            };
        } catch (error) {
            if (record.status.state === 'cancelled') throw new Error(`Blob job cancelled: ${record.request.jobId}`);
            record.status.state = 'failed';
            record.status.error = errorMessage(error);
            this.revoke(record);
            throw error;
        } finally {
            record.controllers.clear();
        }
    }

    private async fetchEntry(
        record: JobRecord,
        entry: BlobJobEntry
    ): Promise<{ bytes: ArrayBuffer; resolvedUrl: string; contentType: string }> {
        if (entry.candidateUrls.length === 0) throw new Error('图片 URL 无效');
        let lastError: unknown = new Error('图片获取失败');

        for (const url of entry.candidateUrls) {
            const controller = new AbortController();
            record.controllers.add(controller);
            const timeoutMs = record.request.fetchTimeoutMs ?? BLOB_FETCH_TIMEOUT_MS;
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                this.throwIfCancelled(record);
                const response = await this.fetchImpl(url, { cache: 'no-store', signal: controller.signal });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const responseContentType = response.headers.get('content-type') || '';
                const contentType = normalizeContentType(responseContentType);
                if (
                    (contentType && !contentType.startsWith('image/'))
                    || (!contentType && normalizeBlobJobOutput(record.request.output) === 'file')
                ) {
                    throw new Error(`非图片响应: ${responseContentType || 'missing content-type'}`);
                }
                const bytes = await response.arrayBuffer();
                if (bytes.byteLength === 0) throw new Error('图片内容为空');
                this.throwIfCancelled(record);
                return { bytes, resolvedUrl: url, contentType };
            } catch (error) {
                this.throwIfCancelled(record);
                lastError = error instanceof Error && error.name === 'AbortError'
                    ? new Error(`请求超时（>${timeoutMs / 1000}秒）：${url}`)
                    : error;
            } finally {
                clearTimeout(timeoutId);
                record.controllers.delete(controller);
            }
        }

        throw new Error(`图片获取失败：${errorMessage(lastError)}`);
    }

    private async buildJobZip(
        record: JobRecord,
        files: Array<{ filename: string; bytes: ArrayBuffer }>
    ): Promise<Blob> {
        const zip = this.createZip();
        for (const file of files) zip.file(file.filename, file.bytes);
        return zip.generateAsync(
            { type: 'blob', streamFiles: true, compression: 'STORE' },
            ({ percent }) => {
                this.throwIfCancelled(record);
                record.status.zipProgress = percent;
            }
        );
    }

    private throwIfCancelled(record: JobRecord): void {
        if (record.status.state === 'cancelled') throw new Error(`Blob job cancelled: ${record.request.jobId}`);
    }

    private revoke(record: JobRecord): void {
        if (!record.objectUrl) return;
        this.revokeObjectURL(record.objectUrl);
        record.objectUrl = undefined;
    }
}

function cloneStatus(status: BlobJobStatus): BlobJobStatus {
    return { ...status };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function normalizeContentType(value: string): string {
    return value.split(';', 1)[0].trim().toLowerCase();
}

function normalizeBlobJobOutput(value: unknown): BlobJobOutput {
    return value === 'file' ? 'file' : 'zip';
}
