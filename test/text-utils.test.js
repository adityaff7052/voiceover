'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveLanguageCode, splitTextIntoChunks } = require('../lib/text-utils');

test('each chunk stays below the byte limit for Hindi Unicode text', () => {
  const input = ('यह एक लंबी हिंदी स्क्रिप्ट है। इसमें कई वाक्य हैं और हर वाक्य को सुरक्षित तरीके से विभाजित किया जाना चाहिए। ').repeat(130);
  const chunks = splitTextIntoChunks(input, 4400);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(Buffer.byteLength(chunk, 'utf8') <= 4400);
  }
});

test('chunking preserves all non-whitespace text and never creates empty chunks', () => {
  const input = ('This is a paragraph. यह दूसरा अनुच्छेद है। ' + 'Narration continues! ').repeat(120);
  const chunks = splitTextIntoChunks(input, 350);
  assert.ok(chunks.every((chunk) => chunk.length > 0));
  const normalize = (value) => value.replace(/\s+/gu, ' ').trim();
  assert.equal(normalize(chunks.join(' ')), normalize(input));
});

test('a single long unbroken token is still split safely at Unicode boundaries', () => {
  const input = 'क'.repeat(5000);
  const chunks = splitTextIntoChunks(input, 500);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 500));
});

test('manual language modes map to the expected Google language codes', () => {
  assert.equal(resolveLanguageCode('hindi', 'Hello'), 'hi-IN');
  assert.equal(resolveLanguageCode('english', 'नमस्ते'), 'en-IN');
  assert.equal(resolveLanguageCode('hinglish', 'aap kaise hain'), 'hi-IN');
});

test('auto mode recognizes Devanagari, common Romanized Hindi and English', () => {
  assert.equal(resolveLanguageCode('auto', 'नमस्ते, आप कैसे हैं?'), 'hi-IN');
  assert.equal(resolveLanguageCode('auto', 'Aap kaise hain, sab theek?'), 'hi-IN');
  assert.equal(resolveLanguageCode('auto', 'Welcome to the narration studio.'), 'en-IN');
});


test('four-byte Unicode characters remain intact across chunk boundaries', () => {
  const input = '🎙️'.repeat(1700);
  const chunks = splitTextIntoChunks(input, 400);
  assert.ok(chunks.length > 1);
  assert.equal(chunks.join(''), input);
  assert.ok(chunks.every((chunk) => Buffer.byteLength(chunk, 'utf8') <= 400));
});
