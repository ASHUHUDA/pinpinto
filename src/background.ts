// Background script for PinPinto Extension
import { PINTEREST_MATCH_PATTERNS, isPinterestUrl as isPinterestPageUrl } from './shared/pinterest';
import { BatchCoordinator, type TrackedDownloadInfo } from './background/batch-coordinator';
import { buildSingleDownloadPath } from './background/download-path';
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

class PinVaultProBackground {
    activeDownloads: Map<number, TrackedDownloadInfo>;
    downloadQueue: any[];
    isProcessingQueue: boolean;
    maxConcurrentDownloads: number;
    batchCoordinator: BatchCoordinator;

    constructor() {
        this.activeDownloads = new Map();
        this.downloadQueue = [];
        this.isProcessingQueue = false;
        this.maxConcurrentDownloads = 3;
        this.batchCoordinator = new BatchCoordinator({
            activeDownloads: this.activeDownloads,
            maxConcurrentDownloads: this.maxConcurrentDownloads,
            normalizeImageUrlForDeduplication: (image, settings) => this.normalizeImageUrlForDeduplication(image, settings),
            getDownloadCandidateUrls: (rawUrl, highQualityEnabled) => this.getDownloadCandidateUrls(rawUrl, highQualityEnabled),
            buildIndexedFilename: (sequence, timestamp, url, originalFilename) => this.buildIndexedFilename(sequence, timestamp, url, originalFilename),
            extractFilenameFromUrl: (url) => this.extractFilenameFromUrl(url),
            formatLocalTimestamp: () => this.formatLocalTimestamp(),
            broadcast: (message) => this.sendMessageToAllExtensionPages(message)
        });

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
        chrome.tabs.onRemoved.addListener((tabId) => {
            void this.batchCoordinator.handleTargetTabClosed(tabId);
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
                    sendResponse(await this.batchCoordinator.start(request, sender.tab?.id));
                    break;

                case 'getBatchTaskState':
                    const snapshot = await this.batchCoordinator.getSnapshot();
                    sendResponse({
                        snapshot,
                        matchesTargetTab: sender.tab?.id === undefined || snapshot?.targetTabId === sender.tab.id
                    });
                    break;

                case 'autoBatchWindowReady':
                    sendResponse({ accepted: await this.batchCoordinator.acceptAutoBatchWindow(request, sender.tab?.id) });
                    break;

                case 'finishAutoBatchSession':
                    sendResponse({ success: await this.batchCoordinator.finishAutoSession(request.jobId, sender.tab?.id) });
                    break;

                case 'cancelDownload':
                    if (typeof request.downloadId === 'number') {
                        await this.cancelDownload(request.downloadId);
                    } else {
                        // Preserve single-image downloads when legacy callers request a generic cancel.
                        // Batch-stop UI should only terminate the active ZIP job, not unrelated downloads.
                        await this.batchCoordinator.cancel(request.jobId);
                    }
                    sendResponse({ success: true });
                    break;

                case 'cancelCurrentBatch':
                    sendResponse({ success: await this.batchCoordinator.cancel(request.jobId) });
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
            const downloadUrl = settings?.highQuality === false
                ? imageData.url
                : this.getHighQualityUrl(imageData.url);

            const singleTimestamp = this.formatLocalTimestamp();
            const filename = this.buildSingleFilename(
                singleTimestamp,
                downloadUrl,
                imageData.originalFilename
            );
            const requestedFilename = buildSingleDownloadPath(filename);

            const downloadOptions: chrome.downloads.DownloadOptions = {
                url: downloadUrl,
                filename: requestedFilename,
                conflictAction: 'uniquify',
                saveAs: false
            };

            console.log('Download options:', downloadOptions);

            const downloadId = await chrome.downloads.download(downloadOptions);
            console.log('Download started with ID:', downloadId);

            // Track download
            this.activeDownloads.set(downloadId, {
                imageData,
                settings,
                startTime: Date.now(),
                status: 'downloading',
                isBatch: false,
                requestedFilename
            });

            return downloadId;

        } catch (error) {
            console.error('Error downloading image:', error);
            console.error('Image data:', imageData);
            throw error;
        }
    }

    normalizeImageUrlForDeduplication(image, settings) {
        return normalizeImageUrlForDeduplicationHelper(image, settings, (url) => this.getHighQualityUrl(url));
    }

    getDownloadCandidateUrls(rawUrl, highQualityEnabled) {
        return getDownloadCandidateUrlsHelper(rawUrl, highQualityEnabled, (url) => this.getHighQualityUrl(url));
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
        await this.batchCoordinator.cancel();
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

        this.batchCoordinator.handleDownloadChange(downloadDelta, downloadInfo);
        if (!downloadInfo) return;

        // Update download status
        if (downloadDelta.state) {
            downloadInfo.status = downloadDelta.state.current;

            if (downloadDelta.state.current === 'complete') {
                downloadInfo.endTime = Date.now();
                downloadInfo.duration = downloadInfo.endTime - downloadInfo.startTime;

                // Show completion log for single downloads
                if (!downloadInfo.isBatch) {
                    console.log('Download Complete:', typeof downloadInfo.imageData === 'string' ? downloadInfo.imageData : downloadInfo.imageData.title);
                }

                // Clean up
                setTimeout(() => {
                    this.activeDownloads.delete(downloadId);
                }, 30000); // Keep for 30 seconds for stats

            } else if (downloadDelta.state.current === 'interrupted') {
                downloadInfo.error = downloadDelta.error || 'Download interrupted';

                // Show error log
                console.log('Download Failed:', typeof downloadInfo.imageData === 'string' ? downloadInfo.imageData : downloadInfo.imageData.title);

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






