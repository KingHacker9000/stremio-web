'use strict';

const DEFAULT_AGENT_URL = 'http://127.0.0.1:11471/v1';

function safeKey(value) {
    return String(value || 'download')
        .normalize('NFKD')
        .replace(/[^a-zA-Z0-9._-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 180) || 'download';
}

function parseTotalBytes(response, resumedFrom) {
    const contentRange = response.headers.get('content-range');
    if (contentRange) {
        const match = /\/([0-9]+)$/.exec(contentRange);
        if (match) return Number(match[1]);
    }
    const contentLength = Number(response.headers.get('content-length'));
    return Number.isFinite(contentLength) && contentLength >= 0 ? contentLength + resumedFrom : null;
}

class BrowserOpfsStore {
    constructor(rootName = 'stremio-sense-downloads') {
        this.rootName = rootName;
        this.rootPromise = null;
    }

    static supported() {
        return typeof navigator !== 'undefined' && !!navigator.storage && typeof navigator.storage.getDirectory === 'function';
    }

    async root() {
        if (!BrowserOpfsStore.supported()) throw new Error('OPFS is not supported by this browser');
        if (!this.rootPromise) {
            this.rootPromise = navigator.storage.getDirectory()
                .then((root) => root.getDirectoryHandle(this.rootName, { create: true }));
        }
        return this.rootPromise;
    }

    async _handle(id, create = true) {
        const root = await this.root();
        return root.getFileHandle(`${safeKey(id)}.media`, { create });
    }

    async _metaHandle(id, create = true) {
        const root = await this.root();
        return root.getFileHandle(`${safeKey(id)}.json`, { create });
    }

    async size(id) {
        try {
            const handle = await this._handle(id, false);
            return (await handle.getFile()).size;
        } catch (error) {
            if (error && error.name === 'NotFoundError') return 0;
            throw error;
        }
    }

    async truncate(id, size = 0) {
        const handle = await this._handle(id, true);
        const writer = await handle.createWritable({ keepExistingData: true });
        await writer.truncate(size);
        await writer.close();
    }

    async write(id, offset, chunk) {
        const handle = await this._handle(id, true);
        const writer = await handle.createWritable({ keepExistingData: true });
        await writer.write({ type: 'write', position: offset, data: chunk });
        await writer.close();
    }

    async writeStream(id, offset, readable, onChunk) {
        const handle = await this._handle(id, true);
        const writer = await handle.createWritable({ keepExistingData: true });
        let position = offset;
        const reader = readable.getReader();
        try {
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                await writer.write({ type: 'write', position, data: value });
                position += value.byteLength;
                if (onChunk) await onChunk(position);
            }
        } finally {
            reader.releaseLock();
            await writer.close();
        }
        return position;
    }

    async writeMetadata(id, metadata) {
        const handle = await this._metaHandle(id, true);
        const writer = await handle.createWritable();
        await writer.write(JSON.stringify(metadata));
        await writer.close();
    }

    async readMetadata(id) {
        try {
            const handle = await this._metaHandle(id, false);
            return JSON.parse(await (await handle.getFile()).text());
        } catch (error) {
            if (error && error.name === 'NotFoundError') return null;
            throw error;
        }
    }

    async file(id) {
        return (await this._handle(id, false)).getFile();
    }

    async remove(id) {
        const root = await this.root();
        await Promise.all([
            root.removeEntry(`${safeKey(id)}.media`).catch((error) => {
                if (!error || error.name !== 'NotFoundError') throw error;
            }),
            root.removeEntry(`${safeKey(id)}.json`).catch((error) => {
                if (!error || error.name !== 'NotFoundError') throw error;
            }),
        ]);
    }

    async list() {
        const root = await this.root();
        const items = [];
        for await (const [name] of root.entries()) {
            if (!name.endsWith('.json')) continue;
            const id = name.slice(0, -5);
            const metadata = await this.readMetadata(id).catch(() => null);
            if (metadata) items.push(metadata);
        }
        return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    }
}

class SenseDownloadManager {
    constructor({ store = new BrowserOpfsStore(), fetchImpl = globalThis.fetch } = {}) {
        if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
        this.store = store;
        this.fetchImpl = fetchImpl;
        this.controllers = new Map();
    }

    static supported() {
        return BrowserOpfsStore.supported();
    }

    async requestPersistence() {
        if (typeof navigator === 'undefined' || !navigator.storage || typeof navigator.storage.persist !== 'function') return false;
        return navigator.storage.persist();
    }

    cancel(id) {
        const controller = this.controllers.get(id);
        if (controller) controller.abort();
    }

