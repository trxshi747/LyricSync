const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const SpotifyWebApi = require('spotify-web-api-node');
const axios = require('axios');
const Genius = require('genius-lyrics');
const crypto = require('crypto');
const { downloadAudio, transcribeAudioFile, isTranscriptionConfigured } = require('./transcriber');
const cache = require('./cache');
const { findLrclibLyrics } = require('./lrclib');

const DAY_S = 24 * 60 * 60;
const LRCLIB_CACHE_TTL_S = 14 * DAY_S;
const AI_LYRICS_CACHE_TTL_S = 90 * DAY_S; // AI transcription is slow and costly, keep it long
const TRANSLATION_CACHE_TTL_S = 90 * DAY_S;
const lyricsCacheKey = (trackId) => `lyrics:v1:${trackId}`;

dotenv.config({ path: '../.env' }); // Load from parent directory

const app = express();
const port = 3001;
const geniusClient = new Genius.Client();

// In-memory store for background AI transcription jobs
const aiJobs = new Map();

const FAILED_JOB_RETRY_MS = 5 * 60 * 1000; // A failed track can be retried after this delay
const GENIUS_TIMEOUT_MS = 6000;

// Looks up plain lyrics on Genius. Never rejects: resolves to null when nothing is found, on error or on timeout.
async function fetchGeniusLyrics(trackName, artistName) {
  let timer;
  try {
    console.log(`Checking Genius: ${trackName} by ${artistName}`);
    const lookup = (async () => {
      const searches = await geniusClient.songs.search(`${trackName} ${artistName}`);
      if (!searches || searches.length === 0) return null;
      const lyricsText = await searches[0].lyrics();
      return lyricsText && lyricsText.trim() !== '' ? lyricsText : null;
    })();
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        console.log(`Genius lookup timed out after ${GENIUS_TIMEOUT_MS}ms for ${trackName}.`);
        resolve(null);
      }, GENIUS_TIMEOUT_MS);
    });
    return await Promise.race([lookup, timeout]);
  } catch (error) {
    console.log(`Genius API failed: ${error.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// geniusLyricsPromise resolves to the Genius text (or null). The audio download starts immediately and
// runs in parallel with it, since Genius is only needed later as a guide for Whisper.
async function runBackgroundAiJob(trackId, trackName, artistName, durationSeconds, geniusLyricsPromise = Promise.resolve(null)) {
  const existing = aiJobs.get(trackId);
  if (existing) {
    const canRetry = existing.status === 'failed' && Date.now() - existing.finishedAt > FAILED_JOB_RETRY_MS;
    if (!canRetry) return; // Already running, completed, or failed too recently to retry
  }

  const failJob = (error) => aiJobs.set(trackId, { status: 'failed', error, finishedAt: Date.now() });

  if (!isTranscriptionConfigured()) {
    console.warn("Groq API key missing or invalid. Cannot transcribe.");
    return failJob('Groq API key missing');
  }

  aiJobs.set(trackId, { status: 'syncing', lyrics: null });
  console.log(`[Job ${trackId}] Started background AI Transcription for ${trackName}...`);

  try {
    const searchQuery = `${trackName} ${artistName}`;
    const audioPromise = downloadAudio(searchQuery, durationSeconds);
    audioPromise.catch(() => {}); // The error is handled below; this avoids an unhandled rejection while Genius is awaited

    const geniusLyrics = await geniusLyricsPromise;
    const audioPath = await audioPromise;

    const generatedLrc = await transcribeAudioFile(audioPath, searchQuery, geniusLyrics);
    if (generatedLrc) {
      aiJobs.set(trackId, { status: 'completed', lyrics: generatedLrc });
      await cache.set(lyricsCacheKey(trackId), generatedLrc, AI_LYRICS_CACHE_TTL_S);
      console.log(`[Job ${trackId}] Successfully completed.`);
    } else {
      failJob('Empty output');
    }
  } catch (error) {
    console.error(`[Job ${trackId}] Failed: ${error.message}`);
    failJob(error.message);
  }
}

app.use(cors());
app.use(express.json());

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://localhost:3001/auth/callback'
});

const scopes = [
  'user-read-currently-playing',
  'user-read-playback-state',
];

app.get('/auth/login', (req, res) => {
  const state = Math.random().toString(36).substring(7);
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);
  res.redirect(authorizeURL);
});

app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) {
    return res.status(400).send('No code provided');
  }
  try {
    const data = await spotifyApi.authorizationCodeGrant(code);
    const { access_token, refresh_token, expires_in } = data.body;

    spotifyApi.setAccessToken(access_token);
    spotifyApi.setRefreshToken(refresh_token);

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    // Redirect to frontend with tokens
    res.redirect(`${frontendUrl}/?access_token=${access_token}&refresh_token=${refresh_token}`);
  } catch (error) {
    console.error('Error during auth callback', error);
    res.status(500).send('Authentication Failed');
  }
});

app.post('/auth/refresh', async (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) return res.status(400).send('No refresh token');

  const tempApi = new SpotifyWebApi({
    clientId: process.env.SPOTIFY_CLIENT_ID,
    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    refreshToken: refresh_token
  });

  try {
    const data = await tempApi.refreshAccessToken();
    res.json({ access_token: data.body.access_token });
  } catch (err) {
    res.status(500).json({ error: 'Could not refresh token' });
  }
});

// Lightweight endpoint used by the keep-alive pinger so the free Render instance doesn't go to sleep
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
});

// --- API Endpoints ---

const CURRENT_TRACK_COALESCE_MS = 800;
const DEFAULT_RETRY_AFTER_S = 5;
const MAX_TRACKED_TOKENS = 200;
const currentTrackRequests = new Map(); // token -> { promise, at }: requests made within the same moment share one Spotify call
const rateLimitedUntil = new Map(); // token -> timestamp: Spotify asked us to wait, so don't call it again before then

// Asks Spotify what is playing and returns { status, body } for the HTTP response. Never throws.
async function loadCurrentTrack(token) {
  const api = new SpotifyWebApi({ accessToken: token });

  try {
    const data = await api.getMyCurrentPlayingTrack();
    const track = data.body && data.body.item;
    if (!track) {
      return { status: 200, body: { is_playing: false } };
    }

    const artist = track.artists?.[0]?.name || 'Unknown artist';
    return {
      status: 200,
      body: {
        is_playing: data.body.is_playing,
        progress_ms: data.body.progress_ms,
        // Local files have no Spotify id; build a stable one so the track is still detected
        track_id: track.id || `local:${track.name}:${artist}:${track.duration_ms}`,
        name: track.name,
        artist,
        album: track.album?.name || '',
        duration_ms: track.duration_ms,
        image_url: track.album?.images?.length > 0 ? track.album.images[0].url : null,
      }
    };
  } catch (error) {
    if (error.statusCode === 401) {
      return { status: 401, body: { error: 'Token expired' } };
    }
    if (error.statusCode === 403) {
      return { status: 403, body: { error: 'Premium required' } };
    }
    if (error.statusCode === 429) {
      const retryAfter = Number(error.headers?.['retry-after']) || DEFAULT_RETRY_AFTER_S;
      rateLimitedUntil.set(token, Date.now() + retryAfter * 1000);
      if (rateLimitedUntil.size > MAX_TRACKED_TOKENS) {
        rateLimitedUntil.delete(rateLimitedUntil.keys().next().value);
      }
      console.warn(`Spotify rate limit hit, backing off for ${retryAfter}s.`);
      return { status: 429, body: { error: 'Rate limited by Spotify', retry_after: retryAfter } };
    }
    console.error('Error getting current track:', error.statusCode || '', error.message);
    return { status: 500, body: { error: 'Failed to fetch current track' } };
  }
}

function getCurrentTrack(token) {
  // While Spotify asks us to wait, answer without calling it: hammering it only prolongs the block
  const blockedUntil = rateLimitedUntil.get(token);
  if (blockedUntil) {
    if (blockedUntil > Date.now()) {
      const retryAfter = Math.ceil((blockedUntil - Date.now()) / 1000);
      return Promise.resolve({ status: 429, body: { error: 'Rate limited by Spotify', retry_after: retryAfter } });
    }
    rateLimitedUntil.delete(token);
  }

  // Several tabs or overlapping requests for the same user share a single Spotify call
  const recent = currentTrackRequests.get(token);
  if (recent && Date.now() - recent.at < CURRENT_TRACK_COALESCE_MS) return recent.promise;

  const promise = loadCurrentTrack(token);
  currentTrackRequests.set(token, { promise, at: Date.now() });
  if (currentTrackRequests.size > MAX_TRACKED_TOKENS) {
    currentTrackRequests.delete(currentTrackRequests.keys().next().value); // Drop the oldest entry
  }
  return promise;
}

app.get('/api/current-track', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  const { status, body } = await getCurrentTrack(token);
  if (status === 429) res.set('Retry-After', String(body.retry_after));
  res.status(status).json(body);
});

app.get('/api/lyrics/job', (req, res) => {
  const { track_id } = req.query;
  if (!track_id) return res.status(400).json({ error: 'Missing track_id' });

  const job = aiJobs.get(track_id);
  if (!job) {
    return res.json({ status: 'not_found' });
  }

  res.json(job);
});

// llama-3.3-70b-versatile is no longer served by Groq; gpt-oss-120b handles Arabic well
const TRANSLATION_MODEL = 'openai/gpt-oss-120b';
const TRANSLATION_LANGUAGES = { en: 'English', ar: 'Arabic' };

// Extra style rules per target language, appended to the shared translator brief
const TRANSLATION_STYLE_NOTES = {
  en: "Use natural, idiomatic English that a native speaker would sing or say.",
  ar: "Write natural, fluent Modern Standard Arabic in a poetic register, never word-for-word. Use Arabic punctuation (، ؟). Make grammatical gender and number agree with the real narrator and addressee identified in your context analysis. Do not add diacritics (tashkeel) unless needed to avoid ambiguity. Use Arabic script only, except for names and brand names you keep as-is."
};

function buildTranslationPrompt(targetLang, trackName, artistName) {
  const languageName = TRANSLATION_LANGUAGES[targetLang];
  const songInfo = trackName ? `The song is "${trackName}"${artistName ? ` by ${artistName}` : ''}. ` : '';

  return `You are a professional literary translator specialised in song lyrics. ${songInfo}You will receive the full lyrics, one line per row, each prefixed by 'id::'. Blank rows separate stanzas.

First, silently analyse the whole song: the narrator, who is addressed (and their gender), the emotional arc, the source language or dialect, slang, idioms, metaphors and cultural references. Then translate every line into ${languageName}, faithful to that analysis.

Rules:
- Translate meaning, tone and imagery, not words. Render idioms and slang with an equivalent expression in ${languageName}; never translate them literally.
- Keep the translation consistent across the song: the same narrator and addressee, and the same rendering for repeated lines and refrains.
- Keep exactly one translated line per input id, in the same order. Never merge, split, skip or reorder lines.
- Keep proper names, ad-libs and onomatopoeia (yeah, oh, la la) as they are.
- If a line is already in ${languageName}, return it unchanged.
- ${TRANSLATION_STYLE_NOTES[targetLang]}

Return only a valid JSON object with two keys: 'context' (a one or two sentence summary of your analysis) followed by 'translations' (an array of objects, each with a numeric 'id' and a string 'text' holding the translated line).`;
}

app.post('/api/translate', async (req, res) => {
  const { lyricsArray, targetLang = 'en', trackName, artistName } = req.body;
  if (!lyricsArray || !Array.isArray(lyricsArray) || lyricsArray.length === 0) {
    return res.status(400).json({ error: 'Missing or empty lyricsArray' });
  }
  if (!TRANSLATION_LANGUAGES[targetLang]) {
    return res.status(400).json({ error: `Unsupported targetLang. Use one of: ${Object.keys(TRANSLATION_LANGUAGES).join(', ')}` });
  }

  // Same lines and language always give the same translation, so cache by content hash
  const translationKey = `translation:v1:${targetLang}:${crypto
    .createHash('sha1')
    .update(JSON.stringify(lyricsArray.map((l) => l.text)))
    .digest('hex')}`;
  const cachedTranslation = await cache.get(translationKey);
  if (cachedTranslation) {
    return res.json({ translatedLyrics: cachedTranslation, targetLang, cached: true });
  }

  try {
    // Send blank rows for empty/instrumental lines so the model sees the stanza structure without translating them
    const textLines = lyricsArray
      .map((l, i) => (l.text && l.text.trim() && l.text !== '[INSTRUMENTAL]' ? `${i}::${l.text}` : ''))
      .join('\n');

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: TRANSLATION_MODEL,
      response_format: { type: "json_object" },
      reasoning_effort: 'low', // Reasoning tokens count toward max_tokens
      messages: [
        {
          role: "system",
          content: buildTranslationPrompt(targetLang, trackName, artistName)
        },
        {
          role: "user",
          content: textLines
        }
      ],
      temperature: 0.3,
      max_tokens: 8192 // Arabic text uses many tokens per line
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const translatedContent = response.data.choices[0].message.content;
    const parsedData = JSON.parse(translatedContent);
    const translations = parsedData.translations || [];

    // Parse the translated lines back into the array
    const translatedArray = [...lyricsArray];
    const isSentLine = (line) => line && line.text && line.text.trim() && line.text !== '[INSTRUMENTAL]';
    const translatedIndexes = new Set();

    for (const item of translations) {
      const index = parseInt(item.id);
      const translatedText = item.text;
      const original = translatedArray[index];
      // Only accept text for lines we actually sent; blank and instrumental lines stay untouched
      if (!isNaN(index) && isSentLine(original) && typeof translatedText === 'string' && translatedText.trim()) {
        translatedArray[index] = { ...original, text: translatedText.trim() };
        translatedIndexes.add(index);
      }
    }

    // Only cache complete translations: a partial result should be retried next time
    const isComplete = lyricsArray.every((line, i) => !isSentLine(line) || translatedIndexes.has(i));
    if (isComplete) cache.set(translationKey, translatedArray, TRANSLATION_CACHE_TTL_S);

    res.json({ translatedLyrics: translatedArray, targetLang });
  } catch (error) {
    console.error('Error translating lyrics:', error.response?.data || error.message);
    res.status(500).json({ error: 'Translation failed' });
  }
});

app.get('/api/lyrics', async (req, res) => {
  const { track_id, track_name, artist_name, duration_ms } = req.query;

  if (!track_name || !artist_name || !track_id) {
    return res.status(400).json({ error: 'Missing track info' });
  }

  const durationSeconds = Math.round(parseInt(duration_ms) / 1000);

  // 0. Already resolved before (LRCLIB or a finished AI transcription): answer instantly
  const cachedLyrics = await cache.get(lyricsCacheKey(track_id));
  if (cachedLyrics) {
    console.log(`Cache hit for ${track_name}.`);
    return res.json({ source: 'lrclib', lyrics: cachedLyrics, cached: true });
  }

  // 1. Try LRCLIB first: exact lookup, then a strict fuzzy search (set LRCLIB_FUZZY_SEARCH=false to turn the fuzzy step off)
  console.log(`Checking LRCLIB: ${track_name} by ${artist_name} (${durationSeconds}s)`);
  const lrclibMatch = await findLrclibLyrics(track_name, artist_name, durationSeconds, {
    fuzzy: process.env.LRCLIB_FUZZY_SEARCH !== 'false'
  });

  if (lrclibMatch) {
    console.log(`Found synced lyrics for ${track_name} on LRCLIB (${lrclibMatch.matchType} match).`);
    cache.set(lyricsCacheKey(track_id), lrclibMatch.lyrics, LRCLIB_CACHE_TTL_S);
    return res.json({
      source: 'lrclib',
      lyrics: lrclibMatch.lyrics
    });
  }
  console.log(`No lyrics found on LRCLIB for ${track_name}. Falling back to AI...`);

  // 2. No synced lyrics: start the Genius lookup (plain text) and the AI job together.
  // The job begins downloading audio right away and uses the Genius text later as a guide for Whisper.
  const geniusPromise = fetchGeniusLyrics(track_name, artist_name);
  runBackgroundAiJob(track_id, track_name, artist_name, durationSeconds, geniusPromise);

  const lyricsText = await geniusPromise;
  if (lyricsText) {
    console.log(`Found plain lyrics on Genius for ${track_name}. AI sync is running in the background.`);
    return res.json({
      source: 'genius',
      lyrics: lyricsText,
      jobId: track_id
    });
  }

  console.log(`No lyrics found on Genius for ${track_name}. AI sync is running in the background.`);
  return res.json({
    source: 'processing',
    jobId: track_id
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
