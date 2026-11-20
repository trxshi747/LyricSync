const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

// Audio download limits. The free Render instance has a tiny CPU share and yt-dlp (with the Deno challenge
// solver) can need more than a minute there, so the per-attempt limit must stay generous: too tight and
// every attempt gets killed, which is worse than waiting.
const DOWNLOAD_ATTEMPT_TIMEOUT_MS = 90000;
const DOWNLOAD_TOTAL_BUDGET_MS = 240000;
const STALE_TMP_FILE_MS = 30 * 60 * 1000;

// yt-dlp leaves partial/temporary files (.part, .ytdl, .f251.webm) when it is killed mid-download.
// They must never be mistaken for the finished audio.
const isPartialDownload = (fileName) => /\.(part|ytdl|temp)$|\.f\d+\./.test(fileName);

// Helper to convert Whisper verbose_json segments to LRC format
function verboseJsonToLrc(segments) {
  let lrcContent = '';

  if (!segments || !Array.isArray(segments)) return lrcContent;

  for (const segment of segments) {
    const startSecs = segment.start; // e.g., 14.52
    const minutes = Math.floor(startSecs / 60);
    const seconds = (startSecs % 60).toFixed(2).padStart(5, '0'); // e.g., '04.52'
    const text = segment.text || '';
    const lrcTime = `[${minutes.toString().padStart(2, '0')}:${seconds}]`;

    const hasMusicEmojis = /[🎵♪🎶]/.test(text);
    let cleanText = text.replace(/[🎵♪🎶]/g, '').trim();
    const textLower = cleanText.toLowerCase();

    // Filter out common Whisper AI hallucinations during silent/instrumental sections
    const badKeywords = [
      "subtitles", "субтитры", "dimatorzok", "amara.org", "thanks for watching",
      "subscribe to", "tanscrit", "transcrit", "transcriber", "sous-titre",
      "altyazı", "çizgi film", "ترجمة", "captioned", "provided to youtube",
      "자막" // Korean for subtitle
    ];

    let isHallucination = badKeywords.some(keyword => textLower.includes(keyword));

    if (textLower === "thank you" || textLower === "thank you." || textLower === "thank you..." ||
        textLower === "you" || textLower === "you." || textLower === "music." || textLower === "music") {
      isHallucination = true;
    }

    if (isHallucination) {
      // skip completely
    } else if (cleanText === '' && hasMusicEmojis) {
      // Whisper outputted only musical notes, meaning it's an instrumental break
      lrcContent += `${lrcTime} [INSTRUMENTAL]\n`;
    } else if (cleanText) {
      lrcContent += `${lrcTime} ${cleanText}\n`;
    }
  }
  return lrcContent;
}

async function detectLanguage(searchQuery, promptText = null) {
  try {
    let content = `Song Info: ${searchQuery}`;
    if (promptText) {
      content += `\nLyrics snippet:\n${promptText.substring(0, 500)}`;
    }

    const response = await axios.post('https://api.groq.com/openai/v1/chat/completions', {
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: "system",
          content: "You are a language detection bot. Determine the ORIGINAL spoken/sung language of the song. If the lyrics provided appear to be an English translation of a foreign song (e.g. 'Du Hast' is German), you MUST return the ISO code of the ORIGINAL language, NOT 'en'. Return ONLY the 2-letter ISO-639-1 language code (e.g. 'en', 'de', 'ru', 'fr', 'es', 'ja', 'ko'). If it is completely impossible to guess, return 'auto'."
        },
        {
          role: "user",
          content: content
        }
      ],
      temperature: 0.1
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const code = response.data.choices[0].message.content.trim().toLowerCase();
    return code.length === 2 ? code : null;
  } catch (e) {
    console.warn("Language detection failed:", e.message);
    return null;
  }
}

function isTranscriptionConfigured() {
  return Boolean(process.env.GROQ_API_KEY) && process.env.GROQ_API_KEY !== 'your_groq_api_key';
}

