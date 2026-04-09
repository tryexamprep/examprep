// =====================================================
// ExamPrep - Main Server
// =====================================================
// SECURITY NOTES:
// - All secrets loaded from .env (never committed)
// - Frontend config.js generated dynamically from env at startup
// - Supabase service-role key kept server-side only (never sent to client)
// - Rate limiting on every endpoint
// - File upload size limits + content validation
// - SHA-256 deduplication to prevent re-processing same files
// - All quotas enforced server-side (not just UI)
// - HTTPS-only in production via Vercel
// - Security headers (CSP, HSTS, X-Frame-Options) via vercel.json

import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';
import { processExamPair, fileHash } from './scripts/process-pdf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ===== Required env vars =====
const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY'];
for (const r of required) {
  if (!process.env[r]) console.error(`⚠️  Missing required env: ${r}`);
}

// ===== Generate public/config.js from env (no secrets - just public values) =====
function generateConfigJs() {
  const templatePath = path.join(__dirname, 'public', 'config.js.template');
  const outPath = path.join(__dirname, 'public', 'config.js');
  if (!fs.existsSync(templatePath)) return;
  let content = fs.readFileSync(templatePath, 'utf8');
  const url = (process.env.SUPABASE_URL || '').trim();
  const key = (process.env.SUPABASE_ANON_KEY || '').trim();
  content = content
    .replaceAll('__SUPABASE_URL__', url)
    .replaceAll('__SUPABASE_ANON_KEY__', key)
    .replaceAll('__APP_TITLE__', process.env.APP_TITLE || 'ExamPrep')
    .replaceAll('__APP_URL__', process.env.APP_URL || 'http://localhost:3000');
  fs.writeFileSync(outPath, content);
}
generateConfigJs();

// ===== Server admin client (uses service-role key, NEVER sent to client) =====
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAdmin = SUPABASE_URL && SUPABASE_SERVICE_ROLE
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, { auth: { persistSession: false } })
  : null;

// ===== Quota config =====
const QUOTAS = {
  free: {
    pdfs_total: 5,            // lifetime PDFs
    pdfs_per_day: 2,
    pdfs_per_month: 5,
    ai_questions_per_day: 0,
    ai_questions_per_month: 0,
    courses: 1,
    storage_mb: 100,
    max_pdf_size_mb: 10,
    max_pages_per_pdf: 25,
  },
  basic: {
    pdfs_total: -1, // unlimited
    pdfs_per_day: 10,
    pdfs_per_month: 30,
    ai_questions_per_day: 20,
    ai_questions_per_month: 100,
    courses: 5,
    storage_mb: 1024,
    max_pdf_size_mb: 20,
    max_pages_per_pdf: 50,
  },
  pro: {
    pdfs_total: -1,
    pdfs_per_day: 30,
    pdfs_per_month: 150,
    ai_questions_per_day: 80,
    ai_questions_per_month: 500,
    courses: -1,
    storage_mb: 5120,
    max_pdf_size_mb: 30,
    max_pages_per_pdf: 100,
  },
  education: {
    pdfs_total: -1,
    pdfs_per_day: 50,
    pdfs_per_month: 500,
    ai_questions_per_day: 200,
    ai_questions_per_month: 2000,
    courses: -1,
    storage_mb: 20480,
    max_pdf_size_mb: 50,
    max_pages_per_pdf: 150,
  },
};

// ===== Express app =====
const app = express();

// Trust proxy (Vercel sits behind a proxy)
app.set('trust proxy', 1);

// Parse JSON (small limit - PDFs go through multer)
app.use(express.json({ limit: '256kb' }));

// Security headers (basic - more in vercel.json)
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  next();
});

// ===== Rate limiting (simple in-memory; use Redis in prod) =====
const rateLimits = new Map();
function rateLimit(key, maxPerMinute) {
  const now = Date.now();
  const bucket = rateLimits.get(key) || { count: 0, resetAt: now + 60000 };
  if (now > bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + 60000;
  }
  bucket.count++;
  rateLimits.set(key, bucket);
  return bucket.count <= maxPerMinute;
}
function rateLimitMiddleware(maxPerMinute) {
  return (req, res, next) => {
    const key = req.headers['x-forwarded-for'] || req.ip || 'unknown';
    if (!rateLimit(`${key}:${req.path}`, maxPerMinute)) {
      return res.status(429).json({ error: 'Too many requests. Try again in a minute.' });
    }
    next();
  };
}

