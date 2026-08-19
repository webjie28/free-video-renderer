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
const WIDTH = 480;
const HEIGHT = 854;
const jobs = new Map();

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

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

    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);

    child.on('close', (code) => {
      if (code === 0) resolve(output.trim());
      else reject(new Error(stderr));
    });
  });
}

function validateUrl(value, field) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') {
      throw new Error('Only HTTPS URLs are allowed');
    }
    return url;
  } catch {
    throw new Error(`${field} must be a valid HTTPS URL`);
  }
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: 'follow',
    signal: AbortSignal.timeout(90000),
  });

  if (!response.ok) {
    throw new Error(`Could not download ${url}: HTTP ${response.status}`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());

  if (bytes.length === 0) {
    throw new Error(`Downloaded file from ${url} is empty`);
  }

  await writeFile(destination, bytes);
}

async function audioDuration(file) {
  const raw = await commandOutput('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);

  const duration = Number.parseFloat(raw);

  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`Could not determine audio duration for ${file}`);
  }

  return Math.min(Math.max(duration, 0.5), 120);
}

function assTime(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = String(
    Math.floor((centiseconds % 360000) / 6000),
  ).padStart(2, '0');
  const secs = String(
    Math.floor((centiseconds % 6000) / 100),
  ).padStart(2, '0');
  const cs = String(centiseconds % 100).padStart(2, '0');

  return `${hours}:${minutes}:${secs}.${cs}`;
}

function escapeAss(value) {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/[{}]/g, '')
    .replace(/\n/g, ' ');
}

