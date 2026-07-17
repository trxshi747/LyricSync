import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { Music, Play, Sparkles, Bot, Smartphone } from 'lucide-react';
import LyricsView from './components/LyricsView';

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

function App() {
  const [accessToken, setAccessToken] = useState(null);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [lyrics, setLyrics] = useState([]);
  const [unsyncedLyrics, setUnsyncedLyrics] = useState(null);
  const [isLoadingLyrics, setIsLoadingLyrics] = useState(false);
  const [isAiFallback, setIsAiFallback] = useState(false);
  const [progressMs, setProgressMs] = useState(0);
  const pollIntervalRef = useRef(null);

  // Smooth progress interpolation between API calls
  useEffect(() => {
    if (!currentTrack?.is_playing) return;

    const interval = setInterval(() => {
      setProgressMs(prev => prev + 100);
    }, 100);

    return () => clearInterval(interval);
  }, [currentTrack?.is_playing]);

  // Handle OAuth Callback parsing
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('access_token');
    if (token) {
      setAccessToken(token);
      // Clean up URL
      window.history.replaceState({}, document.title, "/");
    }
  }, []);

  // Poll Spotify Current Track
  useEffect(() => {
    if (!accessToken) return;

    const fetchCurrentTrack = async () => {
      try {
        const fetchStart = Date.now();
        const res = await axios.get(`${BACKEND_URL}/api/current-track`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const fetchEnd = Date.now();

        if (res.data && res.data.is_playing) {
          // Mathematically calculate the exact network latency (round-trip divided by 2)
          const latency = Math.floor((fetchEnd - fetchStart) / 2);
          setProgressMs(res.data.progress_ms + latency);

          // If track changed, fetch lyrics
          if (!currentTrack || currentTrack.track_id !== res.data.track_id) {
            setCurrentTrack(res.data);
            fetchLyrics(res.data.track_id, res.data.name, res.data.artist, res.data.duration_ms);
          }
        }
      } catch (error) {
        console.error('Error fetching current track:', error);
      }
    };

    fetchCurrentTrack();
    const interval = setInterval(fetchCurrentTrack, 1000);
    return () => clearInterval(interval);
  }, [accessToken, currentTrack]);

  // Parse LRC into array
  const parseLRC = (lrcString) => {
    const lines = lrcString.split('\n');
    const parsed = [];
    const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/;

    for (const line of lines) {
      const match = line.match(timeRegex);
      if (match) {
        const min = parseInt(match[1]);
        const sec = parseInt(match[2]);
        const msMatch = match[3];
        let ms = parseInt(msMatch);
        if (msMatch.length === 2) ms *= 10;

        const timeMs = (min * 60 * 1000) + (sec * 1000) + ms;
        const text = line.replace(timeRegex, '').trim();

        if (text) {
          parsed.push({ timeMs, text });
        }
      }
    }
    return parsed;
  };

  const fetchLyrics = async (trackId, trackName, artistName, durationMs) => {
    setIsLoadingLyrics(true);
    setLyrics([]);
    setUnsyncedLyrics(null);
    setIsAiFallback(false);

    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);

    try {
      const res = await axios.get(`${BACKEND_URL}/api/lyrics`, {
        params: { track_id: trackId, track_name: trackName, artist_name: artistName, duration_ms: durationMs }
      });

      let jobIdToPoll = null;

      if (res.data) {
        if (res.data.source === 'genius') {
          setUnsyncedLyrics(res.data.lyrics);
          setLyrics([]);
          jobIdToPoll = res.data.jobId;
          setIsLoadingLyrics(false); // Done loading initial text
        } else if (res.data.source === 'lrclib') {
          setLyrics(parseLRC(res.data.lyrics));
          setUnsyncedLyrics(null);
          setIsLoadingLyrics(false);
        } else if (res.data.source === 'processing') {
          jobIdToPoll = res.data.jobId;
        }

        // Start polling if AI is running in the background
        if (jobIdToPoll) {
          pollIntervalRef.current = setInterval(async () => {
            try {
              const jobRes = await axios.get(`${BACKEND_URL}/api/lyrics/job?track_id=${jobIdToPoll}`);
              if (jobRes.data && jobRes.data.status === 'completed') {
                setLyrics(parseLRC(jobRes.data.lyrics));
                setUnsyncedLyrics(null);
                setIsAiFallback(true);
                setIsLoadingLyrics(false);
                clearInterval(pollIntervalRef.current);
              } else if (jobRes.data && jobRes.data.status === 'failed') {
                console.error('Background AI job failed:', jobRes.data.error);
                setIsLoadingLyrics(false);
                clearInterval(pollIntervalRef.current);
              }
            } catch (e) {
              console.error('Job polling failed', e);
            }
          }, 3000);
        }
      }
    } catch (error) {
      console.error('Failed to fetch lyrics:', error);
      setIsLoadingLyrics(false);
    }
  };

  const handleLogin = () => {
    window.location.href = `${BACKEND_URL}/auth/login`;
  };

  return (
    <div className="app-container" style={{
      backgroundImage: currentTrack?.image_url ? `url(${currentTrack.image_url})` : 'none',
    }}>
      <div className="bg-overlay"></div>

      <div className="content-wrapper">
        <header className="header">
          <div className="logo">
            <Music className="logo-icon" size={28} />
            LyricSync
          </div>
        </header>

        {!accessToken ? (
          <main className="landing-page">
            <div className="landing-content">
              <h1 className="landing-title">
                Sing along with <br /><span className="highlight">perfect precision.</span>
              </h1>
              <p className="landing-subtitle">
                Connect your Spotify account to experience real-time, beautifully synced lyrics. Powered by LRCLIB and cutting-edge Whisper AI for tracks that don't even have lyrics yet.
              </p>

              <div className="landing-features">
                <div className="feature-card">
                  <Sparkles className="feature-icon" size={24} />
                  <div className="feature-text">
                    <h3>Real-Time Sync</h3>
                    <p>Perfectly timed lyrics synced directly to your Spotify playback.</p>
                  </div>
                </div>
                <div className="feature-card">
                  <Bot className="feature-icon" size={24} />
                  <div className="feature-text">
                    <h3>Whisper AI Fallback</h3>
                    <p>Missing lyrics? AI transcribes them on the fly.</p>
                  </div>
                </div>
                <div className="feature-card">
                  <Smartphone className="feature-icon" size={24} />
                  <div className="feature-text">
                    <h3>Cross-Platform</h3>
                    <p>Flawless experience on both desktop and mobile.</p>
                  </div>
                </div>
              </div>

              <button className="login-btn large-login" onClick={handleLogin}>
                Connect with Spotify
              </button>
            </div>
            <div className="landing-visual">
              <div className="glow-orb primary"></div>
              <div className="glow-orb secondary"></div>
              <div className="glass-card mockup">
                <div className="mockup-header">
                  <div className="mockup-dot"></div>
                  <div className="mockup-dot"></div>
                  <div className="mockup-dot"></div>
                </div>
                <div className="mockup-body">
                  <div className="mockup-line passed">I'm blinded by your face</div>
                  <div className="mockup-line active">You're just in the way</div>
                  <div className="mockup-line">Fly away with my wings</div>
                </div>
              </div>
            </div>
          </main>
        ) : (
          <main className="main-display">
            <div className="track-info">
              {currentTrack ? (
                <>
                  <img
                    src={currentTrack.image_url}
                    alt="Album Art"
                    className={`album-art ${currentTrack.is_playing ? 'spinning' : ''}`}
                  />
                  <div className="track-details">
                    <div className="track-name">{currentTrack.name}</div>
                    <div className="track-artist">{currentTrack.artist}</div>
                  </div>
                  <div className="status-badge">
                    <div className="pulse"></div>
                    Listening
                  </div>
                </>
              ) : (
                <div className="track-details">
                  <div className="track-name">Waiting for music...</div>
                  <div className="track-artist">Play a song on Spotify to see lyrics.</div>
                </div>
              )}
            </div>

            <div style={{ flex: 1, height: '100%', minHeight: 0, position: 'relative' }}>
              {currentTrack && (
                <LyricsView
                  lyrics={lyrics}
                  unsyncedLyrics={unsyncedLyrics}
                  progressMs={progressMs}
                  isLoading={isLoadingLyrics}
                  isAiFallback={isAiFallback}
                />
              )}
            </div>
          </main>
        )}

        <div className="credits-link">
          <a
            href="https://www.instagram.com/yassirkarrouti/"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'rgba(255,255,255,0.6)', textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: '8px', fontSize: '14px', transition: 'color 0.2s' }}
            onMouseOver={(e) => e.currentTarget.style.color = 'white'}
            onMouseOut={(e) => e.currentTarget.style.color = 'rgba(255,255,255,0.6)'}
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect width="20" height="20" x="2" y="2" rx="5" ry="5" /><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z" /><line x1="17.5" x2="17.51" y1="6.5" y2="6.5" /></svg>
            Created by @yassirkarrouti
          </a>
        </div>
      </div>
    </div>
  );
}

export default App;
