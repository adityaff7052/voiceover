'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const textToSpeech = require('@google-cloud/text-to-speech');
const { resolveLanguageCode, splitTextIntoChunks } = require('./lib/text-utils');

const app = express();
const PORT = Number(process.env.PORT || 10000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_TEXT_CHARS = clampInteger(process.env.MAX_TEXT_CHARS, 1000, 200000, 120000);
const MAX_CHUNK_BYTES = 4400; // Google Cloud TTS synchronous request limit is 5,000 bytes.
const JOB_TTL_MS = 60 * 60 * 1000;
const ERROR_TTL_MS = 10 * 60 * 1000;
const MAX_ACTIVE_JOBS = 2;
const jobs = new Map();
const voiceCache = new Map();
let ttsClient;
let activeJobs = 0;

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      baseUri: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      mediaSrc: ["'self'", 'blob:'],
      connectSrc: ["'self'"],
      upgradeInsecureRequests: []
    }
  }
}));
app.use(express.json({ limit: '1mb' }));

function clampInteger(value, min, max, fallback) {
  const number = Number.parseInt(value, 10);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

function getTtsClient() {
  if (ttsClient) return ttsClient;

  const inlineCredentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (inlineCredentials) {
    let parsed;
    try {
      parsed = JSON.parse(inlineCredentials);
    } catch {
      throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the complete service-account JSON into the server environment variable.');
    }

    if (!parsed.client_email || !parsed.private_key) {
      throw new Error('The Google service-account JSON is missing client_email or private_key.');
    }

    ttsClient = new textToSpeech.TextToSpeechClient({
      projectId: parsed.project_id || process.env.GOOGLE_CLOUD_PROJECT,
      credentials: {
        client_email: parsed.client_email,
        private_key: String(parsed.private_key).replace(/\\n/g, '\n')
      }
    });
    return ttsClient;
  }

  const options = {};
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    options.keyFilename = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  }
  if (process.env.GOOGLE_CLOUD_PROJECT) {
    options.projectId = process.env.GOOGLE_CLOUD_PROJECT;
  }

  ttsClient = new textToSpeech.TextToSpeechClient(options);
  return ttsClient;
}

function enginePattern(engine) {
  return engine === 'chirp3' ? '-Chirp3-HD-' : '-Neural2-';
}

async function getMaleVoices(languageCode, engine) {
  const key = `${languageCode}:${engine}`;
  const cached = voiceCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.voices;

  const client = getTtsClient();
  const [response] = await client.listVoices({ languageCode });
  const marker = enginePattern(engine);
  const voices = (response.voices || [])
    .filter((voice) => voice.ssmlGender === 'MALE' && voice.name.includes(marker))
    .map((voice) => ({
      id: voice.name.split('-').at(-1),
      name: voice.name,
      languageCode,
      gender: 'MALE'
    }))
    .sort((a, b) => a.id.localeCompare(b.id));

  if (!voices.length) {
    throw new Error(`Google Cloud returned no compatible male ${engine === 'chirp3' ? 'Chirp 3 HD' : 'Neural2'} voices for ${languageCode}. Check that the Text-to-Speech API is enabled and try another voice engine.`);
  }

  voiceCache.set(key, { voices, expiresAt: Date.now() + 10 * 60 * 1000 });
  return voices;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const executable = process.env.FFMPEG_PATH || 'ffmpeg';
    const child = spawn(executable, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let errorOutput = '';

    child.stderr.on('data', (chunk) => {
      errorOutput += chunk.toString();
      if (errorOutput.length > 8000) errorOutput = errorOutput.slice(-8000);
    });

    child.on('error', (error) => {
      if (error.code === 'ENOENT') {
        reject(new Error('FFmpeg was not found. The included Docker deployment installs it automatically. For local development, install FFmpeg or set FFMPEG_PATH.'));
      } else {
        reject(error);
      }
    });

    child.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`FFmpeg could not combine the audio sections. ${errorOutput.trim()}`));
    });
  });
}

function publicJob(job) {
  return {
    jobId: job.id,
    status: job.status,
    progress: job.progress,
    stage: job.stage,
    chunksDone: job.chunksDone,
    chunksTotal: job.chunksTotal,
    languageCode: job.languageCode || null,
    voiceName: job.voiceName || null,
    audioUrl: job.status === 'completed' ? `/api/jobs/${job.id}/audio` : null,
    error: job.error || null
  };
}

