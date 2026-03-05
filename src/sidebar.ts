import { isPinterestUrl as isPinterestPageUrl } from './shared/pinterest';

const SIDEBAR_TARGET_TAB_KEY = 'pinVaultSidebarTargetTabId';

class PinVaultProSidebar {
    statsUpdateTimer: number | null = null;
    autoScrollStatsTimer: number | null = null;
    batchCount: number = 0;
    isBatchingNow: boolean = false;
    language: 'en' | 'zh' = 'en';
    translations: Record<'en' | 'zh', Record<string, string>> = {
        en: {
            'status.connected': 'Connected to Pinterest',
            'status.notConnected': 'Not a Pinterest page',
            'status.error': 'Connection check failed',
            'alert.openPinterestFirst': 'Please open Pinterest first.',
            'alert.noImages': 'No downloadable images were detected.',
            'alert.selectFirst': 'Please select images first.',
            'alert.downloadStartFailed': 'Failed to start download:',
            'alert.downloadFailed': 'Download failed:',
            'progress.preparing': 'Preparing download...',
            'menu.language': 'Language',
            'menu.github': 'GitHub',
            'menu.currentLanguage': 'English',
            'state.batchComplete': 'Batch download complete (3 rounds).'
        },
        zh: {
            'status.connected': '已连接 Pinterest',
            'status.notConnected': '非 Pinterest 页面',
            'status.error': '连接检查失败，请重试',
            'alert.openPinterestFirst': '请先打开 Pinterest。',
            'alert.noImages': '未检测到可下载图片。',
            'alert.selectFirst': '请先选图。',
            'alert.downloadStartFailed': '启动下载失败：',
            'alert.downloadFailed': '下载失败：',
            'progress.preparing': '准备下载...',
            'menu.language': '语言',
            'menu.github': 'GitHub',
            'menu.currentLanguage': '中文',
            'state.batchComplete': '分批下载完成（3轮）。'
        }
    };
    staticTranslations: Record<'en' | 'zh', Record<string, string>> = {
        en: {
            'stats.total': 'Images',
            'stats.selected': 'Selected',
            'panel.actions': 'Actions',
            'action.selectAll': 'Select all',
            'action.clear': 'Clear',
            'action.downloadSelected': 'Download selected',
            'panel.preferences': 'Preferences',
            'setting.highQuality': 'Prefer high quality',
            'setting.privacyMode': 'Privacy mode',
            'setting.autoScroll': 'Auto scroll',
            'setting.autoBatch': 'Auto batch (200, max 3 rounds)',
            'action.cancelDownload': 'Cancel download',
            'state.notPinterestTitle': 'Open Pinterest first',
            'state.notPinterestDesc': 'Switch to a Pinterest page and try again.',
            'action.openPinterest': 'Open Pinterest'
        },
        zh: {
            'stats.total': '页面图片',
            'stats.selected': '已选择',
            'panel.actions': '快捷操作',
            'action.selectAll': '全选',
            'action.clear': '清空',
            'action.downloadSelected': '下载已选',
            'panel.preferences': '偏好设置',
            'setting.highQuality': '优先高清图',
            'setting.privacyMode': '隐私模式',
            'setting.autoScroll': '自动滚动',
            'setting.autoBatch': '200图自动下(最多3次)',
            'action.cancelDownload': '取消下载',
            'state.notPinterestTitle': '请先打开 Pinterest',
            'state.notPinterestDesc': '切换到 Pinterest 页面后再试。',
            'action.openPinterest': '打开 Pinterest'
        }
    };

    constructor() {
        this.init().catch((error) => console.error(error));
    }

    async init() {
        await this.loadSettings();
        this.setupEventListeners();
        this.bindButtonPressFeedback();
        this.applyLanguage();
        this.checkPinterestStatus();

        this.statsUpdateTimer = window.setInterval(() => {
            this.updateStats();
        }, 2000);

        setTimeout(() => {
            this.updateStats();
        }, 1000);
    }

