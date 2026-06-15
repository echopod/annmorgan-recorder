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

// In-memory job tracker — resets on restart, fine for our use case
const jobs = new Map();

// ─── helpers ────────────────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── recording ──────────────────────────────────────────────────────────────

async function recordSketch(sketchUrl, durationMs = 60000) {
  console.log('[recorder] Launching browser...');

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',   // critical in Docker — avoids /dev/shm OOM
      '--disable-gpu',
      '--window-size=1080,1920',
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

    // ── Set up CDP download interception ──────────────────────────────────
    // We capture the recording by having the in-page MediaRecorder trigger
    // a link download. CDP intercepts this and saves it to /tmp.
    const cdp = await page.createCDPSession();
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: '/tmp',
      eventsEnabled: true,
    });

    let savedFilePath = null;
    const downloadDone = new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Download timeout after ${(durationMs + 40000) / 1000}s`)),
        durationMs + 40000
      );
      cdp.on('Browser.downloadProgress', (evt) => {
        if (evt.state === 'completed') {
          clearTimeout(timer);
          savedFilePath = path.join('/tmp', evt.suggestedFilename || 'recording.webm');
          resolve(savedFilePath);
        } else if (evt.state === 'cancelled') {
          clearTimeout(timer);
          reject(new Error('Browser cancelled the download'));
        }
      });
    });

    // ── Navigate ──────────────────────────────────────────────────────────
    console.log('[recorder] Navigating to:', sketchUrl);
    await page.goto(sketchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500); // let p5.js and sketch initialize fully

    // ── Click start overlay ───────────────────────────────────────────────
    // The sketch waits for a user gesture before starting audio.
    // page.evaluate click() counts as a real user gesture in Chrome.
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

    // ── Brief wait: let startAudio() run and window.__audioStream get set ─
    await sleep(1500);

    // ── Inject MediaRecorder (fire-and-forget — does NOT block eval) ──────
    // The recorder runs entirely inside the page.
    // When it finishes, it triggers a <a> download which CDP intercepts above.
    await page.evaluate((ms) => {
      const canvas = document.querySelector('canvas');
      if (!canvas) { console.error('[page] No canvas found'); return; }

      // Build the stream: video from canvas, audio from sketch's exposed stream
      const videoStream = canvas.captureStream(30);
      let combinedStream = videoStream;

      if (window.__audioStream && window.__audioStream.getAudioTracks().length > 0) {
        combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...window.__audioStream.getAudioTracks(),
        ]);
        console.log('[page] ✓ Combined video + audio');
      } else {
        console.warn('[page] ⚠ window.__audioStream not found — recording video only');
      }

      // Pick best codec available in this Chrome build
      const mimeType = [
        'video/webm; codecs=vp9,opus',
        'video/webm; codecs=vp8,opus',
        'video/webm',
      ].find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';
      console.log('[page] mimeType:', mimeType);

      const chunks = [];
      const rec = new MediaRecorder(combinedStream, {
        mimeType,
        videoBitsPerSecond: 2_500_000, // 2.5 Mbps — good for an animated canvas
      });

      rec.ondataavailable = (e) => { if (e.data?.size > 0) chunks.push(e.data); };

      rec.onstop = () => {
        const blob = new Blob(chunks, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        // Trigger download — CDP intercepts this and saves to /tmp
        const a = document.createElement('a');
        a.style.display = 'none';
        a.href = url;
        a.download = 'annmorgan-recording.webm';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 2000);
        console.log('[page] Download triggered, size:', blob.size, 'bytes');
      };

      rec.start(1000); // collect a chunk every second
      window.__recorder = rec;

      // Auto-stop after recording duration
      setTimeout(() => {
        if (rec.state !== 'inactive') rec.stop();
      }, ms);

      console.log('[page] MediaRecorder started —', ms / 1000, 's');
    }, durationMs);

    console.log(`[recorder] Recording in progress (${durationMs / 1000}s)...`);

    // Wait for the download to complete (blocking until CDP fires 'completed')
    const filePath = await downloadDone;
    console.log('[recorder] ✓ File saved:', filePath);
    return filePath;

  } finally {
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

  console.log('[cloudinary] ✓ Uploaded:', data.secure_url);
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
    console.log(`[job ${jobId}] ✓ Complete`);

  } catch (err) {
    console.error(`[job ${jobId}] ✗ Failed:`, err.message);
    jobs.set(jobId, { status: 'failed', error: err.message });

  } finally {
    if (filePath && fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      console.log(`[job ${jobId}] Cleaned up temp file`);
    }
  }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

// Health check — use this to wake the service before calling /record
app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Start a recording job (returns immediately — recording happens in background)
app.post('/record', (req, res) => {
  const { sketch_url, duration_ms = 60000 } = req.body;

  if (!sketch_url) {
    return res.status(400).json({ error: 'sketch_url is required' });
  }

  const jobId = `job-${Date.now()}`;
  jobs.set(jobId, { status: 'queued', sketch_url });
  console.log(`[/record] Queued ${jobId}:`, sketch_url);

  runJob(jobId, sketch_url, duration_ms); // fire-and-forget

  res.json({ status: 'recording_started', job_id: jobId });
});

// Check job status (optional — useful for debugging)
app.get('/status/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ─── Start ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`annmorgan-recorder running on :${PORT}`);
  console.log(`  Cloudinary cloud: ${CLOUDINARY_CLOUD}`);
  console.log(`  Upload preset:    ${CLOUDINARY_PRESET}`);
});
