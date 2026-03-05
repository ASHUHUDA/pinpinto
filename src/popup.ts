import { isPinterestUrl as isPinterestPageUrl } from './shared/pinterest';

type SupportedLanguage = 'en' | 'zh';

type PopupSettings = {
    language: SupportedLanguage;
    highQuality: boolean;
    privacyMode: boolean;
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

class PinVaultProPopup {
    selectedImages: Set<string>;
    totalImages: number;
    isAutoScrolling: boolean;
    autoScrollStatsTimer: number | null;
    statsUpdateTimer: number | null;
    language: SupportedLanguage;
    translations: Record<string, { checkingPinterest: string; connected: string; notConnected: string }>;
    staticTranslations: Record<SupportedLanguage, Record<string, string>>;

    constructor() {
        this.selectedImages = new Set();
        this.totalImages = 0;
        this.isAutoScrolling = false;
        this.autoScrollStatsTimer = null;
        this.statsUpdateTimer = null;
        this.language = 'en';
        this.translations = {
            en: {
                checkingPinterest: 'Checking...',
                connected: 'Connected to Pinterest',
                notConnected: 'Not a Pinterest page'
            },
            zh: {
                checkingPinterest: '检查中...',
                connected: '已连接 Pinterest',
                notConnected: '非 Pinterest 页面'
            }
        };
        this.staticTranslations = {
            en: {
                'app.subtitle': 'Pinterest Downloader',
                'stats.total': 'Images',
                'stats.selected': 'Selected',
                'action.selectAll': 'Select all',
                'action.clear': 'Clear',
                'action.sidebar': 'Sidebar',
                'setting.autoScroll': 'Auto scroll',
                'setting.autoBatch': 'Auto batch (200, max 3 rounds)',
                'action.stop': 'Stop',
                'panel.downloadSettings': 'Download settings',
                'setting.highQuality': 'Prefer high quality',
                'setting.privacyMode': 'Privacy mode',
                'action.downloadSelected': 'Download selected',
                'action.cancelDownload': 'Cancel download',
                'state.notPinterestTitle': 'Open Pinterest first',
                'state.notPinterestDesc': 'Current tab is not Pinterest.',
                'action.openPinterest': 'Open Pinterest',
                'menu.language': 'Language',
                'menu.github': 'GitHub'
            },
            zh: {
                'app.subtitle': 'Pinterest 下载器',
                'stats.total': '页面图片',
                'stats.selected': '已选择',
                'action.selectAll': '全选',
                'action.clear': '清空',
                'action.sidebar': '侧边栏',
                'setting.autoScroll': '自动滚动',
                'setting.autoBatch': '200图自动下(最多3次)',
                'action.stop': '停止',
                'panel.downloadSettings': '下载设置',
                'setting.highQuality': '优先下载高清图',
                'setting.privacyMode': '隐私模式',
                'action.downloadSelected': '下载已选',
                'action.cancelDownload': '取消下载',
                'state.notPinterestTitle': '请先打开 Pinterest',
                'state.notPinterestDesc': '当前页不是 Pinterest。',
                'action.openPinterest': '打开 Pinterest',
                'menu.language': '语言',
                'menu.github': 'GitHub'
            }
        };

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
            privacyMode: false,
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

        this.language = settings.language === 'zh' ? 'zh' : 'en';
        (document.getElementById('highQuality') as HTMLInputElement).checked = settings.highQuality;
        (document.getElementById('privacyMode') as HTMLInputElement).checked = settings.privacyMode;
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

        document.getElementById('autoScrollToggle')?.addEventListener('change', (e) => {
            this.toggleAutoScroll((e.target as HTMLInputElement).checked);
        });

        document.getElementById('autoBatchToggle')?.addEventListener('change', (e) => {
            this.saveSetting('autoBatchDownload', (e.target as HTMLInputElement).checked);
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

        document.getElementById('privacyMode')?.addEventListener('change', (e) => {
            this.saveSetting('privacyMode', (e.target as HTMLInputElement).checked);
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
        const menu = document.getElementById('settingsMenu');
        const trigger = document.getElementById('settingsBtn');
        if (!menu || !trigger) return;

        const isHidden = menu.classList.contains('panel-hidden');
        menu.classList.toggle('panel-hidden', !isHidden);
        trigger.setAttribute('aria-expanded', isHidden ? 'true' : 'false');
    }

    closeSettingsMenu() {
        const menu = document.getElementById('settingsMenu');
        const trigger = document.getElementById('settingsBtn');
        if (!menu || !trigger) return;

        menu.classList.add('panel-hidden');
        trigger.setAttribute('aria-expanded', 'false');
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
        const tab = await this.getActiveTab();
        if (tab?.id && tab.url && this.isPinterestUrl(tab.url)) {
            return tab;
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

    async toggleAutoScroll(enabled: boolean) {
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

                this.autoScrollStatsTimer = window.setInterval(async () => {
                    await this.updateImageCounts();
                }, 1000);
            } else {
                await chrome.tabs.sendMessage(tab.id, { action: 'stopAutoScroll' });
                this.isAutoScrolling = false;

                if (this.autoScrollStatsTimer) {
                    clearInterval(this.autoScrollStatsTimer);
                    this.autoScrollStatsTimer = null;
                }

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

    async startDownload() {
        try {
            const tab = await this.getActivePinterestTab();
            if (!tab?.id) {
                alert(this.language === 'zh' ? '请先打开 Pinterest。' : 'Please open Pinterest first.');
                return;
            }

            await this.updateImageCounts();

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
                }
            }

            if (selectedImages.length === 0) {
                alert(this.language === 'zh' ? '请先选图。' : 'Please select images first.');
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
                        const prefix = this.language === 'zh' ? '启动下载失败：' : 'Failed to start download: ';
                        alert(`${prefix}${chrome.runtime.lastError.message}`);
                        this.hideProgress();
                        return;
                    }

                    if (!response?.success) {
                        const prefix = this.language === 'zh' ? '下载失败：' : 'Download failed: ';
                        alert(`${prefix}${response?.error || 'Unknown error'}`);
                        this.hideProgress();
                    }
                }
            );
        } catch (error) {
            console.error('Error starting download:', error);
            const prefix = this.language === 'zh' ? '下载失败：' : 'Download failed: ';
            alert(`${prefix}${error instanceof Error ? error.message : String(error)}`);
            this.hideProgress();
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
            privacyMode: false,
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
        if (textEl) textEl.textContent = '连接状态检查失败';
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
    } else if (message.action === 'downloadError') {
        popupInstance.hideProgress();
        const prefix = popupInstance.language === 'zh' ? '下载失败：' : 'Download failed: ';
        alert(`${prefix}${message.error}`);
    }
});


