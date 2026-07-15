// Content script for PinPinto Extension
console.log('PinPinto content script: Starting to load...');

import { createOverlayControls as createImageOverlayControls } from './content/overlay-controls';
import { AutoBatchSessionController, restoreAutoBatchSession } from './content/auto-batch-session';
import { classifyPinterestImage } from './content/image-classifier';
import {
    getHighQualityImageUrl,
    getOriginalImageUrl,
    isValidPinterestImage,
    scanPinterestImages
} from './content/image-scanner';
import { ContentSessionStore } from './content/session-store';
import { SingleDownloadController, type SingleDownloadSettlement } from './content/single-download-state';
import { PINPINTO_CONTENT_STYLE_ID, PINPINTO_CONTENT_STYLE_TEXT } from './content/styles';

export { };

// Prevent multiple instances
if (window.pinVaultContentLoaded) {
    console.log('PinPinto content script already loaded, skipping...');
} else {
    window.pinVaultContentLoaded = true;
    console.log('PinPinto content script loading for first time...');

    class PinVaultContent {
        session: ContentSessionStore;
        isAutoScrolling: boolean;
        scrollInterval: number | null;
        scanInterval: number | null;
        observer: MutationObserver | null;
        lastScrollHeight: number;
        scrollAttempts: number;
        maxScrollAttempts: number;
        autoScrollStopReason: 'manual' | 'exhausted' | null;
        autoScrollStoppedAt: number | null;
        scanTimeout?: number;
        contextMenuImage?: HTMLImageElement | null;
        autoBatchSession: AutoBatchSessionController;
        singleDownloads: SingleDownloadController;

        constructor() {
            this.session = new ContentSessionStore();
            this.isAutoScrolling = false;
            this.scrollInterval = null;
            this.scanInterval = null;
            this.observer = null;
            this.lastScrollHeight = 0;
            this.scrollAttempts = 0;
            this.maxScrollAttempts = 5;
            this.autoScrollStopReason = null;
            this.autoScrollStoppedAt = null;
            this.singleDownloads = new SingleDownloadController();
            this.autoBatchSession = new AutoBatchSessionController({
                scanForImages: () => this.scanForImages(),
                getTotalImages: () => this.session.imageOrder.length,
                getImagesInRange: (startIndex, endIndex) => this.getImagesInRange(startIndex, endIndex),
                getViewportAnchorIndex: () => this.getViewportAnchorIndex(),
                discardImagesBeforeIndex: (startIndex) => this.discardImagesBeforeIndex(startIndex),
                prepareAutoBatchSession: (startIndex) => this.session.prepareAutoBatchSession(startIndex),
                getAutoEligibleWindow: (cursor, limit, exhausted) => (
                    this.session.getAutoEligibleWindow(cursor, limit, exhausted, window.location.href)
                ),
                commitAutoBatchWindow: (input) => this.session.commitAutoBatchWindow(input),
                startAutoScroll: () => this.startAutoScroll(),
                stopAutoScroll: () => this.stopAutoScroll('manual'),
                getAutoScrollStopReason: () => this.autoScrollStopReason,
                sendMessage: (message) => chrome.runtime.sendMessage(message)
            });

            // Make sure we're available on window immediately
            window.pinVaultContent = this;

            this.init();
        }

        init() {
            console.log('PinPinto content script initializing...');
            try {
                this.injectStyles();
                this.setupMessageListener();
                this.scanForImages();
                this.setupMutationObserver();
                this.setupContextMenu();
                void restoreAutoBatchSession(this.autoBatchSession);
                console.log('PinPinto content script initialized successfully');
            } catch (error) {
                console.error('PinPinto content script initialization error:', error);
            }
        }

        injectStyles() {
            if (document.getElementById(PINPINTO_CONTENT_STYLE_ID)) return;

            const style = document.createElement('style');
            style.id = PINPINTO_CONTENT_STYLE_ID;
            style.textContent = PINPINTO_CONTENT_STYLE_TEXT;
            document.head.appendChild(style);
        }

        setupMessageListener() {
            console.log('PinPinto: Setting up message listener...');
            chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
                console.log('PinPinto: Received message:', request);
                try {
                    switch (request.action) {
                        case 'ping':
                            sendResponse({ status: 'ready' });
                            break;

                        case 'getImageCounts':
                            // Rescan before returning counts to ensure we have latest data
                            this.scanForImages();
                            const selectedIds = Array.from(this.session.selectedImages);
                            console.log(`Content script image counts: ${this.session.imageElements.size} total, ${selectedIds.length} selected`);
                            sendResponse({
                                total: this.session.imageElements.size,
                                selected: selectedIds
                            });
                            break;

                        case 'selectAllImages':
                            this.selectAllImages();
                            sendResponse({ success: true });
                            break;

                        case 'deselectAllImages':
                            this.deselectAllImages();
                            sendResponse({ success: true });
                            break;

                        case 'startAutoScroll':
                            this.startAutoScroll();
                            sendResponse({ success: true });
                            break;

                        case 'stopAutoScroll':
                            this.stopAutoScroll();
                            sendResponse({ success: true });
                            break;

                        case 'startAutoBatchSession':
                            void this.autoBatchSession.start({
                                jobId: request.jobId,
                                limit: request.limit,
                                settings: request.settings || {}
                            }).then(() => sendResponse({ success: true }));
                            break;

                        case 'resumeAutoBatchSession':
                            void this.autoBatchSession.resume({
                                jobId: request.jobId,
                                nextCursor: request.nextCursor,
                                limit: request.limit,
                                settings: request.settings || {}
                            }).then(() => sendResponse({ success: true }));
                            break;

                        case 'finishAutoBatchSession':
                            this.autoBatchSession.finish(request.jobId);
                            sendResponse({ success: true });
                            break;

                        case 'cancelAutoBatchSession':
                            this.autoBatchSession.cancel(request.jobId);
                            sendResponse({ success: true });
                            break;

                        case 'getAutoScrollStatus':
                            sendResponse({
                                isAutoScrolling: this.isAutoScrolling,
                                stopReason: this.autoScrollStopReason,
                                stoppedAt: this.autoScrollStoppedAt,
                                scrollAttempts: this.scrollAttempts,
                                maxScrollAttempts: this.maxScrollAttempts
                            });
                            break;

                        case 'getSelectedImages':
                            const images = this.getSelectedImagesData(request.settings);
                            console.log(`Content script getSelectedImages: returning ${images.length} image data objects`);
                            sendResponse({ images });
                            break;

                        case 'getImagesInRange':
                            sendResponse({
                                images: this.getImagesInRange(request.startIndex, request.endIndex)
                            });
                            break;

                        case 'getViewportAnchor':
                            sendResponse({
                                anchorIndex: this.getViewportAnchorIndex()
                            });
                            break;

                        case 'discardImagesBeforeIndex':
                            sendResponse({
                                success: true,
                                ...this.discardImagesBeforeIndex(request.startIndex)
                            });
                            break;

                        case 'commitAutoBatchWindow':
                            sendResponse(this.autoBatchSession.commitWindow({
                                jobId: request.jobId,
                                startOffset: request.startOffset,
                                endOffset: request.endOffset
                            }));
                            break;

                        case 'settleSingleDownload':
                            sendResponse(this.settleSingleDownload(
                                request.imageId,
                                { state: request.state, error: request.error }
                            ));
                            break;

                        case 'clearAllImages':
                            this.clearAllImages();
                            sendResponse({ success: true });
                            break;

                        case 'markImageStatus':
                            this.markImageStatus(request.imageId, request.status, request.error);
                            sendResponse({ success: true });
                            break;

                        default:
                            sendResponse({ error: 'Unknown action' });
                    }
                } catch (error) {
                    console.error('Error handling message:', error);
                    sendResponse({ error: error.message });
                }

                return true; // Keep message channel open for async response
            });
        }

        scanForImages() {
            console.log('PinPinto: Scanning for images...');
            const beforeCount = this.session.imageElements.size;
            scanPinterestImages(document, (image) => this.processImage(image));

            const afterCount = this.session.imageElements.size;
            const newImages = afterCount - beforeCount;

            if (newImages > 0) {
                console.log(`PinPinto: Found ${newImages} new images. Total: ${afterCount}`);
            }

            // Dispatch custom event to notify about image count update
            window.dispatchEvent(new CustomEvent('pinvaultImagesUpdated', {
                detail: { total: afterCount, new: newImages }
            }));
        }

        processImage(img: HTMLImageElement) {
            // Skip if already processed or not a valid Pinterest image
            if (img.dataset.pinvaultProcessed || !this.isValidPinterestImage(img)) {
                return;
            }

            const sourceKey = this.getImageSourceKey(img);
            if (this.session.isIgnoredSource(sourceKey)) {
                img.dataset.pinvaultProcessed = 'ignored';
                return;
            }

            img.dataset.pinvaultProcessed = 'true';

            // Generate unique ID for the image
            const imageId = this.session.createImageId(img);

            // Find the container element
            const container = this.findImageContainer(img);
            if (!container) return;
            const overlayHost = this.findOverlayHost(container);
            if (!overlayHost) return;

            // Make container relative positioned
            if (getComputedStyle(overlayHost).position === 'static') {
                overlayHost.style.position = 'relative';
            }
            overlayHost.classList.add('pinvault-image-container');

            // Create overlay
            const { controls, selectOverlay } = this.createOverlayControls(imageId);
            overlayHost.appendChild(controls);

            // Store image data
            this.session.addImage({
                id: imageId,
                element: img,
                container: overlayHost,
                controls,
                overlay: selectOverlay,
                url: this.getOriginalImageUrl(img),
                title: this.extractImageTitle(container),
                board: this.extractBoardName(),
                domain: window.location.hostname,
                originalFilename: this.extractOriginalFilename(img),
                sourceKey,
                source: classifyPinterestImage(window.location.href, img)
            });
        }

        isValidPinterestImage(img: HTMLImageElement) {
            return isValidPinterestImage(img);
        }

        getImageSourceKey(img: HTMLImageElement) {
            return this.getHighQualityUrl(img);
        }

        findImageContainer(img: HTMLElement) {
            let container = img.parentElement;

            // Look for common Pinterest container classes
            const containerSelectors = [
                '[data-test-id="pin"]',
                '[data-test-id="visual-search-pin"]',
                '.GrowthUnauthPin',
                '.Pin',
                '.pinWrapper'
            ];

            // Traverse up to find a suitable container
            for (let i = 0; i < 6 && container; i++) {
                if (containerSelectors.some(selector => container?.matches && container.matches(selector))) {
                    return container;
                }
                container = container.parentElement;
            }

            // Fallback to checking bounding sizes
            container = img.parentElement;
            for (let i = 0; i < 4 && container; i++) {
                if (container.clientWidth > 100 && container.clientHeight > 100) {
                    return container;
                }
                container = container.parentElement;
            }

            // Fallback to direct parent
            return img.parentElement;
        }

        findOverlayHost(container: HTMLElement) {
            // 首页卡片常见结构是 <a> 包裹图片，若把按钮插在 <a> 内会触发跳转。
            // 这里强制把覆盖层挂到链接外层，避免点击单图按钮时被页面导航事件抢占。
            const linkAncestor = container.closest('a[href]');
            if (linkAncestor?.parentElement) {
                return linkAncestor.parentElement as HTMLElement;
            }

            return container;
        }

        createOverlayControls(imageId) {
            const controls = createImageOverlayControls(imageId, {
                onToggleSelection: () => this.toggleImageSelection(imageId),
                onDownloadSingle: (button) => this.downloadSingleImage(imageId, button)
            });
            const button = controls.controls.querySelector('.pinvault-single-download-btn');
            if (button instanceof HTMLButtonElement) this.singleDownloads.register(imageId, button);
            return controls;
        }

        async downloadSingleImage(imageId: string, singleDownloadBtn: HTMLButtonElement) {
            const imageData = this.session.imageElements.get(imageId);
            if (!imageData) return;
            await this.singleDownloads.start(imageId, singleDownloadBtn, async () => {
                const settings = await chrome.storage.sync.get({
                    highQuality: true
                });
                return chrome.runtime.sendMessage({
                    action: 'downloadImage',
                    imageData: {
                        id: imageId,
                        url: imageData.url,
                        title: imageData.title,
                        board: imageData.board,
                        domain: imageData.domain,
                        originalFilename: imageData.originalFilename
                    },
                    settings
                });
            });
        }

        getHighQualityUrl(img) {
            return getHighQualityImageUrl(img);
        }

        getOriginalImageUrl(img: HTMLImageElement) {
            return getOriginalImageUrl(img);
        }

        extractImageTitle(container) {
            // Try various selectors for Pinterest pin titles
            const titleSelectors = [
                '[data-test-id="pin-title"]',
                '.Pin-title',
                '.pinTitle',
                'h3',
                'h2',
                '[role="button"] div',
                'a[href*="/pin/"] div'
            ];

            for (const selector of titleSelectors) {
                const titleElement = container.querySelector(selector);
                if (titleElement && titleElement.textContent.trim()) {
                    return titleElement.textContent.trim();
                }
            }

            return 'Pinterest Image';
        }

        extractBoardName() {
            // Try to extract board name from URL or page
            const url = window.location.href;
            const boardMatch = url.match(/\/([^\/]+)\/([^\/]+)\//);

            if (boardMatch && boardMatch[2]) {
                return boardMatch[2];
            }

            // Try to find board name in page
            const boardElement = document.querySelector('[data-test-id="board-name"], .boardName, .Board-name');
            if (boardElement) {
                return boardElement.textContent.trim();
            }

            return 'Pinterest';
        }

        extractOriginalFilename(img) {
            const url = img.src || img.dataset.src || '';
            const urlParts = url.split('/');
            return urlParts[urlParts.length - 1] || 'image.jpg';
        }

        toggleImageSelection(imageId) {
            this.session.toggleImageSelection(imageId);
        }

        selectAllImages() {
            this.session.selectAllImages();
        }

        deselectAllImages() {
            this.session.deselectAllImages();
        }

        clearAllImages() {
            this.autoBatchSession.reset();
            this.singleDownloads.clear();
            this.session.clearAllImages();

            window.dispatchEvent(new CustomEvent('pinvaultImagesUpdated', {
                detail: { total: 0, new: 0 }
            }));
        }

        startAutoScroll() {
            if (this.isAutoScrolling) return;

            this.isAutoScrolling = true;
            this.lastScrollHeight = document.body.scrollHeight;
            this.scrollAttempts = 0;
            this.autoScrollStopReason = null;
            this.autoScrollStoppedAt = null;

            // Show scroll indicator
            this.showScrollIndicator();

            // Start scanning for images more frequently during auto-scroll
            this.scanInterval = setInterval(() => {
                if (this.isAutoScrolling) {
                    this.scanForImages();
                }
            }, 2000);

            this.scrollInterval = setInterval(() => {
                if (!this.isAutoScrolling) return;

                const currentScrollHeight = document.body.scrollHeight;
                const scrollY = window.scrollY;
                const windowHeight = window.innerHeight;

                // Check if we're at the bottom
                if (scrollY + windowHeight >= currentScrollHeight - 100) {
                    // Scroll down to load more content
                    window.scrollBy(0, 500);

                    // Check if new content was loaded
                    setTimeout(() => {
                        const newScrollHeight = document.body.scrollHeight;
                        if (newScrollHeight === this.lastScrollHeight) {
                            this.scrollAttempts++;
                            if (this.scrollAttempts >= this.maxScrollAttempts) {
                                this.stopAutoScroll('exhausted');
                                return;
                            }
                        } else {
                            this.scrollAttempts = 0;
                            this.lastScrollHeight = newScrollHeight;
                            // Scan for new images immediately when new content loads
                            setTimeout(() => this.scanForImages(), 500);
                        }
                    }, 1500);
                } else {
                    // Continue scrolling
                    window.scrollBy(0, 300);
                    // Scan for images after each scroll
                    setTimeout(() => this.scanForImages(), 500);
                }
            }, 2500);
        }

        stopAutoScroll(reason: 'manual' | 'exhausted' = 'manual') {
            this.isAutoScrolling = false;
            this.autoScrollStopReason = reason;
            this.autoScrollStoppedAt = Date.now();
            if (this.scrollInterval) {
                clearInterval(this.scrollInterval);
                this.scrollInterval = null;
            }
            if (this.scanInterval) {
                clearInterval(this.scanInterval);
                this.scanInterval = null;
            }
            this.hideScrollIndicator();

            // Do a final scan when stopping
            setTimeout(() => this.scanForImages(), 500);
        }

        showScrollIndicator() {
            const existing = document.getElementById('pinvault-scroll-indicator');
            if (existing) existing.remove();

            const indicator = document.createElement('div');
            indicator.id = 'pinvault-scroll-indicator';
            indicator.className = 'pinvault-scroll-indicator';
            indicator.textContent = 'Auto scroll running...';
            document.body.appendChild(indicator);
        }

        hideScrollIndicator() {
            const indicator = document.getElementById('pinvault-scroll-indicator');
            if (indicator) {
                indicator.remove();
            }
        }

        setupMutationObserver() {
            // Watch for dynamically loaded content
            this.observer = new MutationObserver((mutations) => {
                let hasNewImages = false;

                mutations.forEach((mutation) => {
                    mutation.addedNodes.forEach((node) => {
                        if (node.nodeType === Node.ELEMENT_NODE) {
                            const el = node as Element;
                            // Check if the node contains images
                            const images = el.querySelectorAll ? el.querySelectorAll('img') : [];
                            if (images.length > 0 || (el.tagName === 'IMG')) {
                                hasNewImages = true;
                            }
                        }
                    });
                });

                if (hasNewImages) {
                    // Debounce the scan
                    clearTimeout(this.scanTimeout);
                    this.scanTimeout = setTimeout(() => {
                        this.scanForImages();
                    }, 500);
                }
            });

            this.observer.observe(document.body, {
                childList: true,
                subtree: true
            });
        }

        setupContextMenu() {
            // Add right-click context menu for individual image downloads
            document.addEventListener('contextmenu', (e) => {
                const target = e.target as HTMLElement;
                const img = target.closest('img');
                if (img && this.isValidPinterestImage(img)) {
                    // Store reference for context menu action
                    this.contextMenuImage = img;
                }
            });
        }

        getSelectedImagesData(settings) {
            const selectedData = this.session.getSelectedImagesData();
            console.log(`Getting selected images data: ${this.session.selectedImages.size} selected images`);
            console.log(`Returning ${selectedData.length} image data objects`);
            return selectedData;
        }

        getImagesInRange(startIndex = 0, endIndex = this.session.imageOrder.length) {
            this.scanForImages();
            return this.session.getImagesInRange(startIndex, endIndex);
        }

        getViewportAnchorIndex() {
            this.scanForImages();
            return this.session.getViewportAnchorIndex();
        }

        discardImagesBeforeIndex(startIndex = 0) {
            return this.session.discardImagesBeforeIndex(startIndex);
        }

        markImageStatus(imageId, status, error = null) {
            this.session.markImageStatus(imageId, status, error);
        }

        settleSingleDownload(imageId: string, settlement: SingleDownloadSettlement) {
            if (typeof imageId !== 'string' || !imageId) {
                return { success: false, removed: false, error: 'Missing imageId.' };
            }
            if (!['complete', 'rejected', 'interrupted'].includes(settlement.state)) {
                return { success: false, removed: false, error: 'Invalid settlement state.' };
            }
            const state = this.singleDownloads.settle(imageId, settlement);
            const removed = settlement.state === 'complete'
                ? this.session.removeDownloadedImage(imageId)
                : false;
            if (removed) {
                this.singleDownloads.remove(imageId);
                window.dispatchEvent(new CustomEvent('pinvaultImagesUpdated', {
                    detail: { total: this.session.imageElements.size, new: 0 }
                }));
            }
            return {
                success: settlement.state === 'complete' || state !== null,
                removed,
                imageId
            };
        }
    }

    // Initialize content script when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            window.pinVaultContent = new PinVaultContent();
        });
    } else {
        window.pinVaultContent = new PinVaultContent();
    }

} // End of prevention check



