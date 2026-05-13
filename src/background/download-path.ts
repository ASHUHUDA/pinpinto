export const PINPINTO_DOWNLOAD_ROOT = 'PinPinto';

export function buildSingleDownloadPath(filename: string): string {
    return `${PINPINTO_DOWNLOAD_ROOT}/${filename}`;
}

export function buildZipDownloadPath(zipName: string): string {
    return `${PINPINTO_DOWNLOAD_ROOT}/${zipName}`;
}
