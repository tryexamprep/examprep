/* ============================================================
   ExamPrep Vocab — Main Application
   Standalone vocabulary practice SPA.
   ============================================================ */

'use strict';

// ── Constants ──────────────────────────────────────────────
const DAY_MS = 86_400_000;
const SM2_INTERVALS = [0, 1, 3, 7, 14, 30]; // days per mastery level

// ── VocabData — lazy JSON loader ───────────────────────────
const VocabData = (() => {
  const cache = {};

  async function load(section) {
    if (cache[section]) return cache[section];
    const url = `data/${section}-words.json`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
    const json = await res.json();
    // Flatten levels into a simple words array with level attached
    json.allWords = json.levels.flatMap(lvl =>
      lvl.words.map(w => ({ ...w, level: lvl.level, levelName: lvl.name }))
    );
    cache[section] = json;
    return json;
  }

  function getWords(data, { level = 'all', bookmarks = null, dueOnly = false, progress = null } = {}) {
    let words = data.allWords;
    if (level !== 'all') words = words.filter(w => w.level === Number(level));
    if (bookmarks) words = words.filter(w => bookmarks.includes(w.id));
    if (dueOnly && progress) words = words.filter(w => {
      const m = progress.mastery[w.id];
      return !m || m.nextReview <= Date.now();
    });
    return words;
  }

  function search(data, query) {
    const q = query.toLowerCase().trim();
    if (!q) return data.allWords;
    return data.allWords.filter(w =>
      w.word.toLowerCase().includes(q) ||
      w.translation.toLowerCase().includes(q) ||
      (w.definition && w.definition.toLowerCase().includes(q))
    );
  }

  return { load, getWords, search };
})();

// ── VocabProgress — localStorage CRUD + spaced repetition ─
const VocabProgress = (() => {
  const KEY = 'ep_vocab_v1';

  function _default() {
    return {
      bookmarks: [],
      mastery: {},
      customAssociations: {},
      quizHistory: [],
      dailyStreak: { current: 0, longest: 0, lastDate: null },
      settings: { dailyGoal: 10, currentSection: 'english' }
    };
  }

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || _default(); }
    catch { return _default(); }
  }

  function save(data) {
    localStorage.setItem(KEY, JSON.stringify(data));
  }

  function recordAnswer(wordId, isCorrect) {
    const data = load();
    const m = data.mastery[wordId] || { level: 0, streak: 0, lastSeen: 0, nextReview: 0, seen: 0, correct: 0 };
    m.lastSeen = Date.now();
    m.seen++;
    if (isCorrect) {
      m.streak++;
      m.correct++;
      m.level = Math.min(5, m.level + 1);
    } else {
      m.streak = 0;
      m.level = Math.max(0, m.level - 1);
    }
    m.nextReview = Date.now() + SM2_INTERVALS[m.level] * DAY_MS;
    data.mastery[wordId] = m;
    // Update daily streak
    updateStreak(data);
    save(data);
  }

  function updateStreak(data) {
    const today = new Date().toISOString().slice(0, 10);
    const s = data.dailyStreak;
    if (s.lastDate === today) return;
    const yesterday = new Date(Date.now() - DAY_MS).toISOString().slice(0, 10);
    if (s.lastDate === yesterday) {
      s.current++;
    } else {
      s.current = 1;
    }
    s.lastDate = today;
    s.longest = Math.max(s.longest, s.current);
  }

  function toggleBookmark(wordId) {
    const data = load();
    const idx = data.bookmarks.indexOf(wordId);
    if (idx === -1) {
      data.bookmarks.push(wordId);
    } else {
      data.bookmarks.splice(idx, 1);
    }
    save(data);
    return idx === -1; // true = added
  }

  function isBookmarked(wordId) {
    return load().bookmarks.includes(wordId);
  }

  function saveCustomAssociation(wordId, text) {
    if (!text.trim()) return;
    const data = load();
    if (!data.customAssociations[wordId]) data.customAssociations[wordId] = [];
    data.customAssociations[wordId].push({ text: text.trim(), createdAt: Date.now() });
    save(data);
  }

  function getCustomAssociations(wordId) {
    return load().customAssociations[wordId] || [];
  }

  function addQuizRecord(record) {
    const data = load();
    data.quizHistory.unshift({ ...record, ts: Date.now() });
    if (data.quizHistory.length > 50) data.quizHistory.pop();
    updateStreak(data);
    save(data);
  }

  function getStats(section, allWords) {
    const data = load();
    const prog = data;
    const now = Date.now();
    let mastered = 0, learning = 0, newWords = 0, due = 0;
    for (const w of allWords) {
      const m = prog.mastery[w.id];
      if (!m) { newWords++; }
      else if (m.level === 5) { mastered++; }
      else { learning++; if (m.nextReview <= now) due++; }
      if (!m) due++; // new words are also "due"
    }
    return { mastered, learning, newWords, due, streak: data.dailyStreak.current, longestStreak: data.dailyStreak.longest };
  }

  function getMastery(wordId) {
    return load().mastery[wordId];
  }

  function getMasteryLevel(wordId) {
    const m = getMastery(wordId);
    return m ? m.level : 0;
  }

  return { load, save, recordAnswer, toggleBookmark, isBookmarked, saveCustomAssociation, getCustomAssociations, addQuizRecord, getStats, getMastery, getMasteryLevel };
})();

// ── State ──────────────────────────────────────────────────
const state = {
  section: 'english',
  level: 'all',
  currentData: null,
};

