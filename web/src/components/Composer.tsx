import { useEffect, useRef, useState } from 'react';
import { api, ensureGuest, getGuest } from '../api';
import { Icon } from '../icons';
import { colorFor, initials } from '../util';
// Same rules engine as the server: instant feedback while typing.
import { validateFeedback } from '../../../shared/validation.js';

export type Attachment = { id: string; kind: 'image' | 'audio'; url: string; name?: string; transcript?: { text: string | null; provider: string; status: string } | null };
export type Validation = { canSubmit: boolean; questions: string[]; requiredAttachments: string[]; category: string; provider: string; fallback?: boolean };

type Props = {
  projectId: string;
  isOwner: boolean;
  ownerName?: string;
  element: { tag?: string; isImage?: boolean; text?: string } | null;
  style: React.CSSProperties;
  drawingCount: number;
  drawingActive: boolean;
  onToggleDraw: () => void;
  onCancel: () => void;
  onSubmit: (body: string, attachments: Attachment[]) => Promise<Validation | void>;
  onGuest: (name: string) => void;
};

export function NamePrompt({ onDone, compact }: { onDone: (name: string) => void; compact?: boolean }) {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const g = await ensureGuest(name.trim());
      onDone(g.name);
    } catch (er: any) {
      setErr(er.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }} data-testid="name-prompt">
      {!compact && <div><b>What's your name?</b><div className="muted small">It's shown next to your comments. No account needed.</div></div>}
      <input className="input" autoFocus placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      {err && <div className="error-text">{err}</div>}
      <button className="btn btn-primary" disabled={busy || name.trim().length < 2}>Continue</button>
    </form>
  );
}

export async function uploadFile(projectId: string, file: Blob, name: string, transcript?: string): Promise<Attachment> {
  const form = new FormData();
  form.append('file', file, name);
  if (transcript) form.append('transcript', transcript);
  const r = await api(`/projects/${projectId}/attachments`, { form });
  return r.attachment;
}

function useRecorder(onDone: (blob: Blob, mime: string, transcript: string) => void, onError: (msg: string) => void) {
  const [recording, setRecording] = useState(false);
  const [secs, setSecs] = useState(0);
  const [live, setLive] = useState('');
  const ref = useRef<any>({});
  const stop = () => {
    const r = ref.current;
    try { r.recognition?.stop(); } catch {}
    if (r.recorder?.state === 'recording') r.recorder.stop();
  };
  const start = async () => {
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') return onError('Voice recording is not supported in this browser.');
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e: any) {
      return onError(e?.name === 'NotAllowedError' ? 'Microphone access was denied. Allow microphone access in your browser to record voice feedback.' : 'No microphone could be opened.');
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
    const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    let finalText = '';
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    let recognition: any = null;
    if (SR) {
      recognition = new SR();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';
      recognition.onresult = (ev: any) => {
        let interim = '';
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          if (ev.results[i].isFinal) finalText += ev.results[i][0].transcript + ' ';
          else interim += ev.results[i][0].transcript;
        }
        setLive((finalText + interim).trim());
      };
      recognition.onerror = () => {};
      try { recognition.start(); } catch {}
    }
    recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    recorder.onerror = () => onError('Recording failed.');
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      clearInterval(ref.current.timer);
      setRecording(false);
      // Give the recogniser a moment to deliver its final result.
      setTimeout(() => onDone(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }), recorder.mimeType || 'audio/webm', finalText.trim()), 400);
    };
    recorder.start(250);
    setSecs(0);
    setLive('');
    setRecording(true);
    ref.current = { recorder, recognition, timer: setInterval(() => setSecs((s) => { if (s >= 179) stop(); return s + 1; }), 1000) };
  };
  useEffect(() => () => stop(), []);
  return { recording, secs, live, start, stop };
}

