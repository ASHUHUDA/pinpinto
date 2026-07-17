import { normalizeAutoBatchLimit, normalizeAutoBatchTotalBatches } from '../shared/download-batching';
import { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } from '../shared/download-settings';

type PopupDownloadController = {
    language: 'en' | 'zh';
    isBatchingNow: boolean;
    isAutoScrolling: boolean;
    autoScrollStatsTimer: number | null;
    getActivePinterestTab: () => Promise<chrome.tabs.Tab | null>;
    rememberSidebarTargetTab: (tabId: number | null) => Promise<void>;
    ensureContentScriptInjected: (tabId: number) => Promise<boolean>;
    updateStatsDisplay: (total: number, selected: number) => void;
    saveSetting: (key: string, value: any) => Promise<void>;
    setAutoScrollUi: (enabled: boolean) => void;
    setAutoBatchUi: (enabled: boolean) => void;
    updateImageCounts: () => Promise<void>;
    startDownload: (options?: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number }) => Promise<boolean>;
    toggleAutoScroll: (enabled: boolean) => Promise<void>;
    startBatchTask: (request: Record<string, unknown>) => Promise<{ accepted: boolean; jobId: string; reason?: string }>;
    cancelBatchTask: () => Promise<boolean>;
    stopBatchAfterCurrent: (continueAutoScroll: boolean) => Promise<boolean>;
};

async function saveAutoOptionsDisabled(controller: PopupDownloadController) {
    await Promise.all([
        controller.saveSetting('autoScroll', false),
        controller.saveSetting('autoBatchDownload', false)
    ]);
}

function setAutoBatchUi(enabled: boolean) {
    const toggle = document.getElementById('autoBatchToggle') as HTMLInputElement | null;
    if (toggle) toggle.checked = enabled;
}

function clearAutoScrollTimer(controller: PopupDownloadController) {
    if (controller.autoScrollStatsTimer) {
        clearInterval(controller.autoScrollStatsTimer);
        controller.autoScrollStatsTimer = null;
    }
}

function setAutoOptionsDisabled(controller: PopupDownloadController) {
    controller.isAutoScrolling = false;
    controller.isBatchingNow = false;
    clearAutoScrollTimer(controller);
    controller.setAutoScrollUi(false);
    setAutoBatchUi(false);
}

function setGracefulStopUi(controller: PopupDownloadController, continueAutoScroll: boolean) {
    controller.isAutoScrolling = continueAutoScroll;
    clearAutoScrollTimer(controller);
    controller.setAutoScrollUi(continueAutoScroll);
    controller.setAutoBatchUi(false);
}

export async function toggleAutoBatchDownload(controller: PopupDownloadController, enabled: boolean) {
    if (enabled) {
        await controller.saveSetting('autoScroll', true);
        await controller.saveSetting('autoBatchDownload', true);
        controller.setAutoScrollUi(true);
        controller.setAutoBatchUi(true);
        await controller.toggleAutoScroll(true);
        return;
    }

    await controller.saveSetting('autoBatchDownload', false);
    await controller.saveSetting('autoScroll', true);
    controller.setAutoBatchUi(false);
    controller.setAutoScrollUi(true);
    await controller.stopBatchAfterCurrent(true);
}

export async function clearAllImagesOnPage(controller: PopupDownloadController, tabId: number) {
    try {
        await chrome.tabs.sendMessage(tabId, { action: 'clearAllImages' });
    } catch {
        // ignore and continue with best effort
    }
}

export async function updateImageCounts(controller: PopupDownloadController) {
    try {
        const tab = await controller.getActivePinterestTab();
        if (!tab?.id || !tab.url) {
            controller.updateStatsDisplay(0, 0);
            return;
        }

        await controller.rememberSidebarTargetTab(tab.id);
        await controller.ensureContentScriptInjected(tab.id);

        const response = await chrome.tabs.sendMessage(tab.id, { action: 'getImageCounts' });
        if (response && response.total !== undefined) {
            controller.updateStatsDisplay(response.total, response.selected?.length || 0);
            return;
        }

        await fallbackUpdateStats(controller, tab.id);
    } catch (error) {
        console.error('Error updating image counts:', error);
        try {
            const tab = await controller.getActivePinterestTab();
            if (tab?.id) {
                await fallbackUpdateStats(controller, tab.id);
            }
        } catch (fallbackError) {
            console.error('Fallback stats update failed:', fallbackError);
        }
    }
}


async function getCurrentAutoBatchLimit(controller: PopupDownloadController, storedValue: unknown): Promise<number> {
    const input = document.getElementById('autoBatchLimit') as HTMLInputElement | null;
    const limit = normalizeAutoBatchLimit(input?.value ?? storedValue);
    if (input) input.value = String(limit);
    if (normalizeAutoBatchLimit(storedValue) !== limit) {
        await controller.saveSetting('autoBatchLimit', limit);
    }
    return limit;
}

async function getCurrentAutoBatchTotalBatches(controller: PopupDownloadController, storedValue: unknown): Promise<number> {
    const input = document.getElementById('autoBatchTotalBatches') as HTMLInputElement | null;
    const totalBatches = normalizeAutoBatchTotalBatches(input?.value ?? storedValue);
    if (input) input.value = totalBatches > 0 ? String(totalBatches) : '';
    if (normalizeAutoBatchTotalBatches(storedValue) !== totalBatches) {
        await controller.saveSetting('autoBatchTotalBatches', totalBatches);
    }
    return totalBatches;
}

