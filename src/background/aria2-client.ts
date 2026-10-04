import { isAria2ImageUrl, normalizeAria2Endpoint } from '../shared/aria2-settings';

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type Aria2ErrorKind = 'configuration' | 'rejected' | 'uncertain';
export class Aria2RpcError extends Error {
    constructor(public readonly kind: Aria2ErrorKind, message: string) {
        super(message);
        this.name = 'Aria2RpcError';
    }
}
export type Aria2SubmitClient = {
    addUri: (url: string, filename: string, signal?: AbortSignal) => Promise<string>;
};

export class Aria2Client implements Aria2SubmitClient {
    private readonly endpoint: string;
    constructor(private readonly options: {
        endpoint: string;
        secret?: string;
        fetch?: typeof fetch;
        timeoutMs?: number;
    }) {
        this.endpoint = normalizeAria2Endpoint(options.endpoint);
    }

    async getVersion(): Promise<string> {
        const result = await this.call('aria2.getVersion', []);
        if (!isRecord(result) || typeof result.version !== 'string') {
            throw new Aria2RpcError('uncertain', 'The endpoint did not return a valid aria2 version.');
        }
        return result.version;
    }

    async addUri(url: string, filename: string, signal?: AbortSignal): Promise<string> {
        if (!isAria2ImageUrl(url)) throw new Aria2RpcError('rejected', 'Only Pinterest image URLs can be submitted.');
        const out = filename.replace(/[\\/\x00-\x1f<>:"|?*]/g, '_').slice(0, 220);
        if (!out || out === '.' || out === '..') throw new Aria2RpcError('rejected', 'Invalid output filename.');
        // Chromium may transparently replay a POST on a broken reused connection.
        // Replaying this exact request must not create another aria2 task.
        const gid = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
        let result: unknown;
        try {
            result = await this.call('aria2.addUri', [[url], {
                gid, out,
                'auto-file-renaming': 'true',
                'allow-overwrite': 'false'
            }], signal);
        } catch (error) {
            if (!(error instanceof Aria2RpcError) || error.kind !== 'rejected') throw error;
            return this.confirmRejectedSubmission(gid, url, error, signal);
        }
        if (result !== gid) {
            throw new Aria2RpcError('uncertain', 'The expected task ID was not returned. Check the downloader queue before retrying.');
        }
        return gid;
    }

    private async confirmRejectedSubmission(gid: string, url: string, rejection: Aria2RpcError, signal?: AbortSignal): Promise<string> {
        let status: unknown;
        try {
            // Read-only reconciliation, never resend addUri. A prior transport replay may have been accepted.
            status = await this.call('aria2.tellStatus', [gid, ['gid', 'files']], signal);
        } catch (error) {
            if (error instanceof Aria2RpcError && error.kind === 'rejected') throw rejection;
            throw new Aria2RpcError('uncertain', 'Could not reconcile the rejected submission. Check the downloader queue before retrying.');
        }
        if (isRecord(status) && status.gid === gid && Array.isArray(status.files)
            && status.files.some((file: unknown) => isRecord(file) && Array.isArray(file.uris)
                && file.uris.some((uri: unknown) => isRecord(uri) && uri.uri === url))) return gid;
        throw new Aria2RpcError('uncertain', 'The downloader returned conflicting task information. Check its queue before retrying.');
    }

    private async call(method: string, params: unknown[], signal?: AbortSignal): Promise<unknown> {
        if (signal?.aborted) throw new Aria2RpcError('configuration', 'Submission stopped before sending.');
        const controller = new AbortController();
        const onAbort = () => controller.abort();
        signal?.addEventListener('abort', onAbort, { once: true });
        const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 8000);
        const id = crypto.randomUUID();
        try {
            const response = await (this.options.fetch ?? fetch)(this.endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0', id, method,
                    params: this.options.secret ? [`token:${this.options.secret}`, ...params] : params
                }),
                signal: controller.signal,
                redirect: 'error',
                credentials: 'omit',
                cache: 'no-store',
                referrerPolicy: 'no-referrer'
            });
            const body: unknown = await response.json();
            if (!isRecord(body) || body.jsonrpc !== '2.0' || body.id !== id) throw new Error('Untrusted RPC response');
            if (isRecord(body.error) && Number.isInteger(body.error.code) && !Object.hasOwn(body, 'result')) {
                // Never echo a server message: it can contain credentials or attacker-controlled text.
                throw new Aria2RpcError('rejected', `aria2 rejected the request (code ${body.error.code}).`);
            }
            if (!response.ok || !Object.hasOwn(body, 'result') || Object.hasOwn(body, 'error')) {
                throw new Error('Invalid RPC response');
            }
            return body.result;
        } catch (error) {
            if (error instanceof Aria2RpcError) throw error;
            throw new Aria2RpcError('uncertain', 'RPC connection or response failed. The request may have been accepted; check the downloader queue before retrying.');
        } finally {
            clearTimeout(timeout);
            signal?.removeEventListener('abort', onAbort);
        }
    }
}
