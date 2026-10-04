import { ARIA2_SECRET_KEY } from '../shared/aria2-settings';

// Extension-origin IndexedDB is persistent without exposing credentials through
// chrome.storage or its content-script change events. This is not encryption.
const DATABASE_NAME = 'pinpinto-aria2';
const STORE_NAME = 'credentials';
const SECRET_KEY = 'rpcSecret';
let pending: Promise<unknown> = Promise.resolve();

function serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = pending.then(operation);
    pending = result.catch(() => undefined);
    return result;
}

function openDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE_NAME, 1);
        let blocked = false;
        request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
        request.onerror = () => reject(new Error('Could not open RPC secret storage.'));
        request.onblocked = () => {
            blocked = true;
            reject(new Error('RPC secret storage is blocked. Close other extension settings and retry.'));
        };
        request.onsuccess = () => {
            if (blocked) request.result.close();
            else resolve(request.result);
        };
    });
}

async function transact(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest): Promise<unknown> {
    const database = await openDatabase();
    try {
        return await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, mode);
            const request = operation(transaction.objectStore(STORE_NAME));
            let value: unknown;
            request.onsuccess = () => { value = request.result; };
            transaction.oncomplete = () => resolve(value);
            transaction.onabort = transaction.onerror = () => reject(new Error('Could not access RPC secret storage.'));
        });
    } finally {
        database.close();
    }
}

function validateSecret(value: unknown): string {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid saved RPC secret.');
    return value;
}

export function readAria2Secret(): Promise<string> {
    return serialize(async () => {
        const stored = await transact('readonly', (store) => store.get(SECRET_KEY));
        if (stored !== undefined) return validateSecret(stored);
        const session = await chrome.storage.session.get(ARIA2_SECRET_KEY);
        const legacy = session[ARIA2_SECRET_KEY];
        if (legacy === undefined) return '';
        const secret = validateSecret(legacy);
        await transact('readwrite', (store) => store.put(secret, SECRET_KEY));
        // Remove the old session value only after the durable transaction completes.
        await chrome.storage.session.remove(ARIA2_SECRET_KEY);
        return secret;
    });
}

export function saveAria2Secret(secret: string): Promise<void> {
    return serialize(async () => {
        // An empty value marks an explicit clear, preventing a leftover session
        // credential from being resurrected if session cleanup fails.
        await transact('readwrite', (store) => store.put(validateSecret(secret), SECRET_KEY));
        await chrome.storage.session.remove(ARIA2_SECRET_KEY);
    });
}
