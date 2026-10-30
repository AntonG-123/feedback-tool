// Server-side speech-to-text providers. When none is configured, the browser
// transcribes with the Web Speech API while recording and sends the text
// along with the audio (provider "browser-speech").
import { config } from '../config.js';

export function serverTranscriptionProvider() {
  if (config.transcription.openaiApiKey) return 'openai';
  if (config.transcription.deepgramApiKey) return 'deepgram';
  return null;
}

export async function transcribe(buffer, mime) {
  const provider = serverTranscriptionProvider();
  if (provider === 'openai') {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mime }), 'audio.' + (mime.includes('mp4') ? 'mp4' : mime.includes('ogg') ? 'ogg' : 'webm'));
    form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'whisper-1');
    const r = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST', headers: { Authorization: `Bearer ${config.transcription.openaiApiKey}` }, body: form, signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`OpenAI transcription failed: ${r.status}`);
    return { provider, text: (await r.json()).text || '' };
  }
  if (provider === 'deepgram') {
    const r = await fetch('https://api.deepgram.com/v1/listen?smart_format=true&detect_language=true', {
      method: 'POST', headers: { Authorization: `Token ${config.transcription.deepgramApiKey}`, 'Content-Type': mime }, body: buffer, signal: AbortSignal.timeout(60000),
    });
    if (!r.ok) throw new Error(`Deepgram transcription failed: ${r.status}`);
    const j = await r.json();
    return { provider, text: j.results?.channels?.[0]?.alternatives?.[0]?.transcript || '' };
  }
  return null;
}
