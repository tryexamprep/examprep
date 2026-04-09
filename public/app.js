// =====================================================
// ExamPrep - Frontend SPA
// =====================================================
// Vanilla JS, no framework. Routes: /, /login, /pricing, /dashboard, /courses/:id

const cfg = window.APP_CONFIG || {};
let supabase = null;
if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY) {
  const mod = await import('https://esm.sh/@supabase/supabase-js@2');
  supabase = mod.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
}

const $app = document.getElementById('app');
const state = { user: null, profile: null, courses: [] };

function tmpl(id) {
  const t = document.getElementById(id);
  return t.content.cloneNode(true);
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ===== Router =====
function navigate(path) {
  window.history.pushState({}, '', path);
  render();
}
window.addEventListener('popstate', () => render());

document.addEventListener('click', (e) => {
  const link = e.target.closest('[data-route]');
  if (link) {
    e.preventDefault();
    const path = link.getAttribute('href');
    navigate(path);
  }
});

async function getCurrentUser() {
  if (!supabase) return null;
  const { data } = await supabase.auth.getUser();
  return data?.user || null;
}

async function getProfile(userId) {
  if (!supabase) return null;
  const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  return data;
}

// ===== Render dispatcher =====
async function render() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  // Public routes
  if (path === '/' || path === '/index.html') return renderLanding();
  if (path === '/login') return renderLogin(params.get('signup') === '1');
  if (path === '/pricing') {
    renderLanding();
    setTimeout(() => document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' }), 100);
    return;
  }

  // Protected routes
  const user = await getCurrentUser();
  if (!user) return navigate('/login');
  state.user = user;
  state.profile = await getProfile(user.id);

  if (path === '/dashboard') return renderDashboard();
  if (path.startsWith('/courses/')) return renderCoursePage(path.split('/')[2]);

  // 404 fallback
  renderLanding();
}

// ===== Landing Page =====
function renderLanding() {
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-landing'));
  // Smooth scroll for in-page anchors
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', (e) => {
      const id = a.getAttribute('href').slice(1);
      const el = document.getElementById(id);
      if (el) {
        e.preventDefault();
        el.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });
}

// ===== Login / Signup =====
// Real RFC-5322 simplified email regex (good enough for 99% of valid emails)
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;

// Block obviously fake/disposable email domains
const BLOCKED_EMAIL_DOMAINS = [
  'tempmail.com', 'temp-mail.org', '10minutemail.com', 'guerrillamail.com',
  'mailinator.com', 'throwaway.email', 'yopmail.com', 'fake.com', 'test.com',
  'example.com', 'example.org', 'local', 'localhost', 'tohna1.app', 'tohna1quiz.com',
];

function validateEmail(email) {
  if (!email) return 'כתובת מייל חובה';
  if (email.length > 254) return 'כתובת מייל ארוכה מדי';
  if (!EMAIL_REGEX.test(email)) return 'כתובת מייל לא חוקית';
  const domain = email.split('@')[1].toLowerCase();
  if (BLOCKED_EMAIL_DOMAINS.includes(domain)) return 'כתובת המייל הזו אינה מורשית. השתמש במייל אמיתי.';
  if (!domain.includes('.')) return 'דומיין המייל לא חוקי';
  const tld = domain.split('.').pop();
  if (tld.length < 2) return 'סיומת דומיין לא חוקית';
  return null;
}

