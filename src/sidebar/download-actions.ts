import { normalizeAutoBatchLimit } from '../shared/download-batching';
import { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } from '../shared/download-settings';

type SidebarDownloadController = {
    isBatchingNow: boolean;
    autoScrollStatsTimer: number | null;
    resolveTargetTab: () => Promise<chrome.tabs.Tab | null>;
    ensureContentScriptInjected: (tabId: number) => Promise<boolean>;
    updateStatsDisplay: (total: number, selected: number) => void;
    updateStats: () => Promise<void>;
    saveSetting: (key: string, value: unknown) => Promise<void>;
    startDownload: (options?: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number }) => Promise<boolean>;
    toggleAutoScroll: (enabled: boolean) => Promise<void>;
    startBatchTask: (request: Record<string, unknown>) => Promise<{ accepted: boolean; jobId: string; reason?: string }>;
    cancelBatchTask: () => Promise<boolean>;
    t: (key: string) => string;
};

async function saveAutoOptionsDisabled(controller: SidebarDownloadController) {
    await Promise.all([
        controller.saveSetting('autoScroll', false),
        controller.saveSetting('autoBatchDownload', false)
    ]);
}

function setToggleChecked(id: string, checked: boolean) {
    const toggle = document.getElementById(id) as HTMLInputElement | null;
    if (toggle) toggle.checked = checked;
}

function clearAutoScrollTimer(controller: SidebarDownloadController) {
    if (controller.autoScrollStatsTimer) {
        clearInterval(controller.autoScrollStatsTimer);
        controller.autoScrollStatsTimer = null;
    }
}

function setAutoOptionsDisabled(controller: SidebarDownloadController) {
    controller.isBatchingNow = false;
    clearAutoScrollTimer(controller);
    setToggleChecked('autoScrollToggle', false);
    setToggleChecked('autoBatchToggle', false);
}

export async function clearAllImagesOnPage(controller: SidebarDownloadController, tabId: number) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'clearAllImages' });
    } catch {
        // ignore and continue with best effort
    }
}

export async function fallbackUpdateStats(controller: SidebarDownloadController, tabId: number) {
    const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
            if (window.pinVaultContent) {
                window.pinVaultContent.scanForImages();
                return {
                    total: window.pinVaultContent.session.imageElements.size,
                    selected: window.pinVaultContent.session.selectedImages.size
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
        controller.updateStatsDisplay(results[0].result.total, results[0].result.selected);
    }
}

export async function selectAll(controller: SidebarDownloadController) {
    try {
        const tab = await controller.resolveTargetTab();
        if (!tab?.id || !tab.url) return;

        await controller.ensureContentScriptInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, { action: 'selectAllImages' });
        controller.updateStats();
    } catch (error) {
        console.error('Error selecting all:', error);
    }
}

export async function deselectAll(controller: SidebarDownloadController) {
    try {
        const tab = await controller.resolveTargetTab();
        if (!tab?.id || !tab.url) return;

        await controller.ensureContentScriptInjected(tab.id);
        await clearAllImagesOnPage(controller, tab.id);
        controller.isBatchingNow = false;
        controller.updateStats();
    } catch (error) {
        console.error('Error deselecting all:', error);
    }
}

export async function toggleAutoScroll(
    controller: SidebarDownloadController,
    enabled: boolean
) {
    try {
        const settings = await getSettings();

        if (!enabled) {
            const shouldCancelBatchTask = controller.isBatchingNow || settings.autoBatchDownload === true;
            if (shouldCancelBatchTask) {
                await controller.cancelBatchTask();
            }

            const tab = await controller.resolveTargetTab();
            if (tab?.id && tab.url) {
                await controller.ensureContentScriptInjected(tab.id);
                await chrome.tabs.sendMessage(tab.id, { action: 'stopAutoScroll' });
            }

            setAutoOptionsDisabled(controller);
            await saveAutoOptionsDisabled(controller);
            setTimeout(() => controller.updateStats(), 500);
            return;
        }

        const tab = await controller.resolveTargetTab();
        if (!tab?.id || !tab.url) return;

        await controller.ensureContentScriptInjected(tab.id);

        if (settings.autoBatchDownload === true) {
            controller.isBatchingNow = true;
            const started = await controller.startDownload({ autoBatchMode: true });
            if (!started) controller.isBatchingNow = false;
            await controller.saveSetting('autoScroll', started);
            return;
        }

        await chrome.tabs.sendMessage(tab.id, { action: 'startAutoScroll' });
        clearAutoScrollTimer(controller);
        controller.isBatchingNow = false;

        controller.autoScrollStatsTimer = window.setInterval(async () => {
            if (controller.isBatchingNow) return;

            const targetTab = await controller.resolveTargetTab();
            if (!targetTab?.id) return;

            await controller.ensureContentScriptInjected(targetTab.id);
            await controller.updateStats();

        }, 1000);

        await controller.saveSetting('autoScroll', enabled);
    } catch (error) {
        console.error('Error toggling auto-scroll:', error);
    }
}

