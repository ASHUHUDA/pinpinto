export const ARIA2_ENDPOINT_KEY = 'pinpintoAria2Endpoint';
export const ARIA2_SECRET_KEY = 'pinpintoAria2SessionSecret';
export const DEFAULT_ARIA2_ENDPOINT = 'http://127.0.0.1:6800/jsonrpc';
export const MOTRIX_ARIA2_ENDPOINT = 'http://127.0.0.1:16800/jsonrpc';
export const ARIA2_HOST_PERMISSIONS = [
    'http://127.0.0.1/*', 'http://localhost/*',
    'https://127.0.0.1/*', 'https://localhost/*'
];

export function normalizeAria2Endpoint(value: unknown): string {
    if (typeof value !== 'string') throw new Error('Enter a local aria2 RPC URL.');
    let url: URL;
    try { url = new URL(value.trim()); }
    catch { throw new Error('Enter a valid aria2 RPC URL.'); }
    if (!['http:', 'https:'].includes(url.protocol)
        || !['127.0.0.1', 'localhost'].includes(url.hostname)
        || url.username || url.password || url.search || url.hash) {
        throw new Error('Only HTTP(S) localhost/127.0.0.1 URLs without embedded credentials, query or fragment are allowed.');
    }
    if (url.pathname === '/') url.pathname = '/jsonrpc';
    return url.href;
}

export function aria2PermissionOrigin(endpoint: unknown): string {
    const url = new URL(normalizeAria2Endpoint(endpoint));
    // Extension host permissions do not constrain ports.
    return `${url.protocol}//${url.hostname}/*`;
}

export function isAria2ImageUrl(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol)
            && (url.hostname === 'pinimg.com' || url.hostname.endsWith('.pinimg.com'))
            && !url.username && !url.password;
    } catch { return false; }
}