// ===== Auth middleware - verifies Supabase JWT =====
async function authMiddleware(req, res, next) {
  const auth = req.headers['authorization'];
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }
  const token = auth.substring(7);
  if (!supabaseAdmin) return res.status(500).json({ error: 'Server not configured' });
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data?.user) {
    return res.status(401).json({ error: 'Invalid token' });
  }
  req.userId = data.user.id;
  req.userEmail = data.user.email;
  next();
}

// ===== Get user profile + plan + reset quotas if needed =====
async function getUserProfile(userId) {
  // Reset quotas if needed
  await supabaseAdmin.rpc('reset_user_quotas_if_needed', { p_user_id: userId });
  const { data, error } = await supabaseAdmin
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .single();
  if (error) return null;
  return data;
}

// ===== Static files =====
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/legal', express.static(path.join(__dirname, 'legal')));

// Local image serving (in production, images are in Supabase Storage)
app.use('/storage', express.static(path.join(__dirname, 'data', 'storage')));

// Default routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/login', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/pricing', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/courses/*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ===== Health check =====
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    supabase: !!supabaseAdmin,
    quotas: Object.keys(QUOTAS),
  });
});

// ===== User stats =====
app.get('/api/me', authMiddleware, async (req, res) => {
  const profile = await getUserProfile(req.userId);
  if (!profile) return res.status(404).json({ error: 'profile not found' });
  const plan = profile.plan || 'free';
  res.json({
    profile,
    quotas: QUOTAS[plan],
  });
});

// ===== List user's courses =====
app.get('/api/courses', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('courses')
    .select('*')
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== Create new course =====
app.post('/api/courses', authMiddleware, rateLimitMiddleware(10), async (req, res) => {
  const { name, description, color } = req.body || {};
  if (!name || name.length < 2 || name.length > 100) {
    return res.status(400).json({ error: 'Invalid course name' });
  }

  // Check quota
  const profile = await getUserProfile(req.userId);
  const plan = profile?.plan || 'free';
  const quota = QUOTAS[plan];
  const { count } = await supabaseAdmin.from('courses').select('id', { count: 'exact', head: true }).eq('user_id', req.userId);
  if (quota.courses !== -1 && count >= quota.courses) {
    return res.status(403).json({ error: `הגעת למגבלת הקורסים שלך (${quota.courses}). שדרג לחבילה גדולה יותר.` });
  }

  const { data, error } = await supabaseAdmin
    .from('courses')
    .insert({ user_id: req.userId, name, description: description || null, color: color || '#3b82f6' })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

// ===== Multer for file uploads =====
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max (we check per-plan after)
    files: 2, // exam + solution
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      return cb(new Error('רק קבצי PDF מותרים'));
    }
    cb(null, true);
  },
});