// ── App (router & boot) ────────────────────────────────────
const App = (() => {
  const $app = document.getElementById('app');

  function mount(templateId, callback) {
    const tmpl = document.getElementById(templateId);
    if (!tmpl) { $app.innerHTML = `<div class="page"><p>תבנית לא נמצאה: ${templateId}</p></div>`; return; }
    $app.innerHTML = '';
    $app.appendChild(tmpl.content.cloneNode(true));
    updateNavActive();
    if (callback) callback();
  }

  function navigate(path) {
    location.hash = '#' + path;
  }

  function getRoute() {
    const hash = location.hash.slice(1) || '/';
    return hash.split('?')[0];
  }

  function getParams() {
    const hash = location.hash.slice(1) || '/';
    return new URLSearchParams(hash.split('?')[1] || '');
  }

  async function renderRoute() {
    const path = getRoute();
    const params = getParams();
    try {
      if (path === '/' || path === '') return await renderHome();
      if (path === '/browse') return await renderBrowse(params);
      if (path === '/flashcards') return await renderFlashcards(params);
      if (path === '/quiz') return await renderQuiz(params);
      if (path === '/match') return await renderMatch(params);
      if (path === '/progress') return await renderProgress();
      return await renderHome();
    } catch (err) {
      console.error('[renderRoute]', err);
      $app.innerHTML = `<div class="page" style="text-align:center;padding:60px 20px;">
        <div style="font-size:2.5rem;margin-bottom:12px;">😕</div>
        <h2>משהו השתבש</h2>
        <p style="color:var(--text-muted);margin-top:8px;">${err.message}</p>
        <a href="#/" class="btn btn-primary" style="margin-top:20px;display:inline-flex;">חזרה לבית</a>
      </div>`;
    }
  }

  function updateNavActive() {
    const path = getRoute();
    document.querySelectorAll('[data-route]').forEach(el => {
      el.classList.toggle('active', el.dataset.route === path ||
        (path === '/' && el.dataset.route === '/'));
    });
  }

  function boot() {
    // Theme
    const saved = localStorage.getItem('ep_vocab_theme');
    if (saved === 'dark') document.documentElement.setAttribute('data-theme', 'dark');

    document.getElementById('theme-toggle').addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      document.documentElement.setAttribute('data-theme', isDark ? 'light' : 'dark');
      localStorage.setItem('ep_vocab_theme', isDark ? 'light' : 'dark');
      document.getElementById('theme-toggle').textContent = isDark ? '🌙' : '☀️';
    });
    if (saved === 'dark') document.getElementById('theme-toggle').textContent = '☀️';

    // Routing
    window.addEventListener('hashchange', renderRoute);
    renderRoute();
  }

  return { boot, mount, navigate, $app };
})();

// ── Toast ──────────────────────────────────────────────────
function showToast(msg, ms = 2000) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), ms);
}

// ── Helpers ────────────────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function formatDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('he-IL', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function formatTime(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function diffBadge(level) {
  const names = ['', 'בסיסי', 'בינוני', 'מתקדם', 'קשה', 'מומחה'];
  return `<span class="diff-badge l${level}">${names[level] || level}</span>`;
}

function masteryDot(wordId) {
  const level = VocabProgress.getMasteryLevel(wordId);
  return `<span class="mastery-dot m${level}" title="רמת שליטה ${level}/5"></span>`;
}

function bestAssociation(word) {
  const custom = VocabProgress.getCustomAssociations(word.id);
  if (custom.length > 0) return custom[0].text;
  if (word.associations && word.associations.length > 0) {
    // Prefer Hebrew association
    const he = word.associations.find(a => a.lang === 'he');
    return he ? he.text : word.associations[0].text;
  }
  return null;
}

function generateDistractors(targetWord, allWords, count = 3) {
  const pool = allWords.filter(w => w.id !== targetWord.id);
  const sameLevel = pool.filter(w => Math.abs(w.level - targetWord.level) <= 1);
  const source = sameLevel.length >= count ? sameLevel : pool;
  return shuffle(source).slice(0, count);
}