// Prepares .tmp and removes leftovers from crashed jobs. Only old files are removed so a
// download that is running for another track is never deleted.
function prepareTmpDir() {
  const tmpDir = path.join(__dirname, '..', '.tmp');
  if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
    return tmpDir;
  }

  for (const file of fs.readdirSync(tmpDir)) {
    const filePath = path.join(tmpDir, file);
    try {
      if (Date.now() - fs.statSync(filePath).mtimeMs > STALE_TMP_FILE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch (e) {
      // Ignore if file is locked
    }
  }
  return tmpDir;
}

// Downloads the best matching audio for a track with yt-dlp and returns the local file path.
// Slow part of the pipeline, so it is separate and can start while lyrics sources are still being queried.
async function downloadAudio(searchQuery, durationSeconds) {
  console.log(`Searching and downloading audio for: ${searchQuery}`);

  // Download Audio with standalone yt-dlp.exe (no conversion needed)
  // Groq accepts flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm
  const timestamp = Date.now();
  const tmpDir = prepareTmpDir();

  const ytdlpPath = process.platform === 'win32' ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
  const outputTemplate = path.join(tmpDir, `audio_${timestamp}.%(ext)s`);

  // Pass the exact string directly. execFile safely handles all unicode without shell crashes.
  // Ordered from most to least reliable; the duration filter below keeps wrong videos out.
  const searchProviders = [
    `ytsearch1:${searchQuery} Topic`,
    `ytsearch1:${searchQuery} official audio`,
    `ytsearch2:${searchQuery}`,
    `scsearch1:${searchQuery}`
  ];

  let matchFilter = 'duration < 600';
  if (durationSeconds) {
    // Only accept videos that closely match the Spotify track duration (-15s to +45s margin for MV intros)
    const minDur = Math.max(0, durationSeconds - 15);
    const maxDur = durationSeconds + 45;
    matchFilter = `duration > ${minDur} & duration < ${maxDur}`;
  }

  let extraArgs = [];
  const localCookiePath = path.join(__dirname, 'youtube_cookies.txt');
  const renderSecretPath = '/etc/secrets/youtube_cookies.txt';
  let usableCookiePath = null;

  if (fs.existsSync(renderSecretPath)) {
    usableCookiePath = path.join(tmpDir, `youtube_cookies_${timestamp}.txt`);
    fs.copyFileSync(renderSecretPath, usableCookiePath);
  } else if (fs.existsSync(localCookiePath)) {
    usableCookiePath = path.join(tmpDir, `youtube_cookies_${timestamp}.txt`);
    fs.copyFileSync(localCookiePath, usableCookiePath);
  } else if (process.env.YOUTUBE_COOKIES) {
    usableCookiePath = path.join(tmpDir, `youtube_cookies_${timestamp}.txt`);
    fs.writeFileSync(usableCookiePath, process.env.YOUTUBE_COOKIES);
  }

  if (usableCookiePath) {
    extraArgs.push('--cookies', usableCookiePath);
  }

  const deadline = Date.now() + DOWNLOAD_TOTAL_BUDGET_MS;
  let actualFilePath = null;
  const attemptErrors = []; // Why each attempt failed, surfaced in the job error to make failures diagnosable

  try {
    for (const provider of searchProviders) {
      const remainingMs = deadline - Date.now();
      if (remainingMs < 5000) {
        console.log(`Download time budget used up, giving up before: ${provider}`);
        break;
      }

      const attemptTimeoutMs = Math.min(DOWNLOAD_ATTEMPT_TIMEOUT_MS, remainingMs);
      console.log(`Attempting native download via: ${provider} (Target length: ${durationSeconds}s)`);
      try {
        const { stdout, stderr } = await execFilePromise(ytdlpPath, [
          '-f', 'ba[ext=m4a]/ba/best',
          '--max-filesize', '24M',
          '--match-filter', matchFilter,
          '--remote-components', 'ejs:github',
          ...extraArgs,
          '-o', outputTemplate,
          provider
        ], { timeout: attemptTimeoutMs });
        console.log(`yt-dlp stdout:`, stdout);
        if (stderr) console.log(`yt-dlp stderr:`, stderr);

        const files = fs.readdirSync(tmpDir);
        const downloadedFileName = files.find(f => f.startsWith(`audio_${timestamp}.`) && !isPartialDownload(f));
        if (downloadedFileName) {
          actualFilePath = path.join(tmpDir, downloadedFileName);
          console.log(`Successfully downloaded audio.`);
          break; // Break the loop on success
        }
        attemptErrors.push(`${provider}: no audio produced (${lastLine(`${stdout}\n${stderr}`)})`);
      } catch (err) {
        console.error(`yt-dlp crash for ${provider}:`, err.message || err);
        console.log(`Download failed for ${provider}. Trying next...`);
        const reason = err.killed ? `timed out after ${Math.round(attemptTimeoutMs / 1000)}s` : lastLine(err.stderr || err.message);
        attemptErrors.push(`${provider}: ${reason}`);
        removeAttemptFiles(tmpDir, timestamp); // A killed attempt leaves partial files behind
      }
    }
  } finally {
    // The cookies copy is only needed while yt-dlp runs
    if (usableCookiePath) {
      try { fs.unlinkSync(usableCookiePath); } catch (e) { }
    }
  }

  if (!actualFilePath) {
    const details = attemptErrors.join(' | ').slice(0, 700);
    throw new Error(`Downloaded audio file not found in .tmp directory. All search providers failed.${details ? ` Details: ${details}` : ''}`);
  }
  return actualFilePath;
}

// Deletes everything a failed download attempt left in .tmp for this job
function removeAttemptFiles(tmpDir, timestamp) {
  try {
    for (const file of fs.readdirSync(tmpDir)) {
      if (file.startsWith(`audio_${timestamp}.`)) {
        try { fs.unlinkSync(path.join(tmpDir, file)); } catch (e) { }
      }
    }
  } catch (e) { }
}

// Last non-empty line of a yt-dlp output, shortened: usually the actual ERROR message
function lastLine(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  const errorLine = [...lines].reverse().find((l) => l.startsWith('ERROR')) || lines[lines.length - 1] || 'no output';
  return errorLine.slice(0, 160);
}

// Transcribes a downloaded audio file with Whisper and returns the LRC text. Deletes the file when done.
async function transcribeAudioFile(actualFilePath, searchQuery, promptText = null) {
  try {
    const audioSize = fs.statSync(actualFilePath).size;
    if (audioSize < 10 * 1024) {
      throw new Error(`Downloaded audio is too small to be valid (${audioSize} bytes), likely an incomplete download`);
    }
    console.log(`Uploading audio (${audioSize} bytes) to Groq Whisper API for transcription...`);

    // Detect primary language to prevent Whisper from locking onto intro languages or hallucinating
    const detectedLang = await detectLanguage(searchQuery, promptText);
    if (detectedLang) {
      console.log(`Detected primary language: ${detectedLang}`);
    }

    const formData = new FormData();
    formData.append('file', fs.createReadStream(actualFilePath));
    formData.append('model', 'whisper-large-v3');
    formData.append('response_format', 'verbose_json');

    if (detectedLang) {
      formData.append('language', detectedLang);
    }
    // Whisper accepts up to 244 tokens (~800 characters) as a prompt to guide its vocabulary and alignment.
    // IMPORTANT: Do NOT use conversational instructions here. We also removed the searchQuery (title/artist) because Whisper was hallucinating it during silent sections!
    let whisperPrompt = promptText ? promptText : "";

    if (whisperPrompt) {
      const safePrompt = whisperPrompt.substring(0, 800);
      formData.append('prompt', safePrompt);
      console.log(`Attached transcription prompt from Genius to force precise alignment.`);
    }

    let response;
    try {
      response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          ...formData.getHeaders()
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity
      });
    } catch (err) {
      // Keep Groq's own explanation (and the file size) so the job error says what was actually wrong
      const status = err.response?.status;
      const detail = err.response?.data?.error?.message || err.message;
      throw new Error(`Whisper request failed${status ? ` (${status})` : ''}: ${detail} [audio ${audioSize} bytes${promptText ? ', with prompt' : ''}]`);
    }

    console.log(`Received verbose_json from Groq, converting to LRC...`);
    return verboseJsonToLrc(response.data.segments);
  } finally {
    // Always cleanup the audio file, even when transcription failed
    try {
      if (actualFilePath && fs.existsSync(actualFilePath)) fs.unlinkSync(actualFilePath);
    } catch (e) { }
  }
}

// Download + transcribe in one call (kept for scripts and tests). Returns null on any failure.
async function getTranscribedLyrics(searchQuery, durationSeconds, promptText = null) {
  if (!isTranscriptionConfigured()) {
    console.warn("Groq API key missing or invalid. Cannot transcribe.");
    return null;
  }

  try {
    const audioPath = await downloadAudio(searchQuery, durationSeconds);
    return await transcribeAudioFile(audioPath, searchQuery, promptText);
  } catch (error) {
    console.error('Error in getTranscribedLyrics:', error.response?.data || error);
    return null;
  }
}

module.exports = {
  getTranscribedLyrics,
  downloadAudio,
  transcribeAudioFile,
  isTranscriptionConfigured
};
