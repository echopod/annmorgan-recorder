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
const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || 'dpdr82xba';
const CLOUDINARY_PRESET = process.env.CLOUDINARY_UPLOAD_PRESET || 'agent-drops';
const jobs = new Map();
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function recordSketch(sketchUrl, durationMs) {
  if (!durationMs) durationMs = 60000;
  console.log('[recorder] Fetching sketch HTML from:', sketchUrl);
  const htmlRes = await fetch(sketchUrl);
  if (!htmlRes.ok) throw new Error('Failed to fetch sketch: ' + htmlRes.status);
  const htmlContent = await htmlRes.text();
  console.log('[recorder] Got HTML, length:', htmlContent.length);
  console.log('[recorder] Launching browser...');
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
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });
    var recordingResolve;
    var recordingReject;
    var recordingTimeout;
    const recordingDone = new Promise(function(resolve, reject) {
      recordingResolve = resolve;
      recordingReject = reject;
    });
    recordingTimeout = setTimeout(function() {
      recordingReject(new Error('Recording timeout after ' + (durationMs + 30000) / 1000 + 's'));
    }, durationMs + 30000);
    const filePath = '/tmp/annmorgan-' + Date.now() + '.webm';
    await page.exposeFunction('__recordingComplete', function(base64Data) {
      try {
        clearTimeout(recordingTimeout);
        console.log('[recorder] Received recording data, writing to disk...');
        const buffer = Buffer.from(base64Data, 'base64');
        fs.writeFileSync(filePath, buffer);
        console.log('[recorder] File saved:', filePath, '(' + buffer.length + ' bytes)');
        recordingResolve(filePath);
      } catch(e) {
        recordingReject(new Error('Failed to write file: ' + e.message));
      }
    });
    await page.exposeFunction('__recordingError', function(msg) {
      clearTimeout(recordingTimeout);
      recordingReject(new Error('Page error: ' + msg));
    });
    console.log('[recorder] Loading HTML into page...');
    await page.setContent(htmlContent, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2500);
    const clickResult = await page.evaluate(function() {
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
    await page.evaluate(function(ms) {
      const canvas = document.querySelector('canvas');
      if (!canvas) { window.__recordingError('No canvas found'); return; }
      const videoStream = canvas.captureStream(30);
      var combinedStream = videoStream;
      if (window.__audioStream && window.__audioStream.getAudioTracks().length > 0) {
        combinedStream = new MediaStream([
          ...videoStream.getVideoTracks(),
          ...window.__audioStream.getAudioTracks(),
        ]);
        console.log('[page] Combined video + audio');
      } else {
        console.warn('[page] No audio stream — video only');
      }
      const mimeType = [
        'video/webm; codecs=vp9,opus',
        'video/webm; codecs=vp8,opus',
        'video/webm',
      ].find(function(t) { return MediaRecorder.isTypeSupported(t); }) || 'video/webm';
      console.log('[page] mimeType:', mimeType);
      const chunks = [];
      const rec = new MediaRecorder(combinedStream, { mimeType: mimeType, videoBitsPerSecond: 2500000 });
      rec.ondataavailable = function(e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onstop = function() {
        console.log('[page] Recording stopped, building blob...');
        const blob = new Blob(chunks, { type: 'video/webm' });
        console.log('[page] Blob size:', blob.size, 'bytes');
        const reader = new FileReader();
        reader.onloadend = function() {
          try {
            const base64 = reader.result.split(',')[1];
            console.log('[page] Sending data to Node.js...');
            window.__recordingComplete(base64);
          } catch(e) {
            window.__recordingError('base64 error: ' + e.message);
          }
        };
        reader.onerror = function() { window.__recordingError('FileReader failed'); };
        reader.readAsDataURL(blob);
      };
      rec.start(1000);
      window.__recorder = rec;
      setTimeout(function() { if (rec.state !== 'inactive') rec.stop(); }, ms);
      console.log('[page] MediaRecorder started, duration:', ms / 1000, 's');
    }, durationMs);
    console.log('[recorder] Recording in progress...');
    const savedPath = await recordingDone;
    return savedPath;
  } finally {
    await browser.close();
  }
}
async function uploadToCloudinary(filePath, caption) {
  console.log('[cloudinary] Uploading:', path.basename(filePath));
  const form = new FormData();
  form.append('upload_preset', CLOUDINARY_PRESET);
  form.append('file', fs.createReadStream(filePath));
  if (caption) {
    var safeCaption = caption.replace(/\|/g, ' ').replace(/=/g, '-');
    form.append('context', 'caption=' + safeCaption);
    console.log('[cloudinary] Attaching caption as context metadata');
  }
  const res = await fetch(
    'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/video/upload',
    { method: 'POST', body: form }
  );
  const data = await res.json();
  if (!res.ok) throw new Error('Cloudinary ' + res.status + ': ' + JSON.stringify(data));
  console.log('[cloudinary] Uploaded:', data.secure_url);
  return data;
}
async function runJob(jobId, sketchUrl, durationMs, caption) {
  var filePath = null;
  try {
    jobs.set(jobId, { status: 'recording', startedAt: new Date().toISOString() });
    filePath = await recordSketch(sketchUrl, durationMs);
    jobs.set(jobId, { status: 'uploading' });
    const result = await uploadToCloudinary(filePath, caption);
    jobs.set(jobId, {
      status: 'done',
      cloudinary_url: result.secure_url,
      public_id: result.public_id,
      completedAt: new Date().toISOString(),
    });
    console.log('[job ' + jobId + '] Complete');
  } catch (err) {
    console.error('[job ' + jobId + '] Failed:', err.message);
    jobs.set(jobId, { status: 'failed', error: err.message });
  } finally {
    if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
}
app.get('/health', function(_req, res) {
  res.json({ ok: true, ts: new Date().toISOString() });
});
app.post('/record', function(req, res) {
  const sketch_url = req.body.sketch_url;
  const duration_ms = req.body.duration_ms || 60000;
  const caption = req.body.caption || '';
  if (!sketch_url) return res.status(400).json({ error: 'sketch_url is required' });
  const jobId = 'job-' + Date.now();
  jobs.set(jobId, { status: 'queued', sketch_url: sketch_url });
  console.log('[/record] Queued ' + jobId + ': ' + sketch_url);
  runJob(jobId, sketch_url, duration_ms, caption);
  res.json({ status: 'recording_started', job_id: jobId });
});
app.get('/status/:id', function(req, res) {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Not found' });
  res.json(job);
});
app.listen(PORT, function() {
  console.log('annmorgan-recorder running on :' + PORT);
  console.log('  Cloudinary cloud: ' + CLOUDINARY_CLOUD);
  console.log('  Upload preset:    ' + CLOUDINARY_PRESET);
});
