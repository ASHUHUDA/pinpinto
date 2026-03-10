import { isPinterestUrl as isPinterestPageUrl, PINTEREST_MATCH_PATTERNS } from './shared/pinterest';
import { bindSettingsMenuDismiss, closeSettingsMenu as closeSharedSettingsMenu, toggleSettingsMenu as toggleSharedSettingsMenu } from './shared/settings-menu';
import { DEFAULT_LANGUAGE, SIDEBAR_STATIC_TRANSLATIONS, SIDEBAR_STATUS_TRANSLATIONS, SupportedLanguage, normalizeLanguage } from './shared/ui-translations';

const SIDEBAR_TARGET_TAB_KEY = 'pinVaultSidebarTargetTabId';
const AUTO_BATCH_DOWNLOAD_LIMIT = 100;

class PinVaultProSidebar {
    statsUpdateTimer: number | null = null;
    autoScrollStatsTimer: number | null = null;
    batchCount: number = 0;
    isBatchingNow: boolean = false;
    language: SupportedLanguage = DEFAULT_LANGUAGE;
    translations: typeof SIDEBAR_STATUS_TRANSLATIONS = SIDEBAR_STATUS_TRANSLATIONS;
    staticTranslations: typeof SIDEBAR_STATIC_TRANSLATIONS = SIDEBAR_STATIC_TRANSLATIONS;

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
        bindSettingsMenuDismiss(() => this.closeSettingsMenu());

        document.getElementById('highQuality')?.addEventListener('change', (e) => {
            this.saveSetting('highQuality', (e.target as HTMLInputElement).checked);
        });

        document.getElementById('autoScrollToggle')?.addEventListener('change', (e) => {
            this.toggleAutoScroll((e.target as HTMLInputElement).checked);
        });

        document.getElementById('autoBatchToggle')?.addEventListener('change', async (e) => {
            const checked = (e.target as HTMLInputElement).checked;
            await this.saveSetting('autoBatchDownload', checked);

            if (checked) {
                const autoScrollToggle = document.getElementById('autoScrollToggle') as HTMLInputElement | null;
                if (autoScrollToggle) {
                    autoScrollToggle.checked = true;
                }

                await this.saveSetting('autoScroll', true);
                await this.toggleAutoScroll(true);
            }
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
            languageLabel.textContent =
                this.staticTranslations[this.language]['menu.currentLanguage'] ||
                (this.language === 'en' ? 'English' : '中文');
        }
    }

    t(key: string) {
        return this.translations[this.language][key] || key;
    }

    toggleSettingsMenu() {
        toggleSharedSettingsMenu();
    }