    setupEventListeners() {
        document.getElementById('selectAllBtn')?.addEventListener('click', () => this.selectAll());
        document.getElementById('deselectAllBtn')?.addEventListener('click', () => this.deselectAll());
        document.getElementById('downloadBtn')?.addEventListener('click', () => this.startDownload());
        document.getElementById('settingsBtn')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleSettingsMenu();
        });

        document.getElementById('languageToggleBtn')?.addEventListener('click', async () => {
            this.language = this.language === 'en' ? 'zh' : 'en';
            await this.saveSetting('language', this.language);
            this.applyLanguage();
            this.checkPinterestStatus();
            this.closeSettingsMenu();
        });

        document.getElementById('githubMenuBtn')?.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://github.com/ASHUHUDA/pinpinto' });
            this.closeSettingsMenu();
        });

        document.addEventListener('click', (event) => {
            const target = event.target as Node;
            const menu = document.getElementById('settingsMenu');
            const trigger = document.getElementById('settingsBtn');
            if (!menu || !trigger) return;

            if (!menu.contains(target) && !trigger.contains(target)) {
                this.closeSettingsMenu();
            }
        });

        document.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                this.closeSettingsMenu();
            }
        });

        document.getElementById('highQuality')?.addEventListener('change', (e) => {
            this.saveSetting('highQuality', (e.target as HTMLInputElement).checked);
        });

        document.getElementById('privacyMode')?.addEventListener('change', (e) => {
            this.saveSetting('privacyMode', (e.target as HTMLInputElement).checked);
        });

        document.getElementById('autoScrollToggle')?.addEventListener('change', (e) => {
            this.toggleAutoScroll((e.target as HTMLInputElement).checked);
        });

        document.getElementById('autoBatchToggle')?.addEventListener('change', (e) => {
            this.saveSetting('autoBatchDownload', (e.target as HTMLInputElement).checked);
        });

        document.getElementById('cancelDownloadBtn')?.addEventListener('click', () => {
            this.cancelDownload();
        });

        document.getElementById('openPinterestBtn')?.addEventListener('click', () => {
            chrome.tabs.create({ url: 'https://www.pinterest.com' });
        });
    }

    applyLanguage() {
        document.documentElement.lang = this.language === 'zh' ? 'zh-CN' : 'en';
        document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
            const key = element.dataset.i18n;
            if (!key) return;
            element.textContent = this.staticTranslations[this.language][key] || key;
        });

        const languageLabel = document.getElementById('currentLanguageLabel');
        if (languageLabel) {
            languageLabel.textContent = this.language === 'en' ? 'English' : '中文';
        }
    }

    t(key: string) {
        return this.translations[this.language][key] || key;
    }

    toggleSettingsMenu() {
        const menu = document.getElementById('settingsMenu');
        const trigger = document.getElementById('settingsBtn');
        if (!menu || !trigger) return;

        const isHidden = menu.hasAttribute('hidden');
        if (isHidden) {
            menu.removeAttribute('hidden');
        } else {
            menu.setAttribute('hidden', '');
        }
        trigger.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    }

    closeSettingsMenu() {
        const menu = document.getElementById('settingsMenu');
        const trigger = document.getElementById('settingsBtn');
        if (!menu || !trigger) return;

        menu.setAttribute('hidden', '');
        trigger.setAttribute('aria-expanded', 'false');
    }

    bindButtonPressFeedback() {
        document.querySelectorAll<HTMLButtonElement>('button').forEach((button) => {
            button.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    button.classList.add('is-pressing');
                }
            });

            button.addEventListener('keyup', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    button.classList.remove('is-pressing');
                }
            });

            button.addEventListener('blur', () => {
                button.classList.remove('is-pressing');
            });
        });
    }

    async setTargetTabId(tabId: number | null) {
        if (typeof tabId === 'number') {
            await chrome.storage.local.set({ [SIDEBAR_TARGET_TAB_KEY]: tabId });
        }
    }

    async getStoredTargetTabId() {
        const data = await chrome.storage.local.get(SIDEBAR_TARGET_TAB_KEY);
        const value = data[SIDEBAR_TARGET_TAB_KEY];
        return typeof value === 'number' ? value : null;
    }

    async resolveTargetTab() {
        const storedId = await this.getStoredTargetTabId();
        if (storedId !== null) {
            try {
                const storedTab = await chrome.tabs.get(storedId);
                if (storedTab?.id && storedTab.url && this.isPinterestUrl(storedTab.url)) {
                    return storedTab;
                }
            } catch {
                // ignore stale tab id
            }
        }

        const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (activeTab?.id && activeTab.url && this.isPinterestUrl(activeTab.url)) {
            await this.setTargetTabId(activeTab.id);
            return activeTab;
        }

        const tabs = await chrome.tabs.query({ currentWindow: true });
        const pinterestTab = tabs.find((tab) => tab.id && tab.url && this.isPinterestUrl(tab.url)) || null;

        if (pinterestTab?.id) {
            await this.setTargetTabId(pinterestTab.id);
        }

        return pinterestTab;
    }

    async checkPinterestStatus() {
        try {
            const tab = await this.resolveTargetTab();
            const isPinterest = Boolean(tab?.url && this.isPinterestUrl(tab.url));

            const statusIndicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            const notPinterest = document.getElementById('notPinterest');

            if (isPinterest) {
                if (statusIndicator) (statusIndicator as HTMLElement).style.background = '#10b981';
                if (statusText) statusText.textContent = this.t('status.connected');
                if (notPinterest) notPinterest.style.display = 'none';
                this.updateStats();
            } else {
                if (statusIndicator) (statusIndicator as HTMLElement).style.background = '#f59e0b';
                if (statusText) statusText.textContent = this.t('status.notConnected');
                if (notPinterest) notPinterest.style.display = 'block';
                this.resetStats();
            }
        } catch (error) {
            console.error('Error checking Pinterest status:', error);
            const statusIndicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            if (statusIndicator) (statusIndicator as HTMLElement).style.background = '#ef4444';
            if (statusText) statusText.textContent = this.t('status.error');
        }
    }

    isPinterestUrl(url: string) {
        return isPinterestPageUrl(url);
    }

    async updateStats() {
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) return;

            await this.ensureContentScriptInjected(tab.id);
            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getImageCounts' });

            if (response && response.total !== undefined) {
                this.updateStatsDisplay(response.total, response.selected?.length || 0);
            } else {
                await this.fallbackUpdateStats(tab.id);
            }
        } catch (error) {
            console.error('Error updating stats:', error);
            try {
                const tab = await this.resolveTargetTab();
                if (tab?.id && tab?.url && this.isPinterestUrl(tab.url)) {
                    await this.fallbackUpdateStats(tab.id);
                }
            } catch (fallbackError) {
                console.error('Fallback stats update failed:', fallbackError);
            }
        }
    }

    async fallbackUpdateStats(tabId: number) {
        const results = await chrome.scripting.executeScript({
            target: { tabId },
            func: () => {
                if (window.pinVaultContent) {
                    window.pinVaultContent.scanForImages();
                    return {
                        total: window.pinVaultContent.imageElements.size,
                        selected: window.pinVaultContent.selectedImages.size
                    };
                }

                const images = document.querySelectorAll('img[src*="pinimg.com"], img[data-src*="pinimg.com"]');
                const selected = document.querySelectorAll('img[data-pinvault-selected="true"]');

                return {
                    total: images.length,
                    selected: selected.length
                };
            }
        });

        if (results?.[0]) {
            this.updateStatsDisplay(results[0].result.total, results[0].result.selected);
        }
    }

    async ensureContentScriptInjected(tabId: number) {
        try {
            const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            if (response?.status === 'ready') {
                return true;
            }
        } catch {
            // ignore and continue
        }

        try {
            const contentScriptFile = this.getPrimaryContentScriptFile();
            if (!contentScriptFile) {
                console.error('Content script path not found in manifest.');
                return false;
            }

            await chrome.scripting.executeScript({
                target: { tabId },
                files: [contentScriptFile]
            });
            await new Promise((resolve) => setTimeout(resolve, 500));
            return true;
        } catch (error) {
            console.error('Failed to inject content script:', error);
            return false;
        }
    }

    getPrimaryContentScriptFile() {
        const contentScripts = chrome.runtime.getManifest().content_scripts;
        const firstEntry = contentScripts && contentScripts[0];
        const firstScript = firstEntry?.js?.[0];
        return typeof firstScript === 'string' && firstScript.length > 0 ? firstScript : null;
    }

    updateStatsDisplay(total: number, selected: number) {
        const totalImagesEl = document.getElementById('totalImages');
        const selectedCountEl = document.getElementById('selectedCount');
        const downloadCountEl = document.getElementById('downloadCount');
        const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement | null;

        if (totalImagesEl) totalImagesEl.textContent = String(total);
        if (selectedCountEl) selectedCountEl.textContent = String(selected);
        if (downloadCountEl) downloadCountEl.textContent = `(${selected})`;

        if (downloadBtn) {
            downloadBtn.disabled = selected === 0;
        }
    }

    resetStats() {
        this.updateStatsDisplay(0, 0);
    }

    async selectAll() {
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) return;

            await this.ensureContentScriptInjected(tab.id);
            await chrome.tabs.sendMessage(tab.id, { action: 'selectAllImages' });
            this.updateStats();
        } catch (error) {
            console.error('Error selecting all:', error);
        }
    }

    async deselectAll() {
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) return;

            await this.ensureContentScriptInjected(tab.id);
            await chrome.tabs.sendMessage(tab.id, { action: 'deselectAllImages' });
            this.updateStats();
        } catch (error) {
            console.error('Error deselecting all:', error);
        }
    }

    async toggleAutoScroll(enabled: boolean) {
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) return;

            await this.ensureContentScriptInjected(tab.id);

            if (enabled) {
                await chrome.tabs.sendMessage(tab.id, { action: 'startAutoScroll' });

                if (this.autoScrollStatsTimer) {
                    clearInterval(this.autoScrollStatsTimer);
                }

                this.batchCount = 0;
                this.isBatchingNow = false;

                this.autoScrollStatsTimer = window.setInterval(async () => {
                    if (this.isBatchingNow) return;

                    const targetTab = await this.resolveTargetTab();
                    if (!targetTab?.id) return;

                    await this.updateStats();

                    const settings = await this.getSettings();
                    if (settings.autoBatchDownload) {
                        const total = parseInt(document.getElementById('totalImages')?.textContent || '0', 10);
                        const targetThreshold = (this.batchCount + 1) * 200;

                        if (total >= targetThreshold && this.batchCount < 3) {
                            this.isBatchingNow = true;

                            try {
                                await chrome.tabs.sendMessage(targetTab.id, { action: 'stopAutoScroll' });
                                await chrome.tabs.sendMessage(targetTab.id, { action: 'selectAllImages' });
                                setTimeout(() => {
                                    this.startDownload();
                                }, 500);
                            } catch (error) {
                                console.error('Error during auto-batch:', error);
                                this.isBatchingNow = false;
                            }
                        }
                    }
                }, 1000);
            } else {
                await chrome.tabs.sendMessage(tab.id, { action: 'stopAutoScroll' });

                if (this.autoScrollStatsTimer) {
                    clearInterval(this.autoScrollStatsTimer);
                    this.autoScrollStatsTimer = null;
                }

                setTimeout(() => this.updateStats(), 500);
            }

            await this.saveSetting('autoScroll', enabled);
        } catch (error) {
            console.error('Error toggling auto-scroll:', error);
        }
    }

    async startDownload() {
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) {
                alert(this.t('alert.openPinterestFirst'));
                return;
            }

            await this.updateStats();

            let selectedImages: any[] = [];
            try {
                await this.ensureContentScriptInjected(tab.id);
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: 'getSelectedImages',
                    settings: await this.getSettings()
                });

                if (response?.images?.length) {
                    selectedImages = response.images;
                }
            } catch {
                // ignore and use fallback
            }

            if (selectedImages.length === 0) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const selected = document.querySelectorAll('img[data-pinvault-selected="true"]');
                        const imageData: Array<{ id: string; url: string; title: string; board: string; domain: string; originalFilename: string | undefined }> = [];

                        selected.forEach((img, index) => {
                            const image = img as HTMLImageElement;
                            if (image.src && image.src.includes('pinimg.com')) {
                                imageData.push({
                                    id: `img_${Date.now()}_${index}`,
                                    url: image.src,
                                    title: image.alt || image.title || `Pinterest 图片 ${index + 1}`,
                                    board: document.title || 'Pinterest',
                                    domain: window.location.hostname,
                                    originalFilename: image.src.split('/').pop()
                                });
                            }
                        });

                        return imageData;
                    }
                });

                if (results?.[0]?.result?.length) {
                    selectedImages = results[0].result;
                } else {
                    alert(this.t('alert.noImages'));
                    return;
                }
            }

            if (selectedImages.length === 0) {
                alert(this.t('alert.selectFirst'));
                return;
            }

            this.showProgress();

            chrome.runtime.sendMessage(
                {
                    action: 'downloadImages',
                    images: selectedImages,
                    settings: await this.getSettings()
                },
                (response) => {
                    if (chrome.runtime.lastError) {
                        alert(`${this.t('alert.downloadStartFailed')} ${chrome.runtime.lastError.message}`);
                        this.hideProgress();
                        return;
                    }

                    if (!response?.success) {
                        alert(`${this.t('alert.downloadFailed')} ${response?.error || 'Unknown error'}`);
                        this.hideProgress();
                    }
                }
            );
        } catch (error) {
            console.error('Error starting download:', error);
            alert(`${this.t('alert.downloadFailed')} ${error instanceof Error ? error.message : String(error)}`);
            this.hideProgress();
        }
    }

    showProgress() {
        const progressSection = document.getElementById('progressSection');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const progressDetails = document.getElementById('progressDetails');

        if (progressSection) progressSection.style.display = 'block';
        if (progressFill) (progressFill as HTMLElement).style.width = '0%';
        if (progressText) progressText.textContent = '0%';
        if (progressDetails) progressDetails.textContent = this.t('progress.preparing');
    }

    hideProgress() {
        const progressSection = document.getElementById('progressSection');
        if (progressSection) progressSection.style.display = 'none';
    }

    updateProgress(progress: number, details: string) {
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const progressDetails = document.getElementById('progressDetails');

        if (progressFill) (progressFill as HTMLElement).style.width = `${progress}%`;
        if (progressText) progressText.textContent = `${Math.round(progress)}%`;
        if (progressDetails) progressDetails.textContent = details;
    }

    cancelDownload() {
        chrome.runtime.sendMessage({ action: 'cancelDownload' });
        this.hideProgress();
    }

    async loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                language: 'en',
                highQuality: true,
                privacyMode: false,
                autoScroll: false,
                autoBatchDownload: false
            });

            this.language = settings.language === 'zh' ? 'zh' : 'en';

            (document.getElementById('highQuality') as HTMLInputElement).checked = settings.highQuality !== false;
            (document.getElementById('privacyMode') as HTMLInputElement).checked = settings.privacyMode === true;
            (document.getElementById('autoScrollToggle') as HTMLInputElement).checked = settings.autoScroll === true;

            const autoBatchToggle = document.getElementById('autoBatchToggle') as HTMLInputElement | null;
            if (autoBatchToggle) autoBatchToggle.checked = settings.autoBatchDownload === true;
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    async saveSetting(key: string, value: unknown) {
        try {
            await chrome.storage.sync.set({ [key]: value });
        } catch (error) {
            console.error('Error saving setting:', error);
        }
    }

    async getSettings() {
        try {
            return await chrome.storage.sync.get({
                highQuality: true,
                privacyMode: false,
                autoScroll: false,
                autoBatchDownload: false,
                filenameFormat: 'title_date',
                folderOrganization: 'date',
                customFolder: ''
            });
        } catch (error) {
            console.error('Error getting settings:', error);
            return {
                highQuality: true,
                privacyMode: false,
                autoScroll: false,
                autoBatchDownload: false,
                filenameFormat: 'title_date',
                folderOrganization: 'date',
                customFolder: ''
            };
        }
    }
}

