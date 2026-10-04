export type SupportedLanguage = 'en' | 'zh';

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

const ARIA2_TRANSLATIONS = {
    en: {
        'aria2.batchMethod': 'Batch / auto download',
        'aria2.settings': 'aria2 connection settings',
        'aria2.endpoint': 'Local RPC URL',
        'aria2.motrix': 'Use Motrix port',
        'aria2.secret': 'RPC secret',
        'aria2.info': 'aria2 information',
        'aria2.clearSecret': 'Clear secret',
        'aria2.test': 'Save & test',
        'aria2.help': 'Sends individual images, not ZIPs. Submission does not mean download completion. The secret stays on this device, unencrypted and unsynced, across browser restarts. Blank keeps it; select Clear secret and save to remove it.'
    },
    zh: {
        'aria2.batchMethod': '批量 / 自动下载',
        'aria2.settings': 'aria2 连接设置',
        'aria2.endpoint': '本机 RPC 地址',
        'aria2.motrix': '使用 Motrix 端口',
        'aria2.secret': 'RPC 密钥',
        'aria2.info': 'aria2 说明',
        'aria2.clearSecret': '清除密钥',
        'aria2.test': '保存并测试',
        'aria2.help': '逐张提交，不生成 ZIP。提交成功不代表下载完成。密钥仅存本机，不加密、不云同步，重启后保留。留空不改，勾选清除后保存。'
    }
};

export const POPUP_STATUS_TRANSLATIONS: Record<SupportedLanguage, { checkingPinterest: string; connected: string; notConnected: string }> = {
    en: {
        checkingPinterest: 'Checking...',
        connected: 'Connected to Pinterest',
        notConnected: 'Not a Pinterest page'
    },
    zh: {
        checkingPinterest: '检查中...',
        connected: '已连接 Pinterest',
        notConnected: '不是 Pinterest 页面'
    }
};

export const POPUP_STATIC_TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
    en: {
        ...ARIA2_TRANSLATIONS.en,
        'app.subtitle': 'Pinterest Downloader',
        'stats.total': 'Images',
        'stats.selected': 'Selected',
        'action.selectAll': 'Select all',
        'action.clear': 'Clear',
        'action.sidebar': 'Sidebar',
        'setting.autoScroll': 'Auto scroll',
        'setting.autoBatch': 'Auto download',
        'setting.autoBatchLimit': 'Images per batch',
        'setting.autoBatchTotalBatches': 'Total batches',
        'setting.autoBatchTotalBatchesHelp': 'Images per batch: 1–500. Total batches: leave blank or enter 0 for unlimited batches',
        'setting.downloadAsZip': 'Download as ZIP',
        'setting.singleImageDownload': 'Single-image download',
        'setting.singleImageBrowser': 'Browser',
        'setting.singleImageExternal': 'External downloader',
        'panel.autoBatchSettings': 'Auto batch settings',
        'action.batchInfo': 'Batch information',
        'action.stop': 'Stop',
        'panel.downloadSettings': 'Download settings',
        'setting.highQuality': 'Prefer high quality',
        'action.downloadSelected': 'Download selected',
        'action.cancelDownload': 'Cancel current task',
        'state.autoStopPending': 'Will stop after the current batch',
        'state.notPinterestTitle': 'Open Pinterest first',
        'state.notPinterestDesc': 'Current tab is not Pinterest.',
        'action.openPinterest': 'Open Pinterest',
        'menu.language': 'Language',
        'menu.github': 'GitHub'
    },
    zh: {
        ...ARIA2_TRANSLATIONS.zh,
        'app.subtitle': 'Pinterest 下载器',
        'stats.total': '页面图片',
        'stats.selected': '已选择',
        'action.selectAll': '全选',
        'action.clear': '清空',
        'action.sidebar': '侧边栏',
        'setting.autoScroll': '自动滚动',
        'setting.autoBatch': '自动下载',
        'setting.autoBatchLimit': '每批下载数量',
        'setting.autoBatchTotalBatches': '总批下载数量',
        'setting.autoBatchTotalBatchesHelp': '每批下载数量：1–500。总批下载数量：留空或输入 0 为不限批次',
        'setting.downloadAsZip': '压缩包下载',
        'setting.singleImageDownload': '单图下载方式',
        'setting.singleImageBrowser': '浏览器',
        'setting.singleImageExternal': '外部下载器',
        'panel.autoBatchSettings': '自动分批设置',
        'action.batchInfo': '批次说明',
        'action.stop': '停止',
        'panel.downloadSettings': '下载设置',
        'setting.highQuality': '优先下载高清图',
        'action.downloadSelected': '下载已选',
        'action.cancelDownload': '取消当前任务',
        'state.autoStopPending': '将在当前批次完成后停止',
        'state.notPinterestTitle': '请先打开 Pinterest',
        'state.notPinterestDesc': '当前页不是 Pinterest。',
        'action.openPinterest': '打开 Pinterest',
        'menu.language': '语言',
        'menu.github': 'GitHub'
    }
};

