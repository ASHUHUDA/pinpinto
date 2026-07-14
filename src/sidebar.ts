import { isPinterestUrl as isPinterestPageUrl, PINTEREST_MATCH_PATTERNS } from './shared/pinterest';
import { bindSettingsMenuDismiss, closeSettingsMenu as closeSharedSettingsMenu, toggleSettingsMenu as toggleSharedSettingsMenu } from './shared/settings-menu';
import { DEFAULT_LANGUAGE, SIDEBAR_STATIC_TRANSLATIONS, SIDEBAR_STATUS_TRANSLATIONS, SupportedLanguage, normalizeLanguage } from './shared/ui-translations';
import { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } from './shared/download-settings';
import { normalizeAutoBatchLimit } from './shared/download-batching';
import { BatchTaskClient } from './shared/batch-task-client';
import { isTerminalBatchPhase, type BatchTaskSnapshot } from './shared/batch-task';
import {
    cancelDownload as cancelSidebarDownload,
    clearAllImagesOnPage,
    deselectAll as deselectSidebarImages,
    fallbackUpdateStats as fallbackSidebarUpdateStats,
    getSettings as getSidebarSettings,
    hideProgress as hideSidebarProgress,
    selectAll as selectAllSidebarImages,
    showProgress as showSidebarProgress,
    startDownload as startSidebarDownload,
    toggleAutoScroll as toggleSidebarAutoScroll,
    updateProgress as updateSidebarProgress
} from './sidebar/download-actions';

const SIDEBAR_TARGET_TAB_KEY = 'pinVaultSidebarTargetTabId';

class PinVaultProSidebar {
    statsUpdateTimer: number | null = null;
    autoScrollStatsTimer: number | null = null;
    isBatchingNow: boolean = false;
    language: SupportedLanguage = DEFAULT_LANGUAGE;
    translations: typeof SIDEBAR_STATUS_TRANSLATIONS = SIDEBAR_STATUS_TRANSLATIONS;
    staticTranslations: typeof SIDEBAR_STATIC_TRANSLATIONS = SIDEBAR_STATIC_TRANSLATIONS;
    batchTaskClient: BatchTaskClient;

    constructor() {
        this.batchTaskClient = new BatchTaskClient((snapshot) => this.applyBatchTaskSnapshot(snapshot));
        this.init().catch((error) => console.error(error));
    }

    async init() {
        await this.loadSettings();
        this.setupEventListeners();
        this.setVersionBadge();
        this.bindButtonPressFeedback();
        this.applyLanguage();
        this.checkPinterestStatus();

        this.statsUpdateTimer = window.setInterval(() => {
            this.updateStats();
        }, 2000);

        setTimeout(() => {
            this.updateStats();
        }, 1000);
        await this.batchTaskClient.restore();
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
        document.getElementById('autoBatchLimit')?.addEventListener('change', (e) => {
            this.saveAutoBatchLimit((e.target as HTMLInputElement).value);
        });
        document.getElementById('autoBatchLimit')?.addEventListener('input', (e) => {
            const input = e.target as HTMLInputElement;
            input.value = input.value.replace(/\D/g, '').slice(0, 4);
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

    async fallbackUpdateStats(tabId: number) { return fallbackSidebarUpdateStats(this, tabId); }

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

    async clearAllImagesOnPage(tabId: number) { return clearAllImagesOnPage(this, tabId); }

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

    async selectAll() { return selectAllSidebarImages(this); }
    async deselectAll() { return deselectSidebarImages(this); }
    async toggleAutoScroll(enabled: boolean) { return toggleSidebarAutoScroll(this, enabled); }

    async startDownload(options: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number } = {}) { return startSidebarDownload(this, options); }
    showProgress() { return showSidebarProgress(this); }
    hideProgress() { return hideSidebarProgress(this); }
    updateProgress(progress: number, details: string) { return updateSidebarProgress(this, progress, details); }
    cancelDownload() { return cancelSidebarDownload(this); }
    async startBatchTask(request: Record<string, unknown>) { return this.batchTaskClient.start(request); }
    async cancelBatchTask() { return this.batchTaskClient.cancel(); }

    async loadSettings() {
        try {
            const settings = await chrome.storage.sync.get({
                language: 'en',
                ...SHARED_DOWNLOAD_SETTINGS_DEFAULTS
            });

            this.language = normalizeLanguage(settings.language);

            (document.getElementById('highQuality') as HTMLInputElement).checked = settings.highQuality !== false;
            (document.getElementById('autoScrollToggle') as HTMLInputElement).checked = settings.autoScroll === true;

            const autoBatchToggle = document.getElementById('autoBatchToggle') as HTMLInputElement | null;
            if (autoBatchToggle) autoBatchToggle.checked = settings.autoBatchDownload === true;
            this.syncAutoBatchLimitInput(settings.autoBatchLimit);
        } catch (error) {
            console.error('Error loading settings:', error);
        }
    }

    setVersionBadge() {
        const version = chrome.runtime.getManifest().version;
        document.querySelectorAll<HTMLElement>('.badge-version').forEach((badge) => {
            badge.textContent = `v${version}`;
        });
    }

    syncAutoBatchLimitInput(value: unknown) {
        const input = document.getElementById('autoBatchLimit') as HTMLInputElement | null;
        if (input) input.value = String(normalizeAutoBatchLimit(value));
    }

    async saveAutoBatchLimit(value: unknown) {
        const limit = normalizeAutoBatchLimit(value);
        this.syncAutoBatchLimitInput(limit);
        await this.saveSetting('autoBatchLimit', limit);
    }

    async saveSetting(key: string, value: unknown) {
        try {
            await chrome.storage.sync.set({ [key]: value });
        } catch (error) {
            console.error('Error saving setting:', error);
        }
    }

    async getSettings() { return getSidebarSettings(); }

    applyBatchTaskSnapshot(snapshot: BatchTaskSnapshot) {
        this.showProgress();
        this.updateProgress(snapshot.progress, snapshot.details);
        this.isBatchingNow = !isTerminalBatchPhase(snapshot.phase);
        if (isTerminalBatchPhase(snapshot.phase)) {
            const autoScrollToggle = document.getElementById('autoScrollToggle') as HTMLInputElement | null;
            if (autoScrollToggle) autoScrollToggle.checked = false;
            void this.updateStats();
        }
    }
}

let sidebar: PinVaultProSidebar;

chrome.runtime.onMessage.addListener((message) => {
    if (!sidebar) return;
    sidebar.batchTaskClient.acceptMessage(message);
});

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        sidebar = new PinVaultProSidebar();
    });
} else {
    sidebar = new PinVaultProSidebar();
}




