type DownloadImageLike = string | { url?: unknown } | null | undefined;
type DownloadSettingsLike = { highQuality?: boolean } | null | undefined;

export function getHighQualityUrl(url: string): string {
    if (!url.includes('pinimg.com')) {
        return url;
    }

    let highQualityUrl = url;

    highQualityUrl = highQualityUrl.replace(/\/\d+x\//, '/originals/');
    highQualityUrl = highQualityUrl.replace(/\/\d+x\d+\//, '/originals/');
    highQualityUrl = highQualityUrl.replace(/\/\d+x\d+_/, '/originals/');
    highQualityUrl = highQualityUrl.replace(/_\d+x\d+\./, '_originals.');

    if (highQualityUrl === url) {
        const urlParts = highQualityUrl.split('/');
        for (let i = 0; i < urlParts.length; i++) {
            if (urlParts[i].match(/^\d+x\d*$/)) {
                urlParts[i] = 'originals';
                break;
            }
        }
        highQualityUrl = urlParts.join('/');
    }

    return highQualityUrl;
}

export function normalizeImageUrlForDeduplication(
    image: DownloadImageLike,
    settings: DownloadSettingsLike,
    highQualityUrlResolver = getHighQualityUrl
): string {
    const rawUrl = typeof image === 'string' ? image : image?.url;
    if (typeof rawUrl !== 'string' || !rawUrl) {
        return '';
    }

    if (settings?.highQuality === false || !rawUrl.includes('pinimg.com')) {
        return rawUrl;
    }

    return highQualityUrlResolver(rawUrl);
}

export function getDownloadCandidateUrls(
    rawUrl: unknown,
    highQualityEnabled: boolean,
    highQualityUrlResolver = getHighQualityUrl
): string[] {
    if (typeof rawUrl !== 'string' || !rawUrl) {
        return [];
    }

    const candidates: string[] = [];
    if (highQualityEnabled && rawUrl.includes('pinimg.com')) {
        const highQualityUrl = highQualityUrlResolver(rawUrl);
        candidates.push(highQualityUrl);
        if (highQualityUrl !== rawUrl) {
            candidates.push(rawUrl);
        }
    } else {
        candidates.push(rawUrl);
    }

    return Array.from(new Set(candidates));
}
