'use strict';

const STORAGE_KEY = 'stremio-sense-history-v1';
const MAX_ITEMS = 2000;

function read() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const parsed = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.id === 'string') : [];
    } catch (_) {
        return [];
    }
}

function write(items) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(-MAX_ITEMS))); } catch (_) {}
}

function record(id, kind = 'played') {
    if (typeof id !== 'string' || id.length === 0) return;
    const now = Date.now();
    const items = read();
    const existing = items.findIndex((item) => item.id === id);
    if (existing >= 0) items.splice(existing, 1);
    items.push({ id, kind, at: now });
    write(items);
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('stremio-sense-history-changed'));
}

function ids(limit = 100) {
    return read().slice(-Math.max(0, limit)).map((item) => item.id);
}

function clear() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('stremio-sense-history-changed'));
}

function subscribe(listener) {
    if (typeof window === 'undefined') return () => {};
    const handler = () => listener(read());
    window.addEventListener('stremio-sense-history-changed', handler);
    window.addEventListener('storage', handler);
    return () => {
        window.removeEventListener('stremio-sense-history-changed', handler);
        window.removeEventListener('storage', handler);
    };
}

module.exports = { read, record, ids, clear, subscribe };