    closeSettingsMenu() {
        closeSharedSettingsMenu();
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

        const tabs = await chrome.tabs.query({
            currentWindow: true,
            url: [...PINTEREST_MATCH_PATTERNS]
        });
        const pinterestTab = tabs.find((tab) => typeof tab.id === 'number') || null;

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

            const statusIndicator = document.getElementById('statusIndicator');
            const statusText = document.getElementById('statusText');
            const notPinterest = document.getElementById('notPinterest');
            if (statusIndicator) (statusIndicator as HTMLElement).style.background = '#10b981';
            if (statusText) statusText.textContent = this.t('status.connected');
            if (notPinterest) notPinterest.style.display = 'none';

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

    async toggleAutoScroll(enabled: boolean, options: { resetBatchState?: boolean } = {}) {
        const shouldResetBatchState = options.resetBatchState !== false;
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) return;

            await this.ensureContentScriptInjected(tab.id);

            if (enabled) {
                await chrome.tabs.sendMessage(tab.id, { action: 'startAutoScroll' });

                if (this.autoScrollStatsTimer) {
                    clearInterval(this.autoScrollStatsTimer);
                }

                if (shouldResetBatchState) {
                    this.batchCount = 0;
                }
                this.isBatchingNow = false;

                this.autoScrollStatsTimer = window.setInterval(async () => {
                    if (this.isBatchingNow) return;

                    const targetTab = await this.resolveTargetTab();
                    if (!targetTab?.id) return;

                    await this.updateStats();

                    const settings = await this.getSettings();
                    if (settings.autoBatchDownload) {
                        const total = parseInt(document.getElementById('totalImages')?.textContent || '0', 10);
                        const targetThreshold = (this.batchCount + 1) * AUTO_BATCH_DOWNLOAD_LIMIT;

                        if (total >= targetThreshold) {
                            this.isBatchingNow = true;

                            try {
                                await chrome.tabs.sendMessage(targetTab.id, { action: 'stopAutoScroll' });
                                await chrome.tabs.sendMessage(targetTab.id, { action: 'selectAllImages' });
                                setTimeout(async () => {
                                    const started = await this.startDownload({ autoBatchMode: true });
                                    if (!started) {
                                        this.isBatchingNow = false;
                                    }
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

    async startDownload(options: { autoBatchMode?: boolean } = {}): Promise<boolean> {
        const autoBatchMode = options.autoBatchMode === true;
        try {
            const tab = await this.resolveTargetTab();
            if (!tab?.id || !tab.url || !this.isPinterestUrl(tab.url)) {
                if (!autoBatchMode) {
                    alert(this.t('alert.openPinterestFirst'));
                }
                return false;
            }

            await this.updateStats();

            let selectedImages: any[] = [];
            const settings = await this.getSettings();
            try {
                await this.ensureContentScriptInjected(tab.id);
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: 'getSelectedImages',
                    settings
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
                    if (!autoBatchMode) {
                        alert(this.t('alert.noImages'));
                    }
                    return false;
                }
            }

            if (selectedImages.length === 0) {
                if (!autoBatchMode) {
                    alert(this.t('alert.selectFirst'));
                }
                return false;
            }

            if (autoBatchMode && settings.autoBatchDownload === true && selectedImages.length > AUTO_BATCH_DOWNLOAD_LIMIT) {
                // 自动批量按批次窗口取图，避免每轮都重复首批 100 张。
                const windowStart = this.batchCount * AUTO_BATCH_DOWNLOAD_LIMIT;
                if (windowStart < selectedImages.length) {
                    selectedImages = selectedImages.slice(windowStart, windowStart + AUTO_BATCH_DOWNLOAD_LIMIT);
                } else {
                    // 防御性兜底：窗口越界时取最新一批，避免空下载或重复首批。
                    selectedImages = selectedImages.slice(-AUTO_BATCH_DOWNLOAD_LIMIT);
                }
            }

            this.showProgress();

            chrome.runtime.sendMessage(
                {
                    action: 'downloadImages',
                    images: selectedImages,
                    settings
                },
                (response) => {
                    if (chrome.runtime.lastError) {
                        const errorText = `${this.t('alert.downloadStartFailed')} ${chrome.runtime.lastError.message}`;
                        this.updateProgress(100, errorText);
                        if (!autoBatchMode) {
                            alert(errorText);
                            this.hideProgress();
                        } else {
                            this.isBatchingNow = false;
                        }
                        return;
                    }

                    if (!response?.success) {
                        const errorText = `${this.t('alert.downloadFailed')} ${response?.error || 'Unknown error'}`;
                        this.updateProgress(100, errorText);
                        if (!autoBatchMode) {
                            alert(errorText);
                            this.hideProgress();
                        } else {
                            this.isBatchingNow = false;
                        }
                    }
                }
            );
            return true;
        } catch (error) {
            console.error('Error starting download:', error);
            const errorText = `${this.t('alert.downloadFailed')} ${error instanceof Error ? error.message : String(error)}`;
            this.updateProgress(100, errorText);
            if (!autoBatchMode) {
                alert(errorText);
                this.hideProgress();
            } else {
                this.isBatchingNow = false;
            }
            return false;
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
                autoScroll: false,
                autoBatchDownload: false
            });

            this.language = normalizeLanguage(settings.language);

            (document.getElementById('highQuality') as HTMLInputElement).checked = settings.highQuality !== false;
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

                const settings = await sidebar.getSettings();
                sidebar.isBatchingNow = false;

                if (settings.autoScroll === true) {
                    setTimeout(() => {
                        sidebar.toggleAutoScroll(true, { resetBatchState: false });
                    }, 1000);
                }
            })().catch((error) => console.error(error));
        }
    } else if (message.action === 'downloadError') {
        sidebar.updateProgress(100, `${sidebar.t('alert.downloadFailed')} ${message.error}`);
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




