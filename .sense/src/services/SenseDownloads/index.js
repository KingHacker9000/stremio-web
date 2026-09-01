'use strict';

function safeKey(value){return String(value||'download').normalize('NFKD').replace(/[^a-zA-Z0-9._-]+/g,'_').replace(/^_+|_+$/g,'').slice(0,180)||'download';}
function parseTotalBytes(response,resumedFrom){const contentRange=response.headers.get('content-range');if(contentRange){const match=/\/([0-9]+)$/.exec(contentRange);if(match)return Number(match[1]);}const contentLength=Number(response.headers.get('content-length'));return Number.isFinite(contentLength)&&contentLength>=0?contentLength+resumedFrom:null;}
class BrowserOpfsStore{
 constructor(rootName='stremio-sense-downloads'){this.rootName=rootName;this.rootPromise=null;}
 static supported(){return typeof navigator!=='undefined'&&!!navigator.storage&&typeof navigator.storage.getDirectory==='function';}
 async root(){if(!BrowserOpfsStore.supported())throw new Error('OPFS is not supported by this browser');if(!this.rootPromise)this.rootPromise=navigator.storage.getDirectory().then((root)=>root.getDirectoryHandle(this.rootName,{create:true}));return this.rootPromise;}
 async _handle(id,create=true){return (await this.root()).getFileHandle(`${safeKey(id)}.media`,{create});}
 async _metaHandle(id,create=true){return (await this.root()).getFileHandle(`${safeKey(id)}.json`,{create});}
 async size(id){try{return(await(await this._handle(id,false)).getFile()).size;}catch(error){if(error&&error.name==='NotFoundError')return 0;throw error;}}
 async truncate(id,size=0){const writer=await(await this._handle(id,true)).createWritable({keepExistingData:true});await writer.truncate(size);await writer.close();}
 async writeStream(id,offset,readable,onChunk){const writer=await(await this._handle(id,true)).createWritable({keepExistingData:true});let position=offset;const reader=readable.getReader();try{while(true){const{done,value}=await reader.read();if(done)break;await writer.write({type:'write',position,data:value});position+=value.byteLength;if(onChunk)await onChunk(position);}}finally{reader.releaseLock();await writer.close();}return position;}
 async writeMetadata(id,metadata){const writer=await(await this._metaHandle(id,true)).createWritable();await writer.write(JSON.stringify(metadata));await writer.close();}
 async readMetadata(id){try{return JSON.parse(await(await(await this._metaHandle(id,false)).getFile()).text());}catch(error){if(error&&error.name==='NotFoundError')return null;throw error;}}
 async file(id){return(await this._handle(id,false)).getFile();}
 async remove(id){const root=await this.root();await Promise.all([root.removeEntry(`${safeKey(id)}.media`).catch((e)=>{if(!e||e.name!=='NotFoundError')throw e;}),root.removeEntry(`${safeKey(id)}.json`).catch((e)=>{if(!e||e.name!=='NotFoundError')throw e;})]);}
 async list(){const root=await this.root(),items=[];for await(const[name]of root.entries()){if(!name.endsWith('.json'))continue;const metadata=await this.readMetadata(name.slice(0,-5)).catch(()=>null);if(metadata)items.push(metadata);}return items.sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));}
}
class SenseDownloadManager{
 constructor({store=new BrowserOpfsStore(),fetchImpl=globalThis.fetch}={}){if(typeof fetchImpl!=='function')throw new Error('fetch is unavailable');this.store=store;this.fetchImpl=fetchImpl;this.controllers=new Map();}
 static supported(){return BrowserOpfsStore.supported();}
 async requestPersistence(){if(typeof navigator==='undefined'||!navigator.storage||typeof navigator.storage.persist!=='function')return false;return navigator.storage.persist();}
 cancel(id){const controller=this.controllers.get(id);if(controller)controller.abort();}
 async download({id,url,name,type='video',poster=null,contentId=null,videoId=null,headers={},onProgress=null}){if(!id||!url)throw new Error('download id and url are required');if(this.controllers.has(id))throw new Error('download already active');const controller=new AbortController();this.controllers.set(id,controller);try{let existing=await this.store.size(id);const requestHeaders={...headers};if(existing>0)requestHeaders.Range=`bytes=${existing}-`;let response=await this.fetchImpl(url,{headers:requestHeaders,signal:controller.signal});if(existing>0&&response.status!==206){existing=0;await this.store.truncate(id,0);response=await this.fetchImpl(url,{headers,signal:controller.signal});}if(!response.ok||!response.body)throw new Error(`download failed: HTTP ${response.status}`);const totalBytes=parseTotalBytes(response,existing);const base={id,contentId,videoId,name:name||id,type,poster,sourceUrl:url,totalBytes,downloadedBytes:existing,status:'downloading',updatedAt:Date.now()};await this.store.writeMetadata(id,base);let lastPersist=0;const finalSize=await this.store.writeStream(id,existing,response.body,async(downloadedBytes)=>{const progress=totalBytes?downloadedBytes/totalBytes:null;if(onProgress)onProgress({downloadedBytes,totalBytes,progress});const now=Date.now();if(now-lastPersist>1500){lastPersist=now;await this.store.writeMetadata(id,{...base,downloadedBytes,updatedAt:now});}});const metadata={...base,downloadedBytes:finalSize,totalBytes:totalBytes||finalSize,status:'complete',updatedAt:Date.now()};await this.store.writeMetadata(id,metadata);return metadata;}catch(error){const previous=await this.store.readMetadata(id).catch(()=>null),status=error&&error.name==='AbortError'?'paused':'error';if(previous)await this.store.writeMetadata(id,{...previous,status,error:status==='error'?String(error.message||error):null,updatedAt:Date.now()});throw error;}finally{this.controllers.delete(id);}}
 async list(){return this.store.list();}
 async remove(id){this.cancel(id);return this.store.remove(id);}
 async playableUrl(id){return URL.createObjectURL(await this.store.file(id));}
}
let defaultManager=null;function getSenseDownloadManager(){if(!defaultManager)defaultManager=new SenseDownloadManager();return defaultManager;}
module.exports={BrowserOpfsStore,SenseDownloadManager,getSenseDownloadManager,safeKey,parseTotalBytes};
