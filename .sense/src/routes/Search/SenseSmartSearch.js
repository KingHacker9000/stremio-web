'use strict';

const React = require('react');
const classnames = require('classnames');
const { MetaItem, MetaRow } = require('stremio/components');
const { loadSenseRuntime, loadSenseSearchRuntime } = require('stremio/services/SenseRuntime');
const { encodeQuery } = require('stremio/services/SenseQueryEncoder');
const styles = require('./styles');

function cards(hits) {
    return hits.map((hit) => ({
        id: hit.id,
        type: hit.type,
        name: hit.name,
        poster: hit.id.startsWith('tt') ? `https://images.metahub.space/poster/medium/${hit.id}/img` : null,
        posterShape: 'poster',
        href: `/detail/${encodeURIComponent(hit.type)}/${encodeURIComponent(hit.id)}`,
    }));
}

const SenseSmartSearch = ({ query }) => {
    const [catalog, setCatalog] = React.useState(null);
    const [semanticReady, setSemanticReady] = React.useState(false);

    React.useEffect(() => {
        let active = true;
        const text = typeof query === 'string' ? query.trim() : '';
        if (!text) { setCatalog(null); return () => { active = false; }; }
        const runtimePromise = loadSenseSearchRuntime().catch(() => loadSenseRuntime());
        runtimePromise.then((runtime) => runtime.lexicalSearch(text, 20)).then((hits) => { if (active && hits.length > 0) setCatalog({ items: cards(hits) }); }).catch(() => {});
        const timer = setTimeout(() => {
            Promise.all([runtimePromise, encodeQuery(text)])
                .then(([runtime, vector]) => {
                    if (!active || !vector || vector.length !== runtime.dimensions) return;
                    const hits = runtime.smartSearch(text, { queryVector: vector, limit: 20 });
                    if (hits.length > 0) setCatalog({ items: cards(hits) });
                    setSemanticReady(true);
                })
                .catch(() => { if (active) setSemanticReady(false); });
        }, 180);
        return () => { active = false; clearTimeout(timer); };
    }, [query]);

    if (!catalog) return null;
    return <MetaRow className={classnames(styles['search-row'], styles['search-row-poster'], 'animation-fade-in')} title={semanticReady ? 'Smart Results' : 'Best Matches'} catalog={catalog} itemComponent={MetaItem} />;
};

module.exports = SenseSmartSearch;
