#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,shutil
from pathlib import Path
HERE=Path(__file__).resolve().parent

def cp(src,dst): dst.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(src,dst);print('installed',dst)
def repl(s,old,new,label):
    if new in s:return s
    if old not in s:raise SystemExit(f'upstream anchor changed: {label}')
    return s.replace(old,new,1)
def patch(path,fn):
    s=path.read_text();u=fn(s)
    if u!=s:path.write_text(u);print('patched',path)

def patch_stream(s):
    s=repl(s,"const { default: useRouteFocused } = require('stremio/common/useRouteFocused');\n","const { default: useRouteFocused } = require('stremio/common/useRouteFocused');\nconst { getSenseDownloadManager } = require('stremio/services/SenseDownloads');\n",'stream import')
    anchor="const Stream = ({ className, videoId, videoReleased, addonName, name, description, thumbnail, progress, deepLinks, ...props }) => {\n"
    helper="""function senseHash(value) {\n    let hash = 2166136261;\n    for (let i = 0; i < value.length; i += 1) { hash ^= value.charCodeAt(i); hash = Math.imul(hash, 16777619); }\n    return (hash >>> 0).toString(16);\n}\n\n"""
    if 'function senseHash(value)' not in s:s=repl(s,anchor,helper+anchor,'stream component')
    if 'const downloadVideo = React.useCallback' not in s:
        a="    const copyDownloadLink = React.useCallback((event) => {\n";start=s.find(a);end=s.find("\n    const copyStreamLink = React.useCallback",start)
        if start<0 or end<0:raise SystemExit('upstream anchor changed: download callbacks')
        cb="""\n\n    const downloadVideo = React.useCallback((event) => {\n        event.preventDefault(); event.stopPropagation(); closeMenu();\n        if (!downloadLink) return;\n        if (!navigator.storage || typeof navigator.storage.getDirectory !== 'function') { copyDownloadLink(event); return; }\n        const manager = getSenseDownloadManager();\n        const downloadId = `${videoId || 'video'}-${senseHash(downloadLink)}`;\n        toast.show({ type: 'success', title: 'Download started', timeout: 2500 });\n        manager.requestPersistence().catch(() => false);\n        manager.download({ id: downloadId, url: downloadLink, name: name || description || addonName || videoId || 'Video', videoId })\n            .then(() => toast.show({ type: 'success', title: 'Download complete', timeout: 4000 }))\n            .catch((error) => { if (error && error.name === 'AbortError') return; toast.show({ type: 'error', title: `Download failed: ${error?.message || error}`, timeout: 6000 }); });\n    }, [downloadLink, videoId, name, description, addonName, copyDownloadLink]);\n"""
        s=s[:end]+cb+s[end:]
    old="""                {\n                    downloadLink &&\n                        <Button className={styles['context-menu-option-container']} title={t('CTX_DOWNLOAD_VIDEO')} onClick={copyDownloadLink}>\n                            <Icon className={styles['menu-icon']} name={'download'} />\n                            <div className={styles['context-menu-option-label']}>{t('CTX_COPY_VIDEO_DOWNLOAD_LINK')}</div>\n                        </Button>\n                }\n"""
    new="""                {\n                    downloadLink &&\n                        <Button className={styles['context-menu-option-container']} title={t('CTX_DOWNLOAD_VIDEO')} onClick={downloadVideo}>\n                            <Icon className={styles['menu-icon']} name={'download'} />\n                            <div className={styles['context-menu-option-label']}>{t('CTX_DOWNLOAD_VIDEO')}</div>\n                        </Button>\n                }\n                {\n                    downloadLink &&\n                        <Button className={styles['context-menu-option-container']} title={t('CTX_COPY_VIDEO_DOWNLOAD_LINK')} onClick={copyDownloadLink}>\n                            <Icon className={styles['menu-icon']} name={'link'} />\n                            <div className={styles['context-menu-option-label']}>{t('CTX_COPY_VIDEO_DOWNLOAD_LINK')}</div>\n                        </Button>\n                }\n"""
    return repl(s,old,new,'stream download menu')