function makeCaptionCues(caption, duration) {
  const words = caption.match(/\S+/g) || [];
  const phrases = [];

  // Three words at a time: readable at Shorts speed.
  for (let index = 0; index < words.length; index += 3) {
    phrases.push(words.slice(index, index + 3).join(' '));
  }

  // Longer phrases receive slightly more screen time.
  const weights = phrases.map((phrase) =>
    Math.max(1, phrase.replace(/\s/g, '').length),
  );

  const totalWeight =
    weights.reduce((sum, weight) => sum + weight, 0) || 1;

  let cursor = 0;

  const events = phrases.map((phrase, index) => {
    const next =
      index === phrases.length - 1
        ? duration
        : Math.min(
            duration,
            cursor + (duration * weights[index]) / totalWeight,
          );

    const line = `Dialogue: 0,${assTime(cursor)},${assTime(next)},Default,,0,0,0,,${escapeAss(phrase)}`;

    cursor = next;
    return line;
  });

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${WIDTH}`,
    `PlayResY: ${HEIGHT}`,
    '',
    '[V4+ Styles]',
    'Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding',
    'Style: Default,DejaVu Sans,36,&H00FFFFFF,&H000000FF,&HAA000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,5,40,40,0,1',
    '',
    '[Events]',
    'Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text',
    ...events,
    '',
  ].join('\n');
}

function normalizeHookText(value) {
  return String(value || '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 90);
}

function wrapHookText(text, maxLineLength = 18, maxLines = 3) {
  const words = String(text || '').match(/\S+/g) || [];
  const lines = [];
  let line = '';

  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (candidate.length > maxLineLength && line) {
      lines.push(line);
      line = word;
      if (lines.length === maxLines - 1) break;
    } else {
      line = candidate;
    }
  }

  if (line && lines.length < maxLines) lines.push(line);
  return lines.join('\n') || 'AUTOMATION TIP';
}

function escapeFilterPath(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

async function makeHook(folder, hookText) {
  const source = path.join(folder, 'video-1.mp4');
  const textFile = path.join(folder, 'hook-text.txt');
  const output = path.join(folder, 'hook.mp4');
  const fontFile = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

  await writeFile(textFile, wrapHookText(hookText), 'utf8');

  const filters = [
    'scale=' + WIDTH + ':' + HEIGHT + ':force_original_aspect_ratio=increase',
    'crop=' + WIDTH + ':' + HEIGHT,
    'setsar=1',
    'format=yuv420p',
    'eq=brightness=-0.18:contrast=1.10',
    'drawbox=x=0:y=0:w=iw:h=ih:color=black@0.30:t=fill',
    'drawtext=fontfile=' + escapeFilterPath(fontFile) + ':textfile=' + escapeFilterPath(textFile) + ':fontcolor=white:fontsize=38:line_spacing=10:x=(w-text_w)/2:y=(h-text_h)/2:box=1:boxcolor=black@0.55:boxborderw=18',
    "drawtext=fontfile=" + escapeFilterPath(fontFile) + ":text='NEGOSYO NAKA-AUTO':fontcolor=0x2FE6A6:fontsize=16:x=(w-text_w)/2:y=90:box=1:boxcolor=black@0.35:boxborderw=8",
  ];

  await run('ffmpeg', [
    '-y', '-stream_loop', '-1', '-i', source,
    '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
    '-t', '0.9', '-map', '0:v:0', '-map', '1:a:0',
    '-vf', filters.join(','),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28',
    '-c:a', 'aac', '-b:a', '96k', '-shortest', output,
  ]);

  return output;
}

async function makeScene(folder, scene, index) {
  const video = path.join(folder, `video-${index}.mp4`);
  const audio = path.join(folder, `audio-${index}.mp3`);
  const subtitles = path.join(folder, `caption-${index}.ass`);
  const output = path.join(folder, `scene-${index}.mp4`);

  await download(scene.video_url, video);
  await download(scene.audio_url, audio);

  const duration = await audioDuration(audio);
  const caption = String(scene.caption || '')
    .replace(/\r?\n/g, ' ')
    .trim();

  await writeFile(
    subtitles,
    caption ? makeCaptionCues(caption, duration) : '',
  );

  const filters = [
    `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase`,
    `crop=${WIDTH}:${HEIGHT}`,
    'setsar=1',
    'format=yuv420p',
  ];

  if (caption) {
    // ASS gives a reliable exact-center subtitle position.
    filters.push(`ass=${subtitles}`);
  }

  await run('ffmpeg', [
    '-y',
    '-stream_loop',
    '-1',
    '-i',
    video,
    '-i',
    audio,
    '-t',
    String(duration),
    '-map',
    '0:v:0',
    '-map',
    '1:a:0',
    '-vf',
    filters.join(','),
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    '-shortest',
    output,
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
      sceneFiles.push(
        await makeScene(folder, job.scenes[index], index + 1),
      );
    }

    if (job.hookText) {
      console.log(`Render ${job.id}: adding topic hook card`);
      sceneFiles.unshift(await makeHook(folder, job.hookText));
    }

    const list = path.join(folder, 'concat.txt');
    job.output = path.join(folder, 'final.mp4');

    await writeFile(
      list,
      sceneFiles
        .map((file) => `file '${file.replace(/'/g, "'\\''")}'`)
        .join('\n'),
    );

    await run('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      list,
      '-c:v',
      'libx264',
      '-preset',
      'veryfast',
      '-crf',
      '23',
      '-c:a',
      'aac',
      '-b:a',
      '128k',
      '-movflags',
      '+faststart',
      job.output,
    ]);

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
    const hookText = normalizeHookText(req.body?.hook_text);
    const scenes = req.body?.scenes;

    if (!Array.isArray(scenes) || scenes.length < 1 || scenes.length > 4) {
      return res.status(400).json({
        error: 'scenes must contain between 1 and 4 items',
      });
    }

    for (const [index, scene] of scenes.entries()) {
      validateUrl(scene?.video_url, `scenes[${index}].video_url`);
      validateUrl(scene?.audio_url, `scenes[${index}].audio_url`);
    }

    const id = randomUUID();

    const job = {
      id,
      scenes,
      hookText,
      status: 'queued',
      createdAt: Date.now(),
      folder: null,
      output: null,
      error: null,
    };

    jobs.set(id, job);
    void renderJob(job);

    return res.status(202).json({ id, status: job.status, hook_applied: Boolean(job.hookText) });
  } catch (error) {
    return res.status(400).json({
      error: error instanceof Error ? error.message : 'Invalid render request',
    });
  }
});

app.get('/render/:id', (req, res) => {
  if (!authenticated(req, res)) return;

  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Render job not found' });
  }

  return res.json({
    id: job.id,
    status: job.status,
    hook_applied: Boolean(job.hookText),
    error: job.error,
  });
});

app.get('/render/:id/download', (req, res) => {
  if (!authenticated(req, res)) return;

  const job = jobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: 'Render job not found' });
  }

  if (job.status === 'failed') {
    return res.status(422).json({ error: job.error });
  }

  if (job.status !== 'completed' || !job.output) {
    return res.status(409).json({ error: 'Render is not ready yet' });
  }

  return res
    .type('video/mp4')
    .set('Content-Disposition', 'attachment; filename="short.mp4"')
    .sendFile(job.output, (error) => {
      if (error) {
        console.error(`Render ${job.id}: download failed`, error);
      }

      setTimeout(async () => {
        jobs.delete(job.id);

        if (job.folder) {
          await rm(job.folder, { recursive: true, force: true });
        }
      }, 10 * 60 * 1000).unref();
    });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Free video renderer listening on ${PORT}`);
});

