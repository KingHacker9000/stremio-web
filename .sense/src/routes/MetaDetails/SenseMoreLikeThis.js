'use strict';

const React = require('react');
const { MetaItem, MetaRow } = require('stremio/components');
const { loadSenseRuntime } = require('stremio/services/SenseRuntime');

const CANDIDATE_LIMIT = 96;
const RESULT_LIMIT = 20;
const DIVERSITY_RELEVANCE_WEIGHT = 0.72;

const toMetaItem = (hit) => ({
    id: hit.id,
    type: hit.type,
    name: hit.name,
    poster: `https://images.metahub.space/poster/small/${encodeURIComponent(hit.id)}/img`,
    posterShape: 'poster',
    href: `#/metadetails/${encodeURIComponent(hit.type)}/${encodeURIComponent(hit.id)}`,
});

const SenseMoreLikeThis = ({ metaId }) => {
    const [items, setItems] = React.useState([]);

    React.useEffect(() => {
        let disposed = false;
        setItems([]);
        if (typeof metaId !== 'string' || metaId.length === 0) return () => { disposed = true; };

        loadSenseRuntime()
            .then((runtime) => runtime.similarDiverse(metaId, CANDIDATE_LIMIT, RESULT_LIMIT, DIVERSITY_RELEVANCE_WEIGHT))
            .then((hits) => {
                if (!disposed) {
                    setItems(hits.filter((hit) => hit.type === 'movie' || hit.type === 'series').map(toMetaItem));
                }
            })
            .catch(() => { if (!disposed) setItems([]); });

        return () => { disposed = true; };
    }, [metaId]);

    if (items.length === 0) return null;

    return <MetaRow title={'More Like This'} catalog={{ items }} itemComponent={MetaItem} />;
};

module.exports = SenseMoreLikeThis;
