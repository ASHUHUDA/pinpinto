import { buildAutoEligibleWindow } from './eligible-window';
import type { PinterestImageSource } from './image-classifier';
import { findViewportAnchorIndex, sliceOrderedItems, splitOrderedIdsAtIndex } from './session-helpers';
import { compactAutoSessionWindow } from './session-window';

export type ImageSessionRecord = {
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
    source: PinterestImageSource;
    absoluteOrdinal?: number;
};

export type AutoBatchCommit = {
    startOffset: number;
    endOffset: number;
    autoBatchLimit: number;
};

export class ContentSessionStore {
    selectedImages = new Set<string>();
    imageElements = new Map<string, ImageSessionRecord>();
    imageOrder: string[] = [];
    ignoredImageSources = new Set<string>();
    nextImageOrdinal = 1;
    eligibleBaseOffset = 0;
    nextEligibleOrdinal = 0;

    createImageId(img: HTMLImageElement) {
        const src = img.src || img.dataset.src || '';
        const filename = src.split('/').at(-1) || 'img';
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
        imageData.absoluteOrdinal = this.nextEligibleOrdinal;
        if (imageData.source !== 'recommendation') this.nextEligibleOrdinal += 1;
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

    selectImage(imageId: string): boolean {
        const imageData = this.imageElements.get(imageId);
        if (!imageData) return false;
        if (this.selectedImages.has(imageId)) return true;

        const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
        if (!(checkbox instanceof HTMLElement)) return false;

        this.selectedImages.add(imageId);
        imageData.overlay.classList.add('selected');
        imageData.container.classList.add('pinvault-selected');
        imageData.element.setAttribute('data-pinvault-selected', 'true');
        checkbox.textContent = '[x]';
        return true;
    }

    selectAllImages() {
        this.imageElements.forEach((_imageData, imageId) => this.selectImage(imageId));
    }

    deselectAllImages() {
        this.selectedImages.forEach((imageId) => {
            const imageData = this.imageElements.get(imageId);
            if (!imageData) return;

            const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
            imageData.overlay.classList.remove('selected', 'success', 'error');
            imageData.container.classList.remove('pinvault-selected');
            imageData.element.setAttribute('data-pinvault-selected', 'false');
            if (checkbox instanceof HTMLElement) checkbox.textContent = '[ ]';
        });
        this.selectedImages.clear();
    }

    clearAllImages() {
        [...this.imageElements.keys()].forEach((imageId) => this.removeImage(imageId, true));
        this.selectedImages.clear();
        this.imageElements.clear();
        this.imageOrder = [];
        // Keep ignored sources so delayed auto-scroll scans or MutationObserver
        // callbacks cannot recreate overlays for the same just-cleared images.
        this.nextImageOrdinal = 1;
        this.eligibleBaseOffset = 0;
        this.nextEligibleOrdinal = 0;
    }

    removeDownloadedImage(imageId: string) {
        const removed = this.removeImage(imageId, true);
        this.imageOrder = this.getOrderedImageIds();
        return removed;
    }

    getSelectedImagesData() {
        const selectedData: ReturnType<ContentSessionStore['serializeImageData']>[] = [];
        this.selectedImages.forEach((imageId) => {
            const imageData = this.imageElements.get(imageId);
            if (imageData) selectedData.push(this.serializeImageData(imageData));
        });
        return selectedData;
    }

    getImagesInRange(startIndex = 0, endIndex = this.imageOrder.length) {
        return sliceOrderedItems(this.getOrderedImages(), startIndex, endIndex)
            .map((imageData) => this.serializeImageData(imageData));
    }

    getAutoEligibleWindow(cursor: number, limit: number, exhausted: boolean, pageUrl: string) {
        const window = buildAutoEligibleWindow(this.getOrderedImages(), {
            pageUrl,
            baseOffset: this.eligibleBaseOffset,
            cursor,
            limit,
            exhausted
        });
        return {
            ...window,
            baseOffset: this.eligibleBaseOffset,
            records: window.records.map((record) => this.serializeImageData(record))
        };
    }

    getViewportAnchorIndex() {
        const orderedImages = this.getOrderedImages();
        if (orderedImages.length === 0) return 0;

        const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
        return findViewportAnchorIndex(orderedImages.map((imageData) => {
            const rect = imageData.container.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom };
        }), viewportHeight);
    }

