// Background script for PinPinto Extension
import { PINTEREST_MATCH_PATTERNS, isPinterestUrl as isPinterestPageUrl } from './shared/pinterest';
import { BatchCoordinator, type TrackedDownloadInfo } from './background/batch-coordinator';
import { createBlobJobHost } from './background/blob-host';
import type { BlobJobHost } from './background/blob-runner';
import { OFFSCREEN_MESSAGE_TARGET } from './background/offscreen-protocol';
import { SingleDownloadRegistry } from './background/single-download-registry';
import { cleanupOrphanSingleBlobJobs } from './background/batch-recovery';
import { rememberBounded } from './background/early-terminal-buffer';
import {
    SingleImageDownloadService,
    type SingleImageDownloadResult
} from './background/single-image-download';
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
    maxConcurrentDownloads: number;
    blobHost: BlobJobHost;
    batchCoordinator: BatchCoordinator;
    singleDownloads: SingleDownloadRegistry;
    singleImageDownloads: SingleImageDownloadService;
    externalDownloadIds: Map<number, true>;
    requestedFilenameByUrl: Map<string, string>;

    constructor() {
        this.activeDownloads = new Map();
        this.maxConcurrentDownloads = 3;
        this.externalDownloadIds = new Map();
        this.requestedFilenameByUrl = new Map();
        const blobHost = createBlobJobHost();
        this.blobHost = blobHost;
        this.singleDownloads = new SingleDownloadRegistry({
            notify: async (record, state, error) => {
                if (record.targetTabId === null || !record.imageId) return;
                await chrome.tabs.sendMessage(record.targetTabId, {
                    action: 'settleSingleDownload',
                    imageId: record.imageId,
                    state,
                    error
                });
            },
            onRemoved: async (record) => {
                this.activeDownloads.delete(record.downloadId);
                if (record.blobLeaseJobId) {
                    await blobHost.release(record.blobLeaseJobId).catch(() => {});
                }
            }
        });
        this.batchCoordinator = new BatchCoordinator({
            blobHost,
            activeDownloads: this.activeDownloads,
            maxConcurrentDownloads: this.maxConcurrentDownloads,
            normalizeImageUrlForDeduplication: (image, settings) => this.normalizeImageUrlForDeduplication(image, settings),
            getDownloadCandidateUrls: (rawUrl, highQualityEnabled) => this.getDownloadCandidateUrls(rawUrl, highQualityEnabled),
            buildIndexedFilename: (sequence, timestamp, url, originalFilename) => this.buildIndexedFilename(sequence, timestamp, url, originalFilename),
            extractFilenameFromUrl: (url) => this.extractFilenameFromUrl(url),
            formatLocalTimestamp: () => this.formatLocalTimestamp(),
            rememberRequestedFilename: (url, filename) => this.rememberRequestedFilename(url, filename),
            broadcast: (message) => this.sendMessageToAllExtensionPages(message)
        });
        this.singleImageDownloads = new SingleImageDownloadService({
            blobHost,
            registerBrowserDownload: async (registration) => {
                this.activeDownloads.set(registration.downloadId, {
                    imageData: registration.imageData,
                    settings: registration.settings,
                    startTime: Date.now(),
                    status: 'downloading',
                    isBatch: false,
                    blobLeaseJobId: registration.blobLeaseJobId,
                    targetTabId: registration.targetTabId,
                    imageId: registration.imageId,
                    requestedFilename: registration.requestedFilename
                });
                await this.singleDownloads.register({
                    downloadId: registration.downloadId,
                    targetTabId: registration.targetTabId,
                    imageId: registration.imageId,
                    requestedFilename: registration.requestedFilename,
                    blobLeaseJobId: registration.blobLeaseJobId
                });
            },
            removeTrackedDownload: (downloadId) => {
                this.activeDownloads.delete(downloadId);
            },
            rememberRequestedFilename: (url, filename) => this.rememberRequestedFilename(url, filename)
        });
        void this.cleanupOrphanSingleDownloads().catch((error) => {
            console.warn('Failed to reconcile single-image Blob jobs:', error);
        });

        this.init();
    }

    private async cleanupOrphanSingleDownloads(): Promise<void> {
        const activeSingleRecords = await this.singleDownloads.getRecords();
        for (const record of activeSingleRecords) {
            this.activeDownloads.set(record.downloadId, {
                imageData: { id: record.imageId ?? undefined, url: 'restored-single' }, settings: {},
                startTime: record.createdAt, status: 'downloading', isBatch: false,
                blobLeaseJobId: record.blobLeaseJobId, targetTabId: record.targetTabId,
                imageId: record.imageId, requestedFilename: record.requestedFilename
            });
        }
        const activeLeaseJobIds = activeSingleRecords
            .map((record) => record.blobLeaseJobId)
            .filter((jobId): jobId is string => typeof jobId === 'string' && jobId.length > 0);
        await cleanupOrphanSingleBlobJobs(this.blobHost, activeLeaseJobIds);
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
            if (request?.target === OFFSCREEN_MESSAGE_TARGET) return false;
            this.handleMessage(request, sender, sendResponse);
            return true; // Keep channel open for async response
        });

        // Tab updates
        chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
            this.handleTabUpdate(tabId, changeInfo, tab);
        });
        chrome.tabs.onRemoved.addListener((tabId) => {
            void this.batchCoordinator.handleTargetTabClosed(tabId);
            void this.singleDownloads.removeForTab(tabId);
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
                downloadAsZip: true,
                singleImageDownloadMethod: 'browser',
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
            if (typeof __PINPINTO_E2E__ !== 'undefined'
                && __PINPINTO_E2E__
                && request.action === 'pinpintoE2EBlobProbe') {
                const jobId = `e2e-probe-${Date.now()}`;
                const urls = (Array.isArray(request.urls) ? request.urls : [request.url])
                    .filter((url): url is string => typeof url === 'string' && url.length > 0);
                await this.blobHost.start({
                    jobId,
                    maxConcurrency: 6,
                    entries: urls.map((url, index) => ({
                        imageId: `e2e-probe-${index + 1}`,
                        sequence: index + 1,
                        sourceUrl: url,
                        candidateUrls: [url],
                        filename: `probe-${index + 1}.svg`
                    }))
                });
                const result = await this.blobHost.result(jobId);
                await this.blobHost.release(jobId);
                sendResponse({ success: true, result });
                return;
            }

            switch (request.action) {
                case 'ping':
                    sendResponse({ status: 'ready', timestamp: Date.now() });
                    break;

                case 'downloadImage': {
                    const result = await this.downloadSingleImage(
                        request.imageData,
                        request.settings,
                        sender.tab?.id,
                        request.imageData?.id
                    );
                    if (result.success && result.method === 'external') {
                        await this.singleDownloads.ignoreUntrackedDownload(result.downloadId);
                        rememberBounded(this.externalDownloadIds, result.downloadId, true);
                        const { downloadId: _downloadId, ...response } = result;
                        sendResponse(response);
                    } else {
                        sendResponse(result);
                    }
                    break;
                }

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

                case 'stopAutoBatchAfterCurrent':
                    sendResponse({
                        success: await this.batchCoordinator.stopAutoBatchAfterCurrent(
                            request.jobId,
                            request.continueAutoScroll === true
                        )
                    });
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

    async downloadSingleImage(imageData, settings, targetTabId = null, imageId = null): Promise<SingleImageDownloadResult> {
        return this.singleImageDownloads.start({ imageData, settings, targetTabId, imageId });
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

    handleDownloadChange(downloadDelta) {
        const downloadId = downloadDelta.id;
        const downloadInfo = this.activeDownloads.get(downloadId);
        const state = downloadDelta.state?.current;

        if (
            (state === 'complete' || state === 'interrupted')
            && this.externalDownloadIds.delete(downloadId)
        ) {
            return;
        }

        const batchHandled = this.batchCoordinator.handleDownloadChange(downloadDelta, downloadInfo);
        if (state !== 'complete' && state !== 'interrupted') return;
        if (!batchHandled && !downloadInfo?.isBatch) {
            void this.singleDownloads.handleTerminal(
                downloadId,
                state,
                downloadDelta.error?.current || (state === 'interrupted' ? 'Download interrupted' : undefined)
            );
        }
    }

    handleDownloadFilename(downloadItem, suggest) {
        // Allow custom filename logic if needed
        const downloadInfo = this.activeDownloads.get(downloadItem.id);
        const pendingFilename = this.takeRequestedFilename(downloadItem.url);

        if (downloadInfo?.requestedFilename) {
            suggest({
                filename: downloadInfo.requestedFilename,
                conflictAction: 'uniquify'
            });
        } else if (pendingFilename) {
            suggest({
                filename: pendingFilename,
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

    rememberRequestedFilename(url, filename) {
        if (typeof url === 'string' && url && typeof filename === 'string' && filename) {
            this.requestedFilenameByUrl.set(url, filename);
        }
    }

    takeRequestedFilename(url) {
        if (typeof url === 'string' && this.requestedFilenameByUrl.has(url)) {
            const filename = this.requestedFilenameByUrl.get(url);
            this.requestedFilenameByUrl.delete(url);
            return filename;
        }
        const first = this.requestedFilenameByUrl.entries().next().value;
        if (!first) return undefined;
        this.requestedFilenameByUrl.delete(first[0]);
        return first[1];
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






