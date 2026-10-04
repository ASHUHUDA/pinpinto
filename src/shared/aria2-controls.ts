import { aria2PermissionOrigin, DEFAULT_ARIA2_ENDPOINT, MOTRIX_ARIA2_ENDPOINT, normalizeAria2Endpoint } from './aria2-settings';
import { normalizeBatchDownloadMethod } from './download-settings';
import type { SupportedLanguage } from './ui-translations';

export function updateAria2ModeLabels(language: SupportedLanguage): void {
    const method = document.getElementById('batchDownloadMethod') as HTMLSelectElement | null;
    const label = document.getElementById('autoBatchLabel');
    if (label) label.textContent = method?.value === 'aria2'
        ? language === 'zh' ? '自动提交至 aria2' : 'Auto-submit to aria2'
        : language === 'zh' ? '自动下载' : 'Auto download';
}

export async function bindAria2Controls(getLanguage: () => SupportedLanguage): Promise<void> {
    const method = document.getElementById('batchDownloadMethod') as HTMLSelectElement | null;
    const endpoint = document.getElementById('aria2Endpoint') as HTMLInputElement | null;
    const secret = document.getElementById('aria2Secret') as HTMLInputElement | null;
    const clearSecret = document.getElementById('aria2ClearSecret') as HTMLInputElement | null;
    const button = document.getElementById('aria2TestBtn') as HTMLButtonElement | null;
    const status = document.getElementById('aria2Status');
    if (!method || !endpoint || !secret || !clearSecret || !button || !status) return;
    const report = (en: string, zh: string) => { status.textContent = getLanguage() === 'zh' ? zh : en; };
    const updateZip = () => {
        const zip = document.getElementById('downloadAsZip') as HTMLInputElement | null;
        if (zip) zip.disabled = method.value === 'aria2';
        updateAria2ModeLabels(getLanguage());
    };
    const settings = await chrome.storage.sync.get({ batchDownloadMethod: 'browser' });
    method.value = normalizeBatchDownloadMethod(settings.batchDownloadMethod);
    updateZip();
    method.addEventListener('change', () => {
        updateZip();
        void chrome.storage.sync.set({ batchDownloadMethod: normalizeBatchDownloadMethod(method.value) });
    });
    const config = await chrome.runtime.sendMessage({ action: 'getAria2Config' });
    endpoint.value = config?.endpoint ?? DEFAULT_ARIA2_ENDPOINT;
    if (!config?.success) report('Could not load RPC settings. Try again.', '读取 RPC 设置失败，请重试。');
    else if (config.hasSecret) report('Secret saved on this device. Blank keeps it.', '密钥已保存在本机；留空不改。');
    document.getElementById('aria2MotrixBtn')?.addEventListener('click', () => { endpoint.value = MOTRIX_ARIA2_ENDPOINT; });
    button.addEventListener('click', async () => {
        button.disabled = true;
        try {
            const url = normalizeAria2Endpoint(endpoint.value);
            // Request directly in the click handler, before any await loses user activation.
            const allowed = await chrome.permissions.request({ origins: [aria2PermissionOrigin(url)] });
            if (!allowed) {
                report('Local access was not granted.', '未授予本机访问权限。');
                return;
            }
            report('Testing connection…', '正在测试连接…');
            const result = await chrome.runtime.sendMessage({
                action: 'saveAndTestAria2', endpoint: url, secret: secret.value, clearSecret: clearSecret.checked
            });
            if (result?.success || result?.configSaved) {
                secret.value = '';
                clearSecret.checked = false;
            }
            if (result?.success) report(`Connected to aria2 ${result.version}. Settings saved.`, `已连接 aria2 ${result.version}，配置已保存。`);
            else if (result?.configSaved) report(`Settings saved. Connection failed: ${result.error}`, `配置已保存，连接失败：${result.error}`);
            else report(`Save not confirmed: ${result?.error ?? 'Check RPC settings.'}`, `未确认保存：${result?.error ?? '请检查 RPC 设置。'}`);
        } catch {
            report('Use an HTTP(S) localhost/127.0.0.1 RPC URL. Check the downloader and permission.', '请使用 HTTP(S) localhost/127.0.0.1 RPC 地址，并检查下载器与访问权限。');
        } finally {
            button.disabled = false;
        }
    });
}