export async function startDownload(
    controller: SidebarDownloadController,
    options: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number } = {}
) {
    const autoBatchMode = options.autoBatchMode === true;
    try {
        const tab = await controller.resolveTargetTab();
        if (!tab?.id || !tab.url) {
            if (!autoBatchMode) {
                alert(controller.t('alert.openPinterestFirst'));
            }
            return false;
        }

        await controller.updateStats();

        const settings = await getSettings();
        if (autoBatchMode) {
            showProgress(controller);
            const response = await controller.startBatchTask({
                mode: 'auto',
                targetTabId: tab.id,
                settings,
                autoBatchLimit: normalizeAutoBatchLimit(settings.autoBatchLimit)
            });
            if (!response.accepted) {
                updateProgress(controller, 100, 'Another batch task is already running.');
                controller.isBatchingNow = false;
                return false;
            }
            return true;
        }

        let selectedImages: any[] = [];
        try {
            await controller.ensureContentScriptInjected(tab.id);
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
                alert(controller.t('alert.noImages'));
                return false;
            }
        }

        showProgress(controller);

        const response = await controller.startBatchTask({
            mode: 'manual',
            targetTabId: tab.id,
            images: selectedImages,
            settings
        });
        if (!response.accepted) {
            updateProgress(controller, 100, 'Another batch task is already running.');
            return false;
        }
        return true;
    } catch (error) {
        console.error('Error starting download:', error);
        const errorText = `${controller.t('alert.downloadFailed')} ${error instanceof Error ? error.message : String(error)}`;
        updateProgress(controller, 100, errorText);
        if (!autoBatchMode) {
            alert(errorText);
            hideProgress(controller);
        } else {
            controller.isBatchingNow = false;
        }
        return false;
    }
}

export function showProgress(controller: SidebarDownloadController) {
    const progressSection = document.getElementById('progressSection');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const progressDetails = document.getElementById('progressDetails');

    if (progressSection) progressSection.style.display = 'block';
    if (progressFill) {
        (progressFill as HTMLElement).style.width = '0%';
        if ('setAttribute' in progressFill) progressFill.setAttribute('aria-valuenow', '0');
    }
    if (progressText) progressText.textContent = '0%';
    if (progressDetails) progressDetails.textContent = controller.t('progress.preparing');
}

export function hideProgress(controller: SidebarDownloadController) {
    const progressSection = document.getElementById('progressSection');
    if (progressSection) progressSection.style.display = 'none';
}

export function updateProgress(controller: SidebarDownloadController, progress: number, details: string) {
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const progressDetails = document.getElementById('progressDetails');

    if (progressFill) {
        (progressFill as HTMLElement).style.width = `${progress}%`;
        if ('setAttribute' in progressFill) progressFill.setAttribute('aria-valuenow', String(progress));
    }
    if (progressText) progressText.textContent = `${Math.round(progress)}%`;
    if (progressDetails) progressDetails.textContent = details;
}

export function cancelDownload(controller: SidebarDownloadController) {
    void controller.cancelBatchTask();
    setAutoOptionsDisabled(controller);
    void saveAutoOptionsDisabled(controller);
    hideProgress(controller);
}

export async function getSettings() {
    try {
        return await chrome.storage.sync.get(SHARED_DOWNLOAD_SETTINGS_DEFAULTS);
    } catch (error) {
        console.error('Error getting settings:', error);
        return { ...SHARED_DOWNLOAD_SETTINGS_DEFAULTS };
    }
}