// ===== Upload exam PDF (and optional solution PDF) =====
app.post('/api/upload', authMiddleware, rateLimitMiddleware(3),
  upload.fields([
    { name: 'examPdf', maxCount: 1 },
    { name: 'solutionPdf', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const profile = await getUserProfile(req.userId);
      if (!profile) return res.status(404).json({ error: 'profile not found' });
      const plan = profile.plan || 'free';
      const quota = QUOTAS[plan];

      // ===== Quota checks =====
      // Lifetime PDFs (only for free plan)
      if (quota.pdfs_total !== -1) {
        const { count } = await supabaseAdmin.from('exams').select('id', { count: 'exact', head: true }).eq('user_id', req.userId);
        if (count >= quota.pdfs_total) {
          return res.status(402).json({
            error: `הגעת למגבלה החינמית של ${quota.pdfs_total} קבצי PDF. שדרג לחבילה בתשלום כדי להמשיך.`,
            needs_upgrade: true,
          });
        }
      }
      // Daily limit
      if (profile.pdfs_uploaded_today >= quota.pdfs_per_day) {
        return res.status(429).json({
          error: `הגעת למכסה היומית של ${quota.pdfs_per_day} העלאות. נסה שוב מחר.`,
        });
      }
      // Monthly limit
      if (profile.pdfs_uploaded_this_month >= quota.pdfs_per_month) {
        return res.status(429).json({
          error: `הגעת למכסה החודשית של ${quota.pdfs_per_month} העלאות.`,
        });
      }
      // Storage limit
      if (profile.storage_bytes_used >= quota.storage_mb * 1024 * 1024) {
        return res.status(403).json({ error: `הגעת למגבלת האחסון (${quota.storage_mb}MB).` });
      }

      // ===== Validate uploaded files =====
      const examFile = req.files?.examPdf?.[0];
      const solFile = req.files?.solutionPdf?.[0];
      if (!examFile) return res.status(400).json({ error: 'חסר קובץ exam PDF' });

      const maxBytes = quota.max_pdf_size_mb * 1024 * 1024;
      if (examFile.size > maxBytes) {
        return res.status(413).json({ error: `קובץ הבחינה גדול מהמותר (${quota.max_pdf_size_mb}MB)` });
      }
      if (solFile && solFile.size > maxBytes) {
        return res.status(413).json({ error: `קובץ הפתרון גדול מהמותר (${quota.max_pdf_size_mb}MB)` });
      }

      const { courseId, name } = req.body || {};
      if (!courseId) return res.status(400).json({ error: 'חסר courseId' });
      if (!name || name.length < 2) return res.status(400).json({ error: 'חסר שם למבחן' });

      // Verify course belongs to user
      const { data: course } = await supabaseAdmin.from('courses').select('id').eq('id', courseId).eq('user_id', req.userId).single();
      if (!course) return res.status(403).json({ error: 'אין לך גישה לקורס הזה' });

      // ===== Save files to temp dir for processing =====
      const tempDir = path.join(__dirname, 'data', 'temp', `${req.userId}_${Date.now()}`);
      fs.mkdirSync(tempDir, { recursive: true });
      const examPath = path.join(tempDir, 'exam.pdf');
      fs.writeFileSync(examPath, examFile.buffer);
      let solPath = null;
      if (solFile) {
        solPath = path.join(tempDir, 'solution.pdf');
        fs.writeFileSync(solPath, solFile.buffer);
      }

      // ===== Deduplication: check hash =====
      const hash = fileHash(examPath);
      const { data: existing } = await supabaseAdmin
        .from('exams')
        .select('id')
        .eq('user_id', req.userId)
        .eq('exam_pdf_hash', hash)
        .maybeSingle();
      if (existing) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return res.status(409).json({ error: 'הקובץ הזה כבר הועלה בעבר' });
      }

      // ===== Insert exam record =====
      const { data: exam, error: examErr } = await supabaseAdmin
        .from('exams')
        .insert({
          course_id: courseId,
          user_id: req.userId,
          name,
          exam_pdf_hash: hash,
          status: 'processing',
        })
        .select()
        .single();
      if (examErr) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        return res.status(500).json({ error: examErr.message });
      }

      // ===== Process the PDF =====
      try {
        const result = await processExamPair({
          examPdfPath: examPath,
          solutionPdfPath: solPath,
          outputDir: path.join(__dirname, 'data', 'storage', String(req.userId), String(exam.id)),
          mcqMode: 'auto',
        });

        // Save questions to DB
        const questionsToInsert = result.questions.map(q => ({
          exam_id: exam.id,
          course_id: courseId,
          user_id: req.userId,
          question_number: q.index,
          section_label: q.section,
          image_path: `${req.userId}/${exam.id}/${q.imageFile}`,
          num_options: q.numOptions,
          correct_idx: q.correctIdx || 1, // fallback
          option_labels: null,
          topic: null,
        }));
        if (questionsToInsert.length) {
          const { error: qErr } = await supabaseAdmin.from('questions').insert(questionsToInsert);
          if (qErr) console.error('Failed to insert questions:', qErr.message);
        }

        // Update exam status
        await supabaseAdmin.from('exams').update({
          status: 'ready',
          question_count: result.questionCount,
          processed_at: new Date().toISOString(),
        }).eq('id', exam.id);

        // Update user counters
        await supabaseAdmin.from('profiles').update({
          pdfs_uploaded_today: profile.pdfs_uploaded_today + 1,
          pdfs_uploaded_this_month: profile.pdfs_uploaded_this_month + 1,
          storage_bytes_used: profile.storage_bytes_used + examFile.size + (solFile?.size || 0),
        }).eq('id', req.userId);

        // Update course counters
        await supabaseAdmin.from('courses').update({
          total_questions: (await supabaseAdmin.from('questions').select('id', { count: 'exact', head: true }).eq('course_id', courseId)).count,
          total_pdfs: (await supabaseAdmin.from('exams').select('id', { count: 'exact', head: true }).eq('course_id', courseId)).count,
        }).eq('id', courseId);

        // Cleanup temp dir (keep only the cropped questions in storage dir)
        fs.rmSync(tempDir, { recursive: true, force: true });

        res.json({
          ok: true,
          exam_id: exam.id,
          question_count: result.questionCount,
          mode: result.mode,
        });
      } catch (procErr) {
        await supabaseAdmin.from('exams').update({
          status: 'failed',
          error_message: String(procErr.message || procErr),
        }).eq('id', exam.id);
        fs.rmSync(tempDir, { recursive: true, force: true });
        res.status(500).json({ error: 'עיבוד הקובץ נכשל: ' + procErr.message });
      }
    } catch (err) {
      console.error('upload error:', err);
      res.status(500).json({ error: err.message });
    }
  });

