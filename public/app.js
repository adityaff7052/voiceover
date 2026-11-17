'use strict';

const elements = {
  script: document.getElementById('scriptInput'),
  fileInput: document.getElementById('fileInput'),
  fileName: document.getElementById('fileName'),
  wordCount: document.getElementById('wordCount'),
  charCount: document.getElementById('charCount'),
  clearButton: document.getElementById('clearButton'),
  language: document.getElementById('languageSelect'),
  engine: document.getElementById('engineSelect'),
  voice: document.getElementById('voiceSelect'),
  speed: document.getElementById('speedRange'),
  speedValue: document.getElementById('speedValue'),
  pitch: document.getElementById('pitchRange'),
  pitchValue: document.getElementById('pitchValue'),
  engineNote: document.getElementById('engineNote'),
  generate: document.getElementById('generateButton'),
  serverNotice: document.getElementById('serverNotice'),
  progressPanel: document.getElementById('progressPanel'),
  outputState: document.getElementById('outputState'),
  progressMessage: document.getElementById('progressMessage'),
  progressPercent: document.getElementById('progressPercent'),
  progressBar: document.getElementById('progressBar'),
  progressDetail: document.getElementById('progressDetail'),
  audioResult: document.getElementById('audioResult'),
  audioPlayer: document.getElementById('audioPlayer'),
  downloadButton: document.getElementById('downloadButton')
};

let maxTextChars = 120000;
let selectedVoiceId = '';
let pollToken = 0;
let isBusy = false;

