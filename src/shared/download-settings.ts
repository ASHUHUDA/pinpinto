export type SharedDownloadSettings = {
    highQuality: boolean;
    autoScroll: boolean;
    autoBatchDownload: boolean;
    filenameFormat: string;
    folderOrganization: string;
    customFolder: string;
};

export const SHARED_DOWNLOAD_SETTINGS_DEFAULTS: SharedDownloadSettings = {
    highQuality: true,
    autoScroll: false,
    autoBatchDownload: false,
    filenameFormat: 'title_date',
    folderOrganization: 'date',
    customFolder: ''
};