// ── Word row HTML (Browse) ─────────────────────────────────
function buildWordRow(word, section) {
  const isHe = section === 'hebrew';
  const isBookmarked = VocabProgress.isBookmarked(word.id);
  const custom = VocabProgress.getCustomAssociations(word.id);
  const assocHtml = [
    ...(word.associations || []).map(a => `
      <div class="assoc-card">
        <span class="assoc-flag">${a.lang === 'he' ? '🇮🇱' : '🇺🇸'}</span>
        <span>${escHtml(a.text)}</span>
      </div>`),
    ...custom.map(a => `
      <div class="assoc-card user-assoc">
        <span class="assoc-flag">✏️</span>
        <span>${escHtml(a.text)}</span>
      </div>`)
  ].join('');

  const synonyms = (word.synonyms || []).map(s => `<span class="tag">${escHtml(s)}</span>`).join('');
  const antonyms = (word.antonyms || []).map(s => `<span class="tag" style="background:var(--red-100);color:var(--red-600);">${escHtml(s)}</span>`).join('');

  return `
    <div class="word-row" id="row-${word.id}">
      <div class="word-row-header" data-word-id="${word.id}">
        ${masteryDot(word.id)}
        <span class="word-row-word ${isHe ? 'hebrew-word' : ''}">${escHtml(word.word)}</span>
        <span class="word-row-translation">${escHtml(word.translation)}</span>
        <div class="word-row-actions">
          ${diffBadge(word.level)}
          <span class="word-row-pos">${escHtml(word.partOfSpeech || '')}</span>
          <button class="bookmark-btn ${isBookmarked ? 'bookmarked' : ''}" data-word-id="${word.id}" title="מועדף">
            ${isBookmarked ? '★' : '☆'}
          </button>
          <span class="expand-icon">▾</span>
        </div>
      </div>
      <div class="word-detail">
        <div class="word-detail-section">
          <h4>הגדרה</h4>
          <div class="word-definition">${escHtml(word.definition || '')}</div>
        </div>
        ${word.example ? `
        <div class="word-detail-section">
          <h4>דוגמה</h4>
          <div class="word-example">
            ${escHtml(word.example)}
            ${word.exampleTranslation ? `<span class="example-en">${escHtml(word.exampleTranslation)}</span>` : ''}
          </div>
        </div>` : ''}
        ${assocHtml ? `
        <div class="word-detail-section">
          <h4>אסוציאציות לזכירה</h4>
          <div class="assoc-list">${assocHtml}</div>
        </div>` : ''}
        ${synonyms ? `
        <div class="word-detail-section">
          <h4>מילים נרדפות</h4>
          <div class="tags-list">${synonyms}</div>
        </div>` : ''}
        ${antonyms ? `
        <div class="word-detail-section">
          <h4>ניגודים</h4>
          <div class="tags-list">${antonyms}</div>
        </div>` : ''}
        <div class="word-detail-section">
          <h4>הוסף אסוציאציה שלי</h4>
          <div class="custom-assoc-editor">
            <textarea placeholder="כתוב כאן אסוציאציה שתעזור לך לזכור את המילה..." rows="2" data-word-id="${word.id}"></textarea>
            <div>
              <button class="btn btn-secondary btn-sm save-assoc-btn" data-word-id="${word.id}">שמור אסוציאציה</button>
              <button class="btn btn-ghost btn-sm speak-btn" data-word="${escHtml(word.word)}" data-lang="${isHe ? 'he-IL' : 'en-US'}">🔊 השמע</button>
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function speak(text, lang) {
  if (!('speechSynthesis' in window)) { showToast('הדפדפן שלך אינו תומך בהשמעת קול'); return; }
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = lang;
  u.rate = 0.85;
  window.speechSynthesis.speak(u);
}

// ── Section toggle helper ──────────────────────────────────
function wireSectionToggle(containerId, onSection) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.section = btn.dataset.section;
      onSection(btn.dataset.section);
    });
    if (btn.dataset.section === state.section) btn.classList.add('active');
    else btn.classList.remove('active');
  });
}

// ─────────────────────────────────────────────────────────────
// PAGE: HOME
// ─────────────────────────────────────────────────────────────
async function renderHome() {
  App.mount('tmpl-home', async () => {
    // Load data for current section
    const data = await VocabData.load(state.section);
    state.currentData = data;

    // Word of the Day (deterministic by day)
    const dayIdx = Math.floor(Date.now() / DAY_MS);
    const wotd = data.allWords[dayIdx % data.allWords.length];
    document.getElementById('wotd-word').textContent = wotd.word;
    document.getElementById('wotd-translation').textContent = wotd.translation;
    document.getElementById('wotd-cta').addEventListener('click', () => {
      App.navigate('/flashcards');
    });

    // Section toggle
    wireSectionToggle('section-toggle', async (section) => {
      const d = await VocabData.load(section);
      state.currentData = d;
      updateStats(d);
      renderLevelOverview(d);
    });

    // Stats
    updateStats(data);

    // Level overview
    renderLevelOverview(data);

    // Mode cards
    document.querySelectorAll('.mode-card[data-mode]').forEach(card => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode;
        if (mode === 'review') App.navigate('/flashcards?due=1');
        else if (mode === 'bookmarks') App.navigate('/flashcards?bookmarks=1');
        else App.navigate('/' + mode);
      });
    });
  });
}

function updateStats(data) {
  const prog = VocabProgress.load();
  const stats = VocabProgress.getStats(state.section, data.allWords);
  document.getElementById('stat-mastered').textContent = stats.mastered;
  document.getElementById('stat-learning').textContent = stats.learning;
  document.getElementById('stat-due').textContent = stats.due;
  document.getElementById('stat-streak').textContent = stats.streak;
}

function renderLevelOverview(data) {
  const container = document.getElementById('home-levels');
  if (!container) return;
  const prog = VocabProgress.load();
  container.innerHTML = data.levels.map(lvl => {
    const total = lvl.words.length;
    const mastered = lvl.words.filter(w => (prog.mastery[w.id]?.level || 0) >= 5).length;
    const pct = total > 0 ? Math.round(mastered / total * 100) : 0;
    return `
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px;cursor:pointer;"
           onclick="App.navigate('/browse?level=${lvl.level}')">
        <span class="diff-badge l${lvl.level}" style="min-width:80px;text-align:center;">${escHtml(lvl.name)}</span>
        <div style="flex:1;background:var(--gray-200);border-radius:4px;height:8px;overflow:hidden;">
          <div style="width:${pct}%;background:var(--green-500);height:100%;border-radius:4px;"></div>
        </div>
        <span style="font-size:.82rem;color:var(--text-muted);min-width:60px;text-align:left;">${mastered}/${total} מילים</span>
      </div>`;
  }).join('');
}

// ─────────────────────────────────────────────────────────────
// PAGE: BROWSE
// ─────────────────────────────────────────────────────────────
async function renderBrowse(params) {
  App.mount('tmpl-browse', async () => {
    const initLevel = params.get('level') || 'all';
    let activeSection = state.section;
    let activeLevel = initLevel;
    let bookmarksOnly = false;
    let searchQuery = '';

    // Set level pill
    document.querySelectorAll('.level-pill').forEach(p => {
      p.classList.toggle('active', p.dataset.level === activeLevel);
    });

    const data = await VocabData.load(activeSection);
    state.currentData = data;
    renderList();

    // Section toggle
    wireSectionToggle('browse-section-toggle', async (section) => {
      activeSection = section;
      const d = await VocabData.load(section);
      state.currentData = d;
      renderList();
    });

    // Search
    const searchInput = document.getElementById('browse-search');
    let debounce;
    searchInput.addEventListener('input', e => {
      clearTimeout(debounce);
      debounce = setTimeout(() => { searchQuery = e.target.value; renderList(); }, 250);
    });

    // Level pills
    document.querySelectorAll('.level-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        document.querySelectorAll('.level-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
        activeLevel = pill.dataset.level;
        renderList();
      });
    });

    // Bookmarks checkbox
    document.getElementById('browse-bookmarks-only').addEventListener('change', e => {
      bookmarksOnly = e.target.checked;
      renderList();
    });

    function renderList() {
      const prog = VocabProgress.load();
      let words = searchQuery
        ? VocabData.search(state.currentData, searchQuery)
        : VocabData.getWords(state.currentData, { level: activeLevel });

      if (bookmarksOnly) words = words.filter(w => prog.bookmarks.includes(w.id));

      const count = document.getElementById('browse-count');
      if (count) count.textContent = `${words.length} מילים`;

      const list = document.getElementById('browse-list');
      if (!words.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">🔍</div><h3>לא נמצאו מילים</h3><p>נסה לחפש אחרת או לשנות את הסינון</p></div>`;
        return;
      }
      list.innerHTML = words.map(w => buildWordRow(w, activeSection)).join('');
      wireWordList(list, activeSection);
    }
  });
}

