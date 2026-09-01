'use strict';

const MAGIC = 'SENSEIDX';
const VERSION = 2;
const HEADER_BYTES = 16;
const TYPE_NAMES = new Map([[1, 'movie'], [2, 'series']]);

function cosineI8(a, b) {
    if (!(a instanceof Int8Array) || !(b instanceof Int8Array) || a.length === 0 || a.length !== b.length) return 0;
    let dot = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < a.length; i += 1) { const x = a[i], y = b[i]; dot += x * y; a2 += x * x; b2 += y * y; }
    return a2 === 0 || b2 === 0 ? 0 : dot / Math.sqrt(a2 * b2);
}

function cosineFloatToI8(query, item) {
    if ((!Array.isArray(query) && !(query instanceof Float32Array)) || !(item instanceof Int8Array) || query.length === 0 || query.length !== item.length) return 0;
    let dot = 0, a2 = 0, b2 = 0;
    for (let i = 0; i < query.length; i += 1) { const x = Number(query[i]), y = item[i] / 127; dot += x * y; a2 += x * x; b2 += y * y; }
    return a2 === 0 || b2 === 0 ? 0 : dot / Math.sqrt(a2 * b2);
}

function decodeUtf8(bytes) { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
function normalizeText(input) { return String(input || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
function trigrams(input) { const normalized = `  ${normalizeText(input)}  `; const out = new Set(); for (let i = 0; i + 3 <= normalized.length; i += 1) out.add(normalized.slice(i, i + 3)); return out; }
function diceCoefficient(a, b) { if (a.size === 0 || b.size === 0) return 0; let overlap = 0; for (const token of a) if (b.has(token)) overlap += 1; return (2 * overlap) / (a.size + b.size); }
function softmaxPool(values, temperature = 0.12) { if (values.length === 0) return Number.NEGATIVE_INFINITY; const t = Math.max(0.01, temperature); const maxValue = Math.max(...values); let sum = 0; for (const value of values) sum += Math.exp((value - maxValue) / t); return maxValue + t * Math.log(sum / values.length); }

class SenseRuntime {
    constructor(dimensions, items) { this.dimensions = dimensions; this.items = items; this.positions = new Map(items.map((item, index) => [item.id, index])); this.titleIndex = items.map((item) => ({ id: item.id, normalized: normalizeText(item.name), trigrams: trigrams(item.name) })); }
    static fromArrayBuffer(input) {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (bytes.byteLength < HEADER_BYTES) throw new Error('truncated Sense index');
        const magic = new TextDecoder('ascii').decode(bytes.subarray(0, 8)); if (magic !== MAGIC) throw new Error('invalid Sense index magic');
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const version = view.getUint16(8, true); if (version !== VERSION) throw new Error(`unsupported Sense index version ${version}`);
        const dimensions = view.getUint16(10, true); const count = view.getUint32(12, true); if (dimensions === 0) throw new Error('zero-dimensional Sense index');
        let cursor = HEADER_BYTES; const items = []; const seen = new Set(); const requireBytes = (amount) => { if (cursor + amount > bytes.byteLength) throw new Error('truncated Sense index'); }; const readU16 = () => { requireBytes(2); const value = view.getUint16(cursor, true); cursor += 2; return value; };
        for (let row = 0; row < count; row += 1) {
            const idLength = readU16(); requireBytes(idLength + 1); const id = decodeUtf8(bytes.subarray(cursor, cursor + idLength)); cursor += idLength; if (seen.has(id)) throw new Error(`duplicate item id: ${id}`); seen.add(id);
            const typeCode = bytes[cursor]; cursor += 1; const nameLength = readU16(); requireBytes(nameLength + dimensions); const name = decodeUtf8(bytes.subarray(cursor, cursor + nameLength)); cursor += nameLength; const vector = new Int8Array(dimensions); vector.set(new Int8Array(bytes.buffer, bytes.byteOffset + cursor, dimensions)); cursor += dimensions;
            items.push({ id, name, type: TYPE_NAMES.get(typeCode) || 'other', vector });
        }
        if (cursor !== bytes.byteLength) throw new Error('trailing bytes in Sense index');
        return new SenseRuntime(dimensions, items);
    }
    item(id) { const position = this.positions.get(id); return position === undefined ? null : this.items[position]; }
    _hit(item, score) { return { id: item.id, name: item.name, type: item.type, score }; }
    similar(queryId, limit = 20, options = {}) { const query = this.item(queryId); if (!query || limit <= 0) return []; const exclude = new Set(options.exclude || []); exclude.add(queryId); const mediaType = options.type || null; return this.items.filter((item) => !exclude.has(item.id) && (!mediaType || item.type === mediaType)).map((item) => this._hit(item, cosineI8(query.vector, item.vector))).sort((a,b) => b.score-a.score || a.name.localeCompare(b.name)).slice(0, limit); }
    _diversify(candidates, resultLimit, relevanceWeight) { const lambda = Math.max(0, Math.min(1, relevanceWeight)); const remaining = candidates.slice(), selected = []; while (remaining.length && selected.length < resultLimit) { let bestIndex = 0, bestScore = Number.NEGATIVE_INFINITY; for (let i=0;i<remaining.length;i+=1) { const candidate=remaining[i], candidateVector=this.item(candidate.id).vector; let redundancy=0; for (const picked of selected) redundancy=Math.max(redundancy,Math.max(0,cosineI8(candidateVector,this.item(picked.id).vector))); const mmr=lambda*candidate.score-(1-lambda)*redundancy; if (mmr>bestScore){bestScore=mmr;bestIndex=i;} } selected.push(remaining.splice(bestIndex,1)[0]); } return selected; }
    similarDiverse(queryId, candidateLimit=80, resultLimit=20, relevanceWeight=0.72, options={}) { return this._diversify(this.similar(queryId,Math.max(candidateLimit,resultLimit),options),resultLimit,relevanceWeight); }
    recommendFromHistory(historyIds, options={}) { const resultLimit=options.resultLimit||20,candidateLimit=options.candidateLimit||Math.max(160,resultLimit*10),seedLimit=options.seedLimit||12,relevanceWeight=options.relevanceWeight===undefined?0.76:options.relevanceWeight,temperature=options.temperature||0.12,mediaType=options.type||null,seen=new Set(historyIds||[]),seeds=(historyIds||[]).slice(-seedLimit).map((id)=>this.item(id)).filter(Boolean).reverse(); if(!seeds.length)return[]; const candidates=[]; for(const item of this.items){if(seen.has(item.id)||(mediaType&&item.type!==mediaType))continue; const similarities=seeds.map((seed,index)=>cosineI8(seed.vector,item.vector)+0.035*Math.exp(-index/5)); candidates.push(this._hit(item,softmaxPool(similarities,temperature)));} candidates.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)); return this._diversify(candidates.slice(0,candidateLimit),resultLimit,relevanceWeight); }
    lexicalSearch(query, limit=20, options={}) { const normalizedQuery=normalizeText(query); if(!normalizedQuery||limit<=0)return[]; const queryTrigrams=trigrams(normalizedQuery),mediaType=options.type||null,scores=[]; for(let index=0;index<this.items.length;index+=1){const item=this.items[index];if(mediaType&&item.type!==mediaType)continue;const title=this.titleIndex[index];let score=diceCoefficient(queryTrigrams,title.trigrams);if(title.normalized===normalizedQuery)score+=2;else if(title.normalized.startsWith(normalizedQuery))score+=1;else if(title.normalized.includes(normalizedQuery))score+=0.45;if(score>0.04)scores.push(this._hit(item,score));} scores.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)); return scores.slice(0,limit); }
    semanticSearch(queryVector,limit=40,options={}) { if(!queryVector||queryVector.length!==this.dimensions)return[];const mediaType=options.type||null;return this.items.filter((item)=>!mediaType||item.type===mediaType).map((item)=>this._hit(item,cosineFloatToI8(queryVector,item.vector))).sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name)).slice(0,limit); }
    smartSearch(query,options={}) { const limit=options.limit||20,lexical=this.lexicalSearch(query,Math.max(limit*3,40),options),queryVector=options.queryVector||null;if(!queryVector)return lexical.slice(0,limit);const semantic=this.semanticSearch(queryVector,Math.max(limit*5,80),options),merged=new Map();for(const hit of semantic)merged.set(hit.id,{...hit,semanticScore:hit.score,lexicalScore:0});const lexicalScale=lexical.length===0?1:Math.max(...lexical.map((hit)=>hit.score),1e-6);for(const hit of lexical){const current=merged.get(hit.id)||{...hit,semanticScore:0,lexicalScore:0};current.lexicalScore=hit.score/lexicalScale;merged.set(hit.id,current);}const results=Array.from(merged.values()).map((hit)=>{const lexicalBoost=hit.lexicalScore>=1.9/lexicalScale?1.4:Math.min(0.35,hit.lexicalScore*0.25);return{id:hit.id,name:hit.name,type:hit.type,score:hit.semanticScore+lexicalBoost};});results.sort((a,b)=>b.score-a.score||a.name.localeCompare(b.name));return results.slice(0,limit); }
}
const runtimePromises=new Map();
function loadSenseRuntime(url='/sense/sense.index.bin'){if(!runtimePromises.has(url)){const promise=fetch(url).then((response)=>{if(!response.ok)throw new Error(`Sense index fetch failed: HTTP ${response.status}`);return response.arrayBuffer();}).then((buffer)=>SenseRuntime.fromArrayBuffer(buffer)).catch((error)=>{runtimePromises.delete(url);throw error;});runtimePromises.set(url,promise);}return runtimePromises.get(url);}
function loadSenseSearchRuntime(){return loadSenseRuntime('/sense/sense.search.index.bin');}
module.exports={SenseRuntime,cosineI8,cosineFloatToI8,loadSenseRuntime,loadSenseSearchRuntime,normalizeText};
