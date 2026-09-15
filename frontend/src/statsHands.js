// every imported hand for the stats page and the solver's opponent profiles.
// rows the server sends with a replay still need analysing (missing or older
// stats); the result is written back. cached per signed-in user.
import { apiCall, jsonBody } from './api.js';
import { analyzeHand, inferHeroName, heroSeatByName } from './sessionStats.js';

const cache = { key: null, items: null };
const plural = (n, one, many) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

export function cachedStatsHands(key) {
  return key && cache.key === key ? cache.items : null;
}

export async function loadStatsHands(key, onProgress = () => {}) {
  const items = [];
  let cursor = null;
  do {
    const res = await apiCall(`/api/stats/hands?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!res.ok) throw Object.assign(new Error(res.error || 'Could not load hands'), { code: res.code });
    for (const h of res.hands || []) items.push(h);
    cursor = res.nextCursor || null;
    onProgress(`Loading hands… ${items.length.toLocaleString('en-US')}`);
  } while (cursor);

  const stale = items.filter(it => it.replay);
  if (stale.length) {
    onProgress(`Analyzing ${plural(stale.length, 'older hand', 'older hands')}…`);
    const heroName = inferHeroName(stale.map(it => it.replay));
    const computed = [];
    for (const it of stale) {
      const seat = it.replay.hero != null ? it.replay.hero : heroSeatByName(it.replay, heroName);
      const stats = analyzeHand(it.replay, seat);
      if (stats) { it.stats = stats; computed.push({ id: it.id, stats }); }
      delete it.replay;
    }
    for (let i = 0; i < computed.length; i += 100) {
      await apiCall('/api/stats/backfill', { method: 'POST', ...jsonBody({ items: computed.slice(i, i + 100) }) });
    }
  }
  cache.key = key; cache.items = items;
  return items;
}
