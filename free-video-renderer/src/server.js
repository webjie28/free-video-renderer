import express from 'express';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = Number(process.env.PORT || 10000);
const API_KEY = process.env.API_KEY;
// Render's free instances have limited CPU. This is still a vertical Shorts
// format, but substantially faster to encode than 720x1280.
const WIDTH = 480;
const HEIGHT = 854;
const jobs = new Map();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

function commandOutput(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(output.trim()) : reject(new Error(stderr)));
  });
}

function validateUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') throw new Error('Only HTTPS URLs are allowed');
    return url;
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL`);
  }
}

async function download(url, destination) {
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error(`Downloaded file from ${url} is empty`);
  await writeFile(destination, bytes);
}

async function audioDuration(file) {
  const raw = await commandOutput('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file,
  ]);
  const duration = Number.parseFloat(raw);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error(`Could not determine audio duration for ${file}`);
  return Math.min(Math.max(duration, 0.5), 120);
}

function srtTime(seconds) {
  const milliseconds = Math.round(seconds * 1000);
  const hours = String(Math.floor(milliseconds / 3600000)).padStart(2, '0');
  const minutes = String(Math.floor((milliseconds % 3600000) / 60000)).padStart(2, '0');
  const secs = String(Math.floor((milliseconds % 60000) / 1000)).padStart(2, '0');
  const ms = String(milliseconds % 1000).padStart(3, '0');
  return `${hours}:${minutes}:${secs},${ms}`;
}

async function makeScene(folder, scene, index) {
  const video = path.join(folder, `video-${index}.mp4`);
  const audio = path.join(folder, `audio-${index}.mp3`);
  const subtitles = path.join(folder, `caption-${index}.srt`);
  const output = path.join(folder, `scene-${index}.mp4`);
  await download(scene.video_url, video);
  await download(scene.audio_url, audio);
  const duration = await audioDuration(audio);
  const caption = String(scene.caption || '').replace(/\r?\n/g, ' ').trim();
  await writeFile(subtitles, caption ? `1\n00:00:00,000 --> ${srtTime(duration)}\n${caption}\n` : '');
  const filters = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    'setsar=1',
    'format=yuv420p',
  ];
  if (caption) {
    filters.push(`subtitles=${subtitles}:force_style='FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=3,Alignment=2,MarginV=100'`);
  }
  await run('ffmpeg', [
    '-y', '-stream_loop', '-1', '-i', video, '-i', audio,
    '-t', String(duration), '-map', '0:v:0', '-map', '1:a:0',
    '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', output,
  ]);
  return output;
}

app.get('/health', (_req, res) => res.json({ ok: true }));

function authenticated(req, res) {
  if (!API_KEY || req.get('authorization') !== `Bearer ${API_KEY}`) {
    res.status(401).json({ error: 'Missing or invalid API key' });
    return false;
  }
  return true;
}

async function renderJob(job) {
  try {
    job.status = 'processing';
    console.log(`Render ${job.id}: processing ${job.scenes.length} scenes`);
    const folder = await mkdtemp(path.join(tmpdir(), 'video-render-'));
    job.folder = folder;
    const sceneFiles = [];
    for (let index = 0; index < job.scenes.length; index += 1) {
      console.log(`Render ${job.id}: scene ${index + 1}/${job.scenes.length}`);
      sceneFiles.push(await makeScene(folder, job.scenes[index], index + 1));
    }
    const list = path.join(folder, 'concat.txt');
    job.output = path.join(folder, 'final.mp4');
    await writeFile(list, sceneFiles.map((file) => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'));
    await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', job.output]);
    job.status = 'completed';
    job.completedAt = Date.now();
    console.log(`Render ${job.id}: completed`);
  } catch (error) {
    console.error(error);
    job.status = 'failed';
    job.error = error instanceof Error ? error.message : 'Render failed';
  }
}

app.post('/render', async (req, res) => {
  if (!authenticated(req, res)) return;
  try {
    const scenes = req.body?.scenes;
    if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 4) {
      return res.status(400).json({ error: 'scenes must contain between 1 and 4 items' });
    }
    for (const [index, scene] of scenes.entries()) {
      validateUrl(scene?.video_url, `scenes[${index}].video_url`);
      validateUrl(scene?.audio_url, `scenes[${index}].audio_url`);
    }
    const id = randomUUID();
    const job = { id, scenes, status: 'queued', createdAt: Date.now(), folder: null, output: null, error: null };
    jobs.set(id, job);
    void renderJob(job);
    return res.status(202).json({ id, status: job.status });
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid render request' });
  }
});

app.get('/render/:id', (req, res) => {
  if (!authenticated(req, res)) return;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Render job not found' });
  return res.json({ id: job.id, status: job.status, error: job.error });
});

app.get('/render/:id/download', (req, res) => {
  if (!authenticated(req, res)) return;
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Render job not found' });
  if (job.status === 'failed') return res.status(422).json({ error: job.error });
  if (job.status !== 'completed' || !job.output) return res.status(409).json({ error: 'Render is not ready yet' });
  return res.type('video/mp4').set('Content-Disposition', 'attachment; filename="short.mp4"').sendFile(job.output, (error) => {
    if (error) console.error(`Render ${job.id}: download failed`, error);
    setTimeout(async () => {
      jobs.delete(job.id);
      if (job.folder) await rm(job.folder, { recursive: true, force: true });
    }, 10 * 60 * 1000).unref();
  });
});

// Explicitly bind to every network interface so Render's health/port scanner
// can reach this Docker web service.
app.listen(PORT, '0.0.0.0', () => console.log(`Free video renderer listening on ${PORT}`));