function wireWordList(container, section) {
  // Expand/collapse rows
  container.querySelectorAll('.word-row-header').forEach(header => {
    header.addEventListener('click', e => {
      if (e.target.closest('.bookmark-btn') || e.target.closest('button')) return;
      const row = header.closest('.word-row');
      row.classList.toggle('expanded');
    });
  });

  // Bookmark toggles
  container.querySelectorAll('.bookmark-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const id = btn.dataset.wordId;
      const added = VocabProgress.toggleBookmark(id);
      btn.textContent = added ? '★' : '☆';
      btn.classList.toggle('bookmarked', added);
      showToast(added ? '⭐ נוסף למועדפים' : '🗑 הוסר מהמועדפים');
    });
  });

  // Save custom association
  container.querySelectorAll('.save-assoc-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.wordId;
      const ta = btn.closest('.custom-assoc-editor').querySelector('textarea');
      VocabProgress.saveCustomAssociation(id, ta.value);
      ta.value = '';
      showToast('✅ האסוציאציה נשמרה!');
    });
  });

  // Audio buttons
  container.querySelectorAll('.speak-btn').forEach(btn => {
    btn.addEventListener('click', () => speak(btn.dataset.word, btn.dataset.lang));
  });
}

// ─────────────────────────────────────────────────────────────
// PAGE: FLASHCARDS
// ─────────────────────────────────────────────────────────────
async function renderFlashcards(params) {
  const initSection = params.get('section') || state.section;
  const initLevel = params.get('level') || 'all';
  const initDue = params.get('due') === '1';
  const initBookmarks = params.get('bookmarks') === '1';

  App.mount('tmpl-flashcards', async () => {
    const secEl = document.getElementById('fc-section');
    const levelEl = document.getElementById('fc-level');
    const dueEl = document.getElementById('fc-due-only');
    const bookmarkEl = document.getElementById('fc-bookmarks-only');

    secEl.value = initSection;
    levelEl.value = initLevel;
    dueEl.checked = initDue;
    bookmarkEl.checked = initBookmarks;

    // Count label update
    async function updateCount() {
      const d = await VocabData.load(secEl.value);
      const prog = VocabProgress.load();
      const words = VocabData.getWords(d, {
        level: levelEl.value,
        bookmarks: bookmarkEl.checked ? prog.bookmarks : null,
        dueOnly: dueEl.checked,
        progress: prog
      });
      const lbl = document.getElementById('fc-count-label');
      if (lbl) lbl.textContent = `${words.length} מילים נבחרו`;
    }
    [secEl, levelEl, dueEl, bookmarkEl].forEach(el => el.addEventListener('change', updateCount));
    updateCount();

    document.getElementById('fc-start-btn').addEventListener('click', async () => {
      const d = await VocabData.load(secEl.value);
      const prog = VocabProgress.load();
      let words = VocabData.getWords(d, {
        level: levelEl.value,
        bookmarks: bookmarkEl.checked ? prog.bookmarks : null,
        dueOnly: dueEl.checked,
        progress: prog
      });
      if (!words.length) { showToast('אין מילים בסינון הנוכחי'); return; }

      // Prioritize due words, then new, then seen
      const now = Date.now();
      const due = words.filter(w => !prog.mastery[w.id] || prog.mastery[w.id].nextReview <= now);
      const notDue = words.filter(w => prog.mastery[w.id] && prog.mastery[w.id].nextReview > now);
      words = [...shuffle(due), ...shuffle(notDue)];

      startFlashcardSession(words, secEl.value);
    });
  });
}