def main():
    ap=argparse.ArgumentParser();ap.add_argument('checkout',type=Path);args=ap.parse_args();root=args.checkout.resolve()
    if not (root/'src/routes/MetaDetails/MetaDetails.js').exists():raise SystemExit('not stremio-web')
    files=['src/services/SenseRuntime/index.js','src/services/SenseDownloads/index.js','src/services/SenseHistory/index.js','src/services/SenseQueryEncoder/index.js','src/routes/MetaDetails/SenseMoreLikeThis.js','src/routes/Downloads/Downloads.js','src/routes/Downloads/styles.less','src/routes/Board/SenseTopPicks.js','src/routes/Search/SenseSmartSearch.js']
    for f in files:cp(HERE/f,root/f)
    (root/'assets/sense').mkdir(parents=True,exist_ok=True)
    patch(root/'webpack.config.js',lambda s:repl(s,"                { from: 'assets/images', to: 'images' },\n","                { from: 'assets/images', to: 'images' },\n                { from: 'assets/sense', to: 'sense', noErrorOnMissing: true },\n",'webpack sense assets'))
    def meta(s):
        s=repl(s,"const useSeason = require('./useSeason');\n","const useSeason = require('./useSeason');\nconst SenseMoreLikeThis = require('./SenseMoreLikeThis');\n",'meta import')
        old="""                </div>\n            </div>\n        </div>\n    );\n};\n""";new="""                </div>\n                {\n                    metaDetails.metaItem !== null && metaDetails.metaItem.content.type === 'Ready' ?\n                        <SenseMoreLikeThis metaId={metaDetails.metaItem.content.content.id} /> : null\n                }\n            </div>\n        </div>\n    );\n};\n"""
        return repl(s,old,new,'meta row')
    patch(root/'src/routes/MetaDetails/MetaDetails.js',meta)
    patch(root/'src/routes/index.js',lambda s:repl(repl(s,"const Discover = require('./Discover');\n","const Discover = require('./Discover');\nconst Downloads = require('./Downloads/Downloads');\n",'downloads import'),"    Discover,\n    Library,","    Discover,\n    Downloads,\n    Library,",'downloads export'))
    def routes(s):
        a="""    {\n        path: '/library/:type?',\n        view: 1,\n        element: <routes.Library />,\n    },\n""";return repl(s,a,a+"""    { path: '/downloads/play/:downloadId?', view: 1, element: <routes.Downloads /> },\n    { path: '/downloads', view: 1, element: <routes.Downloads /> },\n""",'downloads routes')
    patch(root/'src/router/routerPaths.tsx',routes)
    patch(root/'src/components/MainNavBars/MainNavBars.tsx',lambda s:repl(s,"    { id: 'library', label: 'Library', icon: 'library', href: '/library' },\n","    { id: 'library', label: 'Library', icon: 'library', href: '/library' },\n    { id: 'downloads', label: 'Downloads', icon: 'download', href: '/downloads' },\n",'downloads tab'))
    patch(root/'src/routes/MetaDetails/StreamsList/Stream/Stream.js',patch_stream)
    def board(s):
        s=repl(s,"const useContinueWatchingPreview = require('./useContinueWatchingPreview');\n","const useContinueWatchingPreview = require('./useContinueWatchingPreview');\nconst SenseTopPicks = require('./SenseTopPicks');\n",'board import')
        return repl(s,"""                    }\n                    {board.catalogs.map((catalog, index) => {\n""","""                    }\n                    <SenseTopPicks continueWatching={continueWatchingPreview.items} />\n                    {board.catalogs.map((catalog, index) => {\n""",'board row')
    patch(root/'src/routes/Board/Board.js',board)
    def player(s):
        s=repl(s,"const { useModelState, useCoreSuspender } = require('stremio/common');\n","const { useModelState, useCoreSuspender } = require('stremio/common');\nconst SenseHistory = require('stremio/services/SenseHistory');\n",'player history import')
        old="""    const ended = React.useCallback(() => {\n        core.transport.dispatch({\n            action: 'Player',\n            args: {\n                action: 'Ended'\n            }\n        }, 'player');\n    }, []);\n""";new="""    const ended = React.useCallback(() => {\n        if (typeof urlParams.id === 'string') SenseHistory.record(urlParams.id, 'completed');\n        core.transport.dispatch({ action: 'Player', args: { action: 'Ended' } }, 'player');\n    }, [urlParams.id]);\n"""
        return repl(s,old,new,'player ended')
    patch(root/'src/routes/Player/usePlayer.js',player)
    def search(s):
        s=repl(s,"const useSearch = require('./useSearch');\n","const useSearch = require('./useSearch');\nconst SenseSmartSearch = require('./SenseSmartSearch');\n",'search import')
        return repl(s,"""            <div ref={scrollContainerRef} className={styles['search-content']} onScroll={onScroll}>\n                {\n""","""            <div ref={scrollContainerRef} className={styles['search-content']} onScroll={onScroll}>\n                {query !== null ? <SenseSmartSearch query={query} /> : null}\n                {\n""",'smart search row')
    patch(root/'src/routes/Search/Search.js',search)
    p=root/'package.json';data=json.loads(p.read_text());data.setdefault('dependencies',{})['@huggingface/transformers']='3.8.1';p.write_text(json.dumps(data,indent=4)+'\n')
if __name__=='__main__':main()