    prepareAutoBatchSession(startIndex = 0) {
        const result = this.discardImagesBeforeIndex(startIndex);
        this.eligibleBaseOffset = 0;
        this.nextEligibleOrdinal = 0;
        this.getOrderedImages().forEach((record) => {
            record.absoluteOrdinal = this.nextEligibleOrdinal;
            if (record.source !== 'recommendation') this.nextEligibleOrdinal += 1;
        });
        return { ...result, baseOffset: this.eligibleBaseOffset };
    }

    discardImagesBeforeIndex(startIndex = 0) {
        const { discarded, remaining } = splitOrderedIdsAtIndex(this.getOrderedImageIds(), startIndex);
        discarded.forEach((imageId) => this.removeImage(imageId, true));
        this.imageOrder = remaining;
        return { discardedCount: discarded.length, remainingCount: remaining.length };
    }

    commitAutoBatchWindow(input: AutoBatchCommit) {
        const startOffset = Math.max(0, Math.floor(input.startOffset));
        const endOffset = Math.max(startOffset, Math.floor(input.endOffset));
        if (endOffset <= this.eligibleBaseOffset) {
            return {
                success: true,
                baseOffset: this.eligibleBaseOffset,
                retainedCount: this.imageElements.size,
                removedIds: [] as string[]
            };
        }
        if (startOffset !== this.eligibleBaseOffset || endOffset > this.nextEligibleOrdinal) {
            return {
                success: false,
                baseOffset: this.eligibleBaseOffset,
                retainedCount: this.imageElements.size,
                removedIds: [] as string[],
                error: 'Compaction range does not match the retained eligible window.'
            };
        }

        const compacted = compactAutoSessionWindow(this.getOrderedImages(), {
            settledThroughOffset: endOffset,
            autoBatchLimit: input.autoBatchLimit
        });
        compacted.removedIds.forEach((imageId) => this.removeImage(imageId, true));
        this.imageOrder = compacted.records.map((record) => record.id);
        this.eligibleBaseOffset = compacted.baseOffset;
        return {
            success: true,
            baseOffset: this.eligibleBaseOffset,
            retainedCount: this.imageElements.size,
            removedIds: compacted.removedIds
        };
    }

    markImageStatus(imageId: string, status: string, error: string | null = null) {
        const imageData = this.imageElements.get(imageId);
        if (!imageData) return;
        const checkbox = imageData.overlay.querySelector('.pinvault-checkbox');
        if (!(checkbox instanceof HTMLElement)) return;

        imageData.overlay.classList.remove('success', 'error');
        if (status === 'success') {
            imageData.overlay.classList.add('success');
            checkbox.textContent = 'OK';
            imageData.overlay.title = 'Downloaded successfully';
        } else if (status === 'error') {
            imageData.overlay.classList.add('error');
            checkbox.textContent = 'ERR';
            imageData.overlay.title = `Download failed: ${error || 'Unknown error'}`;
        }
    }

    private getOrderedImageIds() {
        return this.imageOrder.filter((imageId) => this.imageElements.has(imageId));
    }

    private getOrderedImages() {
        return this.getOrderedImageIds()
            .map((imageId) => this.imageElements.get(imageId))
            .filter((record): record is ImageSessionRecord => Boolean(record));
    }

    private serializeImageData(imageData: ImageSessionRecord) {
        return {
            id: imageData.id,
            url: imageData.url,
            title: imageData.title,
            board: imageData.board,
            domain: imageData.domain,
            originalFilename: imageData.originalFilename,
            source: imageData.source,
            absoluteOrdinal: imageData.absoluteOrdinal
        };
    }

    private removeImage(imageId: string, ignoreFutureScans: boolean) {
        const imageData = this.imageElements.get(imageId);
        if (!imageData) return false;
        if (ignoreFutureScans && imageData.sourceKey) this.ignoredImageSources.add(imageData.sourceKey);

        this.selectedImages.delete(imageId);
        imageData.container.classList.remove('pinvault-selected', 'pinvault-image-container');
        imageData.element.setAttribute('data-pinvault-selected', 'false');
        if (ignoreFutureScans) {
            imageData.element.dataset.pinvaultProcessed = 'ignored';
        } else {
            delete imageData.element.dataset.pinvaultProcessed;
        }
        imageData.controls.remove();
        this.imageElements.delete(imageId);
        return true;
    }
}