async function removeJobFiles(job) {
  if (job.tempDir) {
    await fs.rm(job.tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function synthesizeJob(job, options) {
  activeJobs += 1;
  job.status = 'processing';
  job.stage = 'Preparing your script';

  try {
    const languageCode = resolveLanguageCode(options.language, options.text);
    const voices = await getMaleVoices(languageCode, options.engine);
    const chosenVoice = voices.find((voice) => voice.id === options.voiceId)
      || voices.find((voice) => voice.id === (options.engine === 'chirp3' ? 'Charon' : 'B'))
      || voices[0];

    job.languageCode = languageCode;
    job.voiceName = chosenVoice.name;

    const chunks = splitTextIntoChunks(options.text);
    job.chunksTotal = chunks.length;
    job.stage = `Generating section 1 of ${chunks.length}`;

    const client = getTtsClient();
    job.tempDir = await fs.mkdtemp(path.join(os.tmpdir(), `voiceover-${job.id}-`));
    const partFiles = [];

    for (let index = 0; index < chunks.length; index += 1) {
      job.stage = `Generating section ${index + 1} of ${chunks.length}`;
      const audioConfig = {
        audioEncoding: 'LINEAR16',
        speakingRate: options.speakingRate
      };
      if (options.engine === 'neural2') {
        audioConfig.pitch = options.pitch;
      }

      const [response] = await client.synthesizeSpeech({
        input: { text: chunks[index] },
        voice: {
          languageCode,
          name: chosenVoice.name,
          ssmlGender: 'MALE'
        },
        audioConfig
      });

      if (!response.audioContent || response.audioContent.length === 0) {
        throw new Error(`Google Cloud returned empty audio for section ${index + 1}.`);
      }

      const partPath = path.join(job.tempDir, `part-${String(index + 1).padStart(4, '0')}.wav`);
      await fs.writeFile(partPath, response.audioContent);
      partFiles.push(partPath);
      job.chunksDone = index + 1;
      job.progress = Math.min(92, Math.round((job.chunksDone / chunks.length) * 92));
    }

    job.stage = 'Combining sections into one WAV';
    job.progress = 95;

    const concatFile = path.join(job.tempDir, 'audio-list.txt');
    const outputFile = path.join(job.tempDir, 'voiceover.wav');
    const concatContents = partFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n');
    await fs.writeFile(concatFile, `${concatContents}\n`, 'utf8');

    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatFile,
      '-vn',
      '-ac', '1',
      '-ar', '24000',
      '-c:a', 'pcm_s16le',
      outputFile
    ]);

    const stat = await fs.stat(outputFile);
    if (!stat.size) throw new Error('The final WAV file was empty. Please try again.');

    job.audioPath = outputFile;
    job.status = 'completed';
    job.progress = 100;
    job.stage = 'Your narration is ready';
    job.completedAt = Date.now();
  } catch (error) {
    job.status = 'failed';
    job.stage = 'Generation failed';
    job.error = sanitizeError(error);
    job.completedAt = Date.now();
    await removeJobFiles(job);
  } finally {
    job.text = null;
    activeJobs = Math.max(0, activeJobs - 1);
  }
}

function sanitizeError(error) {
  const message = String(error && error.message ? error.message : 'Unknown error');
  if (/permission|unauthenticated|credential|service account|403|401/i.test(message)) {
    return 'Google Cloud authentication failed or the service account lacks permission. Check the server credentials and Text-to-Speech API access.';
  }
  if (/quota|rate limit|resource exhausted|429/i.test(message)) {
    return 'Google Cloud reported a quota or rate limit. Wait a little and try again, or check the Text-to-Speech quotas in your Google Cloud project.';
  }
  return message.slice(0, 500);
}

const generateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: clampInteger(process.env.GENERATE_RATE_LIMIT, 1, 100, 8),
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Too many generation requests from this network. Please wait a little and try again.' }
});

app.get('/health', (_req, res) => {
  res.status(200).json({ ok: true, service: 'voiceover-studio' });
});

app.get('/api/config', (_req, res) => {
  res.json({
    maxTextChars: MAX_TEXT_CHARS,
    maxChunkBytes: MAX_CHUNK_BYTES,
    engines: ['chirp3', 'neural2'],
    languages: ['auto', 'hindi', 'english', 'hinglish']
  });
});

