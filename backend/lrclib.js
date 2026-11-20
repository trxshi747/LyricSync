const axios = require('axios');

const LRCLIB_API = 'https://lrclib.net/api';
const LRCLIB_TIMEOUT_MS = 8000;
const MAX_DURATION_DIFF_S = 3; // A fuzzy match must last within this many seconds of the Spotify track

// Lowercases and strips what often differs between Spotify and LRCLIB names:
// accents, "(feat. X)", "[Live]", " - Remastered 2011", punctuation.
function normalizeForMatch(text) {
  return String(text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[(\[][^)\]]*[)\]]/g, ' ')
    .replace(/\s-\s.*$/, ' ')
    .replace(/\b(feat|ft)\.?\s.*$/, ' ')
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, ' ')
    .trim();
}

// True when both strings are equal, or the shorter one appears in the longer one as whole words.
function wordsMatch(a, b, minContainedLength) {
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= minContainedLength && ` ${long} `.includes(` ${short} `);
}

// Picks the best synced LRCLIB result for a track, or null. Title, artist and duration must all agree,
// so a wrong song is never shown: showing nothing (and falling back to the AI) is better than wrong lyrics.
function pickBestMatch(results, trackName, artistName, durationSeconds) {
  if (!Array.isArray(results) || !Number.isFinite(durationSeconds)) return null;

  const wantedTrack = normalizeForMatch(trackName);
  const wantedArtist = normalizeForMatch(artistName);

  const candidates = results
    .filter((r) => r && r.syncedLyrics && !r.instrumental)
    .filter((r) => wordsMatch(wantedTrack, normalizeForMatch(r.trackName), 5))
    .filter((r) => wordsMatch(wantedArtist, normalizeForMatch(r.artistName), 2))
    .map((r) => ({ result: r, diff: Math.abs(Number(r.duration) - durationSeconds) }))
    .filter((c) => c.diff <= MAX_DURATION_DIFF_S)
    .sort((a, b) => a.diff - b.diff);

  return candidates.length > 0 ? candidates[0].result : null;
}

async function searchLrclib(params) {
  const { data } = await axios.get(`${LRCLIB_API}/search`, { params, timeout: LRCLIB_TIMEOUT_MS });
  return data;
}

// Finds synced lyrics. Tries the exact lookup first (fast, precise), then a fuzzy search when it misses.
// Returns { lyrics, matchType: 'exact' | 'fuzzy' } or null. Never throws.
async function findLrclibLyrics(trackName, artistName, durationSeconds, { fuzzy = true } = {}) {
  try {
    const params = { track_name: trackName, artist_name: artistName };
    if (Number.isFinite(durationSeconds)) params.duration = durationSeconds;

    const { data } = await axios.get(`${LRCLIB_API}/get`, { params, timeout: LRCLIB_TIMEOUT_MS });
    if (data && data.syncedLyrics) return { lyrics: data.syncedLyrics, matchType: 'exact' };
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.log(`LRCLIB exact lookup found nothing for ${trackName}.`);
    } else {
      console.error(`LRCLIB error: ${err.message}`);
    }
  }

  if (!fuzzy) return null;

  const cleanTrack = normalizeForMatch(trackName) || trackName;
  const queries = [
    { track_name: trackName, artist_name: artistName },
    { q: `${cleanTrack} ${artistName}` }
  ];

  for (const query of queries) {
    try {
      const best = pickBestMatch(await searchLrclib(query), trackName, artistName, durationSeconds);
      if (best) {
        console.log(`LRCLIB fuzzy match for ${trackName}: "${best.trackName}" by ${best.artistName} (${Math.round(best.duration)}s).`);
        return { lyrics: best.syncedLyrics, matchType: 'fuzzy' };
      }
    } catch (err) {
      console.error(`LRCLIB search error: ${err.message}`);
    }
  }

  return null;
}

module.exports = { findLrclibLyrics, pickBestMatch, normalizeForMatch };
