import { AUTO_BATCH_DOWNLOAD_LIMIT, AUTO_BATCH_TOTAL_BATCHES_UNLIMITED } from './download-batching';

export type SingleImageDownloadMethod = 'browser' | 'external' | 'aria2';
export type BatchDownloadMethod = 'browser' | 'aria2';

export type SharedDownloadSettings = {
    highQuality: boolean;
    autoScroll: boolean;
    autoBatchDownload: boolean;
    downloadAsZip: boolean;
    singleImageDownloadMethod: SingleImageDownloadMethod;
    batchDownloadMethod: BatchDownloadMethod;
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
    downloadAsZip: true,
    singleImageDownloadMethod: 'browser',
    batchDownloadMethod: 'browser',
    autoBatchLimit: AUTO_BATCH_DOWNLOAD_LIMIT,
    autoBatchTotalBatches: AUTO_BATCH_TOTAL_BATCHES_UNLIMITED,
    filenameFormat: 'title_date',
    folderOrganization: 'date',
    customFolder: ''
};

export function normalizeDownloadAsZip(value: unknown): boolean {
    return typeof value === 'boolean' ? value : SHARED_DOWNLOAD_SETTINGS_DEFAULTS.downloadAsZip;
}

export function normalizeSingleImageDownloadMethod(value: unknown): SingleImageDownloadMethod {
    return value === 'aria2' ? 'aria2' : value === 'external' ? 'external' : 'browser';
}

export function normalizeBatchDownloadMethod(value: unknown): BatchDownloadMethod {
    return value === 'aria2' ? 'aria2' : 'browser';
}