function startFlashcardSession(words, section) {
  const stage = document.getElementById('fc-stage');
  stage.style.display = 'block';
  document.querySelector('.fc-filter-panel').style.display = 'none';
  document.getElementById('fc-start-btn').style.display = 'none';
  document.getElementById('fc-count-label').style.display = 'none';

  let idx = 0;
  let knownCount = 0;
  let flipped = false;
  const isHe = section === 'hebrew';

  function updateCard() {
    if (idx >= words.length) { showEnd(); return; }
    const w = words[idx];
    flipped = false;
    const card = document.getElementById('fc-card');
    card.classList.remove('flipped');

    document.getElementById('fc-word').textContent = w.word;
    document.getElementById('fc-word').className = `flashcard-word${isHe ? ' he' : ''}`;
    document.getElementById('fc-pos').textContent = w.partOfSpeech || '';
    document.getElementById('fc-translation').textContent = w.translation;
    document.getElementById('fc-example').textContent = w.example || '';

    const assoc = bestAssociation(w);
    const assocEl = document.getElementById('fc-assoc');
    assocEl.textContent = assoc || '';
    assocEl.style.display = assoc ? 'block' : 'none';

    // Bookmark button
    const bm = document.getElementById('fc-btn-bookmark');
    const bookmarked = VocabProgress.isBookmarked(w.id);
    bm.textContent = bookmarked ? '★' : '☆';
    bm.title = bookmarked ? 'הסר ממועדפים' : 'סמן כמועדף';

    // Progress
    const pct = (idx / words.length) * 100;
    document.getElementById('fc-progress-fill').style.width = pct + '%';
    document.getElementById('fc-counter').textContent = `${idx + 1} / ${words.length}`;
  }

  function showEnd() {
    document.getElementById('fc-stage').querySelector('.flashcard-stage').style.display = 'none';
    const endEl = document.getElementById('fc-end');
    endEl.style.display = 'block';
    document.getElementById('fc-end-stats').textContent = `ידעת ${knownCount} מתוך ${words.length} מילים`;
  }

  // Wire controls
  document.getElementById('fc-card').addEventListener('click', () => {
    flipped = !flipped;
    document.getElementById('fc-card').classList.toggle('flipped', flipped);
  });
  document.getElementById('fc-btn-flip').addEventListener('click', () => {
    flipped = !flipped;
    document.getElementById('fc-card').classList.toggle('flipped', flipped);
  });

  document.getElementById('fc-btn-know').addEventListener('click', () => {
    VocabProgress.recordAnswer(words[idx].id, true);
    knownCount++;
    idx++;
    updateCard();
  });
  document.getElementById('fc-btn-learning').addEventListener('click', () => {
    VocabProgress.recordAnswer(words[idx].id, false);
    idx++;
    updateCard();
  });
  document.getElementById('fc-btn-prev').addEventListener('click', () => {
    if (idx > 0) { idx--; updateCard(); }
  });
  document.getElementById('fc-btn-next').addEventListener('click', () => {
    if (idx < words.length - 1) { idx++; updateCard(); }
  });
  document.getElementById('fc-btn-bookmark').addEventListener('click', () => {
    const added = VocabProgress.toggleBookmark(words[idx].id);
    const bm = document.getElementById('fc-btn-bookmark');
    bm.textContent = added ? '★' : '☆';
    showToast(added ? '⭐ נוסף למועדפים' : '🗑 הוסר מהמועדפים');
  });

  // Keyboard navigation
  function keyHandler(e) {
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      flipped = !flipped;
      document.getElementById('fc-card').classList.toggle('flipped', flipped);
    }
    if (e.key === '1') document.getElementById('fc-btn-know').click();
    if (e.key === '2') document.getElementById('fc-btn-learning').click();
    if (e.key === 'ArrowRight') document.getElementById('fc-btn-prev').click();
    if (e.key === 'ArrowLeft') document.getElementById('fc-btn-next').click();
  }
  document.addEventListener('keydown', keyHandler);

  // Touch swipe
  let touchStartX = 0;
  const cardEl = document.getElementById('fc-card');
  cardEl.addEventListener('touchstart', e => { touchStartX = e.touches[0].clientX; }, { passive: true });
  cardEl.addEventListener('touchend', e => {
    const dx = e.changedTouches[0].clientX - touchStartX;
    if (Math.abs(dx) > 60) {
      // RTL: swipe left (dx < 0) = next, swipe right (dx > 0) = prev
      if (dx < 0) document.getElementById('fc-btn-learning').click();
      else document.getElementById('fc-btn-know').click();
    }
  }, { passive: true });

  // End screen buttons
  document.getElementById('fc-restart-btn').addEventListener('click', () => {
    idx = 0; knownCount = 0;
    document.getElementById('fc-end').style.display = 'none';
    document.querySelector('.flashcard-stage').style.display = 'flex';
    words = shuffle(words);
    updateCard();
  });
  document.getElementById('fc-home-btn').addEventListener('click', () => {
    document.removeEventListener('keydown', keyHandler);
    App.navigate('/');
  });

  // Cleanup on route change
  window.addEventListener('hashchange', () => document.removeEventListener('keydown', keyHandler), { once: true });

  updateCard();
}

