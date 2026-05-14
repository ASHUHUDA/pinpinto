import { AUTO_BATCH_DOWNLOAD_LIMIT } from './download-batching';

export type SharedDownloadSettings = {
    highQuality: boolean;
    autoScroll: boolean;
    autoBatchDownload: boolean;
    autoBatchLimit: number;
    filenameFormat: string;
    folderOrganization: string;
    customFolder: string;
};

export const SHARED_DOWNLOAD_SETTINGS_DEFAULTS: SharedDownloadSettings = {
    highQuality: true,
    autoScroll: false,
    autoBatchDownload: false,
    autoBatchLimit: AUTO_BATCH_DOWNLOAD_LIMIT,
    filenameFormat: 'title_date',
    folderOrganization: 'date',
    customFolder: ''
};
