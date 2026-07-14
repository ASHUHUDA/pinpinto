type FolderImageData = {
    board?: string;
    folder?: string;
    url?: string;
};

type FolderSettings = {
    folderOrganization?: string;
    customFolder?: string;
};

export function generateFolderPath(
    imageData: FolderImageData,
    settings: FolderSettings,
    date = new Date()
): string {
    if (imageData.folder) {
        return `${PINPINTO_DOWNLOAD_ROOT}/${imageData.folder}`;
    }

    const sanitize = (str: string) => str.replace(/[^a-z0-9\-_\.]/gi, '_').substring(0, 50);
    const dateStr = date.toISOString().split('T')[0];
    const monthYear = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    let folderPath = PINPINTO_DOWNLOAD_ROOT;

    switch (settings.folderOrganization || 'date') {
        case 'board':
            folderPath += `/${sanitize(imageData.board || 'General')}`;
            break;

        case 'date':
            folderPath += `/${dateStr}`;
            break;

        case 'month':
            folderPath += `/${monthYear}`;
            break;

        case 'board_date':
            folderPath += `/${sanitize(imageData.board || 'General')}/${dateStr}`;
            break;

        case 'domain':
            folderPath += `/${extractDomainFromUrl(imageData.url) || 'Pinterest'}`;
            break;

        case 'custom':
            if (settings.customFolder) {
                folderPath += `/${sanitize(settings.customFolder)}`;
            }
            break;

        case 'none':
        default:
            break;
    }

    return folderPath;
}

export function extractDomainFromUrl(url?: string): string {
    try {
        const domain = new URL(url || '').hostname;
        if (domain.includes('pinterest.')) {
            const parts = domain.split('.');
            if (parts.length > 2) {
                return `Pinterest_${parts[parts.length - 1].toUpperCase()}`;
            }
            return 'Pinterest';
        }
        return domain;
    } catch {
        return 'Unknown';
    }
}
import { PINPINTO_DOWNLOAD_ROOT } from './download-path';
