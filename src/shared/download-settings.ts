import { AUTO_BATCH_DOWNLOAD_LIMIT, AUTO_BATCH_TOTAL_BATCHES_UNLIMITED } from './download-batching';

export type SharedDownloadSettings = {
    highQuality: boolean;
    autoScroll: boolean;
    autoBatchDownload: boolean;
    autoBatchLimit: number;
    autoBatchTotalBatches: number;
    filenameFormat: string;
    folderOrganization: string;
    customFolder: string;
};

export const SHARED_DOWNLOAD_SETTINGS_DEFAULTS: SharedDownloadSettings = {
    highQuality: true,
    autoScroll: false,
    autoBatchDownload: false,
    autoBatchLimit: AUTO_BATCH_DOWNLOAD_LIMIT,
    autoBatchTotalBatches: AUTO_BATCH_TOTAL_BATCHES_UNLIMITED,
    filenameFormat: 'title_date',
    folderOrganization: 'date',
    customFolder: ''
};
