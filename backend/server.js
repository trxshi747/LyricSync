const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const SpotifyWebApi = require('spotify-web-api-node');
const axios = require('axios');
const Genius = require('genius-lyrics');
const { getTranscribedLyrics } = require('./transcriber');

dotenv.config({ path: '../.env' }); // Load from parent directory

const app = express();
const port = 3001;
const geniusClient = new Genius.Client();

// In-memory store for background AI transcription jobs
const aiJobs = new Map();

async function runBackgroundAiJob(trackId, trackName, artistName, durationSeconds, geniusLyrics = null) {
  if (aiJobs.has(trackId)) return; // Already running or completed
  
  aiJobs.set(trackId, { status: 'syncing', lyrics: null });
  console.log(`[Job ${trackId}] Started background AI Transcription for ${trackName}...`);
  
  try {
    const generatedLrc = await getTranscribedLyrics(`${trackName} ${artistName}`, durationSeconds, geniusLyrics);
    if (generatedLrc) {
      aiJobs.set(trackId, { status: 'completed', lyrics: generatedLrc });
      console.log(`[Job ${trackId}] Successfully completed.`);
    } else {
      aiJobs.set(trackId, { status: 'failed', error: 'Empty output' });
    }
  } catch (error) {
    console.error(`[Job ${trackId}] Failed: ${error.message}`);
    aiJobs.set(trackId, { status: 'failed', error: error.message });
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

// --- API Endpoints ---

app.get('/api/current-track', async (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  
  const token = authHeader.split(' ')[1];
  const tempApi = new SpotifyWebApi({ accessToken: token });

  try {
    const data = await tempApi.getMyCurrentPlayingTrack();
    if (!data.body || !data.body.item) {
      return res.json({ is_playing: false });
    }
    
    const track = data.body.item;
    res.json({
      is_playing: data.body.is_playing,
      progress_ms: data.body.progress_ms,
      track_id: track.id,
      name: track.name,
      artist: track.artists[0].name,
      album: track.album.name,
      duration_ms: track.duration_ms,
      image_url: track.album.images.length > 0 ? track.album.images[0].url : null,
    });
  } catch (error) {
    console.error('Error getting current track:', error);
    if (error.statusCode === 403) {
      return res.status(403).json({ error: 'Premium required' });
    }
    res.status(500).json({ error: 'Failed to fetch current track' });
  }
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

app.get('/api/lyrics', async (req, res) => {
  const { track_id, track_name, artist_name, duration_ms } = req.query;
  
  if (!track_name || !artist_name || !track_id) {
    return res.status(400).json({ error: 'Missing track info' });
  }

  const durationSeconds = Math.round(parseInt(duration_ms) / 1000);

  // 1. Try LRCLIB API first
  try {
    const lrclibUrl = `https://lrclib.net/api/get?track_name=${encodeURIComponent(track_name)}&artist_name=${encodeURIComponent(artist_name)}&duration=${durationSeconds}`;
    
    console.log(`Checking LRCLIB: ${lrclibUrl}`);
    const lrcRes = await axios.get(lrclibUrl);
    
    if (lrcRes.data && lrcRes.data.syncedLyrics) {
      console.log(`Found synced lyrics for ${track_name} on LRCLIB.`);
      return res.json({ 
        source: 'lrclib', 
        lyrics: lrcRes.data.syncedLyrics 
      });
    }
  } catch (err) {
    if (err.response && err.response.status === 404) {
      console.log(`No lyrics found on LRCLIB for ${track_name}. Falling back to AI...`);
    } else {
      console.error(`LRCLIB error: ${err.message}`);
    }
  }

  // 2. Try Genius API (Plain Lyrics)
  try {
    console.log(`Checking Genius: ${track_name} by ${artist_name}`);
    const searches = await geniusClient.songs.search(`${track_name} ${artist_name}`);
    
    if (searches && searches.length > 0) {
      const bestMatch = searches[0];
      const lyricsText = await bestMatch.lyrics();
      
      if (lyricsText && lyricsText.trim() !== '') {
        console.log(`Found plain lyrics on Genius for ${track_name}. Starting background sync with prompt assistance...`);
        runBackgroundAiJob(track_id, track_name, artist_name, durationSeconds, lyricsText);
        return res.json({ 
          source: 'genius', 
          lyrics: lyricsText,
          jobId: track_id
        });
      }
    }
    console.log(`No lyrics found on Genius for ${track_name}. Starting background sync...`);
  } catch (error) {
    console.log(`Genius API failed: ${error.message}. Starting background sync...`);
  }

  // 3. AI Fallback: Triggered in background because both LRCLIB and Genius didn't provide synced lyrics
  runBackgroundAiJob(track_id, track_name, artist_name, durationSeconds);
  
  return res.json({
    source: 'processing',
    jobId: track_id
  });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