// ─────────────────────────────────────────────────────────────
// PAGE: QUIZ
// ─────────────────────────────────────────────────────────────
async function renderQuiz(params) {
  App.mount('tmpl-quiz', async () => {
    document.getElementById('qz-start-btn').addEventListener('click', async () => {
      const section = document.getElementById('qz-section').value;
      const level = document.getElementById('qz-level').value;
      const direction = document.getElementById('qz-direction').value;
      const count = parseInt(document.getElementById('qz-count').value, 10);
      const bookmarksOnly = document.getElementById('qz-bookmarks').checked;

      const d = await VocabData.load(section);
      const prog = VocabProgress.load();
      let pool = VocabData.getWords(d, {
        level,
        bookmarks: bookmarksOnly ? prog.bookmarks : null
      });

      if (pool.length < 4) { showToast('צריך לפחות 4 מילים לחידון — שנה סינון'); return; }

      const questions = shuffle(pool).slice(0, Math.min(count, pool.length));
      startQuizSession(questions, d.allWords, section, direction);
    });
  });
}

function startQuizSession(questions, allWords, section, direction) {
  document.getElementById('quiz-config').style.display = 'none';
  document.getElementById('quiz-stage').style.display = 'block';
  const isHe = section === 'hebrew';

  let idx = 0;
  let score = 0;
  const mistakes = [];
  let answered = false;

  function resolveDirection(q) {
    if (direction === 'random') return Math.random() > 0.5 ? 'toTranslation' : 'toWord';
    return direction;
  }

  function renderQuestion() {
    if (idx >= questions.length) { showQuizEnd(); return; }
    answered = false;
    const w = questions[idx];
    const dir = resolveDirection(w);
    const isToTranslation = dir === 'toTranslation';

    // Progress
    const pct = (idx / questions.length) * 100;
    document.getElementById('qz-progress-fill').style.width = pct + '%';
    document.getElementById('qz-score-display').textContent = `${score} נכון`;

    // Question
    document.getElementById('qz-prompt').textContent = isToTranslation ? 'מה פירוש המילה?' : 'מה המילה המתאימה לתרגום זה?';
    const wordEl = document.getElementById('qz-word');
    wordEl.textContent = isToTranslation ? w.word : w.translation;
    wordEl.className = `quiz-word${isHe && isToTranslation ? ' he' : ''}`;

    // Options: correct + 3 distractors
    const distractors = generateDistractors(w, allWords, 3);
    const options = shuffle([w, ...distractors]);
    const optionsEl = document.getElementById('qz-options');
    optionsEl.innerHTML = options.map((opt, i) => {
      const label = isToTranslation ? opt.translation : opt.word;
      return `<button class="quiz-option" data-word-id="${opt.id}" data-correct="${opt.id === w.id}">${escHtml(label)}</button>`;
    }).join('');

    // Hide feedback + next
    const feedback = document.getElementById('qz-feedback');
    feedback.classList.remove('visible');
    document.getElementById('qz-next-btn').style.display = 'none';

    // Wire option clicks
    optionsEl.querySelectorAll('.quiz-option').forEach(btn => {
      btn.addEventListener('click', () => {
        if (answered) return;
        answered = true;
        const isCorrect = btn.dataset.correct === 'true';
        if (isCorrect) score++;
        else mistakes.push(w);

        VocabProgress.recordAnswer(w.id, isCorrect);

        // Highlight
        optionsEl.querySelectorAll('.quiz-option').forEach(b => {
          b.disabled = true;
          if (b.dataset.correct === 'true') b.classList.add('correct');
          else if (b === btn && !isCorrect) b.classList.add('wrong');
        });

        // Feedback
        const assoc = bestAssociation(w);
        document.getElementById('qz-fb-result').textContent = isCorrect ? '✅ נכון!' : `❌ הייתה: "${isToTranslation ? w.translation : w.word}"`;
        document.getElementById('qz-fb-assoc').textContent = assoc || '';
        feedback.classList.add('visible');
        document.getElementById('qz-next-btn').style.display = 'block';

        // Auto-advance after 1.8s on correct
        if (isCorrect) {
          const t = setTimeout(() => { idx++; renderQuestion(); }, 1800);
          document.getElementById('qz-next-btn').addEventListener('click', () => { clearTimeout(t); idx++; renderQuestion(); }, { once: true });
        } else {
          document.getElementById('qz-next-btn').addEventListener('click', () => { idx++; renderQuestion(); }, { once: true });
        }
      });
    });
  }

  function showQuizEnd() {
    document.getElementById('quiz-stage').style.display = 'none';
    document.getElementById('quiz-end').style.display = 'block';
    const pct = Math.round(score / questions.length * 100);
    const endScore = document.getElementById('qz-end-score');
    endScore.textContent = `${pct}%`;
    endScore.className = `end-score ${pct >= 80 ? 'great' : pct >= 50 ? 'ok' : 'poor'}`;
    document.getElementById('qz-end-label').textContent = `${score} נכון מתוך ${questions.length} שאלות`;

    // Save to history
    VocabProgress.addQuizRecord({ section, mode: 'quiz', score, total: questions.length });

    // Mistakes list
    const wrap = document.getElementById('qz-mistakes-wrap');
    if (mistakes.length) {
      const isHe = section === 'hebrew';
      wrap.innerHTML = `<div class="section-h" style="margin-top:16px;"><h2>טעויות לחזרה</h2></div>
        <div class="quiz-mistakes-list">${mistakes.map(w => `
          <div class="quiz-mistake-row">
            <span class="quiz-mistake-word ${isHe ? 'he' : ''}">${escHtml(w.word)}</span>
            <span class="quiz-mistake-trans">${escHtml(w.translation)}</span>
          </div>`).join('')}</div>`;
    }

    document.getElementById('qz-retry-btn').addEventListener('click', () => {
      if (!mistakes.length) { showToast('לא היו טעויות!'); return; }
      startQuizSession(shuffle(mistakes), allWords.length ? allWords : mistakes, section, direction);
      document.getElementById('quiz-end').style.display = 'none';
    });
    document.getElementById('qz-home-btn').addEventListener('click', () => App.navigate('/'));
  }

  renderQuestion();
}

