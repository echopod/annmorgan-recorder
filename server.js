'use strict';

const express = require('express');
const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLOUDINARY_CLOUD  = process.env.CLOUDINARY_CLOUD_NAME  || 'dpdr82xba';
const CLOUDINARY_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || 'agent-drops';

const jobs = new Map();

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── recording ───────────────────────────────────────────────────────────────

async function recordSketch(sketchUrl, durationMs = 60000) {
  console.log('[recorder] Launching browser...');

  // Force Cloudinary to serve the HTML inline rather than as a download
  const browseUrl = sketchUrl.includes('/raw/upload/')
    ? sketchUrl.replace('/raw/upload/', '/raw/upload/fl_inline/')
    : sketchUrl;

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--window-size=1080,1920',
    ],
  });

  // Hoisted so the finally block can cancel it if we exit early
  let downloadTimer = null;

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp',
      eventsEnabled: true,
    });

    const downloadDone = new Promise((resolve, reject) => {
      downloadTimer = setTimeout(
        () => reject(new Error(`Download timeout after ${(durationMs + 40000) / 1000}s`)),
        durationMs + 40000
      );
      cdp.on('Browser.downloadProgress', (evt) => {
        if (evt.state === 'completed') {
          clearTimeout(downloadTimer);
          downloadTimer = null;
          resolve(path.join('/tmp', evt.suggestedFilename || 'recording.webm'));
        } else if (evt.state === 'cancelled') {
          clearTimeout(downloadTimer);
          downloadTimer = null;
          reject(new Error('Browser cancelled the download'));
        }
      });
    });

    // Prevent unhandled rejection if navigation fails before we await this
    downloadDone.catch(() => {});

    console.log('[recorder] Navigating to:', browseUrl);
    await page.goto(browseUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);

    const clickResult = await page.evaluate(() => {
      const overlay = document.getElementById('startOverlay');
      if (overlay) { overlay.click(); return 'overlay'; }
      const canvas = document.querySelector('canvas');
      if (canvas) {
        canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return 'canvas-fallback';
      }
      return 'nothing-found';
    });
    console.log('[recorder] Click result:', clickResult);

    await sleep(1500);

    await page.evaluate((ms) => {
      const canvas = document.querySelector('canvas');
      if (!canvas) { console.error('[page] No canvas found'); return; }

      const videoStream = canvas.captureStream(30);
      let combinedStream = videoStream;

      if (window.__audioStream && window.__audioStream.getAudioTracks().length > 0) {
        combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...window.__audioStream.getAudioTracks(),
        ]);
        console.log('[page] Combined video + audio');
      } else {
        console.warn('[page] No audio stream found — recording video only');
      }

      const mimeType = [
        'video/webm; codecs=vp9,opus',
        'video/webm; codecs=vp8,opus',
        'video/webm',
      ].find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
      console.log('[page] mimeType:', mimeType);

      const chunks = [];
      const rec = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 2_500_000,
      });

      rec.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

      rec.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = 'annmorgan-recording.webm';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
        console.log('[page] Download triggered, size:', blob.size, 'bytes');
      };

      rec.start(1000);
      window.__recorder = rec;
      setTimeout(() => { if (rec.state !== 'inactive') rec.stop(); }, ms);
      console.log('[page] MediaRecorder started —', ms / 1000, 's');
    }, durationMs);

    console.log(`[recorder] Recording in progress (${durationMs / 1000}s)...`);
    const filePath = await downloadDone;
    console.log('[recorder] File saved:', filePath);
    return filePath;

  } finally {
    // Always cancel the timer and close the browser, even if we threw
    if (downloadTimer) clearTimeout(downloadTimer);
    await browser.close();
  }
}

// ─── Cloudinary upload ───────────────────────────────────────────────────────

async function uploadToCloudinary(filePath) {
  console.log('[cloudinary] Uploading:', path.basename(filePath));

  const form = new FormData();
  form.append('upload_preset', CLOUDINARY_PRESET);
  form.append('file', fs.createReadStream(filePath));

  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`,
    { method: 'POST', body: form }
  );

  const data = await res.json();
  if (!res.ok) throw new Error(`Cloudinary ${res.status}: ${JSON.stringify(data)}`);

  console.log('[cloudinary] Uploaded:', data.secure_url);
  return data;
}

// ─── Background job runner ───────────────────────────────────────────────────

async function runJob(jobId, sketchUrl, durationMs) {
  let filePath = null;
  try {
    jobs.set(jobId, { status: 'recording', startedAt: new Date().toISOString() });
    filePath = await recordSketch(sketchUrl, durationMs);

    jobs.set(jobId, { status: 'uploading' });
    const result = await uploadToCloudinary(filePath);

    jobs.set(jobId, {
      status: 'done',
      cloudinary_url: result.secure_url,
      public_id: result.public_id,
      completedAt: new Date().toISOString(),
    });
    console.log(`[job ${jobId}] Complete`);

  } catch (err) {
    console.error(`[job ${jobId}] Failed:`, err.message);
    jobs.set(jobId, { status: 'failed', error: err.message });

  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post('/record', (req, res) => {
  const { sketch_url, duration_ms = 60000 } = req.body;
  if (!sketch_url) return res.status(400).json({ error: 'sketch_url is required' });

  const jobId = `job-${Date.now()}`;
  jobs.set(jobId, { status: 'queued', sketch_url });
  console.log(`[/record] Queued ${jobId}:`, sketch_url);

  runJob(jobId, sketch_url, duration_ms);
  res.json({ status: 'recording_started', job_id: jobId });
});

app.get('/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`annmorgan-recorder running on :${PORT}`);
  console.log(`  Cloudinary cloud: ${CLOUDINARY_CLOUD}`);
  console.log(`  Upload preset:    ${CLOUDINARY_PRESET}`);
});