function countWords(text) {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return (trimmed.match(/[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu) || []).length;
}

function countCharacters(text) {
  return Array.from(text).length;
}

function updateCounts() {
  const text = elements.script.value;
  elements.wordCount.textContent = `${countWords(text).toLocaleString()} words`;
  elements.charCount.textContent = `${countCharacters(text).toLocaleString()} / ${maxTextChars.toLocaleString()} characters`;
  elements.generate.disabled = isBusy || !text.trim() || countCharacters(text) > maxTextChars;
}

function preferredVoiceLanguage() {
  return elements.language.value === 'english' ? 'en-IN' : 'hi-IN';
}

async function loadVoices() {
  const languageCode = preferredVoiceLanguage();
  const engine = elements.engine.value;
  const oldVoice = selectedVoiceId || elements.voice.value;
  elements.voice.disabled = true;
  elements.voice.innerHTML = '<option value="">Loading voices…</option>';

  try {
    const response = await fetch(`/api/voices?languageCode=${encodeURIComponent(languageCode)}&engine=${encodeURIComponent(engine)}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load available voices.');

    elements.voice.replaceChildren();
    for (const voice of data.voices) {
      const option = document.createElement('option');
      option.value = voice.id;
      option.textContent = voice.id;
      elements.voice.append(option);
    }

    const nextVoice = data.voices.some((voice) => voice.id === oldVoice)
      ? oldVoice
      : (data.voices.some((voice) => voice.id === 'Charon') ? 'Charon'
        : (data.voices.some((voice) => voice.id === 'B') ? 'B' : data.voices[0].id));
    elements.voice.value = nextVoice;
    selectedVoiceId = nextVoice;
    elements.voice.disabled = false;
  } catch (error) {
    elements.voice.innerHTML = '<option value="">Voices unavailable</option>';
    elements.voice.disabled = true;
    showNotice(error.message);
  }
}

function updateEngineControls() {
  const isChirp = elements.engine.value === 'chirp3';
  elements.speed.disabled = false;
  elements.pitch.disabled = isChirp;
  elements.engineNote.textContent = isChirp
    ? 'Expressive HD voice with adjustable speaking speed. Pitch adjustment is available with Neural2.'
    : 'Neural2 supports adjustable speaking speed and pitch. The voice character may differ slightly from Chirp 3 HD.';
}

function showNotice(message) {
  elements.serverNotice.textContent = message;
  elements.serverNotice.hidden = false;
}

function clearNotice() {
  elements.serverNotice.textContent = '';
  elements.serverNotice.hidden = true;
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function setBusy(busy) {
  isBusy = busy;
  elements.generate.disabled = isBusy || !elements.script.value.trim() || countCharacters(elements.script.value) > maxTextChars;
  elements.generate.querySelector('span:first-child').textContent = busy ? 'Generating…' : 'Generate narration';
  elements.generate.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function setProgress(job) {
  elements.progressBar.value = job.progress || 0;
  elements.progressPercent.textContent = `${job.progress || 0}%`;
  elements.progressMessage.textContent = job.stage || 'Working…';
  elements.progressDetail.textContent = job.chunksTotal
    ? `${job.chunksDone || 0} of ${job.chunksTotal} sections processed${job.languageCode ? ` · ${job.languageCode}` : ''}`
    : 'Preparing your script.';
}

async function pollJob(jobId, token) {
  const startedAt = Date.now();
  while (token === pollToken) {
    await delay(1200);
    if (token !== pollToken) return;
    if (Date.now() - startedAt > 30 * 60 * 1000) {
      throw new Error('This generation is taking longer than expected. Refresh the page and check your server logs if it remains stuck.');
    }

    const response = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`, { cache: 'no-store' });
    const job = await response.json();
    if (!response.ok) throw new Error(job.error || 'Could not check generation status.');
    setProgress(job);

    if (job.status === 'completed') {
      elements.outputState.textContent = 'READY';
      elements.progressDetail.textContent = `Voice: ${job.voiceName || 'Google Cloud TTS'} · Language: ${job.languageCode || 'Auto'}`;
      elements.audioPlayer.src = job.audioUrl;
      elements.downloadButton.href = `${job.audioUrl}?download=1`;
      elements.audioResult.hidden = false;
      elements.audioPlayer.load();
      return;
    }
    if (job.status === 'failed') throw new Error(job.error || 'Audio generation failed.');
  }
}

async function generateAudio() {
  const text = elements.script.value;
  if (!text.trim()) {
    showNotice('Please paste or upload a script first.');
    return;
  }
  if (countCharacters(text) > maxTextChars) {
    showNotice(`Your script is longer than ${maxTextChars.toLocaleString()} characters.`);
    return;
  }

  clearNotice();
  pollToken += 1;
  const currentToken = pollToken;
  setBusy(true);
  elements.progressPanel.hidden = false;
  elements.audioResult.hidden = true;
  elements.audioPlayer.removeAttribute('src');
  elements.downloadButton.removeAttribute('href');
  elements.outputState.textContent = 'IN PROGRESS';
  elements.progressBar.value = 0;
  elements.progressPercent.textContent = '0%';
  elements.progressMessage.textContent = 'Sending your script securely…';
  elements.progressDetail.textContent = 'The server will split long text into sections and join the finished audio.';

  try {
    const response = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text,
        language: elements.language.value,
        engine: elements.engine.value,
        voiceId: elements.voice.value || selectedVoiceId,
        speakingRate: Number(elements.speed.value),
        pitch: Number(elements.pitch.value)
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The server could not start generation.');
    elements.progressDetail.textContent = `${data.chunksTotal} section${data.chunksTotal === 1 ? '' : 's'} queued for generation.`;
    await pollJob(data.jobId, currentToken);
  } catch (error) {
    elements.outputState.textContent = 'NOT READY';
    elements.progressMessage.textContent = 'Generation could not be completed';
    elements.progressDetail.textContent = error.message;
    showNotice(error.message);
  } finally {
    if (currentToken === pollToken) setBusy(false);
  }
}

async function loadConfiguration() {
  try {
    const response = await fetch('/api/config', { cache: 'no-store' });
    if (!response.ok) throw new Error('Server configuration could not be loaded.');
    const config = await response.json();
    maxTextChars = config.maxTextChars || maxTextChars;
    elements.script.maxLength = maxTextChars;
    updateCounts();
  } catch (error) {
    showNotice(error.message);
  }
}

elements.script.addEventListener('input', updateCounts);
elements.clearButton.addEventListener('click', () => {
  elements.script.value = '';
  elements.fileName.textContent = '';
  elements.fileInput.value = '';
  updateCounts();
  elements.script.focus();
});

elements.fileInput.addEventListener('change', async (event) => {
  const file = event.target.files && event.target.files[0];
  if (!file) return;
  if (!file.name.toLowerCase().endsWith('.txt') && file.type !== 'text/plain') {
    showNotice('Please choose a plain-text .txt file.');
    elements.fileInput.value = '';
    return;
  }
  if (file.size > 1024 * 1024) {
    showNotice('Please choose a text file smaller than 1 MB.');
    elements.fileInput.value = '';
    return;
  }
  try {
    const text = await file.text();
    if (countCharacters(text) > maxTextChars) {
      throw new Error(`This file is longer than the ${maxTextChars.toLocaleString()} character limit.`);
    }
    elements.script.value = text;
    elements.fileName.textContent = file.name;
    updateCounts();
    clearNotice();
  } catch (error) {
    showNotice(error.message || 'This text file could not be read.');
  }
});

elements.engine.addEventListener('change', () => {
  updateEngineControls();
  loadVoices();
});
elements.language.addEventListener('change', loadVoices);
elements.voice.addEventListener('change', () => { selectedVoiceId = elements.voice.value; });
elements.speed.addEventListener('input', () => { elements.speedValue.textContent = `${Number(elements.speed.value).toFixed(2)}×`; });
elements.pitch.addEventListener('input', () => { elements.pitchValue.textContent = Number(elements.pitch.value) > 0 ? `+${elements.pitch.value}` : elements.pitch.value; });
elements.generate.addEventListener('click', generateAudio);

updateCounts();
updateEngineControls();
loadConfiguration();
loadVoices();
