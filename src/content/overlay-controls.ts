type OverlayControlCallbacks = {
    onToggleSelection: () => void;
    onDownloadSingle: (button: HTMLButtonElement) => Promise<void>;
};

type OverlayControlElements = {
    controls: HTMLDivElement;
    selectOverlay: HTMLDivElement;
};

export function createOverlayControls(
    imageId: string,
    callbacks: OverlayControlCallbacks
): OverlayControlElements {
    const controls = document.createElement('div');
    controls.className = 'pinvault-overlay-controls';

    const topRightGroup = document.createElement('div');
    topRightGroup.className = 'pinvault-overlay-group';

    const overlay = document.createElement('div');
    overlay.className = 'pinvault-overlay';
    overlay.dataset.imageId = imageId;

    const checkbox = document.createElement('span');
    checkbox.className = 'pinvault-checkbox';
    checkbox.textContent = '[ ]';
    overlay.appendChild(checkbox);

    overlay.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        callbacks.onToggleSelection();
    });

    const singleDownloadBtn = document.createElement('button');
    singleDownloadBtn.className = 'pinvault-single-download-btn';
    singleDownloadBtn.type = 'button';
    singleDownloadBtn.title = 'Download this image';
    singleDownloadBtn.setAttribute('aria-label', 'Download this image');
    singleDownloadBtn.innerHTML = `
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 3v10" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                    <path d="M8 10.5L12 14.5L16 10.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    <path d="M4 18h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>
                </svg>
                <span class="pinvault-single-download-btn-label">Download</span>
            `;

    singleDownloadBtn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        await callbacks.onDownloadSingle(singleDownloadBtn);
    });

    topRightGroup.appendChild(overlay);
    controls.appendChild(topRightGroup);
    controls.appendChild(singleDownloadBtn);

    return { controls, selectOverlay: overlay };
}

