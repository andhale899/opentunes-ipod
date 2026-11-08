/**
 * A very small key-value store in the browser: IndexedDB, which can hold a folder handle, with
 * localStorage as the fallback for plain data when IndexedDB is blocked. Everything is wrapped so
 * a refusal never stops the app. Used for the interrupted-write note and the remembered folders.
 * Nothing here is ever sent anywhere.
 */

export interface KvStore {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  /** False for a store that cannot hold a folder handle. */
  readonly handles: boolean;
}

export function memoryKv(): KvStore {
  const data = new Map<string, unknown>();
  return {
    handles: true,
    async get(key) {
      return data.get(key);
    },
    async set(key, value) {
      data.set(key, value);
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

const DB_NAME = 'opentunes';
const STORE = 'kv';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
  });
}

function indexedDbKv(): KvStore {
  let opened: Promise<IDBDatabase> | null = null;
  const database = (): Promise<IDBDatabase> => (opened ??= openDatabase());
  const run = async <T,>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await database();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE, mode);
      const request = action(transaction.objectStore(STORE));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB failed.'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB was stopped.'));
    });
  };
  return {
    handles: true,
    get: (key) => run('readonly', (store) => store.get(key)),
    async set(key, value) {
      await run('readwrite', (store) => store.put(value, key));
    },
    async delete(key) {
      await run('readwrite', (store) => store.delete(key));
    },
  };
}

function localStorageKv(storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>): KvStore {
  const name = (key: string): string => `opentunes.kv.${key}`;
  return {
    handles: false,
    async get(key) {
      const text = storage.getItem(name(key));
      return text === null ? undefined : JSON.parse(text);
    },
    async set(key, value) {
      storage.setItem(name(key), JSON.stringify(value));
    },
    async delete(key) {
      storage.removeItem(name(key));
    },
  };
}

/** IndexedDB when it opens, otherwise localStorage, otherwise nothing is kept. */
export async function openKv(): Promise<KvStore> {
  try {
    if (typeof indexedDB !== 'undefined') {
      const store = indexedDbKv();
      await store.get('probe');
      return store;
    }
  } catch {
    // fall through to localStorage
  }
  try {
    if (typeof localStorage !== 'undefined') return localStorageKv(localStorage);
  } catch {
    // blocked
  }
  return memoryKv();
}

let shared: Promise<KvStore> | null = null;

/** The page's store, opened once. */
export function kv(): Promise<KvStore> {
  return (shared ??= openKv());
}

/** For tests: use this store instead of the browser's. */
export function useKv(store: KvStore | null): void {
  shared = store ? Promise.resolve(store) : null;
}
