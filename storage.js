(() => {
  'use strict';

  class DailyTodoStorage {
    constructor({ databaseName, legacyTaskKey, legacyPrefsKey }) {
      this.databaseName = databaseName;
      this.legacyTaskKey = legacyTaskKey;
      this.legacyPrefsKey = legacyPrefsKey;
      this.snapshotKey = `${legacyTaskKey}.atomic.snapshot.v1`;
      this.dbPromise = null;
      this.writeQueue = Promise.resolve();
      this.isIndexedDBAvailable = Boolean(window.indexedDB);
    }

    async load(defaultPrefs) {
      const legacySnapshot = this.readLegacy(defaultPrefs);
      let indexedSnapshot = null;

      if (this.isIndexedDBAvailable) {
        try {
          indexedSnapshot = await this.readIndexedDB();
        } catch (error) {
          this.isIndexedDBAvailable = false;
          console.warn('IndexedDB is unavailable. Using the legacy browser copy.', error);
        }
      }

      const snapshot = this.pickLatest(indexedSnapshot, legacySnapshot, defaultPrefs);
      const source = indexedSnapshot ? 'indexeddb' : legacySnapshot ? 'localstorage' : 'empty';

      if (this.isIndexedDBAvailable && !indexedSnapshot && legacySnapshot) {
        try {
          await this.writeIndexedDB(snapshot);
        } catch (error) {
          this.isIndexedDBAvailable = false;
          console.warn('Legacy data could not be migrated to IndexedDB.', error);
        }
      }

      return { snapshot, source, isIndexedDBAvailable: this.isIndexedDBAvailable };
    }

    save(snapshot) {
      const copy = this.clone(snapshot);
      const mirrorOk = this.writeLegacy(copy);
      if (!this.isIndexedDBAvailable) {
        return mirrorOk
          ? Promise.resolve({ storage: 'localstorage', degraded: false })
          : Promise.reject(new Error('Failed to save to local storage.'));
      }

      this.writeQueue = this.writeQueue
        .catch(() => {})
        .then(() => this.writeIndexedDB(copy));

      return this.writeQueue
        .then(() => ({ storage: 'indexeddb', degraded: false }))
        .catch(err => {
          console.warn('IndexedDB write failed. Operating in localStorage fallback mode.', err);
          this.isIndexedDBAvailable = false;
          if (mirrorOk) {
            return { storage: 'localstorage', degraded: true };
          }
          throw err;
        });
    }

    async requestPersistentStorage() {
      if (!navigator.storage?.persist) return false;
      try {
        return await navigator.storage.persist();
      } catch {
        return false;
      }
    }

    readLegacy(defaultPrefs) {
      try {
        const atomicRaw = localStorage.getItem(this.snapshotKey);
        if (atomicRaw) {
          const envelope = JSON.parse(atomicRaw);
          if (envelope && Array.isArray(envelope.tasks)) {
            return this.normalize(envelope, defaultPrefs);
          }
        }
        const rawTasks = localStorage.getItem(this.legacyTaskKey);
        const rawPrefs = localStorage.getItem(this.legacyPrefsKey);
        if (!rawTasks && !rawPrefs) return null;
        return this.normalize({
          tasks: rawTasks ? JSON.parse(rawTasks) : [],
          prefs: { ...defaultPrefs, ...(rawPrefs ? JSON.parse(rawPrefs) : {}) },
        }, defaultPrefs);
      } catch (error) {
        console.warn('The local backup could not be read.', error);
        return null;
      }
    }

    writeLegacy(snapshot) {
      try {
        const envelope = {
          version: 1,
          savedAt: snapshot.prefs?.lastSavedAt || new Date().toISOString(),
          tasks: snapshot.tasks,
          prefs: snapshot.prefs,
        };
        localStorage.setItem(this.snapshotKey, JSON.stringify(envelope));
        localStorage.setItem(this.legacyTaskKey, JSON.stringify(snapshot.tasks));
        localStorage.setItem(this.legacyPrefsKey, JSON.stringify(snapshot.prefs));
        return true;
      } catch (error) {
        console.warn('The local backup mirror could not be updated.', error);
        return false;
      }
    }

    async readIndexedDB() {
      const db = await this.openDatabase();
      const transaction = db.transaction('state', 'readonly');
      const complete = this.transactionComplete(transaction);
      const record = await this.request(transaction.objectStore('state').get('current'));
      await complete;
      return record?.snapshot || null;
    }

    async writeIndexedDB(snapshot) {
      const db = await this.openDatabase();
      const transaction = db.transaction('state', 'readwrite');
      const complete = this.transactionComplete(transaction);
      transaction.objectStore('state').put({
        id: 'current',
        savedAt: snapshot.prefs.lastSavedAt || new Date().toISOString(),
        snapshot: this.clone(snapshot),
      });
      await complete;
    }

    openDatabase() {
      if (this.dbPromise) return this.dbPromise;
      this.dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('state')) db.createObjectStore('state', { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('The Daily Todo database is blocked by another tab.'));
      });
      return this.dbPromise;
    }

    pickLatest(indexedSnapshot, legacySnapshot, defaultPrefs) {
      if (!indexedSnapshot) return this.normalize(legacySnapshot, defaultPrefs);
      if (!legacySnapshot) return this.normalize(indexedSnapshot, defaultPrefs);
      const indexedSavedAt = new Date(indexedSnapshot.prefs?.lastSavedAt || 0).getTime();
      const legacySavedAt = new Date(legacySnapshot.prefs?.lastSavedAt || 0).getTime();
      return this.normalize(legacySavedAt > indexedSavedAt ? legacySnapshot : indexedSnapshot, defaultPrefs);
    }

    normalize(snapshot, defaultPrefs) {
      return {
        tasks: Array.isArray(snapshot?.tasks) ? snapshot.tasks : [],
        prefs: { ...defaultPrefs, ...(snapshot?.prefs || {}) },
      };
    }

    clone(value) {
      return JSON.parse(JSON.stringify(value));
    }

    request(request) {
      return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    transactionComplete(transaction) {
      return new Promise((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }
  }

  window.DailyTodoStorage = DailyTodoStorage;
})();
