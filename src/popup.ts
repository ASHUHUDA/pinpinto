import { isPinterestUrl as isPinterestPageUrl, PINTEREST_MATCH_PATTERNS } from './shared/pinterest';
import { bindSettingsMenuDismiss, closeSettingsMenu as closeSharedSettingsMenu, toggleSettingsMenu as toggleSharedSettingsMenu } from './shared/settings-menu';
import { DEFAULT_LANGUAGE, normalizeLanguage, POPUP_STATIC_TRANSLATIONS, POPUP_STATUS_TRANSLATIONS, SupportedLanguage } from './shared/ui-translations';

type PopupSettings = {
    language: SupportedLanguage;
    highQuality: boolean;
    autoScroll: boolean;
    autoBatchDownload: boolean;
    theme: string;
    advancedFeaturesEnabled: boolean;
    smartFeaturesEnabled: boolean;
    autoDownloadScheduler: boolean;
    batchProcessing: boolean;
    imageSizeFilter: string;
    duplicateDetection: boolean;
    customWatermark: boolean;
};

const SIDEBAR_TARGET_TAB_KEY = 'pinVaultSidebarTargetTabId';
const AUTO_BATCH_DOWNLOAD_LIMIT = 100;

class PinVaultProPopup {
    selectedImages: Set<string>;
    totalImages: number;
    isAutoScrolling: boolean;
    autoScrollStatsTimer: number | null;
    statsUpdateTimer: number | null;
    batchCount: number;
    isBatchingNow: boolean;
    language: SupportedLanguage;
    translations: typeof POPUP_STATUS_TRANSLATIONS;
    staticTranslations: typeof POPUP_STATIC_TRANSLATIONS;

    constructor() {
        this.selectedImages = new Set();
        this.totalImages = 0;
        this.isAutoScrolling = false;
        this.autoScrollStatsTimer = null;
        this.statsUpdateTimer = null;
        this.batchCount = 0;
        this.isBatchingNow = false;
        this.language = DEFAULT_LANGUAGE;
        this.translations = POPUP_STATUS_TRANSLATIONS;
        this.staticTranslations = POPUP_STATIC_TRANSLATIONS;

        this.init();
    }

    async init() {
        await this.loadSettings();
        this.setupEventListeners();
        this.bindButtonPressFeedback();
        this.updateLanguage();
        await this.checkPinterestConnection();
        this.setupPeriodicUpdates();
    }

    async loadSettings() {
        const settings = (await chrome.storage.sync.get({
            language: 'en',
            highQuality: true,
            autoScroll: false,
            autoBatchDownload: false,
            theme: 'default',
            advancedFeaturesEnabled: true,
            smartFeaturesEnabled: false,
            autoDownloadScheduler: false,
            batchProcessing: false,
            imageSizeFilter: 'all',
            duplicateDetection: true,
            customWatermark: false
        })) as PopupSettings;

        this.language = normalizeLanguage(settings.language);
        (document.getElementById('highQuality') as HTMLInputElement).checked = settings.highQuality;
        (document.getElementById('autoScrollToggle') as HTMLInputElement).checked = settings.autoScroll;

        const autoBatchToggle = document.getElementById('autoBatchToggle') as HTMLInputElement | null;
        if (autoBatchToggle) {
            autoBatchToggle.checked = settings.autoBatchDownload;
        }

        this.applyTheme(settings.theme);

        const themeSelector = document.getElementById('themeSelector') as HTMLSelectElement | null;
        if (themeSelector) {
            themeSelector.value = settings.theme;
        }

        await this.toggleAdvancedFeatures(settings.advancedFeaturesEnabled);
        await this.toggleSmartFeatures(settings.smartFeaturesEnabled);

        const autoDownloadEl = document.getElementById('autoDownloadScheduler') as HTMLInputElement | null;
        const batchProcessingEl = document.getElementById('batchProcessing') as HTMLInputElement | null;
        const imageSizeFilterEl = document.getElementById('imageSizeFilter') as HTMLSelectElement | null;
        const duplicateDetectionEl = document.getElementById('duplicateDetection') as HTMLInputElement | null;
        const customWatermarkEl = document.getElementById('customWatermark') as HTMLInputElement | null;

        if (autoDownloadEl) autoDownloadEl.checked = settings.autoDownloadScheduler;
        if (batchProcessingEl) batchProcessingEl.checked = settings.batchProcessing;
        if (imageSizeFilterEl) imageSizeFilterEl.value = settings.imageSizeFilter;
        if (duplicateDetectionEl) duplicateDetectionEl.checked = settings.duplicateDetection;
        if (customWatermarkEl) customWatermarkEl.checked = settings.customWatermark;

        this.setAutoScrollUi(settings.autoScroll);
    }