    async download({ id, url, name, type = 'video', poster = null, contentId = null, videoId = null, headers = {}, onProgress = null }) {
        if (!id || !url) throw new Error('download id and url are required');
        if (this.controllers.has(id)) throw new Error('download already active');
        const controller = new AbortController();
        this.controllers.set(id, controller);
        try {
            let existing = await this.store.size(id);
            const requestHeaders = { ...headers };
            if (existing > 0) requestHeaders.Range = `bytes=${existing}-`;
            let response = await this.fetchImpl(url, { headers: requestHeaders, signal: controller.signal });
            if (existing > 0 && response.status !== 206) {
                existing = 0;
                await this.store.truncate(id, 0);
                response = await this.fetchImpl(url, { headers, signal: controller.signal });
            }
            if (!response.ok || !response.body) throw new Error(`download failed: HTTP ${response.status}`);
            const totalBytes = parseTotalBytes(response, existing);
            const base = {
                id,
                contentId,
                videoId,
                name: name || id,
                type,
                poster,
                sourceUrl: url,
                totalBytes,
                downloadedBytes: existing,
                status: 'downloading',
                updatedAt: Date.now(),
                backend: 'opfs',
                background: false,
            };
            await this.store.writeMetadata(id, base);
            let lastPersist = 0;
            const finalSize = await this.store.writeStream(id, existing, response.body, async (downloadedBytes) => {
                const progress = totalBytes ? downloadedBytes / totalBytes : null;
                if (onProgress) onProgress({ downloadedBytes, totalBytes, progress });
                const now = Date.now();
                if (now - lastPersist > 1500) {
                    lastPersist = now;
                    await this.store.writeMetadata(id, { ...base, downloadedBytes, updatedAt: now });
                }
            });
            const metadata = {
                ...base,
                downloadedBytes: finalSize,
                totalBytes: totalBytes || finalSize,
                status: 'complete',
                updatedAt: Date.now(),
            };
            await this.store.writeMetadata(id, metadata);
            return metadata;
        } catch (error) {
            const previous = await this.store.readMetadata(id).catch(() => null);
            const status = error && error.name === 'AbortError' ? 'paused' : 'error';
            if (previous) {
                await this.store.writeMetadata(id, { ...previous, status, error: status === 'error' ? String(error.message || error) : null, updatedAt: Date.now() });
            }
            throw error;
        } finally {
            this.controllers.delete(id);
        }
    }

    async list() {
        return this.store.list();
    }

    async remove(id) {
        this.cancel(id);
        return this.store.remove(id);
    }

    async playableUrl(id) {
        const file = await this.store.file(id);
        return URL.createObjectURL(file);
    }
}

class NativeAgentDownloadManager {
    constructor({ baseUrl = DEFAULT_AGENT_URL, fetchImpl = globalThis.fetch, probeTtlMs = 2000 } = {}) {
        if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
        this.baseUrl = baseUrl.replace(/\/$/, '');
        this.fetchImpl = fetchImpl;
        this.probeTtlMs = probeTtlMs;
        this.lastProbeAt = 0;
        this.lastProbeResult = false;
    }

    async _request(path, options = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                ...options,
                signal: controller.signal,
            });
            if (!response.ok) {
                let detail = `HTTP ${response.status}`;
                try {
                    const body = await response.json();
                    if (body && body.error) detail = body.error;
                } catch (_) {
                    // Ignore non-JSON error bodies.
                }
                throw new Error(detail);
            }
            if (response.status === 204) return null;
            return response.json();
        } finally {
            clearTimeout(timer);
        }
    }

    async available({ force = false } = {}) {
        const now = Date.now();
        if (!force && now - this.lastProbeAt < this.probeTtlMs) return this.lastProbeResult;
        this.lastProbeAt = now;
        try {
            const result = await this._request('/health', {}, 800);
            this.lastProbeResult = !!(result && result.ok);
        } catch (_) {
            this.lastProbeResult = false;
        }
        return this.lastProbeResult;
    }

    async requestPersistence() {
        return true;
    }

    async download({ id, url, name, type = 'video', poster = null, contentId = null, videoId = null }) {
        const item = await this._request('/downloads', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, url, name, type, poster, contentId, videoId }),
        });
        this.lastProbeAt = Date.now();
        this.lastProbeResult = true;
        return item;
    }

    cancel(id) {
        this._request(`/downloads/${encodeURIComponent(id)}/pause`, { method: 'POST' }).catch(() => {});
    }

    async list() {
        return this._request('/downloads');
    }

    async remove(id) {
        return this._request(`/downloads/${encodeURIComponent(id)}`, { method: 'DELETE' });
    }

    async playableUrl(id) {
        return `${this.baseUrl}/downloads/${encodeURIComponent(id)}/file`;
    }
}

class HybridSenseDownloadManager {
    constructor({ native = new NativeAgentDownloadManager(), browser = null } = {}) {
        this.native = native;
        this.browser = browser || (SenseDownloadManager.supported() ? new SenseDownloadManager() : null);
        this.lastBackend = null;
    }

    static supported() {
        return typeof fetch === 'function' || SenseDownloadManager.supported();
    }

    async _backend() {
        if (await this.native.available()) {
            this.lastBackend = 'native';
            return this.native;
        }
        if (this.browser) {
            this.lastBackend = 'opfs';
            return this.browser;
        }
        throw new Error('No Sense download backend is available. Start the Sense companion or use a browser with OPFS support.');
    }

    async requestPersistence() {
        const backend = await this._backend();
        return backend.requestPersistence();
    }

    async download(options) {
        const backend = await this._backend();
        return backend.download(options);
    }

    cancel(id) {
        if (this.lastBackend === 'native') {
            this.native.cancel(id);
            return;
        }
        if (this.lastBackend === 'opfs' && this.browser) {
            this.browser.cancel(id);
            return;
        }
        this.native.available().then((available) => {
            if (available) this.native.cancel(id);
            else if (this.browser) this.browser.cancel(id);
        });
    }

    async list() {
        const backend = await this._backend();
        return backend.list();
    }

    async remove(id) {
        const backend = await this._backend();
        return backend.remove(id);
    }

    async playableUrl(id) {
        const backend = await this._backend();
        return backend.playableUrl(id);
    }
}

let defaultManager = null;
function getSenseDownloadManager() {
    if (!defaultManager) defaultManager = new HybridSenseDownloadManager();
    return defaultManager;
}

module.exports = {
    BrowserOpfsStore,
    NativeAgentDownloadManager,
    SenseDownloadManager,
    HybridSenseDownloadManager,
    getSenseDownloadManager,
    safeKey,
    parseTotalBytes,
    DEFAULT_AGENT_URL,
};