let sidebar: PinVaultProSidebar;

chrome.runtime.onMessage.addListener((message) => {
    if (!sidebar) return;

    if (message.action === 'downloadProgress') {
        sidebar.updateProgress(message.progress, message.details);
    } else if (message.action === 'downloadComplete') {
        sidebar.hideProgress();
        sidebar.updateStats();

        if (sidebar.isBatchingNow) {
            sidebar.batchCount++;

            (async () => {
                const tab = await sidebar.resolveTargetTab();
                if (!tab?.id) return;

                chrome.tabs.sendMessage(tab.id, { action: 'deselectAllImages' }).catch(() => {
                    // ignore
                });

                if (sidebar.batchCount < 3) {
                    sidebar.isBatchingNow = false;
                    setTimeout(() => {
                        sidebar.toggleAutoScroll(true);
                    }, 1000);
                } else {
                    sidebar.isBatchingNow = false;
                    sidebar.toggleAutoScroll(false);

                    const toggle = document.getElementById('autoScrollToggle') as HTMLInputElement | null;
                    if (toggle) {
                        toggle.checked = false;
                    }

                    setTimeout(() => {
                        alert(sidebar.t('state.batchComplete'));
                    }, 500);
                }
            })().catch((error) => console.error(error));
        }
    } else if (message.action === 'downloadError') {
        sidebar.hideProgress();
        sidebar.isBatchingNow = false;
        alert(`${sidebar.t('alert.downloadFailed')} ${message.error}`);
    }
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        sidebar = new PinVaultProSidebar();
    });
} else {
    sidebar = new PinVaultProSidebar();
}


