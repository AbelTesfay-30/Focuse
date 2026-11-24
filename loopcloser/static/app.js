/**
 * app.js — LoopCloser frontend
 * State management, API calls, live countdown/elapsed timer, CSV export.
 */

'use strict';

// ── API helpers ──────────────────────────────────────────────────────────────

const API = {
  async get(path) {
    const res = await fetch(path);
    if (!res.ok) await _throwApiError(res);
    // 204 or empty body
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
  async post(path, body) {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await _throwApiError(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
  async patch(path, body) {
    const res = await fetch(path, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) await _throwApiError(res);
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  },
};

async function _throwApiError(res) {
  let detail = `HTTP ${res.status}`;
  try {
    const json = await res.json();
    detail = json.detail || JSON.stringify(json);
  } catch (_) { /* ignore */ }
  throw new Error(detail);
}


// ── Toast notifications ──────────────────────────────────────────────────────

const ICONS = { error: '✕', success: '✓', warn: '⚠' };

function toast(message, type = 'error') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast toast--${type}`;
  el.innerHTML = `<span class="toast__icon">${ICONS[type] || '•'}</span>
                  <span class="toast__msg">${escHtml(message)}</span>`;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4500);
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ── State ────────────────────────────────────────────────────────────────────

const state = {
  activeSession: null,     // SessionOut | null
  projects: [],            // ProjectOut[]
  review: null,            // DailyReview | null
  timerInterval: null,
  selectedMinutes: 25,
};


// ── Timer helpers ────────────────────────────────────────────────────────────

function formatSeconds(totalSec) {
  const h   = Math.floor(totalSec / 3600);
  const m   = Math.floor((totalSec % 3600) / 60);
  const s   = totalSec % 60;
  if (h > 0) {
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }
  return `${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

function startTimerTick(session) {
  stopTimerTick();

  // We track elapsed server-side; use elapsed_seconds as the starting offset
  let elapsed = session.elapsed_seconds || 0;
  const planned = (session.planned_minutes || 0) * 60;

  const clockEl    = document.getElementById('timer-clock');
  const modeLabel  = document.getElementById('timer-mode-label');
  const progressEl = document.getElementById('progress-fill');

  function tick() {
    elapsed += 1;

    if (planned > 0 && elapsed <= planned) {
      // Countdown mode
      const remaining = planned - elapsed;
      clockEl.textContent = formatSeconds(remaining);
      modeLabel.textContent = 'remaining';
      const pct = Math.min((elapsed / planned) * 100, 100);
      progressEl.style.width = pct + '%';
    } else {
      // Overtime / elapsed mode
      const display = planned > 0 ? elapsed - planned : elapsed;
      clockEl.textContent = (planned > 0 ? '+' : '') + formatSeconds(display);
      modeLabel.textContent = planned > 0 ? 'overtime' : 'elapsed';
      progressEl.style.width = '100%';
    }
  }

  tick();
  state.timerInterval = setInterval(tick, 1000);
}

function stopTimerTick() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
}


// ── Browser Notifications ────────────────────────────────────────────────────

// Tracks the timeout ID so we can cancel it if a session is abandoned early
let _notifTimeout = null;

/**
 * Request notification permission from the browser.
 * Updates the 🔔 button to reflect current permission state.
 */
async function requestNotifPermission() {
  if (!('Notification' in window)) {
    toast('Your browser does not support notifications.', 'warn');
    return;
  }
  const result = await Notification.requestPermission();
  updateNotifButton(result);
  if (result === 'granted') {
    toast('Notifications enabled. You\'ll be alerted when time is up.', 'success');
  } else {
    toast('Notification permission denied. Enable it in browser settings.', 'warn');
  }
}

function updateNotifButton(permission) {
  const btn = document.getElementById('btn-notif');
  if (!btn) return;
  if (permission === 'granted') {
    btn.textContent = '🔔 On';
    btn.classList.add('notif-on');
  } else if (permission === 'denied') {
    btn.textContent = '🔕 Blocked';
    btn.classList.add('notif-blocked');
  } else {
    btn.textContent = '🔔 Notify';
    btn.classList.remove('notif-on', 'notif-blocked');
  }
}

/**
 * Schedule a browser notification to fire after `minutes` from now.
 * Also fires a secondary "halfway" nudge if duration > 10 minutes.
 */
function scheduleNotification(taskTitle, minutes) {
  cancelScheduledNotification();
  if (!('Notification' in window) || Notification.permission !== 'granted') return;

  const ms = minutes * 60 * 1000;

  // Halfway nudge (only if session is longer than 10 minutes)
  if (minutes > 10) {
    const halfMs = Math.floor(ms / 2);
    setTimeout(() => {
      if (!state.activeSession) return; // already stopped
      _sendNotification(
        '⏳ Halfway there',
        `${Math.floor(minutes / 2)}m done on "${taskTitle}". Keep going.`,
        'halfway'
      );
    }, halfMs);
  }

  // Time's up notification
  _notifTimeout = setTimeout(() => {
    if (!state.activeSession) return;
    _sendNotification(
      '⏰ Time\'s up!',
      `Your ${minutes}-minute block on "${taskTitle}" is complete. Close the loop.`,
      'timeup'
    );
    // Also show an in-app toast in case the tab is in focus
    toast(`⏰ Time's up! Close the loop on "${taskTitle}".`, 'warn');
  }, ms);
}

function cancelScheduledNotification() {
  if (_notifTimeout !== null) {
    clearTimeout(_notifTimeout);
    _notifTimeout = null;
  }
}

function _sendNotification(title, body, tag) {
  try {
    const n = new Notification(title, {
      body,
      tag,                      // collapses duplicate notifications
      icon: '/static/icon.png', // optional — silently ignored if file absent
      requireInteraction: tag === 'timeup', // "time's up" stays until dismissed
    });
    // Clicking the notification focuses the tab
    n.onclick = () => { window.focus(); n.close(); };
  } catch (e) {
    // Service-worker context mismatch in some browsers — fail silently
  }
}


// ── Render: Focus Panel ──────────────────────────────────────────────────────

function renderFocusPanel() {
  const session    = state.activeSession;
  const idleView   = document.getElementById('idle-view');
  const runView    = document.getElementById('running-view');
  const badge      = document.getElementById('timer-status-badge');

  if (session) {
    idleView.classList.add('hidden');
    runView.classList.remove('hidden');
    badge.textContent = 'RUNNING';
    badge.style.borderColor = 'var(--success)';
    badge.style.color       = 'var(--success)';

    document.getElementById('running-task-title').textContent   = session.task_title;
    document.getElementById('running-project-name').textContent = `↳ ${session.project_name}`;

    startTimerTick(session);
  } else {
    stopTimerTick();
    idleView.classList.remove('hidden');
    runView.classList.add('hidden');
    badge.textContent = 'IDLE';
    badge.style.borderColor = '';
    badge.style.color = '';

    // Reset clock
    document.getElementById('timer-clock').textContent  = '00:00';
    document.getElementById('timer-mode-label').textContent = 'elapsed';
    document.getElementById('progress-fill').style.width = '0%';
    document.getElementById('inp-outcome').value = '';
  }

  // Populate datalist suggestions from active projects
  const dl   = document.getElementById('project-suggestions');
  const hint = document.getElementById('project-input-hint');
  dl.innerHTML = '';
  const activeProjects = state.projects.filter(p => p.status === 'active');
  activeProjects.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.name;
    dl.appendChild(opt);
  });
  if (hint) {
    hint.textContent = activeProjects.length
      ? `${activeProjects.length} active project${activeProjects.length > 1 ? 's' : ''} — type a new name to create one`
      : 'No active projects yet — type a name to create one';
  }
}


// ── Render: Projects Board ───────────────────────────────────────────────────

function renderProjectsPanel() {
  const projects     = state.projects;
  const activeCount  = projects.filter(p => p.status === 'active').length;
  const listEl       = document.getElementById('project-list');
  const wipBadge     = document.getElementById('wip-badge');
  const wipBanner    = document.getElementById('wip-banner');
  const addForm      = document.getElementById('add-project-form');
  const addBtn       = document.getElementById('btn-add-project');
  const projectInput = document.getElementById('inp-project-name');

  wipBadge.textContent = `${activeCount} / 3`;
  document.getElementById('hdr-wip').textContent = `${activeCount} / 3`;

  const atLimit = activeCount >= 3;
  wipBanner.classList.toggle('hidden', !atLimit);
  addBtn.disabled     = atLimit;
  projectInput.disabled = atLimit;
  projectInput.placeholder = atLimit ? 'WIP limit reached' : 'Project name';

  const activeProjects = projects.filter(p => p.status === 'active');

  if (activeProjects.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No active projects yet.</div>';
    return;
  }

  listEl.innerHTML = '';
  activeProjects.forEach(p => {
    const hours = (p.total_minutes / 60).toFixed(1);
    const card  = document.createElement('div');
    card.className = 'project-card' + (p.is_stale ? ' project-card--stale' : '');
    card.innerHTML = `
      <div class="project-card__top">
        <div class="project-card__name">${escHtml(p.name)}</div>
        ${p.is_stale ? '<span class="badge-stale">STALE &gt;48h</span>' : ''}
      </div>
      <div class="project-card__meta mono">${hours}h logged (${p.total_minutes}m)</div>
      <div class="project-card__actions">
        <button class="btn btn-success" data-action="complete" data-id="${p.id}">✓ Complete</button>
        <button class="btn btn-ghost"   data-action="archive"  data-id="${p.id}">Archive</button>
      </div>
    `;
    listEl.appendChild(card);
  });

  // Event delegation for project action buttons
  listEl.querySelectorAll('button[data-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id     = Number(btn.dataset.id);
      const action = btn.dataset.action;
      const status = action === 'complete' ? 'completed' : 'archived';
      await handleProjectStatusUpdate(id, status);
    });
  });
}


