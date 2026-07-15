export async function sendTabMessage(
    tabId: number,
    message: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
    try {
        return await chrome.tabs.sendMessage(tabId, message);
    } catch {
        return null;
    }
}