export const SIDEBAR_STATUS_TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
    en: {
        'status.connected': 'Connected to Pinterest',
        'status.notConnected': 'Not a Pinterest page',
        'status.error': 'Connection check failed',
        'alert.openPinterestFirst': 'Please open Pinterest first.',
        'alert.noImages': 'No downloadable images were detected.',
        'alert.selectFirst': 'Please select images first.',
        'alert.downloadStartFailed': 'Failed to start download:',
        'alert.downloadFailed': 'Download failed:',
        'progress.preparing': 'Preparing download...',
        'menu.language': 'Language',
        'menu.github': 'GitHub',
        'menu.currentLanguage': 'English',
        'state.batchComplete': 'Batch download complete.'
    },
    zh: {
        'status.connected': '已连接 Pinterest',
        'status.notConnected': '不是 Pinterest 页面',
        'status.error': '连接检查失败，请重试。',
        'alert.openPinterestFirst': '请先打开 Pinterest。',
        'alert.noImages': '未检测到可下载图片。',
        'alert.selectFirst': '请先选图。',
        'alert.downloadStartFailed': '启动下载失败：',
        'alert.downloadFailed': '下载失败：',
        'progress.preparing': '准备下载...',
        'menu.language': '语言',
        'menu.github': 'GitHub',
        'menu.currentLanguage': '中文',
        'state.batchComplete': '分批下载完成。'
    }
};

export const SIDEBAR_STATIC_TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
    en: {
        ...ARIA2_TRANSLATIONS.en,
        'stats.total': 'Images',
        'stats.selected': 'Selected',
        'panel.actions': 'Actions',
        'action.selectAll': 'Select all',
        'action.clear': 'Clear',
        'action.downloadSelected': 'Download selected',
        'panel.preferences': 'Preferences',
        'setting.highQuality': 'Prefer high quality',
        'setting.autoScroll': 'Auto scroll',
        'setting.autoBatch': 'Auto download',
        'setting.autoBatchLimit': 'Images per batch',
        'setting.autoBatchTotalBatches': 'Total batches',
        'setting.autoBatchTotalBatchesHelp': 'Images per batch: 1–500. Total batches: leave blank or enter 0 for unlimited batches',
        'setting.downloadAsZip': 'Download as ZIP',
        'setting.singleImageDownload': 'Single-image download',
        'setting.singleImageBrowser': 'Browser',
        'setting.singleImageExternal': 'External downloader',
        'panel.autoBatchSettings': 'Auto batch settings',
        'action.batchInfo': 'Batch information',
        'action.cancelDownload': 'Cancel current task',
        'state.autoStopPending': 'Will stop after the current batch',
        'menu.language': 'Language',
        'menu.github': 'GitHub',
        'state.notPinterestTitle': 'Open Pinterest first',
        'state.notPinterestDesc': 'Switch to a Pinterest page and try again.',
        'action.openPinterest': 'Open Pinterest'
    },
    zh: {
        ...ARIA2_TRANSLATIONS.zh,
        'stats.total': '页面图片',
        'stats.selected': '已选择',
        'panel.actions': '快捷操作',
        'action.selectAll': '全选',
        'action.clear': '清空',
        'action.downloadSelected': '下载已选',
        'panel.preferences': '偏好设置',
        'setting.highQuality': '优先高清图',
        'setting.autoScroll': '自动滚动',
        'setting.autoBatch': '自动下载',
        'setting.autoBatchLimit': '每批下载数量',
        'setting.autoBatchTotalBatches': '总批下载数量',
        'setting.autoBatchTotalBatchesHelp': '每批下载数量：1–500。总批下载数量：留空或输入 0 为不限批次',
        'setting.downloadAsZip': '压缩包下载',
        'setting.singleImageDownload': '单图下载方式',
        'setting.singleImageBrowser': '浏览器',
        'setting.singleImageExternal': '外部下载器',
        'panel.autoBatchSettings': '自动分批设置',
        'action.batchInfo': '批次说明',
        'action.cancelDownload': '取消当前任务',
        'state.autoStopPending': '将在当前批次完成后停止',
        'menu.language': '语言',
        'menu.github': 'GitHub',
        'state.notPinterestTitle': '请先打开 Pinterest',
        'state.notPinterestDesc': '切换到 Pinterest 页面后再试。',
        'action.openPinterest': '打开 Pinterest'
    }
};

export function normalizeLanguage(value: unknown): SupportedLanguage {
    return value === 'zh' ? 'zh' : 'en';
}