app.get('/api/voices', async (req, res) => {
  try {
    const languageCode = req.query.languageCode === 'en-IN' ? 'en-IN' : 'hi-IN';
    const engine = req.query.engine === 'neural2' ? 'neural2' : 'chirp3';
    const voices = await getMaleVoices(languageCode, engine);
    res.json({ voices });
  } catch (error) {
    res.status(503).json({ error: sanitizeError(error) });
  }
});

app.post('/api/generate', generateLimiter, async (req, res) => {
  const { text, language, engine, voiceId } = req.body || {};
  const speakingRate = Number(req.body && req.body.speakingRate);
  const pitch = Number(req.body && req.body.pitch);

  if (typeof text !== 'string' || !text.trim()) {
    return res.status(400).json({ error: 'Please enter some text first.' });
  }
  if (Array.from(text).length > MAX_TEXT_CHARS) {
    return res.status(413).json({ error: `Your script is longer than this deployment limit of ${MAX_TEXT_CHARS.toLocaleString()} characters.` });
  }
  if (!['auto', 'hindi', 'english', 'hinglish'].includes(language)) {
    return res.status(400).json({ error: 'Choose a supported language mode.' });
  }
  if (!['chirp3', 'neural2'].includes(engine)) {
    return res.status(400).json({ error: 'Choose a supported voice engine.' });
  }
  if (!Number.isFinite(speakingRate) || speakingRate < 0.75 || speakingRate > 1.25) {
    return res.status(400).json({ error: 'Speaking speed is outside the supported app range.' });
  }
  if (engine === 'neural2' && (!Number.isFinite(pitch) || pitch < -5 || pitch > 5)) {
    return res.status(400).json({ error: 'Pitch is outside the supported app range.' });
  }
  if (activeJobs >= MAX_ACTIVE_JOBS) {
    return res.status(429).json({ error: 'The studio is already generating two recordings. Please try again when one is finished.' });
  }

  let chunks;
  try {
    chunks = splitTextIntoChunks(text);
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
  if (!chunks.length) return res.status(400).json({ error: 'Please enter some text first.' });

  const id = crypto.randomUUID();
  const job = {
    id,
    status: 'queued',
    progress: 0,
    stage: 'Waiting to start',
    chunksDone: 0,
    chunksTotal: chunks.length,
    text,
    createdAt: Date.now(),
    audioPath: null,
    tempDir: null,
    error: null
  };
  jobs.set(id, job);

  const options = {
    text,
    language,
    engine,
    voiceId: typeof voiceId === 'string' ? voiceId.slice(0, 50) : '',
    speakingRate: Number.isFinite(speakingRate) ? speakingRate : 1,
    pitch: Number.isFinite(pitch) ? pitch : 0
  };

  res.status(202).json({ jobId: id, chunksTotal: chunks.length });
  // The job is deliberately handled after the request returns; progress is polled from /api/jobs/:id.
  synthesizeJob(job, options).catch((error) => {
    job.status = 'failed';
    job.stage = 'Generation failed';
    job.error = sanitizeError(error);
    job.completedAt = Date.now();
    activeJobs = Math.max(0, activeJobs - 1);
  });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This generation job was not found. It may have expired or the server may have restarted.' });
  res.json(publicJob(job));
});

app.get('/api/jobs/:id/audio', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This recording was not found. It may have expired or the server may have restarted.' });
  if (job.status !== 'completed' || !job.audioPath) {
    return res.status(409).json({ error: 'This recording is not ready yet.' });
  }

  const download = req.query.download === '1';
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'private, no-store');
  if (download) {
    return res.download(job.audioPath, 'voiceover-narration.wav');
  }
  return res.sendFile(job.audioPath);
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.use((error, _req, res, _next) => {
  if (error && error.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The submitted text is too large. Please use a smaller script.' });
  }
  console.error(error);
  return res.status(500).json({ error: 'An unexpected server error occurred.' });
});

const cleanupTimer = setInterval(async () => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    const expiresAt = job.status === 'failed'
      ? (job.completedAt || job.createdAt) + ERROR_TTL_MS
      : job.createdAt + JOB_TTL_MS;
    if (job.status !== 'processing' && now > expiresAt) {
      await removeJobFiles(job);
      jobs.delete(id);
    }
  }
}, 60 * 1000);
cleanupTimer.unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Voiceover Studio listening on port ${PORT}`);
});