// ── Render: Review Panel ─────────────────────────────────────────────────────

function renderReviewPanel() {
  const r = state.review;
  if (!r) return;

  // Header stats
  document.getElementById('hdr-minutes').textContent = `${r.total_deep_work_minutes}m`;
  document.getElementById('hdr-score').textContent   = r.focus_score;

  // Stats
  document.getElementById('stat-total-min').textContent = r.total_deep_work_minutes;
  document.getElementById('stat-completed').textContent  = r.completed_sessions_count;
  document.getElementById('stat-abandoned').textContent  = r.abandoned_sessions_count;
  document.getElementById('stat-stale').textContent      = r.stale_projects.length;

  // Score ring  — circumference = 2π × 38 ≈ 238.76
  const circumference = 238.76;
  const offset = circumference - (r.focus_score / 100) * circumference;
  document.getElementById('score-ring-fill').style.strokeDashoffset = offset;
  document.getElementById('score-number').textContent = r.focus_score;

  // Stale alert
  const staleAlert = document.getElementById('stale-alert');
  if (r.stale_projects.length > 0) {
    staleAlert.classList.remove('hidden');
    document.getElementById('stale-names').textContent =
      ' ' + r.stale_projects.map(p => p.name).join(', ');
  } else {
    staleAlert.classList.add('hidden');
  }

  // Outcome log
  const logEl = document.getElementById('outcome-log');
  if (r.sessions.length === 0) {
    logEl.innerHTML = '<div class="empty-state">No sessions logged today.</div>';
    return;
  }

  logEl.innerHTML = '';
  [...r.sessions].reverse().forEach(s => {
    const item = document.createElement('div');
    item.className = `outcome-item outcome-item--${s.status}`;
    const time = s.started_at.replace('T', ' ').substring(0, 16) + ' UTC';
    item.innerHTML = `
      <div class="outcome-item__dot"></div>
      <div class="outcome-item__body">
        <div class="outcome-item__title">${escHtml(s.task_title)}</div>
        <div class="outcome-item__outcome">${escHtml(s.outcome || '—')}</div>
        <div class="outcome-item__meta">${escHtml(s.project_name)} · ${s.actual_minutes}m · ${time}</div>
      </div>
    `;
    logEl.appendChild(item);
  });
}