    setupEventListeners() {
        document.getElementById('selectAllBtn')?.addEventListener('click', () => this.selectAllImages());
        document.getElementById('deselectAllBtn')?.addEventListener('click', () => this.deselectAllImages());
        document.getElementById('openSidebarBtn')?.addEventListener('click', () => this.openSidebar());
        document.getElementById('settingsBtn')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggleSettingsMenu();
        });

        document.getElementById('languageToggleBtn')?.addEventListener('click', () => {
            this.toggleLanguage();
        });

        document.getElementById('githubMenuBtn')?.addEventListener('click', () => {
            this.openGithub();
            this.closeSettingsMenu();
        });
        bindSettingsMenuDismiss(() => this.closeSettingsMenu());

        document.getElementById('autoScrollToggle')?.addEventListener('change', (e) => {
            this.toggleAutoScroll((e.target as HTMLInputElement).checked);
        });

        document.getElementById('autoBatchToggle')?.addEventListener('change', async (e) => {
            const checked = (e.target as HTMLInputElement).checked;
            await this.saveSetting('autoBatchDownload', checked);

            if (checked) {
                this.setAutoScrollUi(true);
                await this.saveSetting('autoScroll', true);
                await this.toggleAutoScroll(true);
            }
        });

        document.getElementById('stopScrollBtn')?.addEventListener('click', () => this.stopAutoScroll());

        document.getElementById('downloadBtn')?.addEventListener('click', () => this.startDownload());
        document.getElementById('cancelDownloadBtn')?.addEventListener('click', () => this.cancelDownload());

        const themeSelector = document.getElementById('themeSelector');
        if (themeSelector) {
            themeSelector.addEventListener('change', (e) => this.changeTheme((e.target as HTMLSelectElement).value));
        }

        const advancedToggle = document.getElementById('advancedFeaturesToggle') as HTMLInputElement | null;
        const smartToggle = document.getElementById('smartFeaturesToggle') as HTMLInputElement | null;

        advancedToggle?.addEventListener('change', (e) => this.toggleAdvancedFeatures((e.target as HTMLInputElement).checked));
        smartToggle?.addEventListener('change', (e) => this.toggleSmartFeatures((e.target as HTMLInputElement).checked));

        const smartFeatureInputs = ['autoDownloadScheduler', 'batchProcessing', 'imageSizeFilter', 'duplicateDetection', 'customWatermark'];
        smartFeatureInputs.forEach((id) => {
            const element = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
            if (!element) return;

            if ((element as HTMLInputElement).type === 'checkbox') {
                element.addEventListener('change', (e) => this.saveSetting(id, (e.target as HTMLInputElement).checked));
            } else {
                element.addEventListener('change', (e) => this.saveSetting(id, (e.target as HTMLSelectElement).value));
            }
        });

        document.getElementById('highQuality')?.addEventListener('change', (e) => {
            this.saveSetting('highQuality', (e.target as HTMLInputElement).checked);
        });

        document.getElementById('openPinterestBtn')?.addEventListener('click', () => this.openPinterest());
    }

    updateLanguage() {
        document.documentElement.lang = this.language === 'zh' ? 'zh-CN' : 'en';

        document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((element) => {
            const key = element.dataset.i18n;
            if (!key) return;
            element.textContent = this.staticTranslations[this.language][key] || key;
        });

        const statusText = document.getElementById('statusText');
        if (statusText && !document.getElementById('connectionStatus')?.classList.contains('connected') && !document.getElementById('connectionStatus')?.classList.contains('not-connected')) {
            statusText.textContent = this.translations[this.language].checkingPinterest;
        }

        const languageLabel = document.getElementById('currentLanguageLabel');
        if (languageLabel) {
            languageLabel.textContent = this.language === 'en' ? 'English' : '中文';
        }
    }

    toggleSettingsMenu() {
        toggleSharedSettingsMenu();
    }

    closeSettingsMenu() {
        closeSharedSettingsMenu();
    }

    async toggleLanguage() {
        this.language = this.language === 'en' ? 'zh' : 'en';
        await this.saveSetting('language', this.language);
        this.updateLanguage();
        await this.checkPinterestConnection();
        this.closeSettingsMenu();
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

    setupPeriodicUpdates() {
        if (this.statsUpdateTimer) {
            clearInterval(this.statsUpdateTimer);
        }

        this.statsUpdateTimer = window.setInterval(async () => {
            const tab = await this.getActiveTab();
            if (tab?.url && this.isPinterestUrl(tab.url)) {
                await this.updateImageCounts();
            }
        }, 2000);
    }

    async getActiveTab() {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        return tab;
    }

    async getActivePinterestTab() {
        const activeTab = await this.getActiveTab();
        if (activeTab?.id && activeTab.url && this.isPinterestUrl(activeTab.url)) {
            return activeTab;
        }

        const { [SIDEBAR_TARGET_TAB_KEY]: storedTabId } = await chrome.storage.local.get(SIDEBAR_TARGET_TAB_KEY);
        if (typeof storedTabId === 'number') {
            try {
                const storedTab = await chrome.tabs.get(storedTabId);
                if (storedTab?.id && storedTab.url && this.isPinterestUrl(storedTab.url)) {
                    return storedTab;
                }
            } catch {
                // ignore missing/closed tab
            }
        }

        const pinterestTabs = await chrome.tabs.query({
            currentWindow: true,
            url: PINTEREST_MATCH_PATTERNS
        });

        const matchedTab = pinterestTabs.find((tab) => tab.id && tab.url && this.isPinterestUrl(tab.url));
        if (matchedTab?.id) {
            await this.rememberSidebarTargetTab(matchedTab.id);
            return matchedTab;
        }

        return null;
    }

    async rememberSidebarTargetTab(tabId: number | null) {
        if (typeof tabId === 'number') {
            await chrome.storage.local.set({ [SIDEBAR_TARGET_TAB_KEY]: tabId });
        }
    }

    async checkPinterestConnection() {
        try {
            const tab = await this.getActiveTab();
            if (!tab?.url) {
                this.showNotPinterest();
                return;
            }

            if (this.isPinterestUrl(tab.url)) {
                await this.rememberSidebarTargetTab(tab.id ?? null);
                this.showConnected();
                await this.updateImageCounts();
            } else {
                this.showNotPinterest();
            }
        } catch (error) {
            console.error('Error checking Pinterest connection:', error);
            this.showError();
        }
    }

    isPinterestUrl(url: string) {
        return isPinterestPageUrl(url);
    }

    async ensureContentScriptInjected(tabId: number) {
        try {
            const response = await chrome.tabs.sendMessage(tabId, { action: 'ping' });
            if (response?.status === 'ready') {
                return true;
            }
        } catch {
            // ignore and continue injecting
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
            console.error('Error injecting content script:', error);
            return false;
        }
    }

    getPrimaryContentScriptFile() {
        const contentScripts = chrome.runtime.getManifest().content_scripts;
        const firstEntry = contentScripts && contentScripts[0];
        const firstScript = firstEntry?.js?.[0];
        return typeof firstScript === 'string' && firstScript.length > 0 ? firstScript : null;
    }

    async updateImageCounts() {
        try {
            const tab = await this.getActivePinterestTab();
            if (!tab?.id || !tab.url) {
                this.updateStatsDisplay(0, 0);
                return;
            }

            await this.rememberSidebarTargetTab(tab.id);
            await this.ensureContentScriptInjected(tab.id);

            const response = await chrome.tabs.sendMessage(tab.id, { action: 'getImageCounts' });
            if (response && response.total !== undefined) {
                this.updateStatsDisplay(response.total, response.selected?.length || 0);
                return;
            }

            await this.fallbackUpdateStats(tab.id);
        } catch (error) {
            console.error('Error updating image counts:', error);
            try {
                const tab = await this.getActivePinterestTab();
                if (tab?.id) {
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

    updateStatsDisplay(total: number, selected: number) {
        this.totalImages = total;

        const totalImagesEl = document.getElementById('totalImages');
        const selectedCountEl = document.getElementById('selectedCount');
        const downloadCountEl = document.getElementById('downloadCount');
        const downloadBtn = document.getElementById('downloadBtn') as HTMLButtonElement | null;

        if (totalImagesEl) totalImagesEl.textContent = String(total);
        if (selectedCountEl) selectedCountEl.textContent = String(selected);
        if (downloadCountEl) downloadCountEl.textContent = `(${selected})`;
        if (downloadBtn) downloadBtn.disabled = selected === 0;
    }

    async selectAllImages() {
        try {
            const tab = await this.getActivePinterestTab();
            if (!tab?.id) return;

            await this.ensureContentScriptInjected(tab.id);
            await chrome.tabs.sendMessage(tab.id, { action: 'selectAllImages' });
            await this.updateImageCounts();
        } catch (error) {
            console.error('Error selecting all images:', error);
        }
    }

    async deselectAllImages() {
        try {
            const tab = await this.getActivePinterestTab();
            if (!tab?.id) return;

            await this.ensureContentScriptInjected(tab.id);
            await chrome.tabs.sendMessage(tab.id, { action: 'deselectAllImages' });
            await this.updateImageCounts();
        } catch (error) {
            console.error('Error deselecting images:', error);
        }
    }

    async toggleAutoScroll(enabled: boolean, options: { resetBatchState?: boolean } = {}) {
        const shouldResetBatchState = options.resetBatchState !== false;
        try {
            const tab = await this.getActivePinterestTab();
            if (!tab?.id) return;

            await this.ensureContentScriptInjected(tab.id);

            if (enabled) {
                await chrome.tabs.sendMessage(tab.id, { action: 'startAutoScroll' });
                this.isAutoScrolling = true;

                if (this.autoScrollStatsTimer) {
                    clearInterval(this.autoScrollStatsTimer);
                }

                if (shouldResetBatchState) {
                    this.batchCount = 0;
                }
                this.isBatchingNow = false;

                this.autoScrollStatsTimer = window.setInterval(async () => {
                    if (this.isBatchingNow) return;

                    await this.updateImageCounts();

                    const settings = await this.getSettings();
                    if (settings.autoBatchDownload !== true) {
                        return;
                    }

                    const total = parseInt(document.getElementById('totalImages')?.textContent || '0', 10);
                    const targetThreshold = (this.batchCount + 1) * AUTO_BATCH_DOWNLOAD_LIMIT;

                    if (total < targetThreshold) {
                        return;
                    }

                    const targetTab = await this.getActivePinterestTab();
                    if (!targetTab?.id) {
                        return;
                    }

                    this.isBatchingNow = true;

                    try {
                        await this.ensureContentScriptInjected(targetTab.id);
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
                }, 1000);
            } else {
                await chrome.tabs.sendMessage(tab.id, { action: 'stopAutoScroll' });
                this.isAutoScrolling = false;

                if (this.autoScrollStatsTimer) {
                    clearInterval(this.autoScrollStatsTimer);
                    this.autoScrollStatsTimer = null;
                }

                this.isBatchingNow = false;
                setTimeout(() => this.updateImageCounts(), 500);
            }

            this.setAutoScrollUi(enabled);
            await this.saveSetting('autoScroll', enabled);
        } catch (error) {
            console.error('Error toggling auto scroll:', error);
        }
    }

    stopAutoScroll() {
        this.toggleAutoScroll(false);
    }

    setAutoScrollUi(enabled: boolean) {
        const stopBtn = document.getElementById('stopScrollBtn') as HTMLButtonElement | null;
        const toggle = document.getElementById('autoScrollToggle') as HTMLInputElement | null;

        if (stopBtn) {
            stopBtn.disabled = !enabled;
        }

        if (toggle) {
            toggle.checked = enabled;
        }
    }

    async startDownload(options: { autoBatchMode?: boolean } = {}): Promise<boolean> {
        const autoBatchMode = options.autoBatchMode === true;

        try {
            const tab = await this.getActivePinterestTab();
            if (!tab?.id) {
                if (!autoBatchMode) {
                    alert(this.language === 'zh' ? '请先打开 Pinterest。' : 'Please open Pinterest first.');
                }
                return false;
            }

            await this.updateImageCounts();
            const settings = await this.getSettings();

            if (autoBatchMode) {
                try {
                    await this.ensureContentScriptInjected(tab.id);
                    await chrome.tabs.sendMessage(tab.id, { action: 'selectAllImages' });
                    await new Promise((resolve) => setTimeout(resolve, 250));
                } catch {
                    // ignore and continue with fallbacks
                }
            }

            let selectedImages: any[] = [];
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
                }
            }

            if (selectedImages.length === 0 && autoBatchMode) {
                const results = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const allImages = document.querySelectorAll('img[src*="pinimg.com"], img[data-src*="pinimg.com"]');
                        const imageData: Array<{ id: string; url: string; title: string; board: string; domain: string; originalFilename: string | undefined }> = [];

                        allImages.forEach((img, index) => {
                            const image = img as HTMLImageElement;
                            const src = image.src || image.getAttribute('data-src') || '';
                            if (!src || !src.includes('pinimg.com')) return;

                            imageData.push({
                                id: `img_${Date.now()}_${index}`,
                                url: src,
                                title: image.alt || image.title || `Pinterest 图片 ${index + 1}`,
                                board: document.title || 'Pinterest',
                                domain: window.location.hostname,
                                originalFilename: src.split('/').pop()
                            });
                        });

                        return imageData;
                    }
                });

                if (results?.[0]?.result?.length) {
                    selectedImages = results[0].result;
                }
            }

            if (selectedImages.length === 0) {
                if (!autoBatchMode) {
                    alert(this.language === 'zh' ? '请先选图。' : 'Please select images first.');
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
                        const errorText = `${this.language === 'zh' ? '启动下载失败：' : 'Failed to start download: '}${chrome.runtime.lastError.message}`;
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
                        const errorText = `${this.language === 'zh' ? '下载失败：' : 'Download failed: '}${response?.error || 'Unknown error'}`;
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
            const errorText = `${this.language === 'zh' ? '下载失败：' : 'Download failed: '}${error instanceof Error ? error.message : String(error)}`;
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

    cancelDownload() {
        chrome.runtime.sendMessage({ action: 'cancelDownload' });
        this.hideProgress();
    }

    showProgress() {
        const progressSection = document.getElementById('progressSection');
        const progressFill = document.getElementById('progressFill');
        const progressText = document.getElementById('progressText');
        const progressDetails = document.getElementById('progressDetails');

        if (progressSection) progressSection.style.display = 'block';
        if (progressFill) (progressFill as HTMLElement).style.width = '0%';
        if (progressText) progressText.textContent = '0%';
        if (progressDetails) progressDetails.textContent = this.language === 'zh' ? '准备下载...' : 'Preparing download...';
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

    async getSettings() {
        return chrome.storage.sync.get({
            highQuality: true,
            autoScroll: false,
            autoBatchDownload: false,
            filenameFormat: 'title_date',
            folderOrganization: 'date',
            customFolder: ''
        });
    }

    async changeTheme(theme: string) {
        this.applyTheme(theme);
        await this.saveSetting('theme', theme);
    }

    applyTheme(theme: string) {
        document.body.className = '';
        document.body.classList.add(`theme-${theme}`);

        const themeColors: Record<string, Record<string, string>> = {
            default: {
                '--primary-color': '#e60023',
                '--secondary-color': '#767676',
                '--background-color': '#ffffff',
                '--text-color': '#333333',
                '--border-color': '#e0e0e0',
                '--accent-color': '#f5f5f5'
            },
            dark: {
                '--primary-color': '#ff4458',
                '--secondary-color': '#999999',
                '--background-color': '#1a1a1a',
                '--text-color': '#ffffff',
                '--border-color': '#333333',
                '--accent-color': '#2a2a2a'
            },
            light: {
                '--primary-color': '#d4006f',
                '--secondary-color': '#888888',
                '--background-color': '#fafafa',
                '--text-color': '#222222',
                '--border-color': '#e8e8e8',
                '--accent-color': '#f0f0f0'
            },
            purple: {
                '--primary-color': '#8e44ad',
                '--secondary-color': '#9b59b6',
                '--background-color': '#f8f5ff',
                '--text-color': '#2c3e50',
                '--border-color': '#d7bde2',
                '--accent-color': '#ebdef0'
            },
            rainbow: {
                '--primary-color': 'linear-gradient(45deg, #ff6b6b, #4ecdc4, #45b7d1, #96ceb4, #ffeaa7, #fd79a8)',
                '--secondary-color': '#666666',
                '--background-color': '#fff5f5',
                '--text-color': '#2d3436',
                '--border-color': '#fab1a0',
                '--accent-color': '#ffeaa7'
            },
            ocean: {
                '--primary-color': '#0984e3',
                '--secondary-color': '#74b9ff',
                '--background-color': '#f1f9ff',
                '--text-color': '#2d3436',
                '--border-color': '#a8dadc',
                '--accent-color': '#e3f2fd'
            }
        };

        const colors = themeColors[theme] || themeColors.default;
        Object.entries(colors).forEach(([property, value]) => {
            document.documentElement.style.setProperty(property, value);
        });
    }

    async toggleAdvancedFeatures(enabled: boolean) {
        const advancedPanel = document.getElementById('advancedFeaturesPanel');
        if (advancedPanel) {
            advancedPanel.style.display = enabled ? 'block' : 'none';
        }

        const advancedToggle = document.getElementById('advancedFeaturesToggle') as HTMLInputElement | null;
        if (advancedToggle) {
            advancedToggle.checked = enabled;
        }

        await this.saveSetting('advancedFeaturesEnabled', enabled);
    }

    async toggleSmartFeatures(enabled: boolean) {
        const smartPanel = document.getElementById('smartFeaturesPanel');
        if (smartPanel) {
            smartPanel.style.display = enabled ? 'block' : 'none';
        }

        const smartToggle = document.getElementById('smartFeaturesToggle') as HTMLInputElement | null;
        if (smartToggle) {
            smartToggle.checked = enabled;
        }

        await this.saveSetting('smartFeaturesEnabled', enabled);
    }

    async saveSetting(key: string, value: any) {
        await chrome.storage.sync.set({ [key]: value });
    }

    openPinterest() {
        chrome.tabs.create({ url: 'https://www.pinterest.com' });
    }

    async openSidebar() {
        try {
            const targetTab = await this.getActivePinterestTab();
            await this.rememberSidebarTargetTab(targetTab?.id ?? null);

            if (chrome.sidePanel) {
                if (targetTab?.id) {
                    await chrome.sidePanel.open({ tabId: targetTab.id } as any);
                } else {
                    await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT } as any);
                }
            } else {
                chrome.tabs.create({ url: chrome.runtime.getURL('sidebar.html') });
            }
        } catch (error) {
            console.error('Error opening sidebar:', error);
            chrome.tabs.create({ url: chrome.runtime.getURL('sidebar.html') });
        }
    }

    openHelp() {
        chrome.tabs.create({ url: 'https://github.com/ASHUHUDA/pinpinto#readme' });
    }

    openFeedback() {
        chrome.tabs.create({ url: 'https://github.com/ASHUHUDA/pinpinto/issues/new' });
    }

    openGithub() {
        chrome.tabs.create({ url: 'https://github.com/ASHUHUDA/pinpinto' });
    }

    showConnected() {
        const statusEl = document.getElementById('connectionStatus');
        const indicatorEl = document.getElementById('statusIndicator');
        const textEl = document.getElementById('statusText');
        const mainContentEl = document.getElementById('mainContent');
        const notPinterestEl = document.getElementById('notPinterest');

        if (statusEl) statusEl.className = 'connection-status connected';
        if (indicatorEl) indicatorEl.className = 'status-indicator connected';
        if (textEl) textEl.textContent = this.translations[this.language].connected;
        if (mainContentEl) mainContentEl.style.display = 'block';
        if (notPinterestEl) notPinterestEl.style.display = 'none';
    }

    showNotPinterest() {
        const statusEl = document.getElementById('connectionStatus');
        const indicatorEl = document.getElementById('statusIndicator');
        const textEl = document.getElementById('statusText');
        const mainContentEl = document.getElementById('mainContent');
        const notPinterestEl = document.getElementById('notPinterest');

        if (statusEl) statusEl.className = 'connection-status not-connected';
        if (indicatorEl) indicatorEl.className = 'status-indicator not-connected';
        if (textEl) textEl.textContent = this.translations[this.language].notConnected;
        if (mainContentEl) mainContentEl.style.display = 'none';
        if (notPinterestEl) notPinterestEl.style.display = 'block';
    }

    showError() {
        const statusEl = document.getElementById('connectionStatus');
        const indicatorEl = document.getElementById('statusIndicator');
        const textEl = document.getElementById('statusText');

        if (statusEl) statusEl.className = 'connection-status error';
        if (indicatorEl) indicatorEl.className = 'status-indicator error';
        if (textEl) textEl.textContent = this.language === 'zh' ? '连接状态检查失败。' : 'Connection check failed.';
    }
}

let popupInstance: PinVaultProPopup;
document.addEventListener('DOMContentLoaded', () => {
    popupInstance = new PinVaultProPopup();
});

chrome.runtime.onMessage.addListener((message) => {
    if (!popupInstance) return;

    if (message.action === 'downloadProgress') {
        popupInstance.updateProgress(message.progress, message.details);
    } else if (message.action === 'downloadComplete') {
        popupInstance.hideProgress();
        popupInstance.updateImageCounts();

        if (popupInstance.isBatchingNow) {
            popupInstance.batchCount++;

            (async () => {
                const tab = await popupInstance.getActivePinterestTab();
                if (!tab?.id) {
                    popupInstance.isBatchingNow = false;
                    return;
                }

                chrome.tabs.sendMessage(tab.id, { action: 'deselectAllImages' }).catch(() => {
                    // ignore
                });

                const settings = await popupInstance.getSettings();
                popupInstance.isBatchingNow = false;

                if (settings.autoScroll === true) {
                    setTimeout(() => {
                        popupInstance.toggleAutoScroll(true, { resetBatchState: false });
                    }, 1000);
                }
            })().catch((error) => console.error(error));
        }
    } else if (message.action === 'downloadError') {
        const prefix = popupInstance.language === 'zh' ? '下载失败：' : 'Download failed: ';
        popupInstance.updateProgress(100, `${prefix}${message.error}`);
        popupInstance.isBatchingNow = false;
        alert(`${prefix}${message.error}`);
    }
});




