export type SupportedLanguage = 'en' | 'zh';

export const DEFAULT_LANGUAGE: SupportedLanguage = 'en';

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
        'app.subtitle': 'Pinterest Downloader',
        'stats.total': 'Images',
        'stats.selected': 'Selected',
        'action.selectAll': 'Select all',
        'action.clear': 'Clear',
        'action.sidebar': 'Sidebar',
        'setting.autoScroll': 'Auto scroll',
        'setting.autoBatch': 'Auto download (100/{0}/∞)',
        'action.stop': 'Stop',
        'panel.downloadSettings': 'Download settings',
        'setting.highQuality': 'Prefer high quality',
        'action.downloadSelected': 'Download selected',
        'action.cancelDownload': 'Cancel download',
        'state.notPinterestTitle': 'Open Pinterest first',
        'state.notPinterestDesc': 'Current tab is not Pinterest.',
        'action.openPinterest': 'Open Pinterest',
        'menu.language': 'Language',
        'menu.github': 'GitHub'
    },
    zh: {
        'app.subtitle': 'Pinterest 下载器',
        'stats.total': '页面图片',
        'stats.selected': '已选择',
        'action.selectAll': '全选',
        'action.clear': '清空',
        'action.sidebar': '侧边栏',
        'setting.autoScroll': '自动滚动',
        'setting.autoBatch': '自动下载(100/{0}/∞)',
        'action.stop': '停止',
        'panel.downloadSettings': '下载设置',
        'setting.highQuality': '优先下载高清图',
        'action.downloadSelected': '下载已选',
        'action.cancelDownload': '取消下载',
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
        'state.batchComplete': 'Batch download complete (3 rounds).'
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
        'state.batchComplete': '分批下载完成（3轮）。'
    }
};

export const SIDEBAR_STATIC_TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = {
    en: {
        'stats.total': 'Images',
        'stats.selected': 'Selected',
        'panel.actions': 'Actions',
        'action.selectAll': 'Select all',
        'action.clear': 'Clear',
        'action.downloadSelected': 'Download selected',
        'panel.preferences': 'Preferences',
        'setting.highQuality': 'Prefer high quality',
        'setting.autoScroll': 'Auto scroll',
        'setting.autoBatch': 'Auto download (100/{0}/∞)',
        'action.cancelDownload': 'Cancel download',
        'menu.language': 'Language',
        'menu.github': 'GitHub',
        'state.notPinterestTitle': 'Open Pinterest first',
        'state.notPinterestDesc': 'Switch to a Pinterest page and try again.',
        'action.openPinterest': 'Open Pinterest'
    },
    zh: {
        'stats.total': '页面图片',
        'stats.selected': '已选择',
        'panel.actions': '快捷操作',
        'action.selectAll': '全选',
        'action.clear': '清空',
        'action.downloadSelected': '下载已选',
        'panel.preferences': '偏好设置',
        'setting.highQuality': '优先高清图',
        'setting.autoScroll': '自动滚动',
        'setting.autoBatch': '自动下载(100/{0}/∞)',
        'action.cancelDownload': '取消下载',
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
