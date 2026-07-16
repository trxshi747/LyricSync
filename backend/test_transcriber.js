const { getTranscribedLyrics } = require('./transcriber');
const dotenv = require('dotenv');
dotenv.config({ path: '../.env' });

(async () => {
  console.log("Testing transcription...");
  const result = await getTranscribedLyrics('༒Lustrous Dungeon Legion༒ △Sco△ audio');
  console.log("Result:", result);
})();
