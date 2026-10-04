import { ARIA2_ENDPOINT_KEY, DEFAULT_ARIA2_ENDPOINT, aria2PermissionOrigin, normalizeAria2Endpoint } from '../shared/aria2-settings';
import { Aria2Client, Aria2RpcError } from './aria2-client';
import { readAria2Secret, saveAria2Secret } from './aria2-secret-store';

export async function createConfiguredAria2Client(): Promise<Aria2Client> {
    const stored = await chrome.storage.local.get(ARIA2_ENDPOINT_KEY);
    const endpoint = normalizeAria2Endpoint(stored[ARIA2_ENDPOINT_KEY] ?? DEFAULT_ARIA2_ENDPOINT);
    if (!await chrome.permissions.contains({ origins: [aria2PermissionOrigin(endpoint)] })) {
        throw new Aria2RpcError('configuration', 'Open aria2 settings and click Save & test to grant local access.');
    }
    const secret = await readAria2Secret();
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
    let configSaved = false;
    try {
        if (request.action === 'getAria2Config') {
            const stored = await chrome.storage.local.get(ARIA2_ENDPOINT_KEY);
            return { success: true, endpoint: stored[ARIA2_ENDPOINT_KEY] ?? DEFAULT_ARIA2_ENDPOINT, hasSecret: Boolean(await readAria2Secret()) };
        }
        const endpoint = normalizeAria2Endpoint(request.endpoint);
        if (!await chrome.permissions.contains({ origins: [aria2PermissionOrigin(endpoint)] })) {
            throw new Aria2RpcError('configuration', 'Local host permission has not been granted.');
        }
        if (request.secret !== undefined && (typeof request.secret !== 'string' || request.secret.length > 4096)) {
            throw new Aria2RpcError('configuration', 'Invalid RPC secret.');
        }
        await chrome.storage.local.set({ [ARIA2_ENDPOINT_KEY]: endpoint });
        if (request.clearSecret === true) await saveAria2Secret('');
        else if (request.secret) await saveAria2Secret(request.secret as string);
        else await readAria2Secret();
        configSaved = true;
        const client = await createConfiguredAria2Client();
        const version = await client.getVersion();
        return { success: true, version };
    } catch (error) {
        return { success: false, configSaved, error: error instanceof Aria2RpcError ? error.message : 'Could not read or save RPC settings. Check the local URL and try again.' };
    }
}
