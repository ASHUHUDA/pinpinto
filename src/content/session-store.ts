import { findViewportAnchorIndex, sliceOrderedItems, splitOrderedIdsAtIndex } from './session-helpers';

type ImageSessionRecord = {
    id: string;
    element: HTMLImageElement;
    container: HTMLElement;
    controls: HTMLElement;
    overlay: HTMLElement;
    url: string;
    title: string;
    board: string;
    domain: string;
    originalFilename?: string;
    sourceKey: string;
};

export class ContentSessionStore {
    selectedImages = new Set<string>();
    imageElements = new Map<string, ImageSessionRecord>();
    imageOrder: string[] = [];
    ignoredImageSources = new Set<string>();
    nextImageOrdinal = 1;

    createImageId(img: HTMLImageElement) {
        const src = img.src || img.dataset.src || '';
        const urlParts = src.split('/');
        const filename = urlParts[urlParts.length - 1];
        const baseName = filename.split('.')[0] || 'img';
        const safeBaseName = baseName.replace(/[^a-z0-9_-]/gi, '_').slice(0, 24) || 'img';
        const imageId = `img_${String(this.nextImageOrdinal).padStart(6, '0')}_${safeBaseName}`;
        this.nextImageOrdinal += 1;
        return imageId;
    }

    isIgnoredSource(sourceKey: string) {
        return this.ignoredImageSources.has(sourceKey);
    }

    addImage(imageData: ImageSessionRecord) {
        this.imageElements.set(imageData.id, imageData);
        this.imageOrder.push(imageData.id);
    }

    toggleImageSelection(imageId: string) {
        const imageData = this.imageElements.get(imageId);
        if (!imageData) return;

        const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
        if (!(checkbox instanceof HTMLElement)) return;

        if (this.selectedImages.has(imageId)) {
            this.selectedImages.delete(imageId);
            imageData.overlay.classList.remove('selected');
            imageData.container.classList.remove('pinvault-selected');
            imageData.element.setAttribute('data-pinvault-selected', 'false');
            checkbox.textContent = '[ ]';
        } else {
            this.selectedImages.add(imageId);
            imageData.overlay.classList.add('selected');
            imageData.container.classList.add('pinvault-selected');
            imageData.element.setAttribute('data-pinvault-selected', 'true');
            checkbox.textContent = '[x]';
        }
    }

    selectAllImages() {
        this.imageElements.forEach((imageData, imageId) => {
            if (this.selectedImages.has(imageId)) return;
            const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
            if (!(checkbox instanceof HTMLElement)) return;

            this.selectedImages.add(imageId);
            imageData.overlay.classList.add('selected');
            imageData.container.classList.add('pinvault-selected');
            imageData.element.setAttribute('data-pinvault-selected', 'true');
            checkbox.textContent = '[x]';
        });
    }

    deselectAllImages() {
        this.selectedImages.forEach((imageId) => {
            const imageData = this.imageElements.get(imageId);
            if (!imageData) return;

            const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
            imageData.overlay.classList.remove('selected', 'success', 'error');
            imageData.container.classList.remove('pinvault-selected');
            imageData.element.setAttribute('data-pinvault-selected', 'false');
            if (checkbox instanceof HTMLElement) {
                checkbox.textContent = '[ ]';
            }
        });

        this.selectedImages.clear();
    }

    clearAllImages() {
        const currentImageIds = [...this.imageOrder];
        currentImageIds.forEach((imageId) => {
            this.removeImageFromSession(imageId, true);
        });

        this.selectedImages.clear();
        this.imageElements.clear();
        this.imageOrder = [];
    }

    getSelectedImagesData() {
        const selectedData = [];
        this.selectedImages.forEach((imageId) => {
            const imageData = this.imageElements.get(imageId);
            if (imageData) {
                selectedData.push(this.serializeImageData(imageData));
            }
        });
        return selectedData;
    }

    getImagesInRange(startIndex = 0, endIndex = this.imageOrder.length) {
        const orderedImages = this.getOrderedImages();
        return sliceOrderedItems(orderedImages, startIndex, endIndex).map((imageData) => this.serializeImageData(imageData));
    }

    getViewportAnchorIndex() {
        const orderedImages = this.getOrderedImages();
        if (orderedImages.length === 0) {
            return 0;
        }

        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        const candidates = orderedImages.map((imageData) => {
            const rect = imageData.container.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
        });

        return findViewportAnchorIndex(candidates, viewportHeight);
    }

    discardImagesBeforeIndex(startIndex = 0) {
        const orderedIds = this.getOrderedImageIds();
        const { discarded, remaining } = splitOrderedIdsAtIndex(orderedIds, startIndex);

        discarded.forEach((imageId) => {
            this.removeImageFromSession(imageId, true);
        });
        this.imageOrder = remaining;

        return {
            discardedCount: discarded.length,
            remainingCount: remaining.length
        };
    }

    markImageStatus(imageId: string, status: string, error: string | null = null) {
        const imageData = this.imageElements.get(imageId);
        if (!imageData) return;

        const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
        if (!(checkbox instanceof HTMLElement)) return;

        imageData.overlay.classList.remove('success', 'error');
        switch (status) {
            case 'success':
                imageData.overlay.classList.add('success');
                checkbox.textContent = 'OK';
                imageData.overlay.title = 'Downloaded successfully';
                break;
            case 'error':
                imageData.overlay.classList.add('error');
                checkbox.textContent = 'ERR';
                imageData.overlay.title = `Download failed: ${error || 'Unknown error'}`;
                break;
        }
    }

    private getOrderedImageIds() {
        return this.imageOrder.filter((imageId) => this.imageElements.has(imageId));
    }

    private getOrderedImages() {
        return this.getOrderedImageIds()
            .map((imageId) => this.imageElements.get(imageId))
            .filter(Boolean) as ImageSessionRecord[];
    }

    private serializeImageData(imageData: ImageSessionRecord) {
        return {
            id: imageData.id,
            url: imageData.url,
            title: imageData.title,
            board: imageData.board,
            domain: imageData.domain,
            originalFilename: imageData.originalFilename
        };
    }

    private removeImageFromSession(imageId: string, ignoreFutureScans = false) {
        const imageData = this.imageElements.get(imageId);
        if (!imageData) return;

        if (ignoreFutureScans && imageData.sourceKey) {
            this.ignoredImageSources.add(imageData.sourceKey);
        }

        this.selectedImages.delete(imageId);
        imageData.container.classList.remove('pinvault-selected');
        imageData.container.classList.remove('pinvault-image-container');
        imageData.element.setAttribute('data-pinvault-selected', 'false');
        imageData.element.dataset.pinvaultProcessed = ignoreFutureScans ? 'ignored' : '';

        if (imageData.controls.parentElement) {
            imageData.controls.remove();
        }

        this.imageElements.delete(imageId);
    }
}
