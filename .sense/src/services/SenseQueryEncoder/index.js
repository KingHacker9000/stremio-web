'use strict';

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
let extractorPromise = null;

async function hasVendoredModel() {
    try {
        const response = await fetch(`/sense/models/${MODEL_ID}/config.json`, { method: 'HEAD' });
        return response.ok;
    } catch (_) {
        return false;
    }
}

async function createExtractor() {
    const transformers = await import('@huggingface/transformers');
    const { pipeline, env } = transformers;
    const local = await hasVendoredModel();
    if (local) {
        env.allowLocalModels = true;
        env.localModelPath = '/sense/models/';
        env.allowRemoteModels = false;
    }
    return pipeline('feature-extraction', MODEL_ID, {
        dtype: 'q8',
        ...(local ? { local_files_only: true } : {}),
    });
}

async function getExtractor() {
    if (!extractorPromise) {
        extractorPromise = createExtractor().catch((error) => {
            extractorPromise = null;
            throw error;
        });
    }
    return extractorPromise;
}

async function encodeQuery(text) {
    const query = String(text || '').trim();
    if (!query) return null;
    const extractor = await getExtractor();
    const output = await extractor(query, { pooling: 'mean', normalize: true });
    return output.data instanceof Float32Array ? output.data : Float32Array.from(output.data);
}

module.exports = { MODEL_ID, encodeQuery, getExtractor };
