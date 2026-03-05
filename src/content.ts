// Content script for PinPinto Extension
console.log('PinPinto content script: Starting to load...');

import { createOverlayControls as createImageOverlayControls } from './content/overlay-controls';
import { PINPINTO_CONTENT_STYLE_ID, PINPINTO_CONTENT_STYLE_TEXT } from './content/styles';

export { };

// Prevent multiple instances
if (window.pinVaultContentLoaded) {
    console.log('PinPinto content script already loaded, skipping...');
} else {
    window.pinVaultContentLoaded = true;
    console.log('PinPinto content script loading for first time...');

    class PinVaultContent {
        selectedImages: Set<string>;
        imageElements: Map<string, any>;
        isAutoScrolling: boolean;
        scrollInterval: number | null;
        scanInterval: number | null;
        observer: MutationObserver | null;
        lastScrollHeight: number;
        scrollAttempts: number;
        maxScrollAttempts: number;
        scanTimeout?: number;
        contextMenuImage?: HTMLImageElement | null;

        constructor() {
            this.selectedImages = new Set();
            this.imageElements = new Map();
            this.isAutoScrolling = false;
            this.scrollInterval = null;
            this.scanInterval = null;
            this.observer = null;
            this.lastScrollHeight = 0;
            this.scrollAttempts = 0;
            this.maxScrollAttempts = 5;

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
                            const selectedIds = Array.from(this.selectedImages);
                            console.log(`Content script image counts: ${this.imageElements.size} total, ${selectedIds.length} selected`);
                            sendResponse({
                                total: this.imageElements.size,
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

                        case 'getSelectedImages':
                            const images = this.getSelectedImagesData(request.settings);
                            console.log(`Content script getSelectedImages: returning ${images.length} image data objects`);
                            sendResponse({ images });
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
            const beforeCount = this.imageElements.size;

            // Pinterest uses various selectors for images
            const selectors = [
                'img[src*="pinimg.com"]',
                'img[data-src*="pinimg.com"]',
                'img[srcset*="pinimg.com"]',
                'picture source[srcset*="pinimg.com"]',
                '[data-test-id="pin"] img',
                '[data-test-id="visual-search-pin"] img',
                '.GrowthUnauthPin img',
                '.Pin img',
                '.pinWrapper img'
            ];

            selectors.forEach(selector => {
                document.querySelectorAll(selector).forEach(el => {
                    const htmlEl = el as HTMLElement;
                    if (htmlEl.tagName.toLowerCase() === 'source') {
                        const img = htmlEl.closest('picture')?.querySelector('img') || htmlEl.closest('div')?.querySelector('img');
                        if (img && !img.dataset.pinvaultProcessed) this.processImage(img as HTMLImageElement);
                    } else if (!htmlEl.dataset.pinvaultProcessed) {
                        this.processImage(htmlEl as HTMLImageElement);
                    }
                });
            });

            // Also scan for any newly loaded images that might not match selectors
            document.querySelectorAll('img').forEach(img => {
                if (this.isValidPinterestImage(img) && !img.dataset.pinvaultProcessed) {
                    this.processImage(img);
                }
            });

            const afterCount = this.imageElements.size;
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

            img.dataset.pinvaultProcessed = 'true';

            // Generate unique ID for the image
            const imageId = this.generateImageId(img);

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
            this.imageElements.set(imageId, {
                element: img,
                container: overlayHost,
                overlay: selectOverlay,
                url: this.getHighQualityUrl(img),
                title: this.extractImageTitle(container),
                board: this.extractBoardName(),
                domain: window.location.hostname,
                originalFilename: this.extractOriginalFilename(img)
            });
        }

        isValidPinterestImage(img: HTMLImageElement) {
            const src = img.src || img.dataset.src || (img as any).srcset || '';

            // Check if it's a Pinterest image
            if (!src.includes('pinimg.com')) return false;

            // Skip avatars, icons, and very small images
            const width = img.naturalWidth || img.width || img.clientWidth || 0;
            const height = img.naturalHeight || img.height || img.clientHeight || 0;

            if (width > 0 && width < 100) return false;
            if (height > 0 && height < 100) return false;

            // Skip if it's likely a profile picture or icon
            if (src.includes('/avatars/') || src.includes('/user/')) return false;

            return true;
        }

        generateImageId(img) {
            const src = img.src || img.dataset.src || '';
            const urlParts = src.split('/');
            const filename = urlParts[urlParts.length - 1];
            return filename.split('.')[0] || `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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
            return createImageOverlayControls(imageId, {
                onToggleSelection: () => this.toggleImageSelection(imageId),
                onDownloadSingle: (button) => this.downloadSingleImage(imageId, button)
            });
        }

        async downloadSingleImage(imageId, singleDownloadBtn) {
            const imageData = this.imageElements.get(imageId);
            if (!imageData) {
                return;
            }

            singleDownloadBtn.classList.remove('success', 'error');
            singleDownloadBtn.disabled = true;

            try {
                const settings = await chrome.storage.sync.get({
                    highQuality: true,
                    privacyMode: false
                });

                const response = await chrome.runtime.sendMessage({
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

                if (response?.success) {
                    singleDownloadBtn.classList.add('success');
                } else {
                    singleDownloadBtn.classList.add('error');
                }
            } catch (error) {
                console.error('PinPinto single image download failed:', error);
                singleDownloadBtn.classList.add('error');
            } finally {
                singleDownloadBtn.disabled = false;
                window.setTimeout(() => {
                    singleDownloadBtn.classList.remove('success', 'error');
                }, 1600);
            }
        }

        getHighQualityUrl(img) {
            let url = img.src || img.dataset.src || '';

            // Convert to highest quality Pinterest URL
            // Pinterest URL pattern: https://i.pinimg.com/564x/...
            // High quality: https://i.pinimg.com/originals/...

            if (url.includes('pinimg.com')) {
                // Replace size parameters with 'originals' for highest quality
                url = url.replace(/\/\d+x\//, '/originals/');
                url = url.replace(/\/\d+x\d+\//, '/originals/');
            }

            return url;
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
            const imageData = this.imageElements.get(imageId);
            if (!imageData) return;

            const overlay = imageData.overlay;
            const checkbox = overlay.querySelector('.pinvault-checkbox');

            if (this.selectedImages.has(imageId)) {
                // Deselect
                this.selectedImages.delete(imageId);
                overlay.classList.remove('selected');
                imageData.container.classList.remove('pinvault-selected');
                imageData.element.setAttribute('data-pinvault-selected', 'false');
                checkbox.textContent = '[ ]';
            } else {
                // Select
                this.selectedImages.add(imageId);
                overlay.classList.add('selected');
                imageData.container.classList.add('pinvault-selected');
                imageData.element.setAttribute('data-pinvault-selected', 'true');
                checkbox.textContent = '[x]';
            }
        }

        selectAllImages() {
            this.imageElements.forEach((imageData, imageId) => {
                if (!this.selectedImages.has(imageId)) {
                    this.selectedImages.add(imageId);
                    imageData.overlay.classList.add('selected');
                    imageData.container.classList.add('pinvault-selected');
                    imageData.element.setAttribute('data-pinvault-selected', 'true');
                    imageData.overlay.querySelector('.pinvault-checkbox').textContent = '[x]';
                }
            });
        }

        deselectAllImages() {
            this.selectedImages.forEach(imageId => {
                const imageData = this.imageElements.get(imageId);
                if (imageData) {
                    imageData.overlay.classList.remove('selected', 'success', 'error');
                    imageData.container.classList.remove('pinvault-selected');
                    imageData.element.setAttribute('data-pinvault-selected', 'false');
                    imageData.overlay.querySelector('.pinvault-checkbox').textContent = '[ ]';
                }
            });
            this.selectedImages.clear();
        }

        startAutoScroll() {
            if (this.isAutoScrolling) return;

            this.isAutoScrolling = true;
            this.lastScrollHeight = document.body.scrollHeight;
            this.scrollAttempts = 0;

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
                                this.stopAutoScroll();
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

        stopAutoScroll() {
            this.isAutoScrolling = false;
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
            const selectedData = [];

            console.log(`Getting selected images data: ${this.selectedImages.size} selected images`);

            this.selectedImages.forEach(imageId => {
                const imageData = this.imageElements.get(imageId);
                if (imageData) {
                    selectedData.push({
                        id: imageId,
                        url: imageData.url,
                        title: imageData.title,
                        board: imageData.board,
                        domain: imageData.domain,
                        originalFilename: imageData.originalFilename
                    });
                } else {
                    console.warn(`No image data found for selected image ID: ${imageId}`);
                }
            });

            console.log(`Returning ${selectedData.length} image data objects`);
            return selectedData;
        }

        markImageStatus(imageId, status, error = null) {
            const imageData = this.imageElements.get(imageId);
            if (!imageData) return;

            const overlay = imageData.overlay;
            const checkbox = overlay.querySelector('.pinvault-checkbox');

            // Remove previous status classes
            overlay.classList.remove('success', 'error');

            switch (status) {
                case 'success':
                    overlay.classList.add('success');
                    checkbox.textContent = 'OK';
                    overlay.title = 'Downloaded successfully';
                    break;
                case 'error':
                    overlay.classList.add('error');
                    checkbox.textContent = 'ERR';
                    overlay.title = `Download failed: ${error || 'Unknown error'}`;
                    break;
            }
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



