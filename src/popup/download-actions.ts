import { AUTO_BATCH_DOWNLOAD_LIMIT, getAutoBatchPlan } from '../shared/download-batching';
import { SHARED_DOWNLOAD_SETTINGS_DEFAULTS } from '../shared/download-settings';

type PopupDownloadController = {
    language: 'en' | 'zh';
    batchCount: number;
    nextBatchStartIndex: number;
    activeAutoBatchSize: number;
    isBatchingNow: boolean;
    isAutoScrolling: boolean;
    autoScrollStatsTimer: number | null;
    getActivePinterestTab: () => Promise<chrome.tabs.Tab | null>;
    rememberSidebarTargetTab: (tabId: number | null) => Promise<void>;
    ensureContentScriptInjected: (tabId: number) => Promise<boolean>;
    updateStatsDisplay: (total: number, selected: number) => void;
    saveSetting: (key: string, value: any) => Promise<void>;
    setAutoScrollUi: (enabled: boolean) => void;
    updateImageCounts: () => Promise<void>;
    startDownload: (options?: { autoBatchMode?: boolean; batchStartIndex?: number; batchEndIndex?: number }) => Promise<boolean>;
    toggleAutoScroll: (enabled: boolean, options?: { resetBatchState?: boolean }) => Promise<void>;
};

export async function getAutoScrollStatus(controller: PopupDownloadController, tabId: number) {
    try {
        return await chrome.tabs.sendMessage(tabId, { action: 'getAutoScrollStatus' });
    } catch {
        return null;
    }
}

export async function getViewportAnchorIndex(controller: PopupDownloadController, tabId: number) {
    try {
        const response = await chrome.tabs.sendMessage(tabId, { action: 'getViewportAnchor' });
        return typeof response?.anchorIndex === 'number' ? response.anchorIndex : 0;
    } catch {
        return 0;
    }
}

export async function discardImagesBeforeIndex(controller: PopupDownloadController, tabId: number, startIndex: number) {
    try {
        await chrome.tabs.sendMessage(tabId, {
            action: 'discardImagesBeforeIndex',
            startIndex
        });
    } catch {
        // ignore and continue with best effort
    }
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
        controller.batchCount = 0;
        controller.nextBatchStartIndex = 0;
        controller.activeAutoBatchSize = 0;
        controller.isBatchingNow = false;
        await controller.updateImageCounts();
    } catch (error) {
        console.error('Error deselecting images:', error);
    }
}

