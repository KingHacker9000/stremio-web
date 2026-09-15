'use strict';

const React = require('react');
const classnames = require('classnames');
const { MetaItem, MetaRow } = require('stremio/components');
const { loadSenseRuntime } = require('stremio/services/SenseRuntime');
const SenseHistory = require('stremio/services/SenseHistory');
const styles = require('./styles');

function toCatalogItems(hits) {
    return hits.map((hit) => ({
        id: hit.id,
        type: hit.type,
        name: hit.name,
        poster: hit.id.startsWith('tt') ? `https://images.metahub.space/poster/medium/${hit.id}/img` : null,
        posterShape: 'poster',
        href: `/detail/${encodeURIComponent(hit.type)}/${encodeURIComponent(hit.id)}`,
    }));
}

const SenseTopPicks = ({ continueWatching = [] }) => {
    const [catalog, setCatalog] = React.useState(null);
    const refresh = React.useCallback(() => {
        const local = SenseHistory.ids(80);
        const continuing = continueWatching.map((item) => item?._id).filter(Boolean);
        const seeds = [...new Set([...local, ...continuing])];
        if (seeds.length === 0) { setCatalog(null); return; }
        loadSenseRuntime()
            .then((runtime) => runtime.recommendFromHistory(seeds, { resultLimit: 20, candidateLimit: 220, seedLimit: 16, relevanceWeight: 0.76 }))
            .then((hits) => setCatalog(hits.length > 0 ? { items: toCatalogItems(hits) } : null))
            .catch(() => setCatalog(null));
    }, [continueWatching]);

    React.useEffect(() => {
        refresh();
        return SenseHistory.subscribe(refresh);
    }, [refresh]);

    if (!catalog) return null;
    return <MetaRow className={classnames(styles['board-row'], styles['board-row-poster'], 'animation-fade-in')} title={'Top Picks for You'} catalog={catalog} itemComponent={MetaItem} />;
};

module.exports = SenseTopPicks;
