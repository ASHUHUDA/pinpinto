export type SingleDownloadPhase = 'idle' | 'pending' | 'submitted' | 'complete' | 'retry';

export type SingleDownloadState = {
    imageId: string;
    phase: SingleDownloadPhase;
    disabled: boolean;
    error: string | null;
    removeImageId: string | null;
};

export type SingleDownloadSettlement = {
    state: 'submitted' | 'complete' | 'rejected' | 'interrupted';
    error?: string | null;
};

type SingleDownloadStartResult = {
    success?: boolean;
    submitted?: boolean;
    state?: string;
    error?: string | null;
};

type SingleDownloadEntry = {
    button: HTMLButtonElement;
    state: SingleDownloadState;
};

export function createSingleDownloadState(imageId: string): SingleDownloadState {
    return {
        imageId,
        phase: 'idle',
        disabled: false,
        error: null,
        removeImageId: null
    };
}

export function acceptSingleDownload(state: SingleDownloadState): {
    accepted: boolean;
    state: SingleDownloadState;
} {
    if (state.phase === 'pending' || state.phase === 'submitted' || state.phase === 'complete') {
        return { accepted: false, state };
    }
    return {
        accepted: true,
        state: {
            ...state,
            phase: 'pending',
            disabled: true,
            error: null,
            removeImageId: null
        }
    };
}

export function settleSingleDownload(
    state: SingleDownloadState,
    settlement: SingleDownloadSettlement
): SingleDownloadState {
    if (state.phase !== 'pending') return state;
    if (settlement.state === 'submitted') {
        return {
            ...state,
            phase: 'submitted',
            disabled: true,
            error: null,
            removeImageId: null
        };
    }
    if (settlement.state === 'complete') {
        return {
            ...state,
            phase: 'complete',
            disabled: true,
            error: null,
            removeImageId: state.imageId
        };
    }
    return {
        ...state,
        phase: 'retry',
        disabled: false,
        error: settlement.error || 'Download failed',
        removeImageId: null
    };
}

export class SingleDownloadController {
    private readonly entries = new Map<string, SingleDownloadEntry>();

    register(imageId: string, button: HTMLButtonElement): void {
        const existing = this.entries.get(imageId);
        const state = existing?.state ?? createSingleDownloadState(imageId);
        this.entries.set(imageId, { button, state });
        this.render(button, state);
    }

    async start(
        imageId: string,
        button: HTMLButtonElement,
        startDownload: () => Promise<SingleDownloadStartResult>
    ): Promise<boolean> {
        this.register(imageId, button);
        const entry = this.entries.get(imageId)!;
        const accepted = acceptSingleDownload(entry.state);
        if (!accepted.accepted) return false;

        entry.state = accepted.state;
        this.render(entry.button, entry.state);
        try {
            const response = await startDownload();
            if (response?.success === true) {
                if (response.submitted === true || response.state === 'submitted') {
                    this.applySettlement(entry, { state: 'submitted' });
                }
                return true;
            }
            this.applySettlement(entry, {
                state: 'rejected',
                error: response?.error || 'The browser rejected the download request.'
            });
        } catch (error) {
            this.applySettlement(entry, {
                state: 'rejected',
                error: error instanceof Error ? error.message : String(error)
            });
        }
        return false;
    }

    settle(imageId: string, settlement: SingleDownloadSettlement): SingleDownloadState | null {
        const entry = this.entries.get(imageId);
        if (!entry) return null;
        return this.applySettlement(entry, settlement);
    }

    remove(imageId: string): void {
        this.entries.delete(imageId);
    }

    clear(): void {
        this.entries.clear();
    }

    private applySettlement(
        entry: SingleDownloadEntry,
        settlement: SingleDownloadSettlement
    ): SingleDownloadState {
        entry.state = settleSingleDownload(entry.state, settlement);
        this.render(entry.button, entry.state);
        return entry.state;
    }

    private render(button: HTMLButtonElement, state: SingleDownloadState): void {
        const label = button.querySelector('.pinvault-single-download-btn-label');
        button.classList.toggle('success', state.phase === 'complete');
        button.classList.toggle('error', state.phase === 'retry');
        button.disabled = state.disabled;

        const text = state.phase === 'pending'
            ? 'Downloading...'
            : state.phase === 'retry'
                ? 'Retry'
                : state.phase === 'submitted'
                    ? 'Sent to external downloader'
                : state.phase === 'complete'
                    ? 'Complete'
                    : 'Download';
        if (label instanceof HTMLElement) label.textContent = text;

        const detail = state.error ? `: ${state.error}` : '';
        button.title = state.phase === 'retry'
            ? `Download failed${detail}`
            : text;
        button.setAttribute('aria-label', button.title);
    }
}
