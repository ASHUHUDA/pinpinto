export function ensureUniqueFilename(filename: string, usedFilenames: Set<string>): string {
    if (!usedFilenames.has(filename)) {
        usedFilenames.add(filename);
        return filename;
    }

    const dotIndex = filename.lastIndexOf('.');
    const baseName = dotIndex >= 0 ? filename.slice(0, dotIndex) : filename;
    const extension = dotIndex >= 0 ? filename.slice(dotIndex) : '';

    let index = 2;
    let candidate = `${baseName}_${index}${extension}`;
    while (usedFilenames.has(candidate)) {
        index++;
        candidate = `${baseName}_${index}${extension}`;
    }

    usedFilenames.add(candidate);
    return candidate;
}

export function formatLocalTimestamp(date = new Date()): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    const second = String(date.getSeconds()).padStart(2, '0');
    return `${year}${month}${day}_${hour}${minute}${second}`;
}

export function buildSingleFilename(
    timestamp: string,
    url: string,
    originalFilename?: string
): string {
    const extension = resolveImageExtension(url, originalFilename);
    return `PinPinto-${timestamp}.${extension}`;
}

export function buildIndexedFilename(
    sequence: number,
    timestamp: string,
    url: string,
    originalFilename?: string
): string {
    const paddedSequence = sequence < 1000 ? String(sequence).padStart(3, '0') : String(sequence);
    const extension = resolveImageExtension(url, originalFilename);
    return `${paddedSequence}-${timestamp}.${extension}`;
}

export function resolveImageExtension(url?: string, originalFilename?: string): string {
    const fromOriginal = extractExtensionFromPath(originalFilename);
    if (fromOriginal) {
        return fromOriginal;
    }

    const fromUrl = extractExtensionFromPath(url);
    if (fromUrl) {
        return fromUrl;
    }

    return 'jpg';
}

export function extractExtensionFromPath(pathValue?: string): string {
    if (typeof pathValue !== 'string' || !pathValue) {
        return '';
    }

    const cleanPath = pathValue.split('?')[0].split('#')[0];
    const lastSegment = cleanPath.split('/').pop() || '';
    const dotIndex = lastSegment.lastIndexOf('.');

    if (dotIndex <= -1 || dotIndex === lastSegment.length - 1) {
        return '';
    }

    const rawExtension = lastSegment.slice(dotIndex + 1).toLowerCase();
    if (!/^[a-z0-9]{1,8}$/.test(rawExtension)) {
        return '';
    }

    if (rawExtension === 'jpeg' || rawExtension === 'jpe' || rawExtension === 'jfif') {
        return 'jpg';
    }
    if (rawExtension === 'tiff') {
        return 'tif';
    }

    return rawExtension;
}

export function extractFilenameFromUrl(url: string): string {
    const urlParts = url.split('/');
    return urlParts[urlParts.length - 1] || 'image.jpg';
}
