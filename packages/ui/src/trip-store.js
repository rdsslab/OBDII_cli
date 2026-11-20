/**
 * Trip logs in the browser (PWA): IndexedDB, written in small chunks every
 * few seconds, so a closed tab or a crash loses at most the last chunk.
 *
 *   trips:  {id, startedAt, updatedAt, meta, samples, events, gpsSamples, durationS, bytes, complete, rate}
 *   chunks: {trip, recs:[...]}   (auto-increment key = write order)
 */
const DB_NAME = 'obd-trips';
const DB_VERSION = 1;

const req2p = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
const tx2p = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error); });

export class IdbTripStore {
    static supported() { return typeof indexedDB !== 'undefined'; }

    async _db() {
        if (this.db) return this.db;
        const r = indexedDB.open(DB_NAME, DB_VERSION);
        r.onupgradeneeded = () => {
            const db = r.result;
            if (!db.objectStoreNames.contains('trips')) db.createObjectStore('trips', { keyPath: 'id' });
            if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { autoIncrement: true }).createIndex('trip', 'trip');
        };
        this.db = await req2p(r);
        return this.db;
    }

    async create(id, info) {
        const db = await this._db();
        const tx = db.transaction('trips', 'readwrite');
        tx.objectStore('trips').put({ id, bytes: 0, samples: 0, events: 0, gpsSamples: 0, durationS: 0, complete: false, ...info, updatedAt: Date.now() });
        await tx2p(tx);
        // Ask the browser not to evict our data under storage pressure.
        try { await navigator.storage?.persist?.(); } catch { /* ignore */ }
    }

    /** Append records and update the trip's counters in one transaction. */
    async append(id, recs, status = {}) {
        if (!recs.length && !Object.keys(status).length) return;
        const db = await this._db();
        const tx = db.transaction(['trips', 'chunks'], 'readwrite');
        const bytes = recs.length ? JSON.stringify(recs).length : 0;
        if (recs.length) tx.objectStore('chunks').add({ trip: id, recs });
        const trips = tx.objectStore('trips');
        const t = await req2p(trips.get(id));
        if (t) trips.put({ ...t, ...status, bytes: (t.bytes || 0) + bytes, updatedAt: Date.now() });
        await tx2p(tx);
    }

    async list() {
        const db = await this._db();
        const all = await req2p(db.transaction('trips').objectStore('trips').getAll());
        return all.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
    }

    async records(id) {
        const db = await this._db();
        const chunks = await req2p(db.transaction('chunks').objectStore('chunks').index('trip').getAll(id));
        return chunks.flatMap(c => c.recs);
    }

    async remove(id) {
        const db = await this._db();
        const tx = db.transaction(['trips', 'chunks'], 'readwrite');
        tx.objectStore('trips').delete(id);
        const idx = tx.objectStore('chunks').index('trip');
        const keys = await req2p(idx.getAllKeys(id));
        for (const k of keys) tx.objectStore('chunks').delete(k);
        await tx2p(tx);
    }

    static async usage() {
        try {
            const e = await navigator.storage?.estimate?.();
            return e ? { used: e.usage, quota: e.quota } : null;
        } catch { return null; }
    }
}
