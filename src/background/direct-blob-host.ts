import { BlobJobRunner, type BlobJobHost } from './blob-runner';

export function createDirectBlobJobHost(): BlobJobHost {
    if (
        typeof document === 'undefined'
        || typeof URL?.createObjectURL !== 'function'
        || typeof URL?.revokeObjectURL !== 'function'
    ) {
        throw new Error('This background context cannot host Blob ZIP jobs.');
    }
    return new BlobJobRunner();
}
