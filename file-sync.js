(() => {
  'use strict';

  class DailyTodoFileSync {
    constructor() {
      this.apiBase = './api';
      this.relativePath = 'data/daily-todo-data.json';
      this.backupPath = 'data/backups/';
      this.available = false;
      this.token = '';
      this.revision = 0;
      this.writeQueue = Promise.resolve();
    }

    async load() {
      if (!this.canReachLocalServer()) return this.unavailable();
      if (!(await this.configure())) return this.unavailable();

      try {
        const response = await fetch(this.apiBase + '/data', { cache: 'no-store' });
        if (response.status === 404 && this.isLocalResponse(response)) {
          return { available: true, snapshot: null, revision: 0 };
        }
        if (!response.ok || !this.isLocalResponse(response)) return this.unavailable();

        const envelope = await response.json();
        if (!this.isValidEnvelope(envelope)) throw new Error('The local data file has an invalid format.');
        this.revision = envelope.revision;
        return {
          available: true,
          revision: this.revision,
          snapshot: { tasks: envelope.tasks, prefs: envelope.prefs },
          snapshotSaved: envelope.snapshotSaved === true,
        };
      } catch (error) {
        console.warn('Local file sync is unavailable.', error);
        return this.unavailable();
      }
    }

    save(snapshot) {
      if (!this.available || !this.token) return Promise.resolve({ available: false, synced: false });
      const payload = JSON.parse(JSON.stringify(snapshot));
      this.writeQueue = this.writeQueue
        .catch(() => {})
        .then(() => this.write(payload));
      return this.writeQueue;
    }

    canReachLocalServer() {
      return location.protocol === 'http:' || location.protocol === 'https:';
    }

    async configure() {
      try {
        const response = await fetch(this.apiBase + '/config', { cache: 'no-store' });
        if (!response.ok || !this.isLocalResponse(response)) return false;
        const config = await response.json();
        if (typeof config.token !== 'string' || !config.token) return false;
        this.token = config.token;
        this.available = true;
        return true;
      } catch {
        return false;
      }
    }

    async write(snapshot) {
      try {
        const response = await fetch(this.apiBase + '/data', {
          method: 'POST',
          cache: 'no-store',
          headers: {
            'Content-Type': 'application/json',
            'X-Daily-Todo-Token': this.token,
          },
          body: JSON.stringify({ baseRevision: this.revision, snapshot }),
        });

        if ((response.status === 401 || response.status === 403) && this.isLocalResponse(response)) {
          return this.reconnectAndRetry(snapshot);
        }
        if (response.status === 409 && this.isLocalResponse(response)) {
          const current = await response.json();
          return { available: true, synced: false, conflict: true, current };
        }
        if (!response.ok || !this.isLocalResponse(response)) {
          throw new Error('The local server did not accept the data file.');
        }

        const result = await response.json();
        if (!Number.isInteger(result.revision)) throw new Error('The local server returned an invalid revision.');
        this.revision = result.revision;
        this.available = true;
        return { available: true, synced: Boolean(result.activeSaved), snapshotSaved: Boolean(result.snapshotSaved) };
      } catch (error) {
        console.warn('Local file sync failed. It will retry on the next change.', error);
        return { available: this.available, synced: false, retryable: true, error };
      }
    }

    async reconnectAndRetry(snapshot) {
      const previousRevision = this.revision;
      const reloaded = await this.load();
      if (!reloaded.available) return { available: false, synced: false, retryable: true };
      if (reloaded.snapshot && this.sameSnapshot(reloaded.snapshot, snapshot)) {
        return { available: true, synced: true, recovered: true, snapshotSaved: reloaded.snapshotSaved };
      }
      if (reloaded.revision !== previousRevision) {
        return { available: true, synced: false, conflict: true, current: reloaded.snapshot };
      }
      return this.write(snapshot);
    }

    sameSnapshot(left, right) {
      return JSON.stringify(left) === JSON.stringify(right);
    }

    isLocalResponse(response) {
      return response.headers.get('X-Daily-Todo-Local') === 'true';
    }

    isValidEnvelope(value) {
      return value
        && Number.isInteger(value.revision)
        && Array.isArray(value.tasks)
        && value.prefs
        && typeof value.prefs === 'object'
        && !Array.isArray(value.prefs);
    }

    unavailable() {
      this.available = false;
      this.token = '';
      return { available: false, snapshot: null, revision: 0 };
    }
  }

  window.DailyTodoFileSync = DailyTodoFileSync;
})();
