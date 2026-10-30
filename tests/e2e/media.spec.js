// Composer media: voice recording (+ transcription editing), microphone
// denial, image paste and drag & drop; batched owner notifications.
import { test, expect } from '@playwright/test';
import pg from 'pg';
import fs from 'node:fs';
import { loginAsOwner, frame, waitFrameReady, clickInFrame } from './helpers.js';

test.describe.configure({ mode: 'serial' });
const OWNER = `media-owner-${Date.now()}@example.com`;
let projectId;
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGklEQVR42mNkYPhfz0AEYBxVSF+FAP5FBQ0Gx8XyAAAAAElFTkSuQmCC';

// Simulated Web Speech API: headless Chromium has no speech service.
const fakeSpeech = (phrase) => `
  window.SpeechRecognition = window.webkitSpeechRecognition = class {
    start() { setTimeout(() => this.onresult && this.onresult({ resultIndex: 0, results: [Object.assign([{ transcript: ${JSON.stringify(phrase)} }], { isFinal: true })] }), 300); }
    stop() {}
  };`;

async function openComposer(page) {
  await page.goto(`/projects/${projectId}`);
  await waitFrameReady(page);
  await clickInFrame(page, 'img.hero-img');
  await expect(page.getByTestId('composer')).toBeVisible();
}

test('voice note: recorded, stored, transcription inserted and editable, validated', async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  await page.addInitScript(fakeSpeech('Change the image'));
  await loginAsOwner(page, OWNER);
  projectId = (await (await page.request.post('/api/projects', { data: { url: 'https://static.test/' } })).json()).project.id;
  await openComposer(page);
  await page.getByTestId('record-voice').click();
  await expect(page.getByTestId('recording')).toBeVisible();
  await page.waitForTimeout(1500);
  await page.getByTestId('recording').getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('composer').locator('audio')).toBeVisible();
  const input = page.getByTestId('comment-input');
  await expect(input).toHaveValue('Change the image');
  await expect(page.getByTestId('composer')).toContainText('review and edit');
  // the transcription is validated like typed text
  await expect(page.getByTestId('validation')).toContainText('attach the image');
  await expect(page.getByTestId('submit-comment')).toBeDisabled();
  await input.fill('Change the image to a photo of our team in the office');
  await expect(page.getByTestId('submit-comment')).toBeEnabled();
  await page.getByTestId('submit-comment').click();
  await expect(page.getByTestId('thread').locator('audio')).toBeVisible();
  const list = (await (await page.request.get(`/api/projects/${projectId}/comments`)).json()).comments;
  const audio = list[0].attachments.find((a) => a.kind === 'audio');
  expect(audio.mime).toMatch(/^audio\//);
  expect(audio.transcript).toBe('Change the image');
  const file = await page.request.get(audio.url);
  expect(file.status()).toBe(200);
  expect((await file.body()).length).toBeGreaterThan(500); // original audio is kept
});

test('voice note without speech service keeps the audio and asks for text', async ({ page, context }) => {
  await context.grantPermissions(['microphone']);
  await page.addInitScript(() => { delete window.webkitSpeechRecognition; delete window.SpeechRecognition; });
  await loginAsOwner(page, OWNER);
  await openComposer(page);
  await page.getByTestId('record-voice').click();
  await page.waitForTimeout(1000);
  await page.getByTestId('recording').getByRole('button', { name: 'Stop' }).click();
  await expect(page.getByTestId('composer').locator('audio')).toBeVisible();
  await expect(page.getByTestId('composer')).toContainText('no transcription was available');
  await expect(page.getByTestId('submit-comment')).toBeDisabled();
});

test('microphone permission denied shows a clear message', async ({ page }) => {
  await page.addInitScript(() => {
    navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
  });
  await loginAsOwner(page, OWNER);
  await openComposer(page);
  await page.getByTestId('record-voice').click();
  await expect(page.getByTestId('composer')).toContainText('Microphone access was denied');
});

test('images can be pasted and dropped into the composer', async ({ page }) => {
  await loginAsOwner(page, OWNER);
  await openComposer(page);
  await page.getByTestId('comment-input').evaluate((el, b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], 'pasted.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  await expect(page.getByTestId('composer').locator('.thumb')).toHaveCount(1);
  await page.getByTestId('composer').evaluate((el, b64) => {
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bin], 'dropped.png', { type: 'image/png' }));
    el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, PNG_B64);
  await expect(page.getByTestId('composer').locator('.thumb')).toHaveCount(2);
  await page.getByTestId('comment-input').fill('Please replace the image.');
  await expect(page.getByTestId('submit-comment')).toBeEnabled(); // image provided -> no more questions
  // a non-image file disguised as PNG is rejected server-side
  const bad = await page.request.post(`/api/projects/${projectId}/attachments`, { multipart: { file: { name: 'x.png', mimeType: 'image/png', buffer: Buffer.from('not an image') } } });
  expect(bad.status()).toBe(400);
});

test('owner notifications are batched (at most one email per interval)', async ({ page, browser }) => {
  await loginAsOwner(page, OWNER);
  const share = (await (await page.request.get(`/api/projects/${projectId}`)).json()).share.url;
  const token = share.split('/s/')[1];
  const db = new pg.Client({ connectionString: 'postgres://agm:agm@127.0.0.1:54339/agm' });
  await db.connect();
  const owner = (await db.query('SELECT id FROM users WHERE email = $1', [OWNER])).rows[0].id;
  const batches = async () => (await db.query('SELECT comment_count, sent_at FROM notification_batches WHERE owner_id = $1 ORDER BY sent_at', [owner])).rows;
  try {
    const guest = await browser.newContext();
    const api = guest.request;
    const g = await (await api.post('/api/guests', { data: { name: 'Nora Notify' } })).json();
    const headers = { 'x-share-token': token, 'x-guest-token': g.token };
    const list = (await (await api.get(`/api/projects/${projectId}/comments`, { headers })).json()).comments;
    // three guest replies in quick succession
    for (const t of ['First', 'Second', 'Third']) {
      const r = await api.post(`/api/projects/${projectId}/comments`, { headers, data: { parentId: list[0].id, body: `${t} reply` } });
      expect(r.status()).toBe(201);
    }
    await expect.poll(batches, { timeout: 20_000 }).toHaveLength(1);
    expect((await batches())[0].comment_count).toBe(3);
    // another reply right away waits for the interval (4s in tests) to pass
    await api.post(`/api/projects/${projectId}/comments`, { headers, data: { parentId: list[0].id, body: 'Fourth reply' } });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await batches()).toHaveLength(1);
    await expect.poll(batches, { timeout: 20_000 }).toHaveLength(2);
    const [a, b] = await batches();
    expect(new Date(b.sent_at) - new Date(a.sent_at)).toBeGreaterThanOrEqual(4000);
    // the owner's own activity does not notify the owner
    const own = (await db.query(`SELECT count(*)::int AS n FROM notification_queue q JOIN comments c ON c.id = q.comment_id WHERE q.owner_id = $1 AND c.author_user_id IS NOT NULL`, [owner])).rows[0].n;
    expect(own).toBe(0);
    await guest.close();
  } finally {
    await db.end();
  }
});