function checkPasswordStrength(password) {
  return {
    length: password.length >= 8,
    letter: /[a-zA-Z]/.test(password),
    number: /[0-9]/.test(password),
    symbol: /[!@#$%^&*()_+\-=\[\]{};:'",.<>?\/\\|`~]/.test(password),
  };
}

function validatePassword(password) {
  const checks = checkPasswordStrength(password);
  if (!checks.length) return 'הסיסמה חייבת להכיל לפחות 8 תווים';
  if (!checks.letter) return 'הסיסמה חייבת להכיל לפחות אות אחת';
  if (!checks.number) return 'הסיסמה חייבת להכיל לפחות ספרה אחת';
  return null;
}

function passwordStrengthScore(password) {
  const c = checkPasswordStrength(password);
  let score = 0;
  if (c.length) score++;
  if (c.letter) score++;
  if (c.number) score++;
  if (c.symbol) score++;
  if (password.length >= 12) score++;
  return score; // 0-5
}

function renderLogin(signupModeInit = false) {
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-login'));

  let signupMode = signupModeInit;
  const form = document.getElementById('auth-form');
  const errEl = document.getElementById('auth-error');
  const emailErr = document.getElementById('email-error');
  const pwErr = document.getElementById('password-error');
  const pwStrength = document.getElementById('password-strength');
  const strengthFill = document.getElementById('strength-fill');
  const checkLen = document.getElementById('check-len');
  const checkLetter = document.getElementById('check-letter');
  const checkNumber = document.getElementById('check-number');
  const checkSymbol = document.getElementById('check-symbol');

  function applyMode() {
    document.getElementById('auth-title').textContent = signupMode ? 'הרשמה חדשה' : 'כניסה לחשבון';
    document.getElementById('auth-tagline').textContent = signupMode
      ? 'התחל בחינם - 5 PDFs בלי עלות'
      : 'ברוך הבא חזרה';
    document.getElementById('btn-primary-action').textContent = signupMode ? 'צור חשבון' : 'כניסה';
    document.getElementById('btn-toggle-mode').textContent = signupMode
      ? 'כבר יש לך חשבון? כניסה'
      : 'אין לך חשבון? הירשם';
    document.getElementById('auth-password').autocomplete = signupMode ? 'new-password' : 'current-password';
    if (signupMode) {
      pwStrength.classList.remove('hidden');
    } else {
      pwStrength.classList.add('hidden');
    }
    errEl.textContent = '';
    emailErr.textContent = '';
    pwErr.textContent = '';
  }
  applyMode();

  // Toggle mode
  document.getElementById('btn-toggle-mode').addEventListener('click', () => {
    signupMode = !signupMode;
    applyMode();
  });

  // Live validation
  const emailInput = document.getElementById('auth-email');
  const pwInput = document.getElementById('auth-password');

  emailInput.addEventListener('blur', () => {
    const v = emailInput.value.trim();
    if (!v) { emailErr.textContent = ''; return; }
    const err = validateEmail(v);
    emailErr.textContent = err || '';
    emailInput.classList.toggle('invalid', !!err);
    emailInput.classList.toggle('valid', !err);
  });

  pwInput.addEventListener('input', () => {
    if (!signupMode) return;
    const v = pwInput.value;
    const checks = checkPasswordStrength(v);
    checkLen.classList.toggle('ok', checks.length);
    checkLetter.classList.toggle('ok', checks.letter);
    checkNumber.classList.toggle('ok', checks.number);
    checkSymbol.classList.toggle('ok', checks.symbol);
    const score = passwordStrengthScore(v);
    const pct = (score / 5) * 100;
    strengthFill.style.width = pct + '%';
    strengthFill.className = 'strength-fill';
    if (score >= 4) strengthFill.classList.add('strong');
    else if (score >= 3) strengthFill.classList.add('good');
    else if (score >= 2) strengthFill.classList.add('weak');
    else strengthFill.classList.add('vweak');
  });

  // Google OAuth
  document.getElementById('btn-google').addEventListener('click', async () => {
    if (!supabase) { errEl.textContent = 'המערכת אינה מוגדרת כראוי.'; return; }
    errEl.textContent = '';
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin + '/dashboard' },
    });
    if (error) {
      const m = error.message || '';
      if (m.includes('not enabled') || m.includes('provider')) {
        errEl.textContent = 'כניסה דרך Google עדיין לא הוגדרה במערכת. נסה הרשמה רגילה דרך מייל.';
      } else {
        errEl.textContent = 'שגיאה: ' + m;
      }
    }
  });

  // Submit handler (works for both modes)
  async function doAuth() {
    errEl.textContent = '';
    emailErr.textContent = '';
    pwErr.textContent = '';

    const email = emailInput.value.trim().toLowerCase();
    const password = pwInput.value;

    // Email validation
    const emailErrMsg = validateEmail(email);
    if (emailErrMsg) {
      emailErr.textContent = emailErrMsg;
      emailInput.classList.add('invalid');
      emailInput.focus();
      return;
    }

    // Password validation
    if (signupMode) {
      const pwErrMsg = validatePassword(password);
      if (pwErrMsg) {
        pwErr.textContent = pwErrMsg;
        pwInput.classList.add('invalid');
        pwInput.focus();
        return;
      }
    } else {
      if (password.length < 1) {
        pwErr.textContent = 'הסיסמה חובה';
        pwInput.focus();
        return;
      }
    }

    if (!supabase) {
      errEl.textContent = 'המערכת אינה מוגדרת כראוי. נסה שוב מאוחר יותר.';
      return;
    }

    const submitBtn = document.getElementById('btn-primary-action');
    submitBtn.disabled = true;
    submitBtn.textContent = signupMode ? 'יוצר חשבון...' : 'מתחבר...';

    try {
      if (signupMode) {
        const { data, error } = await supabase.auth.signUp({
          email,
          password,
          options: {
            data: {
              username: email.split('@')[0],
              signup_source: 'web',
              signup_at: new Date().toISOString(),
            },
            emailRedirectTo: window.location.origin + '/dashboard',
          },
        });
        if (error) { errEl.textContent = translateError(error.message); return; }
        if (data.user && data.session) {
          // Auto-confirmed
          await ensureProfile(data.user.id, email);
          navigate('/dashboard');
        } else if (data.user && !data.session) {
          errEl.textContent = '✓ נרשמת בהצלחה! נשלח אליך מייל לאישור החשבון. בדוק את תיבת הדואר.';
          errEl.style.color = 'var(--success)';
        }
      } else {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) { errEl.textContent = translateError(error.message); return; }
        await ensureProfile(data.user.id, email);
        navigate('/dashboard');
      }
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = signupMode ? 'צור חשבון' : 'כניסה';
    }
  }

  document.getElementById('btn-primary-action').addEventListener('click', (e) => {
    e.preventDefault();
    doAuth();
  });
  form.addEventListener('submit', (e) => { e.preventDefault(); doAuth(); });
}

