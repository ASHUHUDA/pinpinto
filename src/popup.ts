import { isPinterestUrl as isPinterestPageUrl, PINTEREST_MATCH_PATTERNS } from './shared/pinterest';
import { bindSettingsMenuDismiss, closeSettingsMenu as closeSharedSettingsMenu, toggleSettingsMenu as toggleSharedSettingsMenu } from './shared/settings-menu';
import { DEFAULT_LANGUAGE, normalizeLanguage, POPUP_STATIC_TRANSLATIONS, POPUP_STATUS_TRANSLATIONS, SupportedLanguage } from './shared/ui-translations';
import { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } from './shared/download-settings';
import {
    cancelDownload as cancelPopupDownload,
    clearAllImagesOnPage,
    deselectAllImages as deselectPopupImages,
    discardImagesBeforeIndex,
    fallbackUpdateStats as fallbackPopupUpdateStats,
    getAutoScrollStatus as getPopupAutoScrollStatus,
    getSettings as getPopupSettings,
    getViewportAnchorIndex,
    hideProgress as hidePopupProgress,
    selectAllImages as selectAllPopupImages,
    showProgress as showPopupProgress,
    startDownload as startPopupDownload,
    toggleAutoScroll as togglePopupAutoScroll,
    updateImageCounts as updatePopupImageCounts,
    updateProgress as updatePopupProgress
} from './popup/download-actions';

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

class PinVaultProPopup {
    selectedImages: Set<string>;
    totalImages: number;
    isAutoScrolling: boolean;
    autoScrollStatsTimer: number | null;
    statsUpdateTimer: number | null;
    batchCount: number;
    isBatchingNow: boolean;
    nextBatchStartIndex: number;
    activeAutoBatchSize: number;
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
        this.nextBatchStartIndex = 0;
        this.activeAutoBatchSize = 0;
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
            ...SHARED_DOWNLOAD_SETTINGS_DEFAULTS,
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

    async getAutoScrollStatus(tabId: number) { return getPopupAutoScrollStatus(this, tabId); }
    async getViewportAnchorIndex(tabId: number) { return getViewportAnchorIndex(this, tabId); }
    async discardImagesBeforeIndex(tabId: number, startIndex: number) { return discardImagesBeforeIndex(this, tabId, startIndex); }
    async clearAllImagesOnPage(tabId: number) { return clearAllImagesOnPage(this, tabId); }

    async updateImageCounts() { return updatePopupImageCounts(this); }
    async fallbackUpdateStats(tabId: number) { return fallbackPopupUpdateStats(this, tabId); }

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

    async selectAllImages() { return selectAllPopupImages(this); }
    async deselectAllImages() { return deselectPopupImages(this); }
    async toggleAutoScroll(enabled: boolean, options: { resetBatchState?: boolean } = {}) { return togglePopupAutoScroll(this, enabled, options); }

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

    async startDownload(options: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number } = {}) { return startPopupDownload(this, options); }
    cancelDownload() { return cancelPopupDownload(this); }
    showProgress() { return showPopupProgress(this); }
    hideProgress() { return hidePopupProgress(this); }
    updateProgress(progress: number, details: string) { return updatePopupProgress(this, progress, details); }
    async getSettings() { return getPopupSettings(); }

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
            if (chrome.sidePanel) {
                void this.getActivePinterestTab()
                    .then((targetTab) => this.rememberSidebarTargetTab(targetTab?.id ?? null))
                    .catch(() => {});
                await chrome.sidePanel.open({ windowId: chrome.windows.WINDOW_ID_CURRENT } as any);
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
            const completedBatchSize = popupInstance.activeAutoBatchSize
                || (Array.isArray(message.results) ? message.results.length : 0);
            popupInstance.nextBatchStartIndex += completedBatchSize;
            popupInstance.activeAutoBatchSize = 0;
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
        popupInstance.activeAutoBatchSize = 0;
        alert(`${prefix}${message.error}`);
    } else if (message.action === 'downloadCancelled') {
        popupInstance.hideProgress();
        popupInstance.isBatchingNow = false;
        popupInstance.activeAutoBatchSize = 0;
        popupInstance.isAutoScrolling = false;
        popupInstance.setAutoScrollUi(false);
        if (popupInstance.autoScrollStatsTimer) {
            clearInterval(popupInstance.autoScrollStatsTimer);
            popupInstance.autoScrollStatsTimer = null;
        }
    }
});