// ── Action handlers ──────────────────────────────────────────────────────────

async function handleProjectStatusUpdate(id, status) {
  try {
    await API.patch(`/api/projects/${id}`, { status });
    toast(
      status === 'completed' ? 'Project marked complete.' : 'Project archived.',
      'success'
    );
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


async function handleAddProject() {
  const input = document.getElementById('inp-project-name');
  const name  = input.value.trim();
  if (!name) { toast('Enter a project name.', 'warn'); return; }

  try {
    await API.post('/api/projects', { name });
    input.value = '';
    toast('Project created.', 'success');
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


async function handleStartSession() {
  const projectInput = document.getElementById('inp-project-session');
  const taskTitle    = document.getElementById('inp-task').value.trim();
  const minutes      = parseInt(document.getElementById('inp-duration').value, 10);

  const projectName = projectInput.value.trim();
  if (!projectName)         { toast('Enter a project name.', 'warn');     return; }
  if (!taskTitle)           { toast('Enter a task title.', 'warn');       return; }
  if (!minutes || minutes < 1) { toast('Enter a valid duration.', 'warn'); return; }

  try {
    // Find an existing active project by name (case-insensitive), or create one
    let project = state.projects.find(
      p => p.status === 'active' && p.name.toLowerCase() === projectName.toLowerCase()
    );

    if (!project) {
      // Will throw if WIP limit is hit
      project = await API.post('/api/projects', { name: projectName });
      toast(`Project "${project.name}" created.`, 'success');
      // Merge into state so the board doesn't go stale before full refresh
      state.projects = [...state.projects, project];
    }

    const session = await API.post('/api/sessions/start', {
      project_id:      project.id,
      task_title:      taskTitle,
      planned_minutes: minutes,
    });

    state.activeSession = session;
    projectInput.value  = '';
    document.getElementById('inp-task').value = '';

    scheduleNotification(session.task_title, minutes);
    renderFocusPanel();
    toast('Focus block started. Lock in.', 'success');
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


async function handleStopSession(status) {
  const session = state.activeSession;
  if (!session) return;

  const outcome = document.getElementById('inp-outcome').value.trim();
  if (outcome.length < 5) {
    toast('Describe your outcome (min 5 chars) before closing.', 'warn');
    return;
  }

  try {
    await API.post(`/api/sessions/${session.id}/stop`, { outcome, status });
    state.activeSession = null;
    cancelScheduledNotification();
    renderFocusPanel();
    toast(status === 'completed' ? 'Session completed. Loop closed.' : 'Session abandoned.', 'success');
    await refreshAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}


// ── Duration preset buttons ──────────────────────────────────────────────────

function initDurationPresets() {
  const container  = document.getElementById('duration-presets');
  const durationEl = document.getElementById('inp-duration');

  // Set first preset active on load
  container.querySelectorAll('.btn-preset').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const min = parseInt(btn.dataset.min, 10);
      if (min > 0) {
        durationEl.value = min;
        state.selectedMinutes = min;
      } else {
        durationEl.value = '';
        durationEl.focus();
      }
    });
  });

  // Mark first preset active
  container.querySelector('.btn-preset')?.classList.add('active');
  durationEl.addEventListener('input', () => {
    container.querySelectorAll('.btn-preset').forEach(b => b.classList.remove('active'));
  });
}


// ── Data refresh ─────────────────────────────────────────────────────────────

async function refreshProjects() {
  try {
    state.projects = await API.get('/api/projects');
    renderProjectsPanel();
    renderFocusPanel();   // re-populate project dropdown
  } catch (err) {
    toast('Failed to load projects: ' + err.message, 'error');
  }
}

async function refreshActiveSession() {
  try {
    state.activeSession = await API.get('/api/sessions/active');
    renderFocusPanel();
  } catch (err) {
    toast('Failed to load active session: ' + err.message, 'error');
  }
}

async function refreshReview() {
  try {
    state.review = await API.get('/api/review/today');
    renderReviewPanel();
  } catch (err) {
    toast('Failed to load review: ' + err.message, 'error');
  }
}

async function refreshAll() {
  await Promise.all([refreshProjects(), refreshActiveSession(), refreshReview()]);
}


// ── CSV Export ───────────────────────────────────────────────────────────────

function handleExportCsv() {
  const a = document.createElement('a');
  a.href = '/api/export/csv';
  a.download = 'loopcloser_sessions.csv';
  a.click();
}


// ── Periodic sync (re-fetch active session every 30s) ────────────────────────

function startPeriodicSync() {
  setInterval(async () => {
    // Only re-fetch session data if the page is visible
    if (document.visibilityState !== 'visible') return;
    try {
      const fresh = await API.get('/api/sessions/active');
      // Only update elapsed_seconds without resetting the interval
      if (state.activeSession && fresh && fresh.id === state.activeSession.id) {
        state.activeSession.elapsed_seconds = fresh.elapsed_seconds;
      } else if (!!state.activeSession !== !!fresh) {
        // Session started or ended from another tab/client
        state.activeSession = fresh;
        renderFocusPanel();
      }
    } catch (_) { /* silent */ }
  }, 30_000);

  // Refresh review every 5 minutes
  setInterval(() => refreshReview(), 5 * 60_000);
}


// ── Bootstrap ────────────────────────────────────────────────────────────────

function bindEvents() {
  document.getElementById('btn-add-project').addEventListener('click', handleAddProject);
  document.getElementById('inp-project-name').addEventListener('keydown', e => {
    if (e.key === 'Enter') handleAddProject();
  });

  document.getElementById('btn-start').addEventListener('click', handleStartSession);

  document.getElementById('btn-complete').addEventListener('click', () => handleStopSession('completed'));
  document.getElementById('btn-abandon').addEventListener('click',  () => handleStopSession('abandoned'));

  document.getElementById('btn-export').addEventListener('click', handleExportCsv);
  document.getElementById('btn-refresh-review').addEventListener('click', refreshReview);

  document.getElementById('btn-notif').addEventListener('click', requestNotifPermission);
}

async function init() {
  initDurationPresets();
  bindEvents();
  // Reflect current notification permission without prompting
  if ('Notification' in window) {
    updateNotifButton(Notification.permission);
  } else {
    const btn = document.getElementById('btn-notif');
    if (btn) { btn.textContent = '🔕'; btn.disabled = true; }
  }
  await refreshAll();
  startPeriodicSync();
}

document.addEventListener('DOMContentLoaded', init);
