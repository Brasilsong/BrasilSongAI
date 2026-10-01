const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');
dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
const MUSIC_PROVIDER = process.env.MUSIC_PROVIDER || 'mock';
const MUSICAPI_KEY = process.env.MUSICAPI_KEY || '';
const MUSICAPI_BASE = (process.env.MUSICAPI_BASE || 'https://api.musicapi.ai').replace(/\/$/, '');

const projects = new Map();
const jobs = new Map();

const STYLE_MAP = {
  sertanejo: 'Brazilian sertanejo, acoustic guitar, viola caipira, warm male vocal',
  arrocha: 'Brazilian arrocha, romantic groove, acoustic guitar, sax accents, warm male vocal',
  forro: 'Brazilian forró, accordion, zabumba, triangle, danceable groove',
  pagode: 'Brazilian pagode, cavaquinho, pandeiro, tantan, warm groove',
  samba: 'Brazilian samba, cavaquinho, percussion, acoustic guitar',
  mpb: 'Brazilian MPB, acoustic guitar, organic percussion, expressive vocal',
  funk: 'Brazilian funk, modern percussion, punchy bass, energetic groove',
  vaneirao: 'Brazilian vanerão, accordion, dancehall southern groove',
  baiao: 'Brazilian baião, accordion, zabumba, triangle, northeastern groove',
  moda: 'Brazilian moda de viola, viola caipira, acoustic strings, intimate vocal',
  reggae: 'Brazilian reggae, offbeat guitar, bass groove, organic percussion',
  axe: 'Brazilian axé, percussion, electric guitar, festive groove'
};

