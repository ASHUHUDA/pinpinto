// Background script for PinPinto Extension
import JSZip from 'jszip';
import { PINTEREST_MATCH_PATTERNS, isPinterestUrl as isPinterestPageUrl } from './shared/pinterest';
import {
    getDownloadCandidateUrls as getDownloadCandidateUrlsHelper,
    getHighQualityUrl as getHighQualityUrlHelper,
    normalizeImageUrlForDeduplication as normalizeImageUrlForDeduplicationHelper
} from './background/image-url';
import {
    buildIndexedFilename as buildIndexedFilenameHelper,
    buildSingleFilename as buildSingleFilenameHelper,
    ensureUniqueFilename as ensureUniqueFilenameHelper,
    extractExtensionFromPath as extractExtensionFromPathHelper,
    extractFilenameFromUrl as extractFilenameFromUrlHelper,
    formatLocalTimestamp as formatLocalTimestampHelper,
    resolveImageExtension as resolveImageExtensionHelper
} from './background/filename';
import {
    extractDomainFromUrl as extractDomainFromUrlHelper,
    generateFolderPath as generateFolderPathHelper
} from './background/folder-path';

const IMAGE_FETCH_MAX_RETRIES = 3;
const IMAGE_FETCH_TIMEOUT_MS = 15000;

class PinVaultProBackground {
    activeDownloads: Map<number, any>;
    downloadQueue: any[];
    isProcessingQueue: boolean;
    maxConcurrentDownloads: number;

    constructor() {
        this.activeDownloads = new Map();
        this.downloadQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentDownloads = 3;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupContextMenu();
        this.setupDownloadHandlers();
        this.setupSidePanel();
        void this.cleanupLegacySettings();
    }

    async cleanupLegacySettings() {
        try {
            const legacySettings = await chrome.storage.sync.get('privacyMode');
            if (Object.prototype.hasOwnProperty.call(legacySettings, 'privacyMode')) {
                await chrome.storage.sync.remove('privacyMode');
                console.log('Removed legacy setting: privacyMode');
            }
        } catch (error) {
            console.warn('Failed to clean legacy settings:', error);
        }
    }