export async function toggleAutoScroll(
    controller: PopupDownloadController,
    enabled: boolean,
    options: { resetBatchState?: boolean } = {}
) {
    const shouldResetBatchState = options.resetBatchState !== false;
    try {
        const tab = await controller.getActivePinterestTab();
        if (!tab?.id) return;

        await controller.ensureContentScriptInjected(tab.id);
        const settings = await getSettings();

        if (enabled) {
            if (shouldResetBatchState) {
                controller.batchCount = 0;
                controller.nextBatchStartIndex = 0;
                controller.activeAutoBatchSize = 0;
            }

            if (shouldResetBatchState && settings.autoBatchDownload === true) {
                const viewportAnchorIndex = await getViewportAnchorIndex(controller, tab.id);
                await discardImagesBeforeIndex(controller, tab.id, viewportAnchorIndex);
                await controller.updateImageCounts();
            }

            await chrome.tabs.sendMessage(tab.id, { action: 'startAutoScroll' });
            controller.isAutoScrolling = true;

            if (controller.autoScrollStatsTimer) {
                clearInterval(controller.autoScrollStatsTimer);
            }

            controller.isBatchingNow = false;

            controller.autoScrollStatsTimer = window.setInterval(async () => {
                if (controller.isBatchingNow) return;

                const targetTab = await controller.getActivePinterestTab();
                if (!targetTab?.id) {
                    return;
                }

                await controller.ensureContentScriptInjected(targetTab.id);
                await controller.updateImageCounts();

                const currentSettings = await getSettings();
                if (currentSettings.autoBatchDownload !== true) {
                    return;
                }

                const total = parseInt(document.getElementById('totalImages')?.textContent || '0', 10);
                const autoScrollStatus = await getAutoScrollStatus(controller, targetTab.id);
                const batchPlan = getAutoBatchPlan(total, controller.nextBatchStartIndex, currentSettings.autoBatchDownload === true, {
                    autoScrollExhausted: autoScrollStatus?.stopReason === 'exhausted'
                });
                if (!batchPlan.shouldStart) {
                    return;
                }

                controller.isBatchingNow = true;

                try {
                    await controller.ensureContentScriptInjected(targetTab.id);
                    await chrome.tabs.sendMessage(targetTab.id, { action: 'stopAutoScroll' });
                    setTimeout(async () => {
                        const started = await controller.startDownload({
                            autoBatchMode: true,
                            batchStartIndex: batchPlan.startIndex,
                            batchEndIndex: batchPlan.endIndex
                        });
                        if (!started) {
                            controller.isBatchingNow = false;
                            controller.activeAutoBatchSize = 0;
                        }
                    }, 500);
                } catch (error) {
                    console.error('Error during auto-batch:', error);
                    controller.isBatchingNow = false;
                    controller.activeAutoBatchSize = 0;
                }
            }, 1000);
        } else {
            await chrome.tabs.sendMessage(tab.id, { action: 'stopAutoScroll' });
            controller.isAutoScrolling = false;

            if (controller.autoScrollStatsTimer) {
                clearInterval(controller.autoScrollStatsTimer);
                controller.autoScrollStatsTimer = null;
            }

            controller.isBatchingNow = false;
            controller.activeAutoBatchSize = 0;
            setTimeout(() => controller.updateImageCounts(), 500);
        }

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

        let selectedImages: any[] = [];

        if (autoBatchMode) {
            const batchStartIndex = typeof options.batchStartIndex === 'number'
                ? options.batchStartIndex
                : controller.nextBatchStartIndex;
            const batchEndIndex = typeof options.batchEndIndex === 'number'
                ? options.batchEndIndex
                : batchStartIndex + AUTO_BATCH_DOWNLOAD_LIMIT;

            try {
                await controller.ensureContentScriptInjected(tab.id);
                const response = await chrome.tabs.sendMessage(tab.id, {
                    action: 'getImagesInRange',
                    startIndex: batchStartIndex,
                    endIndex: batchEndIndex
                });

                if (response?.images?.length) {
                    selectedImages = response.images;
                }
            } catch {
                // ignore and continue with empty result
            }

            if (selectedImages.length === 0) {
                controller.activeAutoBatchSize = 0;
                return false;
            }

            controller.activeAutoBatchSize = selectedImages.length;
        } else {
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
        }

        showProgress(controller);

        chrome.runtime.sendMessage(
            {
                action: 'downloadImages',
                images: selectedImages,
                settings
            },
            (response) => {
                if (chrome.runtime.lastError) {
                    const errorText = `${controller.language === 'zh' ? '启动下载失败：' : 'Failed to start download: '}${chrome.runtime.lastError.message}`;
                    updateProgress(controller, 100, errorText);
                    if (!autoBatchMode) {
                        alert(errorText);
                        hideProgress(controller);
                    } else {
                        controller.isBatchingNow = false;
                        controller.activeAutoBatchSize = 0;
                    }
                    return;
                }

                if (!response?.success) {
                    const errorText = `${controller.language === 'zh' ? '下载失败：' : 'Download failed: '}${response?.error || 'Unknown error'}`;
                    updateProgress(controller, 100, errorText);
                    if (!autoBatchMode) {
                        alert(errorText);
                        hideProgress(controller);
                    } else {
                        controller.isBatchingNow = false;
                        controller.activeAutoBatchSize = 0;
                    }
                }
            }
        );
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
            controller.activeAutoBatchSize = 0;
        }
        return false;
    }
}

export function cancelDownload(controller: PopupDownloadController) {
    chrome.runtime.sendMessage({ action: 'cancelCurrentBatch' });
    controller.isBatchingNow = false;
    controller.activeAutoBatchSize = 0;
    if (controller.autoScrollStatsTimer) {
        clearInterval(controller.autoScrollStatsTimer);
        controller.autoScrollStatsTimer = null;
    }
    void controller.toggleAutoScroll(false, { resetBatchState: false });
    hideProgress(controller);
}

export function showProgress(controller: PopupDownloadController) {
    const progressSection = document.getElementById('progressSection');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const progressDetails = document.getElementById('progressDetails');

    if (progressSection) progressSection.style.display = 'block';
    if (progressFill) (progressFill as HTMLElement).style.width = '0%';
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

    if (progressFill) (progressFill as HTMLElement).style.width = `${progress}%`;
    if (progressText) progressText.textContent = `${Math.round(progress)}%`;
    if (progressDetails) progressDetails.textContent = details;
}

export async function getSettings() {
    return chrome.storage.sync.get(SHARED_DOWNLOAD_SETTINGS_DEFAULTS);
}