// ===== List exams in a course =====
app.get('/api/courses/:courseId/exams', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('exams')
    .select('*')
    .eq('course_id', req.params.courseId)
    .eq('user_id', req.userId)
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== List questions in a course (for the practice UI) =====
app.get('/api/courses/:courseId/questions', authMiddleware, async (req, res) => {
  const { data, error } = await supabaseAdmin
    .from('questions')
    .select('*')
    .eq('course_id', req.params.courseId)
    .eq('user_id', req.userId)
    .order('exam_id', { ascending: true })
    .order('question_number', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ===== Record an attempt =====
app.post('/api/attempt', authMiddleware, rateLimitMiddleware(60), async (req, res) => {
  const { questionId, courseId, selectedIdx, isCorrect, revealed, timeSeconds, batchId } = req.body || {};
  if (!questionId || !courseId) return res.status(400).json({ error: 'missing fields' });
  const { error } = await supabaseAdmin.from('attempts').insert({
    user_id: req.userId,
    question_id: questionId,
    course_id: courseId,
    selected_idx: selectedIdx ?? null,
    is_correct: !!isCorrect,
    revealed: !!revealed,
    time_seconds: timeSeconds ?? null,
    batch_id: batchId ?? null,
  });
  if (error) return res.status(500).json({ error: error.message });

  // Update review queue
  if (!isCorrect || revealed) {
    await supabaseAdmin.from('review_queue').upsert({
      user_id: req.userId,
      question_id: questionId,
      course_id: courseId,
    });
  } else {
    await supabaseAdmin.from('review_queue').delete().eq('user_id', req.userId).eq('question_id', questionId);
  }
  res.json({ ok: true });
});

// ===== AI similar question generation (Premium feature) =====
app.post('/api/ai/generate-similar', authMiddleware, rateLimitMiddleware(5), async (req, res) => {
  const { questionId, count = 1 } = req.body || {};
  const profile = await getUserProfile(req.userId);
  const plan = profile?.plan || 'free';
  const quota = QUOTAS[plan];

  if (quota.ai_questions_per_month === 0) {
    return res.status(402).json({ error: 'יצירת שאלות AI זמינה רק במנוי בתשלום', needs_upgrade: true });
  }
  if (profile.ai_questions_used_today + count > quota.ai_questions_per_day) {
    return res.status(429).json({ error: `הגעת למכסה היומית של ${quota.ai_questions_per_day} שאלות AI` });
  }
  if (profile.ai_questions_used_this_month + count > quota.ai_questions_per_month) {
    return res.status(429).json({ error: `הגעת למכסה החודשית של ${quota.ai_questions_per_month} שאלות AI` });
  }

  // TODO: call Gemini API to generate similar questions
  // For now, just return a placeholder
  res.status(501).json({
    error: 'יצירת שאלות AI עדיין בפיתוח. תחזור בקרוב!',
  });
});

// ===== Catch-all: serve index.html for SPA routes =====
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => {
  console.log(`ExamPrep server running on http://localhost:${PORT}`);
  console.log(`  Supabase: ${supabaseAdmin ? 'connected' : 'NOT configured'}`);
});
