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
function renderLogin(signupMode = false) {
  $app.innerHTML = '';
  $app.appendChild(tmpl('tmpl-login'));
  document.getElementById('auth-title').textContent = signupMode ? 'הרשמה חדשה' : 'כניסה לחשבון';

  const form = document.getElementById('auth-form');
  const errEl = document.getElementById('auth-error');

  async function doAuth(action) {
    errEl.textContent = '';
    const email = form.email.value.trim();
    const password = form.password.value;
    if (!email.includes('@')) { errEl.textContent = 'כתובת מייל לא חוקית'; return; }
    if (password.length < 6) { errEl.textContent = 'הסיסמה חייבת להיות לפחות 6 תווים'; return; }

    if (!supabase) {
      errEl.textContent = 'המערכת אינה מוגדרת כראוי. נסה שוב מאוחר יותר.';
      return;
    }

    if (action === 'signup') {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) { errEl.textContent = translateError(error.message); return; }
      if (data.user && data.session) {
        // Create profile
        const username = email.split('@')[0];
        await supabase.from('profiles').upsert({
          id: data.user.id,
          username,
          email,
          plan: 'free',
        });
        navigate('/dashboard');
      } else if (data.user && !data.session) {
        errEl.textContent = 'נשלח אליך מייל לאישור. בדוק את תיבת הדואר שלך.';
      }
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) { errEl.textContent = translateError(error.message); return; }
      // Make sure profile exists
      const profile = await getProfile(data.user.id);
      if (!profile) {
        await supabase.from('profiles').upsert({
          id: data.user.id,
          username: email.split('@')[0],
          email,
          plan: 'free',
        });
      }
      navigate('/dashboard');
    }
  }

  document.getElementById('btn-login').onclick = () => doAuth('login');
  document.getElementById('btn-signup').onclick = () => doAuth('signup');
  form.addEventListener('submit', (e) => { e.preventDefault(); doAuth(signupMode ? 'signup' : 'login'); });
}

function translateError(msg) {
  const map = {
    'Invalid login credentials': 'שם משתמש או סיסמה שגויים',
    'User already registered': 'משתמש כבר קיים במערכת',
    'Email not confirmed': 'יש לאשר את המייל לפני התחברות',
    'Email rate limit exceeded': 'נשלחו יותר מדי אימיילים. המתן כמה דקות.',
  };
  return map[msg] || msg;
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
    .from('courses')
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
    const { error } = await supabase.from('courses').insert({
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