export function Composer(p: Props) {
  const guest = getGuest();
  const needsName = !p.isOwner && !guest;
  const [text, setText] = useState('');
  const [atts, setAtts] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [serverV, setServerV] = useState<{ text: string; images: number; v: Validation } | null>(null);
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [voiceNote, setVoiceNote] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const images = atts.filter((a) => a.kind === 'image').length;
  const element = p.element || {};

  const rec = useRecorder(
    async (blob, mime, transcript) => {
      setUploading((n) => n + 1);
      try {
        const ext = mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm';
        const a = await uploadFile(p.projectId, blob, `voice-note.${ext}`, transcript);
        setAtts((x) => [...x, a]);
        const t = a.transcript?.text?.trim();
        if (t) {
          setText((cur) => (cur.trim() ? cur.trim() + ' ' : '') + t);
          setVoiceNote('Transcription inserted — review and edit it before submitting.');
        } else {
          setVoiceNote('The recording is attached, but no transcription was available in this browser. Please summarise your feedback in text.');
        }
        setTimeout(() => taRef.current?.focus(), 0);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setUploading((n) => n - 1);
      }
    },
    (msg) => setError(msg),
  );

  const local: Validation = validateFeedback({ text, attachments: { images }, element });
  const fresh = serverV && serverV.text === text && serverV.images === images ? serverV.v : null;
  const v = fresh || local;
  // Submit stays disabled until the server has validated exactly the current
  // text + attachments as actionable.
  const enabled = !!fresh && fresh.canSubmit && !uploading && !rec.recording && !submitting && !needsName;

  useEffect(() => {
    if (!text.trim()) return;
    setChecking(true);
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api('/validate', { body: { text, attachments: { images }, element }, signal: ctrl.signal })
        .then((r) => setServerV({ text, images, v: r }))
        .catch((e) => { if (e.name !== 'AbortError') setServerV({ text, images, v: { ...local, fallback: true } }); })
        .finally(() => setChecking(false));
    }, 350);
    return () => { clearTimeout(t); ctrl.abort(); };
  }, [text, images]);

  const addFiles = async (files: FileList | File[]) => {
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) { setError('Only images can be attached here.'); continue; }
      setUploading((n) => n + 1);
      try {
        const a = await uploadFile(p.projectId, f, f.name || 'pasted-image.png');
        setAtts((x) => [...x, a]);
      } catch (e: any) {
        setError(e.message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const removeAtt = async (a: Attachment) => {
    setAtts((x) => x.filter((y) => y.id !== a.id));
    api(`/attachments/${a.id}`, { method: 'DELETE' }).catch(() => {});
  };
  const submit = async () => {
    if (!enabled) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await p.onSubmit(text.trim(), atts);
      if (res) setServerV({ text, images, v: res });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  };

  // Only once there is something to evaluate: showing a message on blur of an
  // empty field would shift the toolbar under the pointer mid-click.
  const showValidation = text.trim().length > 0 && !v.canSubmit && v.questions.length > 0;
  const name = p.isOwner ? p.ownerName || 'You' : guest?.name || '';

  return (
    <div
      className="pop"
      style={p.style}
      data-testid="composer"
      onMouseDown={(e) => e.stopPropagation()}
      onDragOver={(e) => { if (e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDragOver(true); } }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => { e.preventDefault(); setDragOver(false); if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files); }}
    >
      {dragOver && <div className="dropzone-hint">Drop image to attach</div>}
      <div className="pop-head">
        {needsName ? <b>New comment</b> : <><span className="avatar avatar-sm" style={{ background: colorFor(name) }}>{initials(name)}</span><b style={{ fontSize: 13 }}>{name}</b></>}
        <span className="spacer" />
        <button className="icon-btn icon-btn-sm" onClick={p.onCancel} aria-label="Cancel"><Icon.x size={16} /></button>
      </div>
      <div className="pop-body">
        {needsName ? (
          <NamePrompt onDone={(n) => p.onGuest(n)} />
        ) : (
          <>
            <div>
              <textarea
                ref={taRef}
                className="textarea"
                autoFocus
                rows={3}
                data-testid="comment-input"
                placeholder="Describe the change… (paste or drop images)"
                value={text}
                onChange={(e) => { setText(e.target.value); e.target.style.height = 'auto'; e.target.style.height = Math.min(220, e.target.scrollHeight + 2) + 'px'; }}
                onPaste={(e) => { const fs = Array.from(e.clipboardData.files || []); if (fs.length) { e.preventDefault(); addFiles(fs); } }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
                  if (e.key === 'Escape') p.onCancel();
                }}
              />
              {showValidation && (
                <div className="validation" data-testid="validation" role="alert">
                  {v.questions.length === 1 ? v.questions[0] : <ul>{v.questions.map((q) => <li key={q}>{q}</li>)}</ul>}
                </div>
              )}
              {!showValidation && checking && text && <div className="validation checking small">Checking…</div>}
              {fresh?.fallback && <div className="muted small" style={{ marginTop: 4 }}>Smart validation is unavailable — checked with built-in rules.</div>}
              {voiceNote && <div className="muted small" style={{ marginTop: 6 }}>{voiceNote}</div>}
            </div>
            {rec.recording && (
              <div className="rec" data-testid="recording">
                <span className="rec-dot" /> Recording {Math.floor(rec.secs / 60)}:{String(rec.secs % 60).padStart(2, '0')}
                <span className="spacer" />
                <button className="btn btn-sm" onClick={rec.stop}><Icon.stop size={14} /> Stop</button>
              </div>
            )}
            {rec.recording && rec.live && <div className="muted small">“{rec.live}”</div>}
            {atts.some((a) => a.kind === 'image') && (
              <div className="thumbs">
                {atts.filter((a) => a.kind === 'image').map((a) => (
                  <div className="thumb" key={a.id}><img src={a.url} alt={a.name || 'attachment'} /><button className="x" onClick={() => removeAtt(a)} aria-label="Remove">✕</button></div>
                ))}
              </div>
            )}
            {atts.filter((a) => a.kind === 'audio').map((a) => (
              <div className="audio-chip" key={a.id}>
                <div className="row small"><Icon.mic size={14} /> Voice note <span className="spacer" /><button className="btn btn-ghost btn-sm" onClick={() => removeAtt(a)}>Remove</button></div>
                <audio controls src={a.url} preload="metadata" />
              </div>
            ))}
            {p.drawingCount > 0 && <div className="muted small"><Icon.pen size={13} /> {p.drawingCount} drawing{p.drawingCount > 1 ? 's' : ''} will be added to the screenshot</div>}
            {uploading > 0 && <div className="row muted small"><span className="spinner" style={{ width: 14, height: 14 }} /> Uploading…</div>}
            {error && <div className="error-text">{error}</div>}
          </>
        )}
      </div>
      {!needsName && (
        <div className="pop-foot">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          <button className="icon-btn" title="Attach image" onClick={() => fileRef.current?.click()} data-testid="attach-image"><Icon.image /></button>
          <button className={`icon-btn ${rec.recording ? 'active' : ''}`} title={rec.recording ? 'Stop recording' : 'Record voice'} onClick={rec.recording ? rec.stop : rec.start} data-testid="record-voice"><Icon.mic /></button>
          <button className={`icon-btn ${p.drawingActive ? 'active' : ''}`} title="Draw on the page" onClick={p.onToggleDraw} data-testid="draw-toggle"><Icon.pen /></button>
          <span className="spacer" />
          <button className="btn btn-ghost" onClick={p.onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!enabled} onClick={submit} data-testid="submit-comment" title={enabled ? 'Submit (Ctrl+Enter)' : 'Add the requested details to submit'}>
            {submitting ? 'Submitting…' : 'Submit comment'}
          </button>
        </div>
      )}
    </div>
  );
}