// ─────────────────────────────────────────────────────────────
// PAGE: MATCH
// ─────────────────────────────────────────────────────────────
async function renderMatch(params) {
  App.mount('tmpl-match', async () => {
    document.getElementById('mt-start-btn').addEventListener('click', async () => {
      const section = document.getElementById('mt-section').value;
      const level = document.getElementById('mt-level').value;

      const d = await VocabData.load(section);
      let pool = VocabData.getWords(d, { level });
      if (pool.length < 4) { showToast('צריך לפחות 4 מילים — שנה סינון'); return; }

      const pairs = shuffle(pool).slice(0, Math.min(8, pool.length));
      startMatchSession(pairs, section);
    });
  });
}

function startMatchSession(pairs, section) {
  document.getElementById('match-config').style.display = 'none';
  document.getElementById('match-stage').style.display = 'block';
  const isHe = section === 'hebrew';

  let selectedWord = null;
  let selectedTrans = null;
  let matchedCount = 0;
  let mistakes = 0;
  let startTime = Date.now();
  let timerInterval;

  // Timer
  timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - startTime) / 1000);
    const el = document.getElementById('mt-timer');
    if (el) el.textContent = formatTime(sec);
  }, 1000);

  // Render words + translations columns
  const shuffledWords = shuffle(pairs);
  const shuffledTrans = shuffle(pairs);

  const wordsCol = document.getElementById('mt-words-col');
  const transCol = document.getElementById('mt-trans-col');

  wordsCol.innerHTML = shuffledWords.map(w =>
    `<div class="match-item word-item ${isHe ? 'he' : ''}" data-id="${w.id}" data-type="word">${escHtml(w.word)}</div>`
  ).join('');
  transCol.innerHTML = shuffledTrans.map(w =>
    `<div class="match-item" data-id="${w.id}" data-type="trans">${escHtml(w.translation)}</div>`
  ).join('');

  document.getElementById('mt-matched-count').textContent = `${matchedCount}/${pairs.length} הותאמו`;

  function tryMatch() {
    if (!selectedWord || !selectedTrans) return;
    const isCorrect = selectedWord === selectedTrans;

    const wordEl = wordsCol.querySelector(`[data-id="${selectedWord}"]`);
    const transEl = transCol.querySelector(`[data-id="${selectedTrans}"]`);

    if (isCorrect) {
      matchedCount++;
      VocabProgress.recordAnswer(selectedWord, true);
      wordEl.classList.remove('selected');
      transEl.classList.remove('selected');
      wordEl.classList.add('correct');
      transEl.classList.add('correct');
      setTimeout(() => { wordEl.classList.add('gone'); transEl.classList.add('gone'); }, 400);
      document.getElementById('mt-matched-count').textContent = `${matchedCount}/${pairs.length} הותאמו`;
      if (matchedCount === pairs.length) {
        clearInterval(timerInterval);
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        setTimeout(() => showMatchEnd(elapsed), 600);
      }
    } else {
      mistakes++;
      VocabProgress.recordAnswer(selectedWord, false);
      wordEl.classList.remove('selected');
      transEl.classList.remove('selected');
      wordEl.classList.add('wrong');
      transEl.classList.add('wrong');
      setTimeout(() => {
        wordEl.classList.remove('wrong');
        transEl.classList.remove('wrong');
      }, 400);
      document.getElementById('mt-mistakes').textContent = `❌ ${mistakes} טעויות`;
    }
    selectedWord = null;
    selectedTrans = null;
  }

  function wireItems(container, type) {
    container.querySelectorAll('.match-item').forEach(item => {
      item.addEventListener('click', () => {
        if (item.classList.contains('correct') || item.classList.contains('gone')) return;
        container.querySelectorAll('.match-item').forEach(i => i.classList.remove('selected'));
        item.classList.add('selected');
        if (type === 'word') selectedWord = item.dataset.id;
        else selectedTrans = item.dataset.id;
        tryMatch();
      });
    });
  }
  wireItems(wordsCol, 'word');
  wireItems(transCol, 'trans');

  function showMatchEnd(elapsed) {
    document.getElementById('match-stage').style.display = 'none';
    document.getElementById('match-end').style.display = 'block';
    document.getElementById('mt-end-time').textContent = formatTime(elapsed);
    document.getElementById('mt-end-stats').textContent = `${mistakes} טעויות`;
    document.getElementById('mt-end-emoji').textContent = mistakes === 0 ? '🏆' : mistakes <= 2 ? '🎉' : '👍';
    VocabProgress.addQuizRecord({ section, mode: 'match', score: pairs.length - mistakes, total: pairs.length });

    document.getElementById('mt-play-again').addEventListener('click', () => {
      clearInterval(timerInterval);
      startMatchSession(shuffle(pairs), section);
      document.getElementById('match-end').style.display = 'none';
    });
    document.getElementById('mt-home-btn').addEventListener('click', () => {
      clearInterval(timerInterval);
      App.navigate('/');
    });
  }
}

