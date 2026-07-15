export const PINTEREST_IMAGE_SELECTORS = [
    'img[src*="pinimg.com"]',
    'img[data-src*="pinimg.com"]',
    'img[srcset*="pinimg.com"]',
    'picture source[srcset*="pinimg.com"]',
    '[data-test-id="pin"] img',
    '[data-test-id="visual-search-pin"] img',
    '.GrowthUnauthPin img',
    '.Pin img',
    '.pinWrapper img'
] as const;

export function isValidPinterestImage(img: HTMLImageElement): boolean {
    const src = img.src || img.dataset.src || img.srcset || '';
    if (!src.includes('pinimg.com')) return false;

    const width = img.naturalWidth || img.width || img.clientWidth || 0;
    const height = img.naturalHeight || img.height || img.clientHeight || 0;
    if ((width > 0 && width < 100) || (height > 0 && height < 100)) return false;
    return !src.includes('/avatars/') && !src.includes('/user/');
}

export function getOriginalImageUrl(img: HTMLImageElement): string {
    return img.currentSrc || img.src || img.dataset.src || '';
}

export function getHighQualityImageUrl(img: HTMLImageElement): string {
    return getOriginalImageUrl(img)
        .replace(/\/\d+x\//, '/originals/')
        .replace(/\/\d+x\d+\//, '/originals/');
}

export function scanPinterestImages(
    root: ParentNode,
    processImage: (image: HTMLImageElement) => void
): void {
    const candidates = new Set<HTMLImageElement>();
    PINTEREST_IMAGE_SELECTORS.forEach((selector) => {
        root.querySelectorAll(selector).forEach((element) => {
            if (element instanceof HTMLImageElement) {
                candidates.add(element);
                return;
            }
            const image = element.closest('picture')?.querySelector('img')
                || element.closest('div')?.querySelector('img');
            if (image) candidates.add(image);
        });
    });
    root.querySelectorAll('img').forEach((image) => {
        if (isValidPinterestImage(image)) candidates.add(image);
    });
    candidates.forEach((image) => {
        if (!image.dataset.pinvaultProcessed) processImage(image);
    });
}