function id(prefix) { return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

function normalizeProject(body = {}) {
  const style = body.style || 'sertanejo';
  return {
    id: body.id || id('prj'),
    name: body.name || 'Minha música',
    lyrics: String(body.lyrics || '').trim(),
    style,
    mood: body.mood || 'romantico',
    bpm: Number(body.bpm || 92),
    key: body.key || 'G',
    vocalGender: body.vocalGender || 'm',
    duration: Math.min(360, Math.max(10, Number(body.duration || 120))),
    referenceMode: body.referenceMode || 'none',
    referenceDescription: body.referenceDescription || '',
    instruments: Array.isArray(body.instruments) ? body.instruments : []
  };
}

function buildTags(p) {
  const base = STYLE_MAP[p.style] || STYLE_MAP.sertanejo;
  return [base, p.mood, `${p.bpm} BPM`, `key ${p.key}`, ...p.instruments].join(', ');
}

async function musicApi(pathname, options = {}) {
  const r = await fetch(`${MUSICAPI_BASE}${pathname}`, {
    ...options,
    headers: { 'Authorization': `Bearer ${MUSICAPI_KEY}`, 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) throw new Error(`MusicAPI ${r.status}: ${data?.message || data?.error || text}`);
  return data;
}

async function providerCreate(p, variant = 'full') {
  if (MUSIC_PROVIDER === 'mock') {
    return { task_id: id('mocktask'), mock: true };
  }
  if (!MUSICAPI_KEY) throw new Error('MUSICAPI_KEY não configurada no servidor.');

  let tags = buildTags(p);
  if (variant === 'guide') tags += ', guide vocal, acoustic guitar, simple arrangement, rehearsal demo, no dense production';
  if (variant === 'instrumental') tags += ', instrumental, no vocals';

  const payload = {
    task_type: 'create_music',
    custom_mode: true,
    mv: process.env.MUSIC_MODEL || 'sonic-v5',
    title: p.name,
    tags,
    prompt: p.lyrics,
    vocal_gender: p.vocalGender,
    duration: p.duration,
    make_instrumental: variant === 'instrumental'
  };
  return musicApi('/api/v1/sonic/create', { method: 'POST', body: JSON.stringify(payload) });
}

async function providerStatus(taskId) {
  if (MUSIC_PROVIDER === 'mock') {
    return { code: 200, message: 'success', data: { status: 'succeeded', clips: [{ id: taskId, audio_url: null, title: 'Mock — configure MUSICAPI_KEY para áudio real' }] } };
  }
  return musicApi(`/api/v1/sonic/task/${encodeURIComponent(taskId)}`);
}

function extractResult(data) {
  const d = data?.data || data || {};
  const clips = d.clips || d.result || d.items || [];
  const clip = Array.isArray(clips) ? clips[0] : clips;
  return {
    status: d.status || data?.status || 'unknown',
    clipId: clip?.id || d.clip_id || d.music_id || d.id || null,
    audioUrl: clip?.audio_url || clip?.audioUrl || clip?.stream_url || d.audio_url || null,
    raw: data
  };
}

async function startJob(project, variant) {
  const job = { id: id('job'), projectId: project.id, variant, status: 'pending', createdAt: new Date().toISOString(), providerTaskId: null, clipId: null, audioUrl: null, error: null };
  jobs.set(job.id, job);
  try {
    const created = await providerCreate(project, variant);
    job.providerTaskId = created.task_id || created.data?.task_id || null;
    if (!job.providerTaskId) throw new Error('O provedor não retornou task_id.');
    job.status = 'running';
    pollJob(job.id).catch(() => {});
  } catch (e) {
    job.status = 'failed'; job.error = e.message;
  }
  return job;
}

async function pollJob(jobId) {
  const job = jobs.get(jobId); if (!job) return;
  for (let i = 0; i < 180; i++) {
    await new Promise(r => setTimeout(r, 3000));
    if (job.status !== 'running') return;
    try {
      const data = await providerStatus(job.providerTaskId);
      const result = extractResult(data);
      const state = String(result.status).toLowerCase();
      if (['succeeded', 'success', 'completed', 'complete'].includes(state)) {
        job.status = 'succeeded'; job.clipId = result.clipId; job.audioUrl = result.audioUrl; job.raw = result.raw; return;
      }
      if (['failed', 'error', 'timeout', 'forbidden'].includes(state)) { job.status = 'failed'; job.error = result.raw?.message || 'Geração falhou.'; return; }
      job.status = 'running';
    } catch (e) { job.status = 'failed'; job.error = e.message; return; }
  }
  job.status = 'failed'; job.error = 'Tempo limite de processamento excedido.';
}

app.get('/api/health', (_, res) => res.json({ ok: true, provider: MUSIC_PROVIDER, configured: MUSIC_PROVIDER === 'mock' || !!MUSICAPI_KEY }));

app.post('/api/projects', (req, res) => {
  const project = normalizeProject(req.body);
  if (!project.lyrics) return res.status(400).json({ error: 'Digite a letra da música.' });
  projects.set(project.id, project);
  res.json(project);
});

app.get('/api/projects/:id', (req, res) => {
  const p = projects.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Projeto não encontrado.' });
  res.json(p);
});

app.post('/api/generate', async (req, res) => {
  const project = req.body.projectId ? projects.get(req.body.projectId) : normalizeProject(req.body);
  if (!project) return res.status(404).json({ error: 'Projeto não encontrado.' });
  if (!project.lyrics) return res.status(400).json({ error: 'A letra é obrigatória.' });
  if (!projects.has(project.id)) projects.set(project.id, project);

  const variants = req.body.variants || ['full', 'guide'];
  const jobsOut = [];
  for (const variant of variants) jobsOut.push(await startJob(project, variant));
  res.json({ projectId: project.id, jobs: jobsOut });
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  res.json(job);
});

async function exportAsset(job, type) {
  if (MUSIC_PROVIDER === 'mock') return { status: 'succeeded', url: null, message: 'Modo demonstração: configure MUSICAPI_KEY para exportar áudio.' };
  if (!job.clipId) throw new Error('A geração ainda não possui clip_id.');
  let endpoint = '/api/v1/sonic/wav';
  let body = { clip_id: job.clipId };
  if (type === 'mp3') { endpoint = '/api/v1/sonic/download'; body = { clip_id: job.clipId, formats: ['mp3'] }; }
  if (type === 'stems_basic') { endpoint = '/api/v1/sonic/stems/basic'; body = { clip_id: job.clipId }; }
  if (type === 'stems_full') { endpoint = '/api/v1/sonic/stems/full'; body = { clip_id: job.clipId }; }
  return musicApi(endpoint, { method: 'POST', body: JSON.stringify(body) });
}

app.post('/api/jobs/:id/export', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job não encontrado.' });
  if (job.status !== 'succeeded') return res.status(409).json({ error: 'A geração ainda não terminou.' });
  const type = req.body.type || 'wav';
  try {
    const data = await exportAsset(job, type);
    res.json({ jobId: job.id, type, data });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.get('*', (req, res, next) => { if (req.path.startsWith('/api/')) return next(); res.sendFile(path.join(__dirname, 'index.html')); });

app.listen(PORT, '0.0.0.0', () => console.log(`BrasilSong AI backend: http://0.0.0.0:${PORT} | provider=${MUSIC_PROVIDER}`));