// ─────────────────────────────────────────────────────────────
// PAGE: PROGRESS
// ─────────────────────────────────────────────────────────────
async function renderProgress() {
  App.mount('tmpl-progress', async () => {
    let activeSection = state.section;
    let data = await VocabData.load(activeSection);
    renderProgressContent(data);

    document.querySelectorAll('.prog-tab').forEach(tab => {
      tab.classList.toggle('active', tab.dataset.section === activeSection);
      tab.addEventListener('click', async () => {
        document.querySelectorAll('.prog-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        activeSection = tab.dataset.section;
        data = await VocabData.load(activeSection);
        renderProgressContent(data);
      });
    });
  });
}

function renderProgressContent(data) {
  const prog = VocabProgress.load();
  const now = Date.now();

  // Mastery bars
  const barsEl = document.getElementById('prog-mastery-bars');
  if (barsEl) {
    const categories = [
      { key: 'new',      label: 'חדש',    check: m => !m,                  cls: 'new' },
      { key: 'l1',       label: 'רמה 1',  check: m => m && m.level === 1,  cls: 'learning' },
      { key: 'l2',       label: 'רמה 2',  check: m => m && m.level === 2,  cls: 'learning' },
      { key: 'l3',       label: 'רמה 3',  check: m => m && m.level === 3,  cls: 'good' },
      { key: 'l4',       label: 'רמה 4',  check: m => m && m.level === 4,  cls: 'great' },
      { key: 'mastered', label: 'מושלם',  check: m => m && m.level === 5,  cls: 'mastered' },
    ];
    const total = data.allWords.length;
    barsEl.innerHTML = categories.map(cat => {
      const count = data.allWords.filter(w => cat.check(prog.mastery[w.id])).length;
      const pct = total > 0 ? Math.round(count / total * 100) : 0;
      return `<div class="mastery-bar-row">
        <span class="bar-label">${cat.label}</span>
        <div class="mastery-bar-track">
          <div class="mastery-bar-fill ${cat.cls}" style="width:${pct}%"></div>
        </div>
        <span class="bar-count">${count}</span>
      </div>`;
    }).join('');
  }

  // Streak
  const streakEl = document.getElementById('prog-streak');
  const streakBest = document.getElementById('prog-streak-best');
  if (streakEl) streakEl.textContent = prog.dailyStreak.current;
  if (streakBest) streakBest.textContent = `הרצף הטוב ביותר: ${prog.dailyStreak.longest} ימים`;

  // Per-level breakdown
  const levelsTable = document.getElementById('prog-levels-table');
  if (levelsTable) {
    levelsTable.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:.88rem;">
        <thead>
          <tr style="border-bottom:2px solid var(--border);">
            <th style="padding:8px 12px;text-align:right;font-weight:600;color:var(--text-muted);">רמה</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;color:var(--text-muted);">סה"כ</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;color:var(--text-muted);">נראו</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;color:var(--text-muted);">מושלם</th>
            <th style="padding:8px 12px;text-align:center;font-weight:600;color:var(--text-muted);">לחזרה</th>
          </tr>
        </thead>
        <tbody>
          ${data.levels.map(lvl => {
            const total = lvl.words.length;
            const seen = lvl.words.filter(w => prog.mastery[w.id]).length;
            const mastered = lvl.words.filter(w => (prog.mastery[w.id]?.level || 0) >= 5).length;
            const due = lvl.words.filter(w => {
              const m = prog.mastery[w.id];
              return !m || m.nextReview <= now;
            }).length;
            return `<tr style="border-bottom:1px solid var(--border);">
              <td style="padding:10px 12px;">${diffBadge(lvl.level)} ${escHtml(lvl.name)}</td>
              <td style="padding:10px 12px;text-align:center;">${total}</td>
              <td style="padding:10px 12px;text-align:center;">${seen}</td>
              <td style="padding:10px 12px;text-align:center;color:var(--green-600);font-weight:600;">${mastered}</td>
              <td style="padding:10px 12px;text-align:center;color:var(--orange-500);font-weight:600;">${due}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  }

  // Quiz history
  const histEl = document.getElementById('prog-history');
  if (histEl) {
    if (!prog.quizHistory.length) {
      histEl.innerHTML = '<div class="empty-state" style="padding:30px 0;"><div class="empty-icon">📊</div><p>עדיין לא ביצעת חידונים</p></div>';
    } else {
      histEl.innerHTML = prog.quizHistory.slice(0, 15).map(h => {
        const pct = Math.round(h.score / h.total * 100);
        return `<div class="history-row">
          <span class="hist-date">${formatDate(h.ts)}</span>
          <span class="hist-mode">${h.mode === 'quiz' ? '🎯 חידון' : '🔗 התאמה'} — ${h.section === 'english' ? '🇺🇸' : '🇮🇱'}</span>
          <span class="hist-score ${pct >= 80 ? 'good' : pct >= 50 ? 'ok' : 'poor'}">${h.score}/${h.total} (${pct}%)</span>
        </div>`;
      }).join('');
    }
  }
}

// ── Start ──────────────────────────────────────────────────
App.boot();