async function ensureProfile(userId, email) {
  if (!supabase) return;
  const { data: existing } = await supabase.from('profiles').select('id').eq('id', userId).maybeSingle();
  if (existing) return;
  await supabase.from('profiles').upsert({
    id: userId,
    username: email.split('@')[0],
    email,
    plan: 'free',
  }, { onConflict: 'id' });
}

function translateError(msg) {
  const map = {
    'Invalid login credentials': 'אימייל או סיסמה שגויים',
    'User already registered': 'כבר קיים משתמש עם כתובת המייל הזו - נסה להתחבר במקום',
    'Email not confirmed': 'יש לאשר את המייל. בדוק את תיבת הדואר שלך.',
    'Email rate limit exceeded': 'נשלחו יותר מדי אימיילים. המתן כמה דקות ונסה שוב.',
    'Email address is invalid': 'כתובת המייל אינה חוקית',
    'Signup requires a valid password': 'נדרשת סיסמה חוקית',
    'Password should be at least 6 characters': 'הסיסמה חייבת להיות לפחות 8 תווים',
  };
  for (const [key, val] of Object.entries(map)) {
    if (msg.toLowerCase().includes(key.toLowerCase())) return val;
  }
  return msg;
}

// ===== Dashboard =====
async function renderDashboard() {
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-dashboard'));

  // User badge
  const username = state.profile?.username || state.user?.email?.split('@')[0] || 'משתמש';
  const plan = state.profile?.plan || 'free';
  document.getElementById('user-badge').textContent = `👤 ${username} • ${planLabel(plan)}`;

  // Logout
  document.getElementById('btn-logout').onclick = async () => {
    await supabase.auth.signOut();
    state.user = null;
    state.profile = null;
    navigate('/');
  };

  // Quotas
  renderQuotaBar();

  // Courses
  await loadCourses();

  // New course
  document.getElementById('btn-new-course').onclick = () => openNewCourseModal();
}

function planLabel(plan) {
  return { free: 'חינמי', basic: 'Basic', pro: 'Pro', education: 'Education' }[plan] || 'חינמי';
}

function renderQuotaBar() {
  const p = state.profile;
  if (!p) return;
  const limits = {
    free: { pdfs: 5, courses: 1, ai: 0 },
    basic: { pdfs: 30, courses: 5, ai: 100 },
    pro: { pdfs: 150, courses: -1, ai: 500 },
    education: { pdfs: 500, courses: -1, ai: 2000 },
  }[p.plan || 'free'];
  const bar = document.getElementById('quota-bar');
  bar.innerHTML = `
    <div style="display:flex;gap:32px;flex-wrap:wrap;">
      <div>📄 <strong>${p.pdfs_uploaded_this_month || 0}</strong> / ${limits.pdfs} קבצי PDF החודש</div>
      <div>📚 <strong>${state.courses?.length || 0}</strong> / ${limits.courses === -1 ? '∞' : limits.courses} קורסים</div>
      <div>✨ <strong>${p.ai_questions_used_this_month || 0}</strong> / ${limits.ai} שאלות AI החודש</div>
      ${p.plan === 'free' ? '<a href="/pricing" data-route="/pricing" class="btn btn-primary" style="margin-right:auto;">שדרג עכשיו</a>' : ''}
    </div>
  `;
}

