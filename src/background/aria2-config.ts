import { ARIA2_ENDPOINT_KEY, ARIA2_SECRET_KEY, DEFAULT_ARIA2_ENDPOINT, aria2PermissionOrigin, normalizeAria2Endpoint } from '../shared/aria2-settings';
import { Aria2Client, Aria2RpcError } from './aria2-client';

export async function createConfiguredAria2Client(): Promise<Aria2Client> {
    const stored = await chrome.storage.local.get(ARIA2_ENDPOINT_KEY);
    const endpoint = normalizeAria2Endpoint(stored[ARIA2_ENDPOINT_KEY] ?? DEFAULT_ARIA2_ENDPOINT);
    if (!await chrome.permissions.contains({ origins: [aria2PermissionOrigin(endpoint)] })) {
        throw new Aria2RpcError('configuration', 'Open aria2 settings and click Save & test to grant local access.');
    }
    const session = await chrome.storage.session.get(ARIA2_SECRET_KEY);
    const secret = typeof session[ARIA2_SECRET_KEY] === 'string' ? session[ARIA2_SECRET_KEY] : '';
    return new Aria2Client({ endpoint, secret });
}

export function isAria2SettingsAction(action: unknown): boolean {
    return action === 'getAria2Config' || action === 'saveAndTestAria2';
}

export async function handleAria2SettingsMessage(request: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
    const senderUrl = sender.url?.split(/[?#]/)[0];
    if (sender.id !== chrome.runtime.id || !['popup.html', 'sidebar.html'].some((page) => senderUrl === chrome.runtime.getURL(page))) {
        return { success: false, error: 'aria2 configuration is available only in extension settings.' };
    }
    try {
        if (request.action === 'getAria2Config') {
            const stored = await chrome.storage.local.get(ARIA2_ENDPOINT_KEY);
            const session = await chrome.storage.session.get(ARIA2_SECRET_KEY);
            return { success: true, endpoint: stored[ARIA2_ENDPOINT_KEY] ?? DEFAULT_ARIA2_ENDPOINT, hasSecret: Boolean(session[ARIA2_SECRET_KEY]) };
        }
        const endpoint = normalizeAria2Endpoint(request.endpoint);
        if (!await chrome.permissions.contains({ origins: [aria2PermissionOrigin(endpoint)] })) {
            throw new Aria2RpcError('configuration', 'Local host permission has not been granted.');
        }
        if (request.secret !== undefined && (typeof request.secret !== 'string' || request.secret.length > 4096)) {
            throw new Aria2RpcError('configuration', 'Invalid RPC secret.');
        }
        await chrome.storage.local.set({ [ARIA2_ENDPOINT_KEY]: endpoint });
        if (request.clearSecret === true) await chrome.storage.session.remove(ARIA2_SECRET_KEY);
        else if (request.secret) await chrome.storage.session.set({ [ARIA2_SECRET_KEY]: request.secret });
        const client = await createConfiguredAria2Client();
        const version = await client.getVersion();
        return { success: true, version };
    } catch (error) {
        return { success: false, error: error instanceof Aria2RpcError ? error.message : 'Check the local RPC URL and secret, and make sure the downloader is running.' };
    }
}
