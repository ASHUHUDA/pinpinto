import { BlobJobRunner } from './background/blob-runner';
import {
    OFFSCREEN_MESSAGE_TARGET,
    type OffscreenBlobMessage,
    type OffscreenBlobResponse
} from './background/offscreen-protocol';

const runner = new BlobJobRunner();

chrome.runtime.onMessage.addListener((message: OffscreenBlobMessage, _sender, sendResponse) => {
    if (message?.target !== OFFSCREEN_MESSAGE_TARGET) return false;
    void handleMessage(message)
        .then((value) => sendResponse({ ok: true, value } satisfies OffscreenBlobResponse))
        .catch((error) => sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : String(error)
        } satisfies OffscreenBlobResponse));
    return true;
});

function handleMessage(message: OffscreenBlobMessage): Promise<unknown> {
    switch (message.operation) {
        case 'start': return runner.start(message.request);
        case 'getStatus': return runner.getStatus(message.jobId);
        case 'result': return runner.result(message.jobId);
        case 'cancel': return runner.cancel(message.jobId);
        case 'release': return runner.release(message.jobId);
        case 'listActiveJobs': return runner.listActiveJobs();
    }
}
