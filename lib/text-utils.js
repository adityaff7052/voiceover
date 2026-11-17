'use strict';

function resolveLanguageCode(language, text) {
  if (language === 'hindi' || language === 'hinglish') return 'hi-IN';
  if (language === 'english') return 'en-IN';

  // Auto mode: Devanagari is a strong Hindi signal. For Latin-script Hinglish,
  // a small set of distinctive Hindi words is used as a best-effort heuristic.
  if (/[\u0900-\u097F]/u.test(text)) return 'hi-IN';
  const words = (text.toLowerCase().match(/[a-z]+/g) || []);
  const markers = new Set([
    'aap', 'accha', 'achha', 'abhi', 'bahut', 'hain', 'hai', 'hoon', 'ho',
    'kaise', 'kahan', 'kaun', 'kyun', 'kyunki', 'kya', 'mera', 'meri',
    'nahi', 'nahin', 'tum', 'tumhara', 'yaar', 'wala', 'wali'
  ]);
  const hits = words.reduce((count, word) => count + (markers.has(word) ? 1 : 0), 0);
  return hits >= 2 ? 'hi-IN' : 'en-IN';
}

function splitTextIntoChunks(input, maxBytes = 4400) {
  if (typeof input !== 'string') throw new TypeError('Text must be a string.');
  if (!Number.isInteger(maxBytes) || maxBytes < 8) throw new RangeError('maxBytes must be an integer of at least 8.');

  let remaining = input.trim();
  const chunks = [];

  while (Buffer.byteLength(remaining, 'utf8') > maxBytes) {
    let bytes = 0;
    let safeEnd = 0;
    let lastSentenceEnd = 0;
    let lastWhitespaceEnd = 0;

    for (const character of remaining) {
      const charBytes = Buffer.byteLength(character, 'utf8');
      if (bytes + charBytes > maxBytes) break;
      bytes += charBytes;
      safeEnd += character.length; // UTF-16 length; iteration is Unicode-code-point safe.

      if (/[.!?।॥\n]/u.test(character)) lastSentenceEnd = safeEnd;
      if (/\s/u.test(character)) lastWhitespaceEnd = safeEnd;
    }

    const cut = lastSentenceEnd >= Math.floor(maxBytes * 0.55)
      ? lastSentenceEnd
      : (lastWhitespaceEnd || safeEnd);

    if (cut <= 0) {
      throw new Error('Unable to split this text safely. Please remove an unusually long unbroken string.');
    }

    const chunk = remaining.slice(0, cut).trim();
    if (chunk) chunks.push(chunk);
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

module.exports = { resolveLanguageCode, splitTextIntoChunks };