    setupEventListeners() {
        // Extension installed/updated
        chrome.runtime.onInstalled.addListener((details) => {
            this.handleInstallation(details);
        });

        // Message handling
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            this.handleMessage(request, sender, sendResponse);
            return true; // Keep channel open for async response
        });

        // Tab updates
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            this.handleTabUpdate(tabId, changeInfo, tab);
        });
    }

    setupContextMenu() {
        // Remove existing context menu items to prevent duplicates
        chrome.contextMenus.removeAll(() => {
            chrome.contextMenus.create({
                id: 'pinvault-download-image',
                title: 'Collect with PinPinto',
                contexts: ['image'],
                documentUrlPatterns: PINTEREST_MATCH_PATTERNS
                });
        });

        chrome.contextMenus.onClicked.addListener((info, tab) => {
            this.handleContextMenuClick(info, tab);
        });
    }

    setupDownloadHandlers() {
        // Monitor download progress
        chrome.downloads.onChanged.addListener((downloadDelta) => {
            this.handleDownloadChange(downloadDelta);
        });

        // Handle download completion
        chrome.downloads.onDeterminingFilename.addListener((downloadItem, suggest) => {
            this.handleDownloadFilename(downloadItem, suggest);
        });
    }

    setupSidePanel() {
        // Set up side panel for Pinterest pages
        if (chrome.sidePanel) {
            try {
                chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false });
            } catch (error) {
                console.log('Side panel API not fully available:', error);
            }
        }
    }

    handleInstallation(details) {
        if (details.reason === 'install') {
            // Set default settings
            chrome.storage.sync.set({
                language: 'en',
                filenameFormat: 'title_date',
                highQuality: true,
                autoScroll: false,
                maxConcurrentDownloads: 3,
                downloadPath: ''
            });

            console.log('PinPinto - Advanced Pinterest Image Harvester installed successfully!');
        } else if (details.reason === 'update') {
            // Handle updates
            this.handleUpdate(details.previousVersion);
        }
    }

    handleUpdate(previousVersion) {
        // Perform migration tasks if needed
        console.log(`Updated from version ${previousVersion}`);

        // Log update instead of showing notification
        console.log('PinPinto - Advanced Pinterest Image Harvester Updated: New professional features and improvements are now available!');
    }

    async handleMessage(request, sender, sendResponse) {
        try {
            switch (request.action) {
                case 'ping':
                    sendResponse({ status: 'ready', timestamp: Date.now() });
                    break;

                case 'downloadImage':
                    const downloadId = await this.downloadSingleImage(request.imageData, request.settings);
                    sendResponse({ success: true, downloadId });
                    break;

                case 'downloadImages':
                    console.log('Background: Received downloadImages request with', request.images?.length || 0, 'images');
                    const results = await this.downloadMultipleImages(request.images || request.urls, request.settings);
                    sendResponse({ success: true, results });
                    break;

                case 'cancelDownload':
                    if (typeof request.downloadId === 'number') {
                        await this.cancelDownload(request.downloadId);
                    } else {
                        await this.cancelAllDownloads();
                    }
                    sendResponse({ success: true });
                    break;

                case 'getDownloadStats':
                    const stats = this.getDownloadStats();
                    sendResponse({ stats });
                    break;

                case 'openOptionsPage':
                    chrome.runtime.openOptionsPage();
                    sendResponse({ success: true });
                    break;

                default:
                    console.warn('Background: Unknown action:', request.action);
                    sendResponse({ error: 'Unknown action' });
            }
        } catch (error) {
            console.error('Error handling message:', error);
            const errorMessage = error instanceof Error ? error.message : String(error);
            sendResponse({ error: errorMessage });
        }
    }

    handleTabUpdate(tabId, changeInfo, tab) {
        // Inject content script if navigating to Pinterest
        if (changeInfo.status === 'complete' && tab.url && this.isPinterestUrl(tab.url)) {
            const contentScriptFile = this.getPrimaryContentScriptFile();
            if (!contentScriptFile) {
                console.warn('Background: No content script path found in manifest.');
                return;
            }

            // Check if content script is already injected
            chrome.scripting.executeScript({
                target: { tabId: tabId },
                func: () => window.pinVaultContentLoaded || false
            }).then(results => {
                if (!results[0].result) {
                    // Content script not loaded, inject it
                    chrome.scripting.executeScript({
                        target: { tabId: tabId },
                        files: [contentScriptFile]
                    }).catch(error => {
                        console.log('Content script injection skipped:', error.message);
                    });
                }
            }).catch(error => {
                // Tab might not be ready, try injecting anyway
                chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: [contentScriptFile]
                }).catch(err => {
                    console.log('Content script injection failed:', err.message);
                });
            });
        }
    }

    getPrimaryContentScriptFile() {
        const contentScripts = chrome.runtime.getManifest().content_scripts;
        const firstEntry = contentScripts && contentScripts[0];
        const firstScript = firstEntry?.js?.[0];
        return typeof firstScript === 'string' && firstScript.length > 0 ? firstScript : null;
    }

    async handleContextMenuClick(info, tab) {
        try {
            const imageUrl = info.srcUrl;
            if (!imageUrl || !this.isPinterestImageUrl(imageUrl)) {
                return;
            }

            // Get user settings
            const settings = await chrome.storage.sync.get({
                filenameFormat: 'title_date',
                highQuality: true
            });

            // Prepare image data
            const imageData = {
                url: settings.highQuality === false ? imageUrl : this.getHighQualityUrl(imageUrl),
                title: this.extractTitleFromUrl(imageUrl) || 'Pinterest Image',
                board: 'Pinterest',
                originalFilename: this.extractFilenameFromUrl(imageUrl)
            };

            // Download the image
            await this.downloadSingleImage(imageData, settings);

            // Log download start instead of notification
            console.log('Download Started:', imageData.title);

        } catch (error) {
            console.error('Error handling context menu click:', error);
            console.log('Download Failed: Failed to download image');
        }
    }

    async downloadSingleImage(imageData, settings) {
        try {
            console.log('Starting download for:', imageData);

            const singleTimestamp = this.formatLocalTimestamp();
            const filename = this.buildSingleFilename(
                singleTimestamp,
                imageData.url,
                imageData.originalFilename
            );
            const folderPath = this.generateFolderPath(imageData, settings);

            const downloadOptions: chrome.downloads.DownloadOptions = {
                url: imageData.url,
                filename: `${folderPath}/${filename}`,
                conflictAction: 'uniquify'
            };

            console.log('Download options:', downloadOptions);

            const downloadId = await chrome.downloads.download(downloadOptions);
            console.log('Download started with ID:', downloadId);

            // Track download
            const requestedFilename = `${folderPath}/${filename}`;
            this.activeDownloads.set(downloadId, {
                imageData,
                settings,
                startTime: Date.now(),
                status: 'downloading',
                requestedFilename
            });

            return downloadId;

        } catch (error) {
            console.error('Error downloading image:', error);
            console.error('Image data:', imageData);
            throw error;
        }
    }

    async downloadMultipleImages(images, settings) {
        const imageList = Array.isArray(images) ? images : [];
        if (imageList.length === 0) {
            this.sendProgressUpdate(100, '未接收到可下载图片。');
            setTimeout(() => {
                this.sendMessageToAllExtensionPages({ action: 'downloadComplete', results: [] });
            }, 500);
            return [];
        }

        const uniqueImages = [];
        const currentBatchUrls = new Set<string>();
        let duplicateCount = 0;

        for (const image of imageList) {
            const imageUrl = this.normalizeImageUrlForDeduplication(image, settings);
            if (!imageUrl) continue;

            // Only dedupe within the current user action.
            // Cross-run dedupe causes "no reaction" after a failed batch.
            if (!currentBatchUrls.has(imageUrl)) {
                currentBatchUrls.add(imageUrl);
                uniqueImages.push(image);
            } else {
                duplicateCount++;
            }
        }

        console.log(`Deduplication: Filtered out ${duplicateCount} duplicate images.`);
        images = uniqueImages;
        const totalImages = images.length;

        if (totalImages === 0) {
            this.sendProgressUpdate(100, '没有检测到新的图片，已全部去重。');
            setTimeout(() => {
                this.sendMessageToAllExtensionPages({ action: 'downloadComplete', results: [] });
            }, 1000);
            return [];
        }

        const results = [];
        let completedImages = 0;
        let successfulImages = 0;
        let failedImages = 0;

        const batchTimestamp = this.formatLocalTimestamp();
        const zipName = `PinPinto_${batchTimestamp}.zip`;

        console.log(`Starting download of ${totalImages} images as ZIP: ${zipName}`);
        this.sendProgressUpdate(0, `开始打包 ${totalImages} 张图片，请稍候...`);

        const parsedBatchSize = Number(settings?.maxConcurrentDownloads);
        const batchSize = Number.isFinite(parsedBatchSize) && parsedBatchSize > 0
            ? Math.floor(parsedBatchSize)
            : this.maxConcurrentDownloads;
        const zip = new JSZip();

        for (let i = 0; i < images.length; i += batchSize) {
            const batch = images.slice(i, i + batchSize);
            const batchPromises = batch.map(async (image, batchIndex) => {
                try {
                    const sourceUrl = typeof image === 'string' ? image : image.url;
                    const candidateUrls = this.getDownloadCandidateUrls(sourceUrl, settings.highQuality !== false);
                    if (candidateUrls.length === 0) {
                        throw new Error('图片 URL 无效');
                    }

                    const { arrayBuffer, resolvedUrl } = await this.fetchImageArrayBuffer(
                        candidateUrls,
                        IMAGE_FETCH_MAX_RETRIES
                    );

                    const imageData = {
                        url: resolvedUrl,
                        title: typeof image === 'string' ? `Image_${i + batchIndex + 1}` : (image.title || `Image_${i + batchIndex + 1}`),
                        board: typeof image === 'string' ? 'Pinterest' : (image.board || 'Pinterest'),
                        originalFilename: typeof image === 'string'
                            ? this.extractFilenameFromUrl(resolvedUrl)
                            : (image.originalFilename || this.extractFilenameFromUrl(resolvedUrl))
                    };

                    const imageSequence = successfulImages + 1;
                    const filename = this.buildIndexedFilename(
                        imageSequence,
                        batchTimestamp,
                        resolvedUrl,
                        imageData.originalFilename
                    );
                    zip.file(filename, arrayBuffer);

                    successfulImages++;
                    completedImages++;
                    const progress = (completedImages / totalImages) * 50;
                    this.sendProgressUpdate(progress, `已获取 ${completedImages}/${totalImages} 张图片`);

                    const imageId = typeof image === 'string' ? `img_${i + batchIndex}` : (image.id || `img_${i + batchIndex}`);
                    return { success: true, imageId };
                } catch (error) {
                    completedImages++;
                    failedImages++;
                    const progress = (completedImages / totalImages) * 50;
                    this.sendProgressUpdate(progress, `已处理 ${completedImages}/${totalImages} 张（失败 ${failedImages} 张）`);

                    const imageId = typeof image === 'string' ? `img_${i + batchIndex}` : (image.id || `img_${i + batchIndex}`);
                    const baseErrorMessage = error instanceof Error ? error.message : String(error);
                    const errorMessage = `${baseErrorMessage}（已跳过）`;
                    return {
                        success: false,
                        error: errorMessage,
                        imageId
                    };
                }
            });

            const batchResults = await Promise.all(batchPromises);
            results.push(...batchResults);

            if (i + batchSize < images.length) {
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        // 全部下载失败时不生成空 ZIP，直接回传错误给 UI。
        if (successfulImages === 0) {
            const errorMessage = '图片下载全部失败，未生成压缩包。';
            this.sendProgressUpdate(100, errorMessage);
            setTimeout(() => {
                this.sendMessageToAllExtensionPages({ action: 'downloadError', error: errorMessage, results });
            }, 500);
            return results;
        }

        this.sendProgressUpdate(60, '图片获取完成，正在压缩打包...');

        try {
            const zipBase64 = await zip.generateAsync(
                {
                    type: 'base64',
                    compression: 'STORE'
                },
                (metadata) => {
                    this.sendProgressUpdate(60 + metadata.percent * 0.35, `打包进度：${Math.round(metadata.percent)}%`);
                }
            );

            this.sendProgressUpdate(95, '打包完成，正在触发下载...');

            const zipDataUrl = `data:application/zip;base64,${zipBase64}`;
            const zipDownloadFilename = `PinPinto/${zipName}`;
            const downloadId = await chrome.downloads.download({
                url: zipDataUrl,
                filename: zipDownloadFilename,
                conflictAction: 'uniquify'
            });

            this.activeDownloads.set(downloadId, {
                imageData: { title: zipName, url: 'local-zip' },
                settings,
                startTime: Date.now(),
                status: 'downloading',
                isBatch: true,
                requestedFilename: zipDownloadFilename
            });

            console.log(`ZIP download started with ID: ${downloadId}`);

            this.sendProgressUpdate(
                100,
                `ZIP 已开始下载，成功保存 ${results.filter(r => r.success).length}/${totalImages} 张图片。`
            );

            setTimeout(() => {
                this.sendMessageToAllExtensionPages({ action: 'downloadComplete', results });
            }, 1000);

            return results;
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            console.error('Error generating or downloading ZIP:', error);
            this.sendProgressUpdate(100, `打包下载失败：${errorMessage}`);

            setTimeout(() => {
                this.sendMessageToAllExtensionPages({ action: 'downloadError', error: errorMessage, results });
            }, 1000);

            return results;
        }
    }

    normalizeImageUrlForDeduplication(image, settings) {
        return normalizeImageUrlForDeduplicationHelper(image, settings, (url) => this.getHighQualityUrl(url));
    }

    getDownloadCandidateUrls(rawUrl, highQualityEnabled) {
        return getDownloadCandidateUrlsHelper(rawUrl, highQualityEnabled, (url) => this.getHighQualityUrl(url));
    }

    async fetchImageArrayBuffer(candidateUrls, maxRetries = IMAGE_FETCH_MAX_RETRIES) {
        let lastError = new Error('图片获取失败');

        // 单图最多重试 3 次；失败则返回错误给当前图片并继续后续图片，避免整批中断。
        for (let attempt = 1; attempt <= maxRetries; attempt++) {
            // 先尝试高清 URL，再回退原始 URL，避免 originals 不存在时整图失败。
            for (const url of candidateUrls) {
                try {
                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
                    const response = await fetch(url, {
                        cache: 'no-store',
                        signal: controller.signal
                    }).finally(() => {
                        clearTimeout(timeoutId);
                    });
                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}`);
                    }

                    const contentType = response.headers.get('content-type') || '';
                    if (contentType && !contentType.startsWith('image/')) {
                        throw new Error(`非图片响应: ${contentType}`);
                    }

                    const arrayBuffer = await response.arrayBuffer();
                    if (arrayBuffer.byteLength === 0) {
                        throw new Error('图片内容为空');
                    }

                    return { arrayBuffer, resolvedUrl: url };
                } catch (error) {
                    if (error instanceof Error && error.name === 'AbortError') {
                        lastError = new Error(`请求超时（>${IMAGE_FETCH_TIMEOUT_MS / 1000}秒）：${url}`);
                    } else {
                        lastError = error instanceof Error ? error : new Error(String(error));
                    }
                }
            }

            if (attempt < maxRetries) {
                // 简单线性退避，降低瞬时网络抖动导致的连续失败概率。
                await new Promise((resolve) => setTimeout(resolve, attempt * 300));
            }
        }

        const lastMessage = lastError?.message || '未知错误';
        throw new Error(`图片获取失败（已重试 ${maxRetries} 次）：${lastMessage}`);
    }

    ensureUniqueFilename(filename, usedFilenames) {
        return ensureUniqueFilenameHelper(filename, usedFilenames);
    }

    async cancelDownload(downloadId) {
        try {
            await chrome.downloads.cancel(downloadId);
            this.activeDownloads.delete(downloadId);
        } catch (error) {
            console.error('Error canceling download:', error);
            throw error;
        }
    }

    async cancelAllDownloads() {
        const allDownloadIds = Array.from(this.activeDownloads.keys());
        await Promise.all(
            allDownloadIds.map(async (id) => {
                try {
                    await chrome.downloads.cancel(id);
                } catch (error) {
                    console.log('Skip cancel for download:', id, error instanceof Error ? error.message : error);
                }
            })
        );
        this.activeDownloads.clear();
    }

    sendProgressUpdate(progress, details) {
        // Send progress update to all active extension pages (popup and sidebar)
        const message = {
            action: 'downloadProgress',
            progress: progress,
            details: details
        };

        // Send to all extension pages
        this.sendMessageToAllExtensionPages(message);
    }

    async sendMessageToAllExtensionPages(message) {
        try {
            // Send to runtime (popup)
            chrome.runtime.sendMessage(message).catch(() => {
                // Ignore if popup is not open
            });

            // Send to all tabs with our extension content
            const tabs = await chrome.tabs.query({});
            for (const tab of tabs) {
                if (tab.url && (tab.url.includes(chrome.runtime.id) || tab.url.includes('pinterest'))) {
                    chrome.tabs.sendMessage(tab.id, message).catch(() => {
                        // Ignore errors for tabs that don't have our content script
                    });
                }
            }
        } catch (error) {
            console.log('Error sending message to extension pages:', error);
        }
    }

    async sendMessageToSidebar(message) {
        // Use the unified method
        await this.sendMessageToAllExtensionPages(message);
    }

    handleDownloadChange(downloadDelta) {
        const downloadId = downloadDelta.id;
        const downloadInfo = this.activeDownloads.get(downloadId);

        if (!downloadInfo) return;

        // Update download status
        if (downloadDelta.state) {
            downloadInfo.status = downloadDelta.state.current;

            if (downloadDelta.state.current === 'complete') {
                downloadInfo.endTime = Date.now();
                downloadInfo.duration = downloadInfo.endTime - downloadInfo.startTime;

                // Show completion log for single downloads
                if (!downloadInfo.isBatch) {
                    console.log('Download Complete:', downloadInfo.imageData.title);
                }

                // Clean up
                setTimeout(() => {
                    this.activeDownloads.delete(downloadId);
                }, 30000); // Keep for 30 seconds for stats

            } else if (downloadDelta.state.current === 'interrupted') {
                downloadInfo.error = downloadDelta.error || 'Download interrupted';

                // Show error log
                console.log('Download Failed:', downloadInfo.imageData.title);

                // Clean up
                this.activeDownloads.delete(downloadId);
            }
        }
    }

    handleDownloadFilename(downloadItem, suggest) {
        // Allow custom filename logic if needed
        const downloadInfo = this.activeDownloads.get(downloadItem.id);

        if (downloadInfo?.requestedFilename) {
            suggest({
                filename: downloadInfo.requestedFilename,
                conflictAction: 'uniquify'
            });
        } else if (downloadInfo && downloadInfo.settings.customPath) {
            suggest({
                filename: downloadInfo.settings.customPath + '/' + downloadItem.filename,
                conflictAction: 'uniquify'
            });
        } else {
            suggest();
        }
    }

    generateFilename(imageData, format) {
        const timestamp = this.formatLocalTimestamp();
        return this.buildSingleFilename(timestamp, imageData.url, imageData.originalFilename);
    }

    formatLocalTimestamp(date = new Date()) {
        return formatLocalTimestampHelper(date);
    }

    buildSingleFilename(timestamp, url, originalFilename) {
        return buildSingleFilenameHelper(timestamp, url, originalFilename);
    }

    buildIndexedFilename(sequence, timestamp, url, originalFilename) {
        return buildIndexedFilenameHelper(sequence, timestamp, url, originalFilename);
    }

    resolveImageExtension(url, originalFilename) {
        return resolveImageExtensionHelper(url, originalFilename);
    }

    extractExtensionFromPath(pathValue) {
        return extractExtensionFromPathHelper(pathValue);
    }

    generateFolderPath(imageData, settings) {
        return generateFolderPathHelper(imageData, settings);
    }

    extractDomainFromUrl(url) {
        return extractDomainFromUrlHelper(url);
    }

    getHighQualityUrl(url) {
        if (url.includes('pinimg.com')) {
            const highQualityUrl = getHighQualityUrlHelper(url);
            console.log('Original URL:', url);
            console.log('High Quality URL:', highQualityUrl);
            return highQualityUrl;
        }
        return url;
    }

    isPinterestUrl(url) {
        return isPinterestPageUrl(url);
    }

    isPinterestImageUrl(url) {
        return url.includes('pinimg.com') || url.includes('pinterest.com');
    }

    extractTitleFromUrl(url) {
        // Try to extract meaningful title from URL
        const urlParts = url.split('/');
        const filename = urlParts[urlParts.length - 1];
        return filename.split('.')[0].replace(/[_\-]/g, ' ');
    }

    extractFilenameFromUrl(url) {
        return extractFilenameFromUrlHelper(url);
    }

    getDownloadStats() {
        const active = Array.from(this.activeDownloads.values());

        return {
            activeDownloads: active.length,
            completedDownloads: active.filter(d => d.status === 'complete').length,
            failedDownloads: active.filter(d => d.error).length,
            totalDataTransferred: active.reduce((sum, d) => sum + (d.bytesReceived || 0), 0)
        };
    }
}

// Initialize background script
new PinVaultProBackground();






