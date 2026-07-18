const { execFile } = require('child_process');
const util = require('util');
const execFilePromise = util.promisify(execFile);
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

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

async function getTranscribedLyrics(searchQuery, durationSeconds, promptText = null) {
  if (!process.env.GROQ_API_KEY || process.env.GROQ_API_KEY === 'your_groq_api_key') {
    console.warn("Groq API key missing or invalid. Cannot transcribe.");
    return null;
  }

  try {
    console.log(`Searching and downloading audio for: ${searchQuery}`);

    // Download Audio with standalone yt-dlp.exe (no conversion needed)
    // Groq accepts flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm
    const timestamp = Date.now();
    const tmpDir = path.join(__dirname, '..', '.tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    } else {
      // Cleanup: If there are 5 or more files left over from crashes, delete them to save space
      const existingFiles = fs.readdirSync(tmpDir);
      if (existingFiles.length >= 5) {
        console.log(`Cleaning up ${existingFiles.length} old files in .tmp directory...`);
        for (const file of existingFiles) {
          try {
            fs.unlinkSync(path.join(tmpDir, file));
          } catch (e) {
            // Ignore if file is locked
          }
        }
      }
    }

    const ytdlpPath = process.platform === 'win32' ? path.join(__dirname, 'yt-dlp.exe') : 'yt-dlp';
    const outputTemplate = path.join(tmpDir, `audio_${timestamp}.%(ext)s`);

    let actualFilePath = null;

    // Pass the exact string directly. execFile safely handles all unicode without shell crashes.
    const searchProviders = [
      `ytsearch1:${searchQuery} Topic`,
      `ytsearch1:${searchQuery} audio`,
      `ytsearch1:${searchQuery} official audio`,
      `ytsearch1:${searchQuery} lyrics`,
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
      usableCookiePath = path.join(tmpDir, 'youtube_cookies.txt');
      fs.copyFileSync(renderSecretPath, usableCookiePath);
    } else if (fs.existsSync(localCookiePath)) {
      usableCookiePath = path.join(tmpDir, 'youtube_cookies.txt');
      fs.copyFileSync(localCookiePath, usableCookiePath);
    } else if (process.env.YOUTUBE_COOKIES) {
      usableCookiePath = path.join(tmpDir, 'youtube_cookies.txt');
      fs.writeFileSync(usableCookiePath, process.env.YOUTUBE_COOKIES);
    }

    if (usableCookiePath) {
      extraArgs.push('--cookies', usableCookiePath);
    }

    for (const provider of searchProviders) {
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
        ], { timeout: 60000 }); // 60 second timeout to prevent infinite hangs
        console.log(`yt-dlp stdout:`, stdout);
        if (stderr) console.log(`yt-dlp stderr:`, stderr);

        const files = fs.readdirSync(tmpDir);
        const downloadedFileName = files.find(f => f.startsWith(`audio_${timestamp}.`));
        if (downloadedFileName) {
          actualFilePath = path.join(tmpDir, downloadedFileName);
          console.log(`Successfully downloaded audio.`);
          break; // Break the loop on success
        }
      } catch (err) {
        console.error(`yt-dlp crash for ${provider}:`, err.message || err);
        console.log(`Download failed for ${provider}. Trying next...`);
      }
    }

    if (!actualFilePath) {
      throw new Error("Downloaded audio file not found in .tmp directory. All search providers failed.");
    }

    console.log(`Uploading audio to Groq Whisper API for transcription...`);
    
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

    const response = await axios.post('https://api.groq.com/openai/v1/audio/transcriptions', formData, {
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        ...formData.getHeaders()
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });

    const jsonData = response.data;

    // Always cleanup the current tmp file if it exists
    if (actualFilePath && fs.existsSync(actualFilePath)) {
      try {
        fs.unlinkSync(actualFilePath);
      } catch (e) { }
    }

    console.log(`Received verbose_json from Groq, converting to LRC...`);
    const lrc = verboseJsonToLrc(jsonData.segments);

    return lrc;
  } catch (error) {
    console.error('Error in getTranscribedLyrics:', error.response?.data || error);
    return null;
  }
}

module.exports = {
  getTranscribedLyrics
};