async function loadCourses() {
  if (!supabase) return;
  const { data, error } = await supabase
    .from('ep_courses')
    .select('*')
    .eq('user_id', state.user.id)
    .order('created_at', { ascending: false });
  if (error) {
    document.getElementById('courses-grid').innerHTML = `<p class="error">שגיאה: ${error.message}</p>`;
    return;
  }
  state.courses = data || [];
  const grid = document.getElementById('courses-grid');
  if (!state.courses.length) {
    grid.innerHTML = `
      <div style="grid-column:1/-1;text-align:center;padding:60px 20px;background:white;border-radius:16px;border:2px dashed var(--border-strong);">
        <div style="font-size:48px;margin-bottom:16px;">📚</div>
        <h3 style="font-size:22px;margin:0 0 8px;">עוד אין לך קורסים</h3>
        <p style="color:var(--text-2);margin:0 0 20px;">צור את הקורס הראשון שלך והעלה את המבחן הראשון</p>
        <button class="btn btn-primary" onclick="document.getElementById('btn-new-course').click()">+ קורס חדש</button>
      </div>
    `;
    return;
  }
  grid.innerHTML = state.courses.map(c => `
    <div class="course-card" data-course-id="${c.id}">
      <h3>${escapeHtml(c.name)}</h3>
      <p style="color:var(--text-2);margin:0;font-size:14px;">${escapeHtml(c.description || '')}</p>
      <div class="stats">
        <span>📄 ${c.total_pdfs || 0} מבחנים</span>
        <span>❓ ${c.total_questions || 0} שאלות</span>
      </div>
    </div>
  `).join('');
  grid.querySelectorAll('.course-card').forEach(card => {
    card.onclick = () => navigate('/courses/' + card.dataset.courseId);
  });
  renderQuotaBar();
}

function openNewCourseModal() {
  const div = document.createElement('div');
  div.appendChild(tmpl('tmpl-new-course'));
  document.body.appendChild(div);

  const overlay = document.getElementById('modal-overlay');
  const close = () => overlay.remove();
  document.getElementById('btn-cancel-course').onclick = close;
  overlay.onclick = (e) => { if (e.target === overlay) close(); };

  const form = document.getElementById('new-course-form');
  const errEl = document.getElementById('course-error');
  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const name = form.name.value.trim();
    const description = form.description.value.trim();
    const { error } = await supabase.from('ep_courses').insert({
      user_id: state.user.id,
      name,
      description: description || null,
    });
    if (error) { errEl.textContent = error.message; return; }
    close();
    await loadCourses();
  };
}

// ===== Course Page (placeholder for now) =====
async function renderCoursePage(courseId) {
  $app.innerHTML = `
    <div class="dashboard">
      <header class="navbar">
        <div class="navbar-inner container">
          <a href="/dashboard" class="logo" data-route="/dashboard">
            <span class="logo-icon">📚</span>
            <span class="logo-text">ExamPrep</span>
          </a>
          <div class="nav-cta">
            <button class="btn btn-ghost" onclick="window.history.back()">← חזרה</button>
          </div>
        </div>
      </header>
      <main class="container" style="padding:40px 20px;">
        <h1>קורס #${escapeHtml(courseId)}</h1>
        <p class="muted">העלאת מבחנים ותרגול - עדיין בפיתוח. הגרסה המלאה תהיה זמינה בקרוב.</p>
        <div style="background:white;padding:40px;border-radius:16px;border:2px dashed var(--border-strong);text-align:center;margin-top:20px;">
          <div style="font-size:48px;">🚧</div>
          <h3>בקרוב</h3>
          <p>פיצ'רים שיתווספו: העלאת PDF, עיבוד אוטומטי, תרגול שאלות, ניתוח דפוסים, ושאלות AI דומות.</p>
        </div>
      </main>
    </div>
  `;
}

// ===== Boot =====
render();