export async function fallbackUpdateStats(controller: PopupDownloadController, tabId: number) {
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

export async function selectAllImages(controller: PopupDownloadController) {
    try {
        const tab = await controller.getActivePinterestTab();
        if (!tab?.id) return;

        await controller.ensureContentScriptInjected(tab.id);
        await chrome.tabs.sendMessage(tab.id, { action: 'selectAllImages' });
        await controller.updateImageCounts();
    } catch (error) {
        console.error('Error selecting all images:', error);
    }
}

export async function deselectAllImages(controller: PopupDownloadController) {
    try {
        const tab = await controller.getActivePinterestTab();
        if (!tab?.id) return;

        await controller.ensureContentScriptInjected(tab.id);
        await clearAllImagesOnPage(controller, tab.id);
        controller.isBatchingNow = false;
        await controller.updateImageCounts();
    } catch (error) {
        console.error('Error deselecting images:', error);
    }
}

export async function toggleAutoScroll(
    controller: PopupDownloadController,
    enabled: boolean
) {
    try {
        const settings = await getSettings();

        if (!enabled) {
            const shouldStopBatchTask = controller.isBatchingNow || settings.autoBatchDownload === true;
            if (shouldStopBatchTask) {
                await controller.saveSetting('autoScroll', false);
                await controller.saveSetting('autoBatchDownload', false);
                setGracefulStopUi(controller, false);
                await controller.stopBatchAfterCurrent(false);
                return;
            }

            const tab = await controller.getActivePinterestTab();
            if (tab?.id) {
                await controller.ensureContentScriptInjected(tab.id);
                await chrome.tabs.sendMessage(tab.id, { action: 'stopAutoScroll' });
            }

            controller.isAutoScrolling = false;
            clearAutoScrollTimer(controller);
            controller.setAutoScrollUi(false);
            controller.setAutoBatchUi(false);
            await controller.saveSetting('autoScroll', false);
            setTimeout(() => controller.updateImageCounts(), 500);
            return;
        }

        const tab = await controller.getActivePinterestTab();
        if (!tab?.id) return;

        await controller.ensureContentScriptInjected(tab.id);

        if (settings.autoBatchDownload === true) {
            controller.isBatchingNow = true;
            const started = await controller.startDownload({ autoBatchMode: true });
            if (!started) controller.isBatchingNow = false;
            controller.setAutoScrollUi(started);
            await controller.saveSetting('autoScroll', started);
            return;
        }

        await chrome.tabs.sendMessage(tab.id, { action: 'startAutoScroll' });
        controller.isAutoScrolling = true;
        clearAutoScrollTimer(controller);
        controller.isBatchingNow = false;

        controller.autoScrollStatsTimer = window.setInterval(async () => {
            if (controller.isBatchingNow) return;

            const targetTab = await controller.getActivePinterestTab();
            if (!targetTab?.id) {
                return;
            }

            await controller.ensureContentScriptInjected(targetTab.id);
            await controller.updateImageCounts();

        }, 1000);

        controller.setAutoScrollUi(enabled);
        await controller.saveSetting('autoScroll', enabled);
    } catch (error) {
        console.error('Error toggling auto scroll:', error);
    }
}

export async function startDownload(
    controller: PopupDownloadController,
    options: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number } = {}
) {
    const autoBatchMode = options.autoBatchMode === true;

    try {
        const tab = await controller.getActivePinterestTab();
        if (!tab?.id) {
            if (!autoBatchMode) {
                alert(controller.language === 'zh' ? '请先打开 Pinterest。' : 'Please open Pinterest first.');
            }
            return false;
        }

        await controller.updateImageCounts();
        const settings = await getSettings();

        if (autoBatchMode) {
            showProgress(controller);
            const autoBatchLimit = await getCurrentAutoBatchLimit(controller, settings.autoBatchLimit);
            const autoBatchTotalBatches = await getCurrentAutoBatchTotalBatches(controller, settings.autoBatchTotalBatches);
            const autoSettings = { ...settings, autoBatchLimit, autoBatchTotalBatches };
            const response = await controller.startBatchTask({
                mode: 'auto',
                targetTabId: tab.id,
                settings: autoSettings,
                autoBatchLimit,
                autoBatchTotalBatches
            });
            if (!response.accepted) {
                const details = controller.language === 'zh'
                    ? '已有批量任务正在运行。'
                    : 'Another batch task is already running.';
                updateProgress(controller, 100, details);
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
            }
        }

        if (selectedImages.length === 0) {
            alert(controller.language === 'zh' ? '请先选图。' : 'Please select images first.');
            return false;
        }

        showProgress(controller);

        const response = await controller.startBatchTask({
            mode: 'manual',
            targetTabId: tab.id,
            images: selectedImages,
            downloadAsZip: settings.downloadAsZip,
            settings
        });
        if (!response.accepted) {
            const errorText = controller.language === 'zh'
                ? '已有批量任务正在运行。'
                : 'Another batch task is already running.';
            updateProgress(controller, 100, errorText);
            return false;
        }
        return true;
    } catch (error) {
        console.error('Error starting download:', error);
        const errorText = `${controller.language === 'zh' ? '下载失败：' : 'Download failed: '}${error instanceof Error ? error.message : String(error)}`;
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

export function cancelDownload(controller: PopupDownloadController) {
    void controller.cancelBatchTask();
    setAutoOptionsDisabled(controller);
    void saveAutoOptionsDisabled(controller);
    hideProgress(controller);
}

export function showProgress(controller: PopupDownloadController) {
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
    if (progressDetails) progressDetails.textContent = controller.language === 'zh' ? '准备下载...' : 'Preparing download...';
}

export function hideProgress(controller: PopupDownloadController) {
    const progressSection = document.getElementById('progressSection');
    if (progressSection) progressSection.style.display = 'none';
}

export function updateProgress(controller: PopupDownloadController, progress: number, details: string) {
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

export async function getSettings() {
    return chrome.storage.sync.get(SHARED_DOWNLOAD_SETTINGS_DEFAULTS);
}
