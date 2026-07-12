/**
 * app.js — Main application logic for the Patient Records PWA
 *
 * Responsibilities:
 *  1. Register the service worker for PWA / offline support.
 *  2. Initialise the SQLite database (via db.js).
 *  3. Handle form submission: validate → insert → refresh list.
 *  4. Render the patient table and handle delete actions.
 *  5. Live search / filter the patient list.
 *  6. Show online/offline status.
 */

'use strict';

// ─── App version — stamped automatically at deploy time ──────────────────
const APP_VERSION = 'v120720261638';

// ─── API base URL ────────────────────────────────────────────────────────
const API_BASE = 'https://api.etbr.org/api';

// ─── DOM references ──────────────────────────────────────────────────────
const form             = document.getElementById('patient-form');
const submitBtn        = document.getElementById('submit-btn');
const exportBtn        = document.getElementById('export-btn');
const patientsTbody    = document.getElementById('patients-tbody');
const emptyState       = document.getElementById('empty-state');
const patientCount     = document.getElementById('patient-count');
const searchInput      = document.getElementById('search-input');
const connectionStatus = document.getElementById('connection-status');
const toast            = document.getElementById('toast');
const installBtn       = document.getElementById('install-btn');

// ART form shortcuts used across handlers
const sexIdSel       = document.getElementById('sexId');
const ageInput       = document.getElementById('age');
const dobInput       = document.getElementById('dateOfBirth');
const ageMonthsInput = document.getElementById('ageMonths');
const weightInput    = document.getElementById('weightKg');
const heightInput    = document.getElementById('heightCm');
const bmiDisplay     = document.getElementById('bmi');
const pmtctSection   = document.getElementById('pmtct-section');

// Visits panel
const visitsPanelEl       = document.getElementById('visits-panel');
const visitsPatientNameEl = document.getElementById('visits-patient-name');
const visitsTbody         = document.getElementById('visits-tbody');
const visitsEmptyEl       = document.getElementById('visits-empty');
const saveVisitBtnEl      = document.getElementById('save-visit-btn');
const visitDateInput      = document.getElementById('visitDate');
const visitMonthDisplay   = document.getElementById('visitMonthDisplay');
const stopReasonRow       = document.getElementById('stop-reason-row');

/** GUID of the patient whose visits are currently shown. */
let _currentVisitPatientTID = null;
let _currentVisitARTStart   = null;

/** GUID of the follow-up visit currently being edited (null = add-new mode). */
let _editingVisitTID = null;

/** True when the visits panel was opened by a read-only user (view-only mode). */
let _visitReadOnly = false;

/** GUID of the patient currently being edited (null = new-patient mode). */
let _editingTID = null;

// ─── Service Worker Registration ────────────────────────────────────────

// Clear the reload-guard flag that was set during the previous SW-triggered
// reload so it doesn't block future updates in this page session.
sessionStorage.removeItem('sw-reloading');

// If the last reload was triggered by a SW update, show a toast once the app is ready.
const _swJustUpdated = sessionStorage.getItem('sw-updated') === '1';
if (_swJustUpdated) sessionStorage.removeItem('sw-updated');

/**
 * Reload to apply fresh assets.
 * While the auth screen is visible, defer the reload so typed credentials
 * are not lost. The deferred reload is applied right after sign-in.
 */
function _reloadForSwUpdate(reason) {
  if (sessionStorage.getItem('sw-reloading')) return;

  const authEl = document.getElementById('auth-screen');
  if (authEl && !authEl.hidden) {
    sessionStorage.setItem('sw-pending-reload', '1');
    console.log(`[SW] ${reason} - deferring reload until after sign-in`);
    return;
  }

  sessionStorage.setItem('sw-reloading', '1');
  sessionStorage.setItem('sw-updated', '1');
  console.log(`[SW] ${reason} - reloading for fresh assets`);
  window.location.reload();
}

if ('serviceWorker' in navigator) {

  // ── IMPORTANT: attach controllerchange BEFORE the load event ─────────
  // The new SW can race through install → skipWaiting → activate →
  // clients.claim() while the page is still loading.  If we waited until
  // the load event to add this listener we'd miss the event entirely and
  // the page would never reload to serve the fresh files.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    _reloadForSwUpdate('Controller changed');
  });

  (async () => {
    try {
      const reg = await navigator.serviceWorker.register('./service-worker.js', {
        // Never use the browser's HTTP cache when fetching the SW script itself.
        // Without this the browser may serve a stale service-worker.js and users
        // get stuck on the old version until they manually clear their cache.
        updateViaCache: 'none'
      });
      console.log('[SW] Registered, scope:', reg.scope);

      // Force an immediate update check on every page open so a newly-deployed
      // service worker is picked up without waiting for the browser's background
      // check interval.
      reg.update().catch(() => {});

      // Also check for updates when the user returns to the tab (e.g. after
      // switching away and coming back).  This catches the case where the page
      // was already open when a deploy happened.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });

      // Belt-and-suspenders: also listen for the new SW's state changes so we
      // catch the case where skipWaiting fires before clients.claim (and therefore
      // before controllerchange).
      reg.addEventListener('updatefound', () => {
        const incoming = reg.installing;
        if (!incoming) return;
        incoming.addEventListener('statechange', () => {
          // 'activated' means the new SW has fully taken over.
          if (incoming.state === 'activated' && navigator.serviceWorker.controller) {
            _reloadForSwUpdate('New SW activated via updatefound');
          }
        });
      });

    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }
  })();
}

// ─── PWA Install Prompt ──────────────────────────────────────────────────

/** Holds the deferred BeforeInstallPromptEvent until the user clicks the button. */
let _deferredInstallPrompt = null;

/**
 * The browser fires `beforeinstallprompt` when the PWA meets installability
 * criteria (HTTPS, valid manifest, active service worker).
 * We prevent the default mini-infobar and surface our own button instead.
 */
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();

  const installedVer = localStorage.getItem('installedVersion');

  // Scenario 3: installed at the exact current version — nothing to do
  if (installedVer === APP_VERSION) {
    console.log('[PWA] App already installed at current version — button suppressed');
    return;
  }

  _deferredInstallPrompt = event;
  installBtn.hidden = false;

  // Scenario 1: never installed; Scenario 2: installed but on older version
  const label = document.getElementById('install-btn-label');
  if (label) label.textContent = installedVer ? 'Update App' : 'Install App';
  console.log('[PWA] Install prompt captured —', installedVer ? 'update available' : 'first install');
});

installBtn.addEventListener('click', async () => {
  // Fallback mode: browser doesn't support beforeinstallprompt — show dismissable instructions
  if (installBtn.dataset.fallback === 'true') {
    const alertEl = document.getElementById('install-instructions-alert');
    const textEl  = document.getElementById('install-instructions-text');
    if (textEl)  textEl.textContent = installBtn.dataset.instructions;
    if (alertEl) { alertEl.hidden = false; alertEl.classList.add('show'); }
    return;
  }

  if (!_deferredInstallPrompt) {
    console.warn('[PWA] No deferred install prompt available');
    return;
  }

  // Show the native install dialog
  _deferredInstallPrompt.prompt();

  const { outcome } = await _deferredInstallPrompt.userChoice;
  console.log('[PWA] Install prompt outcome:', outcome);  // 'accepted' | 'dismissed'

  // The prompt object can only be used once — discard it
  _deferredInstallPrompt = null;
  installBtn.hidden = true;
});

/** Fires after the user completes installation from our prompt or the browser UI. */
window.addEventListener('appinstalled', () => {
  console.log('[PWA] App installed/updated successfully');
  _deferredInstallPrompt = null;
  installBtn.hidden = true;
  installBtn.removeAttribute('data-fallback');
  localStorage.setItem('installedVersion', APP_VERSION);  // record exact installed version
  localStorage.removeItem('pwaInstalled');                 // clean up legacy key
  showToast('App installed successfully!', 'success');
});

/**
 * Fallback for browsers that never fire `beforeinstallprompt` (Firefox, Safari).
 * After the page loads, if we still have no deferred prompt and the app is not
 * already running in standalone mode, surface the button with manual instructions.
 */
window.addEventListener('load', () => {
  // Already running as an installed app
  if (window.matchMedia('(display-mode: standalone)').matches) {
    console.log('[PWA] Running in standalone mode — install button suppressed');
    return;
  }

  // beforeinstallprompt fires before/during load in supporting browsers.
  // A short defer ensures we don't race against it.
  setTimeout(() => {
    if (_deferredInstallPrompt !== null) return; // Chrome/Edge already handled it

    const installedVer = localStorage.getItem('installedVersion');
    // Scenario 3: installed and up to date — no button needed
    if (installedVer === APP_VERSION) return;

    const ua = navigator.userAgent;
    let instructions;

    if (ua.includes('Firefox') && ua.includes('Android')) {
      instructions = 'Firefox (Android): tap the menu button (⋮) at the bottom of the screen, tap "More", then tap "Add app to Home screen".';
    } else if (ua.includes('Firefox')) {
      instructions = 'Firefox (desktop): click the install icon (⬇) in the address bar to install this app.';
    } else if (/iPhone|iPad|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome/.test(ua))) {
      instructions = 'Safari: tap the Share button (□↑) then "Add to Home Screen".';
    } else if (ua.includes('SamsungBrowser')) {
      instructions = 'Samsung Internet: tap the menu button (⋮) at the bottom of the screen, then tap "Add page to" → "Bookmarks" or "Saved Pages" or "Home screen".';
    } else {
      instructions = 'Use your browser\'s menu to install this app.';
    }

    console.log('[PWA] Browser does not support beforeinstallprompt — showing manual install hint');
    installBtn.dataset.fallback = 'true';
    installBtn.dataset.instructions = instructions;
    installBtn.hidden = false;
    const label = document.getElementById('install-btn-label');
    if (label) label.textContent = installedVer ? 'Update App' : 'Install App';
  }, 300);
});

// ─── Online / Offline indicator ──────────────────────────────────────────

const _WIFI_ON_SVG  = `<svg viewBox="0 0 24 24" fill="none" stroke="#4ade80" stroke-width="2.5" width="14" height="14" aria-hidden="true" style="flex-shrink:0"><path d="M5 12.55a11 11 0 0114.08 0"/><path d="M1.42 9a16 16 0 0121.16 0"/><path d="M8.53 16.11a6 6 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;
const _WIFI_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="#fca5a5" stroke-width="2.5" width="14" height="14" aria-hidden="true" style="flex-shrink:0"><line x1="1" y1="1" x2="23" y2="23"/><path d="M16.72 11.06A10.94 10.94 0 0119 12.55"/><path d="M5 12.55a11 11 0 015.17-2.39"/><path d="M10.71 5.05A16 16 0 0122.56 9"/><path d="M1.42 9a15.91 15.91 0 014.7-2.88"/><path d="M8.53 16.11a6 6 0 016.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;

// Tracks real connectivity — navigator.onLine is unreliable in Firefox
// (it only reflects the browser "Work Offline" toggle, not actual WiFi state).
let _reallyOnline = navigator.onLine;

async function _pingConnectivity() {
  try {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), 3000);
    // Any HTTP response (even 4xx/5xx) means the network is reachable.
    // Only a TypeError (network error) means we're truly offline.
    await fetch(`${API_BASE}/auth/login`, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
    clearTimeout(tid);
    _reallyOnline = true;
  } catch {
    _reallyOnline = false;
  }
  updateConnectionStatus();
}

function updateConnectionStatus() {
  if (_reallyOnline) {
    connectionStatus.innerHTML  = `${_WIFI_ON_SVG} Online`;
    connectionStatus.className  = 'status-badge bg-success text-white';
  } else {
    connectionStatus.innerHTML  = `${_WIFI_OFF_SVG} Offline`;
    connectionStatus.className  = 'status-badge bg-danger text-white';
  }
}

// Native events work in Chrome/Opera — use them for instant feedback there.
window.addEventListener('online',  () => { _reallyOnline = true;  updateConnectionStatus(); });
window.addEventListener('offline', () => {
  _reallyOnline = false;
  updateConnectionStatus();
  // If the login screen is showing and a PIN is enrolled, switch to PIN panel
  if (!authScreen.hidden) showAuthScreen();
});
_pingConnectivity();   // set initial state with a real check
setInterval(_pingConnectivity, 15_000);  // poll every 15 s (catches Firefox WiFi drops)

// Stamp the version badge
const versionEl = document.getElementById('app-version');
if (versionEl) versionEl.textContent = 'v' + APP_VERSION.slice(-4);

// ─── Toast helper ────────────────────────────────────────────────────────

let _toastTimer;

// Show update notification now that showToast is defined
if (_swJustUpdated) setTimeout(() => showToast(`App updated to ${APP_VERSION}`, 'success'), 800);

/**
 * Shows a temporary notification at the bottom of the screen.
 * @param {string}  message
 * @param {'success'|'error'|''} type
 */
function showToast(message, type = '') {
  clearTimeout(_toastTimer);
  toast.textContent  = message;
  toast.className    = `toast show ${type}`.trim();

  // Errors stay visible longer so the full message can be read.
  const duration = type === 'error' ? 7000 : 3500;
  _toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, duration);
}

// ── Delete confirmation modal helper ──────────────────────────────────────
let _pendingDeleteFn = null;

function showDeleteConfirm(message, onConfirm) {
  _pendingDeleteFn = onConfirm;
  const msgEl = document.getElementById('delete-confirm-message');
  if (msgEl) msgEl.textContent = message;
  document.getElementById('delete-confirm-trigger').click();
}

document.getElementById('delete-confirm-btn').addEventListener('click', () => {
  if (_pendingDeleteFn) { _pendingDeleteFn(); _pendingDeleteFn = null; }
});

// ─── Validation ──────────────────────────────────────────────────────────

function validateForm() {
  let valid = true;

  function check(id, test, msg) {
    const el  = document.getElementById(id);
    const err = document.getElementById(`${id}-error`);
    if (!el) return;
    el.classList.remove('invalid');
    if (err) err.textContent = '';
    const val = el.tagName === 'SELECT' ? el.value : el.value;
    if (!test(val)) {
      el.classList.add('invalid');
      if (err) err.textContent = msg;
      valid = false;
    }
  }

  check('artNo',       v => v.trim().length >= 1, 'ART number is required.');
  check('fullName',    v => v.trim().length >= 2, 'Full name must be at least 2 characters.');
  check('artStartDate',v => v.trim().length > 0,  'ART Start Date is required.');
  check('age',         v => v !== '' && Number(v) >= 0 && Number(v) <= 99, 'Age must be 0–99.');
  check('sexId',       v => v !== '0' && v !== '', 'Please select sex.');

  // Age in months — only validate when the field is enabled and has a value
  if (ageMonthsInput && !ageMonthsInput.disabled && ageMonthsInput.value !== '') {
    check('ageMonths', v => { const n = Number(v); return !isNaN(n) && n >= 0 && n <= 1188; }, 'Age in months must be 0–1188 (max 99 years).');
  }

  // Cross-field: DOB must not be later than ART Start Date or Date Enrolled in Care
  const dobVal         = document.getElementById('dateOfBirth').value;
  const artStartVal    = document.getElementById('artStartDate').value;
  const enrolledVal    = document.getElementById('dateEnrolledInCare').value;
  const dobErr         = document.getElementById('dateOfBirth-error');
  const dobEl          = document.getElementById('dateOfBirth');
  if (dobErr) dobErr.textContent = '';
  if (dobEl)  dobEl.classList.remove('invalid');
  if (dobVal) {
    const msgs = [];
    if (artStartVal && dobVal > artStartVal)
      msgs.push('ART Start Date');
    if (enrolledVal && dobVal > enrolledVal)
      msgs.push('Date Enrolled in Care');
    if (msgs.length) {
      if (dobEl)  dobEl.classList.add('invalid');
      if (dobErr) dobErr.textContent = `Date of Birth cannot be after ${msgs.join(' or ')}.`;
      valid = false;
    }
  }
  // Weight and height — optional but must be within clinical bounds when entered
  if (weightInput && weightInput.value !== '') {
    check('weightKg', v => { const n = parseFloat(v); return !isNaN(n) && n >= 1 && n <= 250; }, 'Weight must be 1–250 kg.');
  }
  const heightEl = document.getElementById('heightCm');
  if (heightEl && heightEl.value !== '') {
    check('heightCm', v => { const n = parseFloat(v); return !isNaN(n) && n >= 30 && n <= 250; }, 'Height must be 30–250 cm.');
  }

  // MUAC — optional but within clinical bounds when entered
  const muacEl = document.getElementById('muacCm');
  if (muacEl && muacEl.value !== '') {
    check('muacCm', v => { const n = parseFloat(v); return !isNaN(n) && n >= 5 && n <= 60; }, 'MUAC must be 5–60 cm.');
  }

  // Baseline CD4 — validate range based on whether it is absolute or percentage
  const cd4El      = document.getElementById('cd4Value');
  const cd4IsPctEl = document.getElementById('cd4IsPercent');
  if (cd4El && cd4El.value !== '') {
    const isPct   = cd4IsPctEl?.checked;
    const maxCD4  = isPct ? 100 : 3500;
    const unitLbl = isPct ? '%' : 'cells/µL';
    check('cd4Value', v => { const n = parseFloat(v); return !isNaN(n) && n >= 0 && n <= maxCD4; },
      `CD4 must be 0–${maxCD4} ${unitLbl}.`);
  }

  // Phone 1 is optional — only validate format when a value is entered
  const phone1El = document.getElementById('phone1');
  if (phone1El && phone1El.value.trim() !== '') {
    check('phone1', v => /^0\d{9}$/.test(v.trim()), 'Phone 1 must be 10 digits starting with 0.');
  }

  const p2 = document.getElementById('phone2');
  if (p2 && p2.value.trim() !== '') {
    if (!/^0\d{9}$/.test(p2.value.trim())) {
      p2.classList.add('invalid');
      const e = document.getElementById('phone2-error');
      if (e) e.textContent = 'Phone 2 must be 10 digits starting with 0.';
      valid = false;
    }
  }

  // INH dates — each must be at least 7 days after the previous
  const inhEls = [...document.querySelectorAll('#inh-rows .dynamic-row input[type="date"]')]
    .filter(el => el.value);
  inhEls.forEach(el => el.classList.remove('invalid'));
  for (let i = 1; i < inhEls.length; i++) {
    const diffDays = (new Date(inhEls[i].value) - new Date(inhEls[i - 1].value)) / 86400000;
    if (diffDays < 7) {
      inhEls[i].classList.add('invalid');
      showToast(`INH Date ${i + 1} must be at least 7 days after Date ${i}.`, 'error');
      valid = false;
      break;
    }
  }

  // PMTCT delivery dates — each must be at least 365 days after the previous
  const pregEls = [...document.querySelectorAll('#pregnancy-rows .dynamic-row .preg-del')]
    .filter(el => el.value);
  pregEls.forEach(el => el.classList.remove('invalid'));
  for (let i = 1; i < pregEls.length; i++) {
    const diffDays = (new Date(pregEls[i].value) - new Date(pregEls[i - 1].value)) / 86400000;
    if (diffDays < 365) {
      pregEls[i].classList.add('invalid');
      showToast(`Pregnancy ${i + 1} delivery date must be at least 1 year after Pregnancy ${i}.`, 'error');
      valid = false;
      break;
    }
  }

  return valid;
}

// ─── Edit mode helpers ───────────────────────────────────────────────────

const SAVE_BTN_HTML = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z"/>
    <polyline points="17 21 17 13 7 13 7 21"/>
    <polyline points="7 3 7 8 15 8"/>
  </svg>
  Save Patient`;

const UPDATE_BTN_HTML = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
  Update Patient`;

function exitEditMode() {
  _editingTID = null;
  document.getElementById('edit-mode-banner').hidden = true;
  const _ceb = document.getElementById('cancel-edit-btn');
  if (_ceb) _ceb.hidden = true;
  document.getElementById('form-title').textContent  = 'New Patient — ART Register';
  submitBtn.innerHTML = SAVE_BTN_HTML;
}

/**
 * Pre-populates the patient form with an existing patient's data and
 * switches the form into edit mode.
 * @param {string} tid  PtDetailsTID (GUID) of the patient to edit.
 */
function loadPatientIntoForm(tid, scrollToForm = true) {
  const pt = getPtDetails(tid);
  if (!pt) { showToast('Patient record not found.', 'error'); return; }

  _editingTID = tid;

  // ── UI: switch to edit mode ────────────────────────────────────────────
  document.getElementById('form-title').textContent       = 'Edit Patient — ART Register';
  document.getElementById('edit-patient-name').textContent = pt.PtName;
  document.getElementById('edit-mode-banner').hidden      = false;
  const _cancelEditBtn = document.getElementById('cancel-edit-btn');
  if (_cancelEditBtn) _cancelEditBtn.hidden = false;
  submitBtn.innerHTML = UPDATE_BTN_HTML;

  // ── Helpers ────────────────────────────────────────────────────────────
  /** Set a date or month input value and trigger visual update (clear btn, colour). */
  function setDate(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = val ?? '';
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('input',  { bubbles: true }));
  }
  /** Set a select value and trigger select-colour sync. */
  function setSel(id, val) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value = String(val ?? '0');
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // ── Section A: Patient Registration ───────────────────────────────────
  document.getElementById('artNo').value    = pt.ARTNo ?? '';
  const hivRadio = document.querySelector(`input[name="hivRetest"][value="${pt.HIVRetest ?? 0}"]`);
  if (hivRadio) hivRadio.checked = true;
  document.getElementById('fullName').value = pt.PtName ?? '';
  setDate('artStartDate', pt.ARTStartDate);
  setDate('dateEnrolledInCare', pt.DateEnrolledInCare);

  // Setting DOB fires the change handler which auto-calculates & locks age.
  setDate('dateOfBirth', pt.DateOfBirth);

  if (!pt.DateOfBirth) {
    // No DOB — set age manually and restore field states
    if (ageInput) {
      ageInput.readOnly = false;
      ageInput.classList.remove('field-readonly');
      ageInput.value = pt.Age ?? '';
    }
    const years = pt.Age ?? 0;
    if (ageMonthsInput) {
      if (years > 0) {
        ageMonthsInput.value   = '';
        ageMonthsInput.disabled = true;
        ageMonthsInput.classList.add('field-readonly');
      } else {
        ageMonthsInput.disabled = false;
        ageMonthsInput.readOnly = false;
        ageMonthsInput.classList.remove('field-readonly');
      }
    }
  }

  setSel('sexId', pt.SexID);
  document.getElementById('phone1').value            = pt.Phone1 ?? '';
  document.getElementById('phone2').value            = pt.Phone2 ?? '';
  document.getElementById('residenceAddress').value  = pt.ResidenceAddress ?? '';

  setSel('occupationId', pt.OccupationID);
  document.getElementById('occupationOther-wrap').hidden = String(pt.OccupationID) !== '9';
  document.getElementById('occupationOther').value       = pt.OccupationOther ?? '';

  setSel('keyPopuId', pt.KeyPopuID);
  document.getElementById('keyPopuOther-wrap').hidden = String(pt.KeyPopuID) !== '4';
  document.getElementById('keyPopuOther').value       = pt.KeyPopuOther ?? '';

  const xferVal   = String(pt.IsTransferIn ?? 0);
  const xferRadio = document.querySelector(`input[name="isTransferIn"][value="${xferVal}"]`);
  if (xferRadio) xferRadio.checked = true;
  document.getElementById('transferFacility-wrap').hidden    = pt.IsTransferIn !== 1;
  document.getElementById('transferFromFacility').value      = pt.TransferFromFacility ?? '';

  const ptAge = pt.Age ?? 0;
  document.getElementById('guardian-wrap').hidden    = !(ptAge >= 0 && ptAge < 18);
  document.getElementById('guardianName').value      = pt.GuardianName ?? '';
  document.getElementById('guardianPhone1').value    = pt.GuardianPhone1 ?? '';

  // ── Section B: Clinical Baseline ──────────────────────────────────────
  if (weightInput) { weightInput.value = pt.WeightKg ?? ''; weightInput.dispatchEvent(new Event('input', { bubbles: true })); }
  if (heightInput) { heightInput.value = pt.HeightCm ?? ''; heightInput.dispatchEvent(new Event('input', { bubbles: true })); }
  document.getElementById('muacCm').value     = pt.MUACCm   ?? '';
  setSel('whoStageId', pt.WHOStageID);
  document.getElementById('cd4Value').value   = pt.CD4Value ?? '';
  document.getElementById('cd4IsPercent').checked = pt.CD4IsPercent === 1;
  // CPT/TB dates are stored as YYYY-MM-01; month inputs need YYYY-MM
  setDate('cptStartDate',  pt.CPTStartDate  ? pt.CPTStartDate.substring(0, 7)  : null);
  setSel('cptDrugId', pt.CPTDrugID);
  setDate('tbRxStartDate', pt.TBRxStartDate ? pt.TBRxStartDate.substring(0, 7) : null);
  document.getElementById('unitTBNo').value   = pt.UnitTBNo ?? '';
  setSel('tbStatusId', pt.TBStatusID);

  // ── Section C: PMTCT ───────────────────────────────────────────────────
  pmtctSection.hidden = String(pt.SexID) !== '2';
  setSel('breastfeedingId', pt.BreastfeedingID);
  const pregContainer = document.getElementById('pregnancy-rows');
  pregContainer.innerHTML = '';
  getPMTCT(tid).forEach((preg, i) => {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <div><label>Pregnancy ${i + 1} — ANC No</label>
        <input type="text" class="preg-anc" maxlength="50" /></div>
      <div><label>Delivery Date</label>
        <input type="date" class="preg-del" /></div>
      <div><label class="checkbox-label">
        <input type="checkbox" class="preg-mother"> Mother received ART</label></div>
      <div><label class="checkbox-label">
        <input type="checkbox" class="preg-infant"> Infant received ARVs</label></div>
      <div><button type="button" class="btn btn-danger btn-sm remove-row-btn">Remove</button></div>`;
    row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
    pregContainer.appendChild(row);
    const delInput = row.querySelector('.preg-del');
    setupDateField(delInput);
    row.querySelector('.preg-anc').value       = preg.ANCNo ?? '';
    delInput.value                             = preg.DeliveryDate ?? '';
    delInput.dispatchEvent(new Event('change', { bubbles: true }));
    delInput.dispatchEvent(new Event('input',  { bubbles: true }));
    row.querySelector('.preg-mother').checked  = preg.MotherReceivedART  === 1;
    row.querySelector('.preg-infant').checked  = preg.InfantReceivedARVs === 1;
  });

  // ── Section D: Regimen ────────────────────────────────────────────────
  const regHistory = getRegimenHistory(tid);
  function findReg(line, seq) {
    return regHistory.find(r => r.RegimenLine === line && r.SequenceNo === seq) || null;
  }
  const regimenSlots = [
    { line: 1, seq: 0, drugId: 'reg1Original',  reasonId: null,               otherEl: null,            dateEl: null,            wrapId: null },
    { line: 1, seq: 1, drugId: 'reg1Sub1Drug',   reasonId: 'reg1Sub1Reason',   otherEl: 'reg1Sub1Other', dateEl: 'reg1Sub1Date',  wrapId: 'reg1Sub1OtherWrap' },
    { line: 1, seq: 2, drugId: 'reg1Sub2Drug',   reasonId: 'reg1Sub2Reason',   otherEl: 'reg1Sub2Other', dateEl: 'reg1Sub2Date',  wrapId: 'reg1Sub2OtherWrap' },
    { line: 2, seq: 0, drugId: 'reg2Switch',     reasonId: 'reg2SwitchReason', otherEl: null,            dateEl: 'reg2SwitchDate', wrapId: null },
    { line: 2, seq: 1, drugId: 'reg2Sub1Drug',   reasonId: 'reg2Sub1Reason',   otherEl: 'reg2Sub1Other', dateEl: 'reg2Sub1Date',  wrapId: 'reg2Sub1OtherWrap' },
    { line: 2, seq: 2, drugId: 'reg2Sub2Drug',   reasonId: 'reg2Sub2Reason',   otherEl: 'reg2Sub2Other', dateEl: 'reg2Sub2Date',  wrapId: 'reg2Sub2OtherWrap' },
  ];
  for (const slot of regimenSlots) {
    const rec = findReg(slot.line, slot.seq);
    setSel(slot.drugId, rec?.RegimenID ?? 0);
    if (slot.reasonId) setSel(slot.reasonId, rec?.ChangeReasonID ?? 0);
    if (slot.otherEl) {
      const el = document.getElementById(slot.otherEl);
      if (el) el.value = rec?.OtherReasonText ?? '';
    }
    if (slot.wrapId) {
      const wrap = document.getElementById(slot.wrapId);
      if (wrap) wrap.hidden = String(rec?.ChangeReasonID ?? 0) !== '7';
    }
    if (slot.dateEl) setDate(slot.dateEl, rec?.EventDate ?? null);
  }

  // ── Section E: INH Prophylaxis ─────────────────────────────────────────
  const inhContainer = document.getElementById('inh-rows');
  inhContainer.innerHTML = '';
  getINH(tid).forEach((inh, i) => {
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <div><label>Date ${i + 1}</label>
        <input type="date" /></div>
      <div><button type="button" class="btn btn-danger btn-sm remove-row-btn">Remove</button></div>`;
    row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
    inhContainer.appendChild(row);
    const dateInput = row.querySelector('input[type="date"]');
    setupDateField(dateInput);
    dateInput.value = inh.INHDate ?? '';
    dateInput.dispatchEvent(new Event('change', { bubbles: true }));
    dateInput.dispatchEvent(new Event('input',  { bubbles: true }));
  });

  // ── Open section A and scroll form into view ───────────────────────────
  const sectionA = document.querySelector('.form-section');
  if (sectionA && !sectionA.hasAttribute('open')) sectionA.setAttribute('open', '');
  // Re-sync select / date colours for any values set without dispatching events
  refreshFormColours(document.getElementById('patient-form'));
  if (scrollToForm) document.querySelector('.form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Event: escape edit mode on Cancel ──────────────────────────────────

function _resetFormUI() {
  if (ageInput)       { ageInput.readOnly = false; ageInput.classList.remove('field-readonly'); }
  if (ageMonthsInput) { ageMonthsInput.disabled = false; ageMonthsInput.readOnly = false; ageMonthsInput.classList.remove('field-readonly'); }
  document.getElementById('inh-rows').innerHTML      = '';
  document.getElementById('pregnancy-rows').innerHTML = '';
  pmtctSection.hidden = true;
  document.getElementById('occupationOther-wrap').hidden   = true;
  document.getElementById('keyPopuOther-wrap').hidden      = true;
  document.getElementById('transferFacility-wrap').hidden  = true;
  document.getElementById('guardian-wrap').hidden          = true;
}

// ─── Patient table renderer ──────────────────────────────────────────────

function renderPatients(searchTerm = '') {
  const patients = getAllPtDetails(searchTerm);
  const canWrite = userCanWrite();

  const hasRows = patients.length > 0;
  emptyState.style.display = hasRows ? 'none' : 'block';
  document.querySelector('.table-wrap table').style.display = hasRows ? '' : 'none';
  patientCount.textContent = `${patients.length} record${patients.length !== 1 ? 's' : ''}`;

  // Select-all checkbox starts unchecked — user must explicitly choose records to export
  const artSelectAll = document.getElementById('art-select-all');
  if (artSelectAll) { artSelectAll.checked = false; artSelectAll.indeterminate = false; }

  // Keep dashboard stats in sync with the local DB.
  updateDashboardStats();

  patientsTbody.innerHTML = patients.map((p, i) => `
    <tr data-tid="${escHtml(p.PtDetailsTID)}">
      <td>${i + 1}</td>
      <td title="${escHtml(p.ARTNo)}">${escHtml(p.ARTNo)}</td>
      
      <td title="${escHtml(p.PtName || '')}">${escHtml(truncateDisplayName(p.PtName))}</td>
      <td onclick="event.stopPropagation()" style="text-align:center"><input type="checkbox" class="row-check" value="${escHtml(p.PtDetailsTID)}" aria-label="Select ${escHtml(p.PtName || '')}"></td>
      <td>${p.Age}</td>
      <td>${p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : escHtml(p.Sex ?? '')}</td>
      <td>${p.ARTStartDate ? fmtDate(p.ARTStartDate) : ''}</td>
      <td>${p.HealthFacility}</td>
      <td>
        <button class="btn btn-secondary btn-sm visits-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          data-name="${escHtml(p.PtName)}"
          data-artstart="${escHtml(p.ARTStartDate ?? '')}"
          data-readonly="${canWrite ? '' : 'true'}">
          ${canWrite ? 'Enter Follow-Up Visits' : 'View Follow-Up Visits'}
        </button>
      </td>
      <td>${p.HasChanged ? '<span class="badge bg-warning text-dark">Pending</span>' : '<span class="badge bg-success">Synced</span>'}</td>
      <td>${canWrite ? `
        <button class="btn btn-secondary btn-sm edit-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          aria-label="Edit ${escHtml(p.PtName)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          <span class="d-none d-sm-inline">Edit</span>
        </button>
        <button class="btn btn-danger btn-sm delete-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          aria-label="Delete ${escHtml(p.PtName)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
          <span class="d-none d-sm-inline">Delete</span>
        </button>` : `
        <button class="btn btn-secondary btn-sm view-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          aria-label="View ${escHtml(p.PtName)}">
          View
        </button>`}
      </td>
    </tr>
  `).join('');

  // Show / refresh the deleted-records section for write users
  if (canWrite) renderDeletedPatients();
}

// ═══════════════════════════════════════════════════════════════════════════
// ─── TB Register ─────────────────────────────────────────────────────────
// ═══════════════════════════════════════════════════════════════════════════

const TB_API_URL = 'https://api.etbr.org/api/tb-patients/sync-full';

/**
 * Wire up TB-register-specific interactivity:
 *  - DOB → auto-calc age years + age months (locked read-only)
 *  - Patient Type → show/hide Transfer-In fields
 *  - Outcome → show/hide Transfer-Out fields
 *  - HIV result → freeze/unfreeze ART + CPT fields when Negative
 */
function setupTBFormWiring() {
  const tbDobInput       = document.getElementById('tb-dob');
  const tbAgeInput       = document.getElementById('tb-age');
  const tbAgeMonthsInput = document.getElementById('tb-ageMonths');
  const tbAgeMonthsWrap  = document.getElementById('tb-ageMonths-wrap');

  // ── Age / DOB ─────────────────────────────────────────────────────────
  function tbLockAgeYears() {
    if (!tbAgeInput) return;
    tbAgeInput.readOnly = true;
    tbAgeInput.classList.add('field-readonly');
  }
  function tbUnlockAgeYears() {
    if (!tbAgeInput) return;
    tbAgeInput.readOnly = false;
    tbAgeInput.classList.remove('field-readonly');
  }
  function tbDisableAgeMonths() {
    if (!tbAgeMonthsInput) return;
    tbAgeMonthsInput.value    = '';
    tbAgeMonthsInput.disabled = true;
    tbAgeMonthsInput.classList.add('field-readonly');
  }
  function tbLockAgeMonthsWithValue(val) {
    if (!tbAgeMonthsInput) return;
    tbAgeMonthsInput.value    = val;
    tbAgeMonthsInput.disabled = false;
    tbAgeMonthsInput.readOnly = true;
    tbAgeMonthsInput.classList.add('field-readonly');
  }
  function tbUnlockAgeMonths() {
    if (!tbAgeMonthsInput) return;
    tbAgeMonthsInput.disabled = false;
    tbAgeMonthsInput.readOnly = false;
    tbAgeMonthsInput.classList.remove('field-readonly');
  }
  function tbSyncAgeMonthsToYears() {
    const years = parseInt(tbAgeInput?.value, 10);
    if (!isNaN(years) && years >= 1) {
      tbDisableAgeMonths();
    } else {
      tbUnlockAgeMonths();
    }
  }

  tbDobInput?.addEventListener('change', () => {
    if (!tbDobInput.value) {
      tbUnlockAgeYears();
      tbSyncAgeMonthsToYears();
      return;
    }
    tbLockAgeYears();
    const today      = new Date();
    const dob        = new Date(tbDobInput.value);
    const totalMonths =
      (today.getFullYear() - dob.getFullYear()) * 12 +
      (today.getMonth()    - dob.getMonth()) +
      (today.getDate() >= dob.getDate() ? 0 : -1);
    if (tbAgeInput) tbAgeInput.value = Math.min(Math.floor(totalMonths / 12), 99);
    if (totalMonths >= 0 && totalMonths < 12) {
      tbLockAgeMonthsWithValue(totalMonths);
    } else {
      tbDisableAgeMonths();
    }
  });

  tbAgeInput?.addEventListener('input', () => {
    if (!tbDobInput?.value) tbSyncAgeMonthsToYears();
  });

  tbAgeMonthsInput?.addEventListener('input', () => {
    const months = parseInt(tbAgeMonthsInput.value, 10);
    if (!isNaN(months) && tbAgeInput) {
      tbAgeInput.value = Math.min(Math.floor(months / 12), 99);
    }
  });

  // ── Patient Type → Transfer-In fields ────────────────────────────────
  const tbPtTypeID = document.getElementById('tb-ptTypeID');
  const tbTiWrap   = document.getElementById('tb-ti-wrap');
  function tbUpdateTransferInVisibility() {
    const isTransferIn = tbPtTypeID?.value === '5'; // 5 = Transfer In
    if (tbTiWrap) tbTiWrap.hidden = !isTransferIn;
    if (!isTransferIn) {
      const ti1 = document.getElementById('tb-tihf');
      const ti2 = document.getElementById('tb-tiCounty');
      if (ti1) ti1.value = '';
      if (ti2) ti2.value = '';
    }
  }
  tbPtTypeID?.addEventListener('change', tbUpdateTransferInVisibility);
  tbUpdateTransferInVisibility();

  // ── Outcome → Transfer-Out fields ────────────────────────────────────
  const tbOutcomeID = document.getElementById('tb-outcomeID');
  const tbToWrap    = document.getElementById('tb-to-wrap');
  function tbUpdateTransferOutVisibility() {
    const isNotEvaluated = tbOutcomeID?.value === '6'; // 6 = Not Evaluated
    if (tbToWrap) tbToWrap.hidden = !isNotEvaluated;
    if (!isNotEvaluated) {
      const to1 = document.getElementById('tb-tohf');
      const to2 = document.getElementById('tb-toCounty');
      if (to1) to1.value = '';
      if (to2) to2.value = '';
    }
  }
  tbOutcomeID?.addEventListener('change', tbUpdateTransferOutVisibility);
  tbUpdateTransferOutVisibility();

  // ── HIV result → freeze/unfreeze ART + CPT ───────────────────────────
  const tbHivResultSel = document.getElementById('tb-hivTestResultID');
  const tbArtcptWrap   = document.getElementById('tb-artcpt-wrap');
  const tbArtcptWrapRev = document.getElementById('tb-artcpt-wrap-rev');
  function tbUpdateHIVFreeze() {
    const isNegative = tbHivResultSel?.value === '1'; // 1 = Negative
    const artcptInputs = tbArtcptWrap?.querySelectorAll('input') ?? [];
    artcptInputs.forEach(el => {
      el.disabled = isNegative;
      if (isNegative) {
        // Reset to defaults when frozen
        if (el.type === 'radio' && el.value === '0') el.checked = true;
        if (el.type === 'radio' && el.value === '1') el.checked = false;
        if (el.type === 'date') el.value = '';
      }
    });

    const artcptInputsRev = tbArtcptWrapRev?.querySelectorAll('input') ?? [];
    artcptInputsRev.forEach(el => {
      el.disabled = isNegative;
      if (isNegative) {
        // Reset to defaults when frozen
        if (el.type === 'radio' && el.value === '0') el.checked = true;
        if (el.type === 'radio' && el.value === '1') el.checked = false;
        if (el.type === 'date') el.value = '';
      }
    });

    if (tbArtcptWrap) tbArtcptWrap.classList.toggle('field-frozen', isNegative);
    if (tbArtcptWrapRev) tbArtcptWrapRev.classList.toggle('field-frozen', isNegative);
  }
  tbHivResultSel?.addEventListener('change', tbUpdateHIVFreeze);
  tbUpdateHIVFreeze();


    // ── Smear result → freeze/unfreeze Month 0 date + lab number ───────
  const tbMon0ResultSel = document.getElementById('tb-mon0LabResultID');
  const tbMon0DateField = document.getElementById('tb-mon0Date');
  const tbMon0DateWrap  = document.getElementById('tb-mon0Date-wrap');
  const tbMon0LabNoField = document.getElementById('tb-mon0LabNo');
  const tbMon0LabNoWrap  = document.getElementById('tb-mon0LabNo-wrap');

  function tbUpdateSmearDateFreeze() {
    const selectedText = (tbMon0ResultSel?.selectedOptions?.[0]?.textContent || '').trim().toLowerCase();
    const isNoSmearDone = tbMon0ResultSel?.value === '7' || selectedText.includes('no smear done');

    if (tbMon0DateField) {
      tbMon0DateField.disabled = isNoSmearDone;
      if (isNoSmearDone) tbMon0DateField.value = '';
    }
    if (tbMon0LabNoField) {
      tbMon0LabNoField.disabled = isNoSmearDone;
      if (isNoSmearDone) tbMon0LabNoField.value = '';
    }

    if (tbMon0DateWrap) tbMon0DateWrap.classList.toggle('field-frozen', isNoSmearDone);
    if (tbMon0LabNoWrap) tbMon0LabNoWrap.classList.toggle('field-frozen', isNoSmearDone);
  }

  tbMon0ResultSel?.addEventListener('change', tbUpdateSmearDateFreeze);
  tbUpdateSmearDateFreeze();

  // ── Xpert result → freeze/unfreeze Xpert date ───────────────────────
  const tbXpertResultSel = document.getElementById('tb-xpertResultID');
  const tbXpertDateField = document.getElementById('tb-xpertResultDate');
  const tbXpertDateWrap  = document.getElementById('tb-xpertResultDate-wrap');

  function tbUpdateXpertDateFreeze() {
    const selectedText = (tbXpertResultSel?.selectedOptions?.[0]?.textContent || '').trim().toLowerCase();
    const isNotDone = tbXpertResultSel?.value === '1' || selectedText.includes('not done');

    if (tbXpertDateField) {
      tbXpertDateField.disabled = isNotDone;
      if (isNotDone) tbXpertDateField.value = '';
    }

    if (tbXpertDateWrap) tbXpertDateWrap.classList.toggle('field-frozen', isNotDone);
  }

  tbXpertResultSel?.addEventListener('change', tbUpdateXpertDateFreeze);
  tbUpdateXpertDateFreeze();


    // ── Follow-up smear results → freeze/unfreeze date + lab number ─────
  const followUpSmearConfigs = [
    { resultId: 'tb-mon2LabResultID', dateId: 'tb-mon2Date', dateWrapId: 'tb-mon2Date-wrap', labId: 'tb-mon2LabNo', labWrapId: 'tb-mon2LabNo-wrap' },
    { resultId: 'tb-mon3LabResultID', dateId: 'tb-mon3Date', dateWrapId: 'tb-mon3Date-wrap', labId: 'tb-mon3LabNo', labWrapId: 'tb-mon3LabNo-wrap' },
    { resultId: 'tb-mon5LabResultID', dateId: 'tb-mon5Date', dateWrapId: 'tb-mon5Date-wrap', labId: 'tb-mon5LabNo', labWrapId: 'tb-mon5LabNo-wrap' },
    { resultId: 'tb-mon6LabResultID', dateId: 'tb-mon6Date', dateWrapId: 'tb-mon6Date-wrap', labId: 'tb-mon6LabNo', labWrapId: 'tb-mon6LabNo-wrap' }
  ];

  function tbUpdateFollowUpSmearFreeze(config) {
    const resultSel = document.getElementById(config.resultId);
    const dateField = document.getElementById(config.dateId);
    const dateWrap = document.getElementById(config.dateWrapId);
    const labField = document.getElementById(config.labId);
    const labWrap = document.getElementById(config.labWrapId);
    const selectedText = (resultSel?.selectedOptions?.[0]?.textContent || '').trim().toLowerCase();
    const isNotDone = resultSel?.value === '7' || selectedText.includes('no smear done') || selectedText.includes('not done');

    if (dateField) {
      dateField.disabled = isNotDone;
      if (isNotDone) dateField.value = '';
    }
    if (labField) {
      labField.disabled = isNotDone;
      if (isNotDone) labField.value = '';
    }
    if (dateWrap) dateWrap.classList.toggle('field-frozen', isNotDone);
    if (labWrap) labWrap.classList.toggle('field-frozen', isNotDone);
  }

  followUpSmearConfigs.forEach(config => {
    const resultSel = document.getElementById(config.resultId);
    resultSel?.addEventListener('change', () => tbUpdateFollowUpSmearFreeze(config));
    tbUpdateFollowUpSmearFreeze(config);
  });
}


/** Currently-editing TB record GUID, or null when creating new. */
let _tbEditingTID = null;
/** True when the TB form is open in read-only (view) mode. */
let _tbViewOnly = false;

/** Populate the TB patient list table. */
function renderTBPatients(searchTerm = '') {
  const tbody      = document.getElementById('tb-patient-tbody');
  const tbCountEl  = document.getElementById('tb-patient-count');
  if (!tbody) return;
  if (!_selectedFacility) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted text-center py-3">Select a facility first.</td></tr>';
    if (tbCountEl) tbCountEl.textContent = '0 records';
    return;
  }

  const rows = getAllPtDetailsTB(searchTerm);
  const canWrite = userCanWrite();

  if (tbCountEl) tbCountEl.textContent = `${rows.length} record${rows.length !== 1 ? 's' : ''}`;
  updateDashboardStats();
  // Keep monitoring counts and facility tree in sync whenever TB patient data changes
  if (tbMonitoringScreen && !tbMonitoringScreen.hidden) _monBuildTree();
  // Keep data quality screen in sync too
  if (tbQualityScreen && !tbQualityScreen.hidden) _dqBuildTree();

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="9" class="text-muted text-center py-3">No TB patients found.</td></tr>';
    if (canWrite) renderDeletedTBPatients();
    return;
  }

  // Select-all checkbox starts unchecked — user must explicitly choose records to export
  const tbSelectAll = document.getElementById('tb-select-all');
  if (tbSelectAll) { tbSelectAll.checked = false; tbSelectAll.indeterminate = false; }

  tbody.innerHTML = rows.map(p => {
    const syncBadge = p.HasChanged
      ? '<span class="badge bg-warning text-dark">Pending</span>'
      : '<span class="badge bg-success">Synced</span>';
    const actions = canWrite ? `
      <button class="btn btn-secondary btn-sm tb-edit-btn" data-tid="${escHtml(p.PtDetailsTID)}" aria-label="Edit ${escHtml(p.PtName || '')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>
        <span class="d-none d-sm-inline">Edit</span>
      </button>
      <button class="btn btn-danger btn-sm tb-delete-btn" data-tid="${escHtml(p.PtDetailsTID)}" data-name="${escHtml(p.PtName || '')}" aria-label="Delete ${escHtml(p.PtName || '')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/></svg>
        <span class="d-none d-sm-inline">Delete</span>
      </button>
    ` : `
      <button class="btn btn-secondary btn-sm tb-view-btn" data-tid="${escHtml(p.PtDetailsTID)}" aria-label="View ${escHtml(p.PtName || '')}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        <span class="d-none d-sm-inline">View</span>
      </button>
    `;
    const ptName = truncateDisplayName(p.PtName);
    return `<tr data-tid="${escHtml(p.PtDetailsTID)}">
      <td>${p.RegDate ? fmtDate(p.RegDate.slice(0, 10)) : ''}</td>
      <td>${escHtml(p.UnitTBNo || '')}</td>      
      <td>${escHtml(ptName)}</td>
      <td onclick="event.stopPropagation()" style="text-align:center"><input type="checkbox" class="row-check" value="${escHtml(p.PtDetailsTID)}" aria-label="Select ${escHtml(p.PtName || '')}"></td>
      <td>${p.Age ?? ''}</td>
      <td>${p.SexID === 1 ? 'M' : p.SexID === 2 ? 'F' : escHtml(p.Sex || '')}</td>
      <td>${escHtml(p.TbType || '')}</td>
      <td>${escHtml(p.PtTypeShort || p.PtType || '')}</td>
      <td>${p.HealthFacility ?? ''}</td>
      <td>${syncBadge}</td>
      <td>${actions}</td>
    </tr>`;
  }).join('');

  // Edit/delete/view delegation
  tbody.querySelectorAll('.tb-edit-btn').forEach(btn => btn.addEventListener('click', () => startEditTBPatient(btn.dataset.tid)));
  tbody.querySelectorAll('.tb-delete-btn').forEach(btn => btn.addEventListener('click', () => deleteTBPatient(btn.dataset.tid, btn.dataset.name)));
  tbody.querySelectorAll('.tb-view-btn').forEach(btn => btn.addEventListener('click', () => startViewTBPatient(btn.dataset.tid)));

  if (canWrite) renderDeletedTBPatients();
}

/**
 * Renders (or refreshes) the "Deleted Records" section below the TB patient table.
 * Only visible when there are deleted records and the user has write access.
 */
function renderDeletedTBPatients() {
  const deleted = getAllDeletedPtDetailsTB();

  let section = document.getElementById('tb-deleted-patients-section');
  if (!section) {
    const tableWrap = document.querySelector('#tb-register-content .table-wrap');
    if (!tableWrap) return;
    section = document.createElement('div');
    section.id = 'tb-deleted-patients-section';
    section.style.marginTop = '1.5rem';
    tableWrap.parentNode.insertBefore(section, tableWrap.nextSibling);

    section.addEventListener('click', async (e) => {
      const btn = e.target.closest('.tb-undelete-btn');
      if (!btn) return;
      const tid  = btn.dataset.tid;
      const name = btn.dataset.name;
      try {
        await undeletePtDetailsTB(tid);
        { const _u = getUser(); await insertAuditLog({ action: 'UNDELETE_TB', ptDetailsTID: tid, notes: `Restored TB patient: ${name}`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }
        renderTBPatients(document.getElementById('tb-search')?.value || '');
        showToast(`"${name}" has been restored.`, 'success');
        logSync('INFO', 'Auto-sync: tb-undelete', { online: navigator.onLine, hasToken: !!getToken(), syncInProgress: _syncInProgress });
        if (navigator.onLine) triggerTBSync(true, false, 'tb-undelete');
      } catch (err) {
        console.error('[TB] Undelete failed:', err);
        showToast('Could not restore TB patient.', 'error');
      }
    });
  }

  if (!deleted.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  section.innerHTML = `
    <details>
      <summary style="cursor:pointer;font-weight:600;padding:0.5rem 0;user-select:none;">
        Deleted Records (${deleted.length}) — click to expand
      </summary>
      <div class="table-wrap table-wrap--tb-scroll" style="margin-top:0.75rem;">
        <table aria-label="Deleted TB patient records">
          <thead>
            <tr>
              <th>#</th>
              <th>Reg. Date</th>
              <th>TB No</th>
              <th>Patient Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Facility</th>
              <th>TB Site</th>
              <th>Type</th>
              <th>Deleted On</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${deleted.map((p, i) => {
            const ptName = truncateDisplayName(p.PtName);
            return `
              <tr>
                <td>${i + 1}</td>
                <td>${p.RegDate ? fmtDate(p.RegDate.slice(0, 10)) : ''}</td>
                <td>${escHtml(p.UnitTBNo || '')}</td>
                <td>${escHtml(ptName)}</td>
                <td>${p.Age ?? ''}</td>
                <td>${p.SexID === 1 ? 'M' : p.SexID === 2 ? 'F' : ''}</td>
                <td>${escHtml(p.TbType || '')}</td>
                <td>${escHtml(p.PtTypeShort || p.PtType || '')}</td>
                <td>${p.HealthFacility ?? ''}</td>
                <td>${p.LastModOn ? fmtDate(p.LastModOn.substring(0, 10)) : ''}</td>
                <td>
                  <button class="btn btn-secondary btn-sm tb-undelete-btn"
                    data-tid="${escHtml(p.PtDetailsTID)}"
                    data-name="${escHtml(p.PtName || '')}">
                    Restore
                  </button>
                </td>
              </tr>`;
          }).join('')}
          </tbody>
        </table>
      </div>
    </details>`;
}

/** Read the TB form fields into a plain object. */
function _readTBForm() {
  const v = id => document.getElementById(id)?.value?.trim() || null;
  const d = id => document.getElementById(id)?.value || null;
  const sel = id => { const el = document.getElementById(id); return el ? Number(el.value) || 0 : 0; };
  const radio = name => { const el = document.querySelector(`input[name="${name}"]:checked`); return el ? Number(el.value) : 0; };
  return {
    NearestHFID:     _selectedFacility?.id || 0,
    RegDate:         d('tb-regDate'),
    UnitTBNo:        v('tb-unitTBNo'),
    PtName:          v('tb-ptName'),
    DateOfBirth:     d('tb-dob'),
    Age:             Number(document.getElementById('tb-age')?.value) || null,
    AgeMonths:       (() => { const el = document.getElementById('tb-ageMonths'); return (el && !el.disabled && el.value !== '') ? Number(el.value) : null; })(),
    SexID:           sel('tb-sexID'),
    ReferredByID:    sel('tb-referredByID'),
    Village:         v('tb-village'),
    Boma:            v('tb-boma'),
    Payam:           v('tb-payam'),
    County:          v('tb-county'),
    PtPhone:         v('tb-ptPhone'),
    TbTypeID:        sel('tb-tbTypeID'),
    PtTypeID:        sel('tb-ptTypeID'),
    DiagMethodID:    sel('tb-diagMethodID'),
    DateRxStarted:   d('tb-dateRxStarted'),
    RegimenID:       sel('tb-regimenID'),
    TIHF:            v('tb-tihf'),
    TICounty:        v('tb-tiCounty'),
    // Follow-up fields
    Mon0Date:        d('tb-mon0Date'),
    Mon0LabNo:       v('tb-mon0LabNo'),
    Mon0LabResultID: sel('tb-mon0LabResultID'),
    Mon0XpertResultDate: d('tb-xpertResultDate'),
    Mon0XpertResultID:   sel('tb-xpertResultID'),
    DSTResult:       v('tb-dstResult'),
    Mon2Date:        d('tb-mon2Date'),
    Mon2LabNo:       v('tb-mon2LabNo'),
    Mon2LabResultID: sel('tb-mon2LabResultID'),
    Mon3Date:        d('tb-mon3Date'),
    Mon3LabNo:       v('tb-mon3LabNo'),
    Mon3LabResultID: sel('tb-mon3LabResultID'),
    Mon5Date:        d('tb-mon5Date'),
    Mon5LabNo:       v('tb-mon5LabNo'),
    Mon5LabResultID: sel('tb-mon5LabResultID'),
    Mon6Date:        d('tb-mon6Date'),
    Mon6LabNo:       v('tb-mon6LabNo'),
    Mon6LabResultID: sel('tb-mon6LabResultID'),
    HIVTestDate:     d('tb-hivTestDate'),
    HIVTestResultID: sel('tb-hivTestResultID'),
    OnART:           radio('tb-onART'),
    ARTDate:         d('tb-artDate'),
    OnCPT:           radio('tb-onCPT'),
    CPTDate:         d('tb-cptDate'),
    OutcomeID:       sel('tb-outcomeID'),
    OutcomeDate:     d('tb-outcomeDate'),
    MovedTo2ndLine:  radio('tb-movedTo2ndLine'),
    TOHF:            v('tb-tohf'),
    TOCounty:        v('tb-toCounty'),
    Remarks:         v('tb-remarks'),
  };
}

/** Validate the TB form; return array of error messages (empty = valid). */
function _validateTBForm(data) {
  const errs = [];
  if (!data.RegDate)  errs.push({ id: 'tb-regDate-error',    msg: 'Registration Date is required.' });
  if (!data.UnitTBNo) errs.push({ id: 'tb-unitTBNo-error',   msg: 'Unit TB No. is required.' });
  if (!data.PtName)   errs.push({ id: 'tb-ptName-error',     msg: 'Patient Name is required.' });
  // Age: at least one of DOB, age years, or age months must be filled
  const tbAgeEl       = document.getElementById('tb-age');
  const tbAgeMonthsEl = document.getElementById('tb-ageMonths');
  const hasAge = data.DateOfBirth ||
                 (tbAgeEl && tbAgeEl.value !== '') ||
                 (tbAgeMonthsEl && !tbAgeMonthsEl.disabled && tbAgeMonthsEl.value !== '');
  if (!hasAge) errs.push({ id: 'tb-age-error', msg: 'Age or Date of Birth is required.' });
  if (data.SexID === 0 || data.SexID == null)
    errs.push({ id: 'tb-sexID-error', msg: 'Please select sex.' });
  if (data.TbTypeID === 0 || data.TbTypeID == null)
    errs.push({ id: 'tb-tbTypeID-error', msg: 'TB Type is required.' });
  if (data.PtTypeID === 0 || data.PtTypeID == null)
    errs.push({ id: 'tb-ptTypeID-error', msg: 'Patient Type is required.' });
  if (data.DiagMethodID === 0 || data.DiagMethodID == null)
    errs.push({ id: 'tb-diagMethodID-error', msg: 'Diagnosis Method is required.' });
  if (data.PtPhone && !/^0\d{9}$/.test(data.PtPhone))
    errs.push({ id: 'tb-ptPhone-error', msg: 'Phone must be 10 digits starting with 0.' });
  if (data.HIVTestDate && (!data.HIVTestResultID || data.HIVTestResultID === 0))
    errs.push({ id: 'tb-hivTestResultID-error', msg: 'HIV Test Result is required when Date of HIV Test is entered.' });
  return errs;
}

/** Clear all TB form validation error spans. */
function _clearTBErrors() {
  document.querySelectorAll('#tb-patient-form .field-error').forEach(el => {
    el.textContent = '';
    el.hidden = true;
  });
  document.querySelectorAll('#tb-patient-form input.invalid, #tb-patient-form select.invalid').forEach(el => {
    el.classList.remove('invalid');
  });
}

/** Reset the TB form back to "new patient" state. */
function _resetTBForm() {
  if (_tbViewOnly) {
    _tbViewOnly = false;
    document.getElementById('tb-patient-form')?.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = false; });
    const closeBtnV = document.getElementById('tb-cancel-edit-btn');
    if (closeBtnV) closeBtnV.textContent = 'Cancel';
  }
  document.getElementById('tb-patient-form')?.reset();
  _clearTBErrors();
  _tbEditingTID = null;
  const banner = document.getElementById('tb-edit-mode-banner');
  if (banner) banner.hidden = true;
  const noAccessBanner = document.getElementById('tb-no-access-banner');
  if (noAccessBanner) noAccessBanner.hidden = true;
  const cancelBtn = document.getElementById('tb-cancel-edit-btn');
  if (cancelBtn) cancelBtn.hidden = true;
  const titleEl = document.getElementById('tb-form-title');
  if (titleEl) titleEl.textContent = 'New Patient \u2014 Unit TB Register';
  const saveBtn = document.getElementById('tb-save-btn');
  if (saveBtn) { saveBtn.textContent = 'Save Patient'; saveBtn.hidden = false; }
  // Reset ageMonths to default state (always visible, matching ART register)
  const tbAgeMonthsInput = document.getElementById('tb-ageMonths');
  if (tbAgeMonthsInput) {
    tbAgeMonthsInput.value    = '';
    tbAgeMonthsInput.disabled = false;
    tbAgeMonthsInput.readOnly = false;
    tbAgeMonthsInput.classList.remove('field-readonly');
  }
  // Re-apply wiring defaults (transfer-in/out, HIV freeze)
  document.getElementById('tb-ptTypeID')?.dispatchEvent(new Event('change'));
  document.getElementById('tb-outcomeID')?.dispatchEvent(new Event('change'));
  document.getElementById('tb-hivTestResultID')?.dispatchEvent(new Event('change'));
}

// DQ quality-check category that opened the form ('' = none).
// Monitoring category that opened the form ('' = none).
let _pendingDQCategory  = '';
let _pendingMonCategory = '';

/**
 * Expands any ancestor <details> elements so the target element is visible,
 * then scrolls to it and moves keyboard focus into it.
 */
function _openAndFocus(el) {
  if (!el) return;
  let node = el.parentElement;
  while (node && node !== document.body) {
    if (node.tagName === 'DETAILS') node.open = true;
    node = node.parentElement;
  }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  setTimeout(() => { try { el.focus(); } catch (_) {} }, 350);
}

/**
 * After opening a patient form from the DQ quality screen, highlights the
 * field(s) that caused the data-quality flag and scrolls/focuses to them.
 * Handles every DQ category so the behaviour is consistent across the board.
 */
function _applyDQFieldFocus() {
  if (!_pendingDQCategory) return;
  const cat = _pendingDQCategory;
  _pendingDQCategory = '';

  /** Mark a field invalid and show its error span if the value is blank/zero. */
  const mark = (id, msg) => {
    const el  = document.getElementById(id);
    const err = document.getElementById(`${id}-error`);
    if (!el) return false;
    const val = el.value ?? '';
    const empty = val === '' || val === '0';
    if (empty) {
      el.classList.add('invalid');
      if (err) { err.textContent = msg; err.hidden = false; }
    }
    return empty;
  };

  /** Flag a field invalid unconditionally (value present but incorrect). */
  const flag = (id, msg) => {
    const el  = document.getElementById(id);
    const err = document.getElementById(`${id}-error`);
    if (el)  el.classList.add('invalid');
    if (err) { err.textContent = msg; err.hidden = false; }
    return el;
  };

  if (cat === 'missingreg') {
    // Mark ALL blank required fields, then focus the first one.
    mark('tb-ptName',        'Patient name is required.');
    mark('tb-age',           'Age is required.');
    mark('tb-sexID',         'Please select sex.');
    mark('tb-tbTypeID',      'Please select TB site.');
    mark('tb-ptTypeID',      'Please select patient type.');
    mark('tb-regDate',       'Registration date is required.');
    mark('tb-dateRxStarted', 'Date treatment started is required.');
    mark('tb-diagMethodID',  'Please select diagnostic method.');
    _openAndFocus(document.querySelector('#tb-patient-form .invalid'));

  } else if (cat === 'diagmethod') {
    mark('tb-diagMethodID', 'Please select diagnostic method.');
    _openAndFocus(document.getElementById('tb-diagMethodID'));

  } else if (cat === 'norxstart') {
    mark('tb-dateRxStarted', 'Date treatment started is required.');
    _openAndFocus(document.getElementById('tb-dateRxStarted'));

  } else if (cat === 'futuredates') {
    flag('tb-regDate', 'Registration date is in the future — please correct.');
    _openAndFocus(document.getElementById('tb-regDate'));

  } else if (cat === 'smearcured') {
    flag('tb-outcomeID', 'Outcome is "Cured" but no positive smear was recorded at baseline — please verify.');
    _openAndFocus(document.getElementById('tb-outcomeID'));

  } else if (cat === 'nooutcome') {
    mark('tb-outcomeID', 'Please record a treatment outcome.');
    _openAndFocus(document.getElementById('tb-outcomeID'));

  } else if (cat === 'notevaluated') {
    mark('tb-outcomeID', 'Outcome is "Not Evaluated" — please update to the correct DOTS outcome.');
    _openAndFocus(document.getElementById('tb-outcomeID'));

  } else if (cat === 'duplicates') {
    // Name is the suspected duplicate — focus it so the user can review.
    _openAndFocus(document.getElementById('tb-ptName'));

  } else if (cat === 'skipped') {
    // Gap rows have no patient record — this branch is unreachable from the DQ table.

  } else if (cat === 'sametbno') {
    flag('tb-unitTBNo', 'This TB number is already used by another patient.');
    _openAndFocus(document.getElementById('tb-unitTBNo'));
  }
  // 'deleted' — no field focus needed; the deleted/restore UI handles it.
}

/**
 * After opening a patient form from the Monitoring screen, scrolls and
 * focuses the sputum result field for the active monitoring category, or
 * the treatment outcome field for the 'outcome' category.
 */
function _applyMonFieldFocus() {
  if (!_pendingMonCategory) return;
  const cat = _pendingMonCategory;
  _pendingMonCategory = '';

  const sputumMap = {
    '2month': 'tb-mon2LabResultID',
    '3month': 'tb-mon3LabResultID',
    '5month': 'tb-mon5LabResultID',
    '6month': 'tb-mon6LabResultID',
    '8month': 'tb-mon8LabResultID',
  };
  const fieldId = sputumMap[cat] ?? (cat === 'outcome' ? 'tb-outcomeID' : null);
  if (fieldId) _openAndFocus(document.getElementById(fieldId));
}

/** Populate the TB form with an existing record for editing. */
function startEditTBPatient(ptDetailsTID) {
  const rec = getPtDetailsTB(ptDetailsTID);
  const fu  = getPtFollowUpTB(ptDetailsTID);
  if (!rec) { showToast('Record not found.', 'error'); return; }

  _tbEditingTID = ptDetailsTID;

  const s = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
  s('tb-unitTBNo',   rec.UnitTBNo);
  s('tb-regDate',    rec.RegDate ? rec.RegDate.slice(0, 10) : '');
  s('tb-ptName',     rec.PtName);
  s('tb-dob',        rec.DateOfBirth ? rec.DateOfBirth.slice(0, 10) : '');
  s('tb-age',        rec.Age ?? '');
  // AgeMonths: show if age < 1 year and ageMonths value exists
  const tbAgeMonthsInput = document.getElementById('tb-ageMonths');
  const tbAgeMonthsWrap  = document.getElementById('tb-ageMonths-wrap');
  if (tbAgeMonthsInput) {
    const ageYrs = rec.Age ?? 0;
    if (ageYrs < 1 && rec.AgeMonths != null) {
      tbAgeMonthsInput.value    = rec.AgeMonths;
      tbAgeMonthsInput.disabled = !!rec.DateOfBirth;
      tbAgeMonthsInput.readOnly = !!rec.DateOfBirth;
      tbAgeMonthsInput.classList.toggle('field-readonly', !!rec.DateOfBirth);
    } else {
      tbAgeMonthsInput.value    = '';
      tbAgeMonthsInput.disabled = ageYrs >= 1;
      tbAgeMonthsInput.readOnly = false;
      tbAgeMonthsInput.classList.toggle('field-readonly', ageYrs >= 1);
    }
  }
  s('tb-sexID',      rec.SexID);
  s('tb-referredByID', rec.ReferredByID);
  s('tb-village',    rec.Village);
  s('tb-boma',       rec.Boma);
  s('tb-payam',      rec.Payam);
  s('tb-county',     rec.County);
  s('tb-ptPhone',    rec.PtPhone);
  s('tb-tbTypeID',   rec.TbTypeID);
  s('tb-ptTypeID',   rec.PtTypeID);
  s('tb-diagMethodID', rec.DiagMethodID);
  s('tb-dateRxStarted', rec.DateRxStarted ? rec.DateRxStarted.slice(0, 10) : '');
  s('tb-regimenID',  rec.RegimenID);
  s('tb-tihf',       rec.TIHF);
  s('tb-tiCounty',   rec.TICounty);

  if (fu) {
    s('tb-mon0Date',        fu.Mon0Date   ? fu.Mon0Date.slice(0, 10)   : '');
    s('tb-mon0LabNo',       fu.Mon0LabNo);
    s('tb-mon0LabResultID', fu.Mon0LabResultID);
    s('tb-xpertResultDate', fu.Mon0XpertResultDate ? fu.Mon0XpertResultDate.slice(0, 10) : '');
    s('tb-xpertResultID',   fu.Mon0XpertResultID);
    s('tb-dstResult',       fu.DSTResult);
    s('tb-mon2Date',        fu.Mon2Date   ? fu.Mon2Date.slice(0, 10)   : '');
    s('tb-mon2LabNo',       fu.Mon2LabNo);
    s('tb-mon2LabResultID', fu.Mon2LabResultID);
    s('tb-mon3Date',        fu.Mon3Date   ? fu.Mon3Date.slice(0, 10)   : '');
    s('tb-mon3LabNo',       fu.Mon3LabNo);
    s('tb-mon3LabResultID', fu.Mon3LabResultID);
    s('tb-mon5Date',        fu.Mon5Date   ? fu.Mon5Date.slice(0, 10)   : '');
    s('tb-mon5LabNo',       fu.Mon5LabNo);
    s('tb-mon5LabResultID', fu.Mon5LabResultID);
    s('tb-mon6Date',        fu.Mon6Date   ? fu.Mon6Date.slice(0, 10)   : '');
    s('tb-mon6LabNo',       fu.Mon6LabNo);
    s('tb-mon6LabResultID', fu.Mon6LabResultID);
    s('tb-hivTestDate',     fu.HIVTestDate ? fu.HIVTestDate.slice(0, 10) : '');
    s('tb-hivTestResultID', fu.HIVTestResultID);
    // Radio buttons
    const setRadio = (name, val) => {
      const el = document.querySelector(`input[name="${name}"][value="${val ?? 0}"]`);
      if (el) el.checked = true;
    };
    setRadio('tb-onART', fu.OnART);
    s('tb-artDate',  fu.ARTDate  ? fu.ARTDate.slice(0, 10)  : '');
    setRadio('tb-onCPT', fu.OnCPT);
    s('tb-cptDate',  fu.CPTDate  ? fu.CPTDate.slice(0, 10)  : '');
    s('tb-outcomeID',   fu.OutcomeID);
    s('tb-outcomeDate', fu.OutcomeDate ? fu.OutcomeDate.slice(0, 10) : '');
    setRadio('tb-movedTo2ndLine', fu.MovedTo2ndLine);
    s('tb-tohf',    fu.TOHF);
    s('tb-toCounty', fu.TOCounty);
    s('tb-remarks', fu.Remarks);
  }

  const nameEl = document.getElementById('tb-edit-patient-name');
  if (nameEl) nameEl.textContent = rec.PtName || '';
  const banner = document.getElementById('tb-edit-mode-banner');
  if (banner) banner.hidden = false;
  const cancelBtn = document.getElementById('tb-cancel-edit-btn');
  if (cancelBtn) cancelBtn.hidden = false;
  const titleEl = document.getElementById('tb-form-title');
  if (titleEl) titleEl.textContent = 'Edit Patient \u2014 Unit TB Register';
  const saveBtn = document.getElementById('tb-save-btn');
  if (saveBtn) saveBtn.textContent = 'Update Patient';

  // Trigger wiring to apply conditional visibility with the loaded values
  document.getElementById('tb-ptTypeID')?.dispatchEvent(new Event('change'));
  document.getElementById('tb-outcomeID')?.dispatchEvent(new Event('change'));
  document.getElementById('tb-hivTestResultID')?.dispatchEvent(new Event('change'));

  // Re-sync select / date colour classes (programmatic .value= doesn't fire change)
  refreshFormColours(document.getElementById('tb-patient-form'));

  // If opened from the DQ quality screen, highlight field(s) causing the flag
  _applyDQFieldFocus();
  // If opened from the monitoring screen, scroll to the relevant sputum / outcome field
  _applyMonFieldFocus();

  window.scrollTo({ top: 0, behavior: 'instant' });
}

/** Load a TB patient record in read-only (view) mode. */
function startViewTBPatient(ptDetailsTID) {
  startEditTBPatient(ptDetailsTID);
  _tbViewOnly = true;
  document.getElementById('tb-patient-form')?.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
  const titleEl = document.getElementById('tb-form-title');
  if (titleEl) titleEl.textContent = 'View Patient \u2014 Unit TB Register';
  const saveBtn = document.getElementById('tb-save-btn');
  if (saveBtn) saveBtn.hidden = true;
  const cancelBtn = document.getElementById('tb-cancel-edit-btn');
  if (cancelBtn) cancelBtn.textContent = 'Close';
  // Hide edit banner, show view-only notice
  const editBanner = document.getElementById('tb-edit-mode-banner');
  if (editBanner) editBanner.hidden = true;
  const noAccessBanner = document.getElementById('tb-no-access-banner');
  if (noAccessBanner) noAccessBanner.hidden = false;
}

/** Soft-delete a TB patient record. */
async function deleteTBPatient(ptDetailsTID, name) {
  showDeleteConfirm(`Delete all records for "${name || 'this patient'}"? You can restore this record from the Deleted Records section below.`, async () => {
    try {
      await deletePtDetailsTB(ptDetailsTID);
      { const _u = getUser(); await insertAuditLog({ action: 'DELETE_TB', ptDetailsTID: ptDetailsTID, notes: `Deleted TB patient: ${name || ''}`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }
      renderTBPatients(document.getElementById('tb-search')?.value || '');
      showToast(`"${name}" deleted.`, 'success');
      logSync('INFO', 'Auto-sync: tb-delete', { online: navigator.onLine, hasToken: !!getToken(), syncInProgress: _syncInProgress });
      if (navigator.onLine) triggerTBSync(true, true, 'tb-delete');
    } catch (err) {
      console.error('[TB] Delete failed:', err);
      showToast('Could not delete record.', 'error');
    }
  });
}

// TB Save / Update form handler
document.getElementById('tb-save-btn')?.addEventListener('click', async () => {
  if (!userCanWrite()) return;
  _clearTBErrors();
  const data = _readTBForm();
  const errs = _validateTBForm(data);
  if (errs.length) {
    errs.forEach(e => {
      const el = document.getElementById(e.id);
      if (el) { el.textContent = e.msg; el.hidden = false; }
    });
    showToast('Please fix the highlighted errors.', 'error');
    document.querySelector('#tb-patient-form .field-error:not([hidden])')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }

  // Separate follow-up fields from registration fields
  const followUpFields = ['Mon0Date','Mon0LabNo','Mon0LabResultID','Mon0XpertResultDate','Mon0XpertResultID',
    'DSTResult','Mon2Date','Mon2LabNo','Mon2LabResultID','Mon3Date','Mon3LabNo','Mon3LabResultID',
    'Mon5Date','Mon5LabNo','Mon5LabResultID','Mon6Date','Mon6LabNo','Mon6LabResultID',
    'HIVTestDate','HIVTestResultID','OnART','ARTDate','OnCPT','CPTDate',
    'OutcomeID','OutcomeDate','MovedTo2ndLine','TOHF','TOCounty','Remarks'];
  const patData = Object.fromEntries(Object.entries(data).filter(([k]) => !followUpFields.includes(k)));
  const fuData  = Object.fromEntries(Object.entries(data).filter(([k]) =>  followUpFields.includes(k)));

  try {
    const isEdit = !!_tbEditingTID;
    let tid = _tbEditingTID;
    if (tid) {
      await updatePtDetailsTB(tid, patData);
    } else {
      tid = await insertPtDetailsTB(patData);
    }
    // Always upsert follow-up (one per patient)
    await upsertPtFollowUpTB({ PtDetailsTID: tid, ...fuData });

    { const _u = getUser(); await insertAuditLog({ action: isEdit ? 'UPDATE_TB' : 'CREATE_TB', ptDetailsTID: tid, notes: `${isEdit ? 'Updated' : 'Created'} TB patient: ${(patData.PtName || '').slice(0, 100)}`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }

    _resetTBForm();
    renderTBPatients(document.getElementById('tb-search')?.value || '');
    showToast(isEdit ? 'Patient updated successfully!' : 'Patient saved successfully!', 'success');
    if (navigator.onLine) triggerTBSync(true, false, 'tb-save');
  } catch (err) {
    console.error('[TB] Save failed:', err);
    showToast(`Could not save: ${err.message}`, 'error');
  }
});

// TB Cancel Edit button
document.getElementById('tb-cancel-edit-btn')?.addEventListener('click', () => _resetTBForm());

// Bottom "Back to Monitoring" button — only shown when patient opened from monitoring screen
document.getElementById('tb-back-to-monitoring-btn')?.addEventListener('click', () => {
  document.getElementById('back-to-dashboard-btn')?.click();
});

// TB search input
document.getElementById('tb-search')?.addEventListener('input', (e) => {
  renderTBPatients(e.target.value);
});

// TB export button
document.getElementById('tb-export-btn')?.addEventListener('click', () => {
  try {
    exportDB();
    showToast('Database exported as patients.sqlite', 'success');
  } catch (err) {
    console.error('[TB] Export failed:', err);
    showToast('Export failed. Please try again.', 'error');
  }
});

// TB export to Excel button
document.getElementById('tb-export-excel-btn')?.addEventListener('click', () => {
  exportTBPatientsToExcel();
});

// TB sync button
document.getElementById('tb-sync-btn')?.addEventListener('click', async () => {
  await triggerTBSync(false, false, 'tb-manual');
  await triggerSync(true, false, 'tb-btn-art');
});

// ─── TB Sync ──────────────────────────────────────────────────────────────

let _tbSyncInProgress = false;

async function triggerTBSync(silent = false, background = false, caller = 'unknown') {
  if (_tbSyncInProgress) {
    logSync('WARN', `[TB] Skipped [${caller}] \u2014 TB sync already in progress`);
    return;
  }
  _tbSyncInProgress = true;
  logSync('INFO', `[TB] triggerTBSync called`, { caller, silent, background });

  const tbSyncBtn = document.getElementById('tb-sync-btn');

  if (!navigator.onLine) {
    logSync('WARN', '[TB] Aborted \u2014 device is offline');
    if (!silent) showToast('You are offline. Sync is not available.', 'error');
    _tbSyncInProgress = false;
    return;
  }

  const patients = getAllPtDetailsTBForSync();
  logSync('INFO', '[TB] Local changed records', { patients: patients.length });

  if (patients.length === 0) {
    logSync('INFO', '[TB] Aborted \u2014 no changes to sync');
    if (!silent) showToast('No TB changes to sync — all records are up to date.', '');
    _tbSyncInProgress = false;
    return;
  }

  if (!silent) showToast(`Syncing ${patients.length} TB record(s) to the eTBr server…`, '');

  if (!silent && tbSyncBtn) {
    tbSyncBtn.disabled = true;
    tbSyncBtn.classList.add('syncing');
    tbSyncBtn.textContent = 'Syncing…';
  }

  const patientTIDs = patients.map(p => p.PtDetailsTID);
  const followUps   = getAllPtFollowUpTBForSync(patientTIDs);

  const token = getToken();
  if (!token) {
    logSync('ERROR', '[TB] No auth token');
    showToast('Please sign in before syncing.', 'error');
    _tbSyncInProgress = false;
    return;
  }

  try {
    const payload = {
      patients: patients.map(p => ({
        PtDetailsTID:  p.PtDetailsTID,
        HasChanged:    p.HasChanged,
        Deleted:       p.Deleted ?? 0,
        NearestHFID:   p.NearestHFID || 0,
        RegDate:       p.RegDate       || null,
        UnitTBNo:      p.UnitTBNo      || null,
        PtName:        p.PtName        || null,
        DateOfBirth:   p.DateOfBirth   || null,
        Age:           p.Age           ?? null,
        AgeMonths:     p.AgeMonths     ?? null,
        SexID:         p.SexID,
        ReferredByID:  p.ReferredByID,
        Village:       p.Village       || null,
        Boma:          p.Boma          || null,
        Payam:         p.Payam         || null,
        County:        p.County        || null,
        PtPhone:       p.PtPhone       || null,
        TbTypeID:      p.TbTypeID,
        PtTypeID:      p.PtTypeID,
        DiagMethodID:  p.DiagMethodID,
        DateRxStarted: p.DateRxStarted || null,
        RegimenID:     p.RegimenID,
        TIHF:          p.TIHF          || null,
        TICounty:      p.TICounty      || null,
      })),
      followUps: followUps.map(f => ({
        PtFollowUpTID:   f.PtFollowUpTID,
        PtDetailsTID:    f.PtDetailsTID,
        HasChanged:      f.HasChanged,
        Deleted:         f.Deleted ?? 0,
        Mon0Date:        f.Mon0Date        || null,
        Mon0LabNo:       f.Mon0LabNo       || null,
        Mon0LabResultID: f.Mon0LabResultID,
        Mon0XpertResultDate: f.Mon0XpertResultDate || null,
        Mon0XpertResultID:   f.Mon0XpertResultID,
        DSTResult:       f.DSTResult       || null,
        Mon2Date:        f.Mon2Date        || null,
        Mon2LabNo:       f.Mon2LabNo       || null,
        Mon2LabResultID: f.Mon2LabResultID,
        Mon3Date:        f.Mon3Date        || null,
        Mon3LabNo:       f.Mon3LabNo       || null,
        Mon3LabResultID: f.Mon3LabResultID,
        Mon5Date:        f.Mon5Date        || null,
        Mon5LabNo:       f.Mon5LabNo       || null,
        Mon5LabResultID: f.Mon5LabResultID,
        Mon6Date:        f.Mon6Date        || null,
        Mon6LabNo:       f.Mon6LabNo       || null,
        Mon6LabResultID: f.Mon6LabResultID,
        HIVTestDate:     f.HIVTestDate     || null,
        HIVTestResultID: f.HIVTestResultID,
        OnART:           f.OnART,
        ARTDate:         f.ARTDate         || null,
        OnCPT:           f.OnCPT,
        CPTDate:         f.CPTDate         || null,
        OutcomeID:       f.OutcomeID,
        OutcomeDate:     f.OutcomeDate     || null,
        MovedTo2ndLine:  f.MovedTo2ndLine,
        TOHF:            f.TOHF            || null,
        TOCounty:        f.TOCounty        || null,
        Remarks:         f.Remarks         || null,
      })),
    };

    logSync('INFO', `[TB] POST ${TB_API_URL}`, { patients: payload.patients.length, followUps: payload.followUps.length });

    const response = await fetch(TB_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify(payload),
    });

    logSync('INFO', '[TB] Response', { status: response.status, ok: response.ok });

    if (response.status === 401) {
      logSync('ERROR', '[TB] 401 \u2014 forcing re-login');
      clearAuth(); showAuthScreen();
      showToast('Session expired. Please sign in again.', 'error');
      return;
    }

    if (response.ok) {
      const data = await response.json();
      logSync('INFO', '[TB] Sync successful', data);
      await markTBRecordsSynced(patientTIDs);
      localStorage.setItem('tb.lastSync', new Date().toISOString());
      await _pushAuditLogs();
      renderTBPatients();
      if (!silent) showToast(data.message ?? 'TB sync successful!', 'success');
      else if (!background) showToast('Record synced to the eTBr server successfully.', 'success');
    } else {
      let rawBody = '';
      try { rawBody = await response.text(); } catch { /* ignore */ }
      let errorMsg = `TB sync failed (${response.status})`;
      let sqlErrorNumber = null;
      let sqlErrorMessage = null;
      try {
        const ed = JSON.parse(rawBody);
        errorMsg       = ed.error ?? ed.message ?? errorMsg;
        sqlErrorNumber  = ed.sqlErrorNumber  ?? null;
        sqlErrorMessage = ed.sqlErrorMessage ?? null;
      } catch { /* ignore */ }
      logSync('ERROR', `[TB] eTBr server error ${response.status}`, { errorMsg, sqlErrorNumber, sqlErrorMessage });
      if (!background) showToast(silent ? 'TB auto-sync failed \u2014 tap "Sync Data" to retry.' : `${errorMsg}. Please try again.`, 'error');
    }
  } catch (err) {
    logSync('ERROR', `[TB] Network/JS exception: ${err.message}`);
    if (!background) showToast(silent ? 'TB auto-sync failed.' : 'Could not reach eTBr server.', 'error');
  } finally {
    _tbSyncInProgress = false;
    const tbSyncBtnFinal = document.getElementById('tb-sync-btn');
    if (tbSyncBtnFinal) {
      tbSyncBtnFinal.disabled = false;
      tbSyncBtnFinal.classList.remove('syncing');
      tbSyncBtnFinal.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
          <path d="M23 4v6h-6"/>
          <path d="M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
        Sync Data`;
    }
  }
}

// ─── End TB Register ──────────────────────────────────────────────────────

/**
 * Renders (or refreshes) the "Deleted Records" section below the patient table.
 * Creates the section on first call; only visible when there are deleted records.
 * Only called for users who have write access.
 */
function renderDeletedPatients() {
  const deleted = getAllDeletedPtDetails();

  // Ensure the container exists (created once, reused on subsequent calls)
  let section = document.getElementById('deleted-patients-section');
  if (!section) {
    const tableWrap = document.querySelector('#register-content .table-wrap');
    if (!tableWrap) return;
    section = document.createElement('div');
    section.id = 'deleted-patients-section';
    section.style.marginTop = '1.5rem';
    tableWrap.parentNode.insertBefore(section, tableWrap.nextSibling);

    // Add undelete event delegation once
    section.addEventListener('click', async (e) => {
      const btn = e.target.closest('.undelete-btn');
      if (!btn) return;
      const tid  = btn.dataset.tid;
      const name = btn.dataset.name;
      try {
        await undeletePtDetails(tid);
        { const _u = getUser(); await insertAuditLog({ action: 'UNDELETE_ART', ptDetailsTID: tid, notes: `Restored ART patient: ${name}`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }
        renderPatients(searchInput?.value || '');
        showToast(`"${name}" has been restored.`, 'success');
        logSync('INFO', 'Auto-sync: undelete', { online: navigator.onLine, hasToken: !!getToken(), syncInProgress: _syncInProgress });
        if (navigator.onLine) triggerSync(true, false, 'undelete');
      } catch (err) {
        console.error('[App] Undelete failed:', err);
        showToast('Could not restore patient.', 'error');
      }
    });
  }

  if (!deleted.length) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  section.innerHTML = `
    <details>
      <summary style="cursor:pointer;font-weight:600;padding:0.5rem 0;user-select:none;">
        Deleted Records (${deleted.length}) — click to expand
      </summary>
      <div class="table-wrap table-wrap--tb-scroll" style="margin-top:0.75rem;">
        <table aria-label="Deleted patient records">
          <thead>
            <tr>
              <th>#</th>
              <th>ART No</th>
              <th>Full Name</th>
              <th>Age</th>
              <th>Sex</th>
              <th>Started ART</th>
              <th>Facility</th>
              <th>Deleted On</th>
              <th>Action</th>
            </tr>
          </thead>

          

          <tbody>
            ${deleted.map((p, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escHtml(p.ARTNo)}</td>                
                <td>${escHtml(truncateDisplayName(p.PtName))}</td>
                <td>${p.Age}</td>
                <td>${escHtml(p.Sex ?? '')}</td>
                <td>${p.ARTStartDate ? fmtDate(p.ARTStartDate) : ''}</td>
                <td>${p.HealthFacility}</td>
                <td>${p.LastModOn ? fmtDate(p.LastModOn.substring(0, 10)) : ''}</td>
                <td>
                  <button class="btn btn-secondary btn-sm undelete-btn"
                    data-tid="${escHtml(p.PtDetailsTID)}"
                    data-name="${escHtml(p.PtName)}">
                    Restore
                  </button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </details>`;
}

/**
 * Escapes HTML special characters to prevent XSS when injecting patient data
 * into innerHTML.
 * @param {string} str
 * @returns {string}
 */
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Converts an ISO date string (YYYY-MM-DD) to DD/MM/YYYY for display. */
function fmtDate(iso) {
  if (!iso) return '';
  const parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// ─── Excel export helpers ─────────────────────────────────────────────────

/**
 * Applies standard header-row styling to a range of cells in an ExcelJS worksheet.
 * Matches the eTBr server-side export style: bold Segoe UI, #CCCCFF background,
 * dotted borders, vertically centred, row height 22.
 */
function _xlStyleHeader(ws, row, colCount) {
  const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFCCCCFF' } };
  const BORDER      = { style: 'dotted' };
  const BORDER_ALL  = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
  for (let c = 1; c <= colCount; c++) {
    const cell = ws.getCell(row, c);
    cell.font      = { bold: true, name: 'Segoe UI', size: 10 };
    cell.fill      = HEADER_FILL;
    cell.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
    cell.border    = BORDER_ALL;
  }
  ws.getRow(row).height = 22;
}

/**
 * Applies standard data-row styling to a single row in an ExcelJS worksheet.
 * @param {object}   ws       ExcelJS worksheet
 * @param {number}   row      1-based row number
 * @param {number}   colCount number of columns
 * @param {number[]} centred  0-based column indices that should be centre-aligned
 */
function _xlStyleDataRow(ws, row, colCount, centred = []) {
  const BORDER = { style: 'dotted' };
  const BORDER_ALL = { top: BORDER, bottom: BORDER, left: BORDER, right: BORDER };
  const centredSet = new Set(centred);
  for (let c = 1; c <= colCount; c++) {
    const cell = ws.getCell(row, c);
    cell.font      = { name: 'Segoe UI', size: 10 };
    cell.alignment = { vertical: 'middle', horizontal: centredSet.has(c - 1) ? 'center' : 'left', wrapText: false };
    cell.border    = BORDER_ALL;
  }
  ws.getRow(row).height = 22;
}

/** Returns a timestamp string suitable for use in a filename (DDMMYYYYHHmmss). */
function _xlTimestamp() {
  const n = new Date();
  const pad = v => String(v).padStart(2, '0');
  return `${pad(n.getDate())}${pad(n.getMonth()+1)}${n.getFullYear()}_${pad(n.getHours())}${pad(n.getMinutes())}${pad(n.getSeconds())}`;
}

/** Triggers a browser download of an ExcelJS workbook as an .xlsx file. */
async function _xlDownload(workbook, fileName) {
  const buf  = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = fileName;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}

/**
 * Auto-fits a column's width to match the longest cell value in that column.
 * ExcelJS has no built-in autofit; we calculate from cell content length.
 * @param {object} ws         ExcelJS worksheet
 * @param {number} col1Based  1-based column index
 */
/** Capitalises the first letter of each word (title case) for Excel output. */
function _xlTitleCase(str) {
  if (!str) return '';
  return String(str).toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());
}

/**
 * TB treatment duration lookup by RegimenID.
 *
 * HOW TB TREATMENT END DATE IS CALCULATED
 * ─────────────────────────────────────────
 * 1 TB month = 28 calendar days (standard WHO/NTP convention used throughout
 * this system — every threshold and expiry is expressed in these units).
 *
 * The Regimen string encodes treatment months as the leading digit before each
 * drug abbreviation, separated by "/".  Sum all leading numbers × 28 = total days.
 *
 * RegimenT reference (RegimenID → Regimen → months → days):
 *   1  "2HRZE/4RH"           2+4  =  6 mo = 168 d  Standard new DS-TB
 *   2  "2SHRZE/1HRZE/5RHE"   2+1+5 = 8 mo = 224 d  Retreatment
 *   3  "2HRZE/10RH"          2+10 = 12 mo = 336 d  TB meningitis / severe EPTB
 *   5  "2RHZE/2RH"           2+2  =  4 mo = 112 d  Short-course / preventive
 *   6  "2RHE/7RH"            2+7  =  9 mo = 252 d  Retreatment variant
 *   4  "Select One"          unknown — fall back to PtTypeID estimate
 *
 * Fallback by PtTypeID when RegimenID is 0/4/unknown:
 *   PtTypeID = 1 (New)               → 168 days (6 months)
 *   PtTypeID ∈ {2,3,4,6} (Retreatment) → 224 days (8 months)
 *
 * Start date  : p.DateRxStarted.  If NULL, fall back to p.RegDate.
 * Expected end : start_date + treatment_days.
 * Days overdue : today − expected_end  (positive = patient is past their end date).
 */
const _TB_REGIMEN_DAYS = { 1: 168, 2: 224, 3: 336, 5: 112, 6: 252 };

function _tbTreatmentDays(regimenID, ptTypeID) {
  if (regimenID && _TB_REGIMEN_DAYS[regimenID] != null) return _TB_REGIMEN_DAYS[regimenID];
  if (ptTypeID === 1) return 168;
  return 224; // default retreatment estimate
}

/**
 * Returns expected end-date string and days-overdue for a DQ patient row,
 * or null if DateRxStarted (and RegDate) are both absent.
 * @param {object} r  – patient row from getDQListForReport / dq-list API
 * @returns {{ endFmt: string, daysOver: number } | null}
 */
function _tbExpectedEndInfo(r) {
  const startStr = r.DateRxStarted || r.RegDate;
  if (!startStr) return null;
  const parts   = startStr.split('-').map(Number);
  const startMs = new Date(parts[0], parts[1] - 1, parts[2]).getTime();
  const duration = _tbTreatmentDays(r.RegimenID, r.PtTypeID);
  const endMs   = startMs + duration * 86_400_000;
  const endDt   = new Date(endMs);
  const endFmt  = `${String(endDt.getDate()).padStart(2,'0')}/${String(endDt.getMonth()+1).padStart(2,'0')}/${endDt.getFullYear()}`;
  const daysOver = r.DaysSinceStart != null ? Math.max(0, r.DaysSinceStart - duration) : 0;
  return { endFmt, daysOver };
}

function _xlAutoFitColumn(ws, col1Based) {
  let maxLen = 0;
  ws.getColumn(col1Based).eachCell({ includeEmpty: false }, cell => {
    const len = cell.value != null ? String(cell.value).length : 0;
    if (len > maxLen) maxLen = len;
  });
  // Add 2-char padding; cap between 8 and 60 chars
  ws.getColumn(col1Based).width = Math.min(Math.max(maxLen + 2, 8), 60);
}

/**
 * Exports the currently displayed ART patient list to an Excel file.
 * Respects row-checkbox selection — if rows are selected only those are exported.
 * Works fully offline — ExcelJS is pre-cached by the service worker.
 */
async function exportARTPatientsToExcel() {
  if (typeof ExcelJS === 'undefined') {
    showToast('Excel library not loaded. Please go online once to cache it, then try again.', 'error');
    return;
  }

  const allPatients = getAllPtDetails(searchInput?.value ?? '');
  const checkedTIDs = _getCheckedTIDs('patients-tbody');
  if (!checkedTIDs) {
    showToast('Please select the patients you want to export to Excel.', 'error');
    return;
  }
  const patients = allPatients.filter(p => checkedTIDs.has(p.PtDetailsTID));

  if (!patients.length) {
    showToast('No patient records to export.', 'error');
    return;
  }

  const confirmed = await showGenericConfirmModal(
    'Export to Excel',
    `You are about to export ${patients.length} patient record${patients.length !== 1 ? 's' : ''} to Excel.\n\nPatient data is sensitive \u2014 only export when necessary and store the file securely.\n\nProceed?`,
    'Export'
  );
  if (!confirmed) return;

  const user = getUser();
  const exportedBy = user?.fullName ?? user?.userName ?? 'Unknown User';

  try {
    const wb = new ExcelJS.Workbook();
    wb.created  = new Date();
    wb.modified = new Date();
    const ws = wb.addWorksheet('ART Patients');

    // ── Column definitions (initial widths; C will be autofitted after data) ─
    ws.columns = [
      { key: 'serial', width: 6  },
      { key: 'artno',  width: 14 },
      { key: 'name',   width: 14 },   // C — autofitted below
      { key: 'age',    width: 7  },
      { key: 'sex',    width: 7  },
      { key: 'artdt',  width: 14 },
      { key: 'phone',  width: 16 },
      { key: 'hf',     width: 30 },
    ];

    // ── Header row ─────────────────────────────────────────────────────
    const headerLabels = ['#', 'ART No', 'Full Name', 'Age', 'Sex', 'Started ART', 'Phone', 'Health Facility'];
    headerLabels.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
    _xlStyleHeader(ws, 1, headerLabels.length);
    // Column A header: horizontally centred
    ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };

    // ── Data rows ──────────────────────────────────────────────────────
    const centred = [0, 1, 3, 4, 5]; // #, ART No, Age, Sex, Started ART
    patients.forEach((p, i) => {
      const row = i + 2;
      const sex = p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : (p.Sex ?? '');
      ws.getCell(row, 1).value = i + 1;
      ws.getCell(row, 2).value = p.ARTNo        || '';
      ws.getCell(row, 3).value = _xlTitleCase(p.PtName);
      ws.getCell(row, 4).value = p.Age          ?? '';
      ws.getCell(row, 5).value = sex;
      ws.getCell(row, 6).value = p.ARTStartDate ? fmtDate(p.ARTStartDate) : '';
      ws.getCell(row, 7).value = p.Phone1       || '';
      ws.getCell(row, 8).value = p.HealthFacility || '';
      _xlStyleDataRow(ws, row, headerLabels.length, centred);
    });

    // ── Autofit column C (Full Name) ───────────────────────────────────
    _xlAutoFitColumn(ws, 3);

    // ── Sheet formatting ───────────────────────────────────────────────
    ws.views           = [{ state: 'frozen', ySplit: 1 }];
    ws.pageSetup       = { orientation: 'landscape', paperSize: 5, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.headerFooter.oddFooter = `&LExported from eTBr on ${new Date().toDateString()} by ${exportedBy}`;

    await _xlDownload(wb, `ART_Patients_${_xlTimestamp()}.xlsx`);
    logSync('INFO', `[Export] ART: ${patients.length} patient(s) exported by ${exportedBy}`);
    await insertAuditLog({ action: 'EXPORT_ART', notes: `Exported ${patients.length} ART patient(s) to Excel`, userTID: user?.userTID, userName: exportedBy });
    showToast(`Exported ${patients.length} ART patient${patients.length !== 1 ? 's' : ''} to Excel.`, 'success');
  } catch (err) {
    console.error('[Excel Export ART] Failed:', err);
    showToast('Failed to export to Excel. Please try again.', 'error');
  }
}

/**
 * Exports the currently displayed TB patient list to an Excel file.
 * Respects row-checkbox selection — if rows are selected only those are exported.
 * Columns mirror those used in the server-side Template_ExportedData.xlsx export.
 * Works fully offline — ExcelJS is pre-cached by the service worker.
 */
async function exportTBPatientsToExcel() {
  if (typeof ExcelJS === 'undefined') {
    showToast('Excel library not loaded. Please go online once to cache it, then try again.', 'error');
    return;
  }

  const tbSearch    = document.getElementById('tb-search')?.value ?? '';
  const allPatients = getAllPtDetailsTB(tbSearch);
  const checkedTIDs = _getCheckedTIDs('tb-patient-tbody');
  if (!checkedTIDs) {
    showToast('Please select the patients you want to export to Excel.', 'error');
    return;
  }
  const patients = allPatients.filter(p => checkedTIDs.has(p.PtDetailsTID));

  if (!patients.length) {
    showToast('No TB patient records to export.', 'error');
    return;
  }

  const confirmed = await showGenericConfirmModal(
    'Export to Excel',
    `You are about to export ${patients.length} patient record${patients.length !== 1 ? 's' : ''} to Excel.\n\nPatient data is sensitive \u2014 only export when necessary and store the file securely.\n\nProceed?`,
    'Export'
  );
  if (!confirmed) return;

  const user = getUser();
  const exportedBy = user?.fullName ?? user?.userName ?? 'Unknown User';

  try {
    const wb = new ExcelJS.Workbook();
    wb.created  = new Date();
    wb.modified = new Date();
    const ws = wb.addWorksheet('TB Patients');

    // ── Column definitions (initial widths; C, I, J autofitted after data) ─
    ws.columns = [
      { key: 'serial', width: 6  },
      { key: 'regdt',  width: 13 },
      { key: 'tbno',   width: 8  },   // C — autofitted below
      { key: 'name',   width: 28 },
      { key: 'age',    width: 7  },
      { key: 'sex',    width: 7  },
      { key: 'vil',    width: 18 },
      { key: 'phone',  width: 16 },
      { key: 'site',   width: 8  },   // I — autofitted below
      { key: 'type',   width: 8  },   // J — autofitted below
      { key: 'hf',     width: 30 },
    ];

    // ── Header row ─────────────────────────────────────────────────────
    const headerLabels = ['#', 'Reg. Date', 'TB No', 'Patient Name', 'Age', 'Sex', 'Village', 'Phone', 'TB Site', 'Type', 'Health Facility'];
    headerLabels.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
    _xlStyleHeader(ws, 1, headerLabels.length);
    // Column A header: horizontally centred
    ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };

    // ── Data rows ──────────────────────────────────────────────────────
    const centred = [0, 1, 2, 4, 5, 8, 9]; // #, Reg. Date, TB No, Age, Sex, TB Site, Type
    patients.forEach((p, i) => {
      const row = i + 2;
      const sex = p.SexID === 1 ? 'M' : p.SexID === 2 ? 'F' : (p.Sex ?? '');
      const tbType = (p.TbType  && !p.TbType.toLowerCase().includes('select'))        ? p.TbType  : '';
      const ptType = (p.PtTypeShort && !p.PtTypeShort.toLowerCase().includes('select')) ? p.PtTypeShort
                   : (p.PtType && !p.PtType.toLowerCase().includes('select'))          ? p.PtType  : '';
      ws.getCell(row, 1).value  = i + 1;
      ws.getCell(row, 2).value  = p.RegDate ? fmtDate(p.RegDate.slice(0, 10)) : '';
      ws.getCell(row, 3).value  = p.UnitTBNo            || '';
      ws.getCell(row, 4).value  = _xlTitleCase(p.PtName);
      ws.getCell(row, 5).value  = p.Age                 ?? '';
      ws.getCell(row, 6).value  = sex;
      ws.getCell(row, 7).value  = _xlTitleCase(p.Village);
      ws.getCell(row, 8).value  = p.PtPhone             || '';
      ws.getCell(row, 9).value  = tbType;
      ws.getCell(row, 10).value = ptType;
      ws.getCell(row, 11).value = p.HealthFacility      || '';
      _xlStyleDataRow(ws, row, headerLabels.length, centred);
    });

    // ── Autofit columns C (TB No), I (TB Site), J (Type) ──────────────
    _xlAutoFitColumn(ws, 3);
    _xlAutoFitColumn(ws, 9);
    _xlAutoFitColumn(ws, 10);

    // ── Sheet formatting ───────────────────────────────────────────────
    ws.views     = [{ state: 'frozen', ySplit: 1 }];
    ws.pageSetup = { orientation: 'landscape', paperSize: 5, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.headerFooter.oddFooter = `&LExported from eTBr on ${new Date().toDateString()} by ${exportedBy}`;

    await _xlDownload(wb, `TB_Patients_${_xlTimestamp()}.xlsx`);
    logSync('INFO', `[Export] TB: ${patients.length} patient(s) exported by ${exportedBy}`);
    await insertAuditLog({ action: 'EXPORT_TB', notes: `Exported ${patients.length} TB patient(s) to Excel`, userTID: user?.userTID, userName: exportedBy });
    showToast(`Exported ${patients.length} TB patient${patients.length !== 1 ? 's' : ''} to Excel.`, 'success');
  } catch (err) {
    console.error('[Excel Export TB] Failed:', err);
    showToast('Failed to export to Excel. Please try again.', 'error');
  }
}

/**
 * Exports the currently displayed TB Monitoring patient list to Excel.
 * Columns: #, TB No, Reg. Date, Patient Name, Age, Sex, Village, Phone, Facility, Type, [Days Late/Due]
 * Respects row-checkbox selection. Works fully offline.
 */
async function exportMonPatientsToExcel() {
  if (typeof ExcelJS === 'undefined') {
    showToast('Excel library not loaded. Please go online once to cache it, then try again.', 'error');
    return;
  }

  const checkedTIDs = _getCheckedTIDs('mon-patient-tbody');
  if (!checkedTIDs) {
    showToast('Please select the patients you want to export to Excel.', 'error');
    return;
  }
  const rows = _monCurrentRows.filter(r => checkedTIDs.has(String(r.PtDetailsTID)));

  if (!rows.length) {
    showToast('No patients in this list to export.', 'error');
    return;
  }

  const confirmed = await showGenericConfirmModal(
    'Export to Excel',
    `You are about to export ${rows.length} patient record${rows.length !== 1 ? 's' : ''} to Excel.\n\nPatient data is sensitive \u2014 only export when necessary and store the file securely.\n\nProceed?`,
    'Export'
  );
  if (!confirmed) return;

  const user = getUser();
  const exportedBy = user?.fullName ?? user?.userName ?? 'Unknown User';

  const cat         = typeof _monCategory !== 'undefined' ? _monCategory : '';
  const isSputum    = ['2month','3month','5month','6month','8month'].includes(cat);
  const isOutcome   = cat === 'outcome';
  const showDayCol  = isSputum || isOutcome;
  const dayColLabel = isSputum
    ? (typeof _monMode !== 'undefined' && _monMode === 'due' ? 'Days Until Due' : 'Days Late')
    : 'Days Since Rx Start';
  const listTitle   = document.getElementById('mon-list-title')?.textContent || 'Monitoring List';

  try {
    const wb = new ExcelJS.Workbook();
    wb.created  = new Date();
    wb.modified = new Date();
    const ws = wb.addWorksheet('Monitoring');

    const colCount = showDayCol ? 11 : 10;
    ws.columns = [
      { key: 'serial', width: 6  },
      { key: 'tbno',   width: 8  },   // C — autofitted
      { key: 'regdt',  width: 13 },
      { key: 'name',   width: 28 },
      { key: 'age',    width: 7  },
      { key: 'sex',    width: 7  },
      { key: 'vil',    width: 18 },
      { key: 'phone',  width: 16 },
      { key: 'hf',     width: 8  },   // I — autofitted
      { key: 'type',   width: 8  },   // J — autofitted
      ...(showDayCol ? [{ key: 'days', width: 14 }] : []),
    ];

    const headerLabels = ['#', 'TB No', 'Reg. Date', 'Patient Name', 'Age', 'Sex', 'Village', 'Phone', 'Health Facility', 'Type',
      ...(showDayCol ? [dayColLabel] : [])];
    headerLabels.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
    _xlStyleHeader(ws, 1, colCount);
    ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };

    const centred = [0, 1, 4, 5, ...(showDayCol ? [10] : [])];
    rows.forEach((p, i) => {
      const row = i + 2;
      const sex = p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : (p.Sex || '');
      ws.getCell(row, 1).value  = i + 1;
      ws.getCell(row, 2).value  = p.UnitTBNo            || '';
      ws.getCell(row, 3).value  = p.RegDate ? fmtDate(p.RegDate.slice(0, 10)) : '';
      ws.getCell(row, 4).value  = _xlTitleCase(p.PtName);
      ws.getCell(row, 5).value  = p.Age                 ?? '';
      ws.getCell(row, 6).value  = sex;
      ws.getCell(row, 7).value  = _xlTitleCase(p.Village);
      ws.getCell(row, 8).value  = p.PtPhone             || '';
      ws.getCell(row, 9).value  = p.HealthFacility      || '';
      ws.getCell(row, 10).value = p.PtTypeShort         || '';
      if (showDayCol) {
        const d = isSputum ? p.DaysLate : p.DaysSinceStart;
        ws.getCell(row, 11).value = d != null ? d : '';
      }
      _xlStyleDataRow(ws, row, colCount, centred);
    });

    // Autofit C (TB No), I (Facility), J (Type)
    _xlAutoFitColumn(ws, 2);
    _xlAutoFitColumn(ws, 9);
    _xlAutoFitColumn(ws, 10);

    ws.views     = [{ state: 'frozen', ySplit: 1 }];
    ws.pageSetup = { orientation: 'landscape', paperSize: 5, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.headerFooter.oddFooter = `&LExported from eTBr on ${new Date().toDateString()} by ${exportedBy}`;

    const safeTitle = listTitle.replace(/["/\\:*?<>|]/g, '_').slice(0, 50).trim();
    await _xlDownload(wb, `Monitoring_${safeTitle}_${_xlTimestamp()}.xlsx`);
    logSync('INFO', `[Export] MON (${safeTitle}): ${rows.length} patient(s) exported by ${exportedBy}`);
    await insertAuditLog({ action: 'EXPORT_MON', notes: `Exported ${rows.length} patient(s) from monitoring list “${safeTitle}” to Excel`, userTID: user?.userTID, userName: exportedBy });
    showToast(`Exported ${rows.length} patient${rows.length !== 1 ? 's' : ''} to Excel.`, 'success');
  } catch (err) {
    console.error('[Excel Export MON] Failed:', err);
    showToast('Failed to export to Excel. Please try again.', 'error');
  }
}

/**
 * Exports the currently displayed Data Quality patient list to Excel.
 * Columns: #, TB No, Reg. Date, Patient Name, Age, Sex, TB Site, Type, Diag. Method, Issue, Phone, Facility
 * Respects row-checkbox selection. Works fully offline.
 */
async function exportDQPatientsToExcel() {
  if (typeof ExcelJS === 'undefined') {
    showToast('Excel library not loaded. Please go online once to cache it, then try again.', 'error');
    return;
  }

  const checkedTIDs = _getCheckedTIDs('dq-patient-tbody');
  if (!checkedTIDs) {
    showToast('Please select the patients you want to export to Excel.', 'error');
    return;
  }
  const rows = _dqCurrentRows.filter(r => checkedTIDs.has(String(r.PtDetailsTID)));

  if (!rows.length) {
    showToast('No patients in this list to export.', 'error');
    return;
  }

  const confirmed = await showGenericConfirmModal(
    'Export to Excel',
    `You are about to export ${rows.length} patient record${rows.length !== 1 ? 's' : ''} to Excel.\n\nPatient data is sensitive \u2014 only export when necessary and store the file securely.\n\nProceed?`,
    'Export'
  );
  if (!confirmed) return;

  const user = getUser();
  const exportedBy = user?.fullName ?? user?.userName ?? 'Unknown User';

  const cat       = typeof _dqCategory !== 'undefined' ? _dqCategory : '';
  const listTitle = document.getElementById('dq-list-title')?.textContent || 'Data Quality';

  try {
    const wb = new ExcelJS.Workbook();
    wb.created  = new Date();
    wb.modified = new Date();
    const ws = wb.addWorksheet('Data Quality');

    ws.columns = [
      { key: 'serial', width: 6  },
      { key: 'tbno',   width: 8  },   // B — autofitted (col 2, letter C in exported sheet is "Reg. Date")
      { key: 'regdt',  width: 13 },
      { key: 'name',   width: 28 },
      { key: 'age',    width: 7  },
      { key: 'sex',    width: 7  },
      { key: 'site',   width: 8  },
      { key: 'type',   width: 8  },
      { key: 'issue',  width: 20 },   // I — autofitted
      { key: 'diag',   width: 8  },   // J — autofitted
      { key: 'phone',  width: 16 },
      { key: 'hf',     width: 30 },
    ];

    const headerLabels = ['#', 'TB No', 'Reg. Date', 'Patient Name', 'Age', 'Sex', 'TB Site', 'Type', 'Issue', 'Diag. Method', 'Phone', 'Health Facility'];
    headerLabels.forEach((h, i) => { ws.getCell(1, i + 1).value = h; });
    _xlStyleHeader(ws, 1, headerLabels.length);
    ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'center', wrapText: false };

    const centred = [0, 1, 4, 5, 6, 7, 9];
    rows.forEach((r, i) => {
      const row = i + 2;
      const ageDisplay = (r.AgeMonths && r.Age === 0) ? `${r.AgeMonths}m` : (r.Age != null ? String(r.Age) : '');
      const sex = r.SexID === 1 ? 'M' : r.SexID === 2 ? 'F' : '';
      const tbType = (r.TbType && !r.TbType.toLowerCase().includes('select')) ? r.TbType : '';
      const ptType = (r.PtTypeShort && !r.PtTypeShort.toLowerCase().includes('select')) ? r.PtTypeShort : '';
      const diagMethod = (r.DiagMethod || '').replace(/Smear Microscopy/gi, 'Microscopy');

      // Reconstruct plain-text issue note
      let issue = '';
      if      (cat === 'missingreg'   && r.MissingFields)          issue = `Missing: ${r.MissingFields}`;
      else if (cat === 'smearcured'   && r.Outcome)                issue = `Outcome: ${r.Outcome}`;
      else if (cat === 'nooutcome' || cat === 'notevaluated') {
        const _ei = _tbExpectedEndInfo(r);
        issue = _ei ? `Due: ${_ei.endFmt} (+${_ei.daysOver}d overdue)` : r.DaysSinceStart != null ? `${r.DaysSinceStart}d on Rx` : '';
      }
      else if (cat === 'norxstart'    && r.DaysSinceReg != null)   issue = `${r.DaysSinceReg}d since reg.`;
      else if (cat === 'futuredates')                               issue = 'Future date';
      else if (cat === 'duplicates')                                issue = 'Possible duplicate';
      else if (cat === 'sametbno'     && r.UnitTBNo)               issue = `TB No: ${r.UnitTBNo}`;
      else if (cat === 'deleted')                                   issue = 'Deleted';

      ws.getCell(row, 1).value  = i + 1;
      ws.getCell(row, 2).value  = r.UnitTBNo       || '';
      ws.getCell(row, 3).value  = r.RegDate ? fmtDate(r.RegDate.slice ? r.RegDate.slice(0, 10) : r.RegDate) : '';
      ws.getCell(row, 4).value  = _xlTitleCase(r.PtName);
      ws.getCell(row, 5).value  = ageDisplay;
      ws.getCell(row, 6).value  = sex;
      ws.getCell(row, 7).value  = tbType;
      ws.getCell(row, 8).value  = ptType;
      ws.getCell(row, 9).value  = issue;
      ws.getCell(row, 10).value = diagMethod      || '';
      ws.getCell(row, 11).value = r.PtPhone       || '';
      ws.getCell(row, 12).value = r.HealthFacility || '';
      _xlStyleDataRow(ws, row, headerLabels.length, centred);
    });

    // Autofit C (Reg. Date), I (Issue), J (Diag. Method)
    _xlAutoFitColumn(ws, 3);   // C = Reg. Date
    _xlAutoFitColumn(ws, 9);   // I = Issue
    _xlAutoFitColumn(ws, 10);  // J = Diag. Method

    ws.views     = [{ state: 'frozen', ySplit: 1 }];
    ws.pageSetup = { orientation: 'landscape', paperSize: 5, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
    ws.headerFooter.oddFooter = `&LExported from eTBr on ${new Date().toDateString()} by ${exportedBy}`;

    const safeTitle = listTitle.replace(/["/\\:*?<>|]/g, '_').slice(0, 50).trim();
    await _xlDownload(wb, `DataQuality_${safeTitle}_${_xlTimestamp()}.xlsx`);
    logSync('INFO', `[Export] DQ (${safeTitle}): ${rows.length} patient(s) exported by ${exportedBy}`);
    await insertAuditLog({ action: 'EXPORT_DQ', notes: `Exported ${rows.length} patient(s) from data quality “${safeTitle}” to Excel`, userTID: user?.userTID, userName: exportedBy });
    showToast(`Exported ${rows.length} patient${rows.length !== 1 ? 's' : ''} to Excel.`, 'success');
  } catch (err) {
    console.error('[Excel Export DQ] Failed:', err);
    showToast('Failed to export to Excel. Please try again.', 'error');
  }
}

// ─── Event: form submit ──────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!_selectedFacility) {
    showToast('Please select a health facility before saving.', 'error');
    _openSidebar();
    return;
  }

  if (!validateForm()) {
    // validateForm() already shows a specific toast for cross-field errors
    // (INH gaps, pregnancy gaps). Only show the generic fallback when no
    // specific toast was raised (i.e. field-level errors caught by check()).
    const hasSpecificToast = toast.classList.contains('show') && toast.classList.contains('error');
    if (!hasSpecificToast) showToast('Please fix the highlighted errors.', 'error');
    return;
  }

  submitBtn.disabled    = true;
  submitBtn.textContent = 'Saving…';

  try {
    // ── Collect month/year inputs → YYYY-MM-01 ──────────────────────────
    function monthToDate(val) {
      return val ? `${val}-01` : null;
    }

    const data = {
      HIVRetest:            Number(document.querySelector('input[name="hivRetest"]:checked')?.value ?? 0),
      ARTNo:                document.getElementById('artNo').value.trim(),
      ARTStartDate:         document.getElementById('artStartDate').value || null,
      DateEnrolledInCare:   document.getElementById('dateEnrolledInCare').value || null,
      PtName:               document.getElementById('fullName').value.trim(),
      ResidenceAddress:     document.getElementById('residenceAddress').value.trim() || null,
      Phone1:               document.getElementById('phone1').value.trim() || null,
      Phone2:               document.getElementById('phone2').value.trim() || null,
      OccupationID:         Number(document.getElementById('occupationId').value),
      OccupationOther:      document.getElementById('occupationOther').value.trim() || null,
      KeyPopuID:            Number(document.getElementById('keyPopuId').value),
      KeyPopuOther:         document.getElementById('keyPopuOther').value.trim() || null,
      Age:                  Number(document.getElementById('age').value) || 0,
      DateOfBirth:          document.getElementById('dateOfBirth').value || null,
      SexID:                Number(document.getElementById('sexId').value),
      WeightKg:             parseFloat(document.getElementById('weightKg').value) || null,
      HeightCm:             parseFloat(document.getElementById('heightCm').value) || null,
      MUACCm:               parseFloat(document.getElementById('muacCm').value) || null,
      WHOStageID:           Number(document.getElementById('whoStageId').value),
      CD4Value:             parseFloat(document.getElementById('cd4Value').value) || null,
      CD4IsPercent:         document.getElementById('cd4IsPercent').checked ? 1 : 0,
      CPTStartDate:         monthToDate(document.getElementById('cptStartDate').value),
      CPTDrugID:            Number(document.getElementById('cptDrugId').value),
      TBRxStartDate:        monthToDate(document.getElementById('tbRxStartDate').value),
      UnitTBNo:             document.getElementById('unitTBNo').value.trim() || null,
      TBStatusID:           Number(document.getElementById('tbStatusId').value),
      BreastfeedingID:      Number(document.getElementById('breastfeedingId').value),
      IsTransferIn:         document.querySelector('input[name="isTransferIn"]:checked')?.value === '1' ? 1 : 0,
      TransferFromFacility: document.getElementById('transferFromFacility').value.trim() || null,
      GuardianName:         document.getElementById('guardianName').value.trim() || null,
      GuardianPhone1:       document.getElementById('guardianPhone1').value.trim() || null,
      // Facility fields — populated from the tree selection
      NearestHFID:          _selectedFacility?.id       || 0,
      DataSourceID:         _selectedFacility?.id       || 0,
      CountyID:             _selectedFacility?.countyId || 0,
    };

    const wasEditing = !!_editingTID;
    let ptTID;
    if (_editingTID) {
      await updatePtDetails(_editingTID, data);
      await deletePtSubRecords(_editingTID);
      ptTID = _editingTID;
    } else {
      ptTID = await insertPtDetails(data);
    }

    // ── INH dates ────────────────────────────────────────────────────────
    const inhRows = document.querySelectorAll('#inh-rows .dynamic-row');
    let inhSeq = 1;
    for (const row of inhRows) {
      const dateVal = row.querySelector('input[type="date"]')?.value;
      if (dateVal) {
        await insertINH({ PtDetailsTID: ptTID, SequenceNo: inhSeq++, INHDate: dateVal });
      }
    }

    // ── Pregnancy rows (PMTCT) ───────────────────────────────────────────
    const pregRows = document.querySelectorAll('#pregnancy-rows .dynamic-row');
    let pregNo = 1;
    for (const row of pregRows) {
      const ancNo       = row.querySelector('.preg-anc')?.value.trim() || null;
      const delDate     = row.querySelector('.preg-del')?.value || null;
      const motherART   = row.querySelector('.preg-mother')?.checked ? 1 : 0;
      const infantARVs  = row.querySelector('.preg-infant')?.checked ? 1 : 0;
      if (ancNo || delDate) {
        await insertPMTCT({ PtDetailsTID: ptTID, PregnancyNo: pregNo++, ANCNo: ancNo, DeliveryDate: delDate, MotherReceivedART: motherART, InfantReceivedARVs: infantARVs });
      }
    }

    // ── Regimen history ──────────────────────────────────────────────────
    const regimenSlots = [
      { line: 1, seq: 0, drugId: 'reg1Original',  reasonId: null,          otherEl: null,             dateEl: null },
      { line: 1, seq: 1, drugId: 'reg1Sub1Drug',  reasonId: 'reg1Sub1Reason', otherEl: 'reg1Sub1Other', dateEl: 'reg1Sub1Date' },
      { line: 1, seq: 2, drugId: 'reg1Sub2Drug',  reasonId: 'reg1Sub2Reason', otherEl: 'reg1Sub2Other', dateEl: 'reg1Sub2Date' },
      { line: 2, seq: 0, drugId: 'reg2Switch',    reasonId: 'reg2SwitchReason', otherEl: null,          dateEl: 'reg2SwitchDate' },
      { line: 2, seq: 1, drugId: 'reg2Sub1Drug',  reasonId: 'reg2Sub1Reason', otherEl: 'reg2Sub1Other', dateEl: 'reg2Sub1Date' },
      { line: 2, seq: 2, drugId: 'reg2Sub2Drug',  reasonId: 'reg2Sub2Reason', otherEl: 'reg2Sub2Other', dateEl: 'reg2Sub2Date' },
    ];
    for (const slot of regimenSlots) {
      const drugId = Number(document.getElementById(slot.drugId)?.value ?? 0);
      if (drugId > 0) {
        await insertRegimenHistory({
          PtDetailsTID:   ptTID,
          RegimenLine:    slot.line,
          SequenceNo:     slot.seq,
          RegimenID:      drugId,
          ChangeReasonID: slot.reasonId ? Number(document.getElementById(slot.reasonId)?.value ?? 0) : 0,
          OtherReasonText: slot.otherEl  ? (document.getElementById(slot.otherEl)?.value.trim() || null) : null,
          EventDate:      slot.dateEl    ? (document.getElementById(slot.dateEl)?.value || null) : null,
        });
      }
    }

    exitEditMode();
    form.reset();
    // Unlock age fields that may have been locked by a DOB entry
    if (ageInput)       { ageInput.readOnly = false; ageInput.classList.remove('field-readonly'); }
    if (ageMonthsInput) { ageMonthsInput.disabled = false; ageMonthsInput.readOnly = false; ageMonthsInput.classList.remove('field-readonly'); }
    // Reset dynamic rows
    document.getElementById('inh-rows').innerHTML = '';
    document.getElementById('pregnancy-rows').innerHTML = '';
    // Re-hide conditional sections
    pmtctSection.hidden = true;
    document.getElementById('occupationOther-wrap').hidden = true;
    document.getElementById('keyPopuOther-wrap').hidden = true;
    document.getElementById('transferFacility-wrap').hidden = true;
    document.getElementById('guardian-wrap').hidden = true;
    searchInput.value = '';
    renderPatients();
    showToast(wasEditing ? 'Patient updated successfully!' : 'Patient saved successfully!', 'success');
    // Auto-sync in background — silent so the "saved" toast stays visible on success;
    // an error toast will still appear if the server cannot be reached.
    logSync('INFO', 'Auto-sync: form-save', { online: navigator.onLine, hasToken: !!getToken(), syncInProgress: _syncInProgress });
    if (navigator.onLine) triggerSync(true, false, 'form-save');

  } catch (err) {
    console.error('[App] Error saving patient:', err);
    showToast(`Error saving patient: ${err.message}`, 'error');
  } finally {
    submitBtn.disabled  = false;
    // If save failed while in edit mode, keep "Update Patient"; otherwise "Save Patient"
    submitBtn.innerHTML = _editingTID ? UPDATE_BTN_HTML : SAVE_BTN_HTML;
  }
});

// ─── Event: delete patient (event delegation on tbody) ───────────────────

patientsTbody.addEventListener('click', async (event) => {
  // ── Edit button ────────────────────────────────────────────────────────
  const editBtn = event.target.closest('.edit-btn');
  if (editBtn) {
    loadPatientIntoForm(editBtn.dataset.tid);
    return;
  }

  // ── View button (read-only users) ──────────────────────────────────────
  const viewBtn = event.target.closest('.view-btn');
  if (viewBtn) {
    loadPatientIntoForm(viewBtn.dataset.tid);
    return;
  }

  // ── Visits button ───────────────────────────────────────────────────────
  const visitsBtn = event.target.closest('.visits-btn');
  if (visitsBtn) {
    _currentVisitPatientTID = visitsBtn.dataset.tid;
    _currentVisitARTStart   = visitsBtn.dataset.artstart;
    _visitReadOnly          = visitsBtn.dataset.readonly === 'true';
    visitsPatientNameEl.textContent = visitsBtn.dataset.name;
    visitsPanelEl.hidden = false;
    visitsPanelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Hide the add/edit visit form for read-only users
    const visitFormSection = visitsPanelEl.querySelector('.form-section');
    if (visitFormSection) visitFormSection.hidden = _visitReadOnly;
    renderVisits(_currentVisitPatientTID);
    return;
  }

  // ── Delete button ──────────────────────────────────────────────────────
  const btn = event.target.closest('.delete-btn');
  if (!btn) return;

  const tid  = btn.dataset.tid;
  const name = btn.closest('tr')?.querySelector('td:nth-child(3)')?.textContent || 'this patient';

  showDeleteConfirm(`Delete all records for "${name}"? You can restore this record from the Deleted Records section below.`, async () => {
    try {
      await deletePtDetails(tid);
      { const _u = getUser(); await insertAuditLog({ action: 'DELETE_ART', ptDetailsTID: tid, notes: `Deleted ART patient: ${name}`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }
      if (_currentVisitPatientTID === tid) visitsPanelEl.hidden = true;
      renderPatients(searchInput.value);
      showToast('Patient deleted. Use "Deleted Records" below to restore if needed.', 'success');
      logSync('INFO', 'Auto-sync: delete', { online: navigator.onLine, hasToken: !!getToken(), syncInProgress: _syncInProgress });
      if (navigator.onLine) triggerSync(true, false, 'delete');
    } catch (err) {
      console.error('[App] Delete failed:', err);
      showToast('Could not delete patient.', 'error');
    }
  });
});

// ─── Event: live search ──────────────────────────────────────────────────

searchInput.addEventListener('input', () => {
  renderPatients(searchInput.value);
});

// ─── Event: export database ──────────────────────────────────────────────

exportBtn.addEventListener('click', () => {
  try {
    exportDB();   // from db.js — triggers download of patients.sqlite
    showToast('Database exported as patients.sqlite', 'success');
  } catch (err) {
    console.error('[App] Export failed:', err);
    showToast('Export failed. Please try again.', 'error');
  }
});

// ─── Event: export ART patient list to Excel ─────────────────────────────

document.getElementById('export-excel-btn')?.addEventListener('click', () => {
  exportARTPatientsToExcel();
});

// ─── Populate dropdowns from lookup tables ───────────────────────────────

async function populateDropdowns() {
  function fill(selId, rows, idKey, labelKey, skipZero = false) {
    const sel = document.getElementById(selId);
    if (!sel) return;
    const existing = sel.querySelector('option[value="0"]');
    sel.innerHTML = '';
    if (existing) sel.appendChild(existing);
    for (const r of rows) {
      if (skipZero && r[idKey] === 0) continue;
      const opt = document.createElement('option');
      opt.value       = r[idKey];
      opt.textContent = labelKey === 'combined'
        ? `${r.RegimenCode} — ${r.Regimen}`
        : r[labelKey];
      sel.appendChild(opt);
    }
  }

  try {
    const sex        = getLookupAll('SexT');
    const occ        = getLookupAll('OccupationT');
    const keyw       = getLookupAll('KeyPopuT');
    const who        = getLookupAll('WHOStageT');
    const bf         = getLookupAll('BreastfeedingT');
    const cpt        = getLookupAll('CPTDrugT');
    const regimens   = getLookupAll('RegimenARTT');
    const reasons    = getLookupAll('RegimenChangeReasonT');
    const fuStatus   = getLookupAll('FollowUpStatusT');
    const tbSt       = getLookupAll('TBStatusT');
    const stopReas   = getLookupAll('StopReasonT');

    console.log('[DB] SexT rows:', sex.length, '| OccupationT:', occ.length, '| RegimenARTT:', regimens.length);

    const switchReas = reasons.filter(r => r.RegimenChangeReasonID >= 8);
    const subReas    = reasons.filter(r => r.RegimenChangeReasonID >= 1 && r.RegimenChangeReasonID <= 7);
    const adult1st   = regimens.filter(r => r.RegimenCategoryID === 1);
    const adult2nd   = regimens.filter(r => r.RegimenCategoryID === 2);

    fill('sexId',           sex,     'SexID',     'Sex',     true);
    fill('occupationId',    occ,     'OccupationID', 'Occupation');
    fill('keyPopuId',       keyw,    'KeyPopuID', 'KeyPopu');
    fill('whoStageId',      who,     'WHOStageID', 'WHOStage');
    fill('breastfeedingId', bf,      'BreastfeedingID', 'Breastfeeding');
    fill('cptDrugId',       cpt,     'CPTDrugID', 'CPTDrug');
    fill('tbStatusId',      tbSt,    'TBStatusID', 'TBStatus');

    fill('reg1Original', adult1st, 'RegimenID', 'combined');
    fill('reg1Sub1Drug', adult1st, 'RegimenID', 'combined');
    fill('reg1Sub2Drug', adult1st, 'RegimenID', 'combined');
    fill('reg2Switch',   adult2nd, 'RegimenID', 'combined');
    fill('reg2Sub1Drug', adult2nd, 'RegimenID', 'combined');
    fill('reg2Sub2Drug', adult2nd, 'RegimenID', 'combined');

    ['reg1Sub1Reason','reg1Sub2Reason','reg2Sub1Reason','reg2Sub2Reason']
      .forEach(id => fill(id, subReas, 'RegimenChangeReasonID', 'RegimenChangeReason'));
    fill('reg2SwitchReason', switchReas, 'RegimenChangeReasonID', 'RegimenChangeReason');

    fill('visitFollowUpStatus', fuStatus, 'FollowUpStatusID', 'FollowUpStatus');
    fill('visitRegimen',        regimens, 'RegimenID', 'combined');
    fill('visitTBStatus',       tbSt,     'TBStatusID', 'TBStatus');
    fill('visitCPTDrug',        cpt,      'CPTDrugID', 'CPTDrug');
    fill('visitStopReason',     stopReas, 'StopReasonID', 'StopReason');

    // ── TB Register dropdowns ─────────────────────────────────────────────
    // Helper: remove DB rows with ID=0 ("Not Recorded") and any "Select One"
    // placeholder rows — the HTML option value="0" serves as the placeholder.
    function tbRows(rows, labelKey) {
      return rows.filter(r => {
        const label = String(r[labelKey] ?? '').trim();
        return label !== 'Select One' && label !== 'Not recorded';
      });
    }
    fill('tb-sexID',           tbRows(sex,                                  'Sex'),         'SexID',          'Sex',          true);
    fill('tb-referredByID',    tbRows(getLookupAll('ReferredByT'),           'ReferredBy'),  'ReferredByID',   'ReferredBy',   true);
    fill('tb-tbTypeID',        tbRows(getLookupAll('TbTypeT'),               'TbType'),      'TbTypeID',       'TbType',       true);
    fill('tb-ptTypeID',        tbRows(getLookupAll('PtTypeT'),               'PtType'),      'PtTypeID',       'PtType',       true);
    fill('tb-diagMethodID',    tbRows(getLookupAll('DiagMethodT'),           'DiagMethod'),  'DiagMethodID',   'DiagMethod',   true);
    fill('tb-regimenID',       tbRows(getLookupAll('RegimenT'),              'Regimen'),     'RegimenID',      'Regimen',      true);
    fill('tb-xpertResultID',   tbRows(getLookupAll('XpertResultT'),          'XpertResult'), 'XpertResultID',  'XpertResult',  true);
    fill('tb-hivTestResultID', tbRows(getLookupAll('HIVResultT'),            'HIVResult'),   'HIVResultID',    'HIVResult',    true);
    fill('tb-outcomeID',       tbRows(getLookupAll('OutcomeT'),              'Outcome'),     'OutcomeID',      'Outcome',      true);
    const sputumRows = tbRows(getLookupAll('SputumResultT'), 'SputumResult');
    ['tb-mon0LabResultID','tb-mon2LabResultID','tb-mon3LabResultID',
     'tb-mon5LabResultID','tb-mon6LabResultID'].forEach(id =>
      fill(id, sputumRows, 'SputumResultID', 'SputumResult', true));

    if (sex.length === 0) {
      showToast('Lookup tables empty — clearing cache. Please wait…', 'error');
      // Wipe IDB so the DB is re-seeded on next load
      await new Promise((res, rej) => {
        const req = indexedDB.deleteDatabase('PatientPWA');
        req.onsuccess = res; req.onerror = rej;
      });
      setTimeout(() => location.reload(), 1500);
    }
  } catch (err) {
    console.error('[populateDropdowns] error:', err);
    showToast(`Dropdown error: ${err.message}`, 'error');
  }
}

// ─── Form wiring (auto-calc, conditional visibility) ─────────────────────

function setupFormWiring() {
  // BMI auto-calc on registration form
  function updateBMI() {
    const w = parseFloat(weightInput?.value);
    const h = parseFloat(heightInput?.value);
    const b = calcBMI(w, h);
    if (bmiDisplay) bmiDisplay.value = b !== null ? b : '';
  }
  weightInput?.addEventListener('input', updateBMI);
  heightInput?.addEventListener('input', updateBMI);

  // BMI auto-calc on visit form
  function updateVisitBMI() {
    const w = parseFloat(document.getElementById('visitWeight')?.value);
    const h = parseFloat(document.getElementById('visitHeight')?.value);
    const b = calcBMI(w, h);
    const el = document.getElementById('visitBMI');
    if (el) el.value = b !== null ? b : '';
  }
  document.getElementById('visitWeight')?.addEventListener('input', updateVisitBMI);
  document.getElementById('visitHeight')?.addEventListener('input', updateVisitBMI);

  // Sex → show/hide PMTCT section
  sexIdSel?.addEventListener('change', () => {
    const isFemale = sexIdSel.value === '2';
    if (pmtctSection) pmtctSection.hidden = !isFemale;
  });

  // ── Age / DOB / months — Option A locking logic ──────────────────────

  /** Make age years read-only and style it like a calculated field. */
  function lockAgeYears() {
    if (!ageInput) return;
    ageInput.readOnly = true;
    ageInput.classList.add('field-readonly');
  }

  /** Restore age years to a normal editable field. */
  function unlockAgeYears() {
    if (!ageInput) return;
    ageInput.readOnly = false;
    ageInput.classList.remove('field-readonly');
  }

  /**
   * Disable the age-months field (not meaningful when age >= 1 year or when
   * DOB is set and the patient is older than 12 months).
   */
  function disableAgeMonths() {
    if (!ageMonthsInput) return;
    ageMonthsInput.value    = '';
    ageMonthsInput.disabled = true;
    ageMonthsInput.classList.add('field-readonly');
  }

  /** Make age months editable and lock-styled (DOB set, age < 1 year). */
  function lockAgeMonthsWithValue(val) {
    if (!ageMonthsInput) return;
    ageMonthsInput.value    = val;
    ageMonthsInput.disabled = false;
    ageMonthsInput.readOnly = true;
    ageMonthsInput.classList.add('field-readonly');
  }

  /** Fully unlock age months for manual entry (no DOB, age years = 0). */
  function unlockAgeMonths() {
    if (!ageMonthsInput) return;
    ageMonthsInput.disabled = false;
    ageMonthsInput.readOnly = false;
    ageMonthsInput.classList.remove('field-readonly');
  }

  /**
   * Recalculate and lock/unlock age months based on the current age-years
   * value when there is no DOB.  Call whenever age years changes manually.
   */
  function syncAgeMonthsToYears() {
    if (dobInput?.value) return;          // DOB is in charge — don't interfere
    const years = parseInt(ageInput?.value, 10);
    if (!isNaN(years) && years > 0) {
      disableAgeMonths();                 // not relevant for patients >= 1 year
    } else {
      unlockAgeMonths();                  // allow manual months entry for infants
    }
  }

  // DOB entered or cleared
  dobInput?.addEventListener('change', () => {
    // Real-time cross-field validation
    const dobErr = document.getElementById('dateOfBirth-error');
    const dobEl  = dobInput;
    if (dobErr) dobErr.textContent = '';
    dobEl.classList.remove('invalid');
    if (dobInput.value) {
      const artStart = document.getElementById('artStartDate').value;
      const enrolled = document.getElementById('dateEnrolledInCare').value;
      const msgs = [];
      if (artStart && dobInput.value > artStart)  msgs.push('ART Start Date');
      if (enrolled && dobInput.value > enrolled)  msgs.push('Date Enrolled in Care');
      if (msgs.length) {
        dobEl.classList.add('invalid');
        if (dobErr) dobErr.textContent = `Date of Birth cannot be after ${msgs.join(' or ')}.`;
      }
    }

    if (dobInput.value) {
      // ── DOB set: calculate and lock both age fields ──────────────────
      const today       = new Date();
      const dob         = new Date(dobInput.value);
      const totalMonths =
        (today.getFullYear() - dob.getFullYear()) * 12 +
        (today.getMonth()    - dob.getMonth()) +
        (today.getDate() >= dob.getDate() ? 0 : -1);
      const years = Math.floor(totalMonths / 12);

      if (ageInput) ageInput.value = Math.min(years, 99);
      lockAgeYears();

      if (years < 1) {
        lockAgeMonthsWithValue(totalMonths);  // show months for infants
      } else {
        disableAgeMonths();                   // not needed for older patients
      }
    } else {
      // ── DOB cleared: unlock everything and reset ──────────────────────
      unlockAgeYears();
      if (ageInput) ageInput.value = '';
      unlockAgeMonths();
      if (ageMonthsInput) ageMonthsInput.value = '';
    }
    updateGuardianVisibility();
  });

  // Age years typed manually (no DOB)
  ageInput?.addEventListener('input', () => {
    syncAgeMonthsToYears();
    updateGuardianVisibility();
  });

  // Age months typed manually (no DOB, only reachable when age years = 0)
  ageMonthsInput?.addEventListener('input', () => {
    const months = parseInt(ageMonthsInput.value, 10);
    if (!isNaN(months) && ageInput) {
      ageInput.value = Math.min(Math.floor(months / 12), 99);
    }
    updateGuardianVisibility();
  });

  function updateGuardianVisibility() {
    const age = parseInt(ageInput?.value, 10);
    const wrap = document.getElementById('guardian-wrap');
    if (wrap) wrap.hidden = !(age >= 0 && age < 18);
  }

  // Occupation → Other (specify)
  document.getElementById('occupationId')?.addEventListener('change', (e) => {
    document.getElementById('occupationOther-wrap').hidden = e.target.value !== '9';
  });

  // Key Population → Other (specify)
  document.getElementById('keyPopuId')?.addEventListener('change', (e) => {
    document.getElementById('keyPopuOther-wrap').hidden = e.target.value !== '4';
  });

  // Transfer In radio
  document.querySelectorAll('input[name="isTransferIn"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      document.getElementById('transferFacility-wrap').hidden = e.target.value !== '1';
    });
  });

  // Regimen reason → show 'Other' text input
  [['reg1Sub1Reason','reg1Sub1OtherWrap'],
   ['reg1Sub2Reason','reg1Sub2OtherWrap'],
   ['reg2Sub1Reason','reg2Sub1OtherWrap'],
   ['reg2Sub2Reason','reg2Sub2OtherWrap']].forEach(([reasonId, wrapId]) => {
    document.getElementById(reasonId)?.addEventListener('change', (e) => {
      const wrap = document.getElementById(wrapId);
      if (wrap) wrap.hidden = e.target.value !== '7';
    });
  });

  // INH rows
  document.getElementById('add-inh-btn')?.addEventListener('click', () => {
    const container = document.getElementById('inh-rows');
    if (container.children.length >= 6) {
      showToast('Maximum 6 INH dates allowed.', '');
      return;
    }
    const seq = container.children.length + 1;
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <div><label>Date ${seq}</label>
        <input type="date" /></div>
      <div><button type="button" class="btn btn-danger btn-sm remove-row-btn">Remove</button></div>`;
    row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
    setupDateField(row.querySelector('input[type="date"]'));
  });

  // Pregnancy rows
  document.getElementById('add-pregnancy-btn')?.addEventListener('click', () => {
    const container = document.getElementById('pregnancy-rows');
    const seq = container.children.length + 1;
    const row = document.createElement('div');
    row.className = 'dynamic-row';
    row.innerHTML = `
      <div><label>Pregnancy ${seq} — ANC No</label>
        <input type="text" class="preg-anc" maxlength="50" /></div>
      <div><label>Delivery Date</label>
        <input type="date" class="preg-del" /></div>
      <div><label class="checkbox-label">
        <input type="checkbox" class="preg-mother"> Mother received ART</label></div>
      <div><label class="checkbox-label">
        <input type="checkbox" class="preg-infant"> Infant received ARVs</label></div>
      <div><button type="button" class="btn btn-danger btn-sm remove-row-btn">Remove</button></div>`;
    row.querySelector('.remove-row-btn').addEventListener('click', () => row.remove());
    container.appendChild(row);
    setupDateField(row.querySelector('input[type="date"]'));
  });

  // Cancel edit
  document.getElementById('cancel-edit-btn')?.addEventListener('click', () => {
    exitEditMode();
    form.reset();
    _resetFormUI();
  });

  // Visits panel — close button
  document.getElementById('close-visits-btn')?.addEventListener('click', () => {
    visitsPanelEl.hidden = true;
    _currentVisitPatientTID = null;
  });

  // Visit panel — follow-up status → show stop reason
  document.getElementById('visitFollowUpStatus')?.addEventListener('change', (e) => {
    if (stopReasonRow) stopReasonRow.hidden = e.target.value !== '3'; // 3 = Stop
  });

  // Visit panel — stop reason → show other text
  document.getElementById('visitStopReason')?.addEventListener('change', (e) => {
    const wrap = document.getElementById('visitStopOtherWrap');
    if (wrap) wrap.hidden = e.target.value !== '10';
  });

  // Visit panel — visit date → auto-calc month number
  visitDateInput?.addEventListener('change', () => {
    if (!_currentVisitARTStart || !visitDateInput.value) {
      if (visitMonthDisplay) visitMonthDisplay.textContent = '';
      return;
    }
    const m = calcVisitMonth(_currentVisitARTStart, visitDateInput.value);
    const d = new Date(visitDateInput.value);
    const label = d.toLocaleString('default', { month: 'short', year: 'numeric' });
    if (visitMonthDisplay) visitMonthDisplay.textContent = `Month ${m} — ${label}`;
  });

  // Visit panel — viral load: digits only (maxlength=8), real-time > 10M highlight
  const vlInput = document.getElementById('visitViralLoad');
  vlInput?.addEventListener('keydown', (e) => {
    const nav = ['Backspace','Delete','Tab','Escape','Enter',
                 'ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'];
    if (nav.includes(e.key) || e.ctrlKey || e.metaKey) return;
    if (!/^\d$/.test(e.key)) e.preventDefault();  // digits only
  });
  vlInput?.addEventListener('input', () => {
    vlInput.value = vlInput.value.replace(/\D/g, ''); // strip any pasted non-digits
    const val = parseInt(vlInput.value, 10);
    vlInput.classList.toggle('invalid', !isNaN(val) && val > 10000000);
  });

  // Visit panel — save visit
  saveVisitBtnEl?.addEventListener('click', async () => {
    if (!_currentVisitPatientTID) return;
    const vDate = visitDateInput?.value;

    // Clear any previous date validation highlight.
    visitDateInput?.classList.remove('invalid');

    if (!vDate) {
      visitDateInput?.classList.add('invalid');
      showToast('Visit date is required.', 'error');
      return;
    }

    // Enforce date ordering among this patient's visits.
    const allVisitsSorted = getFollowUps(_currentVisitPatientTID)
      .sort((a, b) => (a.VisitDate ?? '') < (b.VisitDate ?? '') ? -1 : 1);
    if (_editingVisitTID) {
      // Edit mode: new date must sit between the preceding and following visits.
      const idx  = allVisitsSorted.findIndex(v => v.PtFollowUpTID === _editingVisitTID);
      const pred = idx > 0 ? allVisitsSorted[idx - 1].VisitDate : null;
      const succ = idx < allVisitsSorted.length - 1 ? allVisitsSorted[idx + 1].VisitDate : null;
      if (pred && vDate < pred) {
        visitDateInput.classList.add('invalid');
        showToast(`Visit date cannot be before visit on ${fmtDate(pred)}.`, 'error');
        return;
      }
      if (succ && vDate > succ) {
        visitDateInput.classList.add('invalid');
        showToast(`Visit date cannot be after visit on ${fmtDate(succ)}.`, 'error');
        return;
      }
    } else {
      // New visit: must not be before the most recent existing visit.
      if (allVisitsSorted.length > 0) {
        const latestDate = allVisitsSorted.at(-1).VisitDate;
        if (latestDate && vDate < latestDate) {
          visitDateInput.classList.add('invalid');
          showToast(`Visit date cannot be before the latest visit (${fmtDate(latestDate)}).`, 'error');
          return;
        }
      }
    }

    // Validate weight/height before building visitData.
    const vWeightEl  = document.getElementById('visitWeight');
    const vHeightEl  = document.getElementById('visitHeight');
    const vCD4El     = document.getElementById('visitCD4');
    const vCD4PctEl  = document.getElementById('visitCD4IsPercent');
    const vWeeksEl   = document.getElementById('visitWeeksInterrupted');
    const rawWeight  = parseFloat(vWeightEl?.value)  || null;
    const rawHeight  = parseFloat(vHeightEl?.value)  || null;
    const rawCD4     = parseFloat(vCD4El?.value)     || null;
    const rawWeeks   = vWeeksEl?.value !== '' ? Number(vWeeksEl?.value) : null;
    const rawVL      = parseInt(document.getElementById('visitViralLoad')?.value, 10) || null;
    const vVLEl      = document.getElementById('visitViralLoad');
    const cd4IsPct   = vCD4PctEl?.checked ?? false;
    vWeightEl?.classList.remove('invalid');
    vHeightEl?.classList.remove('invalid');
    vCD4El?.classList.remove('invalid');
    vWeeksEl?.classList.remove('invalid');
    vVLEl?.classList.remove('invalid');

    if (rawWeeks !== null && (rawWeeks < 0 || rawWeeks > 104 || !Number.isInteger(rawWeeks))) {
      vWeeksEl.classList.add('invalid');
      showToast('Weeks interrupted must be a whole number 0–104.', 'error');
      return;
    }
    if (rawWeight !== null && (rawWeight < 1 || rawWeight > 250)) {
      vWeightEl.classList.add('invalid');
      showToast('Visit weight must be 1–250 kg.', 'error');
      return;
    }
    if (rawHeight !== null && (rawHeight < 30 || rawHeight > 250)) {
      vHeightEl.classList.add('invalid');
      showToast('Visit height must be 30–250 cm.', 'error');
      return;
    }
    if (rawCD4 !== null) {
      const maxCD4  = cd4IsPct ? 100 : 3500;
      const unitLbl = cd4IsPct ? '%' : 'cells/µL';
      if (rawCD4 < 0 || rawCD4 > maxCD4) {
        vCD4El.classList.add('invalid');
        showToast(`Visit CD4 must be 0–${maxCD4} ${unitLbl}.`, 'error');
        return;
      }
    }
    if (rawVL !== null && (rawVL < 1 || rawVL > 10000000)) {
      vVLEl?.classList.add('invalid');
      showToast('Viral load must be between 1 and 10,000,000 copies/ml.', 'error');
      return;
    }

    const visitData = {
      PtDetailsTID:     _currentVisitPatientTID,
      VisitDate:        vDate,
      FollowUpStatusID: Number(document.getElementById('visitFollowUpStatus')?.value ?? 0),
      RegimenID:        Number(document.getElementById('visitRegimen')?.value ?? 0),
      TBStatusID:       Number(document.getElementById('visitTBStatus')?.value ?? 0),
      StopReasonID:     Number(document.getElementById('visitStopReason')?.value ?? 0),
      StopOtherText:    document.getElementById('visitStopOther')?.value.trim() || null,
      WeeksInterrupted: rawWeeks ?? 0,
      WeightKg:         rawWeight,
      HeightCm:         rawHeight,
      CPTDrugID:        Number(document.getElementById('visitCPTDrug')?.value ?? 0),
      CD4Value:         rawCD4,
      CD4IsPercent:     cd4IsPct ? 1 : 0,
      ViralLoad:        rawVL,
      Notes:            document.getElementById('visitNotes')?.value.trim() || null,
    };

    saveVisitBtnEl.disabled = true;
    try {
      if (_editingVisitTID) {
        await updateFollowUp(_editingVisitTID, visitData, _currentVisitARTStart);
      } else {
        await insertFollowUp(visitData, _currentVisitARTStart);
      }
      const wasEditing = !!_editingVisitTID;

      // Reset the visit form back to add-new mode.
      _editingVisitTID = null;
      const visitFormTitle = document.getElementById('visit-form-title');
      if (visitFormTitle) visitFormTitle.textContent = '+ Add / Record a Visit';
      saveVisitBtnEl.textContent = 'Save Follow-up Visit';

      ['visitDate','visitWeight','visitHeight','visitBMI','visitCD4','visitViralLoad','visitNotes','visitWeeksInterrupted']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      ['visitFollowUpStatus','visitRegimen','visitTBStatus','visitCPTDrug','visitStopReason']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = '0'; });
      document.getElementById('visitCD4IsPercent').checked = false;
      if (visitMonthDisplay) visitMonthDisplay.textContent = '';
      if (stopReasonRow) stopReasonRow.hidden = true;

      renderVisits(_currentVisitPatientTID);
      showToast(wasEditing ? 'Visit updated.' : 'Visit saved.', 'success');
      // Auto-sync in background — mirrors the same behaviour as the patient form save.
      { const _u = getUser(); await insertAuditLog({ action: wasEditing ? 'UPDATE_ART_VISIT' : 'CREATE_ART_VISIT', ptDetailsTID: _currentVisitPatientTID, notes: `${wasEditing ? 'Updated' : 'Saved'} ART follow-up visit`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }
      logSync('INFO', 'Auto-sync: visit-save', { online: navigator.onLine, hasToken: !!getToken(), syncInProgress: _syncInProgress });
      if (navigator.onLine) triggerSync(true, false, 'visit-save');
    } catch (err) {
      console.error('[App] Save visit failed:', err);
      showToast('Error saving visit.', 'error');
    } finally {
      saveVisitBtnEl.disabled = false;
    }
  });
}

// ─── Render visits for selected patient ──────────────────────────────────

function renderVisits(ptDetailsTID) {
  const visits = getFollowUps(ptDetailsTID);
  const hasRows = visits.length > 0;
  if (visitsEmptyEl) visitsEmptyEl.style.display = hasRows ? 'none' : 'block';

  if (!visitsTbody) return;
  visitsTbody.innerHTML = visits.map(v => `
    <tr>
      <td>${v.VisitMonth}</td>
      <td>${fmtDate(v.VisitDate ?? '')}</td>
      <td>${escHtml(v.FollowUpStatus ?? '')}</td>
      <td title="${escHtml(v.Regimen ?? '')}">${escHtml(v.RegimenCode ?? '')}</td>
      <td>${escHtml(v.TBStatus ?? '')}</td>
      <td>${v.CD4Value ?? ''}</td>
      <td>${v.ViralLoad || ''}</td>
      <td style="white-space:nowrap">
        ${_visitReadOnly ? '' : `<button class="btn btn-secondary btn-sm edit-visit-btn"
          data-vid="${escHtml(v.PtFollowUpTID)}"
          data-ptid="${escHtml(v.PtDetailsTID)}"
          data-vdate="${escHtml(v.VisitDate ?? '')}"
          data-statusid="${v.FollowUpStatusID ?? 0}"
          data-regimenid="${v.RegimenID ?? 0}"
          data-tbstatusid="${v.TBStatusID ?? 0}"
          data-stopreasonid="${v.StopReasonID ?? 0}"
          data-stopother="${escHtml(v.StopOtherText ?? '')}"
          data-weeksint="${v.WeeksInterrupted ?? 0}"
          data-weight="${v.WeightKg ?? ''}"
          data-height="${v.HeightCm ?? ''}"
          data-cptdrugid="${v.CPTDrugID ?? 0}"
          data-cd4="${v.CD4Value ?? ''}"
          data-cd4pct="${v.CD4IsPercent ?? 0}"
          data-viral="${v.ViralLoad || ''}"
          data-notes="${escHtml(v.Notes ?? '')}"
        >Edit</button>
        <button class="btn btn-danger btn-sm delete-visit-btn"
          data-vid="${escHtml(v.PtFollowUpTID)}"
          data-ptid="${escHtml(v.PtDetailsTID)}">Delete</button>`}
      </td>
    </tr>
  `).join('');
}

visitsTbody?.addEventListener('click', async (e) => {
  // ── Edit visit ───────────────────────────────────────────────────────
  const editBtn = e.target.closest('.edit-visit-btn');
  if (editBtn) {
    const d = editBtn.dataset;
    _editingVisitTID = d.vid;

    // Populate every field in the visit form from the button's data attributes.
    const setVal = (id, val) => { const el = document.getElementById(id); if (el) el.value = val ?? ''; };
    setVal('visitDate',             d.vdate);
    setVal('visitFollowUpStatus',   d.statusid);
    setVal('visitRegimen',          d.regimenid);
    setVal('visitTBStatus',         d.tbstatusid);
    setVal('visitStopReason',       d.stopreasonid);
    setVal('visitStopOther',        d.stopother);
    setVal('visitWeeksInterrupted', d.weeksint);
    setVal('visitWeight',           d.weight);
    setVal('visitHeight',           d.height);
    setVal('visitCPTDrug',          d.cptdrugid);
    setVal('visitCD4',              d.cd4);
    setVal('visitViralLoad',        d.viral);
    setVal('visitNotes',            d.notes);
    const cd4PctEl = document.getElementById('visitCD4IsPercent');
    if (cd4PctEl) cd4PctEl.checked = d.cd4pct === '1';

    // Trigger dependent UI (stop reason row, BMI, month display).
    document.getElementById('visitFollowUpStatus')?.dispatchEvent(new Event('change'));
    document.getElementById('visitStopReason')?.dispatchEvent(new Event('change'));
    visitDateInput?.dispatchEvent(new Event('change'));
    document.getElementById('visitHeight')?.dispatchEvent(new Event('input'));

    // Switch form title and button to edit mode.
    const visitFormTitle = document.getElementById('visit-form-title');
    if (visitFormTitle) visitFormTitle.textContent = 'Edit Visit';
    if (saveVisitBtnEl) saveVisitBtnEl.textContent = 'Update Follow-up Visit';

    // Expand the add/edit panel and scroll it into view.
    const details = document.querySelector('#visits-panel details.form-section');
    if (details) {
      details.open = true;
      details.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    return;
  }

  // ── Delete visit ─────────────────────────────────────────────────────
  const btn = e.target.closest('.delete-visit-btn');
  if (!btn) return;

  showDeleteConfirm('Delete this visit record? This cannot be undone.', async () => {
    try {
      await deleteVisit(btn.dataset.vid);
      renderVisits(btn.dataset.ptid);
      showToast('Visit deleted.', 'success');
    } catch (err) {
      showToast('Could not delete visit.', 'error');
    }
  });
});

// ─── Select Colour Sync ──────────────────────────────────────────────────

/**
 * Keeps select elements visually consistent with text-input placeholders:
 * muted colour when showing "-- Select --" (value 0), full colour when a
 * real option is chosen.  Call once after dropdowns are populated.
 */
function initSelectColours() {
  function syncSelect(sel) {
    sel.classList.toggle('select-has-value', sel.value !== '0' && sel.value !== '');
  }
  document.querySelectorAll('select').forEach(sel => {
    syncSelect(sel);
    sel.addEventListener('change', () => syncSelect(sel));
  });
}

/**
 * Re-syncs select and date-input colour classes after the form is populated
 * programmatically (no change event fires when setting .value directly).
 * Pass a container element to scope to one form, or omit for whole document.
 */
function refreshFormColours(container) {
  const root = container || document;
  root.querySelectorAll('select').forEach(sel => {
    sel.classList.toggle('select-has-value', sel.value !== '0' && sel.value !== '');
  });
  root.querySelectorAll('input[type="date"], input[type="month"]').forEach(inp => {
    const hasValue = !!inp.value;
    inp.classList.toggle('date-has-value', hasValue);
    // Set inline style so the colour updates even when the browser's date-input
    // shadow DOM does not repaint in response to a CSS class change alone.
    inp.style.color      = hasValue ? '#0000F0' : '';
    inp.style.fontWeight = '';
  });
}

// ─── Date Field Setup ────────────────────────────────────────────────────

/**
 * Configures a single date/month input so that:
 *  1. Future dates are blocked (max = today / current month).
 *  2. The user can only pick via the date-picker dialog — keyboard typing is
 *     blocked.  Delete/Backspace still clear the field.
 *  3. Clicking anywhere on the input opens the picker immediately.
 *  4. A clear (×) button is injected next to the input.
 */
function setupDateField(input) {
  const isMonth = input.type === 'month';
  const today   = new Date();
  const yyyy    = today.getFullYear();
  const mm      = String(today.getMonth() + 1).padStart(2, '0');
  const dd      = String(today.getDate()).padStart(2, '0');

  // 1. Cap at today — no future dates
  input.max = isMonth ? `${yyyy}-${mm}` : `${yyyy}-${mm}-${dd}`;

  // 2. Block keyboard input (typing) but allow Tab, Escape, Delete, Backspace
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' || e.key === 'Escape') return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      input.value = '';
      syncClearBtn();
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    e.preventDefault();
  });

  // 3. Open picker immediately on click
  input.addEventListener('click', () => {
    try { input.showPicker(); } catch (_) { /* unsupported browser — native click suffices */ }
  });

  // Wrap the input in a flex container so we can position the clear button
  const wrap = document.createElement('div');
  wrap.className = 'date-input-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);

  // 4. Inject the clear button
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.className = 'date-clear-btn';
  clearBtn.setAttribute('aria-label', 'Clear date');
  clearBtn.setAttribute('title', 'Clear');
  clearBtn.textContent = '×';
  wrap.appendChild(clearBtn);

  function syncClearBtn() {
    clearBtn.hidden = !input.value;
  }
  syncClearBtn(); // set initial state

  // Keep text colour in sync: muted when empty (looks like placeholder),
  // full colour when a value is present.
  // Inline style is set in addition to the CSS class because Chrome's shadow-DOM
  // rendering of date inputs does not always repaint when only a class changes.
  function syncDateColour() {
    const hasValue = !!input.value;
    input.classList.toggle('date-has-value', hasValue);
    input.style.color      = hasValue ? '#0000F0' : '';
    input.style.fontWeight = '';
  }
  syncDateColour();

  input.addEventListener('change', () => { syncClearBtn(); syncDateColour(); });
  input.addEventListener('input',  () => { syncClearBtn(); syncDateColour(); });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    syncClearBtn();
    syncDateColour();
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('input',  { bubbles: true }));
  });
}

/**
 * Initialise every date/month input currently in the DOM.
 * Call once during bootstrap; call setupDateField() individually for any
 * inputs created dynamically afterward.
 */
function initDateFields() {
  document.querySelectorAll('input[type="date"], input[type="month"]')
    .forEach(setupDateField);
}

// ─── Duplicate detection ──────────────────────────────────────────────────

/**
 * Show or clear an inline duplicate-patient warning beneath a form field.
 * @param {string} anchorId - ID of the input whose parent receives the warning.
 * @param {string} warnId   - Stable element ID for the warning div.
 * @param {string} html     - Warning inner HTML, or '' to remove.
 */
function _showDupWarning(anchorId, warnId, html) {
  let el = document.getElementById(warnId);
  if (!html) { if (el) el.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id        = warnId;
    el.className = 'dup-warning';
    el.style.cssText =
      'background:#fff3cd;color:#856404;border:1px solid #ffc107;' +
      'border-radius:6px;padding:0.4rem 0.7rem;font-size:0.82rem;margin-top:0.3rem;';
    const anchor = document.getElementById(anchorId)?.closest('.date-input-wrap')?.parentElement
                ?? document.getElementById(anchorId)?.parentElement;
    if (anchor) anchor.appendChild(el);
  }
  el.innerHTML = html;
}

/** Build warning HTML for a duplicate patient record. */
function _dupHtml(pt, prefix = '\u26a0\ufe0f') {
  const when = pt.ARTStartDate ? ` &nbsp;\u2022 ART start: ${fmtDate(pt.ARTStartDate)}` : '';
  return `${prefix} <strong>Possible duplicate:</strong> ${escHtml(pt.PtName || '')}, ` +
         `Age&nbsp;${pt.Age}, ${escHtml(pt.Sex || '')} &mdash; ART No.&nbsp;<strong>${escHtml(pt.ARTNo || '')}</strong>${when}`;
}

/**
 * Initialise real-time duplicate detection on the patient-entry form.
 * Checks local SQLite immediately (works offline).
 * When online, also queries the server to catch cross-device duplicates.
 *
 * Warnings are advisory only — they do NOT block form submission.
 */
function initDuplicateDetection() {
  const artNoInput  = document.getElementById('artNo');
  const fullNameInp = document.getElementById('fullName');

  const ART_WARN  = 'dup-warn-artno';
  const NAME_WARN = 'dup-warn-name';
  let   _nameTimer = null;

  // ── ART No check ─────────────────────────────────────────────────────
  async function checkARTNo() {
    const artNo = artNoInput?.value.trim();
    _showDupWarning('artNo', ART_WARN, '');
    if (!artNo) return;

    const local = checkDuplicateARTNo(artNo, _editingTID);
    if (local) { _showDupWarning('artNo', ART_WARN, _dupHtml(local)); return; }

    if (!navigator.onLine) return;
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetch(
        `${API_BASE}/patients/check-duplicate?artNo=${encodeURIComponent(artNo)}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return;
      const data    = await res.json();
      const matches = (data.artNoMatches ?? []).filter(m => m.PtDetailsTID?.toLowerCase() !== _editingTID?.toLowerCase());
      if (matches.length) {
        _showDupWarning('artNo', ART_WARN,
          _dupHtml(matches[0], '\uD83C\uDF10\u26a0\ufe0f') + ' <em>(on the eTBr server)</em>');
      }
    } catch { /* network error — ignore */ }
  }

  artNoInput?.addEventListener('blur',   checkARTNo);
  artNoInput?.addEventListener('change', checkARTNo);
  artNoInput?.addEventListener('input',  () => _showDupWarning('artNo', ART_WARN, ''));

  // ── Name + Age + Sex check (debounced) ───────────────────────────────
  async function checkNameDemographics() {
    const name  = fullNameInp?.value.trim();
    const age   = parseInt(ageInput?.value, 10);
    const sexId = parseInt(sexIdSel?.value, 10);
    _showDupWarning('fullName', NAME_WARN, '');
    if (!name || isNaN(age) || age < 0 || isNaN(sexId) || sexId <= 0) return;

    const locals = checkDuplicateName(name, age, sexId, _editingTID);
    if (locals.length) { _showDupWarning('fullName', NAME_WARN, _dupHtml(locals[0])); return; }

    if (!navigator.onLine) return;
    const token = getToken();
    if (!token) return;
    const facId = _selectedFacility?.id || 0;
    try {
      const qs = new URLSearchParams({ name, age, sexId });
      if (facId > 0) qs.set('facilityId', facId);
      const res = await fetch(
        `${API_BASE}/patients/check-duplicate?${qs}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (!res.ok) return;
      const data    = await res.json();
      const matches = (data.nameMatches ?? []).filter(m => m.PtDetailsTID?.toLowerCase() !== _editingTID?.toLowerCase());
      if (matches.length) {
        _showDupWarning('fullName', NAME_WARN,
          _dupHtml(matches[0], '\uD83C\uDF10\u26a0\ufe0f') + ' <em>(on the eTBr server)</em>');
      }
    } catch { /* ignore */ }
  }

  function _scheduleNameCheck() {
    clearTimeout(_nameTimer);
    _nameTimer = setTimeout(checkNameDemographics, 600);
  }

  fullNameInp?.addEventListener('blur',   checkNameDemographics);
  fullNameInp?.addEventListener('input',  () => {
    _showDupWarning('fullName', NAME_WARN, '');
    _scheduleNameCheck();
  });
  ageInput?.addEventListener('change',  _scheduleNameCheck);
  sexIdSel?.addEventListener('change',  _scheduleNameCheck);

  // Clear warnings on form reset
  form?.addEventListener('reset', () => {
    _showDupWarning('artNo',    ART_WARN,  '');
    _showDupWarning('fullName', NAME_WARN, '');
  });
}

// ─── Input Character Filters ─────────────────────────────────────────────

/**
 * Restrict a text <input> or <textarea> so that only characters matching
 * `charRegex` can be entered. Covers keyboard typing, paste, and autofill.
 *
 * @param {HTMLElement|null} el        - The input / textarea element.
 * @param {RegExp}           charRegex - Regex that matches ONE allowed character.
 */
function _filterTextInput(el, charRegex) {
  if (!el) return;

  function clean() {
    const cur = el.value;
    const filtered = [...cur].filter(ch => charRegex.test(ch)).join('');
    if (filtered !== cur) {
      const pos = el.selectionStart ?? cur.length;
      el.value = filtered;
      const newPos = Math.max(0, pos - (cur.length - filtered.length));
      try { el.setSelectionRange(newPos, newPos); } catch (_) {}
    }
  }

  el.addEventListener('input', clean);
  el.addEventListener('keydown', e => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    // Let control / navigation keys through
    if (e.key.length !== 1) return;
    if (!charRegex.test(e.key)) e.preventDefault();
  });
}

/**
 * Block specific unwanted keys on a <input type="number"> field and prevent
 * paste of those characters. Browsers allow 'e'/'E'/'+' in number inputs by
 * default (scientific notation) — this closes that loophole.
 *
 * @param {HTMLElement|null} el          - The number input element.
 * @param {...string}        blockedKeys - Key values to block (e.g. 'e','E','+','-','.').
 */
function _filterNumberInput(el, ...blockedKeys) {
  if (!el) return;
  const blocked = new Set(blockedKeys);
  el.addEventListener('keydown', e => {
    if (blocked.has(e.key)) e.preventDefault();
  });
  el.addEventListener('paste', e => {
    const text = (e.clipboardData || window.clipboardData).getData('text');
    if ([...text].some(ch => blocked.has(ch))) e.preventDefault();
  });
}

/**
 * Attach all input-character filters for the patient registration and
 * visit forms. Call once after the DOM is ready.
 */
function initInputFilters() {
  const get = id => document.getElementById(id);

  // ── Text fields ──────────────────────────────────────────────────────
  // ART Number: digits, letters, slash (/), dash (-)
  _filterTextInput(get('artNo'),            /[a-zA-Z0-9/\-]/);

  // Full Patient Name: letters and spaces only
  _filterTextInput(get('fullName'),         /[a-zA-Z ]/);

  // Phone contacts: digits only
  _filterTextInput(get('phone1'),           /[0-9]/);
  _filterTextInput(get('phone2'),           /[0-9]/);

  // Residence Address: letters, digits, space, comma, period, dash
  _filterTextInput(get('residenceAddress'), /[a-zA-Z0-9 ,.\-]/);

  // Unit TB Reg Number: digits, letters, slash (/), dash (-)
  _filterTextInput(get('unitTBNo'),         /[a-zA-Z0-9/\-]/);

  // TB address fields: letters, digits, space, comma, period, dash (no apostrophe)
  const tbAddrRegex = /[a-zA-Z0-9 ,.\-]/;
  _filterTextInput(get('tb-village'),  tbAddrRegex);
  _filterTextInput(get('tb-boma'),     tbAddrRegex);
  _filterTextInput(get('tb-payam'),    tbAddrRegex);
  _filterTextInput(get('tb-county'),   tbAddrRegex);
  _filterTextInput(get('tb-tihf'),     tbAddrRegex);
  _filterTextInput(get('tb-tiCounty'), tbAddrRegex);
  _filterTextInput(get('tb-tohf'),     tbAddrRegex);
  _filterTextInput(get('tb-toCounty'), tbAddrRegex);

  // TB Phone: digits only (10-digit format enforced on validation)
  _filterTextInput(get('tb-ptPhone'),  /[0-9]/);

  // TB patient name: letters and spaces only
  _filterTextInput(get('tb-ptName'),   /[a-zA-Z ]/);

  // TB Unit TB No: letters, digits, slash, dash
  _filterTextInput(get('tb-unitTBNo'), /[a-zA-Z0-9/\-]/);

  // TB lab numbers: letters, digits, slash, dash
  const tbLabRegex = /[a-zA-Z0-9/\-]/;
  _filterTextInput(get('tb-mon0LabNo'), tbLabRegex);
  _filterTextInput(get('tb-mon2LabNo'), tbLabRegex);
  _filterTextInput(get('tb-mon3LabNo'), tbLabRegex);
  _filterTextInput(get('tb-mon5LabNo'), tbLabRegex);
  _filterTextInput(get('tb-mon6LabNo'), tbLabRegex);

  // TB DST result: letters, digits, space, period, comma, dash
  _filterTextInput(get('tb-dstResult'), /[a-zA-Z0-9 ,.\-]/);

  // TB Remarks: letters, digits, space, period, comma, dash, slash
  _filterTextInput(get('tb-remarks'), /[a-zA-Z0-9 ,.\-/]/);

  // TB age in months: integer only
  _filterNumberInput(get('tb-ageMonths'), 'e', 'E', '+', '-', '.');

  // Visit Notes: alphanumeric, space, slash, dash, period, comma
  _filterTextInput(get('visitNotes'),       /[a-zA-Z0-9 /\-.,]/);

  // ── Number fields — block scientific-notation keys ───────────────────
  // Integer-only (age, age in months): also block decimal point
  _filterNumberInput(get('age'),                  'e', 'E', '+', '-', '.');
  _filterNumberInput(get('ageMonths'),            'e', 'E', '+', '-', '.');
  _filterNumberInput(get('visitWeeksInterrupted'),'e', 'E', '+', '-', '.');

  // Decimal-allowed (measurements, CD4): block e/E/+ only; - already blocked by min="0"
  _filterNumberInput(get('weightKg'),    'e', 'E', '+', '-');
  _filterNumberInput(get('heightCm'),    'e', 'E', '+', '-');
  _filterNumberInput(get('muacCm'),      'e', 'E', '+', '-');
  _filterNumberInput(get('cd4Value'),    'e', 'E', '+', '-');
  _filterNumberInput(get('visitWeight'), 'e', 'E', '+', '-');
  _filterNumberInput(get('visitHeight'), 'e', 'E', '+', '-');
  _filterNumberInput(get('visitCD4'),    'e', 'E', '+', '-');
}

// ─── Bootstrap ───────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
//  AUTH MODULE
//  Handles JWT storage, login / register / forgot-password / reset-password.
// ═══════════════════════════════════════════════════════════════════════════

// localStorage keys
const AUTH_TOKEN_KEY  = 'art.token';
const AUTH_EXPIRY_KEY = 'art.expiry';
const AUTH_USER_KEY   = 'art.user';

// ── Auth DOM refs ────────────────────────────────────────────────────────
const authScreen      = document.getElementById('auth-screen');
const appScreen       = document.getElementById('app-screen');
const userInfoBar     = document.getElementById('user-info-bar');
const userNameDisplay = document.getElementById('user-name-display');
const logoutBtn       = document.getElementById('logout-btn');

const loginPanel      = document.getElementById('auth-login-panel');
const registerPanel   = document.getElementById('auth-register-panel');
const forgotPanel     = document.getElementById('auth-forgot-panel');
const resetPanel      = document.getElementById('auth-reset-panel');
const offlinePinPanel = document.getElementById('auth-offline-pin-panel');
const enrollPinPanel  = document.getElementById('auth-enroll-pin-panel');

const loginForm       = document.getElementById('login-form');
const loginError      = document.getElementById('login-error');
const loginSuccess    = document.getElementById('login-success');
const loginBtnEl      = document.getElementById('login-btn');

const registerForm    = document.getElementById('register-form');
const registerError   = document.getElementById('register-error');
const registerSuccess = document.getElementById('register-success');

const forgotForm      = document.getElementById('forgot-form');
const forgotMsg       = document.getElementById('forgot-msg');

const resetForm       = document.getElementById('reset-form');
const resetMsg        = document.getElementById('reset-msg');

// ── Auth helpers ─────────────────────────────────────────────────────────

function getToken() {
  const token  = localStorage.getItem(AUTH_TOKEN_KEY);
  const expiry = localStorage.getItem(AUTH_EXPIRY_KEY);
  if (!token || !expiry) return null;
  if (new Date() >= new Date(expiry)) {
    // When offline, keep credentials so the offline PIN panel can show the user name
    if (navigator.onLine) clearAuth();
    return null;
  }
  return token;
}

function getUser() {
  const s = localStorage.getItem(AUTH_USER_KEY);
  try { return s ? JSON.parse(s) : null; } catch { return null; }
}

function saveAuth(resp) {
  localStorage.setItem(AUTH_TOKEN_KEY,  resp.token);
  localStorage.setItem(AUTH_EXPIRY_KEY, resp.expiresAt);
  localStorage.setItem(AUTH_USER_KEY,   JSON.stringify({
    userID:       resp.userID,
    userTID:      resp.userTID,
    userName:     resp.userName,
    fullName:     resp.fullName,
    emailAddress: resp.emailAddress,
    dataSourceID: resp.dataSourceID,
    groupID:      resp.groupID,
    countyID:     resp.countyID,
    stateID:      resp.stateID,
    countryID:    resp.countryID,
    locationID:   resp.locationID,
    subRecID:     resp.subRecID,
    ngoName:      resp.ngoName,
    dtls:         resp.dtls,
    zonal:        resp.zonal,
    ntp:          resp.ntp,
    ngo:          resp.ngo,
    adminID:      resp.adminID,
    superUserID:  resp.superUserID,
    roles:        resp.roles,
  }));
}

function clearAuth() {
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EXPIRY_KEY);
  localStorage.removeItem(AUTH_USER_KEY);
  // Clear pull timestamps so the next login always does a full pull.
  localStorage.removeItem('art.lastArtPullAt');
  localStorage.removeItem('art.lastTbPullAt');
}

// ─── Offline session flag ────────────────────────────────────────────────
// Stored in sessionStorage so it is automatically cleared when the tab closes.
const OFFLINE_SESSION_KEY = 'art.offlineSession';

function isOfflineSession() {
  return sessionStorage.getItem(OFFLINE_SESSION_KEY) === '1';
}

function setOfflineSession(flag) {
  if (flag) sessionStorage.setItem(OFFLINE_SESSION_KEY, '1');
  else      sessionStorage.removeItem(OFFLINE_SESSION_KEY);
}

// ─── Offline PIN: WebCrypto PBKDF2 helpers ───────────────────────────────
// Uses the built-in SubtleCrypto API — no external dependency, works offline.
const PIN_ITERATIONS = 200_000;
const PIN_HASH_BITS  = 256;

function _b64(bytes)  { return btoa(String.fromCharCode(...bytes)); }
function _unb64(str)  { return Uint8Array.from(atob(str), c => c.charCodeAt(0)); }

async function _pbkdf2Derive(pin, saltBytes) {
  const enc         = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: PIN_ITERATIONS },
    keyMaterial, PIN_HASH_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Hashes a PIN and stores the credential in IndexedDB.
 * @param {string} pin  — exactly 6 digits
 */
async function enrollOfflinePin(pin) {
  const user = getUser();
  if (!user) throw new Error('Not logged in');
  const salt  = crypto.getRandomValues(new Uint8Array(16));
  const hash  = await _pbkdf2Derive(pin, salt);
  await saveOfflinePin({
    hash:        _b64(hash),
    salt:        _b64(salt),
    iterations:  PIN_ITERATIONS,
    failCount:   0,
    lockedUntil: null,
    userTID:     user.userTID,
    userName:    user.userName,
    userProfile: user,   // full profile stored so offline session works after logout
  });
}

/**
 * Verifies an entered PIN against the stored credential.
 * Increments the fail counter; after 5 failures the credential is wiped
 * and the user must log in online again.
 *
 * @param {string} pin
 * @returns {Promise<'ok'|'wrong'|'locked'|'wiped'>}
 */
async function attemptOfflinePinLogin(pin) {
  const stored = await loadOfflinePin();
  if (!stored) return 'wiped';

  // Check lockout
  if (stored.lockedUntil && Date.now() < stored.lockedUntil) return 'locked';

  const hash  = await _pbkdf2Derive(pin, _unb64(stored.salt));
  const match = _b64(hash) === stored.hash;

  if (match) {
    // Reset fail counter on success
    await saveOfflinePin({ ...stored, failCount: 0, lockedUntil: null });
    // Restore user profile to localStorage if it was cleared (e.g. after logout)
    if (!getUser() && stored.userProfile) {
      localStorage.setItem(AUTH_USER_KEY, JSON.stringify(stored.userProfile));
    }
    return 'ok';
  }

  const newFail = (stored.failCount ?? 0) + 1;
  if (newFail >= 5) {
    // Too many wrong attempts — wipe the PIN; user must authenticate online
    await clearOfflinePin();
    return 'wiped';
  }

  await saveOfflinePin({ ...stored, failCount: newFail });
  return 'wrong';
}

/**
 * After a successful online login, prompt the user to enroll an offline PIN
 * if they do not already have one.
 */
async function _checkPinEnrollment() {
  console.log('[PIN] _checkPinEnrollment: start');
  try {
    const user    = getUser();
    console.log('[PIN] getUser:', user ? `${user.userName} (${user.userTID})` : 'null');
    const pinData = await loadOfflinePin();
    console.log('[PIN] loadOfflinePin returned:', pinData);
    if (pinData && user && pinData.userTID === user.userTID) {
      console.log('[PIN] PIN already enrolled — going to app');
      // Already enrolled — go straight to the app
      showAppScreen();
      return;
    }
    console.log('[PIN] No PIN enrolled — showing enroll panel');
    // No PIN yet — show the enrollment panel as a full auth-screen step
    authScreen.hidden  = false;
    appScreen.hidden   = true;
    userInfoBar.hidden = true;
    _showPanel('enroll-pin');
    const subtitleEl = document.getElementById('enroll-pin-subtitle');
    if (subtitleEl) {
      subtitleEl.textContent =
        `Welcome, ${user?.fullName ?? user?.userName ?? 'user'}! Set a PIN for offline access.`;
    }
    document.querySelectorAll(
      '#pin-enroll-group .otp-digit, #pin-enroll-confirm-group .otp-digit'
    ).forEach(d => { d.value = ''; d.classList.remove('otp-filled'); });
    const errEl = document.getElementById('pin-enroll-error');
    if (errEl) errEl.hidden = true;
    console.log('[PIN] enroll panel shown. enrollPinPanel.hidden =', enrollPinPanel?.hidden);
    setTimeout(() => document.querySelector('#pin-enroll-group .otp-digit')?.focus(), 100);
  } catch (err) {
    console.error('[PIN] _checkPinEnrollment ERROR:', err);
    showAppScreen(); // graceful fallback
  }
}

/**
 * Show the amber banner prompting re-authentication when the device comes
 * back online while an offline session is active.
 */
function _showReauthBanner() {
  let banner = document.getElementById('reauth-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'reauth-banner';
    banner.style.cssText =
      'position:fixed;top:0;left:0;right:0;z-index:9999;' +
      'background:#f59e0b;color:#1a1a1a;text-align:center;' +
      'padding:0.6rem 1rem;font-size:0.9rem;font-weight:500;cursor:pointer;';
    banner.innerHTML =
      'You\'re back online. ' +
      '<strong>Tap here to sign in and sync your data.</strong>';
    banner.addEventListener('click', () => {
      setOfflineSession(false);
      clearAuth();
      banner.hidden = true;
      showAuthScreen();
    });
    document.body.prepend(banner);
  }
  banner.hidden = false;
  updateSyncButtonState();
}

/**
 * Returns true when the logged-in user is allowed to create, edit and delete
 * patient records.  Read-only users (MoH coordinators, NTP observers) can
 * browse data but cannot make changes.
 *
 * Write access rules:
 *   - Facility staff (dataSourceID > 0)          → always writable
 *   - NGO at state level  (ngo && zonal)          → writable
 *   - NGO at county level (ngo && dtls)           → writable
 *   - All other roles (NTP, Zonal MoH, DTLS MoH) → read-only
 */
function userCanWrite() {
  const user = getUser();
  if (!user) return false;
  if (user.dataSourceID > 0)               return true;   // facility staff
  if (user.ngo && (user.zonal || user.dtls)) return true; // NGO field staff
  return false;
}

function applyReadOnlyMode() {
  const banner = document.getElementById('no-access-banner');
  if (banner) banner.hidden = false;

  // Disable every input/select/textarea in the patient form
  const form = document.getElementById('patient-form');
  if (form) {
    form.querySelectorAll('input, select, textarea').forEach(el => { el.disabled = true; });
  }

  // Hide Save/Update and Sync buttons — nothing can be submitted
  if (submitBtn) submitBtn.hidden = true;
  if (syncBtn)   syncBtn.hidden   = true;

  // Hide the new-patient form card entirely for read-only users
  const newPatientCard = document.getElementById('patient-form')?.closest('.card');
  if (newPatientCard) newPatientCard.hidden = true;
}

// ─── Dashboard screen references ─────────────────────────────────────────
const dashboardScreen     = document.getElementById('dashboard-screen');
const artRegisterScreen   = document.getElementById('art-register-screen');

/**
 * Updates the three stat tiles on the dashboard welcome banner.
 * Safe to call any time after the DB is initialised.
 */
function updateDashboardStats() {
  try {
    const pending  = getAllPtDetailsForSync().length + getAllPtDetailsTBForSync().length;
    const lastSyncART = localStorage.getItem('art.lastSync');
    const lastSyncTB  = localStorage.getItem('tb.lastSync');
    const lastSync = (!lastSyncART && !lastSyncTB) ? null
                   : !lastSyncART ? lastSyncTB
                   : !lastSyncTB  ? lastSyncART
                   : (new Date(lastSyncART) > new Date(lastSyncTB) ? lastSyncART : lastSyncTB);

    const elPts   = document.getElementById('db-stat-patients');
    const elTbPts = document.getElementById('db-stat-tb-patients');
    const elPend  = document.getElementById('db-stat-pending');
    const elSync  = document.getElementById('db-stat-lastsync');

    // Show local counts immediately as a fallback while the server responds
    if (elPts)   elPts.textContent   = getAllPtDetails().length.toLocaleString();
    if (elTbPts) elTbPts.textContent = getAllPtDetailsTB().length.toLocaleString();
    if (elPend)  elPend.textContent  = pending.toLocaleString();
    if (elSync) {
      if (lastSync) {
        const diff = Math.round((Date.now() - new Date(lastSync)) / 60000); // minutes
        elSync.textContent = diff < 1    ? 'Just now'
                           : diff < 60   ? `${diff}m ago`
                           : diff < 1440 ? `${Math.round(diff/60)}h ago`
                           : `${Math.round(diff/1440)}d ago`;
      } else {
        elSync.textContent = 'Never';
      }
    }
  } catch { /* DB not ready yet — stats will be refreshed on next call */ }

  // Overlay server-side counts (authoritative, scope-filtered) when online
  if (navigator.onLine && getToken()) {
    const token = getToken();
    fetch(`${API_BASE}/reports/dashboard-counts`, {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return;
        const elPts   = document.getElementById('db-stat-patients');
        const elTbPts = document.getElementById('db-stat-tb-patients');
        if (data.artCount != null && elPts)   elPts.textContent   = Number(data.artCount).toLocaleString();
        if (data.tbCount  != null && elTbPts) elTbPts.textContent = Number(data.tbCount).toLocaleString();
      })
      .catch(() => { /* offline or error — keep local counts */ });
  }
}

/** Navigate to the dashboard, hiding any open register screen. */
function showDashboard() {
  _unlockOrientation();
  if (dashboardScreen)     dashboardScreen.hidden     = false;
  if (artRegisterScreen)   artRegisterScreen.hidden   = true;
  if (tbMonitoringScreen)  tbMonitoringScreen.hidden  = true;
  if (tbQualityScreen)     tbQualityScreen.hidden     = true;
  const psScreen = document.getElementById('patient-search-screen');
  if (psScreen)            psScreen.hidden            = true;
  updateDashboardStats();
  // Load pending approvals, active user list and active sessions for SuperUsers/Admins
  loadPendingApprovals();
  loadActiveUsers();
  loadActiveSessions();
  // Scroll to top so the welcome banner is visible
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ─── User Approval Panel ─────────────────────────────────────────────────

/**
 * Loads and renders the pending user approvals panel.
 * Only shown to users with SuperUser or Admin role.
 * Scoped by the server to the approver's own organisation (SubRecID).
 */
async function loadPendingApprovals() {
  const user = getUser();

  // Only Super Users and Admins can approve accounts
  const canApprove = user && (user.superUserID === 1 || user.adminID === 1);
  if (!canApprove) return;

  const token = getToken();
  if (!token || !navigator.onLine) return;

  const loadingEl = document.getElementById('approval-loading');
  const emptyEl   = document.getElementById('approval-empty');
  const tableWrap = document.getElementById('approval-table-wrap');
  const badge     = document.getElementById('approval-badge');

  if (loadingEl) loadingEl.hidden = false;
  if (emptyEl)   emptyEl.hidden   = true;
  if (tableWrap) tableWrap.hidden = true;
  if (badge)     badge.hidden     = true;

  try {
    const res = await fetch(`${API_BASE}/auth/pending`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }

    if (!res.ok) {
      if (loadingEl) loadingEl.hidden = true;
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'Could not load pending accounts.'; }
      return;
    }

    const users = await res.json();
    if (loadingEl) loadingEl.hidden = true;

    if (!users.length) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'No pending accounts awaiting approval.'; }
      return;
    }

    if (emptyEl)   emptyEl.hidden = true;
    if (tableWrap) tableWrap.hidden = false;
    if (badge) {
      badge.hidden = false;
      badge.textContent = `${users.length} pending`;
    }

    const tbody = document.getElementById('approval-tbody');
    if (!tbody) return;

    tbody.innerHTML = users.map(u => {
      const name     = escHtml(u.FullName   ?? '');
      const uname    = escHtml(u.UserName   ?? '');
      const email    = escHtml(u.EmailAddress ?? '');
      const phone    = escHtml(u.PhoneNo    ?? '—');
      const org      = u.NGO ? escHtml(u.SubRec ?? 'NGO') : 'NTP / MoH';
      const regDate  = u.CreatedAt ? fmtDate(u.CreatedAt.toString().slice(0, 10)) : '—';
      const tid      = escHtml(u.UserTID ?? '');
      return `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:0.5rem 0.75rem;font-weight:500">${name}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${uname}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${email}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${phone}</td>
        <td style="padding:0.5rem 0.75rem">
          <span style="background:${u.NGO ? '#fef3c7' : '#dbeafe'};color:${u.NGO ? '#92400e' : '#1e40af'};
                       padding:2px 8px;border-radius:99px;font-size:0.78rem;font-weight:600">${org}</span>
        </td>
        <td style="padding:0.5rem 0.75rem;color:#6b7280;white-space:nowrap">${regDate}</td>
        <td style="padding:0.5rem 0.75rem;white-space:nowrap">
          <button class="btn btn-sm approval-approve-btn" data-tid="${tid}" data-name="${name}"
                  style="background:#059669;color:#fff;border:none;padding:4px 12px;border-radius:5px;margin-right:4px">
            Approve
          </button>
          <button class="btn btn-sm approval-reject-btn" data-tid="${tid}" data-name="${name}"
                  style="background:#dc2626;color:#fff;border:none;padding:4px 12px;border-radius:5px">
            Reject
          </button>
        </td>
      </tr>`;
    }).join('');

    // Event delegation for approve / reject buttons
    tbody.querySelectorAll('.approval-approve-btn').forEach(btn => {
      btn.addEventListener('click', () => _handleApproval(btn.dataset.tid, btn.dataset.name, 'approve'));
    });
    tbody.querySelectorAll('.approval-reject-btn').forEach(btn => {
      btn.addEventListener('click', () => _handleApproval(btn.dataset.tid, btn.dataset.name, 'reject'));
    });

  } catch (err) {
    console.warn('[Approvals] Failed to load pending users:', err);
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl)   { emptyEl.hidden = false; emptyEl.textContent = 'Could not load pending accounts.'; }
  }
}

/**
 * Sends an approve or reject request for a pending user, then refreshes the panel.
 * @param {string} userTID  - GUID of the pending user.
 * @param {string} name     - Display name (for confirmation message).
 * @param {'approve'|'reject'} action
 */
async function _handleApproval(userTID, name, action) {
  const label  = action === 'approve' ? 'approve' : 'reject';
  const verb   = action === 'approve' ? 'Approve' : 'Reject';

  const confirmed = await showGenericConfirmModal(
    `${verb} Account`,
    `${verb} the account for <strong>${name}</strong>?${action === 'approve'
      ? '<br><br>They will receive an email and can sign in immediately.'
      : '<br><br>They will be notified by email that their registration was not approved.'}`,
    verb
  );
  if (!confirmed) return;

  const token = getToken();
  if (!token) { showToast('Session expired. Please sign in again.', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/auth/${label}/${encodeURIComponent(userTID)}`, {
      method:  'POST',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      showToast(data.error ?? `Failed to ${label} account.`, 'error');
      return;
    }

    showToast(
      action === 'approve'
        ? `Account for ${name} approved. They have been notified by email.`
        : `Account for ${name} rejected.`,
      'success'
    );

    // Refresh both panels — an approval moves a user from pending → active
    await loadPendingApprovals();
    await loadActiveUsers();

  } catch (err) {
    console.error(`[Approvals] ${verb} failed:`, err);
    showToast(`Could not ${label} account. Please try again.`, 'error');
  }
}

// ─── Active User Management Panel ────────────────────────────────────────

/**
 * Loads and renders the active user management panel.
 * Only shown to SuperUsers/Admins. Scoped by the server to the caller's org.
 */
async function loadActiveUsers() {
  const user    = getUser();
  const section = document.getElementById('usermgmt-section');
  if (!section) return;

  const canManage = user && (user.superUserID === 1 || user.adminID === 1);
  section.hidden = !canManage;
  if (!canManage) return;

  const token = getToken();
  if (!token || !navigator.onLine) return;

  const loadingEl  = document.getElementById('usermgmt-loading');
  const emptyEl    = document.getElementById('usermgmt-empty');
  const tableWrap  = document.getElementById('usermgmt-table-wrap');
  const countBadge = document.getElementById('usermgmt-count-badge');

  if (loadingEl) loadingEl.hidden = false;
  if (emptyEl)   emptyEl.hidden   = true;
  if (tableWrap) tableWrap.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/auth/users`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }

    if (!res.ok) {
      if (loadingEl) loadingEl.hidden = true;
      if (emptyEl)   { emptyEl.hidden = false; emptyEl.textContent = 'Could not load users.'; }
      return;
    }

    const users = await res.json();
    if (loadingEl) loadingEl.hidden = true;

    if (!users.length) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'No other active users in your organisation.'; }
      if (countBadge) countBadge.textContent = '0 accounts';
      return;
    }

    if (emptyEl)   emptyEl.hidden   = true;
    if (tableWrap) tableWrap.hidden = false;
    if (countBadge) countBadge.textContent = `${users.length} account${users.length !== 1 ? 's' : ''}`;

    const tbody = document.getElementById('usermgmt-tbody');
    if (!tbody) return;

    tbody.innerHTML = users.map(u => {
      const name      = escHtml(u.FullName   ?? '');
      const uname     = escHtml(u.UserName   ?? '');
      const email     = escHtml(u.EmailAddress ?? '');
      const phone     = escHtml(u.PhoneNo    ?? '—');
      const groupName = escHtml(u.GroupName  ?? '—');
      const approvedOn = u.DateApproved ? fmtDate(u.DateApproved.toString().slice(0, 10)) : '—';
      const tid       = escHtml(u.UserTID ?? '');
      // SuperUsers and Admins cannot be deactivated from this UI
      const isPrivileged = u.SuperUserID === 1 || u.AdminID === 1;
      const actionBtn = isPrivileged
        ? `<span style="color:#9ca3af;font-size:0.8rem">Protected</span>`
        : `<button class="btn btn-sm usermgmt-facilities-btn" data-tid="${tid}" data-name="${name}"
                   style="background:#2563eb;color:#fff;border:none;padding:4px 10px;border-radius:5px;margin-right:4px">
             Facilities
           </button>
           <button class="btn btn-sm usermgmt-deactivate-btn" data-tid="${tid}" data-name="${name}"
                   style="background:#dc2626;color:#fff;border:none;padding:4px 12px;border-radius:5px">
             Deactivate
           </button>`;
      return `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:0.5rem 0.75rem;font-weight:500">${name}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${uname}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${email}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${phone}</td>
        <td style="padding:0.5rem 0.75rem">
          <span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:99px;font-size:0.78rem;font-weight:600">${groupName}</span>
        </td>
        <td style="padding:0.5rem 0.75rem;color:#6b7280;white-space:nowrap">${approvedOn}</td>
        <td style="padding:0.5rem 0.75rem">${actionBtn}</td>
      </tr>`;
    }).join('');

    tbody.querySelectorAll('.usermgmt-facilities-btn').forEach(btn => {
      btn.addEventListener('click', () => _handleFacilities(btn.dataset.tid, btn.dataset.name));
    });
    tbody.querySelectorAll('.usermgmt-deactivate-btn').forEach(btn => {
      btn.addEventListener('click', () => _handleDeactivate(btn.dataset.tid, btn.dataset.name));
    });

  } catch (err) {
    console.warn('[UserMgmt] Failed to load users:', err);
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl)   { emptyEl.hidden = false; emptyEl.textContent = 'Could not load users.'; }
  }
}

/**
 * Deactivates (soft-deletes) an active user after confirmation.
 * @param {string} userTID
 * @param {string} name
 */
async function _handleDeactivate(userTID, name) {
  const confirmed = await showGenericConfirmModal(
    'Deactivate Account',
    `Deactivate the account for "${name}"?\n\nThey will be immediately signed out and will no longer be able to log in.`,
    'Deactivate'
  );
  if (!confirmed) return;

  const token = getToken();
  if (!token) { showToast('Session expired. Please sign in again.', 'error'); return; }

  try {
    const res = await fetch(`${API_BASE}/auth/users/${encodeURIComponent(userTID)}`, {
      method:  'DELETE',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }

    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      showToast(data.error ?? 'Failed to deactivate account.', 'error');
      return;
    }

    showToast(data.message ?? `Account for "${name}" deactivated.`, 'success');
    await loadActiveUsers();

  } catch (err) {
    console.error('[UserMgmt] Deactivate failed:', err);
    showToast('Could not deactivate account. Please try again.', 'error');
  }
}

// Wire up the refresh button on the active users panel
document.getElementById('usermgmt-refresh-btn')?.addEventListener('click', () => loadActiveUsers());

// ─── User Facility Assignment ─────────────────────────────────────────────

/** The UserTID of the user whose facilities are currently being edited. */
let _umfCurrentUserTID = null;

/**
 * Opens the facility-assignment modal for a user, loads their current
 * assignments, and renders the full geo tree with those facilities pre-checked.
 * @param {string} userTID
 * @param {string} name
 */
async function _handleFacilities(userTID, name) {
  _umfCurrentUserTID = userTID;

  const nameEl = document.getElementById('umf-user-name');
  if (nameEl) nameEl.textContent = name;

  const treeEl    = document.getElementById('umf-tree');
  const summaryEl = document.getElementById('umf-tree-summary');
  if (treeEl)    treeEl.innerHTML = '<div class="tree-loading">Loading facilities\u2026</div>';
  if (summaryEl) summaryEl.textContent = '';

  // Show modal immediately so the user sees progress.
  document.getElementById('umf-modal-trigger')?.click();

  const token = getToken();
  if (!token) return;

  try {
    // Fetch all geo facilities and the user's current assignments in parallel.
    const [geoItems, assigned] = await Promise.all([
      fetchGeoTreeData(),
      fetch(`${API_BASE}/auth/users/${encodeURIComponent(userTID)}/facilities`, {
        headers: { 'Authorization': `Bearer ${token}` },
      }).then(r => r.ok ? r.json() : []).catch(() => []),
    ]);

    const assignedSet = new Set(assigned.map(f => f.healthFacilityID));
    _umfBuildTree(geoItems, assignedSet);
  } catch (err) {
    console.error('[UserFacilities] Load failed:', err);
    if (treeEl) treeEl.innerHTML = '<div class="tree-empty" style="color:var(--danger)">Could not load facilities.</div>';
  }
}

/**
 * Builds the multiselect facility tree inside #umf-tree.
 * Uses the same rpt-tree-* classes and interaction pattern as the reports tree.
 * @param {Array}  items      - flat list from fetchGeoTreeData()
 * @param {Set}    preChecked - Set of HealthFacilityIDs to pre-check
 */
function _umfBuildTree(items, preChecked) {
  const treeEl    = document.getElementById('umf-tree');
  const summaryEl = document.getElementById('umf-tree-summary');
  if (!treeEl) return;

  treeEl.innerHTML = '';

  // Group: state → county → facilities
  const stateMap = new Map();
  for (const it of items) {
    if (!stateMap.has(it.stateID))
      stateMap.set(it.stateID, { name: it.state, counties: new Map() });
    const st = stateMap.get(it.stateID);
    if (!st.counties.has(it.countyID))
      st.counties.set(it.countyID, { name: it.county, facilities: [] });
    st.counties.get(it.countyID).facilities.push({ id: it.healthFacilityID, name: it.healthFacility });
  }

  if (!stateMap.size) {
    treeEl.innerHTML = '<div class="tree-empty">No facilities available.</div>';
    return;
  }

  const mkEl = (tag, cls, txt) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (txt) e.textContent = txt;
    return e;
  };
  const mkCb = (level, id) => {
    const cb = document.createElement('input');
    cb.type = 'checkbox'; cb.className = 'rpt-tree-cb';
    cb.dataset.level = level; cb.dataset.id = String(id);
    return cb;
  };
  const toggleChildren = (childEl, togEl) => {
    const open = childEl.classList.toggle('open');
    togEl.classList.toggle('open', open);
  };

  const refreshAncestors = () => {
    const setParent = (parentCb, childCbs) => {
      if (!parentCb || !childCbs.length) return;
      const n    = childCbs.filter(c => c.checked).length;
      const nInd = childCbs.filter(c => c.indeterminate).length;
      if (n === 0 && nInd === 0)               { parentCb.checked = false; parentCb.indeterminate = false; }
      else if (n === childCbs.length && !nInd) { parentCb.checked = true;  parentCb.indeterminate = false; }
      else                                     { parentCb.checked = false; parentCb.indeterminate = true;  }
    };
    for (const cn of treeEl.querySelectorAll('.rpt-tree-county')) {
      const ccb  = cn.querySelector(':scope > .rpt-tree-cb');
      const fcbs = [...cn.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-facility > .rpt-tree-cb')];
      setParent(ccb, fcbs);
    }
    for (const sn of treeEl.querySelectorAll('.rpt-tree-state')) {
      const scb  = sn.querySelector(':scope > .rpt-tree-cb');
      const ccbs = [...sn.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-county > .rpt-tree-cb')];
      setParent(scb, ccbs);
    }
  };

  const updateSummary = () => {
    if (!summaryEl) return;
    const allFacCbs   = [...treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]')];
    const checkedFacs = allFacCbs.filter(cb => cb.checked);
    const n = checkedFacs.length;
    if (n === 0) {
      summaryEl.textContent = 'No facilities selected \u2014 default scope will apply.';
      summaryEl.style.color = '#6b7280';
    } else if (n === allFacCbs.length) {
      summaryEl.textContent = `All ${n} facilities selected.`;
      summaryEl.style.color = '#059669';
    } else {
      summaryEl.textContent = `${n} of ${allFacCbs.length} facilit${n === 1 ? 'y' : 'ies'} selected.`;
      summaryEl.style.color = '#2563eb';
    }
  };

  for (const [stateId, stateData] of [...stateMap.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const stateNode     = mkEl('div', 'rpt-tree-node rpt-tree-state');
    const stateToggle   = mkEl('span', 'rpt-tree-toggle');
    const stateCb       = mkCb('state', stateId);
    const stateLabel    = mkEl('span', 'rpt-tree-label', stateData.name);
    const stateChildren = mkEl('div', 'rpt-tree-children');

    for (const [countyId, countyData] of [...stateData.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const countyNode     = mkEl('div', 'rpt-tree-node rpt-tree-county');
      const countyToggle   = mkEl('span', 'rpt-tree-toggle');
      const countyCb       = mkCb('county', countyId);
      const countyLabel    = mkEl('span', 'rpt-tree-label', countyData.name);
      const countyChildren = mkEl('div', 'rpt-tree-children');

      for (const fac of [...countyData.facilities].sort((a, b) => a.name.localeCompare(b.name))) {
        const facNode  = mkEl('div', 'rpt-tree-node rpt-tree-facility');
        const facCb    = mkCb('facility', fac.id);
        const facLabel = mkEl('span', 'rpt-tree-label', fac.name);
        if (preChecked.has(fac.id)) facCb.checked = true;
        facCb.addEventListener('change', () => { refreshAncestors(); updateSummary(); });
        facLabel.addEventListener('click', () => facCb.click());
        facNode.append(facCb, facLabel);
        countyChildren.appendChild(facNode);
      }

      countyCb.addEventListener('change', () => {
        countyChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
          cb.checked = countyCb.checked; cb.indeterminate = false;
        });
        countyCb.indeterminate = false;
        refreshAncestors(); updateSummary();
      });
      countyLabel.addEventListener('click', () => countyCb.click());
      countyToggle.addEventListener('click', () => toggleChildren(countyChildren, countyToggle));

      countyNode.append(countyToggle, countyCb, countyLabel, countyChildren);
      stateChildren.appendChild(countyNode);
    }

    stateCb.addEventListener('change', () => {
      stateChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
        cb.checked = stateCb.checked; cb.indeterminate = false;
      });
      stateCb.indeterminate = false;
      updateSummary();
    });
    stateLabel.addEventListener('click', () => stateCb.click());
    stateToggle.addEventListener('click', () => toggleChildren(stateChildren, stateToggle));

    stateNode.append(stateToggle, stateCb, stateLabel, stateChildren);
    treeEl.appendChild(stateNode);
  }

  // Auto-expand states/counties that contain pre-checked facilities.
  if (preChecked.size > 0) {
    for (const cb of treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]:checked')) {
      let el = cb.parentElement;
      while (el && el !== treeEl) {
        if (el.classList.contains('rpt-tree-children')) {
          el.classList.add('open');
          const tog = el.parentElement?.querySelector(':scope > .rpt-tree-toggle');
          if (tog) tog.classList.add('open');
        }
        el = el.parentElement;
      }
    }
  }

  refreshAncestors();
  updateSummary();
}

// Save-button handler for the facility assignment modal.
document.getElementById('umf-save-btn')?.addEventListener('click', async () => {
  const treeEl  = document.getElementById('umf-tree');
  const saveBtn = document.getElementById('umf-save-btn');
  if (!treeEl || !_umfCurrentUserTID) return;

  const facilityIds = [...treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]:checked')]
    .map(cb => parseInt(cb.dataset.id, 10));

  const token = getToken();
  if (!token) { showToast('Session expired. Please sign in again.', 'error'); return; }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving\u2026';

  try {
    const res = await fetch(
      `${API_BASE}/auth/users/${encodeURIComponent(_umfCurrentUserTID)}/facilities`,
      {
        method:  'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ facilityIds }),
      }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(data.error ?? 'Failed to save assignments.', 'error');
      return;
    }
    // Close the modal via the Cancel button (data-bs-dismiss) to avoid Bootstrap API dependency.
    document.querySelector('#usermgmt-facilities-modal [data-bs-dismiss="modal"]')?.click();
    showToast(data.message ?? 'Facility assignments saved.', 'success');
  } catch (err) {
    console.error('[UserFacilities] Save failed:', err);
    showToast('Could not save assignments. Please try again.', 'error');
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save Assignments';
  }
});

// ─── User Management Card Clicks / Panel Toggle ───────────────────────────

// Lock orientation to landscape while the migration panel is open;
// unlock when any other panel opens or the user navigates away.
let _orientationChangeListener = null;

function _lockLandscape() {
  const prompt  = document.getElementById('migration-rotate-prompt');
  const portrait = () => window.matchMedia('(orientation: portrait)').matches;

  // Remove any stale listener from a previous open.
  if (_orientationChangeListener) {
    screen.orientation?.removeEventListener('change', _orientationChangeListener);
  }

  // Track orientation changes: show/hide the prompt as the device rotates.
  _orientationChangeListener = () => {
    if (prompt) prompt.hidden = !portrait();
  };
  screen.orientation?.addEventListener('change', _orientationChangeListener);

  // Try the browser API first (works on Android standalone PWA when auto-rotate is ON).
  const lockAttempt = (async () => {
    try {
      if (screen.orientation?.lock) await screen.orientation.lock('landscape');
    } catch (_) { /* not supported or denied — fall through to prompt */ }
  })();

  // Show the prompt immediately if currently in portrait; it will
  // auto-hide via the listener once the device (or API) goes landscape.
  if (prompt) {
    lockAttempt.then(() => { prompt.hidden = !portrait(); });
    if (portrait()) prompt.hidden = false;
  }
}

function _unlockOrientation() {
  const prompt = document.getElementById('migration-rotate-prompt');
  if (prompt) prompt.hidden = true;
  if (_orientationChangeListener) {
    screen.orientation?.removeEventListener('change', _orientationChangeListener);
    _orientationChangeListener = null;
  }
  try {
    if (screen.orientation?.unlock) screen.orientation.unlock();
  } catch (_) {}
}

/** Opens one panel, closes the others. If already open, closes it. */
async function _toggleUmgmtPanel(panelId, loadFn) {
  // Warn if the migration panel is currently open and migrations are active.
  if (_migrationPolls.size > 0) {
    const migPanel = document.getElementById('migration-panel');
    if (migPanel && !migPanel.hidden) {
      const proceed = await _warnIfMigratingAsync();
      if (!proceed) return;
    }
  }
  const panels = document.querySelectorAll('.umgmt-panel');
  const target = document.getElementById(panelId);
  if (!target) return;
  const wasHidden = target.hidden;
  const migrationWasOpen = !document.getElementById('migration-panel')?.hidden;
  panels.forEach(p => { p.hidden = true; });
  if (wasHidden) {
    target.hidden = false;
    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (loadFn) loadFn();
    if (panelId === 'migration-panel') _lockLandscape();
    else if (migrationWasOpen)         _unlockOrientation();
  } else {
    // Toggled closed — if migration panel was the one closing, release lock.
    if (migrationWasOpen) _unlockOrientation();
  }
}

// Panel close buttons (delegated on the section)
document.getElementById('usermgmt-section')?.addEventListener('click', e => {
  const closeBtn = e.target.closest('.umgmt-panel-close');
  if (closeBtn) {
    const panel = document.getElementById(closeBtn.dataset.panel);
    if (panel) panel.hidden = true;
  }
});

// Card clicks
const _umgmtCardApprovals = document.getElementById('umgmt-card-approvals');
const _umgmtCardUsers     = document.getElementById('umgmt-card-users');
const _umgmtCardSessions  = document.getElementById('umgmt-card-sessions');

function _wireUmgmtCard(el, panelId, loadFn) {
  if (!el) return;
  el.addEventListener('click', () => _toggleUmgmtPanel(panelId, loadFn));
  el.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _toggleUmgmtPanel(panelId, loadFn); }
  });
}
_wireUmgmtCard(_umgmtCardApprovals, 'approval-panel',   loadPendingApprovals);
_wireUmgmtCard(_umgmtCardUsers,     'usermgmt-panel',   loadActiveUsers);
_wireUmgmtCard(_umgmtCardSessions,  'sessions-panel',   loadActiveSessions);
_wireUmgmtCard(
  document.getElementById('umgmt-card-migration'),
  'migration-panel',
  loadLegacyMigrationPanel
);

// ─── Legacy Data Migration Panel ─────────────────────────────────────────────

/** Per-facility polling interval IDs. Map<dataSourceId, intervalId>. */
const _migrationPolls = new Map();

/**
 * True when the current user is allowed to trigger migration actions.
 * Set on each panel load; false for read-only users.
 */
let _migrationCanAct = false;

/**
 * Loads the facility list from the API and renders the migration table.
 * Called when the Migration card is clicked.
 */
async function loadLegacyMigrationPanel() {
  const user = getUser();
  if (!user) return;

  // Determine whether this user may trigger migration actions.
  _migrationCanAct = user.superUserID === 1 || user.adminID === 1;

  const token = getToken();
  if (!token || !navigator.onLine) return;

  const loadingEl   = document.getElementById('migration-loading');
  const emptyEl     = document.getElementById('migration-empty');
  const treeSection = document.getElementById('migration-tree-section');
  const badge       = document.getElementById('migration-summary-badge');

  if (loadingEl)   loadingEl.hidden   = false;
  if (emptyEl)     emptyEl.hidden     = true;
  if (treeSection) treeSection.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/legacy-migration/facilities`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }

    if (loadingEl) loadingEl.hidden = true;

    if (!res.ok) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'Could not load facilities.'; }
      return;
    }

    const rows = await res.json();

    if (!rows || rows.length === 0) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'No facilities found in legacy database.'; }
      return;
    }

    // Update summary badge on the card
    const migratedCount = rows.filter(r => r.isMigrated).length;
    if (badge) badge.textContent = `${migratedCount} / ${rows.length} migrated`;

    // Render facility tree
    const treeEl = document.getElementById('migration-tree');
    if (treeEl) treeEl._treeData = rows;
    _renderMigrationTree(rows);
    if (treeSection) treeSection.hidden = false;

    // Resume polling for any that are currently running
    rows.filter(r => r.progressStatus === 'running' || r.progressStatus === 'delta-running' || r.progressStatus === 'queued')
        .forEach(r => _startMigrationPoll(r.dataSourceId));

  } catch (err) {
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl)   { emptyEl.hidden = false; emptyEl.textContent = 'Error loading facility list.'; }
  }
}

/** Returns HTML for one facility node inside the migration tree. */
function _migrationFacilityNode(r) {
  const countStr = r.legacyPatients != null && r.legacyPatients > 0
    ? r.legacyPatients.toLocaleString()
    : null;
  return `<li class="tree-node tree-node--facility"
      id="migration-row-${r.dataSourceId}"
      data-dsid="${r.dataSourceId}"
      data-name="${escHtml(r.facilityName)}"
      data-count="${r.legacyPatients ?? 0}">
    <div class="migration-fac-row">
      <span class="migration-fac-name">${escHtml(r.facilityName)}</span>
      <span style="flex-shrink:0;min-width:60px;display:flex;justify-content:center;align-items:center">${countStr ? `<span class="migration-count-chip">${countStr}</span>` : ''}</span>
      <span id="migration-migrate-${r.dataSourceId}" style="flex-shrink:0;min-width:82px;display:flex;justify-content:center;align-items:center">${_migrationMigrateCell(r)}</span>
      <span id="migration-delta-${r.dataSourceId}" style="flex-shrink:0;min-width:110px;display:flex;justify-content:center;align-items:center">${_migrationDeltaCell(r)}</span>
      <span id="migration-undo-${r.dataSourceId}" style="flex-shrink:0;min-width:80px;display:flex;justify-content:center;align-items:center">${_migrationUndoCell(r)}</span>
      <span id="migration-status-${r.dataSourceId}" style="flex-shrink:0;min-width:160px;display:flex;flex-direction:column;align-items:flex-start;gap:3px">${_migrationStatusCell(r)}</span>
    </div>
  </li>`;
}

/**
 * Builds and renders the migration facility tree inside #migration-tree.
 * Groups by State → County → Facility, with migrated/total badges on headings.
 */
function _renderMigrationTree(rows, filterText = '') {
  const container = document.getElementById('migration-tree');
  if (!container) return;

  const term = filterText.trim().toLowerCase();
  const visible = rows.filter(r =>
    !term ||
    r.facilityName.toLowerCase().includes(term) ||
    (r.county || '').toLowerCase().includes(term) ||
    (r.state  || '').toLowerCase().includes(term)
  );

  if (visible.length === 0) {
    container.innerHTML = term
      ? `<p class="tree-empty">No facilities match "<em>${escHtml(filterText)}</em>".</p>`
      : `<p class="tree-empty">No old eTBr legacy records found.</p>`;
    return;
  }

  // Group: state name → county name → facilities[]
  const stateMap = new Map();
  for (const r of visible) {
    const sk = r.state || '(Unknown State)';
    if (!stateMap.has(sk)) stateMap.set(sk, new Map());
    const countyMap = stateMap.get(sk);
    const ck = r.county || '(Unknown County)';
    if (!countyMap.has(ck)) countyMap.set(ck, []);
    countyMap.get(ck).push(r);
  }

  let html = `<ul class="tree-list tree-list--country"><li class="tree-node tree-node--country">
  <details class="tree-details" open>
    <summary class="tree-summary tree-summary--country">
      <span class="tree-toggle-box"></span>
      <span>South Sudan</span>
    </summary>
    <ul class="tree-list tree-list--state">`;

  for (const [stateName, countyMap] of [...stateMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let stateMigrated = 0, stateTotal = 0;
    for (const facs of countyMap.values()) {
      stateTotal   += facs.length;
      stateMigrated += facs.filter(f => f.isMigrated).length;
    }
    const stateOpen = term ? ' open' : '';
    html += `<li class="tree-node tree-node--state">
      <details class="tree-details"${stateOpen}>
        <summary class="tree-summary tree-summary--state">
          <span class="tree-toggle-box"></span>
          <span>${escHtml(stateName)}</span>
          <span style="margin-left:auto;font-size:0.72rem;font-weight:400;color:#6b7280;padding-right:0.2rem">${stateMigrated}/${stateTotal}</span>
        </summary>
        <ul class="tree-list tree-list--county">`;

    for (const [countyName, facs] of [...countyMap.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const countyMigrated = facs.filter(f => f.isMigrated).length;
      const countyOpen = term ? ' open' : '';
      html += `<li class="tree-node tree-node--county">
          <details class="tree-details"${countyOpen}>
            <summary class="tree-summary tree-summary--county">
              <span class="tree-toggle-box"></span>
              <span>${escHtml(countyName)} County</span>
              <span style="margin-left:auto;font-size:0.71rem;font-weight:400;color:#6b7280;padding-right:0.2rem">${countyMigrated}/${facs.length}</span>
            </summary>
            <ul class="tree-list tree-list--facility">`;

      for (const fac of facs.slice().sort((a, b) => a.facilityName.localeCompare(b.facilityName)))
        html += _migrationFacilityNode(fac);

      html += `</ul>
          </details>
        </li>`;
    }

    html += `</ul>
      </details>
    </li>`;
  }

  html += `</ul>
  </details>
</li></ul>`;
  container.innerHTML = html;
}

/** Formats a Date as dd/mm/yyyy HH:MM in local time. */
function _formatMigrationDate(dt) {
  const day = String(dt.getDate()).padStart(2, '0');
  const mon = String(dt.getMonth() + 1).padStart(2, '0');
  const yr  = dt.getFullYear();
  const hr  = String(dt.getHours()).padStart(2, '0');
  const min = String(dt.getMinutes()).padStart(2, '0');
  return `${day}/${mon}/${yr} ${hr}:${min}`;
}

/** Returns HTML for the status indicator in the migration tree row. */
function _migrationStatusCell(r) {
  if (r.progressStatus === 'running')
    return _migrationProgressBar(r.dataSourceId, r.progressPct ?? 0, r.progressMsg || 'Importing…');
  if (r.progressStatus === 'delta-running')
    return _migrationProgressBar(r.dataSourceId, r.progressPct ?? 0, r.progressMsg || 'Syncing changes…');
  if (r.progressStatus === 'queued')
    return `<span class="migration-status-chip" style="background:#fef3c7;color:#92400e;border:1px solid #fde68a">⌛ Queued</span>`;
  if (r.isMigrated) {
    const d   = r.migratedOn ? _formatMigrationDate(new Date(r.migratedOn)) : '';
    const pts = r.importedPatients != null ? r.importedPatients.toLocaleString() : '0';
    let html  = `<span class="migration-status-chip migration-status-migrated">&#10003; ${pts} pts${d ? ' &bull; ' + d : ''}</span>`;
    if (r.lastDeltaSyncOn) {
      const dSync   = _formatMigrationDate(new Date(r.lastDeltaSyncOn));
      const syncPts = r.lastDeltaSyncPatients != null ? r.lastDeltaSyncPatients.toLocaleString() : '0';
      html += ` <span class="migration-status-chip" style="background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;font-size:0.72rem">&#8635; ${syncPts} synced &bull; ${dSync}</span>`;
    }
    return html;
  }
  if (r.progressStatus === 'error') {
    const msg = r.progressMsg || '';
    return `<span style="display:inline-flex;flex-direction:column;gap:1px">
      <span class="migration-status-chip migration-status-error">&#x26A0; Error</span>
      ${msg ? `<span style="font-size:0.68rem;color:#991b1b;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(msg)}">${escHtml(msg)}</span>` : ''}
    </span>`;
  }
  return '';
}

/** Returns HTML for a compact inline progress bar (tree row). */
function _migrationProgressBar(dataSourceId, pct, msg) {
  return `<span id="migration-pbar-wrap-${dataSourceId}"
      style="display:inline-flex;align-items:center;gap:0.35rem;min-width:130px;max-width:180px">
    <span style="flex:1;background:#e5e7eb;border-radius:4px;height:7px;overflow:hidden;display:block">
      <span id="migration-pbar-${dataSourceId}"
        style="display:block;background:#d97706;height:100%;width:${pct}%;transition:width 0.4s ease;border-radius:4px"></span>
    </span>
    <span id="migration-pct-${dataSourceId}"
      style="font-size:0.71rem;color:#6b7280;white-space:nowrap;flex-shrink:0">${pct}%</span>
  </span>`;
}

/** Returns HTML for the Migrate column of a facility row. */
function _migrationMigrateCell(r) {
  if (r.progressStatus === 'running' || r.progressStatus === 'delta-running' || r.progressStatus === 'queued' || r.isMigrated) return '';
  if (!_migrationCanAct) {
    return `<button type="button" disabled
              style="flex-shrink:0;background:#e5e7eb;color:#9ca3af;border:1px solid #d1d5db;border-radius:6px;
                     padding:0.22rem 0.65rem;font-size:0.78rem;cursor:not-allowed;font-weight:600;white-space:nowrap">
              Migrate
            </button>`;
  }
  return `<button type="button"
            class="migration-start-btn"
            data-dsid="${r.dataSourceId}"
            data-name="${escHtml(r.facilityName)}"
            data-count="${r.legacyPatients ?? 0}"
            style="flex-shrink:0;background:#d97706;color:#fff;border:none;border-radius:6px;
                   padding:0.22rem 0.65rem;font-size:0.78rem;cursor:pointer;font-weight:600;white-space:nowrap">
            Migrate
          </button>`;
}

/** Returns HTML for the Sync Changes column of a facility row. */
function _migrationDeltaCell(r) {
  if (r.progressStatus === 'running' || r.progressStatus === 'delta-running' || r.progressStatus === 'queued') return '';
  if (r.isMigrated && _migrationCanAct) {
    return `<button type="button"
              class="migration-delta-btn"
              data-dsid="${r.dataSourceId}"
              data-name="${escHtml(r.facilityName)}"
              style="flex-shrink:0;background:#1d4ed8;color:#fff;border:none;border-radius:6px;
                     padding:0.22rem 0.65rem;font-size:0.78rem;cursor:pointer;font-weight:600;white-space:nowrap">
              Sync Changes
            </button>`;
  }
  return `<button type="button" disabled
            style="flex-shrink:0;background:#e5e7eb;color:#9ca3af;border:1px solid #d1d5db;border-radius:6px;
                   padding:0.22rem 0.65rem;font-size:0.78rem;cursor:not-allowed;font-weight:600;white-space:nowrap">
            Sync Changes
          </button>`;
}

/** Returns HTML for the Undo Sync column of a facility row. */
function _migrationUndoCell(r) {
  if (r.progressStatus === 'running' || r.progressStatus === 'delta-running' || r.progressStatus === 'queued') return '';
  if (r.isMigrated) {
    if (!_migrationCanAct) {
      return `<button type="button" disabled
                style="flex-shrink:0;background:#e5e7eb;color:#9ca3af;border:1px solid #d1d5db;border-radius:6px;
                       padding:0.22rem 0.6rem;font-size:0.78rem;cursor:not-allowed;font-weight:500;white-space:nowrap">
                Undo
              </button>`;
    }
    return `<button type="button"
              class="migration-reset-btn"
              data-dsid="${r.dataSourceId}"
              data-name="${escHtml(r.facilityName)}"
              data-pts="${r.importedPatients ?? 0}"
              style="flex-shrink:0;background:none;border:1px solid #dc2626;color:#dc2626;border-radius:6px;
                     padding:0.22rem 0.6rem;font-size:0.78rem;cursor:pointer;font-weight:500;white-space:nowrap">
              Undo
            </button>`;
  }
  return '';
}

/** Starts polling every 3 s for a running migration. */
function _startMigrationPoll(dataSourceId) {
  if (_migrationPolls.has(dataSourceId)) return; // already polling

  const facRow  = document.getElementById(`migration-row-${dataSourceId}`);
  const facName = facRow?.dataset.name || `Facility ${dataSourceId}`;

  // Entry stores live metadata used by the banner and ETA calculation.
  const entry = { intervalId: null, name: facName, pct: 0, status: 'queued', runningStart: null };
  _migrationPolls.set(dataSourceId, entry);
  _updateMigrationBanner();

  const id = setInterval(async () => {
    try {
      const token = getToken();
      if (!token) { _stopMigrationPoll(dataSourceId); return; }

      const res = await fetch(
        `${API_BASE}/legacy-migration/facility/${dataSourceId}/progress`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      if (!res.ok) return;

      const p = await res.json();

      // Update progress bar
      const pbarEl    = document.getElementById(`migration-pbar-${dataSourceId}`);
      const pctEl     = document.getElementById(`migration-pct-${dataSourceId}`);
      const wrapEl    = document.getElementById(`migration-pbar-wrap-${dataSourceId}`);
      const statusEl  = document.getElementById(`migration-status-${dataSourceId}`);
      const migrateEl = document.getElementById(`migration-migrate-${dataSourceId}`);
      const deltaEl   = document.getElementById(`migration-delta-${dataSourceId}`);
      const undoEl    = document.getElementById(`migration-undo-${dataSourceId}`);

      if (p.status === 'running' || p.status === 'delta-running') {
        // Mark the moment active processing started (transition out of queued).
        if (entry.status === 'queued' || entry.runningStart === null) entry.runningStart = Date.now();
        entry.status = p.status;
        entry.pct    = p.pct;
        _updateMigrationBanner();
        if (pbarEl) pbarEl.style.width = `${p.pct}%`;
        if (pctEl)  pctEl.textContent = `${p.pct}%`;
        return; // keep polling
      }
      if (p.status === 'queued') {
        entry.status = 'queued';
        _updateMigrationBanner();
        if (pctEl) pctEl.textContent = 'Queued…';
        return; // keep polling
      }

      // Terminal state — stop polling and refresh the row
      _stopMigrationPoll(dataSourceId);

      if (p.status === 'done') {
        const pts = p.importedPatients.toLocaleString();
        const d   = _formatMigrationDate(new Date());
        if (statusEl) statusEl.innerHTML =
          `<span class="migration-status-chip migration-status-migrated">&#10003; ${pts} pts &bull; ${d}</span>`;

        // Populate Sync Changes + Undo columns; clear Migrate column
        const facName = document.getElementById(`migration-row-${dataSourceId}`)?.dataset.name || '';
        if (migrateEl) migrateEl.innerHTML = '';
        if (deltaEl) deltaEl.innerHTML =
          `<button type="button"
             class="migration-delta-btn"
             data-dsid="${dataSourceId}"
             data-name="${escHtml(facName)}"
             style="flex-shrink:0;background:#1d4ed8;color:#fff;border:none;border-radius:6px;
                    padding:0.22rem 0.65rem;font-size:0.78rem;cursor:pointer;font-weight:600;white-space:nowrap">
             Sync Changes
           </button>`;
        if (undoEl) undoEl.innerHTML =
          `<button type="button"
             class="migration-reset-btn"
             data-dsid="${dataSourceId}"
             data-name="${escHtml(facName)}"
             data-pts="${p.importedPatients ?? 0}"
             style="flex-shrink:0;background:none;border:1px solid #dc2626;color:#dc2626;border-radius:6px;
                    padding:0.22rem 0.6rem;font-size:0.78rem;cursor:pointer;font-weight:500;white-space:nowrap">
             Undo
           </button>`;

        // Update the summary badge on the card
        const badge = document.getElementById('migration-summary-badge');
        if (badge) {
          const treeEl = document.getElementById('migration-tree');
          const total = treeEl?._treeData?.length ?? 0;
          const migratedNow = document.querySelectorAll('#migration-tree .migration-status-migrated').length;
          badge.textContent = `${migratedNow} / ${total} migrated`;
        }

      } else if (p.status === 'delta-done') {
        // Reload panel to show accurate delta sync stats from the database
        await loadLegacyMigrationPanel();
      } else if (p.status === 'error') {
        const errorMsg = p.message || '';
        const rowEl   = document.getElementById(`migration-row-${dataSourceId}`);
        const facName = rowEl?.dataset.name  || '';
        const count   = rowEl?.dataset.count || '0';
        if (statusEl) statusEl.innerHTML =
          `<span style="display:inline-flex;flex-direction:column;gap:1px">
            <span class="migration-status-chip migration-status-error">&#x26A0; Error</span>
            ${errorMsg ? `<span style="font-size:0.68rem;color:#991b1b;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(errorMsg)}">${escHtml(errorMsg)}</span>` : ''}
          </span>`;
        if (migrateEl) migrateEl.innerHTML =
          `<button type="button" class="migration-start-btn"
             data-dsid="${dataSourceId}" data-name="${escHtml(facName)}" data-count="${count}"
             style="flex-shrink:0;background:#d97706;color:#fff;border:none;border-radius:6px;
                    padding:0.22rem 0.65rem;font-size:0.78rem;cursor:pointer;font-weight:600;white-space:nowrap">
             Migrate
           </button>`;
        if (deltaEl) deltaEl.innerHTML =
          `<button type="button" disabled
             style="flex-shrink:0;background:#e5e7eb;color:#9ca3af;border:1px solid #d1d5db;border-radius:6px;
                    padding:0.22rem 0.65rem;font-size:0.78rem;cursor:not-allowed;font-weight:600;white-space:nowrap">
             Sync Changes
           </button>`;
        if (undoEl) undoEl.innerHTML = '';
      }
    } catch (_) { /* ignore transient network errors */ }
  }, 3000);

  entry.intervalId = id;
}

function _stopMigrationPoll(dataSourceId) {
  const entry = _migrationPolls.get(dataSourceId);
  if (entry != null) clearInterval(entry.intervalId);
  _migrationPolls.delete(dataSourceId);
  _updateMigrationBanner();
}

/**
 * Shows/updates a fixed bottom banner listing all active or queued migrations
 * with live progress and estimated time remaining. Hides when all are done.
 */
function _updateMigrationBanner() {
  // Inject pulse animation once
  if (!document.getElementById('migration-banner-style')) {
    const s = document.createElement('style');
    s.id = 'migration-banner-style';
    s.textContent = '@keyframes _migPulse{0%,100%{opacity:1}50%{opacity:.4}}';
    document.head.appendChild(s);
  }

  let banner = document.getElementById('migration-active-banner');

  if (_migrationPolls.size === 0) {
    if (banner) banner.hidden = true;
    return;
  }

  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'migration-active-banner';
    banner.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:9999',
      'background:#1e293b', 'color:#f1f5f9',
      'padding:0.65rem 1.25rem 0.75rem',
      'box-shadow:0 -2px 14px rgba(0,0,0,.3)',
      'border-top:2px solid #d97706',
      'font-size:0.82rem', 'font-family:inherit'
    ].join(';');
    document.body.appendChild(banner);
  }
  banner.hidden = false;

  let rows = '';
  for (const [, e] of _migrationPolls) {
    const isActive = e.status === 'running' || e.status === 'delta-running';
    const dot = `<span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;
      background:${isActive ? '#f97316' : '#fbbf24'};
      animation:${isActive ? '_migPulse 1.4s ease-in-out infinite' : 'none'}"></span>`;

    let rightHtml;
    if (!isActive) {
      rightHtml = `<span style="color:#fbbf24;white-space:nowrap">⌛ Queued</span>`;
    } else {
      // ETA: linear extrapolation from when active processing started
      let etaTxt = '';
      if (e.runningStart && e.pct > 0) {
        const elapsed = Date.now() - e.runningStart; // ms
        const rate    = e.pct / elapsed;             // % per ms
        if (rate > 0) {
          const remaining = Math.round((100 - e.pct) / rate); // ms
          if (remaining > 0 && remaining < 7_200_000) {
            const m = Math.floor(remaining / 60000);
            const s = Math.floor((remaining % 60000) / 1000);
            etaTxt = m > 0 ? ` ≈ ${m}m left` : s > 5 ? ` ≈ ${s}s left` : ' almost done';
          }
        }
      }
      rightHtml = `<span style="display:inline-flex;align-items:center;gap:0.45rem;white-space:nowrap">
        <span style="width:72px;background:#374151;border-radius:3px;height:5px;display:inline-block;vertical-align:middle">
          <span style="display:block;background:#f97316;height:100%;width:${e.pct}%;border-radius:3px;transition:width .4s ease"></span>
        </span>
        <span style="color:#d1d5db">${e.pct}%${etaTxt}</span>
      </span>`;
    }

    rows += `<div style="display:flex;align-items:center;gap:0.55rem;padding:0.1rem 0">
      ${dot}
      <span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
        max-width:min(220px,35vw);color:#e2e8f0">${escHtml(e.name)}</span>
      ${rightHtml}
    </div>`;
  }

  banner.innerHTML = `<div style="max-width:960px;margin:0 auto;display:flex;align-items:flex-start;gap:0.85rem">
    <span style="font-size:1.1rem;flex-shrink:0;padding-top:0.05rem">⚙️</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;color:#fb923c;margin-bottom:0.3rem">
        Data migration in progress — please do not close this window
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:0.25rem 1.5rem">${rows}</div>
    </div>
  </div>`;
}

// Warn before tab/window close while any migration is active.
window.addEventListener('beforeunload', e => {
  if (_migrationPolls.size === 0) return;
  e.preventDefault();
  e.returnValue = ''; // triggers browser’s built-in “Leave site?” dialog
});

/**
 * Builds HTML listing active/queued migrations for the in-app warning modal.
 */
function _migrationWarningContent() {
  const lines = [];
  for (const [, e] of _migrationPolls) {
    const isActive = e.status === 'running' || e.status === 'delta-running';
    let detail = isActive ? `${e.pct}%` : 'Queued';
    if (isActive && e.runningStart && e.pct > 0) {
      const rate = e.pct / (Date.now() - e.runningStart);
      if (rate > 0) {
        const rem = Math.round((100 - e.pct) / rate);
        if (rem > 0 && rem < 7_200_000) {
          const m = Math.floor(rem / 60000);
          const s = Math.floor((rem % 60000) / 1000);
          detail += m > 0 ? ` &mdash; &asymp;${m}m left` : s > 5 ? ` &mdash; &asymp;${s}s left` : ' &mdash; almost done';
        }
      }
    }
    lines.push(
      `<div style="display:flex;align-items:center;gap:0.4rem;padding:0.1rem 0">` +
      `<span style="color:${isActive ? '#d97706' : '#9ca3af'}">${isActive ? '&#9679;' : '&#8987;'}</span>` +
      `<span><strong>${escHtml(e.name)}</strong> &mdash; ${detail}</span></div>`
    );
  }
  return `Migration is running in the background:<br>` +
    `<div style="margin:0.45rem 0 0.5rem;padding-left:0.1rem">${lines.join('')}</div>` +
    `The import will finish on its own &mdash; you can continue using the eTBr.<br>` +
    `<strong>Do not close or refresh this browser tab until all migrations complete.</strong>`;
}

/**
 * If any migrations are active, shows a styled confirm modal listing them.
 * Returns true to proceed, false if the user cancels.
 */
async function _warnIfMigratingAsync() {
  if (_migrationPolls.size === 0) return true;
  return showGenericConfirmModal('Migration in Progress', _migrationWarningContent(), 'Continue Anyway');
}

// Delegated click handler for Migrate / Retry buttons in the migration table
document.getElementById('migration-panel')?.addEventListener('click', async e => {
  const btn = e.target.closest('.migration-start-btn');
  if (!btn) return;

  const dataSourceId = parseInt(btn.dataset.dsid, 10);
  const name         = btn.dataset.name  || `Facility ${dataSourceId}`;
  const count        = parseInt(btn.dataset.count, 10) || 0;

  const confirmed = await showGenericConfirmModal(
    'Confirm Migration',
    `Import <strong>${count.toLocaleString()}</strong> patient records from<br><em>${escHtml(name)}</em> into the new eTBr system?<br><br>The import runs in the background — you can continue using the eTBr and check back later.`,
    'Import Records'
  );
  if (!confirmed) return;

  btn.disabled    = true;
  btn.textContent = 'Starting…';

  const token = getToken();
  if (!token) return;

  try {
    const res = await fetch(
      `${API_BASE}/legacy-migration/facility/${dataSourceId}`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (res.status === 409) {
      const err = await res.json();
      await showGenericInfoModal('Already Migrated', err.error || 'This facility has already been migrated or a migration is already in progress.');
      btn.disabled = false; btn.textContent = 'Migrate';
      return;
    }
    if (!res.ok) {
      await showGenericInfoModal('Error', 'Failed to start migration. Please try again.');
      btn.disabled = false; btn.textContent = 'Migrate';
      return;
    }

    // Replace button with "In progress…" and show progress bar
    const statusEl  = document.getElementById(`migration-status-${dataSourceId}`);
    const migrateEl = document.getElementById(`migration-migrate-${dataSourceId}`);
    const deltaEl   = document.getElementById(`migration-delta-${dataSourceId}`);
    const undoEl    = document.getElementById(`migration-undo-${dataSourceId}`);
    if (statusEl)  statusEl.innerHTML = _migrationProgressBar(dataSourceId, 0, 'Starting import…');
    if (migrateEl) migrateEl.innerHTML = '';
    if (deltaEl)   deltaEl.innerHTML = '';
    if (undoEl)    undoEl.innerHTML = '';

    _startMigrationPoll(dataSourceId);

  } catch (err) {
    await showGenericInfoModal('Network Error', 'Could not reach the server. Check your connection and try again.');
    btn.disabled = false; btn.textContent = 'Migrate';
  }
});

// Delegated click handler for Remove (rollback) buttons
document.getElementById('migration-panel')?.addEventListener('click', async e => {
  const btn = e.target.closest('.migration-reset-btn');
  if (!btn) return;

  const dataSourceId = parseInt(btn.dataset.dsid, 10);
  const name         = btn.dataset.name || `Facility ${dataSourceId}`;
  const pts          = parseInt(btn.dataset.pts, 10) || 0;

  const confirmed = await showGenericConfirmModal(
    'Undo Migration',
    `This will permanently delete <strong>${pts.toLocaleString()}</strong> imported patients and their follow-ups for<br><em>${escHtml(name)}</em>.<br><br>The facility will return to “Not migrated” and can be re-migrated. Continue?`,
    'Yes, Undo'
  );
  if (!confirmed) return;

  btn.disabled    = true;
  btn.textContent = 'Undoing…';

  const token = getToken();
  if (!token) return;

  try {
    const res = await fetch(
      `${API_BASE}/legacy-migration/facility/${dataSourceId}/undo`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      await showGenericInfoModal('Error', err.error || 'Failed to undo migration. Please try again.');
      btn.disabled = false; btn.textContent = 'Undo';
      return;
    }

    const result = await res.json();

    // Reset the row — clear status chip and restore Migrate / disabled Sync Changes
    const statusEl  = document.getElementById(`migration-status-${dataSourceId}`);
    const migrateEl = document.getElementById(`migration-migrate-${dataSourceId}`);
    const deltaEl   = document.getElementById(`migration-delta-${dataSourceId}`);
    const undoEl    = document.getElementById(`migration-undo-${dataSourceId}`);
    if (statusEl)  statusEl.innerHTML = '';
    if (migrateEl) migrateEl.innerHTML =
      `<button type="button" class="migration-start-btn"
         data-dsid="${dataSourceId}" data-name="${escHtml(name)}" data-count="0"
         style="flex-shrink:0;background:#d97706;color:#fff;border:none;border-radius:6px;
                padding:0.22rem 0.65rem;font-size:0.78rem;cursor:pointer;font-weight:600;white-space:nowrap">
         Migrate
       </button>`;
    if (deltaEl) deltaEl.innerHTML =
      `<button type="button" disabled
         style="flex-shrink:0;background:#e5e7eb;color:#9ca3af;border:1px solid #d1d5db;border-radius:6px;
                padding:0.22rem 0.65rem;font-size:0.78rem;cursor:not-allowed;font-weight:600;white-space:nowrap">
         Sync Changes
       </button>`;
    if (undoEl) undoEl.innerHTML = '';

    // Update card badge
    const badge  = document.getElementById('migration-summary-badge');
    const treeEl = document.getElementById('migration-tree');
    if (badge && treeEl) {
      const total       = treeEl._treeData?.length ?? 0;
      const migratedNow = document.querySelectorAll('#migration-tree .migration-status-migrated').length;
      badge.textContent = migratedNow > 0 ? `${migratedNow} / ${total} migrated` : '';
    }

    await showGenericInfoModal('Migration Undone', `Removed ${result.deletedPatients.toLocaleString()} patients and ${result.deletedFollowUps.toLocaleString()} follow-ups. The facility can now be re-migrated.`);
  } catch (_) {
    await showGenericInfoModal('Network Error', 'Could not reach the server. Please try again.');
    btn.disabled = false; btn.textContent = 'Undo';
  }
});

// Delegated click handler for Sync Changes (delta) buttons
document.getElementById('migration-panel')?.addEventListener('click', async e => {
  const btn = e.target.closest('.migration-delta-btn');
  if (!btn) return;

  const dataSourceId = parseInt(btn.dataset.dsid, 10);
  const name         = btn.dataset.name || `Facility ${dataSourceId}`;

  const confirmed = await showGenericConfirmModal(
    'Sync Changes',
    `Sync patient records that changed in the old eTBr system after 30 Jun 2026 for<br><em>${escHtml(name)}</em>?<br><br>Only modified or newly added patients will be processed.`,
    'Sync Changes'
  );
  if (!confirmed) return;

  btn.disabled    = true;
  btn.textContent = 'Starting…';

  const token = getToken();
  if (!token) return;

  try {
    const res = await fetch(
      `${API_BASE}/legacy-migration/facility/${dataSourceId}/delta`,
      { method: 'POST', headers: { 'Authorization': `Bearer ${token}` } }
    );

    if (res.status === 409) {
      const err = await res.json();
      await showGenericInfoModal('Cannot Sync', err.error || 'A migration or sync is already in progress.');
      btn.disabled = false; btn.textContent = 'Sync Changes';
      return;
    }
    if (!res.ok) {
      await showGenericInfoModal('Error', 'Failed to start sync. Please try again.');
      btn.disabled = false; btn.textContent = 'Sync Changes';
      return;
    }

    // Show progress bar while syncing
    const statusEl = document.getElementById(`migration-status-${dataSourceId}`);
    const deltaEl  = document.getElementById(`migration-delta-${dataSourceId}`);
    const undoEl   = document.getElementById(`migration-undo-${dataSourceId}`);
    if (statusEl) statusEl.innerHTML = _migrationProgressBar(dataSourceId, 0, 'Syncing changes…');
    if (deltaEl)  deltaEl.innerHTML = '';
    if (undoEl)   undoEl.innerHTML = '';

    _startMigrationPoll(dataSourceId);

  } catch (err) {
    await showGenericInfoModal('Network Error', 'Could not reach the server. Check your connection and try again.');
    btn.disabled = false; btn.textContent = 'Sync Changes';
  }
});

// Refresh button for migration panel
document.getElementById('migration-refresh-btn')?.addEventListener('click', loadLegacyMigrationPanel);
document.getElementById('migration-tree-search')?.addEventListener('input', e => {
  const treeEl = document.getElementById('migration-tree');
  if (treeEl?._treeData) _renderMigrationTree(treeEl._treeData, e.target.value);
});

// ─── Active Sessions ──────────────────────────────────────────────────────

/**
 * Loads users who have been active in the last 60 minutes.
 * Requires Admin or SuperUser role.
 */
async function loadActiveSessions() {
  const user = getUser();
  const canView = user && (user.superUserID === 1 || user.adminID === 1);
  if (!canView) return;

  const token = getToken();
  if (!token || !navigator.onLine) return;

  const loadingEl  = document.getElementById('sessions-loading');
  const emptyEl    = document.getElementById('sessions-empty');
  const tableWrap  = document.getElementById('sessions-table-wrap');
  const countBadge = document.getElementById('sessions-count-badge');

  if (loadingEl) loadingEl.hidden = false;
  if (emptyEl)   emptyEl.hidden   = true;
  if (tableWrap) tableWrap.hidden = true;

  try {
    const res = await fetch(`${API_BASE}/auth/sessions`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });

    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }

    if (!res.ok) {
      if (loadingEl) loadingEl.hidden = true;
      if (emptyEl)   { emptyEl.hidden = false; emptyEl.textContent = 'Could not load sessions.'; }
      return;
    }

    const sessions = await res.json();
    if (loadingEl) loadingEl.hidden = true;

    if (!sessions.length) {
      if (emptyEl) { emptyEl.hidden = false; emptyEl.textContent = 'No active sessions in the last 60 minutes.'; }
      if (countBadge) countBadge.textContent = '0 online';
      return;
    }

    if (emptyEl)    emptyEl.hidden   = true;
    if (tableWrap)  tableWrap.hidden = false;
    if (countBadge) countBadge.textContent = `${sessions.length} online`;

    const tbody = document.getElementById('sessions-tbody');
    if (!tbody) return;

    const now = Date.now();
    tbody.innerHTML = sessions.map(s => {
      const name     = escHtml(s.FullName   ?? '');
      const uname    = escHtml(s.UserName   ?? '');
      const role     = escHtml(s.GroupName  ?? '—');
      const lastSeen = s.LastSeenAt
        ? (s.LastSeenAt.toString().endsWith('Z') ? s.LastSeenAt.toString() : s.LastSeenAt.toString() + 'Z')
        : null;
      let timeAgo = '—';
      let statusPill = '';
      if (lastSeen) {
        const diffMs  = now - new Date(lastSeen).getTime();
        const diffMin = Math.round(diffMs / 60000);
        timeAgo = diffMin < 1   ? 'Just now'
                : diffMin < 60  ? `${diffMin}m ago`
                : `${Math.round(diffMin / 60)}h ago`;
        const isActive = diffMin <= 10;
        statusPill = isActive
          ? `<span style="background:#d1fae5;color:#065f46;padding:2px 8px;border-radius:99px;font-size:0.78rem;font-weight:600">&#9679; Active</span>`
          : `<span style="background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:99px;font-size:0.78rem;font-weight:600">Away</span>`;
      }
      return `<tr style="border-bottom:1px solid #f3f4f6">
        <td style="padding:0.5rem 0.75rem;font-weight:500">${name}</td>
        <td style="padding:0.5rem 0.75rem;color:#4b5563">${uname}</td>
        <td style="padding:0.5rem 0.75rem">
          <span style="background:#dbeafe;color:#1e40af;padding:2px 8px;border-radius:99px;font-size:0.78rem;font-weight:600">${role}</span>
        </td>
        <td style="padding:0.5rem 0.75rem;color:#6b7280;white-space:nowrap">${timeAgo}</td>
        <td style="padding:0.5rem 0.75rem">${statusPill}</td>
      </tr>`;
    }).join('');

  } catch (err) {
    console.warn('[Sessions] Failed to load:', err);
    if (loadingEl) loadingEl.hidden = true;
    if (emptyEl)   { emptyEl.hidden = false; emptyEl.textContent = 'Could not load sessions.'; }
  }
}

// ─── Heartbeat — keeps LastSeenAt current so sessions are accurate ────────
(function startHeartbeat() {
  async function _sendHeartbeat() {
    const token = getToken();
    if (!token || !navigator.onLine) return;
    try {
      await fetch(`${API_BASE}/auth/heartbeat`, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
    } catch { /* offline or error — silently ignore */ }
  }
  // Fire once immediately after login, then every 5 minutes
  setTimeout(_sendHeartbeat, 5000);
  setInterval(_sendHeartbeat, 5 * 60 * 1000);
})();

// ─── Server data recovery ─────────────────────────────────────────────────

/**
 * Called automatically after login when the local database is empty.
 * Fetches all records entered by this user from the server and imports them
 * silently.  A dismissible banner blocks new data entry while the restore is
 * in progress so the user cannot accidentally create duplicates.
 *
 * Also triggered by the optional manual "Restore from Server" button.
 */
/**
 * Pulls all patient records for the logged-in user from the server and merges
 * them into the local SQLite database.
 *
 * @param {boolean} silent
 *   false (default) — full-screen banner, used on fresh installs / manual restore.
 *   true  — background pull (no banner); shows a toast only if new records arrive.
 *           Used after every login and each periodic sync so records entered on
 *           other devices appear on this device automatically.
 *
 * Safety: importFullPayloadFromServer uses INSERT OR IGNORE, so records that
 * already exist locally (including any with HasChanged=1) are NEVER overwritten.
 * The pull therefore cannot destroy unsynced local edits.
 */
async function autoRestoreFromServer(silent = false) {
  const token = getToken();
  if (!token || !navigator.onLine) return;

  // Only users who can enter data download records from the server.
  // Read-only users (NTP, State/County coordinators, etc.) oversee many
  // facilities — pulling all their data would be excessive and slow.
  if (!userCanWrite()) return;

  // Delta pull for background syncs (silent=true) when we have a previous pull timestamp.
  // Full pull otherwise: new device/browser (no stored timestamp) or manual restore.
  const lastArtPullAt = silent ? localStorage.getItem('art.lastArtPullAt') : null;
  const url = lastArtPullAt
    ? `${API_BASE}/patients/mine?since=${encodeURIComponent(lastArtPullAt)}`
    : `${API_BASE}/patients/mine`;

  // ── Banner: block new-entry while restoring (non-silent only) ──────────
  let banner = null;
  if (!silent) {
    banner = document.getElementById('restore-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'restore-banner';
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:#0d6efd;color:#fff;text-align:center;' +
        'padding:0.6rem 1rem;font-size:0.9rem;font-weight:500;';
      document.body.prepend(banner);
    }
    banner.textContent = 'Recovering your data from the eTBr server\u2026 Please wait.';
    banner.hidden = false;
    if (submitBtn) submitBtn.disabled = true;
  }

  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }
    if (!res.ok) throw new Error(`eTBr server returned ${res.status}`);

    const payload  = await res.json();
    const imported = await importFullPayloadFromServer(payload);
    // Record pull timestamp for next delta sync (2-min overlap guards against clock skew).
    localStorage.setItem('art.lastArtPullAt', new Date(Date.now() - 2 * 60 * 1000).toISOString());
    const total    = (payload.patients ?? []).length;

    if (imported > 0) {
      renderPatients();
      updateDashboardStats();
    }

    if (!silent) {
      if (total === 0) {
        banner.textContent = 'No records found on server for your account.';
      } else {
        banner.textContent =
          `\u2713 Recovered ${imported} patient record(s) from server.` +
          (total > imported ? ` (${total - imported} already present locally.)` : '');
      }
      showToast(`Recovered ${imported} record(s) from server.`, 'success');
      setTimeout(() => { if (banner) banner.hidden = true; }, 5000);
    } else {
      logSync('INFO', `Pull from server: ${total} on server, ${imported} synced (inserted+updated).`);
      if (imported > 0) {
        showToast(`${imported} record(s) synced from server.`, 'success');
      }
    }

  } catch (err) {
    console.error('[App] autoRestoreFromServer failed:', err);
    if (!silent) {
      banner.textContent = 'Could not retrieve records from server. Tap "Sync" to retry later.';
      banner.style.background = '#dc3545';
      setTimeout(() => { if (banner) banner.hidden = true; }, 6000);
    } else {
      logSync('WARN', `Background pull failed: ${err.message}`);
    }
  } finally {
    if (!silent && submitBtn) submitBtn.disabled = false;
  }
}

/**
 * Pulls all TB patient records for the logged-in user from the server and
 * merges them into the local SQLite database.  Mirrors autoRestoreFromServer
 * but calls GET /api/tb-patients/mine and importTBPayloadFromServer.
 *
 * @param {boolean} silent  false = show toast on new records; true = fully silent unless records arrive
 */
async function autoRestoreFromServerTB(silent = false) {
  const token = getToken();
  if (!token || !navigator.onLine) return;

  // Only users who can enter data download records from the server.
  // Read-only users (NTP, State/County coordinators, etc.) oversee many
  // facilities — pulling all their data would be excessive and slow.
  if (!userCanWrite()) return;

  // TB registration date cutoff — 18 months (1.5 years) before today.
  //
  // Rationale:
  //   • TB treatment outcomes reports cover a full year (12 months), so we
  //     need patients registered at least 12 months back.
  //   • An extra 3 months of safety margin is added for quarter-end
  //     submission scenarios: e.g. a user logging in at the end of September
  //     may still need to submit a Q2 report (patients registered Apr–Jun),
  //     which is 3–5 months in the past.  The 18-month window covers this
  //     comfortably.
  //   • The cutoff is recalculated on every login, so it always rolls forward
  //     with the current date.
  //
  // ART data cutoff: not yet enforced — to be decided, likely anchored to
  // each facility's baseline data entry date.
  const tbCutoff = new Date();
  tbCutoff.setMonth(tbCutoff.getMonth() - 18);
  const regDateFrom = tbCutoff.toISOString().slice(0, 10); // YYYY-MM-DD

  // Delta pull for background syncs (silent=true) when we have a previous pull timestamp.
  // Full pull otherwise: new device/browser (no stored timestamp) or manual restore.
  const lastTbPullAt = silent ? localStorage.getItem('art.lastTbPullAt') : null;
  const tbUrl = lastTbPullAt
    ? `${API_BASE}/tb-patients/mine?since=${encodeURIComponent(lastTbPullAt)}&regDateFrom=${encodeURIComponent(regDateFrom)}`
    : `${API_BASE}/tb-patients/mine?regDateFrom=${encodeURIComponent(regDateFrom)}`;

  try {
    const res = await fetch(tbUrl, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (res.status === 401) { clearAuth(); showAuthScreen(); return; }
    if (!res.ok) throw new Error(`Server returned ${res.status}`);

    const payload  = await res.json();
    const imported = await importTBPayloadFromServer(payload);
    // Record pull timestamp for next delta sync (2-min overlap guards against clock skew).
    localStorage.setItem('art.lastTbPullAt', new Date(Date.now() - 2 * 60 * 1000).toISOString());
    const total    = (payload.patients ?? []).length;

    if (imported > 0) {
      renderTBPatients();
      updateDashboardStats();
      // If the monitoring screen is open (but the TB register isn't), rebuild tree + refresh
      if (tbMonitoringScreen && !tbMonitoringScreen.hidden) _monBuildTree();
      // If the data quality screen is open, rebuild its tree + refresh too
      if (tbQualityScreen && !tbQualityScreen.hidden) _dqBuildTree();
    }

    if (!silent) {
      if (total === 0) {
        showToast('No TB records found on the eTBr server for your account.', '');
      } else {
        showToast(`Recovered ${imported} TB record(s) from the eTBr server.`, 'success');
      }
    } else {
      logSync('INFO', `[TB] Pull from the eTBr server: ${total} on server, ${imported} synced.`);
      if (imported > 0) {
        showToast(`${imported} TB record(s) synced from the eTBr server.`, 'success');
      }
    }
  } catch (err) {
    logSync('WARN', `[TB] Background pull failed: ${err.message}`);
  }
}

/** Navigate into the ART Register from the dashboard. */
function showARTRegister() {
  if (dashboardScreen)   dashboardScreen.hidden   = true;
  if (artRegisterScreen) artRegisterScreen.hidden = false;

  // Always start fresh — clear any previously selected facility and register
  _saveSelectedFacility(null);
  _selectedRegister = null;
  const regSelect = document.getElementById('register-select');
  if (regSelect) regSelect.value = '';
  updateFacilityBanner();
  applyFacilityGate();

  // Load/refresh the facility tree in the background
  loadAndRenderGeoTree();

  window.scrollTo({ top: 0, behavior: 'instant' });
}

function showAppScreen() {
  // If an update was downloaded while user was on the sign-in screen,
  // apply it now before entering the main app.
  if (sessionStorage.getItem('sw-pending-reload') === '1' && !sessionStorage.getItem('sw-reloading')) {
    sessionStorage.removeItem('sw-pending-reload');
    sessionStorage.setItem('sw-reloading', '1');
    sessionStorage.setItem('sw-updated', '1');
    window.location.reload();
    return;
  }

  authScreen.hidden = true;
  appScreen.hidden  = false;
  // Record this login immediately so Active Sessions shows the correct time
  (async () => {
    const tok = getToken();
    if (tok && navigator.onLine) {
      try { await fetch(`${API_BASE}/auth/heartbeat`, { method: 'POST', headers: { 'Authorization': `Bearer ${tok}` } }); } catch {}
    }
  })();
  const user = getUser();
  if (user) {
    logoutBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true" style="flex-shrink:0"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Log Out`;
    userInfoBar.hidden = false;
    // Populate welcome banner
    const nameEl     = document.getElementById('db-welcome-name');
    const facilityEl = document.getElementById('db-welcome-facility');
    if (nameEl)     nameEl.textContent     = `Welcome back, ${user.fullName ?? user.userName ?? 'User'}!`;
    const rolesEl = document.getElementById('db-welcome-roles');
    if (facilityEl) facilityEl.textContent = '';
    if (rolesEl) {
      const roleDisplayMap = {
        'SuperUser':        'Super User',
        'CountySupervisor': 'County Supervisor',
        'StateCoordinator': 'State Coordinator',
        'National':         'National',
        'Admin':            'Admin',
        'DataEntrant':      'Data Entrant',
      };
      const allRoles = Array.isArray(user.roles) && user.roles.length
        ? user.roles.map(r => r === 'NGO'
            ? (user.ngoName && user.ngoName.trim() ? user.ngoName.trim() : 'NGO')
            : (roleDisplayMap[r] ?? r))
        : [user.groupID === 4 ? 'National Level' : user.groupID === 3 ? 'State Coordinator' : user.groupID === 2 ? 'County Supervisor' : 'Data Entrant'];
      // First line: elevated roles (Super User, Admin)
      const elevated  = allRoles.filter(r => r === 'Super User' || r === 'Admin');
      // Second line: operational roles
      const secondary = allRoles.filter(r => r !== 'Super User' && r !== 'Admin');
      rolesEl.innerHTML = '';
      if (elevated.length)  rolesEl.innerHTML += `<span>${elevated.join(' · ')}</span>`;
      if (secondary.length) rolesEl.innerHTML += `${elevated.length ? '<br>' : ''}<span>${secondary.join(' · ')}</span>`;
    }
  }
  // Always land on the dashboard after login
  showDashboard();

  // Baseline card is visible to all users regardless of role.
  const baselineCard = document.getElementById('dash-goto-baseline');
  if (baselineCard) baselineCard.hidden = false;

  // Start the 5-minute heartbeat and kick off a bidirectional sync on login.
  // 1. Upload any local HasChanged=1 records to the server first (1.5 s delay).
  // 2. Pull all records belonging to this user from the server (5 s delay) —
  //    this merges records entered on other devices into the local database.
  //    INSERT OR IGNORE means HasChanged=1 local records are never overwritten.
  startPeriodicSync();
  _startInactivityWatcher();
  if (navigator.onLine) {
    setTimeout(() => triggerSync(true, true, 'post-login'), 1500);
    setTimeout(() => triggerTBSync(true, true, 'post-login-tb'), 1500);
    setTimeout(() => autoRestoreFromServer(true), 5000);
    setTimeout(() => autoRestoreFromServerTB(true), 5000);
  }
}

async function showAuthScreen() {
  stopPeriodicSync();
  _stopInactivityWatcher();
  _unlockOrientation();
  // When offline, show the PIN panel if a PIN is enrolled — even if the user
  // profile was cleared from localStorage (e.g. after an explicit logout).
  if (!_reallyOnline) {
    try {
      const pinData = await loadOfflinePin();
      if (pinData) {
        authScreen.hidden  = false;
        appScreen.hidden   = true;
        userInfoBar.hidden = true;
        _showPanel('offline-pin');
        const subtitleEl = document.getElementById('offline-pin-subtitle');
        if (subtitleEl) {
          const user = getUser();
          const displayName = user?.fullName ?? user?.userName
                           ?? pinData.userProfile?.fullName ?? pinData.userProfile?.userName
                           ?? pinData.userName ?? 'your account';
          subtitleEl.textContent = `Offline — enter PIN to continue as ${displayName}`;
        }
        const firstDigit = document.querySelector('#offline-pin-group .otp-digit');
        if (firstDigit) setTimeout(() => firstDigit.focus(), 100);
        return;
      }
    } catch { /* fall through to normal login */ }
  }
  authScreen.hidden  = false;
  appScreen.hidden   = true;
  userInfoBar.hidden = true;
  _showPanel('login');
}

function _showPanel(name) {
  loginPanel.hidden        = name !== 'login';
  registerPanel.hidden     = name !== 'register';
  forgotPanel.hidden       = name !== 'forgot';
  resetPanel.hidden        = name !== 'reset';
  offlinePinPanel.hidden   = name !== 'offline-pin';
  enrollPinPanel.hidden    = name !== 'enroll-pin';
  if (name === 'login') { loginError.hidden = true; loginError.textContent = ''; }
  if (name !== 'login') { loginSuccess.hidden = true; loginSuccess.textContent = ''; }
}

// ── Panel navigation ─────────────────────────────────────────────────────
document.getElementById('show-register-link').addEventListener('click',     e => { e.preventDefault(); _showPanel('register'); });
document.getElementById('show-forgot-link').addEventListener('click',       e => { e.preventDefault(); _showPanel('forgot'); });
document.getElementById('show-login-link').addEventListener('click',        e => { e.preventDefault(); _showPanel('login'); });
document.getElementById('show-login-from-forgot').addEventListener('click', e => { e.preventDefault(); _showPanel('login'); });
document.getElementById('show-login-from-reset').addEventListener('click',  e => { e.preventDefault(); _showPanel('login'); });

// ── Offline PIN: "use password instead" link ─────────────────────────────
document.getElementById('offline-pin-use-password')?.addEventListener('click', e => {
  e.preventDefault();
  _showPanel('login');
});

// ── Offline PIN: OTP digit wiring ────────────────────────────────────────
(function () {
  const group = document.getElementById('offline-pin-group');
  if (!group) return;
  const digits = Array.from(group.querySelectorAll('.otp-digit'));
  digits.forEach((input, i) => {
    input.addEventListener('input', e => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val.slice(-1);
      e.target.classList.toggle('otp-filled', !!e.target.value);
      if (e.target.value && i < digits.length - 1) digits[i + 1].focus();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].focus();
        digits[i - 1].value = '';
        digits[i - 1].classList.remove('otp-filled');
      }
    });
  });
})();

// ── Offline PIN: form submit ──────────────────────────────────────────────
document.getElementById('offline-pin-form')?.addEventListener('submit', async e => {
  e.preventDefault();
  const digits  = Array.from(document.querySelectorAll('#offline-pin-group .otp-digit'));
  const pin     = digits.map(d => d.value).join('');
  const errEl   = document.getElementById('offline-pin-error');
  const btn     = document.getElementById('offline-pin-btn');

  if (pin.length !== 6) {
    errEl.textContent = 'Please enter all 6 digits.';
    errEl.hidden = false;
    return;
  }

  btn.disabled    = true;
  btn.textContent = 'Verifying…';
  errEl.hidden    = true;

  try {
    const result = await attemptOfflinePinLogin(pin);

    if (result === 'ok') {
      setOfflineSession(true);
      authScreen.hidden  = true;
      appScreen.hidden   = false;
      userInfoBar.hidden = false;
      // Restore the app UI using the cached user profile
      showAppScreen();
      showToast('Offline access granted. Data entry enabled.', 'info');
      updateSyncButtonState();

    } else if (result === 'wrong') {
      const stored = await loadOfflinePin();
      const left   = 5 - ((stored?.failCount) ?? 0);
      digits.forEach(d => { d.value = ''; d.classList.remove('otp-filled'); });
      digits[0]?.focus();
      errEl.textContent = `Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} remaining.`;
      errEl.hidden = false;

    } else if (result === 'locked') {
      errEl.textContent = 'Too many attempts. You must sign in online.';
      errEl.hidden = false;

    } else { // 'wiped'
      errEl.textContent = 'Too many failed attempts — offline PIN has been cleared. Please sign in online.';
      errEl.hidden = false;
      // Fall back to normal login panel after a short delay
      setTimeout(() => { clearAuth(); _showPanel('login'); }, 3000);
    }
  } catch {
    errEl.textContent = 'An error occurred. Please try again.';
    errEl.hidden = false;
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Unlock';
  }
});

// ── PIN Enrollment modal: OTP digit wiring ───────────────────────────────
(function () {
  function wireGroup(groupId) {
    const group = document.getElementById(groupId);
    if (!group) return;
    const digits = Array.from(group.querySelectorAll('.otp-digit'));
    digits.forEach((input, i) => {
      input.addEventListener('input', e => {
        const val = e.target.value.replace(/\D/g, '');
        e.target.value = val.slice(-1);
        e.target.classList.toggle('otp-filled', !!e.target.value);
        if (e.target.value && i < digits.length - 1) digits[i + 1].focus();
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Backspace' && !input.value && i > 0) {
          digits[i - 1].focus();
          digits[i - 1].value = '';
          digits[i - 1].classList.remove('otp-filled');
        }
      });
    });
  }
  wireGroup('pin-enroll-group');
  wireGroup('pin-enroll-confirm-group');
})();

// ── PIN Enrollment modal: Save button ────────────────────────────────────
document.getElementById('pin-enroll-save-btn')?.addEventListener('click', async () => {
  const pin1   = Array.from(document.querySelectorAll('#pin-enroll-group .otp-digit')).map(d => d.value).join('');
  const pin2   = Array.from(document.querySelectorAll('#pin-enroll-confirm-group .otp-digit')).map(d => d.value).join('');
  const errEl  = document.getElementById('pin-enroll-error');
  const saveBtn = document.getElementById('pin-enroll-save-btn');

  errEl.hidden = true;

  if (pin1.length !== 6) {
    errEl.textContent = 'Please enter a 6-digit PIN.';
    errEl.hidden = false;
    return;
  }
  if (pin1 !== pin2) {
    errEl.textContent = 'PINs do not match. Please try again.';
    errEl.hidden = false;
    // Clear confirm group
    document.querySelectorAll('#pin-enroll-confirm-group .otp-digit').forEach(d => {
      d.value = ''; d.classList.remove('otp-filled');
    });
    document.querySelector('#pin-enroll-confirm-group .otp-digit')?.focus();
    return;
  }
  if (/^(\d)\1{5}$/.test(pin1)) {
    errEl.textContent = 'PIN cannot be 6 identical digits (e.g. 000000). Please choose another.';
    errEl.hidden = false;
    return;
  }

  saveBtn.disabled    = true;
  saveBtn.textContent = 'Saving…';
  try {
    await enrollOfflinePin(pin1);
    showAppScreen();
    showToast('Offline PIN saved. You can now log in without internet.', 'success');
  } catch {
    errEl.textContent = 'Could not save PIN. Please try again.';
    errEl.hidden = false;
  } finally {
    saveBtn.disabled    = false;
    saveBtn.textContent = 'Save PIN';
  }
});

// ── PIN Enrollment panel: Skip link ──────────────────────────────────────
document.getElementById('pin-enroll-skip-btn')?.addEventListener('click', e => {
  e.preventDefault();
  showAppScreen();
});


document.querySelectorAll('.pwd-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    const inp = document.getElementById(btn.dataset.target);
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });
});

// ── Password strength meter ───────────────────────────────────────────────
(function () {
  const pwdInput     = document.getElementById('reg-password');
  const confirmInput = document.getElementById('reg-confirm');
  const strengthEl   = document.getElementById('pwd-strength');
  const labelEl      = document.getElementById('pwd-strength-label');
  const matchEl      = document.getElementById('pwd-match');

  if (!pwdInput || !strengthEl || !matchEl) return;

  const LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong'];

  function scorePassword(pwd) {
    if (!pwd) return 0;
    let score = 0;
    if (pwd.length >= 8)  score++;
    if (pwd.length >= 12) score++;          // extra point for length ≥ 12
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
    if (/\d/.test(pwd))   score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    // cap at 4
    return Math.min(score, 4);
  }

  function updateStrength() {
    const val   = pwdInput.value;
    const score = scorePassword(val);

    if (!val) {
      strengthEl.hidden = true;
      strengthEl.removeAttribute('data-score');
    } else {
      strengthEl.hidden = false;
      strengthEl.dataset.score = score;
      labelEl.textContent = LABELS[score];
    }

    // also refresh match if confirm has content
    updateMatch();
  }

  function updateMatch() {
    const val     = confirmInput.value;
    const matches = val && pwdInput.value === val;

    if (!val) {
      matchEl.hidden = true;
      matchEl.className = 'pwd-match';
      return;
    }

    matchEl.hidden = false;
    if (matches) {
      matchEl.className    = 'pwd-match match-ok';
      matchEl.innerHTML    = '&#10003; Passwords match';
    } else {
      matchEl.className    = 'pwd-match match-no';
      matchEl.innerHTML    = '&#10007; Passwords do not match';
    }
  }

  pwdInput.addEventListener('input', updateStrength);
  confirmInput.addEventListener('input', updateMatch);
})();

// ── OTP digit boxes (reset-code) ─────────────────────────────────────────
(function () {
  const group = document.getElementById('reset-code-group');
  if (!group) return;
  const digits = Array.from(group.querySelectorAll('.otp-digit'));

  digits.forEach((input, i) => {
    input.addEventListener('input', e => {
      const val = e.target.value.replace(/\D/g, '');
      e.target.value = val.slice(-1);
      e.target.classList.toggle('otp-filled', !!e.target.value);
      if (e.target.value && i < digits.length - 1) digits[i + 1].focus();
    });
    input.addEventListener('keydown', e => {
      if (e.key === 'Backspace' && !input.value && i > 0) {
        digits[i - 1].focus();
        digits[i - 1].value = '';
        digits[i - 1].classList.remove('otp-filled');
      }
    });
    input.addEventListener('paste', e => {
      e.preventDefault();
      const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '');
      digits.forEach((d, j) => {
        d.value = pasted[j] ?? '';
        d.classList.toggle('otp-filled', !!d.value);
      });
      const focusIdx = Math.min(pasted.length, digits.length - 1);
      digits[focusIdx].focus();
    });
  });
})();

// ── Reset-form password strength & match ─────────────────────────────────
(function () {
  const pwdInput     = document.getElementById('reset-password');
  const confirmInput = document.getElementById('reset-confirm');
  const strengthEl   = document.getElementById('reset-pwd-strength');
  const labelEl      = document.getElementById('reset-pwd-strength-label');
  const matchEl      = document.getElementById('reset-pwd-match');

  if (!pwdInput || !strengthEl || !matchEl) return;

  const LABELS = ['', 'Weak', 'Fair', 'Good', 'Strong'];

  function scorePassword(pwd) {
    if (!pwd) return 0;
    let score = 0;
    if (pwd.length >= 8)  score++;
    if (pwd.length >= 12) score++;
    if (/[A-Z]/.test(pwd) && /[a-z]/.test(pwd)) score++;
    if (/\d/.test(pwd))   score++;
    if (/[^A-Za-z0-9]/.test(pwd)) score++;
    return Math.min(score, 4);
  }

  function updateStrength() {
    const val   = pwdInput.value;
    const score = scorePassword(val);
    if (!val) {
      strengthEl.hidden = true;
      strengthEl.removeAttribute('data-score');
    } else {
      strengthEl.hidden = false;
      strengthEl.dataset.score = score;
      labelEl.textContent = LABELS[score];
    }
    updateMatch();
  }

  function updateMatch() {
    const val     = confirmInput.value;
    const matches = val && pwdInput.value === val;
    if (!val) {
      matchEl.hidden    = true;
      matchEl.className = 'pwd-match';
      return;
    }
    matchEl.hidden = false;
    if (matches) {
      matchEl.className = 'pwd-match match-ok';
      matchEl.innerHTML = '&#10003; Passwords match';
    } else {
      matchEl.className = 'pwd-match match-no';
      matchEl.innerHTML = '&#10007; Passwords do not match';
    }
  }

  pwdInput.addEventListener('input', updateStrength);
  confirmInput.addEventListener('input', updateMatch);
})();

// ── Cascading location dropdowns (registration) ─────────────────────────
(function () {
  const stateEl    = document.getElementById('StateID');
  const countyEl   = document.getElementById('CountyID');
  const facilityEl = document.getElementById('HealthFacilityID');
  if (!stateEl) return;

  function fillSelect(sel, items, valueKey, labelKey, placeholder) {
    sel.innerHTML = `<option value="0">${placeholder}</option>`;
    for (const item of items) {
      if (item[valueKey] === 0) continue; // skip the SQL "ALL" sentinel row
      const opt = document.createElement('option');
      opt.value = item[valueKey];
      opt.textContent = item[labelKey];
      sel.appendChild(opt);
    }
  }

  async function loadStates() {
    try {
      const data = await fetch(`${API_BASE}/auth/states`).then(r => r.json());
      fillSelect(stateEl, data, 'stateID', 'state', '-- National Level --');
    } catch {
      stateEl.innerHTML = '<option value="0">-- Could not load states --</option>';
    }
  }

  async function loadCounties(stateId) {
    countyEl.innerHTML = '<option value="0">Loading…</option>';
    countyEl.disabled = true;
    resetFacility();
    try {
      const data = await fetch(`${API_BASE}/auth/counties?stateId=${stateId}`).then(r => r.json());
      fillSelect(countyEl, data, 'countyID', 'county', '-- Select county (optional) --');
      countyEl.disabled = false;
    } catch {
      countyEl.innerHTML = '<option value="0">-- Could not load counties --</option>';
    }
  }

  function resetCounty() {
    countyEl.disabled = true;
    countyEl.innerHTML = '<option value="0">-- Select a state first --</option>';
    resetFacility();
  }

  async function loadFacilities(countyId) {
    facilityEl.innerHTML = '<option value="0">Loading…</option>';
    facilityEl.disabled = true;
    try {
      const data = await fetch(`${API_BASE}/auth/facilities?countyId=${countyId}`).then(r => r.json());
      fillSelect(facilityEl, data, 'healthFacilityID', 'healthFacility', '-- Select facility (optional) --');
      facilityEl.disabled = false;
    } catch {
      facilityEl.innerHTML = '<option value="0">-- Could not load facilities --</option>';
    }
  }

  function resetFacility() {
    facilityEl.disabled = true;
    facilityEl.innerHTML = '<option value="0">-- Select a county first --</option>';
  }

  stateEl.addEventListener('change', () => {
    const sid = Number(stateEl.value);
    if (sid === 0) resetCounty(); else loadCounties(sid);
  });

  countyEl.addEventListener('change', () => {
    const cid = Number(countyEl.value);
    if (cid === 0) resetFacility(); else loadFacilities(cid);
  });

  loadStates();
})();

// ── NGO cascade: WorkWithID → SubRecID → NGOLocationID ─────────────────────
(function () {
  const workWithEl = document.getElementById('WorkWithID');
  const subRecEl   = document.getElementById('SubRecID');
  const ngoLocEl   = document.getElementById('NGOLocationID');
  if (!workWithEl) return;

  function fillSelect(sel, items, valueKey, labelKey, placeholder) {
    sel.innerHTML = `<option value="0">${placeholder}</option>`;
    for (const item of items) {
      if (item[valueKey] === 0) continue;
      const opt = document.createElement('option');
      opt.value = item[valueKey];
      opt.textContent = item[labelKey];
      sel.appendChild(opt);
    }
  }

  async function loadSubRecipients() {
    subRecEl.innerHTML = '<option value="0">Loading…</option>';
    subRecEl.disabled = true;
    resetNGOLocation();
    try {
      const data = await fetch(`${API_BASE}/auth/subrecipients`).then(r => r.json());
      fillSelect(subRecEl, data, 'subRecID', 'subRec', '-- Select sub recipient --');
      subRecEl.disabled = false;
    } catch {
      subRecEl.innerHTML = '<option value="0">-- Could not load sub recipients --</option>';
    }
  }

  async function loadNGOLocations(subRecId) {
    ngoLocEl.innerHTML = '<option value="0">Loading…</option>';
    ngoLocEl.disabled = true;
    try {
      const data = await fetch(`${API_BASE}/auth/locations?subRecId=${subRecId}`).then(r => r.json());
      fillSelect(ngoLocEl, data, 'locationID', 'location', '-- ALL Field Locations --');
      ngoLocEl.disabled = false;
    } catch {
      ngoLocEl.innerHTML = '<option value="0">-- Could not load locations --</option>';
    }
  }

  function resetSubRec() {
    subRecEl.disabled = true;
    subRecEl.innerHTML = '<option value="0">-- Select organisation above first --</option>';
    resetNGOLocation();
  }

  function resetNGOLocation() {
    ngoLocEl.disabled = true;
    ngoLocEl.innerHTML = '<option value="0">-- Select sub recipient first --</option>';
  }

  workWithEl.addEventListener('change', () => {
    const wid = Number(workWithEl.value);
    if (wid === 2) loadSubRecipients();
    else resetSubRec();
  });

  subRecEl.addEventListener('change', () => {
    const sid = Number(subRecEl.value);
    if (sid === 0) resetNGOLocation(); else loadNGOLocations(sid);
  });
})();

// ── Login submit ──────────────────────────────────────────────────────────
loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  loginError.hidden = true;
  loginBtnEl.disabled   = true;
  loginBtnEl.textContent = 'Signing in…';

  try {
    const res  = await fetch(`${API_BASE}/auth/login`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userName: document.getElementById('login-username').value.trim(),
        password: document.getElementById('login-password').value,
      }),
    });
    const data = await res.json();

    if (res.ok) {
      // ── User-switch / first-login detection ────────────────────────────
      // Each user gets their own user-scoped IndexedDB (PatientPWA_<username>)
      // so patient data from different facilities can never mix on a shared device.
      const _normUser = raw =>
        (raw && raw.includes('@') ? raw.split('@')[0] : (raw || ''))
          .toLowerCase().replace(/[^a-z0-9._-]/g, '_');
      const _prevUser = localStorage.getItem('art.lastLoginUser') || '';
      const _newUser  = _normUser(data.userName || '');

      if (!_prevUser) {
        // First login on this device (or first after this feature was deployed).
        // The legacy 'PatientPWA' database may already hold data for this user —
        // migrate it by re-pointing the IDB name and flushing the in-memory DB.
        setIDBUser(data.userName);
        await _persistDB();
      } else if (_prevUser !== _newUser) {
        // A different user is signing in — open their own isolated database
        // and force a full data pull so they see their complete correct dataset.
        localStorage.removeItem('art.lastArtPullAt');
        localStorage.removeItem('art.lastTbPullAt');
        setIDBUser(data.userName);
        await initDB();
        console.log(`[Auth] User switch: ${_prevUser} → ${_newUser}. Fresh database opened.`);
      }
      // Same user as before: the correct database is already open — nothing to do.

      if (_newUser) localStorage.setItem('art.lastLoginUser', _newUser);
      // ── /User-switch ───────────────────────────────────────────────────

      saveAuth(data);
      setOfflineSession(false);
      loginForm.reset();
      // Pre-cache facility list in the background so it's available offline
      fetchGeoTreeData().catch(() => {});
      // Show enrollment panel if needed, then app — or go straight to app
      console.log('[PIN] Login OK — calling _checkPinEnrollment()');
      _checkPinEnrollment();
    } else {
      loginError.textContent = data.error ?? 'Login failed.';
      loginError.hidden = false;
    }
  } catch (err) {
    // TypeError = network unreachable (works cross-browser, unlike navigator.onLine in Firefox)
    if (err instanceof TypeError) {
      _reallyOnline = false;
      updateConnectionStatus();
      const pinData = await loadOfflinePin().catch(() => null);
      if (pinData) { showAuthScreen(); return; }
    }
    loginError.textContent = 'Could not reach the eTBr server. Check your connection.';
    loginError.hidden = false;
  } finally {
    loginBtnEl.disabled   = false;
    loginBtnEl.textContent = 'Sign In';
  }
});

// ── Register: real-time username availability check (debounced) ──────────
const regUsernameInput = document.getElementById('reg-username');
const regUsernameHint  = document.getElementById('reg-username-hint');
let _usernameAvailable = true;
let _usernameCheckTimer = null;
let _lastCheckedUsername = '';

async function _checkUsername(val) {
  if (!val) {
    regUsernameHint.hidden = true;
    _usernameAvailable = true;
    return;
  }
  // Show spinner while checking
  regUsernameHint.removeAttribute('style');
  regUsernameHint.className = 'field-hint username-checking';
  regUsernameHint.textContent = 'Checking\u2026';
  regUsernameHint.hidden = false;
  _usernameAvailable = false; // block submit until result is known
  try {
    const res  = await fetch(`${API_BASE}/auth/check-username?username=${encodeURIComponent(val)}`);
    const data = await res.json();
    // Ignore stale results if the user kept typing
    if (regUsernameInput.value.trim() !== val) return;
    _usernameAvailable = data.available;
    regUsernameHint.className = 'field-hint';
    regUsernameHint.textContent = data.available ? '\u2713 Username is available' : '\u2717 Username is already taken';
    regUsernameHint.style.color = data.available ? 'var(--success)' : 'var(--danger)';
  } catch {
    regUsernameHint.hidden = true;
    _usernameAvailable = true; // don't block submit if check fails
  }
}

regUsernameInput.addEventListener('input', () => {
  clearTimeout(_usernameCheckTimer);
  const val = regUsernameInput.value.trim();
  if (!val) { regUsernameHint.hidden = true; _usernameAvailable = true; return; }
  if (val.length < 6) {
    regUsernameHint.className = 'field-hint';
    regUsernameHint.style.color = 'var(--text-muted)';
    regUsernameHint.textContent = 'Username must be at least 6 characters';
    regUsernameHint.hidden = false;
    _usernameAvailable = false;
    return;
  }
  // Fire immediately if user pauses for 400 ms
  _usernameCheckTimer = setTimeout(() => _checkUsername(val), 400);
});

// Also fire immediately if user tabs/clicks away with a pending value
regUsernameInput.addEventListener('blur', () => {
  clearTimeout(_usernameCheckTimer);
  const val = regUsernameInput.value.trim();
  if (val && val.length >= 6) _checkUsername(val);
  else if (val && val.length < 6) {
    regUsernameHint.className = 'field-hint';
    regUsernameHint.style.color = 'var(--text-muted)';
    regUsernameHint.textContent = 'Username must be at least 6 characters';
    regUsernameHint.hidden = false;
    _usernameAvailable = false;
  }
});

// ── Register: email uniqueness check ─────────────────────────────────────
const regEmailInput = document.getElementById('reg-email');
const regEmailHint  = document.getElementById('reg-email-hint');
let _emailAvailable = true;
let _emailCheckTimer = null;

function _isValidEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v); }

async function _checkEmail(val) {
  if (!_isValidEmail(val)) {
    regEmailHint.className = 'field-hint';
    regEmailHint.style.color = 'var(--text-muted)';
    regEmailHint.textContent = 'Enter a valid email address';
    regEmailHint.hidden = false;
    _emailAvailable = false;
    return;
  }
  regEmailHint.removeAttribute('style');
  regEmailHint.className = 'field-hint username-checking';
  regEmailHint.textContent = 'Checking\u2026';
  regEmailHint.hidden = false;
  _emailAvailable = false;
  try {
    const res  = await fetch(`${API_BASE}/auth/check-email?email=${encodeURIComponent(val)}`);
    const data = await res.json();
    if (regEmailInput.value.trim() !== val) return;
    _emailAvailable = data.available;
    regEmailHint.className = 'field-hint';
    regEmailHint.textContent = data.available ? '\u2713 Email is available' : '\u2717 Email is already registered';
    regEmailHint.style.color = data.available ? 'var(--success)' : 'var(--danger)';
  } catch {
    regEmailHint.hidden = true;
    _emailAvailable = true;
  }
}

regEmailInput.addEventListener('input', () => {
  clearTimeout(_emailCheckTimer);
  const val = regEmailInput.value.trim();
  if (!val) { regEmailHint.hidden = true; _emailAvailable = true; return; }
  _emailCheckTimer = setTimeout(() => _checkEmail(val), 400);
});
regEmailInput.addEventListener('blur', () => {
  clearTimeout(_emailCheckTimer);
  const val = regEmailInput.value.trim();
  if (val) _checkEmail(val);
});

// ── Register: phone uniqueness check ─────────────────────────────────────────────────────────────────
const regPhoneInput = document.getElementById('reg-phone');
const regPhoneHint  = document.getElementById('reg-phone-hint');
let _phoneAvailable = true;
let _phoneCheckTimer = null;

async function _checkPhone(val) {
  try {
    const res  = await fetch(`${API_BASE}/auth/check-phone?phone=${encodeURIComponent(val)}`);
    const data = await res.json();
    if (regPhoneInput.value.replace(/\D/g, '') !== val) return; // stale — user kept typing
    _phoneAvailable = !data.partial && data.available; // only block submit on exact match
    regPhoneHint.className = 'field-hint';
    if (data.available) {
      regPhoneHint.textContent = val.length === 10
        ? '\u2713 Phone number is available'
        : '\u2713 No numbers start with these digits';
      regPhoneHint.style.color = 'var(--success)';
    } else {
      regPhoneHint.textContent = val.length === 10
        ? '\u2717 Phone number is already registered'
        : '\u26a0\ufe0f A registered number starts with these digits';
      regPhoneHint.style.color = data.partial ? 'var(--warning, #d97706)' : 'var(--danger)';
    }
    regPhoneHint.hidden = false;
  } catch {
    regPhoneHint.hidden = true;
    _phoneAvailable = true;
  }
}

// Strip any non-digit character as the user types
regPhoneInput.addEventListener('input', () => {
  const cleaned = regPhoneInput.value.replace(/\D/g, '');
  if (regPhoneInput.value !== cleaned) regPhoneInput.value = cleaned;

  clearTimeout(_phoneCheckTimer);
  const val = cleaned;

  if (!val) { regPhoneHint.hidden = true; _phoneAvailable = true; return; }

  if (val[0] !== '0') {
    regPhoneHint.className = 'field-hint';
    regPhoneHint.style.color = 'var(--danger)';
    regPhoneHint.textContent = '\u2717 Phone number must start with 0';
    regPhoneHint.hidden = false;
    _phoneAvailable = false;
    return;
  }

  if (val.length < 5) {
    regPhoneHint.className = 'field-hint';
    regPhoneHint.style.color = 'var(--text-muted)';
    regPhoneHint.textContent = `${val.length}/10 digits`;
    regPhoneHint.hidden = false;
    _phoneAvailable = false;
    return;
  }

  // 5+ digits — show spinner immediately then check after debounce
  regPhoneHint.removeAttribute('style');
  regPhoneHint.className = 'field-hint username-checking';
  regPhoneHint.textContent = 'Checking\u2026';
  regPhoneHint.hidden = false;
  _phoneAvailable = val.length < 10; // don't block submit on partial result
  _phoneCheckTimer = setTimeout(() => _checkPhone(val), 400);
});

regPhoneInput.addEventListener('blur', () => {
  clearTimeout(_phoneCheckTimer);
  const val = regPhoneInput.value.replace(/\D/g, '');
  if (!val) { regPhoneHint.hidden = true; _phoneAvailable = true; return; }
  if (val.length >= 5 && val[0] === '0') _checkPhone(val);
});

// ── Register submit ───────────────────────────────────────────────────────
registerForm.addEventListener('submit', async e => {
  e.preventDefault();
  registerError.hidden   = true;
  registerSuccess.hidden = true;

  const regUsernameVal = document.getElementById('reg-username').value.trim();
  if (regUsernameVal.length < 6) {
    registerError.textContent = 'Username must be at least 6 characters.';
    registerError.hidden = false;
    document.getElementById('reg-username').focus();
    return;
  }
  if (!_usernameAvailable) {
    registerError.textContent = 'That username is already taken. Please choose another.';
    registerError.hidden = false;
    document.getElementById('reg-username').focus();
    return;
  }
  if (!_emailAvailable) {
    registerError.textContent = 'That email address is already registered or invalid.';
    registerError.hidden = false;
    document.getElementById('reg-email').focus();
    return;
  }
  const phoneVal = document.getElementById('reg-phone').value.trim();
  if (phoneVal) {
    if (!/^\d+$/.test(phoneVal) || phoneVal.length !== 10 || phoneVal[0] !== '0') {
      registerError.textContent = 'Phone number must be exactly 10 digits and start with 0.';
      registerError.hidden = false;
      document.getElementById('reg-phone').focus();
      return;
    }
    if (!_phoneAvailable) {
      registerError.textContent = 'That phone number is already registered.';
      registerError.hidden = false;
      document.getElementById('reg-phone').focus();
      return;
    }
  }

  const pwd     = document.getElementById('reg-password').value;
  const confirm = document.getElementById('reg-confirm').value;
  if (pwd !== confirm) {
    registerError.textContent = 'Passwords do not match.';
    registerError.hidden = false;
    return;
  }
  if (pwd.length < 8) {
    registerError.textContent = 'Password must be at least 8 characters.';
    registerError.hidden = false;
    return;
  }

  const stateId       = Number(document.getElementById('StateID')?.value)          || 0;
  const countyId      = Number(document.getElementById('CountyID')?.value)         || 0;
  const facilityId    = Number(document.getElementById('HealthFacilityID')?.value) || 0;
  const subRecId      = Number(document.getElementById('SubRecID')?.value)         || 0;
  const ngoLocationId = Number(document.getElementById('NGOLocationID')?.value)    || 0;
  // GroupID is inferred from geographic selections:
  // Group 1 (Data Entrant)      — State + County + Facility selected, SubRecID ≠ 2.
  // Group 2 (County Supervisor) — County selected without a facility, OR
  //                               State+County+Facility selected AND SubRecID = 2.
  // Group 3 (State Coordinator) — State selected but no county or facility.
  // Group 4 (National)          — Nothing specific selected.
  let inferredGroupID;
  if (stateId !== 0 && countyId !== 0 && facilityId !== 0)
    inferredGroupID = (subRecId === 2) ? 2 : 1;
  else if (countyId !== 0 && facilityId === 0)
    inferredGroupID = 2;
  else if (stateId !== 0 && countyId === 0 && facilityId === 0)
    inferredGroupID = 3;
  else
    inferredGroupID = 4;

  const regBtn = document.getElementById('register-btn');
  regBtn.disabled    = true;
  regBtn.textContent = 'Creating account…';

  try {
    const res  = await fetch(`${API_BASE}/auth/register`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        fullName:         document.getElementById('reg-fullname').value.trim(),
        userName:         document.getElementById('reg-username').value.trim(),
        emailAddress:     document.getElementById('reg-email').value.trim(),
        phoneNo:          document.getElementById('reg-phone').value.trim() || null,
        password:         pwd,
        groupID:          inferredGroupID,
        stateID:          stateId,
        countyID:         countyId,
        healthFacilityID: facilityId,
        subRecID:         subRecId,
        locationID:       ngoLocationId,
      }),
    });
    const data = await res.json();

    if (res.ok || res.status === 201) {
      registerForm.reset();
      // Reset cascading dropdowns
      const stateEl    = document.getElementById('StateID');
      const countyEl   = document.getElementById('CountyID');
      const facilEl    = document.getElementById('HealthFacilityID');
      const workWithEl = document.getElementById('WorkWithID');
      const subRecEl   = document.getElementById('SubRecID');
      const ngoLocEl   = document.getElementById('NGOLocationID');
      if (stateEl)    stateEl.value = '0';
      if (countyEl)  { countyEl.disabled = true;  countyEl.innerHTML  = '<option value="0">-- Select a state first --</option>'; }
      if (facilEl)   { facilEl.disabled  = true;  facilEl.innerHTML   = '<option value="0">-- Select a county first --</option>'; }
      if (workWithEl) workWithEl.value = '0';
      if (subRecEl)  { subRecEl.disabled  = true;  subRecEl.innerHTML  = '<option value="0">-- Select organisation above first --</option>'; }
      if (ngoLocEl)  { ngoLocEl.disabled  = true;  ngoLocEl.innerHTML  = '<option value="0">-- Select sub recipient first --</option>'; }
      const successMsg = data.message ?? 'Account created! Awaiting administrator approval.';
      registerSuccess.textContent = successMsg;
      registerSuccess.hidden = false;
      setTimeout(() => {
        loginSuccess.textContent = successMsg;
        loginSuccess.hidden = false;
        _showPanel('login');
      }, 4000);
    } else {
      registerError.textContent = data.error ?? 'Registration failed.';
      registerError.hidden = false;
    }
  } catch {
    registerError.textContent = 'Could not reach the eTBr server. Check your connection.';
    registerError.hidden = false;
  } finally {
    regBtn.disabled    = false;
    regBtn.textContent = 'Create Account';
  }
});

// ── Forgot-password submit ────────────────────────────────────────────────
forgotForm.addEventListener('submit', async e => {
  e.preventDefault();
  forgotMsg.hidden    = true;
  forgotMsg.className = 'auth-msg';
  const forgotBtn = document.getElementById('forgot-btn');
  forgotBtn.disabled    = true;
  forgotBtn.textContent = 'Sending…';

  try {
    const res  = await fetch(`${API_BASE}/auth/forgot-password`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ emailAddress: document.getElementById('forgot-email').value.trim() }),
    });
    const data = await res.json();

    if (res.ok) {
      forgotMsg.className = 'auth-msg auth-msg--success';
      if (data.resetCode) {
        // Dev mode: API returned the code directly — pre-fill OTP boxes
        const _otpDigits = document.querySelectorAll('#reset-code-group .otp-digit');
        String(data.resetCode).split('').forEach((ch, i) => {
          if (_otpDigits[i]) { _otpDigits[i].value = ch; _otpDigits[i].classList.add('otp-filled'); }
        });
        forgotMsg.textContent = `Code generated. Redirecting to reset form… (Dev code: ${data.resetCode})`;
      } else {
        forgotMsg.textContent = data.message ?? 'If that email is registered, a code has been sent.';
      }
      forgotMsg.hidden = false;
      setTimeout(() => _showPanel('reset'), 2500);
    } else {
      forgotMsg.className   = 'auth-msg auth-msg--error';
      forgotMsg.textContent = data.error ?? 'An error occurred. Please try again.';
      forgotMsg.hidden      = false;
    }
  } catch {
    forgotMsg.className   = 'auth-msg auth-msg--error';
    forgotMsg.textContent = 'Could not reach the eTBr server.';
    forgotMsg.hidden      = false;
  } finally {
    forgotBtn.disabled    = false;
    forgotBtn.textContent = 'Send Reset Code';
  }
});

// ── Reset-password submit ─────────────────────────────────────────────────
resetForm.addEventListener('submit', async e => {
  e.preventDefault();
  resetMsg.hidden    = true;
  resetMsg.className = 'auth-msg';

  const newPwd  = document.getElementById('reset-password').value;
  const confirm = document.getElementById('reset-confirm').value;
  if (newPwd !== confirm) {
    resetMsg.className   = 'auth-msg auth-msg--error';
    resetMsg.textContent = 'Passwords do not match.';
    resetMsg.hidden      = false;
    return;
  }

  const resetBtn = document.getElementById('reset-btn');
  resetBtn.disabled    = true;
  resetBtn.textContent = 'Resetting…';

  try {
    const res  = await fetch(`${API_BASE}/auth/reset-password`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        userName:    document.getElementById('reset-username').value.trim(),
        resetCode:   Array.from(document.querySelectorAll('#reset-code-group .otp-digit')).map(d => d.value).join(''),
        newPassword: newPwd,
      }),
    });
    const data = await res.json();

    if (res.ok) {
      resetMsg.className   = 'auth-msg auth-msg--success';
      resetMsg.textContent = data.message ?? 'Password reset! You can now sign in.';
      resetMsg.hidden      = false;
      resetForm.reset();
      setTimeout(() => _showPanel('login'), 2500);
    } else {
      resetMsg.className   = 'auth-msg auth-msg--error';
      resetMsg.textContent = data.error ?? 'Reset failed.';
      resetMsg.hidden      = false;
    }
  } catch {
    resetMsg.className   = 'auth-msg auth-msg--error';
    resetMsg.textContent = 'Could not reach the eTBr server.';
    resetMsg.hidden      = false;
  } finally {
    resetBtn.disabled    = false;
    resetBtn.textContent = 'Reset Password';
  }
});

// ── Logout ────────────────────────────────────────────────────────────────
// Modal is triggered by data-bs-toggle on the button — no JS constructor needed.
// Just wire up the actual sign-out action on the confirm button.
document.getElementById('logout-confirm-btn').addEventListener('click', () => {
  setOfflineSession(false);
  _stopInactivityWatcher();
  // Clear the JWT but keep the user profile in localStorage so that
  // the offline PIN panel can identify the user if they go offline after logout.
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EXPIRY_KEY);
  showAuthScreen();
});

// Blur any focused element inside the modal before Bootstrap sets aria-hidden,
// which would otherwise trigger an accessibility warning in the browser console.
document.getElementById('logout-modal')?.addEventListener('hide.bs.modal', () => {
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
});

// ─── Facility Tree ───────────────────────────────────────────────────────

const FACILITY_KEY = 'art.selectedFacility';   // localStorage key
let _selectedFacility = null;   // { id, name, countyId, county, stateId, state }
let _selectedRegister = null;   // 'art' | 'tb' | null (not persisted — reset on each visit)
/** True when the sidebar was auto-collapsed due to portrait orientation (not by user action). */
let _sidebarAutoCollapsed = false;

// ─── Cached rows for monitoring / DQ export ──────────────────────────────
/** Last-rendered rows in the TB Monitoring list — used by the Excel export. */
let _monCurrentRows = [];
/** Last-rendered rows in the Data Quality list — used by the Excel export. */
let _dqCurrentRows  = [];

/** Persist the selected facility to localStorage so it survives page reloads. */
function _saveSelectedFacility(fac) {
  _selectedFacility = fac;
  if (fac) localStorage.setItem(FACILITY_KEY, JSON.stringify(fac));
  else     localStorage.removeItem(FACILITY_KEY);
}

/** Restore a previously selected facility from localStorage. */
function _restoreSelectedFacility() {
  try {
    const raw = localStorage.getItem(FACILITY_KEY);
    _selectedFacility = raw ? JSON.parse(raw) : null;
  } catch { _selectedFacility = null; }
}

/**
 * Fetch the geographic tree from the server and cache it in GeoAreaT.
 * Silently falls back to the local cache when offline.
 * @returns {Promise<Array>} flat list of facility rows
 */
async function fetchGeoTreeData() {
  const token = getToken();
  if (_reallyOnline && token) {
    try {
      const res = await fetch(`${API_BASE}/patients/geo-tree`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const items = await res.json();
        // Cache to SQLite — but don't let a DB error discard valid server data.
        // On mobile Chrome (installed PWA) the DB can be slow to initialise;
        // we always return the server items regardless of whether caching succeeds.
        try { upsertGeoAreaData(items); } catch (cacheErr) {
          console.warn('[Tree] Could not cache geo data locally:', cacheErr.message);
        }
        console.log(`[Tree] Fetched ${items.length} facilities from the eTBr server`);
        return items;
      }
    } catch (err) {
      console.warn('[Tree] eTBr server fetch failed, falling back to cache:', err.message);
    }
  }
  // Offline or fetch failed — return cached data.
  // Wrap in try/catch: if the local SQLite view is missing (e.g. DB init
  // failed partway on mobile) this would otherwise throw uncaught and show
  // "Could not load facilities" instead of the more helpful offline message.
  try {
    const cached = getGeoAreaData();
    console.log(`[Tree] Using ${cached.length} cached facilities`);
    return cached.map(r => ({
      healthFacilityID: r.HealthFacilityID,
      healthFacility:   r.HealthFacility,
      countyID:         r.CountyID,
      county:           r.County,
      stateID:          r.StateID,
      state:            r.State,
      stateShort:       r.StateShort ?? '',
    }));
  } catch (dbErr) {
    console.warn('[Tree] Local cache read failed:', dbErr.message);
    return [];
  }
}

/**
 * Build and render the expandable facility tree inside #facility-tree.
 * @param {Array}  items       - flat list from fetchGeoTreeData()
 * @param {string} filterText  - search/filter term (case-insensitive)
 */
function renderFacilityTree(items, filterText = '') {
  const container = document.getElementById('facility-tree');
  if (!container) return;

  const term = filterText.trim().toLowerCase();

  // Group items: state → county → facilities
  const states = new Map();
  for (const it of items) {
    if (term && !it.healthFacility.toLowerCase().includes(term)
             && !it.county.toLowerCase().includes(term)
             && !it.state.toLowerCase().includes(term)) continue;

    if (!states.has(it.stateID))
      states.set(it.stateID, { name: it.state, counties: new Map() });
    const stateObj = states.get(it.stateID);

    if (!stateObj.counties.has(it.countyID))
      stateObj.counties.set(it.countyID, { name: it.county, facilities: [] });
    stateObj.counties.get(it.countyID).facilities.push(it);
  }

  if (states.size === 0) {
    container.innerHTML = term
      ? `<p class="tree-empty">No facilities match "<em>${escHtml(filterText)}</em>".</p>`
      : `<p class="tree-empty">No facilities available. Connect to the internet to load facility data.</p>`;
    return;
  }

  let html = `<ul class="tree-list tree-list--country">
<li class="tree-node tree-node--country">
  <details class="tree-details" open>
    <summary class="tree-summary tree-summary--country">
      <span class="tree-toggle-box"></span>
      <span>South Sudan</span>
    </summary>
    <ul class="tree-list tree-list--state">`;
  for (const [, stateObj] of [...states.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const stateOpen = term ? ' open' : '';
    html += `<li class="tree-node tree-node--state">
      <details class="tree-details"${stateOpen}>
        <summary class="tree-summary tree-summary--state">
          <span class="tree-toggle-box"></span>
          <span>${escHtml(stateObj.name)}</span>
        </summary>
        <ul class="tree-list tree-list--county">`;

    for (const [, countyObj] of [...stateObj.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const countyOpen = term ? ' open' : '';
      html += `<li class="tree-node tree-node--county">
          <details class="tree-details"${countyOpen}>
            <summary class="tree-summary tree-summary--county">
              <span class="tree-toggle-box"></span>
              <span>${escHtml(countyObj.name)} County</span>
            </summary>
            <ul class="tree-list tree-list--facility">`;

      for (const fac of countyObj.facilities.sort((a, b) => a.healthFacility.localeCompare(b.healthFacility))) {
        const isSelected = _selectedFacility && _selectedFacility.id === fac.healthFacilityID;
        html += `<li class="tree-node tree-node--facility${isSelected ? ' tree-node--selected' : ''}">
                <button class="tree-facility-btn" type="button"
                  data-fid="${fac.healthFacilityID}"
                  data-fname="${escHtml(fac.healthFacility)}"
                  data-cid="${fac.countyID}"
                  data-cname="${escHtml(fac.county)}"
                  data-sid="${fac.stateID}"
                  data-sname="${escHtml(fac.state)}">
                  ${escHtml(fac.healthFacility)}
                </button>
              </li>`;
      }

      html += `</ul>
          </details>
        </li>`;
    }

    html += `</ul>
      </details>
    </li>`;
  }
  html += `</ul>
  </details>
</li>
</ul>`;
  container.innerHTML = html;
}

/** Load geo-tree data and render the tree (call when entering the register). */
async function loadAndRenderGeoTree() {
  const container = document.getElementById('facility-tree');
  if (container) container.innerHTML = '<p class="tree-loading">Loading facilities\u2026</p>';
  try {
    const items = await fetchGeoTreeData();
    // Store a flat reference for search filtering
    const treeEl = document.getElementById('facility-tree');
    if (treeEl) treeEl._treeData = items;
    renderFacilityTree(items);
  } catch (err) {
    console.error('[Tree] Failed to load tree:', err);
    const container2 = document.getElementById('facility-tree');
    if (container2) container2.innerHTML =
      '<p class="tree-empty">Could not load facilities. ' +
      '<button type="button" class="btn btn-sm btn-outline-primary mt-2" ' +
      'onclick="loadAndRenderGeoTree()">Retry</button></p>';
  }
}

/**
 * Promise-based Bootstrap confirm modal — replaces native confirm().
 * @param {string} title    - Modal header text
 * @param {string} message  - Body text (supports \n for line breaks)
 * @param {string} [okLabel='OK'] - Label for the confirm button
 * @returns {Promise<boolean>}
 */
function showGenericConfirmModal(title, message, okLabel = 'OK') {
  return new Promise(resolve => {
    const modalEl = document.getElementById('generic-confirm-modal');
    const titleEl = document.getElementById('generic-confirm-label');
    const msgEl   = document.getElementById('generic-confirm-msg');
    const okBtn   = document.getElementById('generic-confirm-ok');
    const canBtn  = document.getElementById('generic-confirm-cancel');
    if (!modalEl || !okBtn || !canBtn) { resolve(true); return; }
    if (titleEl) titleEl.textContent = title;
    if (msgEl)   msgEl.innerHTML     = message;
    if (okBtn)   okBtn.textContent   = okLabel;

    const backdrop = document.createElement('div');
    backdrop.id = 'generic-confirm-backdrop';
    backdrop.className = 'modal-backdrop fade';
    document.body.appendChild(backdrop);
    requestAnimationFrame(() => backdrop.classList.add('show'));

    modalEl.style.display = 'block';
    modalEl.removeAttribute('aria-hidden');
    modalEl.setAttribute('aria-modal', 'true');
    requestAnimationFrame(() => modalEl.classList.add('show'));

    function cleanup(result) {
      okBtn.removeEventListener('click', onOk);
      canBtn.removeEventListener('click', onCancel);
      modalEl.classList.remove('show');
      modalEl.style.display = '';
      modalEl.setAttribute('aria-hidden', 'true');
      modalEl.removeAttribute('aria-modal');
      const bd = document.getElementById('generic-confirm-backdrop');
      if (bd) bd.remove();
      resolve(result);
    }
    function onOk()     { cleanup(true);  }
    function onCancel() { cleanup(false); }
    okBtn.addEventListener('click', onOk);
    canBtn.addEventListener('click', onCancel);
  });
}

/**
 * One-button informational modal (no Cancel). Resolves when OK is clicked.
 */
function showGenericInfoModal(title, message) {
  const canBtn = document.getElementById('generic-confirm-cancel');
  if (canBtn) canBtn.hidden = true;
  return showGenericConfirmModal(title, message, 'OK').finally(() => {
    const cb = document.getElementById('generic-confirm-cancel');
    if (cb) cb.hidden = false;
  });
}

/**
 * Called when the user taps a facility in the tree.
 * If currently editing a patient, ask for confirmation first.
 * @param {{id,name,countyId,county,stateId,state}} fac
 */
async function selectFacility(fac) {
  function doSelect() {
    _saveSelectedFacility(fac);
    updateFacilityBanner();
    applyFacilityGate();
    // showToast(`Facility selected: ${fac?.name || 'Unknown facility'} Selected`, 'success');
    showToast(`${fac?.name || 'Unknown facility'}`, 'success');

    // Re-render tree to update selected highlight
    const tree = document.getElementById('facility-tree');
    if (tree && tree._treeData) renderFacilityTree(tree._treeData, document.getElementById('tree-search')?.value || '');
    // Close sidebar on mobile after selection; auto-collapse on portrait tablet/desktop
    if (window.innerWidth < 768) {
      _closeSidebar();
    } else if (window.innerWidth < window.innerHeight) {
      _setSidebarCollapsed(true);
      _sidebarAutoCollapsed = true;
    }
  }

  if (_editingTID) {
    // Confirm facility change while editing a patient
    const confirmed = await showGenericConfirmModal(
      'Change Facility?',
      'Changing the facility will exit edit mode and start a new patient.\n\nContinue?'
    );
    if (!confirmed) return;
    exitEditMode();
    form.reset();
    _resetFormUI();
  }
  doSelect();
  // Warn if the newly selected facility has no baseline data (write users only)
  if (typeof window._blCheckAndWarnBaseline === 'function' && fac?.id) {
    window._blCheckAndWarnBaseline(fac.id);
  }
}

/** Show/hide the facility-required and selected-facility banners. */
function updateFacilityBanner() {
  const reqBanner = document.getElementById('facility-required-banner');
  const selBanner = document.getElementById('selected-facility-banner');
  const content   = document.getElementById('register-content');
  const topLabel  = document.getElementById('selected-facility-topbar-label');

  if (_selectedFacility) {
    if (reqBanner) reqBanner.hidden = true;
    if (selBanner) selBanner.hidden = false;
    document.getElementById('sfb-name').textContent = _selectedFacility.name;
    document.getElementById('sfb-breadcrumb').textContent = `${_selectedFacility.county} County \u203a ${_selectedFacility.state}`;
    if (topLabel) topLabel.textContent = _selectedFacility.name;
    // Show "Set Baseline Data" / "Update Baseline Data" button for write users only
    const sfbBaselineBtn = document.getElementById('sfb-baseline-btn');
    if (sfbBaselineBtn) {
      sfbBaselineBtn.hidden = !userCanWrite();
      if (userCanWrite()) {
        sfbBaselineBtn.textContent = 'Set Baseline Data'; // reset to default while loading
        // Async: update text once we know if data already exists for this facility
        if (typeof window._blLoadBaseline === 'function') {
          window._blLoadBaseline(_selectedFacility.id).then(existing => {
            if (existing) sfbBaselineBtn.textContent = 'Update Baseline Data';
          }).catch(() => {});
        }
      }
    }
  } else {
    if (reqBanner) reqBanner.hidden = false;
    if (selBanner) selBanner.hidden = true;
    if (topLabel) topLabel.textContent = 'Select a Facility';
    const sfbBaselineBtn = document.getElementById('sfb-baseline-btn');
    if (sfbBaselineBtn) sfbBaselineBtn.hidden = true;
  }
}

/** Show or hide the register selector and register content based on facility + register selection. */
function applyFacilityGate() {
  const regSelector = document.getElementById('register-selector');
  const content     = document.getElementById('register-content');
  const artContent  = document.getElementById('art-register-content');
  const tbContent   = document.getElementById('tb-register-content');

  // Keep the dropdown value in sync with the programmatic register selection,
  // and lock it when the patient was opened from monitoring or DQ (no switching mid-edit).
  const regSelect = document.getElementById('register-select');
  if (regSelect) {
    regSelect.value    = _selectedRegister || '';
    regSelect.disabled = !!(_fromMonitoring || _fromDQScreen);
  }

  if (!_selectedFacility) {
    // No facility — hide everything below the facility-required banner
    if (regSelector) regSelector.hidden = true;
    if (content)     content.hidden     = true;
  } else if (!_selectedRegister) {
    // Facility selected, register not yet chosen — show the dropdown
    if (regSelector) regSelector.hidden = false;
    if (content)     content.hidden     = true;
  } else {
    // Both selected — show register content and the correct sub-section
    if (regSelector) regSelector.hidden = false;
    if (content)     content.hidden     = false;
    if (artContent)  artContent.hidden  = (_selectedRegister !== 'art');
    if (tbContent)   tbContent.hidden   = (_selectedRegister !== 'tb');
    // Baseline data button is ART-register-only
    const baselineBtn = document.getElementById('sfb-baseline-btn');
    if (baselineBtn) baselineBtn.hidden = (_selectedRegister !== 'art') || !userCanWrite();
    // Enforce read-only mode for users who cannot enter data
    if (!userCanWrite()) applyReadOnlyMode();
  }
}

// ── Sidebar open / close (mobile) ────────────────────────────────────────

function _openSidebar() {
  const sidebar = document.getElementById('register-sidebar');
  if (sidebar) sidebar.classList.add('sidebar--open');
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'true');
}

function _closeSidebar() {
  const sidebar = document.getElementById('register-sidebar');
  if (sidebar) sidebar.classList.remove('sidebar--open');
  const toggleBtn = document.getElementById('sidebar-toggle-btn');
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', 'false');
}

document.getElementById('sidebar-toggle-btn')?.addEventListener('click', () => {
  const sidebar = document.getElementById('register-sidebar');
  const isOpen  = sidebar?.classList.contains('sidebar--open');
  isOpen ? _closeSidebar() : _openSidebar();
});

document.getElementById('sidebar-close-btn')?.addEventListener('click', _closeSidebar);

// ── Desktop sidebar collapse / expand ────────────────────────────────────
function _setSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('register-sidebar');
  const layout  = sidebar?.closest('.register-layout');
  if (!sidebar || !layout) return;
  sidebar.classList.toggle('sidebar--collapsed', collapsed);
  layout.classList.toggle('sidebar--collapsed', collapsed);
  const btn = document.getElementById('sidebar-collapse-btn');
  if (btn) {
    btn.innerHTML = collapsed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>`;
    btn.setAttribute('aria-label', collapsed ? 'Expand sidebar' : 'Collapse sidebar');
  }
  localStorage.setItem('art.sidebarCollapsed', collapsed ? '1' : '0');
}
document.getElementById('sidebar-collapse-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();   // prevent click bubbling to #register-sidebar expand listener
  const sidebar = document.getElementById('register-sidebar');
  _setSidebarCollapsed(!sidebar?.classList.contains('sidebar--collapsed'));
  _sidebarAutoCollapsed = false;  // user took manual control
});

/** Click anywhere on the collapsed data-entry sidebar bar to re-expand it */
document.getElementById('register-sidebar')?.addEventListener('click', e => {
  const sidebar = document.getElementById('register-sidebar');
  if (sidebar?.classList.contains('sidebar--collapsed') &&
      !e.target.closest('#sidebar-collapse-btn')) {
    _setSidebarCollapsed(false);
    _sidebarAutoCollapsed = false;  // user took manual control
  }
});
if (localStorage.getItem('art.sidebarCollapsed') === '1') _setSidebarCollapsed(true);

// ── Portrait-mode auto-collapse on orientation change ─────────────────────
// When the device rotates into portrait on a tablet/desktop viewport, collapse
// the sidebar if a facility is already selected (avoids wasted left-panel space).
// Rotating back to landscape restores the sidebar only if we auto-collapsed it.
window.addEventListener('resize', () => {
  const registerScreen = document.getElementById('art-register-screen');
  if (!registerScreen || registerScreen.hidden) return;
  if (window.innerWidth < 768) return;  // mobile handles its own overlay state

  const isPortrait = window.innerWidth < window.innerHeight;
  if (isPortrait && _selectedFacility) {
    const sidebar = document.getElementById('register-sidebar');
    if (!sidebar?.classList.contains('sidebar--collapsed')) {
      _setSidebarCollapsed(true);
      _sidebarAutoCollapsed = true;
    }
  } else if (!isPortrait && _sidebarAutoCollapsed) {
    _setSidebarCollapsed(false);
    _sidebarAutoCollapsed = false;
  }
});

document.getElementById('frb-open-sidebar-btn')?.addEventListener('click', _openSidebar);

// ── Register selector: load the chosen register ──────────────────────────

document.getElementById('register-select')?.addEventListener('change', (e) => {
  _selectedRegister = e.target.value || null;
  applyFacilityGate();
  if (_selectedFacility && _selectedRegister === 'art') {
    renderPatients();
    // Re-check baseline warning whenever the user switches to the ART register
    if (typeof window._blCheckAndWarnBaseline === 'function' && _selectedFacility?.id) {
      window._blCheckAndWarnBaseline(_selectedFacility.id);
    }
  }
  if (_selectedFacility && _selectedRegister === 'tb') {
    renderTBPatients();
    // Hide baseline warning — not relevant for the TB register
    const warnBanner = document.getElementById('bl-facility-warn-banner');
    if (warnBanner) warnBanner.hidden = true;
  }
});

// ── Facility tree: click delegation ──────────────────────────────────────

document.getElementById('facility-tree')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tree-facility-btn');
  if (!btn) return;
  // Stop propagation so the click doesn't reach the #register-sidebar expand listener,
  // which would immediately undo the portrait-mode collapse triggered inside selectFacility.
  e.stopPropagation();
  const fac = {
    id:       Number(btn.dataset.fid),
    name:     btn.dataset.fname,
    countyId: Number(btn.dataset.cid),
    county:   btn.dataset.cname,
    stateId:  Number(btn.dataset.sid),
    state:    btn.dataset.sname,
  };
  selectFacility(fac);
});

// ── Facility tree: search ─────────────────────────────────────────────────

document.getElementById('tree-search')?.addEventListener('input', (e) => {
  const tree = document.getElementById('facility-tree');
  if (!tree || !tree._treeData) return;
  renderFacilityTree(tree._treeData, e.target.value);
});

// ── "Change Facility" button ──────────────────────────────────────────────

document.getElementById('sfb-change-btn')?.addEventListener('click', () => {
  _openSidebar();
  document.getElementById('tree-search')?.focus();
});

// ─── Bootstrap ───────────────────────────────────────────────────────────

/**
 * Entry point: initialise the database then render the patient list.
 */
async function bootstrap() {
  try {
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Loading database…';

    // Scope the IndexedDB to the last-logged-in user before opening it.
    // This ensures different accounts on the same device use separate databases.
    setIDBUser(localStorage.getItem('art.lastLoginUser') || '');

    await initDB();
    await populateDropdowns();
    initSelectColours();
    setupFormWiring();
    setupTBFormWiring();
    initDateFields();
    initInputFilters();
    initDuplicateDetection();
    renderPatients();
  } catch (err) {
    console.error('[App] Failed to initialise database:', err);
    showToast('Database initialisation failed. Reload the page.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = SAVE_BTN_HTML;
  }

  // Gate the UI behind auth — show auth screen if no valid JWT is present.
  if (getToken()) {
    showAppScreen();
  } else {
    showAuthScreen();
  }
}

bootstrap();

// ─── Sync feature ────────────────────────────────────────────────────────
//
// ARCHITECTURE OVERVIEW:
//   The PWA always saves data locally first (offline-first).
//   When the user explicitly clicks "Sync Data" the app reads every
//   record from the local SQLite DB and POSTs them to the backend API.
//   The API inserts them into SQL Server — the database credentials never
//   leave the server.
//
// SECURITY NOTE — API KEY IN FRONTEND:
//   The SYNC_API_KEY constant below is visible in the JavaScript bundle
//   to anyone who opens DevTools.  This is an unavoidable limitation of
//   client-side secrets.  The key still provides meaningful defence:
//     • Blocks anonymous bots and scanners that don't know the key.
//     • Can be rotated server-side if it leaks without changing app code.
//   For stronger security, pair this with server-side user authentication
//   (JWT tokens) so individual actors can be revoked independently.
//
//   ▶  Replace the placeholder below with the same value you put in
//      appsettings.json "ApiKey" before deploying.

/**
 * The URL of your deployed .NET Web API.
 * During local development use the address printed by `dotnet run`
 * (e.g. https://localhost:7123).
 * In production use your public API URL.
 */
const SYNC_API_URL       = 'https://api.etbr.org/api/patients/sync-full';
const AUDIT_LOGS_API_URL = 'https://api.etbr.org/api/audit-logs';

/**
 * Shared API key — must match the "ApiKey" value in appsettings.json.
 *
 * SECURITY: See the note above.  Do NOT commit a real production key here.
 * Consider loading it from a build-time environment variable or a separate
 * config file excluded from source control.
 */
const SYNC_API_KEY = 'mzr/st5M8oo+napv3tfX1gY6zyA32hkb7ow4g3lVm28=';

// ─── Sync diagnostic log ──────────────────────────────────────────────────
/** Holds the last 200 timestamped sync log entries. */
const _syncLog = [];

/**
 * Append a timestamped entry to the in-memory sync log.
 * @param {'INFO'|'WARN'|'ERROR'} level
 * @param {string} message
 * @param {*} [extra] - any extra value that will be JSON-serialised
 */
function logSync(level, message, extra) {
  const ts    = new Date().toISOString();
  const entry = extra !== undefined
    ? `[${ts}] ${level}: ${message} — ${JSON.stringify(extra, null, 0)}`
    : `[${ts}] ${level}: ${message}`;
  _syncLog.push(entry);
  if (_syncLog.length > 200) _syncLog.shift();          // keep last 200
  if (level === 'ERROR') console.error('[Sync]', entry);
  else if (level === 'WARN') console.warn('[Sync]', entry);
  else console.log('[Sync]', entry);
}

/** Populate the sync log modal content (called on modal show event). */
function showSyncLogModal() {
  const pre = document.getElementById('sync-log-content');
  if (!pre) return;
  pre.textContent = _syncLog.length
    ? _syncLog.slice().reverse().join('\n')   // newest first
    : '(No sync attempts recorded yet. Press "Sync Data" to begin.)';
}

// Populate content each time the modal is about to open.
document.getElementById('sync-log-modal')?.addEventListener('show.bs.modal', showSyncLogModal);

/**
 * Pushes all pending (Synced = 0) rows from the local AuditLogT table to the
 * server's LogT table via POST /api/audit-logs.
 *
 * Called silently at the end of every successful ART or TB sync so that audit
 * entries accumulated during offline use are eventually recorded on the server.
 * Never throws — audit logging must never break the calling sync flow.
 */
async function _pushAuditLogs() {
  const logs = getPendingAuditLogs();
  if (!logs.length) return;
  const token = getToken();
  if (!token) return;
  try {
    logSync('INFO', `[Audit] Pushing ${logs.length} pending audit log entries to server`);
    const response = await fetch(AUDIT_LOGS_API_URL, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body:    JSON.stringify(logs),
    });
    if (response.ok) {
      const ids = logs.map(l => l.AuditLogID);
      await markAuditLogsSynced(ids);
      logSync('INFO', `[Audit] ${ids.length} audit log entries pushed successfully`);
    } else {
      logSync('WARN', `[Audit] Server rejected audit log push (${response.status}) — will retry on next sync`);
    }
  } catch (err) {
    logSync('WARN', `[Audit] Push failed: ${err.message} — will retry on next sync`);
  }
}

/** Reference to the Sync button injected in index.html. */
const syncBtn = document.getElementById('sync-btn');

/**
 * Keeps the Sync button's visibility in sync with the online/offline state.
 * We don't hide it — we show it but disable it offline so the user knows the
 * feature exists and understands why it isn't clickable.
 */
function updateSyncButtonState() {
  if (!syncBtn) return;

  if (isOfflineSession()) {
    syncBtn.disabled = true;
    syncBtn.title    = 'Offline session — connect to internet and re-authenticate to sync';
  } else if (navigator.onLine) {
    syncBtn.disabled = false;
    syncBtn.title    = 'Send all local records to the central database';
  } else {
    syncBtn.disabled = true;
    syncBtn.title    = 'Sync unavailable while offline';
  }
}

// Keep the button state in step with connectivity changes.
window.addEventListener('online',  updateSyncButtonState);
window.addEventListener('offline', updateSyncButtonState);
updateSyncButtonState();   // set initial state on page load

// ─── Sync: core function ──────────────────────────────────────────────────

/**
 * Sends all local patient records to the server API.
 *
 * @param {boolean} silent
 *   true  — called automatically after save/update; never shows a success
 *           toast (so it doesn't override the "Patient saved" message) but
 *           DOES show an error toast so the user knows if data didn't reach
 *           the server.
 *   false — called by the Sync button; shows full loading state and both
 *           success and error toasts.
 */
let _syncInProgress = false;

async function triggerSync(silent = false, background = false, caller = 'unknown') {
  if (_syncInProgress) {
    logSync('WARN', `Skipped [${caller}] — sync already in progress`);
    return;
  }
  _syncInProgress = true;

  logSync('INFO', `triggerSync called`, { caller, silent, background, online: navigator.onLine, offlineSession: isOfflineSession() });

  if (!navigator.onLine) {
    logSync('WARN', 'Aborted — device is offline');
    if (!silent) showToast('You are offline. Sync is not available.', 'error');
    _syncInProgress = false;
    return;
  }

  const patients       = getAllPtDetailsForSync(); // only records with HasChanged = 1
  const patientTIDs    = patients.map(p => p.PtDetailsTID);
  const inhRecords     = getAllINHForSync(patientTIDs);
  const pmtctRecords   = getAllPMTCTForSync(patientTIDs);
  const regimenHistory = getAllRegimenHistoryForSync(patientTIDs);
  const followUps      = getAllFollowUpsForSync(patientTIDs);

  logSync('INFO', 'Local records found', {
    patients:  patients.length,
    inh:       inhRecords.length,
    pmtct:     pmtctRecords.length,
    regimen:   regimenHistory.length,
    followUps: followUps.length,
  });

  if (patients.length === 0) {
    logSync('INFO', 'Aborted — no changes to sync');
    if (!silent) showToast('No changes to sync — all records are up to date.', '');
    _syncInProgress = false;
    return;
  }

  if (!silent) {
    syncBtn.disabled = true;
    syncBtn.classList.add('syncing');
    syncBtn.textContent = 'Syncing…';
  }

  try {
    // Build a complete payload — patients plus all child-table records.
    const payload = {
      patients: patients.map(p => ({
        PtDetailsTID:         p.PtDetailsTID,
        HasChanged:           p.HasChanged,
        HIVRetest:            p.HIVRetest,
        ARTNo:                p.ARTNo,
        ARTStartDate:         p.ARTStartDate         || null,
        DateEnrolledInCare:   p.DateEnrolledInCare   || null,
        PtName:             p.PtName,
        ResidenceAddress:     p.ResidenceAddress     || null,
        Phone1:               p.Phone1               || null,
        Phone2:               p.Phone2               || null,
        OccupationID:         p.OccupationID,
        OccupationOther:      p.OccupationOther      || null,
        KeyPopuID:            p.KeyPopuID,
        KeyPopuOther:         p.KeyPopuOther         || null,
        Age:                  p.Age,
        DateOfBirth:          p.DateOfBirth          || null,
        SexID:                p.SexID,
        WeightKg:             p.WeightKg             ?? null,
        HeightCm:             p.HeightCm             ?? null,
        MUACCm:               p.MUACCm               ?? null,
        BMI:                  p.BMI                  ?? null,
        WHOStageID:           p.WHOStageID,
        CD4Value:             p.CD4Value             ?? null,
        CD4IsPercent:         p.CD4IsPercent,
        CPTStartDate:         p.CPTStartDate         || null,
        CPTDrugID:            p.CPTDrugID,
        TBRxStartDate:        p.TBRxStartDate        || null,
        UnitTBNo:             p.UnitTBNo             || null,
        TBStatusID:           p.TBStatusID,
        BreastfeedingID:      p.BreastfeedingID,
        IsTransferIn:         p.IsTransferIn,
        TransferFromFacility: p.TransferFromFacility || null,
        GuardianName:         p.GuardianName         || null,
        GuardianPhone1:       p.GuardianPhone1       || null,
        NearestHFID:          p.NearestHFID          || 0,
        Deleted:              p.Deleted              ?? 0,
      })),
      inhRecords: inhRecords.map(r => ({
        INHProphylaxisTID: r.INHProphylaxisTID,
        PtDetailsTID:      r.PtDetailsTID,
        SequenceNo:        r.SequenceNo,
        INHDate:           r.INHDate || null,
        HasChanged:        r.HasChanged,
      })),
      pmtctRecords: pmtctRecords.map(r => ({
        PMTCTPregnancyTID:  r.PMTCTPregnancyTID,
        PtDetailsTID:       r.PtDetailsTID,
        PregnancyNo:        r.PregnancyNo,
        ANCNo:              r.ANCNo || null,
        DeliveryDate:       r.DeliveryDate || null,
        MotherReceivedART:  r.MotherReceivedART,
        InfantReceivedARVs: r.InfantReceivedARVs,
        HasChanged:         r.HasChanged,
      })),
      regimenHistory: regimenHistory.map(r => ({
        RegimenHistoryTID: r.RegimenHistoryTID,
        PtDetailsTID:      r.PtDetailsTID,
        RegimenLine:       r.RegimenLine,
        SequenceNo:        r.SequenceNo,
        RegimenID:         r.RegimenID,
        ChangeReasonID:    r.ChangeReasonID,
        OtherReasonText:   r.OtherReasonText || null,
        EventDate:         r.EventDate || null,
        HasChanged:        r.HasChanged,
      })),
      followUps: followUps.map(r => ({
        PtFollowUpTID:    r.PtFollowUpTID,
        PtDetailsTID:     r.PtDetailsTID,
        VisitDate:        r.VisitDate || null,
        VisitMonth:       r.VisitMonth,
        FollowUpStatusID: r.FollowUpStatusID,
        RegimenID:        r.RegimenID,
        TBStatusID:       r.TBStatusID,
        StopReasonID:     r.StopReasonID,
        StopOtherText:    r.StopOtherText || null,
        WeeksInterrupted: r.WeeksInterrupted,
        WeightKg:         r.WeightKg  ?? null,
        HeightCm:         r.HeightCm  ?? null,
        BMI:              r.BMI       ?? null,
        CPTDrugID:        r.CPTDrugID,
        CD4Value:         r.CD4Value  ?? null,
        CD4IsPercent:     r.CD4IsPercent,
        ViralLoad:        r.ViralLoad || null,
        Notes:            r.Notes    || null,
        HasChanged:       r.HasChanged,
      })),
    };

    logSync('INFO', 'Payload built', {
      patients:  payload.patients.length,
      inh:       payload.inhRecords.length,
      pmtct:     payload.pmtctRecords.length,
      regimen:   payload.regimenHistory.length,
      followUps: payload.followUps.length,
    });

    const token = getToken();
    if (!token) {
      const rawToken  = !!localStorage.getItem(AUTH_TOKEN_KEY);
      const rawExpiry = localStorage.getItem(AUTH_EXPIRY_KEY);
      const isExpired = rawExpiry ? new Date() >= new Date(rawExpiry) : null;
      logSync('ERROR', 'No auth token', { caller, tokenExists: rawToken, expiry: rawExpiry, now: new Date().toISOString(), expired: isExpired });
      showToast('Please sign in before syncing.', 'error');
      showAuthScreen();
      return;
    }
    const expiry = localStorage.getItem(AUTH_EXPIRY_KEY);
    logSync('INFO', 'Auth token OK', { caller, expiry, now: new Date().toISOString() });

    logSync('INFO', `POST ${SYNC_API_URL}`);
    const response = await fetch(SYNC_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(payload)
    });

    logSync('INFO', 'Response received', { status: response.status, ok: response.ok, statusText: response.statusText });

    // Expired / invalid token — force re-login
    if (response.status === 401) {
      logSync('ERROR', '401 Unauthorized — clearing auth and forcing re-login');
      clearAuth();
      showAuthScreen();
      showToast('Session expired. Please sign in again.', 'error');
      return;
    }

    if (response.ok) {
      const data = await response.json();
      logSync('INFO', 'Sync successful', data);
      // Mark all synced records as clean (HasChanged = 0) on this device.
      // They will be re-flagged HasChanged = 1 the next time they are edited.
      await markRecordsSynced(patientTIDs);
      // Record the timestamp so the dashboard "Last Synced" stat stays current.
      localStorage.setItem('art.lastSync', new Date().toISOString());
      await _pushAuditLogs();
      updateDashboardStats();
      if (!silent) {
        showToast(data.message ?? 'Sync successful!', 'success');
      } else if (!background) {
        // Auto-sync after save: show a brief confirmation once the network
        // round-trip completes. The natural latency means the "Patient saved"
        // toast will already have been visible for a moment before this appears.
        showToast('Record synced to the eTBr server successfully.', 'success');
      }
      // background=true: fully silent � success is recorded in the sync log only
    } else {
      let rawBody = '';
      try { rawBody = await response.text(); } catch { /* ignore */ }
      let errorMsg = `Sync failed (${response.status})`;
      try {
        const errData = JSON.parse(rawBody);
        errorMsg = errData.error ?? errData.message ?? errorMsg;
      } catch { /* non-JSON error body */ }
      logSync('ERROR', `eTBr server error ${response.status}`, { errorMsg, rawBody: rawBody.slice(0, 500) });
      if (!background) {
        // Show sync error � user needs to know data didn't reach the eTBr server.
        showToast(
        silent ? 'Auto-sync failed — tap "Sync Data" to retry.' : `${errorMsg}. Please try again.`,
          'error'
        );
      }
      // background=true: error is logged only � periodic sync will retry automatically
    }

  } catch (err) {
    logSync('ERROR', `Network/JS exception: ${err.message}`, { stack: err.stack?.split('\n').slice(0, 4) });
    if (!background) {
      showToast(
      silent ? 'Auto-sync failed — check your connection.' : 'Could not reach the eTBr server. Check your connection and retry.',
        'error'
      );
    }
  } finally {
    if (!silent) {
      syncBtn.disabled = false;
      syncBtn.classList.remove('syncing');
      syncBtn.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16" aria-hidden="true">
          <path d="M23 4v6h-6"/>
          <path d="M1 20v-6h6"/>
          <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/>
        </svg>
        Sync Data
      `;
      updateSyncButtonState();
    }
    _syncInProgress = false;
  }
}

// ─── Auto-sync when connectivity is restored ────────────────────────────
// Fires silently so offline-collected data is uploaded as soon as the
// device comes back online, without the user needing to tap "Sync Data".
window.addEventListener('online', () => {
  if (isOfflineSession()) {
    _showReauthBanner();
    return;
  }
  if (getToken()) {
    triggerSync(true, true, 'online-restored');
    triggerTBSync(true, true, 'online-restored-tb');
  }
});

// ─── Inactivity timeout ───────────────────────────────────────────────────
// Healthcare requirement: auto-logout after a period of browser inactivity to
// protect patient-record confidentiality.
//
// Behaviour:
//   • 13 minutes of no interaction → show a warning modal with countdown.
//   • 2 more minutes without interaction → automatically sign out.
//   • Any interaction (click, keystroke, touch, scroll) resets the clock and
//     dismisses the warning if visible.
//   • Timer is started when the user enters the main app and stopped on logout.
//
// The warning threshold and logout threshold are tunable via the constants below.
const INACTIVITY_WARN_MS   = 13 * 60 * 1000;  // 13 min → show warning
const INACTIVITY_LOGOUT_MS =  2 * 60 * 1000;  //  2 min after warning → log out

let _inactivityWarnTimer   = null;
let _inactivityLogoutTimer = null;
let _inactivityCountdown   = null;
let _lastActivityReset     = 0;

function _inactivitySignOut() {
  _stopInactivityWatcher();
  // Mirror the manual-logout flow: keep user profile for offline-PIN, remove token.
  localStorage.removeItem(AUTH_TOKEN_KEY);
  localStorage.removeItem(AUTH_EXPIRY_KEY);
  showToast('You were signed out due to inactivity.', 'info');
  showAuthScreen();
}

function _resetInactivityTimers() {
  // Hide warning modal if visible.
  const modal = document.getElementById('inactivity-modal');
  if (modal) modal.hidden = true;

  // Cancel any running logout countdown.
  if (_inactivityLogoutTimer) { clearTimeout(_inactivityLogoutTimer);  _inactivityLogoutTimer = null; }
  if (_inactivityCountdown)   { clearInterval(_inactivityCountdown);   _inactivityCountdown   = null; }

  // Re-arm the warn timer.
  clearTimeout(_inactivityWarnTimer);
  _inactivityWarnTimer = setTimeout(_showInactivityWarning, INACTIVITY_WARN_MS);
}

// Debounced activity handler — fires at most once every 10 seconds so
// mousemove doesn't hammer setTimeout/clearTimeout on every pixel.
function _onUserActivity() {
  const now = Date.now();
  if (now - _lastActivityReset < 10_000) return;
  _lastActivityReset = now;
  _resetInactivityTimers();
}

function _showInactivityWarning() {
  // Build the modal once, reuse on subsequent warnings.
  let modal = document.getElementById('inactivity-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'inactivity-modal';
    modal.style.cssText =
      'position:fixed;inset:0;z-index:99998;background:rgba(15,23,42,0.65);' +
      'display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = `
      <div style="background:#fff;border-radius:12px;padding:2rem 2rem 1.75rem;max-width:380px;
                  width:calc(100% - 2rem);text-align:center;box-shadow:0 24px 64px rgba(0,0,0,0.35);">
        <div style="font-size:2.25rem;line-height:1;margin-bottom:0.65rem;">&#x23F1;</div>
        <h3 style="margin:0 0 0.5rem;color:#0f172a;font-size:1.05rem;font-weight:700;">
          Session Expiring Soon
        </h3>
        <p style="margin:0 0 0.25rem;color:#475569;font-size:0.875rem;line-height:1.55;">
          No activity has been detected. To protect patient data,<br>
          you will be signed out in
        </p>
        <p style="margin:0 0 1.5rem;font-size:1.75rem;font-weight:700;color:#dc2626;
                  letter-spacing:0.04em;" id="inactivity-countdown">2:00</p>
        <div style="display:flex;gap:0.75rem;justify-content:center;flex-wrap:wrap;">
          <button id="inactivity-stay-btn"
            style="background:#2563eb;color:#fff;border:none;border-radius:8px;
                   padding:0.6rem 1.5rem;font-size:0.875rem;font-weight:600;cursor:pointer;
                   min-width:130px;">
            Stay Signed In
          </button>
          <button id="inactivity-logout-btn"
            style="background:#f8fafc;color:#64748b;border:1px solid #e2e8f0;border-radius:8px;
                   padding:0.6rem 1.25rem;font-size:0.875rem;cursor:pointer;min-width:110px;">
            Sign Out Now
          </button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    document.getElementById('inactivity-stay-btn').addEventListener('click', () => {
      _lastActivityReset = 0;  // bypass debounce so the button always works
      _resetInactivityTimers();
    });
    document.getElementById('inactivity-logout-btn').addEventListener('click', _inactivitySignOut);
  }
  modal.hidden = false;

  // Countdown display — ticks every second.
  let secsLeft = Math.round(INACTIVITY_LOGOUT_MS / 1000);
  const cdEl = document.getElementById('inactivity-countdown');
  const tick = () => {
    const m = Math.floor(secsLeft / 60);
    const s = secsLeft % 60;
    if (cdEl) cdEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  };
  tick();
  _inactivityCountdown = setInterval(() => { secsLeft--; tick(); }, 1000);

  // Auto-logout after the grace period elapses.
  _inactivityLogoutTimer = setTimeout(_inactivitySignOut, INACTIVITY_LOGOUT_MS);
}

function _startInactivityWatcher() {
  const events = ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'];
  events.forEach(e => document.addEventListener(e, _onUserActivity, { passive: true }));
  _lastActivityReset = 0;
  _resetInactivityTimers();
}

function _stopInactivityWatcher() {
  const events = ['click', 'keydown', 'mousemove', 'touchstart', 'scroll'];
  events.forEach(e => document.removeEventListener(e, _onUserActivity));
  clearTimeout(_inactivityWarnTimer);
  if (_inactivityLogoutTimer) { clearTimeout(_inactivityLogoutTimer);  _inactivityLogoutTimer = null; }
  if (_inactivityCountdown)   { clearInterval(_inactivityCountdown);   _inactivityCountdown   = null; }
  const modal = document.getElementById('inactivity-modal');
  if (modal) modal.hidden = true;
}

// --- Periodic background sync ------------------------------------------------
// Runs every 5 minutes while the app is open.  Catches the case where the
// page was loaded (or reloaded) while already online — the 'online' event
// never fires in that scenario, so unsynced records would otherwise wait
// until the user manually clicks Sync.  This mirrors the WhatsApp model:
// data queued offline is pushed as soon as a connection is available,
// with or without user intervention.
let _periodicSyncTimer = null;

function startPeriodicSync() {
  stopPeriodicSync();   // clear any stale timer first
  _periodicSyncTimer = setInterval(async () => {
    // If the JWT has expired while the user is online, force them back to login.
    // getToken() already calls clearAuth() on expiry when online, so just
    // redirect to the auth screen to prompt re-authentication.
    if (!getToken() && navigator.onLine) {
      stopPeriodicSync();
      _stopInactivityWatcher();
      showToast('Your session has expired. Please sign in again.', 'error');
      showAuthScreen();
      return;
    }
    if (navigator.onLine && getToken()) {
      await triggerSync(true, true, 'periodic-5min');
      await triggerTBSync(true, true, 'periodic-5min-tb');
      autoRestoreFromServer(true);   // pull ART records entered on other devices
      autoRestoreFromServerTB(true); // pull TB records entered on other devices
    }
  }, 5 * 60 * 1000);   // every 5 minutes
}

function stopPeriodicSync() {
  if (_periodicSyncTimer !== null) {
    clearInterval(_periodicSyncTimer);
    _periodicSyncTimer = null;
  }
}

// ─── Sync: click handler ──────────────────────────────────────────────────

syncBtn?.addEventListener('click', async () => {
  if (!navigator.onLine) {
    showToast('You are offline. Sync is not available.', 'error');
    return;
  }
  await triggerSync(false, false, 'sync-button');
  await triggerTBSync(true, false, 'sync-button-tb');
  await autoRestoreFromServer(true); // also pull records from other devices
  await autoRestoreFromServerTB(true);
});

// ─── Sync log: copy button ───────────────────────────────────────────────
document.getElementById('sync-log-copy-btn')?.addEventListener('click', () => {
  const text = document.getElementById('sync-log-content')?.textContent ?? '';
  navigator.clipboard.writeText(text).then(
    () => showToast('Log copied to clipboard', 'success'),
    () => showToast('Copy failed — select and copy manually', 'error')
  );
});

// ─── Dashboard navigation ─────────────────────────────────────────────────

/** ART Register card */
document.getElementById('dash-goto-data-entry')?.addEventListener('click', async () => {
  if (!await _warnIfMigratingAsync()) return;
  showARTRegister();
});
document.getElementById('dash-goto-data-entry')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _warnIfMigratingAsync().then(ok => ok && showARTRegister()); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  TB MONITORING SCREEN
// ─────────────────────────────────────────────────────────────────────────────

const tbMonitoringScreen = document.getElementById('tb-monitoring-screen');
const tbQualityScreen    = document.getElementById('tb-quality-screen');

/** Current monitoring state */
let _monMode        = 'missed';   // 'missed' | 'due'
let _monCategory    = '2month';   // active category key
let _monFacilityIDs = [];         // [] = all facilities (no filter)
let _fromMonitoring = false;      // true when patient record was opened from monitoring
let _monUseServer   = false;      // true when local DB has no patients → use server API

/**
 * Returns true when the viewport looks like a phone held in landscape
 * (width > height AND height is phone-sized, i.e. < ~560 px).
 * On tablets and desktops the sidebar should stay expanded by default.
 */
function _isLandscapePhone() {
  return window.innerWidth > window.innerHeight && window.innerHeight < 560;
}

/** Navigate to the TB monitoring screen from the dashboard. */
function showTBMonitoring() {
  if (dashboardScreen)    dashboardScreen.hidden    = true;
  if (artRegisterScreen)  artRegisterScreen.hidden  = true;
  if (tbMonitoringScreen) tbMonitoringScreen.hidden = false;
  _fromMonitoring = false;

  // Reset mode / category
  _monMode     = 'missed';
  _monCategory = '2month';
  const missedChk = document.getElementById('mon-missed-chk');
  const dueChk    = document.getElementById('mon-due-chk');
  if (missedChk) missedChk.checked = true;
  if (dueChk)    dueChk.checked    = false;

  // Re-highlight default category row
  document.querySelectorAll('.mon-stat-row').forEach(r => r.classList.remove('mon-stat-row--active'));
  document.getElementById('mon-cat-2month')?.classList.add('mon-stat-row--active');

  // Build or refresh the facility tree (works offline — reads local DB)
  _monBuildTree();

  // On a phone in landscape the sidebar takes too much horizontal space —
  // start it collapsed so the data panel is immediately visible.
  // In portrait (phone or tablet) the CSS already positions the sidebar
  // off-screen; just ensure any previously-open overlay is dismissed.
  if (_isLandscapePhone()) {
    _monSetSidebarCollapsed(true);
  } else if (window.matchMedia('(orientation: portrait)').matches) {
    document.getElementById('mon-sidebar')?.classList.remove('mon-sidebar--open');
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
}

/** Navigate back to dashboard from the monitoring screen. */
function hideTBMonitoring() {
  if (tbMonitoringScreen) tbMonitoringScreen.hidden = true;
  _fromMonitoring = false;
  showDashboard();
}

/**
 * Build the facility tree inside #mon-tree.
 * Uses the same State > County > Facility hierarchy as the reports tree
 * but filters to only facilities that have TB patients in the local DB.
 * Works fully offline — all data comes from local SQLite.
 */
async function _monBuildTree() {
  const treeEl    = document.getElementById('mon-tree');
  const summaryEl = document.getElementById('mon-tree-summary');
  if (!treeEl) return;

  treeEl.innerHTML = '<div class="tree-loading">Loading facilities…</div>';

  try {
    // Get only facilities that have TB patients (local DB, works offline)
    let activeFacs = getMonitoringFacilities(null, null);
    _monUseServer = false;

    // No local data — try to get facility list from server
    if (!activeFacs.length) {
      const token = getToken();
      if (token && _reallyOnline) {
        try {
          const resp = await fetch(`${API_BASE}/tb-patients/monitor-facilities`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            const serverFacs = await resp.json();
            if (Array.isArray(serverFacs) && serverFacs.length) {
              // Use server facility IDs; build geo tree from local vwGeogAreaQ
              activeFacs = serverFacs.map(f => ({ HealthFacilityID: f.HealthFacilityID }));
              _monUseServer = true;
            }
          }
        } catch (_) { /* stay offline */ }
      }
    }

    if (!activeFacs.length) {
      treeEl.innerHTML = '<div class="tree-empty">No TB patients found in this database.</div>';
      _monFacilityIDs = [];
      _monRefreshAll();
      return;
    }

    // Build a set of active facility IDs for fast lookup
    const activeSet = new Set(activeFacs.map(f => f.HealthFacilityID));

    // Get full geo data (local SQLite, also offline)
    const geo = getGeoAreaData().filter(r => activeSet.has(r.HealthFacilityID));

    // Apply the same user scope rules as the reports tree
    const user  = getUser();
    const scope = user ? resolveGeoScope(user, geo) : { level: 'national', stateID: 0, countyID: 0, facilityID: 0 };

    treeEl.innerHTML = '';

    // Group into state → county → facilities
    const stateMap = new Map();
    for (const r of geo) {
      if (!stateMap.has(r.StateID))
        stateMap.set(r.StateID, { name: r.State, counties: new Map() });
      const st = stateMap.get(r.StateID);
      if (!st.counties.has(r.CountyID))
        st.counties.set(r.CountyID, { name: r.County, facilities: [] });
      st.counties.get(r.CountyID).facilities.push({ id: r.HealthFacilityID, name: r.HealthFacility });
    }

    if (!stateMap.size) {
      treeEl.innerHTML = '<div class="tree-empty">No facilities found.</div>';
      _monFacilityIDs = [];
      _monRefreshAll();
      return;
    }

    const mkEl = (tag, cls, txt) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (txt) e.textContent = txt;
      return e;
    };
    const mkCb = (id) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'rpt-tree-cb';
      cb.dataset.level = 'facility'; cb.dataset.id = String(id);
      return cb;
    };
    const toggle = (childrenEl, toggleEl) => {
      const open = childrenEl.classList.toggle('open');
      toggleEl.classList.toggle('open', open);
    };

    const sortedStates = [...stateMap.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

    for (const [stateId, stateData] of sortedStates) {
      const stateNode     = mkEl('div', 'rpt-tree-node rpt-tree-state');
      const stateToggle   = mkEl('span', 'rpt-tree-toggle');
      const stateCb       = document.createElement('input');
      stateCb.type = 'checkbox'; stateCb.className = 'rpt-tree-cb';
      stateCb.dataset.level = 'state'; stateCb.dataset.id = String(stateId);
      const stateLabel    = mkEl('span', 'rpt-tree-label', stateData.name);
      const stateChildren = mkEl('div', 'rpt-tree-children');

      const sortedCounties = [...stateData.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

      for (const [countyId, countyData] of sortedCounties) {
        const countyNode     = mkEl('div', 'rpt-tree-node rpt-tree-county');
        const countyToggle   = mkEl('span', 'rpt-tree-toggle');
        const countyCb       = document.createElement('input');
        countyCb.type = 'checkbox'; countyCb.className = 'rpt-tree-cb';
        countyCb.dataset.level = 'county'; countyCb.dataset.id = String(countyId);
        const countyLabel    = mkEl('span', 'rpt-tree-label', countyData.name);
        const countyChildren = mkEl('div', 'rpt-tree-children');

        const sortedFacs = [...countyData.facilities].sort((a, b) => a.name.localeCompare(b.name));
        for (const fac of sortedFacs) {
          const facNode  = mkEl('div', 'rpt-tree-node rpt-tree-facility');
          const facCb    = mkCb(fac.id);
          const facLabel = mkEl('span', 'rpt-tree-label', fac.name);
          facCb.addEventListener('change', () => { _monRefreshAncestors(); _monTreeChanged(); });
          facLabel.addEventListener('click', () => { if (!facCb.disabled) facCb.click(); });
          facNode.appendChild(facCb);
          facNode.appendChild(facLabel);
          countyChildren.appendChild(facNode);
        }

        countyCb.addEventListener('change', () => {
          countyChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
            if (!cb.disabled) { cb.checked = countyCb.checked; cb.indeterminate = false; }
          });
          countyCb.indeterminate = false;
          _monRefreshAncestors();
          _monTreeChanged();
        });
        countyLabel.addEventListener('click', () => { if (!countyCb.disabled) countyCb.click(); });
        countyToggle.addEventListener('click', () => toggle(countyChildren, countyToggle));

        countyNode.appendChild(countyToggle);
        countyNode.appendChild(countyCb);
        countyNode.appendChild(countyLabel);
        countyNode.appendChild(countyChildren);
        stateChildren.appendChild(countyNode);
      }

      stateCb.addEventListener('change', () => {
        stateChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
          if (!cb.disabled) { cb.checked = stateCb.checked; cb.indeterminate = false; }
        });
        stateCb.indeterminate = false;
        _monTreeChanged();
      });
      stateLabel.addEventListener('click', () => { if (!stateCb.disabled) stateCb.click(); });
      stateToggle.addEventListener('click', () => toggle(stateChildren, stateToggle));

      stateNode.appendChild(stateToggle);
      stateNode.appendChild(stateCb);
      stateNode.appendChild(stateLabel);
      stateNode.appendChild(stateChildren);
      treeEl.appendChild(stateNode);
    }

    // Apply user scope (same logic as reports): pre-check and expand relevant nodes
    _monApplyScope(scope);
    _monTreeChanged();
  } catch (err) {
    if (treeEl) treeEl.innerHTML = `<div class="tree-empty" style="color:var(--danger)">Error loading facilities</div>`;
    console.error('[Monitoring] _monBuildTree:', err);
    _monFacilityIDs = [];
    _monRefreshAll();
  }
}

/** Apply user scope (pre-checks the relevant facility/county/state nodes). */
function _monApplyScope(scope) {
  const treeEl = document.getElementById('mon-tree');
  if (!treeEl) return;

  if (scope.level === 'facility') {
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="facility"][data-id="${scope.facilityID}"]`);
    if (cb) { cb.checked = true; cb.disabled = true; _monExpandAncestors(cb); _monRefreshAncestors(); }
  } else if (scope.level === 'county') {
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="county"][data-id="${scope.countyID}"]`);
    if (cb) { _monExpandToNode(cb); cb.click(); }
  } else if (scope.level === 'state') {
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="state"][data-id="${scope.stateID}"]`);
    if (cb) { _monExpandToNode(cb); cb.click(); }
  } else {
    // National / no scope: check all facilities
    treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]').forEach(cb => { cb.checked = true; });
    _monRefreshAncestors();
  }
}

/** Walk up from a checkbox and open all ancestor containers. */
function _monExpandAncestors(cb) {
  let el = cb.parentElement;
  while (el && el !== document.getElementById('mon-tree')) {
    if (el.classList.contains('rpt-tree-children')) {
      el.classList.add('open');
      const parentToggle = el.parentElement?.querySelector(':scope > .rpt-tree-toggle');
      if (parentToggle) parentToggle.classList.add('open');
    }
    el = el.parentElement;
  }
}

/** Expand the node containing the checkbox AND all its ancestors. */
function _monExpandToNode(cb) {
  const node     = cb.parentElement;
  const children = node.querySelector(':scope > .rpt-tree-children');
  const tog      = node.querySelector(':scope > .rpt-tree-toggle');
  if (children && !children.classList.contains('open')) {
    children.classList.add('open'); if (tog) tog.classList.add('open');
  }
  _monExpandAncestors(cb);
}

/** Re-scan county and state nodes to keep parent checkbox states in sync. */
function _monRefreshAncestors() {
  const treeEl = document.getElementById('mon-tree');
  if (!treeEl) return;
  const setParent = (parentCb, childCbs) => {
    if (!parentCb || !childCbs.length) return;
    const n    = childCbs.filter(c => c.checked).length;
    const nInd = childCbs.filter(c => c.indeterminate).length;
    if (n === 0 && nInd === 0)           { parentCb.checked = false; parentCb.indeterminate = false; }
    else if (n === childCbs.length && !nInd) { parentCb.checked = true;  parentCb.indeterminate = false; }
    else                                 { parentCb.checked = false; parentCb.indeterminate = true;  }
  };
  for (const cn of treeEl.querySelectorAll('.rpt-tree-county')) {
    const ccb  = cn.querySelector(':scope > .rpt-tree-cb');
    const fcbs = [...cn.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-facility > .rpt-tree-cb')];
    setParent(ccb, fcbs);
  }
  for (const sn of treeEl.querySelectorAll('.rpt-tree-state')) {
    const scb  = sn.querySelector(':scope > .rpt-tree-cb');
    const ccbs = [...sn.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-county > .rpt-tree-cb')];
    setParent(scb, ccbs);
  }
}

/**
 * Called whenever any tree checkbox changes.
 * Updates _monFacilityIDs, the showing label, and refreshes all counts.
 */
function _monTreeChanged() {
  const treeEl    = document.getElementById('mon-tree');
  const summaryEl = document.getElementById('mon-tree-summary');
  const showLabel = document.getElementById('mon-showing-label');
  if (!treeEl) return;

  const allFacCbs   = [...treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]')];
  const checkedFacs = allFacCbs.filter(cb => cb.checked);
  const total       = allFacCbs.length;
  const n           = checkedFacs.length;

  // Update _monFacilityIDs (empty = all = no filter)
  _monFacilityIDs = (n === 0 || n === total)
    ? []
    : checkedFacs.map(cb => parseInt(cb.dataset.id, 10));

  // Update tree summary
  if (summaryEl) {
    if (n === 0) {
      summaryEl.textContent = 'No facility selected';
      summaryEl.style.color = 'var(--danger)';
    } else if (n === total) {
      summaryEl.textContent = `All ${total} facilities selected`;
      summaryEl.style.color = '';
    } else {
      summaryEl.textContent = `${n} of ${total} facilit${n === 1 ? 'y' : 'ies'} selected`;
      summaryEl.style.color = 'var(--primary)';
    }
  }

  // Update top showing label
  if (showLabel) {
    if (n === 0) {
      showLabel.textContent = 'No facility selected';
    } else if (n === total) {
      showLabel.textContent = 'All Facilities';
    } else if (n === 1) {
      const label = checkedFacs[0].nextElementSibling?.textContent?.trim() || '1 Facility';
      showLabel.textContent = label;
    } else {
      showLabel.textContent = `${n} Facilities Selected`;
    }
  }

  _monRefreshAll();
}

/** Collapse or expand the monitoring sidebar. */
function _monSetSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('mon-sidebar');
  const layout  = sidebar?.closest('.mon-layout');
  if (!sidebar || !layout) return;
  sidebar.classList.toggle('mon-collapsed', collapsed);
  layout.classList.toggle('mon-collapsed', collapsed);
  const btn = document.getElementById('mon-sidebar-collapse-btn');
  if (btn) {
    btn.innerHTML = collapsed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>`;
    btn.setAttribute('aria-label', collapsed ? 'Expand filter' : 'Collapse filter');
  }
  try { localStorage.setItem('mon.sidebarCollapsed', collapsed ? '1' : '0'); } catch (_) {}
}

/** Recompute all category counts and re-render the active list. */
async function _monRefreshAll() {
  try {
    let counts;
    if (_monUseServer) {
      const token = getToken();
      if (token && _reallyOnline) {
        try {
          const qs = new URLSearchParams({ mode: _monMode });
          _monFacilityIDs.forEach(id => qs.append('facilityIds', id));
          const resp = await fetch(`${API_BASE}/tb-patients/monitor-counts?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(10000),
          });
          if (resp.ok) counts = await resp.json();
        } catch (_) {}
      }
      if (!counts) counts = { sputum2:0, sputum3:0, sputum5:0, sputum6:0, sputum8:0, hiv:0, cpt:0, art:0, hhp:0, outcome:0 };
    } else {
      counts = getTBMonCounts(_monFacilityIDs, _monMode);
    }

    const fmt    = n => String(n).padStart(2, '0');
    const el     = id => document.getElementById(id);

    el('mon-count-2month')  && (el('mon-count-2month').textContent  = fmt(counts.sputum2));
    el('mon-count-3month')  && (el('mon-count-3month').textContent  = fmt(counts.sputum3));
    el('mon-count-5month')  && (el('mon-count-5month').textContent  = fmt(counts.sputum5));
    el('mon-count-6month')  && (el('mon-count-6month').textContent  = fmt(counts.sputum6));
    el('mon-count-8month')  && (el('mon-count-8month').textContent  = fmt(counts.sputum8));
    el('mon-count-hiv')     && (el('mon-count-hiv').textContent     = fmt(counts.hiv));
    el('mon-count-cpt')     && (el('mon-count-cpt').textContent     = fmt(counts.cpt));
    el('mon-count-art')     && (el('mon-count-art').textContent     = fmt(counts.art));
    el('mon-count-hhp')     && (el('mon-count-hhp').textContent     = fmt(counts.hhp));
    el('mon-count-outcome') && (el('mon-count-outcome').textContent = fmt(counts.outcome));

    const sputumHd = document.getElementById('mon-sputum-hd');
    if (sputumHd) {
      sputumHd.textContent = _monMode === 'missed'
        ? 'TB Patients Who Missed Sputum Examination'
        : 'TB Patients Due For Sputum Examination';
    }

    _monSelectCategory(_monCategory);
  } catch (err) {
    console.error('[Monitoring] _monRefreshAll:', err);
  }
}

/** Highlight the chosen category row and render its patient list. */
async function _monSelectCategory(cat) {
  _monCategory = cat;
  document.querySelectorAll('.mon-stat-row').forEach(r => {
    r.classList.toggle('mon-stat-row--active', r.dataset.cat === cat);
    r.setAttribute('aria-pressed', r.dataset.cat === cat ? 'true' : 'false');
  });
  try {
    let rows;
    if (_monUseServer) {
      const tbody = document.getElementById('mon-patient-tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="text-center py-3 text-muted">Loading from server…</td></tr>';
      rows = [];
      const token = getToken();
      if (token && _reallyOnline) {
        try {
          const qs = new URLSearchParams({ mode: _monMode, category: cat });
          _monFacilityIDs.forEach(id => qs.append('facilityIds', id));
          const resp = await fetch(`${API_BASE}/tb-patients/monitor-patients?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) rows = await resp.json();
        } catch (_) {}
      }
    } else {
      rows = getTBMonList(cat, _monMode, _monFacilityIDs);
    }
    _monRenderList(cat, rows);
  } catch (err) {
    const tbody = document.getElementById('mon-patient-tbody');
    if (tbody) tbody.innerHTML =
      `<tr><td colspan="11" class="text-danger text-center py-3">Error: ${escHtml(err.message)}</td></tr>`;
    console.error('[Monitoring] _monSelectCategory:', err);
  }
}

/** Human-readable title for a monitoring category + mode. */
function _monCatTitle(cat, mode) {
  const m = mode === 'missed';
  switch (cat) {
    case '2month':  return (m ? 'MISSED' : 'DUE FOR') + ' Sputum Examination After 2 Months Of DOTS';
    case '3month':  return (m ? 'MISSED' : 'DUE FOR') + ' Sputum Examination After 3 Months Of DOTS';
    case '5month':  return (m ? 'MISSED' : 'DUE FOR') + ' Sputum Examination After 5 Months Of DOTS';
    case '6month':  return (m ? 'MISSED' : 'DUE FOR') + ' Sputum Examination After 6 Months Of DOTS';
    case '8month':  return (m ? 'MISSED' : 'DUE FOR') + ' Sputum Examination After 8 Months Of DOTS (Retreatment)';
    case 'hiv':     return 'Due For HIV Testing';
    case 'cpt':     return 'Due For CPT Prophylaxis';
    case 'art':     return 'Due To Start ART';
    case 'hhp':     return 'With No HHP For Support';
    case 'outcome': return 'DOTS Outcome Missing';
    default:        return cat;
  }
}

/** Render the patient table. */
function _monRenderList(cat, rows) {
  const tbody   = document.getElementById('mon-patient-tbody');
  const titleEl = document.getElementById('mon-list-title');
  const subEl   = document.getElementById('mon-list-subtitle');
  const hintEl  = document.getElementById('mon-list-hint');
  const colHdEl = document.getElementById('mon-late-col-hd');
  if (!tbody) return;

  // Store current rows for export
  _monCurrentRows = rows;

  // Select-all checkbox starts unchecked — user must explicitly choose records to export
  const monSelectAll = document.getElementById('mon-select-all');
  if (monSelectAll) { monSelectAll.checked = false; monSelectAll.indeterminate = false; }

  const isSputum  = ['2month','3month','5month','6month','8month'].includes(cat);
  const isOutcome = cat === 'outcome';

  if (colHdEl) {
    if (isSputum) {
      colHdEl.textContent = _monMode === 'missed' ? 'Days Late' : 'Days Until Due';
      colHdEl.hidden = false;
    } else if (isOutcome) {
      colHdEl.textContent = 'Days Since Rx Start';
      colHdEl.hidden = false;
    } else {
      colHdEl.hidden = true;
    }
  }

  if (titleEl) titleEl.textContent = _monCatTitle(cat, _monMode);

  const n = rows.length;
  if (subEl) {
    if (n === 0)      subEl.textContent = 'No TB Patients Found';
    else if (n === 1) subEl.textContent = 'Found 01 TB Patient';
    else              subEl.textContent = `Found ${String(n).padStart(2, '0')} TB Patients`;
  }
  if (hintEl) {
    hintEl.textContent = n > 0 ? 'HINT: Click any patient row to view or update their medical record' : '';
  }

  if (!n) {
    tbody.innerHTML = `<tr><td colspan="11" class="text-muted text-center py-3">No patients in this category.</td></tr>`;
    return;
  }

  tbody.innerHTML = rows.map(p => {
    let daysCell = '';
    if (isSputum) {
      const d   = p.DaysLate;
      const cls = d > 0 ? 'mon-days-late' : d === 0 ? 'mon-days-today' : 'mon-days-due';
      const lbl = _monMode === 'missed' ? (d > 0 ? '+' + d : '0') : Math.abs(d);
      daysCell = `<td class="${cls}">${lbl}</td>`;
    } else if (isOutcome) {
      daysCell = `<td>${p.DaysSinceStart != null ? p.DaysSinceStart : ''}</td>`;
    }
    return `<tr data-tid="${escHtml(p.PtDetailsTID)}" data-hfid="${p.NearestHFID || 0}" data-hfname="${escHtml(p.HealthFacility || '')}">
      <td>${escHtml(p.UnitTBNo || '')}</td>
      <td>${p.RegDate ? fmtDate(p.RegDate.slice(0, 10)) : ''}</td>
      <td>${escHtml(truncateDisplayName(p.PtName))}</td>
      <td onclick="event.stopPropagation()" style="text-align:center"><input type="checkbox" class="row-check" value="${escHtml(String(p.PtDetailsTID))}" aria-label="Select ${escHtml(p.PtName || '')}"></td>
      <td>${p.Age != null ? p.Age : ''}</td>
      <td>${escHtml(p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : (p.Sex || ''))}</td>
      <td>${escHtml(p.Village || '')}</td>
      <td>${escHtml(p.PtPhone || '')}</td>
      <td>${escHtml(p.HealthFacility || '')}</td>
      <td>${escHtml(p.PtTypeShort || '')}</td>
      ${daysCell}
    </tr>`;
  }).join('');

  // Row click: open patient record in edit mode; track origin so back-btn can return here
  tbody.querySelectorAll('tr[data-tid]').forEach(tr => {
    tr.addEventListener('click', async (e) => {
      if (e.target.classList.contains('row-check') || e.target.type === 'checkbox') return;
      const tid    = tr.dataset.tid;
      const hfid   = Number(tr.dataset.hfid);
      const hfname = tr.dataset.hfname || '';
      if (!tid || !hfid) return;

      const facInfo = getMonitoringFacilityInfo(hfid);
      _fromMonitoring = true;

      if (tbMonitoringScreen) tbMonitoringScreen.hidden = true;
      if (artRegisterScreen)  artRegisterScreen.hidden  = false;

      _saveSelectedFacility({
        id:       hfid,
        name:     hfname,
        county:   facInfo ? (facInfo.County   || '') : '',
        state:    facInfo ? (facInfo.State    || '') : '',
        countyId: facInfo ? (facInfo.CountyID || 0)  : 0,
        stateId:  facInfo ? (facInfo.StateID  || 0)  : 0
      });
      _selectedRegister = 'tb';
      updateFacilityBanner();
      applyFacilityGate();
      window.scrollTo({ top: 0, behavior: 'instant' });
      loadAndRenderGeoTree();   // populate the facility tree (empty when coming from monitoring)
      // Relabel the back button so it's clear where it leads
      const backBtn = document.getElementById('back-to-dashboard-btn');
      if (backBtn) backBtn.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Monitoring`;
      // Show the bottom back-to-monitoring button
      const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
      if (bottomBackBtn) bottomBackBtn.hidden = false;
      _pendingMonCategory = _monCategory;
      await _fetchAndUpsertTBPatientIfNeeded(tid);
      startEditTBPatient(tid);  // editable — not read-only
    });
  });
}

// ── Monitoring event listeners ────────────────────────────────────────────

document.getElementById('mon-back-btn')?.addEventListener('click', hideTBMonitoring);

document.getElementById('mon-stats-panel')?.addEventListener('click', e => {
  const row = e.target.closest('.mon-stat-row[data-cat]');
  if (row) _monSelectCategory(row.dataset.cat);
});
document.getElementById('mon-stats-panel')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    const row = e.target.closest('.mon-stat-row[data-cat]');
    if (row) { e.preventDefault(); _monSelectCategory(row.dataset.cat); }
  }
});

document.getElementById('mon-missed-chk')?.addEventListener('change', e => {
  if (e.target.checked) {
    _monMode = 'missed';
    const d = document.getElementById('mon-due-chk');
    if (d) d.checked = false;
    _monRefreshAll();
  } else { e.target.checked = true; }
});

document.getElementById('mon-due-chk')?.addEventListener('change', e => {
  if (e.target.checked) {
    _monMode = 'due';
    const m = document.getElementById('mon-missed-chk');
    if (m) m.checked = false;
    _monRefreshAll();
  } else { e.target.checked = true; }
});

/** Sidebar collapse (desktop) */
document.getElementById('mon-sidebar-collapse-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();   // prevent click bubbling to #mon-sidebar expand listener
  const sidebar = document.getElementById('mon-sidebar');
  _monSetSidebarCollapsed(!sidebar?.classList.contains('mon-collapsed'));
});
// Restore collapse state from last session
try {
  if (localStorage.getItem('mon.sidebarCollapsed') === '1') _monSetSidebarCollapsed(true);
} catch (_) {}

/** Mobile sidebar */
document.getElementById('mon-sidebar-toggle-btn')?.addEventListener('click', () => {
  document.getElementById('mon-sidebar')?.classList.toggle('mon-sidebar--open');
});
document.getElementById('mon-sidebar-close-btn')?.addEventListener('click', () => {
  document.getElementById('mon-sidebar')?.classList.remove('mon-sidebar--open');
});

// Close the monitoring sidebar overlay when rotating back to landscape
window.addEventListener('resize', () => {
  const isPortrait = window.matchMedia('(orientation: portrait)').matches;
  if (!isPortrait) {
    // Rotated to landscape — clear overlay state on both screens; desktop CSS takes over
    const monScreen = document.getElementById('tb-monitoring-screen');
    if (monScreen && !monScreen.hidden)
      document.getElementById('mon-sidebar')?.classList.remove('mon-sidebar--open');
    const dqScreen = document.getElementById('tb-quality-screen');
    if (dqScreen && !dqScreen.hidden)
      document.getElementById('dq-sidebar')?.classList.remove('mon-sidebar--open');
  }
});

/** Filter-bar button (funnel icon next to the facility label in the mode bar) */
document.getElementById('mon-filter-bar-btn')?.addEventListener('click', () => {
  const sidebar = document.getElementById('mon-sidebar');
  if (!sidebar) return;
  // Use overlay (slide-in) mode on phones AND portrait tablets;
  // use desktop collapse on landscape tablet/desktop.
  const useOverlay = window.innerWidth <= 768 ||
    window.matchMedia('(orientation: portrait) and (max-width: 1100px)').matches;
  if (useOverlay) {
    sidebar.classList.toggle('mon-sidebar--open');   // portrait/mobile: toggle overlay
  } else {
    _monSetSidebarCollapsed(!sidebar.classList.contains('mon-collapsed')); // desktop: toggle collapse
  }
});

/** Clicking anywhere on the collapsed sidebar bar re-expands it */
document.getElementById('mon-sidebar')?.addEventListener('click', e => {
  const sidebar = document.getElementById('mon-sidebar');
  if (sidebar?.classList.contains('mon-collapsed') &&
      !e.target.closest('#mon-sidebar-collapse-btn')) {
    _monSetSidebarCollapsed(false);
  }
});

document.getElementById('mon-print-btn')?.addEventListener('click', () => window.print());

// ─── Select-all checkbox wiring (event delegation on each table) ───────────

/** Generic select-all handler: wire a table so clicking the header checkbox
 *  checks/unchecks all row-check inputs, and individual row checks update the
 *  header checkbox's indeterminate/checked state. */
function _wireSelectAll(tableId, selectAllId, tbodyId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.addEventListener('change', e => {
    const selectAll = document.getElementById(selectAllId);
    if (e.target.id === selectAllId) {
      // Select-all toggled — sync every row checkbox
      document.querySelectorAll(`#${tbodyId} .row-check`).forEach(cb => {
        cb.checked = e.target.checked;
      });
    } else if (e.target.classList.contains('row-check')) {
      // Individual row toggled — update the header checkbox state
      if (!selectAll) return;
      const all = [...document.querySelectorAll(`#${tbodyId} .row-check`)];
      const checkedCount = all.filter(cb => cb.checked).length;
      selectAll.checked       = checkedCount === all.length;
      selectAll.indeterminate = checkedCount > 0 && checkedCount < all.length;
    }
  });
}

_wireSelectAll('patients-table',    'art-select-all', 'patients-tbody');
_wireSelectAll('tb-patient-table',  'tb-select-all',  'tb-patient-tbody');
_wireSelectAll('mon-patient-table', 'mon-select-all', 'mon-patient-tbody');
_wireSelectAll('dq-patient-table',  'dq-select-all',  'dq-patient-tbody');

/** Returns the TIDs of the currently checked rows in a tbody,
 *  or null if none are checked (caller should export all rows). */
function _getCheckedTIDs(tbodyId) {
  const checked = [...document.querySelectorAll(`#${tbodyId} .row-check:checked`)];
  return checked.length > 0 ? new Set(checked.map(cb => cb.value)) : null;
}

/** Dashboard card → monitoring */
document.getElementById('dash-goto-tb-monitoring')?.addEventListener('click', async () => {
  if (!await _warnIfMigratingAsync()) return;
  showTBMonitoring();
});
document.getElementById('dash-goto-tb-monitoring')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _warnIfMigratingAsync().then(ok => ok && showTBMonitoring()); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  DATA QUALITY CHECK SCREEN
// ─────────────────────────────────────────────────────────────────────────────

/** Current quality screen state */
let _dqCategory    = 'all';
let _dqFacilityIDs = [];   // [] = all facilities (no filter)
let _dqUseServer   = false; // true when local DB has no patients → use server API
let _fromDQScreen       = false; // true when patient record opened from DQ Quality screen
let _fromPreReportDQ    = false; // true when patient record opened from pre-report DQ modal
let _preReportDQReshowFn = null; // set by pre-report DQ row click; called by back-btn to restore modal

/** Navigate to the data quality screen from the dashboard. */
function showTBQuality() {
  if (dashboardScreen)    dashboardScreen.hidden    = true;
  if (artRegisterScreen)  artRegisterScreen.hidden  = true;
  if (tbMonitoringScreen) tbMonitoringScreen.hidden = true;
  if (tbQualityScreen)    tbQualityScreen.hidden    = false;

  _dqCategory    = 'all';
  _dqFacilityIDs = [];

  // Highlight default category row
  document.querySelectorAll('.dq-stat-row').forEach(r => {
    r.classList.remove('dq-stat-row--active');
    r.setAttribute('aria-pressed', 'false');
  });
  const defaultRow = document.getElementById('dq-cat-all');
  if (defaultRow) { defaultRow.classList.add('dq-stat-row--active'); defaultRow.setAttribute('aria-pressed', 'true'); }

  _dqBuildTree();

  // On a phone in landscape the sidebar takes too much horizontal space —
  // start it collapsed so the data panel is immediately visible.
  // In portrait (phone or tablet) the CSS already positions the sidebar
  // off-screen; just ensure any previously-open overlay is dismissed.
  if (_isLandscapePhone()) {
    _dqSetSidebarCollapsed(true);
  } else if (window.matchMedia('(orientation: portrait)').matches) {
    document.getElementById('dq-sidebar')?.classList.remove('mon-sidebar--open');
  }

  window.scrollTo({ top: 0, behavior: 'instant' });
}

/** Navigate back to the dashboard from the quality screen. */
function hideTBQuality() {
  if (tbQualityScreen) tbQualityScreen.hidden = true;
  showDashboard();
}

// ── Facility tree ──────────────────────────────────────────────────────────

async function _dqBuildTree() {
  const treeEl    = document.getElementById('dq-tree');
  const summaryEl = document.getElementById('dq-tree-summary');
  if (!treeEl) return;

  treeEl.innerHTML = '<div class="tree-loading">Loading facilities…</div>';

  try {
    let activeFacs = getMonitoringFacilities(null, null);
    _dqUseServer = false;

    if (!activeFacs.length) {
      const token = getToken();
      if (token && _reallyOnline) {
        try {
          const resp = await fetch(`${API_BASE}/tb-patients/monitor-facilities`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(8000),
          });
          if (resp.ok) {
            const serverFacs = await resp.json();
            if (Array.isArray(serverFacs) && serverFacs.length) {
              activeFacs = serverFacs.map(f => ({ HealthFacilityID: f.HealthFacilityID }));
              _dqUseServer = true;
            }
          }
        } catch (_) {}
      }
    }

    if (!activeFacs.length) {
      treeEl.innerHTML = '<div class="tree-empty">No TB patients found in this database.</div>';
      _dqFacilityIDs = [];
      _dqRefreshAll();
      return;
    }

    const activeSet = new Set(activeFacs.map(f => f.HealthFacilityID));
    const geo       = getGeoAreaData().filter(r => activeSet.has(r.HealthFacilityID));
    const user      = getUser();
    const scope     = user ? resolveGeoScope(user, geo) : { level: 'national', stateID: 0, countyID: 0, facilityID: 0 };

    treeEl.innerHTML = '';

    // Group into state → county → facilities
    const stateMap = new Map();
    for (const r of geo) {
      if (!stateMap.has(r.StateID))
        stateMap.set(r.StateID, { name: r.State, counties: new Map() });
      const st = stateMap.get(r.StateID);
      if (!st.counties.has(r.CountyID))
        st.counties.set(r.CountyID, { name: r.County, facilities: [] });
      st.counties.get(r.CountyID).facilities.push({ id: r.HealthFacilityID, name: r.HealthFacility });
    }

    if (!stateMap.size) {
      treeEl.innerHTML = '<div class="tree-empty">No facilities found.</div>';
      _dqFacilityIDs = [];
      _dqRefreshAll();
      return;
    }

    const mkEl = (tag, cls, txt) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (txt) e.textContent = txt;
      return e;
    };
    const mkCb = (id) => {
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.className = 'rpt-tree-cb';
      cb.dataset.level = 'facility'; cb.dataset.id = String(id);
      return cb;
    };
    const toggle = (childrenEl, toggleEl) => {
      const open = childrenEl.classList.toggle('open');
      toggleEl.classList.toggle('open', open);
    };

    const sortedStates = [...stateMap.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

    for (const [stateId, stateData] of sortedStates) {
      const stateNode     = mkEl('div', 'rpt-tree-node rpt-tree-state');
      const stateToggle   = mkEl('span', 'rpt-tree-toggle');
      const stateCb       = document.createElement('input');
      stateCb.type = 'checkbox'; stateCb.className = 'rpt-tree-cb';
      stateCb.dataset.level = 'state'; stateCb.dataset.id = String(stateId);
      const stateLabel    = mkEl('span', 'rpt-tree-label', stateData.name);
      const stateChildren = mkEl('div', 'rpt-tree-children');

      const sortedCounties = [...stateData.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

      for (const [countyId, countyData] of sortedCounties) {
        const countyNode     = mkEl('div', 'rpt-tree-node rpt-tree-county');
        const countyToggle   = mkEl('span', 'rpt-tree-toggle');
        const countyCb       = document.createElement('input');
        countyCb.type = 'checkbox'; countyCb.className = 'rpt-tree-cb';
        countyCb.dataset.level = 'county'; countyCb.dataset.id = String(countyId);
        const countyLabel    = mkEl('span', 'rpt-tree-label', countyData.name);
        const countyChildren = mkEl('div', 'rpt-tree-children');

        const sortedFacs = [...countyData.facilities].sort((a, b) => a.name.localeCompare(b.name));
        for (const fac of sortedFacs) {
          const facNode  = mkEl('div', 'rpt-tree-node rpt-tree-facility');
          const facCb    = mkCb(fac.id);
          const facLabel = mkEl('span', 'rpt-tree-label', fac.name);
          facCb.addEventListener('change', () => { _dqRefreshAncestors(); _dqTreeChanged(); });
          facLabel.addEventListener('click', () => { if (!facCb.disabled) facCb.click(); });
          facNode.appendChild(facCb);
          facNode.appendChild(facLabel);
          countyChildren.appendChild(facNode);
        }

        countyCb.addEventListener('change', () => {
          countyChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
            if (!cb.disabled) { cb.checked = countyCb.checked; cb.indeterminate = false; }
          });
          countyCb.indeterminate = false;
          _dqRefreshAncestors();
          _dqTreeChanged();
        });
        countyLabel.addEventListener('click', () => { if (!countyCb.disabled) countyCb.click(); });
        countyToggle.addEventListener('click', () => toggle(countyChildren, countyToggle));

        countyNode.appendChild(countyToggle);
        countyNode.appendChild(countyCb);
        countyNode.appendChild(countyLabel);
        countyNode.appendChild(countyChildren);
        stateChildren.appendChild(countyNode);
      }

      stateCb.addEventListener('change', () => {
        stateChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
          if (!cb.disabled) { cb.checked = stateCb.checked; cb.indeterminate = false; }
        });
        stateCb.indeterminate = false;
        _dqTreeChanged();
      });
      stateLabel.addEventListener('click', () => { if (!stateCb.disabled) stateCb.click(); });
      stateToggle.addEventListener('click', () => toggle(stateChildren, stateToggle));

      stateNode.appendChild(stateToggle);
      stateNode.appendChild(stateCb);
      stateNode.appendChild(stateLabel);
      stateNode.appendChild(stateChildren);
      treeEl.appendChild(stateNode);
    }

    _dqApplyScope(scope);
    _dqTreeChanged();

  } catch (err) {
    if (treeEl) treeEl.innerHTML = `<div class="tree-empty" style="color:var(--danger)">Error loading facilities</div>`;
    console.error('[DQ] _dqBuildTree:', err);
    _dqFacilityIDs = [];
    _dqRefreshAll();
  }
}

function _dqApplyScope(scope) {
  const treeEl = document.getElementById('dq-tree');
  if (!treeEl) return;
  if (scope.level === 'facility') {
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="facility"][data-id="${scope.facilityID}"]`);
    if (cb) { cb.checked = true; cb.disabled = true; _dqExpandAncestors(cb); _dqRefreshAncestors(); }
  } else if (scope.level === 'county') {
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="county"][data-id="${scope.countyID}"]`);
    if (cb) { _dqExpandToNode(cb); cb.click(); }
  } else if (scope.level === 'state') {
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="state"][data-id="${scope.stateID}"]`);
    if (cb) { _dqExpandToNode(cb); cb.click(); }
  } else {
    treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]').forEach(cb => { cb.checked = true; });
    _dqRefreshAncestors();
  }
}

function _dqExpandAncestors(cb) {
  let el = cb.parentElement;
  while (el && el !== document.getElementById('dq-tree')) {
    if (el.classList.contains('rpt-tree-children')) {
      el.classList.add('open');
      const parentToggle = el.parentElement?.querySelector(':scope > .rpt-tree-toggle');
      if (parentToggle) parentToggle.classList.add('open');
    }
    el = el.parentElement;
  }
}

function _dqExpandToNode(cb) {
  const node     = cb.parentElement;
  const children = node.querySelector(':scope > .rpt-tree-children');
  const tog      = node.querySelector(':scope > .rpt-tree-toggle');
  if (children && !children.classList.contains('open')) {
    children.classList.add('open'); if (tog) tog.classList.add('open');
  }
  _dqExpandAncestors(cb);
}

function _dqRefreshAncestors() {
  const treeEl = document.getElementById('dq-tree');
  if (!treeEl) return;
  const setParent = (parentCb, childCbs) => {
    if (!parentCb || !childCbs.length) return;
    const n    = childCbs.filter(c => c.checked).length;
    const nInd = childCbs.filter(c => c.indeterminate).length;
    if (n === 0 && nInd === 0)               { parentCb.checked = false; parentCb.indeterminate = false; }
    else if (n === childCbs.length && !nInd) { parentCb.checked = true;  parentCb.indeterminate = false; }
    else                                     { parentCb.checked = false; parentCb.indeterminate = true;  }
  };
  for (const cn of treeEl.querySelectorAll('.rpt-tree-county')) {
    const ccb  = cn.querySelector(':scope > .rpt-tree-cb');
    const fcbs = [...cn.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-facility > .rpt-tree-cb')];
    setParent(ccb, fcbs);
  }
  for (const sn of treeEl.querySelectorAll('.rpt-tree-state')) {
    const scb  = sn.querySelector(':scope > .rpt-tree-cb');
    const ccbs = [...sn.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-county > .rpt-tree-cb')];
    setParent(scb, ccbs);
  }
}

function _dqTreeChanged() {
  const treeEl    = document.getElementById('dq-tree');
  const summaryEl = document.getElementById('dq-tree-summary');
  const showLabel = document.getElementById('dq-showing-label');
  if (!treeEl) return;

  const allFacCbs   = [...treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]')];
  const checkedFacs = allFacCbs.filter(cb => cb.checked);
  const total = allFacCbs.length;
  const n     = checkedFacs.length;

  _dqFacilityIDs = (n === 0 || n === total)
    ? []
    : checkedFacs.map(cb => parseInt(cb.dataset.id, 10));

  if (summaryEl) {
    if (n === 0) {
      summaryEl.textContent = 'No facility selected';
      summaryEl.style.color = 'var(--danger)';
    } else if (n === total) {
      summaryEl.textContent = `All ${total} facilities selected`;
      summaryEl.style.color = '';
    } else {
      summaryEl.textContent = `${n} of ${total} facilit${n === 1 ? 'y' : 'ies'} selected`;
      summaryEl.style.color = '#d97706';
    }
  }
  if (showLabel) {
    if (n === 0)      showLabel.textContent = 'No facility selected';
    else if (n === total) showLabel.textContent = 'All Facilities';
    else if (n === 1) showLabel.textContent = checkedFacs[0].nextElementSibling?.textContent?.trim() || '1 Facility';
    else              showLabel.textContent = `${n} Facilities Selected`;
  }

  _dqRefreshAll();
}

function _dqSetSidebarCollapsed(collapsed) {
  const sidebar = document.getElementById('dq-sidebar');
  const layout  = document.getElementById('dq-layout');
  if (!sidebar) return;
  sidebar.classList.toggle('mon-collapsed', collapsed);
  if (layout) layout.classList.toggle('mon-collapsed', collapsed);
  const btn = document.getElementById('dq-sidebar-collapse-btn');
  if (btn) {
    btn.innerHTML = collapsed
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="9 18 15 12 9 6"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="15 18 9 12 15 6"/></svg>`;
    btn.setAttribute('aria-label', collapsed ? 'Expand filter' : 'Collapse filter');
  }
  try { localStorage.setItem('dq.sidebarCollapsed', collapsed ? '1' : '0'); } catch (_) {}
}

// ── Counts and list rendering ──────────────────────────────────────────────

async function _dqRefreshAll() {
  try {
    let counts;
    if (_dqUseServer) {
      const token = getToken();
      if (token && _reallyOnline) {
        try {
          const qs = new URLSearchParams();
          _dqFacilityIDs.forEach(id => qs.append('facilityIds', id));
          const resp = await fetch(`${API_BASE}/tb-patients/quality-counts?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) counts = await resp.json();
        } catch (_) {}
      }
      if (!counts) counts = { all:0, duplicates:0, skipped:0, sametbno:0, smearcured:0, missingreg:0, nooutcome:0, notevaluated:0, diagmethod:0, norxstart:0, futuredates:0, deleted:0 };
    } else {
      counts = getDQCounts(_dqFacilityIDs);
    }

    const fmt    = n => String(n).padStart(2, '0');
    const setCount = (id, n, isIssue) => {
      const el = document.getElementById(id);
      if (!el) return;
      el.textContent = fmt(n);
      if (isIssue) el.classList.toggle('dq-stat-count--issue', n > 0);
    };

    setCount('dq-count-all',         counts.all,         false);
    setCount('dq-count-duplicates',  counts.duplicates,  true);
    setCount('dq-count-skipped',     counts.skipped,     true);
    setCount('dq-count-sametbno',    counts.sametbno,    true);
    setCount('dq-count-smearcured',  counts.smearcured,  true);
    setCount('dq-count-missingreg',  counts.missingreg,  true);
    setCount('dq-count-nooutcome',    counts.nooutcome,    true);
    setCount('dq-count-notevaluated',  counts.notevaluated, true);
    setCount('dq-count-diagmethod',  counts.diagmethod,  true);
    setCount('dq-count-norxstart',   counts.norxstart,   true);
    setCount('dq-count-futuredates', counts.futuredates, true);
    setCount('dq-count-deleted',     counts.deleted,     true);

    _dqSelectCategory(_dqCategory);
  } catch (err) {
    console.error('[DQ] _dqRefreshAll:', err);
  }
}

async function _dqSelectCategory(cat) {
  _dqCategory = cat;
  document.querySelectorAll('.dq-stat-row').forEach(r => {
    const active = r.dataset.dqcat === cat;
    r.classList.toggle('dq-stat-row--active', active);
    r.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  try {
    let rows;
    if (_dqUseServer) {
      const tbody = document.getElementById('dq-patient-tbody');
      if (tbody) tbody.innerHTML = '<tr><td colspan="11" class="text-center py-3 text-muted">Loading from server…</td></tr>';
      rows = [];
      const token = getToken();
      if (token && _reallyOnline) {
        try {
          const qs = new URLSearchParams({ category: cat });
          _dqFacilityIDs.forEach(id => qs.append('facilityIds', id));
          const resp = await fetch(`${API_BASE}/tb-patients/quality-patients?${qs}`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) rows = await resp.json();
        } catch (_) {}
      }
    } else {
      rows = getDQList(cat, _dqFacilityIDs);
    }
    _dqRenderList(cat, rows);
  } catch (err) {
    const tbody = document.getElementById('dq-patient-tbody');
    if (tbody) tbody.innerHTML =
      `<tr><td colspan="11" class="text-danger text-center py-3">Error: ${escHtml(err.message)}</td></tr>`;
    console.error('[DQ] _dqSelectCategory:', err);
  }
}

function _dqCatTitle(cat) {
  switch (cat) {
    case 'all':         return 'All Patients In The eTBr';
    case 'duplicates':  return 'Patients Entered Twice — Possible Duplicates';
    case 'skipped':     return 'Patients Skipped During Data Entry';
    case 'sametbno':    return 'Patients With The Same TB Treatment Number';
    case 'smearcured':  return 'Smear Negative Patients Declared Cured';
    case 'missingreg':  return 'Patients With Missing Registration Info';
    case 'nooutcome':    return 'Patients With No DOTS Outcome';
    case 'notevaluated': return 'Patients Marked Not Evaluated';
    case 'diagmethod':  return 'Patients With No TB Diagnostic Method Recorded';
    case 'norxstart':   return 'Patients With No Treatment Start Date (Registered >14 Days Ago)';
    case 'futuredates': return 'Patients With Registration Date In The Future';
    case 'deleted':     return 'Deleted Patients — Click Any Row To Restore';
    default:            return cat;
  }
}

function _dqCatHint(cat, n) {
  if (n === 0) return '';
  switch (cat) {
    case 'all':         return 'HINT: Review the list to ensure all patients are correctly registered.';
    case 'duplicates':  return 'HINT: Check each group of same-named patients and delete the duplicate record.';
    case 'skipped':     return '';
    case 'sametbno':    return 'HINT: Correct the TB treatment number for the affected patients.';
    case 'smearcured':  return 'HINT: Change the outcome to "Treatment Completed" for patients who were not bacteriologically confirmed.';
    case 'missingreg':  return 'HINT: Open each patient record and fill in the highlighted missing fields.';
    case 'nooutcome':    return 'HINT: Record the correct DOTS outcome for each patient shown.';
    case 'notevaluated': return 'HINT: Review each patient and update the outcome from "Not Evaluated" to the correct DOTS outcome.';
    case 'diagmethod':  return 'HINT: Open each patient record and select the method used to diagnose TB.';
    case 'norxstart':   return 'HINT: Enter the date treatment was started, or verify whether the patient began treatment.';
    case 'futuredates': return 'HINT: Correct the registration date — it cannot be in the future.';
    case 'deleted':     return 'HINT: Click the Restore button on any row to undelete a patient record that was removed in error.';
    default:            return '';
  }
}

function _dqRenderList(cat, rows) {
  const tbody   = document.getElementById('dq-patient-tbody');
  const titleEl = document.getElementById('dq-list-title');
  const subEl   = document.getElementById('dq-list-subtitle');
  const hintEl  = document.getElementById('dq-list-hint');
  const notesHd = document.getElementById('dq-notes-col-hd');
  if (!tbody) return;

  // Store current rows for export (only patient rows, not gap rows)
  _dqCurrentRows = cat === 'skipped' ? [] : rows;

  // Select-all checkbox starts unchecked — user must explicitly choose records to export
  const dqSelectAll = document.getElementById('dq-select-all');
  if (dqSelectAll) { dqSelectAll.checked = false; dqSelectAll.indeterminate = false; }

  // Toggle between the normal 11-column header and the simplified skipped header
  const theadNormal  = document.getElementById('dq-thead-normal');
  const theadSkipped = document.getElementById('dq-thead-skipped');
  if (theadNormal)  theadNormal.hidden  = (cat === 'skipped');
  if (theadSkipped) theadSkipped.hidden = (cat !== 'skipped');

  // Decide whether the Notes/Issue column is relevant for this category
  const showNotes = ['missingreg', 'smearcured', 'nooutcome', 'notevaluated', 'norxstart', 'futuredates', 'duplicates', 'sametbno', 'deleted'].includes(cat);
  if (notesHd) notesHd.hidden = !showNotes;
  const tbl = document.getElementById('dq-patient-table');
  if (tbl) tbl.classList.toggle('dq-hide-notes', !showNotes);

  if (titleEl) titleEl.textContent = _dqCatTitle(cat);

  const n = rows.length;
  if (subEl) {
    if (n === 0)                subEl.textContent = cat === 'all' ? 'No Patients In The Database' : 'No Issues Found — Congratulations!';
    else if (cat === 'skipped') subEl.textContent = n === 1 ? 'Found 01 TB patient skipped during data entry' : `Found ${String(n).padStart(2, '0')} TB patients skipped during data entry`;
    else if (n === 1)           subEl.textContent = 'Found 01 Patient';
    else                        subEl.textContent = `Found ${String(n).padStart(2, '0')} Patients`;
  }
  if (hintEl) hintEl.textContent = _dqCatHint(cat, n);

  if (n === 0) {
    tbody.innerHTML = `<tr><td colspan="12" class="text-center py-3" style="color:#059669;font-weight:600">${cat === 'all' ? 'No patients in this database yet.' : '✓ No issues found for this check.'}</td></tr>`;
    return;
  }

  // ── Skipped gaps: missing sequence slots, not existing patient records ────
  if (cat === 'skipped') {
    tbody.innerHTML = rows.map(r =>
      `<tr class="dq-row--gap">
        <td>${escHtml(String(r.MissingTBNo).padStart(3, '0'))}/${r.RegYear}</td>
        <td colspan="11" style="text-align:left">${escHtml(r.HealthFacility || '—')}</td>
      </tr>`
    ).join('');
    return;
  }

  const fmtDate = d => {
    if (!d) return '—';
    const parts = d.split('-');
    if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
    return d;
  };
  const esc = escHtml;

  tbody.innerHTML = rows.map(r => {
    // Build notes cell content based on category
    let notes = '';
    if (cat === 'missingreg' && r.MissingFields) {
      notes = `<span class="dq-issue-badge">Missing: ${esc(r.MissingFields)}</span>`;
    } else if (cat === 'smearcured' && r.Outcome) {
      notes = `<span class="dq-issue-badge">Outcome: ${esc(r.Outcome)}</span>`;
    } else if (cat === 'nooutcome' || cat === 'notevaluated') {
      const info = _tbExpectedEndInfo(r);
      if (info) {
        notes = `<span class="dq-issue-badge">Due: ${info.endFmt}<br><span style="color:#dc2626">&#9650; ${info.daysOver}d overdue</span></span>`;
      } else if (r.DaysSinceStart != null) {
        notes = `<span class="dq-issue-badge">${r.DaysSinceStart}d on Rx</span>`;
      }
    } else if (cat === 'norxstart' && r.DaysSinceReg != null) {
      notes = `<span class="dq-issue-badge">${r.DaysSinceReg}d since reg.</span>`;
    } else if (cat === 'futuredates') {
      notes = `<span class="dq-issue-badge">Future date</span>`;
    } else if (cat === 'duplicates') {
      notes = `<span class="dq-issue-badge">Possible duplicate</span>`;
    } else if (cat === 'sametbno' && r.UnitTBNo) {
      notes = `<span class="dq-issue-badge">TB No: ${esc(r.UnitTBNo)}</span>`;
    } else if (cat === 'deleted') {
      notes = `<button class="btn btn-success dq-undelete-btn" data-tid="${esc(String(r.PtDetailsTID))}" data-name="${esc(r.PtName || '')}" onclick="event.stopPropagation()" style="white-space:nowrap;font-size:0.78rem;display:block;height:85%;width:100%;">↩ Restore</button>`;
    }

    const ageDisplay = r.AgeMonths && r.Age === 0
      ? `${r.AgeMonths}m`
      : (r.Age ? String(r.Age) : '—');

    // For the deleted category the notes td has no padding so the Restore
    // button can fill the full row height without expanding it.
    const notesTd = (cat === 'deleted' && notes)
      ? `<td style="padding:0;">${notes}</td>`
      : `<td>${notes || '—'}</td>`;

    return `<tr data-tid="${esc(String(r.PtDetailsTID))}" data-hfid="${r.NearestHFID || 0}" data-hfname="${esc(r.HealthFacility || '')}">
      <td>${esc(r.UnitTBNo || '—')}</td>
      <td>${fmtDate(r.RegDate)}</td>
      <td title="${esc(r.PtName || '')}">${esc(truncateDisplayName(r.PtName))}</td>
      <td onclick="event.stopPropagation()" style="text-align:center"><input type="checkbox" class="row-check" value="${esc(String(r.PtDetailsTID))}" aria-label="Select ${esc(r.PtName || '')}"></td>
      <td>${esc(ageDisplay)}</td>
      <td>${r.SexID === 1 ? 'M' : r.SexID === 2 ? 'F' : '—'}</td>
      <td>${esc(r.TbType || '—')}</td>
      <td>${esc(r.PtTypeShort || '—')}</td>
      ${notesTd}
      <td>${esc((r.DiagMethod || '').replace(/Smear Microscopy/gi, 'Microscopy') || '—')}</td>
      <td>${esc(r.PtPhone || '—')}</td>
      <td>${esc(r.HealthFacility || '—')}</td>
    </tr>`;
  }).join('');

  // Row click: open patient record (edit for writers, view-only for read-only users)
  document.getElementById('dq-patient-table')?.querySelectorAll('tr[data-tid]').forEach(tr => {
    tr.addEventListener('click', async (e) => {
      if (e.target.classList.contains('row-check') || e.target.type === 'checkbox') return;
      const tid    = tr.dataset.tid;
      const hfid   = Number(tr.dataset.hfid);
      const hfname = tr.dataset.hfname || '';
      if (!tid || !hfid) return;

      const facInfo = getMonitoringFacilityInfo(hfid);
      _fromDQScreen = true;

      if (tbQualityScreen)  tbQualityScreen.hidden  = true;
      if (artRegisterScreen) artRegisterScreen.hidden = false;

      _saveSelectedFacility({
        id:       hfid,
        name:     hfname,
        county:   facInfo ? (facInfo.County   || '') : '',
        state:    facInfo ? (facInfo.State    || '') : '',
        countyId: facInfo ? (facInfo.CountyID || 0)  : 0,
        stateId:  facInfo ? (facInfo.StateID  || 0)  : 0
      });
      _selectedRegister = 'tb';
      updateFacilityBanner();
      applyFacilityGate();
      window.scrollTo({ top: 0, behavior: 'instant' });
      loadAndRenderGeoTree();
      const backBtn = document.getElementById('back-to-dashboard-btn');
      if (backBtn) backBtn.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Quality Check`;
      const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
      if (bottomBackBtn) {
        bottomBackBtn.hidden = false;
        bottomBackBtn.innerHTML =
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Back to Data Quality Check`;
      }
      if (userCanWrite()) {
        _pendingDQCategory = cat;
        await _fetchAndUpsertTBPatientIfNeeded(tid);
        startEditTBPatient(tid);
      } else {
        await _fetchAndUpsertTBPatientIfNeeded(tid);
        startViewTBPatient(tid);
      }
    });
  });

  // Restore (undelete) handler — DQ deleted category only
  if (cat === 'deleted') {
    tbody.querySelectorAll('.dq-undelete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        const tid  = btn.dataset.tid;
        const name = _xlTitleCase(btn.dataset.name) || 'This patient';
        const confirmed = await showGenericConfirmModal(
          'Restore Patient Record',
          `Restore <strong>${name}</strong> back to the active register?`,
          'Restore'
        );
        if (!confirmed) return;
        try {
          await undeletePtDetailsTB(tid);
          { const _u = getUser(); await insertAuditLog({ action: 'UNDELETE_TB', ptDetailsTID: tid, notes: `Restored TB patient from Data Quality screen: ${name}`, userTID: _u?.userTID, userName: _u?.fullName ?? _u?.userName }); }
          showToast(`${name} has been restored.`, 'success');
          logSync('INFO', 'Auto-sync: dq-undelete', { online: navigator.onLine });
          if (navigator.onLine) triggerTBSync(true, false, 'dq-undelete');
          _dqRefreshAll();          // update sidebar counts
          _dqSelectCategory('deleted'); // refresh the patient list
        } catch (err) {
          console.error('[DQ] Undelete failed:', err);
          showToast('Could not restore patient. Please try again.', 'error');
        }
      });
    });
  }
}

// ── Quality screen event listeners ─────────────────────────────────────────

document.getElementById('dq-back-btn')?.addEventListener('click', hideTBQuality);

document.getElementById('dq-stats-panel')?.addEventListener('click', e => {
  const row = e.target.closest('.dq-stat-row[data-dqcat]');
  if (row) _dqSelectCategory(row.dataset.dqcat);
});
document.getElementById('dq-stats-panel')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    const row = e.target.closest('.dq-stat-row[data-dqcat]');
    if (row) { e.preventDefault(); _dqSelectCategory(row.dataset.dqcat); }
  }
});

document.getElementById('dq-sidebar-collapse-btn')?.addEventListener('click', (e) => {
  e.stopPropagation();
  const sidebar = document.getElementById('dq-sidebar');
  _dqSetSidebarCollapsed(!sidebar?.classList.contains('mon-collapsed'));
});
try {
  if (localStorage.getItem('dq.sidebarCollapsed') === '1') _dqSetSidebarCollapsed(true);
} catch (_) {}

document.getElementById('dq-sidebar-toggle-btn')?.addEventListener('click', () => {
  document.getElementById('dq-sidebar')?.classList.toggle('mon-sidebar--open');
});
document.getElementById('dq-sidebar-close-btn')?.addEventListener('click', () => {
  document.getElementById('dq-sidebar')?.classList.remove('mon-sidebar--open');
});

/** Filter-bar button (funnel icon next to the facility label in the context bar) */
document.getElementById('dq-filter-bar-btn')?.addEventListener('click', () => {
  const sidebar = document.getElementById('dq-sidebar');
  if (!sidebar) return;
  const useOverlay = window.innerWidth <= 768 ||
    window.matchMedia('(orientation: portrait) and (max-width: 1100px)').matches;
  if (useOverlay) {
    sidebar.classList.toggle('mon-sidebar--open');   // portrait/mobile: toggle overlay
  } else {
    _dqSetSidebarCollapsed(!sidebar.classList.contains('mon-collapsed')); // desktop: toggle
  }
});
document.getElementById('dq-sidebar')?.addEventListener('click', e => {
  const sidebar = document.getElementById('dq-sidebar');
  if (sidebar?.classList.contains('mon-collapsed') &&
      !e.target.closest('#dq-sidebar-collapse-btn')) {
    _dqSetSidebarCollapsed(false);
  }
});

document.getElementById('dq-print-btn')?.addEventListener('click', () => window.print());
document.getElementById('dq-export-excel-btn')?.addEventListener('click', () => exportDQPatientsToExcel());
document.getElementById('mon-export-excel-btn')?.addEventListener('click', () => exportMonPatientsToExcel());

/**
 * Orientation / resize handler: collapse the facility sidebar when the user
 * rotates a phone into landscape while the monitoring or DQ screen is open.
 * Also re-expands when rotating back to portrait so the mobile overlay CSS
 * can take over cleanly (mon-collapsed conflicts with position:fixed layout).
 * Uses a small debounce so the dimensions are stable before we measure.
 */
(function () {
  let _orientationTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(_orientationTimer);
    _orientationTimer = setTimeout(() => {
      const landscape = _isLandscapePhone();
      if (tbMonitoringScreen && !tbMonitoringScreen.hidden) {
        const s = document.getElementById('mon-sidebar');
        if (s) {
          if (landscape && !s.classList.contains('mon-collapsed'))  _monSetSidebarCollapsed(true);
          if (!landscape && s.classList.contains('mon-collapsed'))  _monSetSidebarCollapsed(false);
        }
      }
      if (tbQualityScreen && !tbQualityScreen.hidden) {
        const s = document.getElementById('dq-sidebar');
        if (s) {
          if (landscape && !s.classList.contains('mon-collapsed'))  _dqSetSidebarCollapsed(true);
          if (!landscape && s.classList.contains('mon-collapsed'))  _dqSetSidebarCollapsed(false);
        }
      }
    }, 150);
  });
})();

/** Dashboard card → quality screen */
document.getElementById('dash-goto-tb-quality')?.addEventListener('click', async () => {
  if (!await _warnIfMigratingAsync()) return;
  showTBQuality();
});
document.getElementById('dash-goto-tb-quality')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _warnIfMigratingAsync().then(ok => ok && showTBQuality()); }
});

// ─────────────────────────────────────────────────────────────────────────────
//  PATIENT SEARCH SCREEN
//  Full-screen cross-register search (ART + TB). Opens inline like the
//  monitoring / quality screens — no modal.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch a single TB patient from the server and upsert into the local SQLite DB
 * if the patient is not already present.  Returns true when the patient is
 * available locally after the call (either was already there or was imported).
 * Never throws — network/API failures return false silently.
 */
async function _fetchAndUpsertTBPatientIfNeeded(tid) {
  if (!tid) return false;
  const norm = tid.toLowerCase();
  try { if (getPtDetailsTB(norm)) return true; } catch (_) {}   // already local
  const token = getToken();
  if (!token) return false;
  try {
    const resp = await fetch(`${API_BASE}/tb-patients/${encodeURIComponent(norm)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(12000),
    });
    if (!resp.ok) return false;
    const data = await resp.json();
    await importTBPayloadFromServer(data);
    return true;
  } catch { return false; }
}

(function initPatientSearchModule() {
  const searchScreen = document.getElementById('patient-search-screen');
  if (!searchScreen) return;

  // Track whether the patient form was opened from this screen so the
  // back button can return here with the previous query still active.
  let _fromSearch       = false;
  let _searchQuery      = '';
  let _searchRegister   = '';   // '' | 'ART' | 'TB'

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const inputEl   = document.getElementById('psearch-input');
  const clearBtn  = document.getElementById('psearch-clear-btn');
  const countEl   = document.getElementById('psearch-count');
  const hintEl    = document.getElementById('psearch-hint');
  const tableEl   = document.getElementById('psearch-table');
  const tbodyEl   = document.getElementById('psearch-tbody');
  const emptyEl   = document.getElementById('psearch-empty');
  const chips     = document.querySelectorAll('.psearch-chip');

  // Save the original search-mode thead so we can restore it after browse mode
  const _origTheadHTML = tableEl?.querySelector('thead tr')?.innerHTML ?? '';

  // ── Responsive placeholder ─────────────────────────────────────────────────
  const _phFull  = 'Enter Name, ART No, TB No or phone\u2026';
  const _phShort = 'Name, ART No, TB No\u2026';
  const _phMq    = window.matchMedia('(max-width: 480px)');
  function _updatePlaceholder() {
    if (inputEl) inputEl.placeholder = _phMq.matches ? _phShort : _phFull;
  }
  _updatePlaceholder();
  _phMq.addEventListener('change', _updatePlaceholder);

  // ── Show / hide ────────────────────────────────────────────────────────────
  function showPatientSearch(restoreQuery) {
    if (dashboardScreen)    dashboardScreen.hidden    = true;
    if (artRegisterScreen)  artRegisterScreen.hidden  = true;
    if (tbMonitoringScreen) tbMonitoringScreen.hidden = true;
    if (tbQualityScreen)    tbQualityScreen.hidden    = true;
    searchScreen.hidden = false;
    _fromSearch = false;
    // Always hide the sync bar when entering normal patient search
    const syncBar = document.getElementById('psearch-sync-bar');
    if (syncBar) syncBar.hidden = true;

    if (restoreQuery) {
      // Coming back from a patient record
      if (_browseMode) {
        // Was in browse mode — re-show all patients for that register
        _setChip(_browseReg);
        _showBrowseAll();
      } else {
        inputEl.value = _searchQuery;
        clearBtn.hidden = !_searchQuery;
        _runSearch();
      }
    } else {
      // Fresh open — reset everything including browse mode
      _browseMode     = false;
      _browseReg      = '';
      _searchQuery    = '';
      _searchRegister = '';
      inputEl.value   = '';
      clearBtn.hidden = true;
      _setChip('');
      _restoreSearchUI();
      _showEmpty('Type to search across ART and TB registers.');
    }

    window.scrollTo({ top: 0, behavior: 'instant' });
    setTimeout(() => inputEl?.focus(), 80);
  }

  function hidePatientSearch() {
    searchScreen.hidden = true;
    _fromSearch = false;
    const syncBar = document.getElementById('psearch-sync-bar');
    if (syncBar) syncBar.hidden = true;
    showDashboard();
  }

  // ── Register chip selection ────────────────────────────────────────────────
  function _setChip(reg) {
    _searchRegister = reg;
    chips.forEach(c => c.classList.toggle('psearch-chip--active', c.dataset.reg === reg));
  }

  chips.forEach(chip => {
    chip.addEventListener('click', () => {
      const reg = chip.dataset.reg;
      if (_browseMode) {
        if (reg === '') {
          // "All" clicked — exit browse, switch to search mode
          _browseMode = false;
          _browseReg  = '';
          _setChip('');
          _restoreSearchUI();
          _showEmpty('Type to search across ART and TB registers.');
        } else {
          // Switching register in browse mode
          _browseReg      = reg;
          _searchRegister = reg;
          _setChip(reg);
          _updateBrowseTitle(reg);
          _showBrowseAll();
        }
      } else {
        _setChip(reg);
        _runSearch();
      }
    });
  });

  // ── Input wiring ──────────────────────────────────────────────────────────
  let _debounceTimer = null;

  inputEl?.addEventListener('input', () => {
    _searchQuery = inputEl.value;
    clearBtn.hidden = !_searchQuery;
    clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(_runSearch, 250);
  });

  clearBtn?.addEventListener('click', () => {
    inputEl.value   = '';
    _searchQuery    = '';
    clearBtn.hidden = true;
    _showEmpty('Type to search across ART and TB registers.');
    inputEl.focus();
  });

  // ── Core search ───────────────────────────────────────────────────────────
  function _showEmpty(msg) {
    if (tableEl)  tableEl.hidden  = true;
    if (countEl)  countEl.hidden  = true;
    if (hintEl)   hintEl.hidden   = true;
    if (emptyEl) { emptyEl.hidden = false; emptyEl.querySelector('p').textContent = msg; }
  }

  // Maps server camelCase response → same PascalCase shape as searchAllPatients()
  const _fromServerResult = r => ({
    Register:       r.register,
    PtDetailsTID:   r.ptDetailsTID,
    PtName:         r.ptName,
    PatientNo:      r.patientNo,
    Age:            r.age,
    Sex:            r.sex,
    Phone:          r.phone,
    HealthFacility: r.healthFacility,
    NearestHFID:    r.nearestHFID,
  });

  // Calls GET /api/patients/search and returns normalised results, or null on failure.
  async function _serverSearch(term, register) {
    const token = getToken();
    if (!token || !navigator.onLine) return null;
    try {
      const regParam = register ? `&register=${encodeURIComponent(register)}` : '';
      const resp = await fetch(
        `${API_BASE}/patients/search?q=${encodeURIComponent(term)}${regParam}`,
        { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      return Array.isArray(data) ? data.map(_fromServerResult) : null;
    } catch { return null; }
  }

  async function _runSearch() {
    const term = (_searchQuery || '').trim();
    if (term.length < 1) {
      _showEmpty('Type to search across ART and TB registers.');
      return;
    }

    const register = _searchRegister || null;
    const canWrite = userCanWrite();
    let results;
    let fromServer = false;

    if (canWrite) {
      // ── Data-entry users: local DB is primary ──────────────────────────
      try { results = searchAllPatients(term, register); }
      catch (e) { console.error('[Search] local error:', e); results = []; }

      if (results.length === 0 && navigator.onLine) {
        // Local DB is empty (new device?) — fall back to server
        if (emptyEl) { emptyEl.hidden = false; emptyEl.querySelector('p').textContent = 'Searching server…'; }
        const svr = await _serverSearch(term, register);
        if (svr && svr.length > 0) { results = svr; fromServer = true; }
      }
    } else {
      // ── Read-only users (national/state/county/NTP): no local data ─────
      // Go straight to server; use whatever might be in the local DB offline.
      if (navigator.onLine) {
        if (emptyEl) { emptyEl.hidden = false; emptyEl.querySelector('p').textContent = 'Searching…'; }
        const svr = await _serverSearch(term, register);
        if (svr !== null) { results = svr; fromServer = true; }
        else {
          try { results = searchAllPatients(term, register); }
          catch (e) { console.error('[Search] offline fallback error:', e); results = []; }
        }
      } else {
        // Offline — use local fallback (may be empty)
        try { results = searchAllPatients(term, register); }
        catch (e) { console.error('[Search] offline error:', e); results = []; }
      }
    }

    if (!results || !results.length) {
      _showEmpty(`No patients found for "${escHtml(term)}".`);
      return;
    }

    if (emptyEl)  emptyEl.hidden  = true;
    if (tableEl)  tableEl.hidden  = false;
    if (hintEl)   hintEl.hidden   = false;
    const countLabel = `${results.length} result${results.length !== 1 ? 's' : ''}${fromServer ? ' (eTBr server)' : ''}`;
    if (countEl) { countEl.hidden = false; countEl.textContent = countLabel; }

    tbodyEl.innerHTML = results.map(p => {
      const regBadge = p.Register === 'ART'
        ? '<span class="psearch-badge psearch-badge--art">ART</span>'
        : '<span class="psearch-badge psearch-badge--tb">TB</span>';
      const sex = p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : (p.Sex || '—');
      return `<tr data-tid="${escHtml(p.PtDetailsTID)}"
                  data-reg="${escHtml(p.Register)}"
                  data-hfid="${escHtml(String(p.NearestHFID || 0))}"
                  data-hfname="${escHtml(p.HealthFacility || '')}"
                  data-canwrite="${canWrite}"
                  data-fromsrv="${fromServer}"
                  role="button" tabindex="0" style="cursor:pointer">
        <td>${regBadge}</td>
        <td>${escHtml(_xlTitleCase(p.PtName) || '—')}</td>
        <td>${escHtml(p.PatientNo || '—')}</td>
        <td>${p.Age != null ? p.Age : '—'}</td>
        <td>${sex}</td>
        <td>${escHtml(p.Phone || '—')}</td>
        <td>${escHtml(p.HealthFacility || '—')}</td>
      </tr>`;
    }).join('');

    // Event delegation — one handler on the tbody survives innerHTML replacement
    tbodyEl.onclick = e => {
      const tr = e.target.closest('tr[data-tid]');
      if (tr) _openPatient(tr);
    };
    tbodyEl.onkeydown = e => {
      if (e.key === 'Enter' || e.key === ' ') {
        const tr = e.target.closest('tr[data-tid]');
        if (tr) { e.preventDefault(); _openPatient(tr); }
      }
    };
  }

  // ── Open a patient record from search results ──────────────────────────────
  async function _openPatient(tr) {
    const tid      = (tr.dataset.tid || '').toLowerCase();   // SQLite stores GUIDs lowercase
    const reg      = tr.dataset.reg;       // 'ART' | 'TB'
    const hfid     = Number(tr.dataset.hfid);
    const hfname   = tr.dataset.hfname || '';
    const canWrite = tr.dataset.canwrite === 'true';
    const fromSvr  = tr.dataset.fromsrv === 'true';

    if (!tid) return;

    // ── Immediately navigate away from the search screen ─────────────────
    _fromSearch = true;
    _searchQuery = inputEl?.value || '';
    searchScreen.hidden = true;

    const facInfo = getMonitoringFacilityInfo(hfid);
    if (artRegisterScreen) artRegisterScreen.hidden = false;

    _saveSelectedFacility({
      id:       hfid,
      name:     hfname,
      county:   facInfo ? (facInfo.County   || '') : '',
      state:    facInfo ? (facInfo.State    || '') : '',
      countyId: facInfo ? (facInfo.CountyID || 0)  : 0,
      stateId:  facInfo ? (facInfo.StateID  || 0)  : 0
    });
    _selectedRegister = reg === 'TB' ? 'tb' : 'art';
    updateFacilityBanner();
    applyFacilityGate();
    window.scrollTo({ top: 0, behavior: 'instant' });
    loadAndRenderGeoTree();

    const backBtn = document.getElementById('back-to-dashboard-btn');
    if (backBtn) backBtn.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Search Results`;

    // ── If the result came from a server search, fetch and upsert locally ─
    // Runs after the screen has already transitioned so the user sees
    // an immediate response. The form-population call below waits for this.
    if (fromSvr) {
      const token = getToken();
      if (token) {
        try {
          const endpoint = reg === 'TB'
            ? `${API_BASE}/tb-patients/${encodeURIComponent(tid)}`
            : `${API_BASE}/patients/${encodeURIComponent(tid)}`;
          const resp = await fetch(endpoint, {
            headers: { Authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(15000),
          });
          if (resp.ok) {
            const payload = await resp.json();
            if (reg === 'TB') {
              await importTBPayloadFromServer(payload);
            } else {
              await importFullPayloadFromServer(payload);
            }
          } else {
            console.warn('[Search] Pre-fetch returned', resp.status, 'for', tid);
          }
        } catch (e) {
          console.warn('[Search] Could not pre-fetch patient record from server:', e);
        }
      }
    }

    if (reg === 'TB') {
      // ── Open TB patient ──────────────────────────────────────────────────
      const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
      if (bottomBackBtn) {
        bottomBackBtn.hidden = false;
        bottomBackBtn.innerHTML =
          `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Back to Search Results`;
      }

      if (canWrite) {
        startEditTBPatient(tid);
      } else {
        startViewTBPatient(tid);
      }

    } else {
      // ── Open ART patient ─────────────────────────────────────────────────
      // applyFacilityGate → applyReadOnlyMode hides the form card for read-only
      // users, but we need it visible to show the patient's data.
      const _artFormCard = document.getElementById('patient-form')?.closest('.card');
      if (_artFormCard) _artFormCard.hidden = false;
      renderPatients();

      if (canWrite) {
        loadPatientIntoForm(tid, false);
      } else {
        loadPatientIntoForm(tid, false);
        // Switch from edit mode to view mode: hide the "Editing:" banner and retitle
        document.getElementById('edit-mode-banner').hidden = true;
        const formTitle = document.getElementById('form-title');
        if (formTitle) formTitle.textContent = 'View Patient \u2014 ART Register';
        document.getElementById('patient-form')?.querySelectorAll('input,select,textarea').forEach(el => { el.disabled = true; });
        const subBtn = document.getElementById('submit-btn');
        if (subBtn) subBtn.hidden = true;
        const cancelBtn = document.getElementById('cancel-edit-btn');
        if (cancelBtn) cancelBtn.textContent = 'Close';
      }
    }
  }

  // ── Hook back-to-dashboard-btn to return to search when opened from here ──
  //    We wrap the existing listener by patching showDashboard detection via
  //    the _fromSearch flag checked inside the existing back-btn handler.
  //    Instead, we intercept at the artRegisterScreen back button level by
  //    monkeypatching is not clean — we expose a function for the back button
  //    handler (already in app.js) to call.
  window._patientSearchReturnIfNeeded = function () {
    if (!_fromSearch) return false;
    _fromSearch = false;
    // Hide the TB bottom back button in case it was shown
    const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
    if (bottomBackBtn) bottomBackBtn.hidden = true;
    // Reset back button label
    const backBtn = document.getElementById('back-to-dashboard-btn');
    if (backBtn) backBtn.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Dashboard`;
    if (artRegisterScreen) artRegisterScreen.hidden = true;
    showPatientSearch(true);
    return true;
  };

  // ── Dashboard card wiring ─────────────────────────────────────────────────
  document.getElementById('dash-goto-patient-search')?.addEventListener('click', async () => {
    if (!await _warnIfMigratingAsync()) return;
    showPatientSearch(false);
  });
  document.getElementById('db-header-search-btn')?.addEventListener('click', async () => {
    if (!await _warnIfMigratingAsync()) return;
    showPatientSearch(false);
  });
  document.getElementById('dash-goto-patient-search')?.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); _warnIfMigratingAsync().then(ok => ok && showPatientSearch(false)); }
  });

  document.getElementById('psearch-back-btn')?.addEventListener('click', hidePatientSearch);

  // ── Pending Sync: "Sync Now" button ───────────────────────────────────────
  document.getElementById('psearch-sync-btn')?.addEventListener('click', async () => {
    const statusEl = document.getElementById('psearch-sync-status');
    const btn = document.getElementById('psearch-sync-btn');
    if (!navigator.onLine) {
      if (statusEl) statusEl.textContent = 'You are offline — sync unavailable.';
      return;
    }
    if (btn) btn.disabled = true;
    if (statusEl) statusEl.textContent = 'Syncing…';
    try {
      await triggerSync(false, false, 'pending-sync-btn');
      await triggerTBSync(true, false, 'pending-sync-btn-tb');
      await autoRestoreFromServer(true);
      await autoRestoreFromServerTB(true);
      updateDashboardStats();
      if (statusEl) statusEl.textContent = 'Sync complete.';
      // Refresh the list
      _showPendingAll();
    } catch {
      if (statusEl) statusEl.textContent = 'Sync failed — try again.';
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  // ── Keyboard shortcut: '/' on dashboard focuses search ───────────────────
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
    if (!dashboardScreen || dashboardScreen.hidden) return;
    e.preventDefault();
    showPatientSearch(false);
  });

  // ── Patient Browser (stat tile) — show ALL patients for one register ──────
  let _browseMode   = false;
  let _browseReg    = '';   // 'ART' | 'TB'

  /** Restores the original search-mode table header and nav breadcrumb. */
  function _restoreSearchUI() {
    const thead = tableEl?.querySelector('thead tr');
    if (thead && _origTheadHTML) thead.innerHTML = _origTheadHTML;
    const navTitle = document.getElementById('psearch-nav-title');
    if (navTitle) navTitle.textContent = 'Search Patients';
  }

  /** Updates the breadcrumb title while browsing a specific register. */
  function _updateBrowseTitle(reg) {
    const navTitle = document.getElementById('psearch-nav-title');
    if (navTitle) navTitle.textContent = `All ${reg} Patients`;
  }

  function _showBrowseAll() {
    let rows;
    try {
      rows = _browseReg === 'TB' ? getAllPtDetailsTB('') : getAllPtDetails('');
    } catch (e) {
      _showEmpty('Could not load patient list.');
      return;
    }

    if (!rows || !rows.length) {
      _showEmpty(`No ${_browseReg} patients found in this device's local database.`);
      return;
    }

    // Swap thead to match the register's native column layout
    const thead = tableEl?.querySelector('thead tr');
    if (thead) {
      thead.innerHTML = _browseReg === 'TB'
        ? '<th>Reg. Date</th><th>TB No</th><th>Patient Name</th><th>Age</th><th>Sex</th><th>TB Site</th><th>Type</th><th>Facility</th><th>Sync</th>'
        : '<th>ART No</th><th>Patient Name</th><th>Age</th><th>Sex</th><th>ART Start Date</th><th>Facility</th><th>Sync</th>';
    }

    if (emptyEl) emptyEl.hidden = true;
    if (tableEl) tableEl.hidden = false;
    if (hintEl)  hintEl.hidden  = false;
    if (countEl) { countEl.hidden = false; countEl.textContent = `${rows.length} ${_browseReg} patient${rows.length !== 1 ? 's' : ''}`; }

    const canWrite = userCanWrite();

    if (_browseReg === 'TB') {
      tbodyEl.innerHTML = rows.map(p => {
        const syncBadge = p.HasChanged
          ? '<span class="badge bg-warning text-dark">Pending</span>'
          : '<span class="badge bg-success">Synced</span>';
        const sex = p.SexID === 1 ? 'M' : p.SexID === 2 ? 'F' : escHtml(p.Sex || '');
        return `<tr data-tid="${escHtml(p.PtDetailsTID)}"
                    data-reg="TB"
                    data-hfid="${escHtml(String(p.NearestHFID || 0))}"
                    data-hfname="${escHtml(p.HealthFacility || '')}"
                    data-canwrite="${canWrite}"
                    role="button" tabindex="0" style="cursor:pointer">
          <td>${p.RegDate ? fmtDate(p.RegDate.slice(0, 10)) : '\u2014'}</td>
          <td>${escHtml(p.UnitTBNo || '\u2014')}</td>
          <td>${escHtml(truncateDisplayName(p.PtName) || '\u2014')}</td>
          <td>${p.Age ?? '\u2014'}</td>
          <td>${sex}</td>
          <td>${escHtml(p.TbType || '\u2014')}</td>
          <td>${escHtml(p.PtTypeShort || p.PtType || '\u2014')}</td>
          <td>${escHtml(p.HealthFacility || '\u2014')}</td>
          <td>${syncBadge}</td>
        </tr>`;
      }).join('');
    } else {
      tbodyEl.innerHTML = rows.map(p => {
        const syncBadge = p.HasChanged
          ? '<span class="badge bg-warning text-dark">Pending</span>'
          : '<span class="badge bg-success">Synced</span>';
        const sex = p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : escHtml(p.Sex || '');
        return `<tr data-tid="${escHtml(p.PtDetailsTID)}"
                    data-reg="ART"
                    data-hfid="${escHtml(String(p.NearestHFID || 0))}"
                    data-hfname="${escHtml(p.HealthFacility || '')}"
                    data-canwrite="${canWrite}"
                    role="button" tabindex="0" style="cursor:pointer">
          <td>${escHtml(p.ARTNo || '\u2014')}</td>
          <td>${escHtml(truncateDisplayName(p.PtName) || '\u2014')}</td>
          <td>${p.Age ?? '\u2014'}</td>
          <td>${sex}</td>
          <td>${p.ARTStartDate ? fmtDate(p.ARTStartDate) : '\u2014'}</td>
          <td>${escHtml(p.HealthFacility || '\u2014')}</td>
          <td>${syncBadge}</td>
        </tr>`;
      }).join('');
    }

    tbodyEl.querySelectorAll('tr[data-tid]').forEach(tr => {
      const open = () => _openPatient(tr);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // ── Pending Sync Browser — show all HasChanged=1 patients (ART + TB) ──────
  function _showPendingAll() {
    let artRows = [], tbRows = [];
    try {
      artRows = getAllPtDetails('').filter(p => p.HasChanged);
      tbRows  = getAllPtDetailsTB('').filter(p => p.HasChanged);
    } catch (e) {
      _showEmpty('Could not load pending-sync patients.');
      return;
    }

    // Normalise to the same shape used by searchAllPatients / _runSearch
    const rows = [
      ...artRows.map(p => ({
        Register:      'ART',
        PtDetailsTID:  p.PtDetailsTID,
        PtName:        p.PtName,
        PatientNo:     p.ARTNo,
        Age:           p.Age,
        Sex:           p.Sex,
        Phone:         p.Phone1,
        HealthFacility: p.HealthFacility,
        NearestHFID:   p.NearestHFID,
      })),
      ...tbRows.map(p => ({
        Register:      'TB',
        PtDetailsTID:  p.PtDetailsTID,
        PtName:        p.PtName,
        PatientNo:     p.UnitTBNo,
        Age:           p.Age,
        Sex:           p.Sex,
        Phone:         p.PtPhone,
        HealthFacility: p.HealthFacility,
        NearestHFID:   p.NearestHFID,
      })),
    ];

    if (!rows.length) {
      _showEmpty('No patients are currently pending sync.');
      return;
    }

    // Restore the search-mode thead (Register | Name | Patient No | Age | Sex | Phone | Facility)
    const thead = tableEl?.querySelector('thead tr');
    if (thead && _origTheadHTML) thead.innerHTML = _origTheadHTML;

    if (emptyEl) emptyEl.hidden = true;
    if (tableEl) tableEl.hidden = false;
    if (hintEl)  hintEl.hidden  = false;
    if (countEl) {
      countEl.hidden = false;
      countEl.textContent = `${rows.length} patient${rows.length !== 1 ? 's' : ''} pending sync`;
    }

    const canWrite = userCanWrite();

    tbodyEl.innerHTML = rows.map(p => {
      const regBadge = p.Register === 'ART'
        ? '<span class="psearch-badge psearch-badge--art">ART</span>'
        : '<span class="psearch-badge psearch-badge--tb">TB</span>';
      const sex = p.Sex === 'Male' ? 'M' : p.Sex === 'Female' ? 'F' : (p.Sex || '—');
      return `<tr data-tid="${escHtml(p.PtDetailsTID)}"
                  data-reg="${escHtml(p.Register)}"
                  data-hfid="${escHtml(String(p.NearestHFID || 0))}"
                  data-hfname="${escHtml(p.HealthFacility || '')}"
                  data-canwrite="${canWrite}"
                  role="button" tabindex="0" style="cursor:pointer">
        <td>${regBadge}</td>
        <td>${escHtml(_xlTitleCase(p.PtName) || '—')}</td>
        <td>${escHtml(p.PatientNo || '—')}</td>
        <td>${p.Age != null ? p.Age : '—'}</td>
        <td>${sex}</td>
        <td>${escHtml(p.Phone || '—')}</td>
        <td>${escHtml(p.HealthFacility || '—')}</td>
      </tr>`;
    }).join('');

    tbodyEl.querySelectorAll('tr[data-tid]').forEach(tr => {
      const open = () => _openPatient(tr);
      tr.addEventListener('click', open);
      tr.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
  }

  // Expose for external callers (stat tiles on dashboard)
  window._openPatientBrowser = function(register) {
    _browseMode     = true;
    _browseReg      = register;
    _searchQuery    = '';
    _searchRegister = register;

    // Show the search screen
    if (dashboardScreen)    dashboardScreen.hidden    = true;
    if (artRegisterScreen)  artRegisterScreen.hidden  = true;
    if (tbMonitoringScreen) tbMonitoringScreen.hidden = true;
    if (tbQualityScreen)    tbQualityScreen.hidden    = true;
    const psScreen2 = document.getElementById('patient-search-screen');
    if (psScreen2) psScreen2.hidden = false;
    _fromSearch     = false;
    inputEl.value   = '';
    clearBtn.hidden = true;
    _setChip(register);
    _updateBrowseTitle(register);
    window.scrollTo({ top: 0, behavior: 'instant' });
    _showBrowseAll();
  };

  window._openPendingBrowser = function() {
    _browseMode     = false;
    _browseReg      = '';
    _searchQuery    = '';
    _searchRegister = null;

    // Show the search screen
    if (dashboardScreen)    dashboardScreen.hidden    = true;
    if (artRegisterScreen)  artRegisterScreen.hidden  = true;
    if (tbMonitoringScreen) tbMonitoringScreen.hidden = true;
    if (tbQualityScreen)    tbQualityScreen.hidden    = true;
    const psScreen3 = document.getElementById('patient-search-screen');
    if (psScreen3) psScreen3.hidden = false;
    _fromSearch     = false;
    inputEl.value   = '';
    clearBtn.hidden = true;
    _setChip(null);
    const navTitle = document.getElementById('psearch-nav-title');
    if (navTitle) navTitle.textContent = 'Pending Sync';
    const thead = tableEl?.querySelector('thead tr');
    if (thead && _origTheadHTML) thead.innerHTML = _origTheadHTML;
    // Show the sync bar
    const syncBar = document.getElementById('psearch-sync-bar');
    if (syncBar) syncBar.hidden = false;
    const syncStatus = document.getElementById('psearch-sync-status');
    if (syncStatus) syncStatus.textContent = '';
    window.scrollTo({ top: 0, behavior: 'instant' });
    _showPendingAll();
  };

  // When the user types in browse mode, switch to normal search
  inputEl?.addEventListener('input', () => {
    if (_browseMode && (inputEl.value || '').trim()) {
      _browseMode = false;
      _restoreSearchUI();
    }
  }, true);  // capture to run before the main input listener

})();


document.getElementById('restore-from-server-btn')?.addEventListener('click', () => autoRestoreFromServer());

// ─── Stat tile clicks — open patient browser filtered by register ─────────
document.getElementById('db-stat-art-tile')?.addEventListener('click', () => {
  window._openPatientBrowser?.('ART');
});
document.getElementById('db-stat-tb-tile')?.addEventListener('click', () => {
  window._openPatientBrowser?.('TB');
});
document.getElementById('db-stat-pending-tile')?.addEventListener('click', () => {
  window._openPendingBrowser?.();
});

/** Export Database card — delegates to the existing export button */
document.getElementById('dash-goto-export')?.addEventListener('click', () => {
  exportBtn?.click();
});
document.getElementById('dash-goto-export')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); exportBtn?.click(); }
});

/** Back to Dashboard button inside the ART Register screen */
document.getElementById('back-to-dashboard-btn')?.addEventListener('click', () => {
  // Check if we came from the patient search screen first
  if (window._patientSearchReturnIfNeeded && window._patientSearchReturnIfNeeded()) return;

  // If we came from the pre-report DQ modal, re-show it (promise is still pending)
  if (_fromPreReportDQ && typeof _preReportDQReshowFn === 'function') {
    _fromPreReportDQ = false;
    const reshowFn = _preReportDQReshowFn;
    _preReportDQReshowFn = null;
    const backBtn = document.getElementById('back-to-dashboard-btn');
    if (backBtn) backBtn.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Dashboard`;
    const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
    if (bottomBackBtn) {
      bottomBackBtn.hidden = true;
      bottomBackBtn.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Back to Monitoring`;
    }
    if (artRegisterScreen) artRegisterScreen.hidden = true;
    setTimeout(reshowFn, 150);
    return;
  }

  // If we came from the TB Quality screen, go back there instead of the dashboard
  if (_fromDQScreen) {
    _fromDQScreen = false;
    const backBtn = document.getElementById('back-to-dashboard-btn');
    if (backBtn) backBtn.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Dashboard`;
    const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
    if (bottomBackBtn) {
      bottomBackBtn.hidden = true;
      bottomBackBtn.innerHTML =
        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Back to Monitoring`;
    }
    if (artRegisterScreen)  artRegisterScreen.hidden  = true;
    if (tbQualityScreen)    tbQualityScreen.hidden    = false;
    _dqRefreshAll();
  } else if (_fromMonitoring) {
    _fromMonitoring = false;
    // Restore back button label to Dashboard
    const backBtn = document.getElementById('back-to-dashboard-btn');
    if (backBtn) backBtn.innerHTML =
      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Dashboard`;
    // Hide the bottom back-to-monitoring button
    const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
    if (bottomBackBtn) bottomBackBtn.hidden = true;
    if (artRegisterScreen)  artRegisterScreen.hidden  = true;
    if (tbMonitoringScreen) tbMonitoringScreen.hidden = false;
    _monRefreshAll();   // refresh counts/list in case patient data was updated
  } else {
    showDashboard();
  }
});

// ─── ART Monthly Report modal ────────────────────────────────────────────

// Resolve how much of the geo hierarchy is locked for a given user.
// Returns { level: 'facility'|'county'|'state'|'national', stateID, countyID, facilityID }
// IDs are looked up from the live geo cache when the user object lacks them.
function resolveGeoScope(user, geo) {
  if (user.dataSourceID > 0) {
    const entry = geo.find(r => r.HealthFacilityID === user.dataSourceID) ?? null;
    return {
      level:      'facility',
      stateID:    entry?.StateID  || user.stateID  || 0,
      countyID:   entry?.CountyID || user.countyID || 0,
      facilityID: user.dataSourceID,
    };
  }
  if (user.countyID > 0) {
    const entry = geo.find(r => r.CountyID === user.countyID) ?? null;
    return {
      level:      'county',
      stateID:    entry?.StateID || user.stateID || 0,
      countyID:   user.countyID,
      facilityID: 0,
    };
  }
  if (user.stateID > 0) {
    return { level: 'state', stateID: user.stateID, countyID: 0, facilityID: 0 };
  }
  return { level: 'national', stateID: 0, countyID: 0, facilityID: 0 };
}

(function initArtReportModal() {
  const modal       = document.getElementById('art-report-modal');
  if (!modal) return;

  const programmeSel    = document.getElementById('rpt-programme');
  const subTypeSel      = document.getElementById('rpt-sub-type');
  const dataSourceSel   = document.getElementById('rpt-data-source');
  const periodSection   = document.getElementById('rpt-period-section');
  const dhis2Config     = document.getElementById('rpt-dhis2-config');
  const periodTypeSel   = document.getElementById('rpt-period-type');
  const periodSel       = document.getElementById('rpt-period');
  const periodWrap      = document.getElementById('rpt-period-wrap');
  const yearSel         = document.getElementById('rpt-year');
  const cfQuarterSel    = document.getElementById('rpt-cf-quarter');
  const cfYearSel       = document.getElementById('rpt-cf-year');
  const dhis2ProgressWrap = document.getElementById('rpt-dhis2-progress-wrap');
  const geoTreeWrap     = document.getElementById('rpt-geo-tree');
  const treeEl          = document.getElementById('rpt-tree');
  const summaryEl       = document.getElementById('rpt-tree-summary');
  const treeSearchEl    = document.getElementById('rpt-tree-search');

  // Delegated handler: clicking × on a chip unchecks that facility in the tree
  summaryEl.addEventListener('click', e => {
    const btn = e.target.closest('.rpt-summary-chip-close');
    if (!btn) return;
    const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="facility"][data-id="${btn.dataset.facid}"]`);
    if (cb && !cb.disabled) { cb.checked = false; refreshAncestors(); updateSummary(); }
  });
  const statusEl      = document.getElementById('rpt-status');
  const generateBtn      = document.getElementById('rpt-generate-btn');
  const dhis2PrepareBtn  = document.getElementById('rpt-dhis2-prepare-btn');
  const progressWrap     = document.getElementById('rpt-progress-wrap');
  const progressBar   = document.getElementById('rpt-progress-bar');
  const progressLabel = document.getElementById('rpt-progress-label');
  const progressPct   = document.getElementById('rpt-progress-pct');

  // --- Period cascade --------------------------------------------------------------------------
  const PERIOD_OPTIONS = {
    monthly: [
      { value: '1',  label: 'January'  }, { value: '2',  label: 'February' },
      { value: '3',  label: 'March'    }, { value: '4',  label: 'April'    },
      { value: '5',  label: 'May'      }, { value: '6',  label: 'June'     },
      { value: '7',  label: 'July'     }, { value: '8',  label: 'August'   },
      { value: '9',  label: 'September'}, { value: '10', label: 'October'  },
      { value: '11', label: 'November' }, { value: '12', label: 'December' },
    ],
    quarterly: [
      { value: 'q1', label: 'Quarter 1' },
      { value: 'q2', label: 'Quarter 2' },
      { value: 'q3', label: 'Quarter 3' },
      { value: 'q4', label: 'Quarter 4' },
    ],
    semiannually: [
      { value: 'h1', label: 'Semester 1 (Jan - Jun)' },
      { value: 'h2', label: 'Semester 2 (Jul - Dec)' },
    ],
    annually: [],   // no sub-period � Period dropdown is hidden
  };

  function updatePeriodOptions() {
    const type = periodTypeSel.value;
    const opts = PERIOD_OPTIONS[type] ?? [];
    periodSel.innerHTML = '';
    if (opts.length === 0) {
      periodWrap.style.display = 'none';
    } else {
      periodWrap.style.display = '';
      for (const o of opts) {
        const el = document.createElement('option');
        el.value = o.value; el.textContent = o.label;
        periodSel.appendChild(el);
      }
    }
  }
  periodTypeSel.addEventListener('change', updatePeriodOptions);

  // --- Report Type cascade ----------------------------------------------------------------------
  // ART Monthly: locked to monthly only.
  // TB Quarterly: monthly is not applicable — quarterly/semiannually/annually allowed.
  const PERIOD_TYPE_ALL = ['monthly', 'quarterly', 'semiannually', 'annually'];
  const PERIOD_TYPE_LABELS = {
    monthly: 'Monthly', quarterly: 'Quarterly',
    semiannually: 'Semiannually', annually: 'Annually',
  };

  // --- Programme → Sub-type cascade -----------------------------------------------------------
  const SUB_TYPES = {
    art: [
      { value: 'art-monthly',    label: 'ART Monthly (Excel)' },
    ],
    tb: [
      { value: 'tb-quarterly',   label: 'DS-TB NTP Report Only'                              },
      { value: 'tb-lfa',         label: 'DS-TB LFA Verification Report' },
      { value: 'tb-dhis2',       label: 'DS-TB NTP Report To DHIS2'                          },
      { value: 'dr-tb-quarterly',label: 'DR-TB NTP Report Only (coming soon)',         disabled: true },
      { value: 'dr-tb-dhis2',    label: 'DR-TB NTP Report To DHIS2 (coming soon)',     disabled: true },
    ],
  };

  function populateSubTypes() {
    const prog = programmeSel.value;
    const src  = dataSourceSel ? dataSourceSel.value : 'etbr-server';
    let types  = (SUB_TYPES[prog] ?? []).slice();
    // When reading FROM DHIS2, hide the "send to DHIS2" report types
    if (src === 'dhis2') {
      types = types.filter(t => t.value !== 'tb-dhis2' && t.value !== 'dr-tb-dhis2');
    }
    subTypeSel.innerHTML = '';
    for (const t of types) {
      const opt = document.createElement('option');
      opt.value = t.value; opt.textContent = t.label;
      if (t.disabled) { opt.disabled = true; opt.style.color = '#aaa'; }
      subTypeSel.appendChild(opt);
    }
  }

  function applySubType() {
    const sub         = subTypeSel.value;
    const src         = dataSourceSel ? dataSourceSel.value : 'etbr-server';
    const isDhis2Send = sub === 'tb-dhis2';                        // sending to DHIS2
    const isDhis2Read = src === 'dhis2' && sub !== 'tb-dhis2';     // reading from DHIS2
    const isDhis2     = isDhis2Send;                               // kept for prepare-btn compat
    const isART       = sub === 'art-monthly';
    const isTB        = sub === 'tb-quarterly';
    // DHIS2 quarter/year config (single-quarter picker) shown only when SENDING to DHIS2.
    // When READING from DHIS2 we show the standard period section so the user can pick
    // a quarter, semester, or full year — and we build multiple DHIS2 period params.
    const usesDhis2Config = isDhis2Send;

    // Show/hide standard period section vs DHIS2 config
    // - Sending to DHIS2: show single-quarter picker (dhis2Config), hide standard period section
    // - Reading from DHIS2: show standard period section (quarter/semester/annual), hide quarter picker
    // - Everything else: show standard period section
    if (periodSection) periodSection.style.display = usesDhis2Config ? 'none' : '';
    if (dhis2Config)   dhis2Config.style.display   = usesDhis2Config ? ''     : 'none';

    // Geo tree is always visible — every report type requires a facility selection
    if (geoTreeWrap) geoTreeWrap.style.display = '';
    // If tree has never been built (e.g. very first open), build it now.
    if (treeEl && treeEl.children.length === 0) {
      (async () => {
        const user = getUser();
        if (!user) return;
        await fetchGeoTreeData();
        const geo   = getGeoAreaData();
        const scope = resolveGeoScope(user, geo);
        buildTree(geo, scope);
      })();
    }

    // Show/hide generate vs prepare buttons
    generateBtn.style.display    = isDhis2Send ? 'none' : '';
    if (dhis2PrepareBtn) dhis2PrepareBtn.style.display = isDhis2Send ? '' : 'none';

    // Update modal title and header colour to match the dashboard button that opened it
    const titleEl  = document.getElementById('rpt-modal-title-text');
    const headerEl = document.getElementById('rpt-modal-header');
    if (titleEl) {
      if (isDhis2Send)      titleEl.textContent = 'Send TB Reports to DHIS2';
      else if (isDhis2Read) titleEl.textContent = 'Get TB Reports from DHIS2';
      else                  titleEl.textContent = 'Generate Reports';
    }
    if (headerEl) {
      // Green (#1b5e42) for DHIS2-send; teal (#055160) for DHIS2-read/pull; blue (#084298) for standard reports
      if (isDhis2Send)       headerEl.style.background = '#1b5e42';
      else if (isDhis2Read)  headerEl.style.background = '#055160';
      else                   headerEl.style.background = '#084298';
    }

    // Rebuild Period Type options for ART vs TB Excel
    if (!usesDhis2Config) {
      const allowed = isART
        ? PERIOD_TYPE_ALL
        : PERIOD_TYPE_ALL.filter(t => t !== 'monthly');
      const prev = periodTypeSel.value;
      periodTypeSel.innerHTML = '';
      for (const t of allowed) {
        const opt = document.createElement('option');
        opt.value = t; opt.textContent = PERIOD_TYPE_LABELS[t];
        periodTypeSel.appendChild(opt);
      }
      periodTypeSel.value = allowed.includes(prev) ? prev : allowed[0];
      periodTypeSel.disabled = false;
      updatePeriodOptions();
    }

    generateBtn.disabled = false;
    if (dhis2PrepareBtn) dhis2PrepareBtn.disabled = false;
    setStatus('', '');
  }

  programmeSel.addEventListener('change', () => { populateSubTypes(); applySubType(); });
  subTypeSel.addEventListener('change', applySubType);
  if (dataSourceSel) dataSourceSel.addEventListener('change', () => { populateSubTypes(); applySubType(); });

  // --- Date-range helper ------------------------------------------------------------------------
  function getDateRange() {
    const type = periodTypeSel.value;
    const year = parseInt(yearSel.value, 10);
    const val  = periodSel.value;
    const iso  = (y, m, d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const last = (y, m) => new Date(y, m, 0).getDate();
    switch (type) {
      case 'monthly': {
        const m = parseInt(val, 10);
        return { startDate: iso(year, m, 1), endDate: iso(year, m, last(year, m)) };
      }
      case 'quarterly': {
        const quarters = { q1:[1,3], q2:[4,6], q3:[7,9], q4:[10,12] };
        const [sm, em] = quarters[val];
        return { startDate: iso(year, sm, 1), endDate: iso(year, em, last(year, em)) };
      }
      case 'semiannually':
        return val === 'h1'
          ? { startDate: iso(year, 1, 1),  endDate: iso(year, 6, 30)  }
          : { startDate: iso(year, 7, 1),  endDate: iso(year, 12, 31) };
      case 'annually':
        return { startDate: iso(year, 1, 1), endDate: iso(year, 12, 31) };
      default: return null;
    }
  }

  // --- Populate year dropdown ----------------------------------------------------------------------
  const currentYear = new Date().getFullYear();
  for (let y = currentYear + 1; y >= currentYear - 5; y--) {
    const opt = document.createElement('option');
    opt.value = y; opt.textContent = y;
    if (y === currentYear) opt.selected = true;
    yearSel.appendChild(opt);
  }

  // Populate DHIS2 year selector
  (function populateDhis2Years() {
    const now = new Date().getFullYear();
    cfYearSel.innerHTML = '';
    for (let yr = now + 1; yr >= now - 7; yr--) {
      const opt = document.createElement('option');
      opt.value = yr; opt.textContent = yr;
      if (yr === now) opt.selected = true;
      cfYearSel.appendChild(opt);
    }
    // Default DHIS2 quarter/year to the previous completed quarter
    const _d    = new Date();
    const _curQ = Math.floor(_d.getMonth() / 3) + 1; // 1–4, current quarter
    const _prevQ    = _curQ === 1 ? 4 : _curQ - 1;
    const _prevQYear = _curQ === 1 ? _d.getFullYear() - 1 : _d.getFullYear();
    cfQuarterSel.value = String(_prevQ);
    cfYearSel.value    = String(_prevQYear);
  })();

  // Pre-select: HIV programme → ART Monthly, previous month
  const prevMonth = new Date(); prevMonth.setDate(1); prevMonth.setMonth(prevMonth.getMonth() - 1);
  programmeSel.value = 'art';
  populateSubTypes();
  subTypeSel.value = 'art-monthly';
  applySubType();
  periodSel.value = String(prevMonth.getMonth() + 1);
  yearSel.value   = String(prevMonth.getFullYear());
  modal.addEventListener('show.bs.modal', async (event) => {
    setStatus('', '');
    generateBtn.disabled = false;
    if (dhis2PrepareBtn) dhis2PrepareBtn.disabled = false;

    // Detect which dashboard card triggered the modal
    const trigger  = event.relatedTarget;
    const dhisMode = trigger?.closest('[data-dhis2-mode]')?.dataset.dhis2Mode ?? '';

    if (dhisMode === 'send') {
      // "Send to DHIS2" card → TB programme, DHIS2-send sub-type
      if (dataSourceSel) dataSourceSel.value = 'etbr-server';
      programmeSel.value = 'tb';
      populateSubTypes();
      subTypeSel.value = 'tb-dhis2';
    } else if (dhisMode === 'pull') {
      // "Pull Data from DHIS2" card → TB programme, DHIS2 as data source
      if (dataSourceSel) dataSourceSel.value = 'dhis2';
      programmeSel.value = 'tb';
      populateSubTypes();
    } else {
      // "Generate Reports" card or any other trigger → reset to defaults
      if (dataSourceSel) dataSourceSel.value = 'etbr-server';
      programmeSel.value = 'art';
      populateSubTypes();
      subTypeSel.value = 'art-monthly';
    }

    applySubType();  // re-apply so state is consistent on each open
    const user = getUser();
    if (!user) return;

    // Always build the geo tree — facility selection is required for every report type.
    await fetchGeoTreeData();
    const geo   = getGeoAreaData();
    const scope = resolveGeoScope(user, geo);
    buildTree(geo, scope);
    geoTreeWrap.style.display = '';
  });

  // ── Tree builder ─────────────────────────────────────────────────────
  function buildTree(geo, scope) {
    treeEl.innerHTML = '';

    // Group flat geo list into state → county → facilities
    const stateMap = new Map();
    for (const r of geo) {
      if (!stateMap.has(r.StateID))
        stateMap.set(r.StateID, { name: r.State, counties: new Map() });
      const st = stateMap.get(r.StateID);
      if (!st.counties.has(r.CountyID))
        st.counties.set(r.CountyID, { name: r.County, facilities: [] });
      st.counties.get(r.CountyID).facilities.push({ id: r.HealthFacilityID, name: r.HealthFacility });
    }

    const sortedStates = [...stateMap.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

    for (const [stateId, stateData] of sortedStates) {
      const stateNode     = _el('div', 'rpt-tree-node rpt-tree-state');
      const stateToggle   = _el('span', 'rpt-tree-toggle');
      const stateCb       = _checkbox('state', stateId);
      const stateLabel    = _el('span', 'rpt-tree-label', stateData.name);
      const stateChildren = _el('div', 'rpt-tree-children');

      const sortedCounties = [...stateData.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

      for (const [countyId, countyData] of sortedCounties) {
        const countyNode     = _el('div', 'rpt-tree-node rpt-tree-county');
        const countyToggle   = _el('span', 'rpt-tree-toggle');
        const countyCb       = _checkbox('county', countyId);
        const countyLabel    = _el('span', 'rpt-tree-label', countyData.name);
        const countyChildren = _el('div', 'rpt-tree-children');

        const sortedFacs = [...countyData.facilities].sort((a, b) => a.name.localeCompare(b.name));
        for (const fac of sortedFacs) {
          const facNode  = _el('div', 'rpt-tree-node rpt-tree-facility');
          const facCb    = _checkbox('facility', fac.id);
          const facLabel = _el('span', 'rpt-tree-label', fac.name);

          facCb.addEventListener('change', () => { refreshAncestors(); updateSummary(); });
          facLabel.addEventListener('click', () => { if (!facCb.disabled) facCb.click(); });

          facNode.appendChild(facCb);
          facNode.appendChild(facLabel);
          countyChildren.appendChild(facNode);
        }

        countyCb.addEventListener('change', () => {
          const checked = countyCb.checked;
          countyChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
            if (!cb.disabled) { cb.checked = checked; cb.indeterminate = false; }
          });
          countyCb.indeterminate = false;
          refreshAncestors();
          updateSummary();
        });
        countyLabel.addEventListener('click', () => { if (!countyCb.disabled) countyCb.click(); });
        countyToggle.addEventListener('click', () => _toggleChildren(countyChildren, countyToggle));

        countyNode.appendChild(countyToggle);
        countyNode.appendChild(countyCb);
        countyNode.appendChild(countyLabel);
        countyNode.appendChild(countyChildren);
        stateChildren.appendChild(countyNode);
      }

      stateCb.addEventListener('change', () => {
        const checked = stateCb.checked;
        stateChildren.querySelectorAll('.rpt-tree-cb').forEach(cb => {
          if (!cb.disabled) { cb.checked = checked; cb.indeterminate = false; }
        });
        stateCb.indeterminate = false;
        updateSummary();
      });
      stateLabel.addEventListener('click', () => { if (!stateCb.disabled) stateCb.click(); });
      stateToggle.addEventListener('click', () => _toggleChildren(stateChildren, stateToggle));

      stateNode.appendChild(stateToggle);
      stateNode.appendChild(stateCb);
      stateNode.appendChild(stateLabel);
      stateNode.appendChild(stateChildren);
      treeEl.appendChild(stateNode);
    }

    applyScope(scope);
    updateSummary(true);
    // Clear any previous search when tree is rebuilt
    if (treeSearchEl) { treeSearchEl.value = ''; _filterTree(''); }
  }

  // ── Tree filter (search box) ──────────────────────────────────────────
  function _filterTree(term) {
    const q = term.trim().toLowerCase();
    for (const facNode of treeEl.querySelectorAll('.rpt-tree-facility')) {
      const label = facNode.querySelector('.rpt-tree-label')?.textContent?.toLowerCase() ?? '';
      const match = !q || label.includes(q);
      facNode.style.display = match ? '' : 'none';
    }
    // Show/hide county nodes based on whether any children are visible
    for (const countyNode of treeEl.querySelectorAll('.rpt-tree-county')) {
      const visibleFacs = [...countyNode.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-facility')]
        .some(n => n.style.display !== 'none');
      countyNode.style.display = visibleFacs ? '' : 'none';
      if (q && visibleFacs) {
        const ch = countyNode.querySelector(':scope > .rpt-tree-children');
        const tog = countyNode.querySelector(':scope > .rpt-tree-toggle');
        if (ch && !ch.classList.contains('open')) { ch.classList.add('open'); tog?.classList.add('open'); }
      }
    }
    // Show/hide state nodes based on whether any county children are visible
    for (const stateNode of treeEl.querySelectorAll('.rpt-tree-state')) {
      const visibleCounties = [...stateNode.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-county')]
        .some(n => n.style.display !== 'none');
      stateNode.style.display = visibleCounties ? '' : 'none';
      if (q && visibleCounties) {
        const ch = stateNode.querySelector(':scope > .rpt-tree-children');
        const tog = stateNode.querySelector(':scope > .rpt-tree-toggle');
        if (ch && !ch.classList.contains('open')) { ch.classList.add('open'); tog?.classList.add('open'); }
      }
    }
  }

  if (treeSearchEl) {
    treeSearchEl.addEventListener('input', () => _filterTree(treeSearchEl.value));
  }

  // Reset search when modal is closed
  modal.addEventListener('hidden.bs.modal', () => {
    if (treeSearchEl) { treeSearchEl.value = ''; _filterTree(''); }
  });

  // ── DOM helpers ───────────────────────────────────────────────────────
  function _el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls)  e.className   = cls;
    if (text) e.textContent = text;
    return e;
  }

  function _checkbox(level, id) {
    const cb = document.createElement('input');
    cb.type          = 'checkbox';
    cb.className     = 'rpt-tree-cb';
    cb.dataset.level = level;
    cb.dataset.id    = String(id);
    return cb;
  }

  function _toggleChildren(childrenEl, toggleEl) {
    const open = childrenEl.classList.toggle('open');
    toggleEl.classList.toggle('open', open);
  }

  // ── Ancestor state refresh ────────────────────────────────────────────
  // Re-scans all county + state nodes and sets checked/indeterminate states.
  function refreshAncestors() {
    for (const countyNode of treeEl.querySelectorAll('.rpt-tree-county')) {
      const countyCb  = countyNode.querySelector(':scope > .rpt-tree-cb');
      const facCbs    = [...countyNode.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-facility > .rpt-tree-cb')];
      _setParentState(countyCb, facCbs);
    }
    for (const stateNode of treeEl.querySelectorAll('.rpt-tree-state')) {
      const stateCb   = stateNode.querySelector(':scope > .rpt-tree-cb');
      const countyCbs = [...stateNode.querySelectorAll(':scope > .rpt-tree-children > .rpt-tree-county > .rpt-tree-cb')];
      _setParentState(stateCb, countyCbs);
    }
  }

  function _setParentState(parentCb, childCbs) {
    if (!parentCb || childCbs.length === 0) return;
    const numChecked = childCbs.filter(cb => cb.checked).length;
    const numIndet   = childCbs.filter(cb => cb.indeterminate).length;
    if (numChecked === 0 && numIndet === 0) {
      parentCb.checked = false; parentCb.indeterminate = false;
    } else if (numChecked === childCbs.length && numIndet === 0) {
      parentCb.checked = true;  parentCb.indeterminate = false;
    } else {
      parentCb.checked = false; parentCb.indeterminate = true;
    }
  }

  // ── Scope application ─────────────────────────────────────────────────
  // Pre-expands and pre-selects nodes based on the caller's access level.
  function applyScope(scope) {
    if (scope.level === 'facility') {
      // Lock to the single assigned facility — cannot be deselected
      const cb = treeEl.querySelector(`.rpt-tree-cb[data-level="facility"][data-id="${scope.facilityID}"]`);
      if (cb) {
        cb.checked  = true;
        cb.disabled = true;
        _expandAncestors(cb);
        refreshAncestors();
      }
    } else if (scope.level === 'county') {
      // Pre-check and expand the user's county
      const countyCb = treeEl.querySelector(`.rpt-tree-cb[data-level="county"][data-id="${scope.countyID}"]`);
      if (countyCb) {
        _expandToNode(countyCb);
        countyCb.click();   // cascades check to all facilities + calls refreshAncestors
      }
    } else if (scope.level === 'state') {
      // Pre-check and expand the user's state
      const stateCb = treeEl.querySelector(`.rpt-tree-cb[data-level="state"][data-id="${scope.stateID}"]`);
      if (stateCb) {
        _expandToNode(stateCb);
        stateCb.click();    // cascades check to all counties + facilities
      }
    }
    // 'national' / NGO admin: nothing pre-selected — user chooses freely
  }

  // Expand the children panel of the node that owns this checkbox,
  // and also expand its parent containers up to the tree root.
  function _expandToNode(cb) {
    const node     = cb.parentElement;
    const children = node.querySelector(':scope > .rpt-tree-children');
    const toggle   = node.querySelector(':scope > .rpt-tree-toggle');
    if (children && !children.classList.contains('open')) {
      children.classList.add('open');
      if (toggle) toggle.classList.add('open');
    }
    // Expand ancestor containers (e.g. a county is inside a state's children div)
    let ancestor = node.parentElement;
    while (ancestor && ancestor !== treeEl) {
      if (ancestor.classList.contains('rpt-tree-children')) {
        ancestor.classList.add('open');
        const ancestorNode   = ancestor.parentElement;
        const ancestorToggle = ancestorNode?.querySelector(':scope > .rpt-tree-toggle');
        if (ancestorToggle) ancestorToggle.classList.add('open');
      }
      ancestor = ancestor.parentElement;
    }
  }

  // Walk up from a facility checkbox and open every parent container.
  function _expandAncestors(facCb) {
    let el = facCb.parentElement;  // .rpt-tree-facility node
    while (el && el !== treeEl) {
      if (el.classList.contains('rpt-tree-children')) {
        el.classList.add('open');
        const parentNode   = el.parentElement;
        const parentToggle = parentNode?.querySelector(':scope > .rpt-tree-toggle');
        if (parentToggle) parentToggle.classList.add('open');
      }
      el = el.parentElement;
    }
  }

  // ── Selection helpers ─────────────────────────────────────────────────
  function getSelectedFacilityIds() {
    return [...treeEl.querySelectorAll('.rpt-tree-cb[data-level="facility"]:checked')]
      .map(cb => parseInt(cb.dataset.id, 10));
  }

  function updateSummary(silent = false) {
    const ids = getSelectedFacilityIds();
    if (ids.length === 0) {
      const _noFacMsg = 'No facilities selected — please select at least one facility, county or state.';
      summaryEl.textContent = _noFacMsg;
      summaryEl.style.color = '#dc3545';
      if (!silent) showToast(_noFacMsg, 'error');
      // summaryEl.style.fontWeight = 'bold';
      return;
    }
    summaryEl.style.color = '';
    // summaryEl.style.fontWeight = '';
    const escape = s => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const names = ids.map(id =>
      escape(
        treeEl.querySelector(`.rpt-tree-cb[data-level="facility"][data-id="${id}"]`)
          ?.nextElementSibling?.textContent?.trim() ?? `Facility ${id}`
      )
    );
    const count = ids.length;
    summaryEl.innerHTML =
      `<div class="rpt-summary-header">${count} facilit${count === 1 ? 'y' : 'ies'} selected:</div>` +
      `<div class="rpt-summary-list">${names.map((n, i) =>
        `<span class="rpt-summary-chip">${n}<button class="rpt-summary-chip-close" data-facid="${ids[i]}" aria-label="Deselect ${n}" title="Deselect">&times;</button></span>`
      ).join('')}</div>`;
  }

  // ── Status helper ────────────────────────────────────────────────────
  function setStatus(msg, type) {
    if (!msg) { statusEl.style.display = 'none'; statusEl.classList.remove('rpt-status-anim'); return; }
    if (type === 'success') {
      statusEl.className          = 'alert';   // reset (no rpt-status-anim yet)
      statusEl.style.background   = '#1b5e42';
      statusEl.style.color        = '#fff';
      statusEl.style.fontWeight   = 'normal';
      statusEl.style.border       = 'none';
    } else {
      statusEl.className          = `alert alert-${type || 'info'}`;
      statusEl.style.background   = '';
      statusEl.style.color        = '';
      statusEl.style.fontWeight   = '';
      statusEl.style.border       = '';
    }
    statusEl.textContent  = msg;
    statusEl.style.display = '';
    void statusEl.offsetWidth;             // force reflow so animation restarts
    statusEl.classList.add('rpt-status-anim');
  }

  // ── Progress bar helpers ─────────────────────────────────────────────
  function setProgress(step, total, label) {
    const pct = total > 0 ? Math.round((step / total) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    progressBar.parentElement.setAttribute('aria-valuenow', pct);
    progressLabel.textContent = label;
    progressPct.textContent   = `${pct}%`;
    progressWrap.style.display = '';
  }

  function clearProgress() {
    progressWrap.style.display  = 'none';
    progressBar.style.width     = '0%';
    progressLabel.textContent   = '';
    progressPct.textContent     = '';
  }


  // --- Offline warning modal (replaces native confirm()) -----------------------------------------------
  function showOfflineWarningModal() {
    return new Promise(resolve => {
      const modalEl = document.getElementById('offline-confirm-modal');
      const okBtn   = document.getElementById('offline-confirm-ok');
      const canBtn  = document.getElementById('offline-confirm-cancel');
      if (!modalEl || !okBtn || !canBtn) { resolve(true); return; } // fallback: allow

      const backdrop = document.createElement('div');
      backdrop.id = 'offline-confirm-backdrop';
      backdrop.className = 'modal-backdrop fade';
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('show'));

      modalEl.style.display = 'block';
      modalEl.removeAttribute('aria-hidden');
      modalEl.setAttribute('aria-modal', 'true');
      requestAnimationFrame(() => modalEl.classList.add('show'));

      function cleanup(result) {
        okBtn.removeEventListener('click', onOk);
        canBtn.removeEventListener('click', onCancel);
        modalEl.classList.remove('show');
        modalEl.style.display = '';
        modalEl.setAttribute('aria-hidden', 'true');
        modalEl.removeAttribute('aria-modal');
        const bd = document.getElementById('offline-confirm-backdrop');
        if (bd) bd.remove();
        resolve(result);
      }
      const onOk     = () => cleanup(true);
      const onCancel = () => cleanup(false);
      okBtn.addEventListener('click', onOk);
      canBtn.addEventListener('click', onCancel);
    });
  }

  // --- Generate button --------------------------------------------------------------------------
  generateBtn.addEventListener('click', async () => {
    const src = dataSourceSel ? dataSourceSel.value : 'etbr-server';

    // ── 'This Computer': always use local SQLite, regardless of connectivity ──
    if (src === 'this-computer') {
      if (subTypeSel.value === 'tb-quarterly') {
        await generateTbQuarterlyReportOffline();
        return;
      }
      if (subTypeSel.value === 'art-monthly') {
        await generateArtMonthlyReportOffline();
        return;
      }
      if (subTypeSel.value === 'tb-lfa') {
        await generateLfaOffline();
        return;
      }
      setStatus('Offline report generation is not available for this report type.', 'warning');
      return;
    }

    // ── 'DHIS2': read aggregate data from DHIS2 ──────────────────────────────
    if (src === 'dhis2') {
      if (!_reallyOnline) {
        const msg = 'Reading from DHIS2 requires an active internet connection. Please reconnect and try again.';
        setStatus(msg, 'danger');
        showToast(msg, 'error');
        return;
      }
      if (subTypeSel.value === 'tb-quarterly') {
        await generateTbQuarterlyFromDhis2();
        return;
      }
      if (subTypeSel.value === 'tb-lfa') {
        await generateLfaFromDhis2();
        return;
      }
      setStatus('Reading from DHIS2 is currently only available for the DS-TB NTP Report and DS-TB LFA Verification Report.', 'warning');
      return;
    }

    // ── 'eTBr Server' (default): existing online / offline-fallback logic ────
    if (!_reallyOnline) {
      // DHIS2 submissions always require a live server connection — hard block.
      if (subTypeSel.value === 'tb-dhis2') {
        const msg = 'Sending data to DHIS2 requires an active internet connection. Please reconnect and try again.';
        setStatus(msg, 'danger');
        showToast(msg, 'error');
        return;
      }

      // All other report types can be generated offline from the local SQLite
      // database, but warn the user about potential data discrepancies first.
      const confirmed = await showOfflineWarningModal();
      if (!confirmed) return;

      if (subTypeSel.value === 'tb-quarterly') {
        await generateTbQuarterlyReportOffline();
        return;
      }
      if (subTypeSel.value === 'art-monthly') {
        await generateArtMonthlyReportOffline();
        return;
      }
      if (subTypeSel.value === 'tb-lfa') {
        await generateLfaOffline();
        return;
      }
      setStatus('Offline report generation is not yet available for this report type. Please reconnect and try again.', 'warning');
      return;
    }

    if (subTypeSel.value === 'tb-quarterly') {
      await generateTbQuarterlyReport();
      return;
    }
    if (subTypeSel.value === 'tb-lfa') {
      await generateLfaFromServer();
      return;
    }
    const year  = parseInt(yearSel.value, 10);
    if (!year) { setStatus('Please select a year.', 'warning'); return; }
    if (periodTypeSel.value !== 'annually' && !periodSel.value) {
      setStatus('Please select a period.', 'warning'); return;
    }
    const range = getDateRange();
    if (!range) { setStatus('Invalid period selection.', 'warning'); return; }

    // ── Future period guard ───────────────────────────────────────────────
    // Allow the current month/quarter/semester/year even if it hasn't ended,
    // but block anything whose start date is in a future month.
    {
      const today    = new Date();
      const nowYear  = today.getFullYear();
      const nowMonth = today.getMonth() + 1; // 1–12
      const type     = periodTypeSel.value;
      const val      = periodSel.value;
      let periodStartMonth;
      if      (type === 'monthly')      periodStartMonth = parseInt(val, 10);
      else if (type === 'quarterly')    periodStartMonth = ({ q1:1, q2:4, q3:7, q4:10 })[val];
      else if (type === 'semiannually') periodStartMonth = val === 'h1' ? 1 : 7;
      else                              periodStartMonth = 1; // annually → January

      if (year > nowYear || (year === nowYear && periodStartMonth > nowMonth)) {
        setStatus('Cannot generate a report for a future period.', 'warning');
        return;
      }
    }
    // ── End future period guard ───────────────────────────────────────────

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected — please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }
    const qs = new URLSearchParams({ startDate: range.startDate, endDate: range.endDate });
    for (const id of facilityIds) qs.append('facilityIds', id);

    // ── Baseline pre-flight check ─────────────────────────────────────────
    // Only run for specific-facility requests (national/all skips this).
    if (facilityIds.length > 0 && typeof window._blCheckBaselineStatus === 'function') {
      setStatus('Checking baseline configuration...', 'info');
      const blResult = await window._blCheckBaselineStatus(facilityIds, range.startDate);

      if (blResult.status === 'error') {
        // Hard block: report period is before the facility's baseline date
        const msgs = blResult.warnings.map(w => w.message).join('\n\n');
        setStatus(msgs, 'danger');
        generateBtn.disabled = false;
        return;
      }

      if (blResult.status === 'warning' && blResult.warnings.length > 0) {
        // Filter out "outdated_baseline" warnings the user has already snoozed
        const activeWarnings = blResult.warnings.filter(w => {
          if (w.type === 'outdated_baseline') {
            const snoozeKey = `art.bl.snoozeOutdated.${w.facilityId}`;
            return !localStorage.getItem(snoozeKey);
          }
          return true;
        });

        if (activeWarnings.length > 0) {
          const msgs = activeWarnings.map(w => w.message).join('\n\n');
          // For outdated_baseline, offer a snooze option
          const hasOutdated = activeWarnings.some(w => w.type === 'outdated_baseline');
          let confirmMsg = msgs + '\n\nDo you want to continue generating the report anyway?';
          if (hasOutdated) {
            confirmMsg += '\n\n(Select "OK" to continue. You can update the baseline from the ART Register or Data Management dashboard.)';
          }

          const proceed = await showGenericConfirmModal(
            'Baseline Warning',
            confirmMsg,
            'Continue Anyway'
          );
          if (!proceed) {
            setStatus('Report cancelled. Please review baseline configuration.', 'warning');
            generateBtn.disabled = false;
            return;
          }

          // If user confirmed, offer to snooze outdated_baseline reminders for each facility
          if (hasOutdated) {
            for (const w of activeWarnings.filter(w => w.type === 'outdated_baseline')) {
              const snooze = await showGenericConfirmModal(
                'Suppress Reminder?',
                `Suppress this outdated-baseline reminder for facility "${w.facilityName}"?`,
                'Suppress'
              );
              if (snooze) {
                localStorage.setItem(`art.bl.snoozeOutdated.${w.facilityId}`, '1');
              }
            }
          }
        }
      }
    }
    // ── End baseline check ────────────────────────────────────────────────

    const sseUrl = `${API_BASE}/reports/art-monthly-progress?${qs}`;
    setStatus('Generating report\u2026', 'info');
    clearProgress();
    generateBtn.disabled = true;
    console.log('[Report] SSE URL:', sseUrl);

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);

    try {
      const resp = await fetch(sseUrl, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      console.log('[Report] SSE response status:', resp.status, resp.statusText);

      if (!resp.ok) {
        let errMsg = `eTBr server error (${resp.status}).`;
        try {
          const rawBody = await resp.text();
          console.error('[Report] Error body:', rawBody);
          const j = JSON.parse(rawBody);
          if (j.detail) console.error('[Report] eTBr server detail:', j.detail);
          errMsg = j.error || errMsg;
        } catch { /* ignore parse error */ }
        setStatus(errMsg, 'danger');
        return;
      }

      // ── Consume the SSE stream ──────────────────────────────────────
      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let downloadToken    = null;
      let downloadFilename = null;

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        // SSE events are delimited by double newlines.
        const events = buf.split('\n\n');
        buf = events.pop(); // last element may be an incomplete event

        for (const rawEvent of events) {
          // Each event may have one or more "data: ..." lines.
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload) continue;

          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.error) {
            setStatus(evt.error, 'danger');
            clearProgress();
            return; // leaves finally to re-enable the button
          }

          if (evt.done) {
            downloadToken    = evt.token;
            downloadFilename = evt.filename;
            setProgress(evt.total ?? 1, evt.total ?? 1, 'Finalising\u2026');
            break streamLoop;
          }

          if (evt.step !== undefined) {
            setProgress(evt.step, evt.total, evt.label || '');
            setStatus(`Step ${evt.step} of ${evt.total}: ${evt.label || ''}`, 'info');
          }
        }
      }

      if (!downloadToken) {
        setStatus('Report generation incomplete. Please try again.', 'danger');
        clearProgress();
        return;
      }

      // ── Download the finished file ──────────────────────────────────
      setStatus('Downloading report\u2026', 'info');
      const dlUrl  = `${API_BASE}/reports/art-monthly-download?token=${encodeURIComponent(downloadToken)}`;
      const dlResp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${authToken}` } });

      if (!dlResp.ok) {
        let errMsg = `Download failed (${dlResp.status}).`;
        try { const j = await dlResp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        clearProgress();
        return;
      }

      const blob    = await dlResp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor  = document.createElement('a');
      anchor.href     = blobUrl;
      anchor.download = downloadFilename || `ART_Report_${range.startDate}_${range.endDate}_SV.xlsx`;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setStatus('Report downloaded successfully.', 'success');
      clearProgress();
    } catch (err) {
      console.error('[Report] SSE/download failed:', err?.name, err?.message);
      setStatus('Failed to generate the report. Check your connection and try again.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  });

  // ── Pre-Report Data Quality Check ────────────────────────────────────
  /**
   * Runs data quality checks for the TB report periods and shows a checklist modal.
   * Returns a Promise<boolean>: true = user wants to proceed, false = cancelled.
   *
   * @param {number[]} facilityIds
   * @param {{ startDate:string, endDate:string }} cfRange  New-registration (CF) period
   * @param {{ startDate:string, endDate:string }} toRange  Treatment-outcomes (TO) period
   * @param {number} cfYear  Year of the CF period
   */
  async function _runPreReportDQCheck(facilityIds, cfRange, toRange, cfYear) {
    return new Promise(resolve => {
      const modalEl       = document.getElementById('pre-report-dq-modal');
      const proceedBtn    = document.getElementById('pre-dq-proceed-btn');
      const proceedLabel  = document.getElementById('pre-dq-proceed-label');
      const cancelBtn      = document.getElementById('pre-dq-cancel-btn');
      const headerCloseBtn = document.getElementById('pre-dq-header-close-btn');
      const fixBtn         = document.getElementById('pre-dq-fix-btn');
      const checklistEl   = document.getElementById('pre-dq-checklist');
      const summaryEl     = document.getElementById('pre-dq-summary');
      const autoclosePill = document.getElementById('pre-dq-autoclose-pill');
      const autocloseCb   = document.getElementById('dq-auto-close-cb');
      const periodInfoEl  = document.getElementById('pre-dq-period-info');
      const detailEl      = document.getElementById('pre-dq-detail');
      const detailTitleEl = document.getElementById('pre-dq-detail-title');
      const detailTbody   = document.getElementById('pre-dq-detail-tbody');
      const detailThead   = document.querySelector('#pre-dq-detail-table thead');
      const closeDetailBtn = document.getElementById('pre-dq-close-detail-btn');

      const _THEAD_FULL    = '<tr><th>TB No</th><th>Reg Date</th><th>Patient Name</th><th>Age</th><th>Sex</th><th>Facility</th><th>Issue / Note</th></tr>';
      const _THEAD_SKIPPED = '<tr><th style="width:16.666%">TB No</th><th>Facility</th></tr>';
      const _COL_FULL = 7;
      const _COL_SKIP = 2;

      if (!modalEl) { resolve(true); return; }

      // ── Manual show/hide (same pattern as showOfflineWarningModal) ────────
      function _showModal() {
        const bd = document.createElement('div');
        bd.id = 'pre-dq-backdrop';
        bd.className = 'modal-backdrop fade';
        document.body.appendChild(bd);
        requestAnimationFrame(() => bd.classList.add('show'));
        modalEl.style.display = 'block';
        modalEl.removeAttribute('aria-hidden');
        modalEl.setAttribute('aria-modal', 'true');
        requestAnimationFrame(() => modalEl.classList.add('show'));
      }

      function _hideModal() {
        modalEl.classList.remove('show');
        modalEl.style.display = '';
        modalEl.setAttribute('aria-hidden', 'true');
        modalEl.removeAttribute('aria-modal');
        const bd = document.getElementById('pre-dq-backdrop');
        if (bd) bd.remove();
      }

      let _resolved = false;
      let _counts   = null;
      let _openCat  = null;

      function cleanup(result) {
        if (_resolved) return;
        _resolved = true;
        proceedBtn.removeEventListener('click', onProceed);
        cancelBtn.removeEventListener('click', onCancel);
        if (headerCloseBtn) headerCloseBtn.removeEventListener('click', onCancel);
        fixBtn.removeEventListener('click', onFix);
        _hideModal();
        resolve(result);
      }

      // Format a { startDate, endDate } object as a readable label (Q1 2026, H2 2026 etc.)
      function _fmtRange(r) {
        if (!r) return '';
        const y  = r.startDate.slice(0, 4);
        const sm = parseInt(r.startDate.slice(5, 7), 10);
        const em = parseInt(r.endDate.slice(5, 7), 10);
        const yr2 = parseInt(r.endDate.slice(0, 4), 10);
        const yr1 = parseInt(r.startDate.slice(0, 4), 10);
        const len = (yr2 - yr1) * 12 + em - sm + 1;
        if (len === 3)  return `Q${Math.floor((sm - 1) / 3) + 1} ${y}`;
        if (len === 6)  return sm <= 6 ? `H1 ${y}` : `H2 ${y}`;
        if (len === 12) return y;
        // Fallback: format as dd/mm/yyyy – dd/mm/yyyy
        const fd = iso => { const p = iso.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : iso; };
        return `${fd(r.startDate)} – ${fd(r.endDate)}`;
      }

      const fmtDate = d => {
        if (!d) return '—';
        const p = d.split('-');
        return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d;
      };

      const cfLabel = _fmtRange(cfRange);
      const toLabel = _fmtRange(toRange);

      // SC (Sputum Conversion) period: one quarter before the CF period.
      // Uses pure date-component arithmetic to avoid timezone-offset bugs
      // (toISOString() returns UTC which can shift the date back by a day in UTC+N zones).
      const _shiftMonth = (iso, n) => {
        const parts = iso.split('-');
        let y = parseInt(parts[0], 10), m = parseInt(parts[1], 10) - 1, d = parseInt(parts[2], 10);
        m += n;
        y += Math.floor(m / 12);
        m = ((m % 12) + 12) % 12;
        const maxDay = new Date(y, m + 1, 0).getDate(); // last day of target month
        d = Math.min(d, maxDay);
        return `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      };
      const scRange = { startDate: _shiftMonth(cfRange.startDate, -3), endDate: _shiftMonth(cfRange.endDate, -3) };
      const scLabel = _fmtRange(scRange);

      if (periodInfoEl) {
        const fd = d => { if (!d) return '—'; const p = d.split('-'); return p.length === 3 ? `${p[2]}/${p[1]}/${p[0]}` : d; };
        const cfDateRange = `${fd(cfRange.startDate)} – ${fd(cfRange.endDate)}`;
        const toDateRange = `${fd(toRange.startDate)} – ${fd(toRange.endDate)}`;
        const scDateRange = `${fd(scRange.startDate)} – ${fd(scRange.endDate)}`;
        periodInfoEl.innerHTML =
          `<strong style="display:block;margin-bottom:.35rem">Checking data quality for this report:</strong>` +
          `<div class="pre-dq-period-tags">` +
          `  <span class="pre-dq-tag pre-dq-tag--cf">&#128196; Case Finding&colon; ${escHtml(cfLabel)}</span>` +
          `  <span class="pre-dq-tag pre-dq-tag--sc">&#128300; Sputum Conversion&colon; ${escHtml(scLabel)}</span>` +
          `  <span class="pre-dq-tag pre-dq-tag--to">&#128203; Treatment Outcomes&colon; ${escHtml(toLabel)}</span>` +          
          `</div>` +
          `<div class="pre-dq-period-note">Checking&hellip;</div>`;
      }

      const CHECKS = [
        { key: 'missingreg',   label: 'Missing Patient Registration Info',            period: 'cf'   },
        { key: 'duplicates',   label: 'Duplicate Patients (Entered More Than Once)',  period: 'cf'   },
        { key: 'sametbno',     label: 'Duplicate Unit TB Numbers',                    period: 'cf'   },
        { key: 'diagmethod',   label: 'Diagnostic Method Not Recorded',               period: 'cf'   },
        { key: 'scmissed2',    label: 'Missed 2-Month Sputum Exam',                   period: 'sc'   },
        { key: 'scmissed3',    label: 'Missed 3-Month Sputum Exam',                   period: 'sc'   },
        { key: 'nooutcome',    label: 'Missing TB Treatment Outcome',                 period: 'to'   },
        { key: 'smearcured',   label: 'Smear-Negative But Declared Cured',            period: 'to'   },
        { key: 'notevaluated', label: 'Outcome Marked as "Not Evaluated"',            period: 'to'   },
        { key: 'skipped',      label: 'Skipped TB Numbers (Data Entry Gaps)',         period: 'year' },
      ];
      const PERIOD_LABEL = { cf: cfLabel, to: toLabel, sc: scLabel, year: `Year ${cfYear}` };

      // Show loading
      if (checklistEl) checklistEl.innerHTML =
        '<div class="pre-dq-loading"><div class="spinner-border spinner-border-sm text-primary me-2" role="status" aria-hidden="true"></div>Checking data quality&hellip;</div>';
      if (summaryEl)  summaryEl.style.display = 'none';
      if (detailEl)   detailEl.style.display  = 'none';
      proceedBtn.disabled = true;
      fixBtn.style.display = 'none';

      _showModal();

      // ── Server-first DQ fetch ─────────────────────────────────────────────
      // Pre-checks the global _reallyOnline flag (set by _pingConnectivity every
      // 15 s via a HEAD request).  This is the fastest way to detect "connected
      // but no data bundles": the HEAD ping times out at 3 s and flips the flag
      // before we even get here, so we skip the network round-trip entirely.
      // If _reallyOnline is true we make a fresh GET with a 5-second AbortController
      // timeout — tight enough to catch a stalling mobile connection quickly.
      // On any network failure (TypeError / AbortError) we immediately update
      // _reallyOnline and the nav-bar badge, then fall through to local SQLite.
      async function _serverDQ(path, extra) {
        if (!_reallyOnline) return null;          // already known offline — skip immediately
        const token = (typeof getToken === 'function') ? getToken() : null;
        if (!token) return null;
        const qs = new URLSearchParams();
        facilityIds.forEach(id => qs.append('facilityIds', id));
        qs.set('cfStart', cfRange.startDate);
        qs.set('cfEnd',   cfRange.endDate);
        qs.set('toStart', toRange.startDate);
        qs.set('toEnd',   toRange.endDate);
        qs.set('scStart', scRange.startDate);
        qs.set('scEnd',   scRange.endDate);
        if (cfYear) qs.set('cfYear', cfYear);
        if (extra) Object.entries(extra).forEach(([k, v]) => qs.set(k, v));
        const ctrl = new AbortController();
        const tid  = setTimeout(() => ctrl.abort(), 5_000);
        try {
          const resp = await fetch(`${API_BASE}/tb-patients/${path}?${qs}`, {
            headers: { 'Authorization': `Bearer ${token}` },
            cache: 'no-store', signal: ctrl.signal,
          });
          clearTimeout(tid);
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          return await resp.json();
        } catch (err) {
          clearTimeout(tid);
          // Network failure or timeout = truly offline; update badge immediately
          if (err instanceof TypeError || err.name === 'AbortError') {
            _reallyOnline = false;
            updateConnectionStatus();
          }
          return null;
        }
      }

      // Run counts after the modal opens
      setTimeout(async () => {
        let _dqSource = 'server';

        // 1. Try the live server
        _counts = await _serverDQ('dq-counts');

        // 2. Fall back to local SQLite if server is unreachable or times out
        if (!_counts) {
          _dqSource = 'local';
          try {
            _counts = (typeof getDQCountsForReport === 'function')
              ? getDQCountsForReport(facilityIds, cfRange.startDate, cfRange.endDate, toRange.startDate, toRange.endDate, cfYear, scRange.startDate, scRange.endDate)
              : null;
          } catch (e) { console.error('[PreDQ] local count error:', e); _counts = null; }
        }

        // Update the source note now that we know where the data came from
        if (periodInfoEl) {
          const noteEl = periodInfoEl.querySelector('.pre-dq-period-note');
          if (noteEl) {
            if (_dqSource === 'server') {
              noteEl.innerHTML = '&#10003;&nbsp;Checked against live eTBr server data.';
              noteEl.style.color = '#059669';
            } else {
              noteEl.innerHTML = '&#9888;&nbsp;Offline &mdash; based on locally synced data.';
              noteEl.style.color = '#d97706';
            }
          }
        }

        if (!_counts) {
          if (checklistEl) checklistEl.innerHTML =
            '<div class="pre-dq-loading text-warning">Data not available — checks skipped.</div>';
          proceedBtn.disabled = false;
          return;
        }

        const totalIssues = CHECKS.reduce((s, c) => s + (_counts[c.key] || 0), 0);

        // Build checklist rows
        if (checklistEl) {
          const hint = `<div class="pre-dq-hint">&#128270; Click a row with issues to view the affected patients.</div>`;
          const hdr = `<div class="pre-dq-checklist-hdr">
            <div></div><div></div>
            <div class="pre-dq-hdr-cell">Quarter</div>
            <div class="pre-dq-hdr-cell">Issues</div>
          </div>`;
          checklistEl.innerHTML = hint + hdr + CHECKS.map(c => {
            const n    = _counts[c.key] || 0;
            const pass = n === 0;
            const icon = pass
              ? `<span class="pre-dq-icon pre-dq-icon--pass" aria-label="Passed">&#10003;</span>`
              : `<span class="pre-dq-icon pre-dq-icon--fail" aria-label="Failed">&#10007;</span>`;
            const countEl = pass
              ? `<span class="pre-dq-count pre-dq-count--pass">0</span>`
              : `<span class="pre-dq-count pre-dq-count--fail">${n}</span>`;
            return `<div class="pre-dq-row${pass ? '' : ' pre-dq-row--fail'}" data-cat="${escHtml(c.key)}"
              ${!pass ? `title="Click to ${n === 1 ? 'see 1 affected patient' : `see ${n} affected patients`}"` : ''}>
              <div class="pre-dq-row-icon">${icon}</div>
              <div class="pre-dq-row-label">${escHtml(c.label)}</div>
              <div class="pre-dq-row-period"><span class="pre-dq-period-badge">${escHtml(PERIOD_LABEL[c.period] || '')}</span></div>
              <div class="pre-dq-row-count">${countEl}</div>
            </div>`;
          }).join('');

          // Delegate: click on a failing row → toggle detail
          checklistEl.addEventListener('click', e => {
            const row = e.target.closest('[data-cat].pre-dq-row--fail');
            if (!row || !row.dataset.cat) return;
            const cat = row.dataset.cat;
            if (_openCat === cat) {
              // Toggle off — close the detail panel
              if (detailEl) detailEl.style.display = 'none';
              row.classList.remove('pre-dq-row--open');
              _openCat = null;
            } else {
              // Close any previously open row highlight
              const prev = checklistEl.querySelector('.pre-dq-row--open');
              if (prev) prev.classList.remove('pre-dq-row--open');
              row.classList.add('pre-dq-row--open');
              _openCat = cat;
              _showDetail(cat);
            }
          });
        }

        // Summary
        const _DQ_AUTO_CLOSE_KEY = 'art.dqAutoClose';
        if (summaryEl) {
          if (totalIssues === 0) {
            summaryEl.className = 'pre-dq-summary pre-dq-summary--pass';
            summaryEl.innerHTML = `<strong>&#10003; All checks passed.</strong> Your data looks good — proceed with generating the report.`;
          } else {
            summaryEl.className = 'pre-dq-summary pre-dq-summary--fail';
            summaryEl.innerHTML = `<strong>&#9888; ${totalIssues} issue${totalIssues === 1 ? '' : 's'} found.</strong> Your report may not be accurate. Fix the issues first, or generate anyway.`;
          }
          summaryEl.style.display = '';
        }

        // Show the auto-close preference pill below the checklist table
        if (autoclosePill && autocloseCb) {
          autocloseCb.checked = localStorage.getItem(_DQ_AUTO_CLOSE_KEY) === '1';
          autoclosePill.style.display = '';
          autocloseCb.onchange = e => localStorage.setItem(_DQ_AUTO_CLOSE_KEY, e.target.checked ? '1' : '0');
        }

        proceedBtn.disabled = false;
        if (proceedLabel) proceedLabel.textContent = totalIssues > 0 ? 'Generate Anyway' : 'Generate Report';
        proceedBtn.classList.toggle('btn-danger',   totalIssues > 0);
        proceedBtn.classList.toggle('btn-primary',  totalIssues === 0);
        if (totalIssues > 0) fixBtn.style.display = '';

        // Auto-close only when the user has explicitly opted in via the preference checkbox.
        if (totalIssues === 0 && localStorage.getItem(_DQ_AUTO_CLOSE_KEY) === '1') {
          setTimeout(() => { if (!_resolved) cleanup(true); }, 1400);
        }
      }, 200);

      // Show patient detail list for the clicked category
      function _showDetail(cat) {
        if (!detailEl || !detailTbody) return;
        const def   = CHECKS.find(c => c.key === cat);
        const label = def ? def.label : cat;
        const per   = def ? (PERIOD_LABEL[def.period] || '') : '';
        if (detailTitleEl) detailTitleEl.textContent = `${label} — ${per}`;
        const isSkipped = cat === 'skipped';
        if (detailThead) detailThead.innerHTML = isSkipped ? _THEAD_SKIPPED : _THEAD_FULL;
        const _cols = isSkipped ? _COL_SKIP : _COL_FULL;
        detailTbody.innerHTML = `<tr><td colspan="${_cols}" class="text-center py-2 text-muted">Loading&hellip;</td></tr>`;
        detailEl.style.display = '';
        // Scroll to detail
        setTimeout(() => detailEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 60);

        setTimeout(async () => {
          // Server-first: try live API, fall back to local SQLite
          let rows = null;
          try { rows = await _serverDQ('dq-list', { category: cat }); } catch (_) {}
          if (!rows) {
            try {
              rows = (typeof getDQListForReport === 'function')
                ? getDQListForReport(cat, facilityIds, cfRange.startDate, cfRange.endDate, toRange.startDate, toRange.endDate, cfYear, scRange.startDate, scRange.endDate)
                : [];
            } catch (e) { console.error('[PreDQ] detail local error:', e); rows = []; }
          }

          try {
            if (!rows.length) {
              detailTbody.innerHTML = `<tr><td colspan="${_cols}" class="text-center py-2 text-success">&#10003; No issues found.</td></tr>`;
              return;
            }

            const esc = escHtml;
            const fd  = fmtDate;

            if (isSkipped) {
              detailTbody.innerHTML =
                rows.slice(0, 250).map(r =>
                  `<tr><td>${esc(String(r.MissingTBNo || '').padStart(3,'0'))}/${r.RegYear || ''}</td>` +
                  `<td>${esc(r.HealthFacility || '—')}</td></tr>`
                ).join('') +
                (rows.length > 250 ? `<tr><td colspan="${_cols}" class="text-center text-muted fst-italic py-1">… and ${rows.length - 250} more</td></tr>` : '');
              return;
            }

            const noteFor = r => {
              if (cat === 'missingreg' && r.MissingFields)    return esc(r.MissingFields);
              if (cat === 'smearcured' && r.Outcome)          return `Outcome: ${esc(r.Outcome)}`;
              if (cat === 'nooutcome' || cat === 'notevaluated') {
                const info = _tbExpectedEndInfo(r);
                if (info) return `Due: ${info.endFmt} <span style="color:#dc2626;white-space:nowrap">&#9650; ${info.daysOver}d overdue</span>`;
                if (r.DaysSinceStart != null) return `${r.DaysSinceStart}d on Rx`;
              }
              if (cat === 'sametbno'  && r.UnitTBNo)          return `TB No: ${esc(r.UnitTBNo)}`;
              if (cat === 'duplicates')                       return 'Possible duplicate';
              if (cat === 'diagmethod')                       return 'Method not recorded';
              if (cat === 'scmissed2')                        return 'No 2-month smear done';
              if (cat === 'scmissed3')                        return 'No 3-month smear done';
              return '—';
            };

            detailTbody.innerHTML =
              rows.slice(0, 250).map(r =>
                `<tr data-tid="${esc(String(r.PtDetailsTID || ''))}" data-hfid="${r.NearestHFID || 0}" data-hfname="${esc(r.HealthFacility || '')}" style="cursor:pointer" title="Click to open this patient's record">
                  <td>${esc(r.UnitTBNo || '—')}</td>
                  <td>${fd(r.RegDate)}</td>
                  <td>${esc(_xlTitleCase(r.PtName) || '—')}</td>
                  <td>${r.Age || '—'}</td>
                  <td>${r.SexID === 1 ? 'M' : r.SexID === 2 ? 'F' : '—'}</td>
                  <td>${esc(r.HealthFacility || '—')}</td>
                  <td><span class="pre-dq-detail-note">${noteFor(r)}</span></td>
                </tr>`
              ).join('') +
              (rows.length > 250 ? `<tr><td colspan="7" class="text-center text-muted fst-italic py-1">… and ${rows.length - 250} more</td></tr>` : '');

            // Row click — open the patient's record; back button restores this modal
            if (typeof startEditTBPatient === 'function' && typeof userCanWrite === 'function' && userCanWrite()) {
              detailTbody.querySelectorAll('tr[data-tid]').forEach(tr => {
                tr.addEventListener('click', () => {
                  const tid    = tr.dataset.tid;
                  const hfid   = Number(tr.dataset.hfid);
                  const hfname = tr.dataset.hfname || '';
                  if (!tid || !hfid) return;

                  const savedCat = _openCat;

                  // Hide (but do not resolve) the pre-report DQ modal so the
                  // patient form can fill the screen.  _preReportDQReshowFn is
                  // read by the back-button handler to restore this modal.
                  _hideModal();
                  _preReportDQReshowFn = () => {
                    _showModal();
                    if (savedCat) setTimeout(() => _showDetail(savedCat), 80);
                  };
                  _fromPreReportDQ = true;

                  const doOpen = async () => {
                    const facInfo = (typeof getMonitoringFacilityInfo === 'function')
                      ? getMonitoringFacilityInfo(hfid) : null;
                    _saveSelectedFacility({
                      id: hfid, name: hfname,
                      county:   facInfo ? (facInfo.County   || '') : '',
                      state:    facInfo ? (facInfo.State    || '') : '',
                      countyId: facInfo ? (facInfo.CountyID || 0)  : 0,
                      stateId:  facInfo ? (facInfo.StateID  || 0)  : 0
                    });
                    if (artRegisterScreen) artRegisterScreen.hidden = false;
                    _selectedRegister = 'tb';
                    updateFacilityBanner();
                    applyFacilityGate();
                    window.scrollTo({ top: 0, behavior: 'instant' });
                    loadAndRenderGeoTree();
                    const backBtn = document.getElementById('back-to-dashboard-btn');
                    if (backBtn) backBtn.innerHTML =
                      `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> DQ Check`;
                    const bottomBackBtn = document.getElementById('tb-back-to-monitoring-btn');
                    if (bottomBackBtn) {
                      bottomBackBtn.hidden = false;
                      bottomBackBtn.innerHTML =
                        `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg> Back to DQ Check`;
                    }
                    _pendingDQCategory = savedCat;
                    await _fetchAndUpsertTBPatientIfNeeded(tid);
                    startEditTBPatient(tid);
                  };

                  // If the report modal is still open, dismiss it first
                  const rptModal = document.getElementById('art-report-modal');
                  if (rptModal && rptModal.classList.contains('show')) {
                    rptModal.addEventListener('hidden.bs.modal', () => setTimeout(doOpen, 80), { once: true });
                    const closeBtn = rptModal.querySelector('[data-bs-dismiss="modal"]');
                    if (closeBtn) closeBtn.click(); else doOpen();
                  } else {
                    doOpen();
                  }
                });
              });
            }
          } catch (e) {
            console.error('[PreDQ] _showDetail error:', e);
            detailTbody.innerHTML = `<tr><td colspan="7" class="text-danger text-center py-2">Error loading details.</td></tr>`;
          }
        }, 60);
      }

      const onProceed = async () => {
        if (_resolved) return;
        // Audit-log any issues the user chose to ignore
        if (_counts) {
          const ignored = CHECKS.filter(c => (_counts[c.key] || 0) > 0);
          if (ignored.length) {
            const issueStr = ignored.map(c => `${c.label} (${_counts[c.key]})`).join('; ');
            const u = (typeof getUser === 'function') ? getUser() : null;
            try {
              await insertAuditLog({
                action:   'REPORT_DQ_IGNORED',
                notes:    `User generated TB quarterly report despite DQ issues — ${issueStr}. CF: ${cfRange.startDate}–${cfRange.endDate}; TO: ${toRange.startDate}–${toRange.endDate}`,
                userTID:  u?.userTID,
                userName: u?.fullName ?? u?.userName,
              });
            } catch (_) {}
          }
        }
        cleanup(true);
      };

      const onCancel  = () => { if (!_resolved) cleanup(false); };

      const onFix = () => {
        if (_resolved) return;
        _resolved = true;
        _hideModal(); // hide the DQ modal

        // ── Capture current report form selections before anything changes ─
        const _saved = {};
        ['rpt-data-source','rpt-programme','rpt-sub-type','rpt-period-type',
         'rpt-period','rpt-year','rpt-cf-quarter','rpt-cf-year'].forEach(id => {
          const el = document.getElementById(id);
          if (el) _saved[id] = el.value;
        });
        // Save only the IDs of checked facility checkboxes
        _saved.facilityCbs = [];
        document.querySelectorAll('.rpt-tree-cb[data-level="facility"]').forEach(cb => {
          if (cb.checked) _saved.facilityCbs.push(cb.dataset.id);
        });

        // Navigate to TB Quality and inject the "Return to Report" banner
        const _doNavigate = () => {
          if (typeof showTBQuality === 'function') showTBQuality();
          const _existing = document.getElementById('dq-return-banner');
          if (_existing) _existing.remove();
          const _banner = document.createElement('div');
          _banner.id = 'dq-return-banner';
          _banner.style.cssText = 'position:sticky;top:0;z-index:200;background:#fffbeb;border-bottom:2px solid #f59e0b;padding:.55rem 1rem;display:flex;align-items:center;gap:.75rem;font-size:.875rem;';
          _banner.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="#d97706" stroke-width="2" width="16" height="16" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<span style="flex:1;color:#92400e">Fix the issues below, then click <strong>Return to Report</strong> to continue generating your report.</span>' +
            '<button id="dq-return-btn" type="button" style="background:#1a3a5c;color:#fff;border:none;border-radius:.375rem;padding:.35rem .85rem;font-size:.8rem;cursor:pointer;white-space:nowrap;flex-shrink:0">&#8617;&#xFE0E; Return to Report</button>';
          const _screen = document.getElementById('tb-quality-screen');
          if (_screen) _screen.insertBefore(_banner, _screen.firstChild);
          document.getElementById('dq-return-btn')?.addEventListener('click', () => {
            _banner.remove();
            if (typeof hideTBQuality === 'function') hideTBQuality();
            setTimeout(() => {
              const _m = document.getElementById('art-report-modal');
              // Register restore handler BEFORE triggering the modal open
              if (_m && _saved['rpt-programme']) {
                _m.addEventListener('shown.bs.modal', () => {
                  // Restore in cascade order: parent selects first, then children
                  const _set = id => {
                    const el = document.getElementById(id);
                    if (el && _saved[id] !== undefined) {
                      el.value = _saved[id];
                      el.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                  };
                  // Tier 1: data-source and programme (triggers sub-type rebuild)
                  _set('rpt-data-source');
                  _set('rpt-programme');
                  setTimeout(() => {
                    // Tier 2: sub-type and period-type (triggers period rebuild)
                    _set('rpt-sub-type');
                    _set('rpt-period-type');
                    setTimeout(() => {
                      // Tier 3: leaf fields
                      ['rpt-period','rpt-year','rpt-cf-quarter','rpt-cf-year'].forEach(_set);
                      // Tier 4: restore facility checkboxes
                      if (_saved.facilityCbs.length) {
                        document.querySelectorAll('.rpt-tree-cb[data-level="facility"]').forEach(cb => {
                          const want = _saved.facilityCbs.includes(cb.dataset.id);
                          if (cb.checked !== want) {
                            cb.checked = want;
                            cb.dispatchEvent(new Event('change', { bubbles: true }));
                          }
                        });
                      }
                    }, 80);
                  }, 80);
                }, { once: true });
              }
              document.getElementById('report-card')?.click();
            }, 350);
          });
        };

        // Close the report modal via Bootstrap's own dismiss button so that
        // Bootstrap resets _isShown = false. Without this, reopening fails silently.
        const rptModal = document.getElementById('art-report-modal');
        if (rptModal && rptModal.classList.contains('show')) {
          rptModal.addEventListener('hidden.bs.modal', () => setTimeout(_doNavigate, 80), { once: true });
          const _closeBtn = rptModal.querySelector('[data-bs-dismiss="modal"]');
          if (_closeBtn) {
            _closeBtn.click();
          } else {
            // Fallback if no dismiss button exists
            rptModal.classList.remove('show');
            rptModal.style.display = '';
            rptModal.setAttribute('aria-hidden', 'true');
            rptModal.removeAttribute('aria-modal');
            document.querySelectorAll('.modal-backdrop').forEach(el => el.remove());
            document.body.classList.remove('modal-open');
            document.body.style.removeProperty('padding-right');
            setTimeout(_doNavigate, 100);
          }
        } else {
          setTimeout(_doNavigate, 100);
        }

        resolve(false);
      };

      if (closeDetailBtn) closeDetailBtn.addEventListener('click', () => {
        if (detailEl) detailEl.style.display = 'none';
        if (checklistEl) { const prev = checklistEl.querySelector('.pre-dq-row--open'); if (prev) prev.classList.remove('pre-dq-row--open'); }
        _openCat = null;
      });
      proceedBtn.addEventListener('click', onProceed);
      cancelBtn.addEventListener('click',  onCancel);
      if (headerCloseBtn) headerCloseBtn.addEventListener('click', onCancel);
      fixBtn.addEventListener('click',     onFix);
    });
  }

  // ── TB Quarterly Report generator ────────────────────────────────────
  async function generateTbQuarterlyReport() {
    // Offline guard — the outer click handler routes offline calls to
    // generateTbQuarterlyReportOffline(), so if we reach here we are online.
    // Keep the guard as a belt-and-braces fallback.
    if (!_reallyOnline) {
      const _offlineMsg = 'Report generation requires an internet connection. You are currently offline. Please reconnect and try again.';
      setStatus(_offlineMsg, 'warning');
      showToast(_offlineMsg, 'error');
      return;
    }

    // Derive date ranges from the three period selectors
    // CF date range — derived from the period type/period/year selectors
    const cfRange = getDateRange();
    if (!cfRange) { setStatus('Please select a valid reporting period.', 'warning'); return; }

    // Guard: CF period must not be entirely in the future.
    if (new Date(cfRange.startDate) > new Date()) {
      setStatus('Cannot generate a report for a future period.', 'warning');
      return;
    }

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected — please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    // ── Pre-report data quality check ───────────────────────────────────────
    {
      // Subtract exactly one year by decrementing the year digit — timezone-safe.
      // Quarters always start on the 1st and end on the last day of a month,
      // so decrementing the year is always correct (no leap-year edge cases).
      const _cfYear    = parseInt(cfRange.startDate.slice(0, 4), 10);
      const _cfEndYear = parseInt(cfRange.endDate.slice(0, 4), 10);
      const _toRange   = {
        startDate: `${_cfYear    - 1}-${cfRange.startDate.slice(5)}`,
        endDate:   `${_cfEndYear - 1}-${cfRange.endDate.slice(5)}`,
      };
      const _ok = await _runPreReportDQCheck(facilityIds, cfRange, _toRange, _cfYear);
      if (!_ok) { generateBtn.disabled = false; return; }
    }
    // ── End pre-report DQ check ─────────────────────────────────────────────

    const qs = new URLSearchParams({ cfStartDate: cfRange.startDate, cfEndDate: cfRange.endDate });
    for (const id of facilityIds) qs.append('facilityIds', id);

    const sseUrl = `${API_BASE}/reports/tb-quarterly-progress?${qs}`;
    setStatus('Generating TB quarterly report…', 'info');
    clearProgress();
    generateBtn.disabled = true;
    console.log('[TB Report] SSE URL:', sseUrl);

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);

    try {
      const resp = await fetch(sseUrl, { headers: { Authorization: `Bearer ${authToken}` } });
      console.log('[TB Report] SSE response status:', resp.status, resp.statusText);

      if (!resp.ok) {
        let errMsg = `eTBr server error (${resp.status}).`;
        try {
          const rawBody = await resp.text();
          console.error('[TB Report] eTBr server error body:', rawBody);
          const j = JSON.parse(rawBody);
          errMsg = j.error || errMsg;
        } catch { /* ignore */ }
        setStatus(errMsg, 'danger');
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let downloadToken    = null;
      let downloadFilename = null;

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split('\n\n');
        buf = events.pop();

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload) continue;

          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.error) {
            setStatus(evt.error, 'danger');
            clearProgress();
            return;
          }
          if (evt.done) {
            downloadToken    = evt.token;
            downloadFilename = evt.filename;
            setProgress(evt.total ?? 1, evt.total ?? 1, 'Finalising…');
            break streamLoop;
          }
          if (evt.step !== undefined) {
            setProgress(evt.step, evt.total, evt.label || '');
            setStatus(`Step ${evt.step} of ${evt.total}: ${evt.label || ''}`, 'info');
          }
        }
      }

      if (!downloadToken) {
        setStatus('Report generation incomplete. Please try again.', 'danger');
        clearProgress();
        return;
      }

      setStatus('Downloading report…', 'info');
      const dlUrl  = `${API_BASE}/reports/tb-quarterly-download?token=${encodeURIComponent(downloadToken)}`;
      const dlResp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${authToken}` } });

      if (!dlResp.ok) {
        let errMsg = `Download failed (${dlResp.status}).`;
        try { const j = await dlResp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        clearProgress();
        return;
      }

      const blob    = await dlResp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor  = document.createElement('a');
      anchor.href     = blobUrl;
      anchor.download = downloadFilename || `TB_NTP_${cfRange.startDate.slice(0, 7)}_SV.xlsx`;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setStatus('TB quarterly report downloaded successfully.', 'success');
      clearProgress();
    } catch (err) {
      console.error('[TB Report] SSE/download failed:', err?.name, err?.message);
      setStatus('Failed to generate the report. Check your connection and try again.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── TB Quarterly Report — Read from DHIS2 ────────────────────────────
  // Converts DHIS2 period strings like ["2026Q1"] or ["2026Q1","2026Q2"]
  // to a filename-friendly label: "Q1_2026" or "Q1-Q2_2026".
  function formatDhis2PeriodForFilename(periods) {
    if (!periods || periods.length === 0) return '';
    if (periods.length === 1) {
      const m = periods[0].match(/^(\d{4})Q(\d+)$/);
      return m ? `Q${m[2]}_${m[1]}` : periods[0];
    }
    const year = (periods[periods.length - 1].match(/^(\d{4})/) || [])[1] || '';
    const qs = periods.map(p => { const m = p.match(/Q(\d+)$/); return m ? `Q${m[1]}` : p; }).join('-');
    return year ? `${qs}_${year}` : qs;
  }

  async function generateTbQuarterlyFromDhis2() {
    const year = parseInt(yearSel.value, 10);
    const type = periodTypeSel.value;    // 'quarterly' | 'semiannually' | 'annually'
    const val  = periodSel.value;        // e.g. 'q1', 'h2', or '' for annually

    if (!year) {
      setStatus('Please select a year.', 'warning');
      return;
    }
    if (type !== 'annually' && !val) {
      setStatus('Please select a period.', 'warning');
      return;
    }

    // Build the list of DHIS2 period strings (e.g. ["2026Q1", "2026Q2"])
    let dhis2Periods;
    if (type === 'quarterly') {
      const qNum = { q1: 1, q2: 2, q3: 3, q4: 4 }[val];
      if (!qNum) { setStatus('Please select a valid quarter.', 'warning'); return; }
      dhis2Periods = [`${year}Q${qNum}`];
    } else if (type === 'semiannually') {
      dhis2Periods = val === 'h1'
        ? [`${year}Q1`, `${year}Q2`]
        : [`${year}Q3`, `${year}Q4`];
    } else { // annually
      dhis2Periods = [`${year}Q1`, `${year}Q2`, `${year}Q3`, `${year}Q4`];
    }

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected \u2014 please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    const qs = new URLSearchParams();
    for (const p of dhis2Periods) qs.append('periods', p);
    for (const id of facilityIds) qs.append('facilityIds', id);

    setStatus('Fetching TB report data from DHIS2\u2026', 'info');
    clearProgress();
    generateBtn.disabled = true;

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    try {
      const resp = await fetch(`${API_BASE}/dhis2/tb-read-ntp?${qs}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (!resp.ok) {
        let errMsg = `DHIS2 read error (${resp.status}).`;
        try { const j = await resp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let downloadToken    = null;
      let downloadFilename = null;

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split('\n\n');
        buf = events.pop();

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload) continue;

          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.error) { setStatus(evt.error, 'danger'); clearProgress(); return; }
          if (evt.done) {
            downloadToken    = evt.token;
            downloadFilename = evt.filename;
            setProgress(evt.total ?? 1, evt.total ?? 1, 'Finalising\u2026');
            break streamLoop;
          }
          if (evt.step !== undefined) {
            setProgress(evt.step, evt.total, evt.label || '');
            setStatus(`Step ${evt.step} of ${evt.total}: ${evt.label || ''}`, 'info');
          }
        }
      }

      if (!downloadToken) {
        setStatus('Report generation incomplete. Please try again.', 'danger');
        clearProgress();
        return;
      }

      setStatus('Downloading report\u2026', 'info');
      const dlUrl  = `${API_BASE}/dhis2/tb-read-ntp-download?token=${encodeURIComponent(downloadToken)}`;
      const dlResp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${authToken}` } });

      if (!dlResp.ok) {
        let errMsg = `Download failed (${dlResp.status}).`;
        try { const j = await dlResp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        clearProgress();
        return;
      }

      const blob    = await dlResp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor  = document.createElement('a');
      anchor.href     = blobUrl;
      anchor.download = downloadFilename || `TB_NTP_from_DHIS2_${formatDhis2PeriodForFilename(dhis2Periods)}_DHIS.xlsx`;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setStatus('TB NTP report from DHIS2 downloaded successfully.', 'success');
      clearProgress();
    } catch (err) {
      console.error('[DHIS2 Read] Failed:', err?.name, err?.message);
      setStatus('Failed to fetch report from DHIS2. Check your connection and try again.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── DS-TB LFA Verification Report — Read from DHIS2 ─────────────────
  async function generateLfaFromDhis2() {
    const year = parseInt(yearSel.value, 10);
    const type = periodTypeSel.value;    // 'quarterly' | 'semiannually' | 'annually'
    const val  = periodSel.value;        // e.g. 'q1', 'h2', or '' for annually

    if (!year) {
      setStatus('Please select a year.', 'warning');
      return;
    }
    if (type !== 'annually' && !val) {
      setStatus('Please select a period.', 'warning');
      return;
    }

    // Build the list of DHIS2 period strings (e.g. ["2026Q1", "2026Q2"])
    let dhis2Periods;
    if (type === 'quarterly') {
      const qNum = { q1: 1, q2: 2, q3: 3, q4: 4 }[val];
      if (!qNum) { setStatus('Please select a valid quarter.', 'warning'); return; }
      dhis2Periods = [`${year}Q${qNum}`];
    } else if (type === 'semiannually') {
      dhis2Periods = val === 'h1'
        ? [`${year}Q1`, `${year}Q2`]
        : [`${year}Q3`, `${year}Q4`];
    } else { // annually
      dhis2Periods = [`${year}Q1`, `${year}Q2`, `${year}Q3`, `${year}Q4`];
    }

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected \u2014 please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    const qs = new URLSearchParams();
    for (const p of dhis2Periods) qs.append('periods', p);
    for (const id of facilityIds) qs.append('facilityIds', id);

    setStatus('Fetching LFA Verification data from DHIS2\u2026', 'info');
    clearProgress();
    generateBtn.disabled = true;

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    try {
      const resp = await fetch(`${API_BASE}/dhis2/tb-read-lfa?${qs}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });

      if (!resp.ok) {
        let errMsg = `DHIS2 LFA read error (${resp.status}).`;
        try { const j = await resp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let downloadToken    = null;
      let downloadFilename = null;

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split('\n\n');
        buf = events.pop();

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload) continue;

          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.error) { setStatus(evt.error, 'danger'); clearProgress(); return; }
          if (evt.done) {
            downloadToken    = evt.token;
            downloadFilename = evt.filename;
            setProgress(evt.total ?? 1, evt.total ?? 1, 'Finalising\u2026');
            break streamLoop;
          }
          if (evt.step !== undefined) {
            setProgress(evt.step, evt.total, evt.label || '');
            setStatus(`Step ${evt.step} of ${evt.total}: ${evt.label || ''}`, 'info');
          }
        }
      }

      if (!downloadToken) {
        setStatus('Report generation incomplete. Please try again.', 'danger');
        clearProgress();
        return;
      }

      setStatus('Downloading LFA Verification Report\u2026', 'info');
      const dlUrl  = `${API_BASE}/dhis2/tb-read-lfa-download?token=${encodeURIComponent(downloadToken)}`;
      const dlResp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${authToken}` } });

      if (!dlResp.ok) {
        let errMsg = `Download failed (${dlResp.status}).`;
        try { const j = await dlResp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        clearProgress();
        return;
      }

      const blob    = await dlResp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor  = document.createElement('a');
      anchor.href     = blobUrl;
      anchor.download = downloadFilename || `LFA_Verification_${formatDhis2PeriodForFilename(dhis2Periods)}_DHIS.xlsx`;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setStatus('DS-TB LFA Verification Report downloaded successfully.', 'success');
      clearProgress();
    } catch (err) {
      console.error('[DHIS2 LFA Read] Failed:', err?.name, err?.message);
      setStatus('Failed to fetch LFA report from DHIS2. Check your connection and try again.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── LFA Verification Report — eTBr Server ────────────────────────────
  async function generateLfaFromServer() {
    if (!_reallyOnline) {
      const _offMsg = 'Report generation requires an internet connection. You are currently offline.';
      setStatus(_offMsg, 'warning');
      showToast(_offMsg, 'error');
      return;
    }

    const cfRange = getDateRange();
    if (!cfRange) { setStatus('Please select a valid reporting period.', 'warning'); return; }

    if (new Date(cfRange.startDate) > new Date()) {
      setStatus('Cannot generate a report for a future period.', 'warning');
      return;
    }

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected \u2014 please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    const qs = new URLSearchParams({ cfStartDate: cfRange.startDate, cfEndDate: cfRange.endDate });
    for (const id of facilityIds) qs.append('facilityIds', id);

    const sseUrl = `${API_BASE}/reports/tb-lfa-progress?${qs}`;
    setStatus('Generating DS-TB LFA Verification Report\u2026', 'info');
    clearProgress();
    generateBtn.disabled = true;

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    try {
      const resp = await fetch(sseUrl, { headers: { Authorization: `Bearer ${authToken}` } });

      if (!resp.ok) {
        let errMsg = `eTBr server error (${resp.status}).`;
        try {
          const rawBody = await resp.text();
          const j = JSON.parse(rawBody);
          errMsg = j.error || errMsg;
        } catch { /* ignore */ }
        setStatus(errMsg, 'danger');
        return;
      }

      const reader  = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let downloadToken    = null;
      let downloadFilename = null;

      streamLoop: while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });

        const events = buf.split('\n\n');
        buf = events.pop();

        for (const rawEvent of events) {
          const dataLine = rawEvent.split('\n').find(l => l.startsWith('data: '));
          if (!dataLine) continue;
          const payload = dataLine.slice(6).trim();
          if (!payload) continue;

          let evt;
          try { evt = JSON.parse(payload); } catch { continue; }

          if (evt.error) { setStatus(evt.error, 'danger'); clearProgress(); return; }
          if (evt.done) {
            downloadToken    = evt.token;
            downloadFilename = evt.filename;
            setProgress(evt.total ?? 1, evt.total ?? 1, 'Finalising\u2026');
            break streamLoop;
          }
          if (evt.step !== undefined) {
            setProgress(evt.step, evt.total, evt.label || '');
            setStatus(`Step ${evt.step} of ${evt.total}: ${evt.label || ''}`, 'info');
          }
        }
      }

      if (!downloadToken) {
        setStatus('Report generation incomplete. Please try again.', 'danger');
        clearProgress();
        return;
      }

      setStatus('Downloading LFA Verification Report\u2026', 'info');
      const dlUrl  = `${API_BASE}/reports/tb-lfa-download?token=${encodeURIComponent(downloadToken)}`;
      const dlResp = await fetch(dlUrl, { headers: { Authorization: `Bearer ${authToken}` } });

      if (!dlResp.ok) {
        let errMsg = `Download failed (${dlResp.status}).`;
        try { const j = await dlResp.json(); errMsg = j.error || errMsg; } catch { }
        setStatus(errMsg, 'danger');
        clearProgress();
        return;
      }

      const blob    = await dlResp.blob();
      const blobUrl = URL.createObjectURL(blob);
      const anchor  = document.createElement('a');
      anchor.href     = blobUrl;
      anchor.download = downloadFilename || `LFA_Verification_${cfRange.startDate.slice(0, 7)}_SV.xlsx`;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

      setStatus('DS-TB LFA Verification Report downloaded successfully.', 'success');
      clearProgress();
    } catch (err) {
      console.error('[LFA Report] SSE/download failed:', err?.name, err?.message);
      setStatus('Failed to generate the LFA report. Check your connection and try again.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── LFA Verification Report — Offline (This Computer) ─────────────────
  async function generateLfaOffline() {
    const cfRange = getDateRange();
    if (!cfRange) { setStatus('Please select a valid reporting period.', 'warning'); return; }

    if (new Date(cfRange.startDate) > new Date()) {
      setStatus('Cannot generate a report for a future period.', 'warning');
      return;
    }

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected — please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    setStatus('Generating offline LFA Verification Report\u2026', 'info');
    clearProgress();
    generateBtn.disabled = true;

    try {
      const _db = window._patientDb;
      if (!_db) { setStatus('Local database is not available. Sync at least once while online.', 'danger'); return; }

      const execSql = (sql, params = []) => {
        const result = _db.exec(sql, params);
        if (!result || result.length === 0) return [];
        const { columns, values } = result[0];
        return values.map(row => Object.fromEntries(columns.map((col, i) => [col, row[i]])));
      };

      // Derive period
      const cfStart = cfRange.startDate;   // 'YYYY-MM-DD'
      const cfEnd   = cfRange.endDate;

      const cfStartDate = new Date(cfStart);
      const cfEndDate   = new Date(cfEnd);
      const periodMonths =
        (cfEndDate.getFullYear() - cfStartDate.getFullYear()) * 12 +
        cfEndDate.getMonth() - cfStartDate.getMonth() + 1;

      // TO period is 12 months earlier
      const toStartDate = new Date(cfStartDate); toStartDate.setFullYear(toStartDate.getFullYear() - 1);
      const toEndDate   = new Date(cfEndDate);   toEndDate.setFullYear(toEndDate.getFullYear() - 1);
      const toStart = toStartDate.toISOString().slice(0, 10);
      const toEnd   = toEndDate.toISOString().slice(0, 10);

      const cfOrdinal   = periodMonths === 3 ? Math.floor((cfStartDate.getMonth()) / 3) + 1
                        : periodMonths === 6 ? (cfStartDate.getMonth() < 6 ? 1 : 2)
                        : 0;
      const toOrdinal   = periodMonths === 3 ? Math.floor((toStartDate.getMonth()) / 3) + 1
                        : periodMonths === 6 ? (toStartDate.getMonth() < 6 ? 1 : 2)
                        : 0;
      const cfYearStr   = String(cfStartDate.getFullYear());
      const toYearStr   = String(toStartDate.getFullYear());
      const cfQuarterStr = cfOrdinal > 0 ? String(cfOrdinal) : '1';
      const toQuarterStr = toOrdinal > 0 ? String(toOrdinal) : '1';
      const periodLabel = periodMonths === 3 ? `Q${cfOrdinal}` : periodMonths === 6 ? `H${cfOrdinal}` : 'Annual';

      // Local helpers
      const isSmearPos = (r) => [1, 4, 5, 6].includes(r);
      const isXpertPos = (r) => [3, 4, 5].includes(r);
      const isTbPBC    = (tbType, lab, xpert) => tbType === 1 && (isSmearPos(lab) || isXpertPos(xpert));
      const lfaAg      = (age) => age < 5 ? 0 : age < 10 ? 1 : age < 15 ? 2 : age < 20 ? 3 : age < 25 ? 4 :
                                  age < 35 ? 5 : age < 45 ? 6 : age < 55 ? 7 : age < 65 ? 8 : 9;

      // Column arrays for 10 LFA age groups
      const cfAgColsM  = ['V',  'W',  'X',  'Y',  'Z',  'AA', 'AB', 'AC', 'AD', 'AE'];
      const cfAgColsF  = ['AF', 'AG', 'AH', 'AI', 'AJ', 'AK', 'AL', 'AM', 'AN', 'AO'];
      const hivAgColsM = ['BC', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BK', 'BL'];
      const hivAgColsF = ['BM', 'BN', 'BO', 'BP', 'BQ', 'BR', 'BS', 'BT', 'BU', 'BV'];
      const artAgColsM = ['CE', 'CF', 'CG', 'CH', 'CI', 'CJ', 'CK', 'CL', 'CM', 'CN'];
      const artAgColsF = ['CO', 'CP', 'CQ', 'CR', 'CS', 'CT', 'CU', 'CV', 'CW', 'CX'];

      // Get facilities (ordered by county, name)
      const facIdList = facilityIds.join(',');
      const facilityRows = execSql(`
        SELECT hf.HealthFacilityID, hf.HealthFacility,
               COALESCE(c.County, '') AS County
        FROM   HealthFacilityT hf
        LEFT   JOIN CountyT c ON c.CountyID = hf.CountyID
        WHERE  hf.HealthFacilityID IN (${facIdList})
        ORDER  BY c.County, hf.HealthFacility`);

      if (facilityRows.length === 0) {
        setStatus('No facilities found in local database. Please sync while online.', 'danger');
        return;
      }

      setProgress(0, facilityRows.length + 1, 'Loading template\u2026');
      setStatus('Loading LFA template\u2026', 'info');

      if (typeof ExcelJS === 'undefined') {
        setStatus('Excel library (ExcelJS) is not loaded. Please go online once to cache it, then try again.', 'danger');
        return;
      }

      const templateResp = await fetch('./templates/Template_LFA_Verification_Report.xlsx');
      if (!templateResp.ok) {
        setStatus('LFA template not found. Please go online once to cache the templates, then try again.', 'danger');
        return;
      }
      const templateBuf = await templateResp.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(templateBuf);

      // The LFA template has two sheets: casefinding (index 0) and outcome (index 1)
      const ws = workbook.getWorksheet('casefinding') || workbook.worksheets[0];
      const wo = workbook.getWorksheet('outcome')     || workbook.worksheets[1];

      if (!ws || !wo) {
        setStatus('Could not locate required sheets in the LFA template. Please re-cache by going online once.', 'danger');
        return;
      }

      // Write cell helper
      const sw = (sheet, addr, val) => { sheet.getCell(addr).value = val; };

      let counter = 3; // first data row = counter + 1 = 4

      for (let fi = 0; fi < facilityRows.length; fi++) {
        const fac = facilityRows[fi];
        const facId = fac.HealthFacilityID;
        setProgress(fi + 1, facilityRows.length + 1, `Processing ${fac.HealthFacility}\u2026`);
        setStatus(`Processing ${fac.HealthFacility}\u2026`, 'info');
        counter++;

        // ── CF counters ────────────────────────────────────────────────
        let cfPBCNew = 0, cfPBCRelapse = 0, cfPBCPrevTreat = 0, cfPBCOther = 0;
        let cfPCDNew = 0, cfPCDRelapse = 0, cfPCDPrevTreat = 0, cfPCDOther = 0;
        let cfEPNew  = 0, cfEPRelapse  = 0, cfEPPrevTreat  = 0, cfEPOther  = 0;
        let cfSuspectsSeen = 0, cfPBCLab = 0;
        let cfTestedHIV = 0, cfTestedHIVPos = 0, cfTestedHIVART = 0, cfTestedHIVCPT = 0;
        let cfGeneXpert = 0, cfMicroscopy = 0, cfTBLam = 0, cfTrueNat = 0, cfXray = 0;
        let cfGeneXpertPos = 0, cfMicroscopyPos = 0, cfTrueNatPos = 0;
        // 10 age groups × 2 sexes
        const cfPBCNewRelapse = Array.from({length: 10}, () => [0, 0]);
        const cfHIVPos        = Array.from({length: 10}, () => [0, 0]);
        const cfARTHIVPos     = Array.from({length: 10}, () => [0, 0]);

        const cfRows = execSql(`
          SELECT pd.PtTypeID, pd.TbTypeID, pd.SexID,
                 COALESCE(pd.Age, 0)              AS Age,
                 COALESCE(pd.DiagMethodID, 0)     AS DiagMethodID,
                 COALESCE(fu.Mon0LabResultID, 0)   AS Mon0LabResultID,
                 COALESCE(fu.Mon0XpertResultID, 0) AS Mon0XpertResultID,
                 COALESCE(fu.HIVTestResultID, 0)   AS HIVTestResultID,
                 COALESCE(fu.OnART, 0)             AS OnART,
                 COALESCE(fu.OnCPT, 0)             AS OnCPT
          FROM PtDetailsT pd
          LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID AND fu.Deleted = 0
          WHERE pd.Deleted = 0
            AND pd.PtTypeID IN (1, 2, 3, 4, 6)
            AND pd.RegDate BETWEEN ? AND ?
            AND pd.NearestHFID = ?`, [cfStart, cfEnd, facId]);

        for (const r of cfRows) {
          const ptType   = r.PtTypeID   || 0;
          const tbType   = r.TbTypeID   || 0;
          const sexId    = r.SexID      || 0;
          const age      = r.Age        || 0;
          const diagMeth = r.DiagMethodID || 0;
          const lab      = r.Mon0LabResultID   || 0;
          const xpert    = r.Mon0XpertResultID || 0;
          const hivRes   = r.HIVTestResultID   || 0;
          const onART    = r.OnART || 0;
          const onCPT    = r.OnCPT || 0;

          const pbc = isTbPBC(tbType, lab, xpert);
          const pcd = !pbc && tbType === 1;
          const ep  = tbType === 3;
          const si  = sexId === 2 ? 1 : 0;
          const ag  = lfaAg(age);

          if (pbc) {
            if      (ptType === 1)               cfPBCNew++;
            else if (ptType === 2)               cfPBCRelapse++;
            else if (ptType === 3 || ptType === 4) cfPBCPrevTreat++;
            else if (ptType === 6)               cfPBCOther++;
          } else if (pcd) {
            if      (ptType === 1)               cfPCDNew++;
            else if (ptType === 2)               cfPCDRelapse++;
            else if (ptType === 3 || ptType === 4) cfPCDPrevTreat++;
            else if (ptType === 6)               cfPCDOther++;
          } else if (ep) {
            if      (ptType === 1)               cfEPNew++;
            else if (ptType === 2)               cfEPRelapse++;
            else if (ptType === 3 || ptType === 4) cfEPPrevTreat++;
            else if (ptType === 6)               cfEPOther++;
          }

          if (pbc) cfPBCLab++;
          if (pbc && (ptType === 1 || ptType === 2)) cfPBCNewRelapse[ag][si]++;

          if (ptType === 1 || ptType === 2) {
            if      (diagMeth === 1) { cfGeneXpert++;  if (isXpertPos(xpert)) cfGeneXpertPos++; }
            else if (diagMeth === 2) { cfMicroscopy++; if (isSmearPos(lab))   cfMicroscopyPos++; }
            else if (diagMeth === 3) { cfTBLam++; }
            else if (diagMeth === 4) { cfTrueNat++;    if (isXpertPos(xpert)) cfTrueNatPos++; }
            else if (diagMeth === 5) { cfXray++; }
          }

          if (hivRes > 0) cfTestedHIV++;
          if (hivRes === 2) {
            cfTestedHIVPos++;
            cfHIVPos[ag][si]++;
            if (onART === 1) { cfTestedHIVART++; cfARTHIVPos[ag][si]++; }
            if (onCPT === 1)  cfTestedHIVCPT++;
          }
        }

        // Presumptive cases
        const pcRows = execSql(`
          SELECT COALESCE(SUM(pc.PresumptiveCase), 0) AS Total
          FROM PresumptiveCaseT pc
          JOIN YearT y ON y.YearID = pc.YearID
          WHERE pc.MonthID IS NOT NULL AND pc.YearID IS NOT NULL
            AND (CAST(y.YearName AS TEXT) || '-' || printf('%02d', pc.MonthID) || '-15')
                BETWEEN ? AND ?
            AND pc.NearestHFID = ?`, [cfStart, cfEnd, facId]);
        cfSuspectsSeen = pcRows.length ? (pcRows[0].Total || 0) : 0;

        // ── TO counters ────────────────────────────────────────────────
        let toNewPBCM = 0, toNewPBCF = 0;
        let toNewPBC_CuredM = 0,      toNewPBC_CuredF = 0;
        let toNewPBC_CompletedM = 0,  toNewPBC_CompletedF = 0;
        let toNewPBC_DiedM = 0,       toNewPBC_DiedF = 0;
        let toNewPBC_FailedM = 0,     toNewPBC_FailedF = 0;
        let toNewPBC_LostToFPM = 0,   toNewPBC_LostToFPF = 0;
        let toNewPBC_NotEvalM = 0,    toNewPBC_NotEvalF = 0;

        let toNewPCDEPM = 0, toNewPCDEPF = 0;
        let toNewPCDEP_CompletedM = 0, toNewPCDEP_CompletedF = 0;
        let toNewPCDEP_DiedM = 0,      toNewPCDEP_DiedF = 0;
        let toNewPCDEP_FailedM = 0,    toNewPCDEP_FailedF = 0;
        let toNewPCDEP_LostToFPM = 0,  toNewPCDEP_LostToFPF = 0;
        let toNewPCDEP_NotEvalM = 0,   toNewPCDEP_NotEvalF = 0;

        let toRelapseM = 0, toRelapseF = 0;
        let toRelapse_CuredM = 0,     toRelapse_CuredF = 0;
        let toRelapse_CompletedM = 0, toRelapse_CompletedF = 0;
        let toRelapse_DiedM = 0,      toRelapse_DiedF = 0;
        let toRelapse_FailedM = 0,    toRelapse_FailedF = 0;
        let toRelapse_LostToFPM = 0,  toRelapse_LostToFPF = 0;
        let toRelapse_NotEvalM = 0,   toRelapse_NotEvalF = 0;

        let toTestedHIV = 0, toTestedHIVPos = 0, toTestedHIVART = 0;
        let toHIVPos_Cured = 0, toHIVPos_Completed = 0, toHIVPos_Died = 0;
        let toHIVPos_Failed = 0, toHIVPos_LostToFP = 0, toHIVPos_NotEval = 0;
        let toChn = 0, toChn_Cured = 0, toChn_Completed = 0, toChn_Died = 0,
            toChn_Failed = 0, toChn_LostToFP = 0, toChn_NotEval = 0;
        let toAdol = 0, toAdol_Cured = 0, toAdol_Completed = 0, toAdol_Died = 0,
            toAdol_Failed = 0, toAdol_LostToFP = 0, toAdol_NotEval = 0;

        const toRows = execSql(`
          SELECT pd.PtTypeID, pd.TbTypeID, pd.SexID,
                 COALESCE(pd.Age, 0)              AS Age,
                 COALESCE(fu.Mon0LabResultID, 0)   AS Mon0LabResultID,
                 COALESCE(fu.Mon0XpertResultID, 0) AS Mon0XpertResultID,
                 COALESCE(fu.HIVTestResultID, 0)   AS HIVTestResultID,
                 COALESCE(fu.OnART, 0)             AS OnART,
                 COALESCE(fu.OutcomeID, 0)         AS OutcomeID
          FROM PtDetailsT pd
          LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID AND fu.Deleted = 0
          WHERE pd.Deleted = 0
            AND pd.PtTypeID IN (1, 2, 3, 4, 6)
            AND pd.RegDate BETWEEN ? AND ?
            AND pd.NearestHFID = ?`, [toStart, toEnd, facId]);

        for (const r of toRows) {
          const ptType  = r.PtTypeID || 0;
          const tbType  = r.TbTypeID || 0;
          const sexId   = r.SexID    || 0;
          const age     = r.Age      || 0;
          const lab     = r.Mon0LabResultID   || 0;
          const xpert   = r.Mon0XpertResultID || 0;
          const hivRes  = r.HIVTestResultID   || 0;
          const onART   = r.OnART    || 0;
          const outcome = r.OutcomeID || 0;

          const pbc   = isTbPBC(tbType, lab, xpert);
          const pcdEP = !pbc && (tbType === 1 || tbType === 3);
          const si    = sexId === 2 ? 1 : 0;

          const isCured     = outcome === 1;
          const isCompleted = outcome === 2;
          const isDied      = outcome === 3;
          const isFailed    = outcome === 4;
          const isLostToFP  = outcome === 5;
          const isNotEval   = outcome === 6 || outcome === 0;

          if (ptType === 1 && pbc) {
            if (si === 0) { toNewPBCM++; if (isCured) toNewPBC_CuredM++; if (isCompleted) toNewPBC_CompletedM++; if (isDied) toNewPBC_DiedM++; if (isFailed) toNewPBC_FailedM++; if (isLostToFP) toNewPBC_LostToFPM++; if (isNotEval) toNewPBC_NotEvalM++; }
            else          { toNewPBCF++; if (isCured) toNewPBC_CuredF++; if (isCompleted) toNewPBC_CompletedF++; if (isDied) toNewPBC_DiedF++; if (isFailed) toNewPBC_FailedF++; if (isLostToFP) toNewPBC_LostToFPF++; if (isNotEval) toNewPBC_NotEvalF++; }
          } else if (ptType === 1 && pcdEP) {
            if (si === 0) { toNewPCDEPM++; if (isCompleted) toNewPCDEP_CompletedM++; if (isDied) toNewPCDEP_DiedM++; if (isFailed) toNewPCDEP_FailedM++; if (isLostToFP) toNewPCDEP_LostToFPM++; if (isNotEval) toNewPCDEP_NotEvalM++; }
            else          { toNewPCDEPF++; if (isCompleted) toNewPCDEP_CompletedF++; if (isDied) toNewPCDEP_DiedF++; if (isFailed) toNewPCDEP_FailedF++; if (isLostToFP) toNewPCDEP_LostToFPF++; if (isNotEval) toNewPCDEP_NotEvalF++; }
          } else if (ptType === 2) {
            if (si === 0) { toRelapseM++; if (isCured) toRelapse_CuredM++; if (isCompleted) toRelapse_CompletedM++; if (isDied) toRelapse_DiedM++; if (isFailed) toRelapse_FailedM++; if (isLostToFP) toRelapse_LostToFPM++; if (isNotEval) toRelapse_NotEvalM++; }
            else          { toRelapseF++; if (isCured) toRelapse_CuredF++; if (isCompleted) toRelapse_CompletedF++; if (isDied) toRelapse_DiedF++; if (isFailed) toRelapse_FailedF++; if (isLostToFP) toRelapse_LostToFPF++; if (isNotEval) toRelapse_NotEvalF++; }
          }

          if (hivRes > 0) toTestedHIV++;
          if (hivRes === 2) {
            toTestedHIVPos++;
            if (isCured)     toHIVPos_Cured++;
            if (isCompleted) toHIVPos_Completed++;
            if (isDied)      toHIVPos_Died++;
            if (isFailed)    toHIVPos_Failed++;
            if (isLostToFP)  toHIVPos_LostToFP++;
            if (isNotEval)   toHIVPos_NotEval++;
            if (onART === 1) toTestedHIVART++;
          }

          if (age < 15) {
            toChn++;
            if (isCured)     toChn_Cured++;
            if (isCompleted) toChn_Completed++;
            if (isDied)      toChn_Died++;
            if (isFailed)    toChn_Failed++;
            if (isLostToFP)  toChn_LostToFP++;
            if (isNotEval)   toChn_NotEval++;
          }
          if (age >= 10 && age <= 19) {
            toAdol++;
            if (isCured)     toAdol_Cured++;
            if (isCompleted) toAdol_Completed++;
            if (isDied)      toAdol_Died++;
            if (isFailed)    toAdol_Failed++;
            if (isLostToFP)  toAdol_LostToFP++;
            if (isNotEval)   toAdol_NotEval++;
          }
        }

        // ── Write CF row ──────────────────────────────────────────────
        sw(ws, `A${counter}`, counter - 3);
        sw(ws, `B${counter}`, '');               // SubRec — not in local DB
        sw(ws, `C${counter}`, fac.County);
        sw(ws, `D${counter}`, fac.HealthFacility);
        sw(ws, `E${counter}`, cfYearStr);
        sw(ws, `F${counter}`, cfQuarterStr);

        sw(ws, `G${counter}`,  cfPBCNew);      sw(ws, `H${counter}`, cfPBCRelapse);
        sw(ws, `I${counter}`,  cfPBCPrevTreat); sw(ws, `J${counter}`, cfPBCOther);
        sw(ws, `K${counter}`,  cfPCDNew);      sw(ws, `L${counter}`, cfPCDRelapse);
        sw(ws, `M${counter}`,  cfPCDPrevTreat); sw(ws, `N${counter}`, cfPCDOther);
        sw(ws, `O${counter}`,  cfEPNew);       sw(ws, `P${counter}`, cfEPRelapse);
        sw(ws, `Q${counter}`,  cfEPPrevTreat);  sw(ws, `R${counter}`, cfEPOther);
        sw(ws, `S${counter}`,  cfPBCNew + cfPCDNew + cfEPNew);
        sw(ws, `T${counter}`,  cfPBCRelapse + cfPCDRelapse + cfEPRelapse);
        sw(ws, `U${counter}`,  (cfPBCNew + cfPCDNew + cfEPNew) + (cfPBCRelapse + cfPCDRelapse + cfEPRelapse));

        for (let i = 0; i < 10; i++) {
          sw(ws, `${cfAgColsM[i]}${counter}`, cfPBCNewRelapse[i][0]);
          sw(ws, `${cfAgColsF[i]}${counter}`, cfPBCNewRelapse[i][1]);
        }

        sw(ws, `AP${counter}`, cfSuspectsSeen);
        sw(ws, `AQ${counter}`, cfPBCLab);
        sw(ws, `AR${counter}`, cfGeneXpert);
        sw(ws, `AS${counter}`, cfMicroscopy);
        sw(ws, `AT${counter}`, cfTBLam);
        sw(ws, `AU${counter}`, cfTrueNat);
        sw(ws, `AV${counter}`, cfXray);
        // AW = GeneXpert + TBLam + TrueNat
        const cfAW = cfGeneXpert + cfTBLam + cfTrueNat;
        sw(ws, `AW${counter}`, cfAW);
        // AX = AW / sum(AR:AV)
        const cfDenomDiag = cfGeneXpert + cfMicroscopy + cfTBLam + cfTrueNat + cfXray;
        sw(ws, `AX${counter}`, cfDenomDiag === 0 ? 0 : cfAW / cfDenomDiag);
        sw(ws, `AY${counter}`, cfGeneXpertPos);
        sw(ws, `AZ${counter}`, cfMicroscopyPos);
        sw(ws, `BA${counter}`, cfTBLam);        // TB-LAM count matches reference
        sw(ws, `BB${counter}`, cfTrueNatPos);

        for (let i = 0; i < 10; i++) {
          sw(ws, `${hivAgColsM[i]}${counter}`, cfHIVPos[i][0]);
          sw(ws, `${hivAgColsF[i]}${counter}`, cfHIVPos[i][1]);
        }

        sw(ws, `BW${counter}`, cfTestedHIV);
        sw(ws, `BX${counter}`, cfTestedHIVPos);
        sw(ws, `BY${counter}`, cfTestedHIVART);
        sw(ws, `BZ${counter}`, cfTestedHIVCPT);
        // CA = sum of age groups
        const cfCA = cfPBCNewRelapse.reduce((s, [m, f]) => s + m + f, 0);
        sw(ws, `CA${counter}`, cfCA);
        sw(ws, `CB${counter}`, cfCA - (cfPBCNew + cfPCDNew + cfEPNew + cfPBCRelapse + cfPCDRelapse + cfEPRelapse));
        sw(ws, `CC${counter}`, cfCA === 0 ? 0 : cfTestedHIV / cfCA);
        sw(ws, `CD${counter}`, cfTestedHIVPos === 0 ? 'NA' : cfTestedHIVART / cfTestedHIVPos);

        for (let i = 0; i < 10; i++) {
          sw(ws, `${artAgColsM[i]}${counter}`, cfARTHIVPos[i][0]);
          sw(ws, `${artAgColsF[i]}${counter}`, cfARTHIVPos[i][1]);
        }

        // ── Write TO row ──────────────────────────────────────────────
        const toRow = counter + 1;
        sw(wo, `A${toRow}`, counter - 3);
        sw(wo, `B${toRow}`, '');
        sw(wo, `C${toRow}`, fac.County);
        sw(wo, `D${toRow}`, fac.HealthFacility);
        sw(wo, `E${toRow}`, toYearStr);
        sw(wo, `F${toRow}`, toQuarterStr);

        const toTotal   = (toNewPBCM + toNewPCDEPM + toRelapseM) + (toNewPBCF + toNewPCDEPF + toRelapseF);
        const toSuccess = (toNewPBC_CuredM + toRelapse_CuredM) +
                          (toNewPBC_CompletedM + toNewPCDEP_CompletedM + toRelapse_CompletedM) +
                          (toNewPBC_CuredF + toRelapse_CuredF) +
                          (toNewPBC_CompletedF + toNewPCDEP_CompletedF + toRelapse_CompletedF);
        const toDied    = (toNewPBC_DiedM + toNewPCDEP_DiedM + toRelapse_DiedM) +
                          (toNewPBC_DiedF + toNewPCDEP_DiedF + toRelapse_DiedF);
        const toFailed  = (toNewPBC_FailedM + toNewPCDEP_FailedM + toRelapse_FailedM) +
                          (toNewPBC_FailedF + toNewPCDEP_FailedF + toRelapse_FailedF);
        const toLFP     = (toNewPBC_LostToFPM + toNewPCDEP_LostToFPM + toRelapse_LostToFPM) +
                          (toNewPBC_LostToFPF + toNewPCDEP_LostToFPF + toRelapse_LostToFPF);
        const toNotEval = (toNewPBC_NotEvalM + toNewPCDEP_NotEvalM + toRelapse_NotEvalM) +
                          (toNewPBC_NotEvalF + toNewPCDEP_NotEvalF + toRelapse_NotEvalF);

        sw(wo, `G${toRow}`, toTotal);
        sw(wo, `H${toRow}`, toSuccess);
        sw(wo, `I${toRow}`, toDied);
        sw(wo, `J${toRow}`, toFailed);
        sw(wo, `K${toRow}`, toLFP);
        sw(wo, `L${toRow}`, toNotEval);
        sw(wo, `M${toRow}`, toTotal === 0 ? 0 : toSuccess / toTotal);

        sw(wo, `N${toRow}`, toTestedHIV);
        sw(wo, `O${toRow}`, toTestedHIVPos);
        sw(wo, `P${toRow}`, toTestedHIVART);
        sw(wo, `Q${toRow}`, toTestedHIVPos);   // HIV+ denominator
        const toHIVSuccess = toHIVPos_Cured + toHIVPos_Completed;
        sw(wo, `R${toRow}`, toHIVSuccess);
        sw(wo, `S${toRow}`, toHIVPos_Died);
        sw(wo, `T${toRow}`, toHIVPos_Failed);
        sw(wo, `U${toRow}`, toHIVPos_LostToFP);
        sw(wo, `V${toRow}`, toHIVPos_NotEval);
        sw(wo, `W${toRow}`, toTestedHIVPos === 0 ? 0 : toHIVSuccess / toTestedHIVPos);

        sw(wo, `X${toRow}`,  toChn);
        sw(wo, `Y${toRow}`,  toChn_Cured + toChn_Completed);
        sw(wo, `Z${toRow}`,  toChn_Died);
        sw(wo, `AA${toRow}`, toChn_Failed);
        sw(wo, `AB${toRow}`, toChn_LostToFP);
        sw(wo, `AC${toRow}`, toChn_NotEval);
        sw(wo, `AD${toRow}`, toChn === 0 ? 0 : (toChn_Cured + toChn_Completed) / toChn);

        sw(wo, `AE${toRow}`, toAdol);
        sw(wo, `AF${toRow}`, toAdol_Cured + toAdol_Completed);
        sw(wo, `AG${toRow}`, toAdol_Died);
        sw(wo, `AH${toRow}`, toAdol_Failed);
        sw(wo, `AI${toRow}`, toAdol_LostToFP);
        sw(wo, `AJ${toRow}`, toAdol_NotEval);
        sw(wo, `AK${toRow}`, toAdol === 0 ? 0 : (toAdol_Cured + toAdol_Completed) / toAdol);
      }

      // ── TO sheet header ──────────────────────────────────────────────
      if (periodMonths === 3) {
        wo.getCell('F3').value = `Q${toOrdinal} of ${toYearStr}`;
      } else if (periodMonths === 6) {
        const semLbl = toOrdinal === 1 ? 'Semester 1' : 'Semester 2';
        wo.getCell('F3').value = `${semLbl} of ${toYearStr}`;
      } else {
        wo.getCell('F3').value = `Year ${toYearStr}`;
      }

      // ── Download ──────────────────────────────────────────────────────
      setProgress(facilityRows.length + 1, facilityRows.length + 1, 'Building workbook\u2026');
      const geoLabel  = facilityRows.length === 1
        ? facilityRows[0].HealthFacility
        : facilityRows.map(f => f.County).filter((v, i, a) => a.indexOf(v) === i).length === 1
          ? facilityRows[0].County : 'National';
      const fileName  = `${geoLabel.replace(/["/\\:*?<>|]/g, '_').slice(0, 60).trim()}_LFA_Verification_${periodLabel}_${cfYearStr}_Offline.xlsx`;
      const wbOut     = await workbook.xlsx.writeBuffer();
      const blob      = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url       = URL.createObjectURL(blob);
      const anchor    = document.createElement('a');
      anchor.href = url; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      setStatus(
        '\u26a0 Offline LFA report downloaded as preliminary data only. ' +
        'Regenerate from the eTBr server after syncing to obtain the final formatted report.',
        'warning'
      );
      clearProgress();
    } catch (err) {
      console.error('[LFA Offline Report] Failed:', err?.name, err?.message, err);
      setStatus('Failed to generate the offline LFA report. Please try again or reconnect.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── TB Quarterly Report — Offline generator ───────────────────────────
  async function generateTbQuarterlyReportOffline() {
    const cfRange = getDateRange();
    if (!cfRange) { setStatus('Please select a valid reporting period.', 'warning'); return; }

    if (new Date(cfRange.startDate) > new Date()) {
      setStatus('Cannot generate a report for a future period.', 'warning');
      return;
    }

    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected — please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    // ── Pre-report data quality check ───────────────────────────────────────
    {
      const _cfYear    = parseInt(cfRange.startDate.slice(0, 4), 10);
      const _cfEndYear = parseInt(cfRange.endDate.slice(0, 4), 10);
      const _toRange   = {
        startDate: `${_cfYear    - 1}-${cfRange.startDate.slice(5)}`,
        endDate:   `${_cfEndYear - 1}-${cfRange.endDate.slice(5)}`,
      };
      const _ok = await _runPreReportDQCheck(facilityIds, cfRange, _toRange, _cfYear);
      if (!_ok) return;
    }
    // ── End pre-report DQ check ─────────────────────────────────────────────

    setStatus('Generating offline TB quarterly report…', 'info');
    clearProgress();
    generateBtn.disabled = true;

    try {
      // Self-contained DB query helper — uses window._patientDb exposed by db.js
      // initDB(), so this function has no hard dependency on dbExec being defined
      // globally (avoids breakage when there is a Cloudflare / SW cache mismatch).
      const _db = window._patientDb;
      if (!_db) {
        setStatus('Local database is not ready. Please reload the page and try again.', 'danger');
        return;
      }
      const execSql = (sql, params = []) => {
        const r = _db.exec(sql, params);
        if (!r.length) return [];
        const { columns, values } = r[0];
        return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
      };

      // ── Period arithmetic ─────────────────────────────────────────────
      const cfStart = cfRange.startDate; // 'YYYY-MM-DD'
      const cfEnd   = cfRange.endDate;

      const cfStartM = parseInt(cfStart.slice(5, 7), 10);
      const cfEndM   = parseInt(cfEnd.slice(5,   7), 10);
      const cfStartY = parseInt(cfStart.slice(0, 4), 10);
      const cfEndY   = parseInt(cfEnd.slice(0,   4), 10);

      const periodMonths = (cfEndY - cfStartY) * 12 + cfEndM - cfStartM + 1;

      // helper: add N months to an ISO date string
      const addMonths = (iso, n) => {
        const d = new Date(iso + 'T00:00:00');
        d.setMonth(d.getMonth() + n);
        return d.toISOString().slice(0, 10);
      };

      // helper: format a list of quarter numbers as English text
      // e.g. [4,1] → "4 and 1"  |  [4,1,2,3] → "4, 1, 2 and 3"
      const formatQuarterList = qs => {
        if (qs.length === 1) return String(qs[0]);
        const strs = qs.map(String);
        return strs.slice(0, -1).join(', ') + ' and ' + strs[strs.length - 1];
      };

      // SC: one quarter before EACH CF quarter (fixed -3 month shift, not -periodMonths).
      // H1 CF (Q1+Q2) → SC = Q4(prev year) + Q1(curr year)  [Oct–Mar]
      // H2 CF (Q3+Q4) → SC = Q2 + Q3 (same year)            [Apr–Sep]
      // Annual        → SC = Q4(prev) + Q1+Q2+Q3             [Oct–Sep]
      const scStart = addMonths(cfStart, -3);
      const scEnd   = addMonths(cfEnd,   -3);
      const toStart = addMonths(cfStart, -12);
      const toEnd   = addMonths(cfEnd,   -12);

      const cfQuarterCount = periodMonths / 3; // 1, 2, or 4
      const cfQ1      = Math.floor((cfStartM - 1) / 3) + 1; // first CF quarter number (1–4)
      const scStartY  = parseInt(scStart.slice(0, 4), 10);
      const scEndY    = parseInt(scEnd.slice(0,   4), 10);
      const toStartM  = parseInt(toStart.slice(5, 7), 10);
      const toStartY  = parseInt(toStart.slice(0, 4), 10);

      // SC quarter numbers: for each CF quarter shifted back by 1 (Q1 wraps to Q4 prev year)
      const scQuarterNums = Array.from({length: cfQuarterCount}, (_, i) => {
        const cfQ = cfQ1 + i;
        return cfQ <= 1 ? 4 : cfQ - 1;
      });

      const cfOrdinal = periodMonths === 3 ? cfQ1
                      : periodMonths === 6 ? (cfStartM <= 6 ? 1 : 2) : 0;
      const toOrdinal = periodMonths === 3 ? Math.floor((toStartM - 1) / 3) + 1
                      : periodMonths === 6 ? (toStartM <= 6 ? 1 : 2) : 0;

      const cfYearStr = String(cfStartY);
      const scYearStr = scStartY === scEndY ? String(scStartY) : `${scStartY}/${scEndY}`;
      const toYearStr = String(toStartY);
      const periodLabel = periodMonths === 3 ? `Q${cfOrdinal}`
                        : periodMonths === 6 ? `H${cfOrdinal}` : 'Annual';

      // ── Geo filter ────────────────────────────────────────────────────
      const geoClausePt  = facilityIds.length ? `AND pd.NearestHFID IN (${facilityIds.map(() => '?').join(',')})` : '';
      const geoClausePc  = facilityIds.length ? `AND pc.NearestHFID IN (${facilityIds.map(() => '?').join(',')})` : '';

      // ── Facility label ────────────────────────────────────────────────
      let facilityLabel = 'All Facilities';
      let geoFilePrefix = 'National';
      if (facilityIds.length === 1) {
        const hfRows = execSql('SELECT HealthFacility FROM HealthFacilityT WHERE HealthFacilityID = ?', [facilityIds[0]]);
        if (hfRows.length && hfRows[0].HealthFacility) {
          facilityLabel = hfRows[0].HealthFacility;
          geoFilePrefix = facilityLabel.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        }
      } else if (facilityIds.length > 1) {
        facilityLabel = `Multiple Facilities (${facilityIds.length} selected)`;
        geoFilePrefix = `Multi_${facilityIds.length}`;
      }

      // ── Local helpers (mirrors server-side logic) ─────────────────────
      const isSmearPos = r => r === 1 || r === 4 || r === 5 || r === 6;
      const isXpertPos = r => r === 3 || r === 4 || r === 5;
      const isTbPBC    = (tbType, lab, xpert) => tbType === 1 && (isSmearPos(lab) || isXpertPos(xpert));
      const isTbPCD    = (tbType, lab, xpert) => tbType === 1 && !isSmearPos(lab) && !isXpertPos(xpert);
      const ntpAg      = age =>
        age < 5  ? 0 : age < 10 ? 1 : age < 15 ? 2 : age < 20 ? 3 : age < 25 ? 4 :
        age < 35 ? 5 : age < 45 ? 6 : age < 55 ? 7 : age < 65 ? 8 : 9;

      // ── Case Finding counters ─────────────────────────────────────────
      let cfPBCNew = 0, cfPBCRelapse = 0, cfPBCPrevTreat = 0, cfPBCOther = 0;
      let cfPCDNew = 0, cfPCDRelapse = 0, cfPCDPrevTreat = 0, cfPCDOther = 0;
      let cfEPNew  = 0, cfEPRelapse  = 0, cfEPPrevTreat  = 0, cfEPOther  = 0;
      let cfSuspectsSeen = 0, cfPBCLab = 0;
      let cfTestedHIV = 0, cfTestedHIVPos = 0, cfTestedHIVART = 0, cfTestedHIVCPT = 0;
      let cfGeneXpert = 0, cfMicroscopy = 0, cfTBLam = 0, cfTrueNat = 0, cfXray = 0;
      let cfGeneXpertPos = 0, cfMicroscopyPos = 0, cfTrueNatPos = 0;
      // 10 NTP age groups × 2 sexes (0=Male,1=Female)
      const cfPBCNewRelapse = Array.from({length:10}, () => [0,0]);
      const cfHIVPos        = Array.from({length:10}, () => [0,0]);
      const cfARTHIVPos     = Array.from({length:10}, () => [0,0]);

      setStatus('Processing Case Finding data…', 'info');
      {
        const cfSql = `
          SELECT pd.PtTypeID, pd.TbTypeID, pd.SexID, pd.Age, pd.DiagMethodID,
                 COALESCE(fu.Mon0LabResultID,0)   AS Mon0LabResultID,
                 COALESCE(fu.Mon0XpertResultID,0) AS Mon0XpertResultID,
                 COALESCE(fu.HIVTestResultID,0)   AS HIVTestResultID,
                 COALESCE(fu.OnART,0)             AS OnART,
                 COALESCE(fu.OnCPT,0)             AS OnCPT
          FROM PtDetailsT pd
          LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID AND fu.Deleted = 0
          WHERE pd.Deleted = 0
            AND pd.PtTypeID IN (1,2,3,4,6)
            AND pd.RegDate BETWEEN ? AND ?
            ${geoClausePt}`;
        const cfRows = execSql(cfSql, [cfStart, cfEnd, ...facilityIds]);
        for (const r of cfRows) {
          const ptType   = r.PtTypeID   || 0;
          const tbType   = r.TbTypeID   || 0;
          const sexId    = r.SexID      || 0;
          const age      = r.Age        || 0;
          const diagMeth = r.DiagMethodID || 0;
          const lab      = r.Mon0LabResultID   || 0;
          const xpert    = r.Mon0XpertResultID || 0;
          const hivRes   = r.HIVTestResultID   || 0;
          const onART    = r.OnART || 0;
          const onCPT    = r.OnCPT || 0;

          const pbc = isTbPBC(tbType, lab, xpert);
          const pcd = isTbPCD(tbType, lab, xpert);
          const ep  = tbType === 3;
          const si  = sexId === 2 ? 1 : 0;
          const ag  = ntpAg(age);

          if (pbc) {
            if      (ptType === 1)             cfPBCNew++;
            else if (ptType === 2)             cfPBCRelapse++;
            else if (ptType === 3 || ptType === 4) cfPBCPrevTreat++;
            else if (ptType === 6)             cfPBCOther++;
          } else if (pcd) {
            if      (ptType === 1)             cfPCDNew++;
            else if (ptType === 2)             cfPCDRelapse++;
            else if (ptType === 3 || ptType === 4) cfPCDPrevTreat++;
            else if (ptType === 6)             cfPCDOther++;
          } else if (ep) {
            if      (ptType === 1)             cfEPNew++;
            else if (ptType === 2)             cfEPRelapse++;
            else if (ptType === 3 || ptType === 4) cfEPPrevTreat++;
            else if (ptType === 6)             cfEPOther++;
          }

          if (pbc && (ptType === 1 || ptType === 2)) cfPBCNewRelapse[ag][si]++;
          if (pbc) cfPBCLab++;

          if (ptType === 1 || ptType === 2) {
            switch (diagMeth) {
              case 1: cfGeneXpert++;  if (isXpertPos(xpert)) cfGeneXpertPos++; break;
              case 2: cfMicroscopy++; if (isSmearPos(lab))   cfMicroscopyPos++; break;
              case 3: cfTBLam++; break;
              case 4: cfTrueNat++;    if (isXpertPos(xpert)) cfTrueNatPos++; break;
              case 5: cfXray++; break;
            }
          }

          if (hivRes > 0) cfTestedHIV++;
          if (hivRes === 2) {
            cfTestedHIVPos++;
            cfHIVPos[ag][si]++;
            if (onART === 1) { cfTestedHIVART++; cfARTHIVPos[ag][si]++; }
            if (onCPT === 1) cfTestedHIVCPT++;
          }
        }
      }

      // ── Sputum Conversion counters ────────────────────────────────────
      let scNewPBC = 0, scSmearND = 0, sc2Months = 0, sc3Months = 0;

      setStatus('Processing Sputum Conversion data…', 'info');
      {
        const scSql = `
          SELECT pd.PtTypeID, pd.TbTypeID,
                 COALESCE(fu.Mon0LabResultID,0)   AS Mon0LabResultID,
                 COALESCE(fu.Mon0XpertResultID,0) AS Mon0XpertResultID,
                 COALESCE(fu.Mon2LabResultID,0)   AS Mon2LabResultID,
                 COALESCE(fu.Mon3LabResultID,0)   AS Mon3LabResultID
          FROM PtDetailsT pd
          LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID AND fu.Deleted = 0
          WHERE pd.Deleted = 0
            AND pd.PtTypeID IN (1,2,3,4,6)
            AND pd.RegDate BETWEEN ? AND ?
            ${geoClausePt}`;
        const scRows = execSql(scSql, [scStart, scEnd, ...facilityIds]);
        for (const r of scRows) {
          const ptType = r.PtTypeID || 0;
          const tbType = r.TbTypeID || 0;
          const lab    = r.Mon0LabResultID   || 0;
          const xpert  = r.Mon0XpertResultID || 0;
          const mon2   = r.Mon2LabResultID   || 0;
          const mon3   = r.Mon3LabResultID   || 0;
          if (!isTbPBC(tbType, lab, xpert) || ptType !== 1) continue;
          scNewPBC++;
          if      (mon2 === 2)                              sc2Months++;
          else if (mon3 === 2)                              sc3Months++;
          else if ((mon2 === 0 || mon2 === 3 || mon2 === 7) &&
                   (mon3 === 0 || mon3 === 3 || mon3 === 7)) scSmearND++;
        }
      }

      // ── Treatment Outcome counters ────────────────────────────────────
      let toNewPBCM = 0, toNewPBCF = 0;
      let toNewPBC_CuredM = 0,     toNewPBC_CuredF = 0;
      let toNewPBC_CompletedM = 0, toNewPBC_CompletedF = 0;
      let toNewPBC_DiedM = 0,      toNewPBC_DiedF = 0;
      let toNewPBC_FailedM = 0,    toNewPBC_FailedF = 0;
      let toNewPBC_LostToFPM = 0,  toNewPBC_LostToFPF = 0;
      let toNewPBC_NotEvalM = 0,   toNewPBC_NotEvalF = 0;

      let toNewPCDEPM = 0, toNewPCDEPF = 0;
      let toNewPCDEP_CompletedM = 0, toNewPCDEP_CompletedF = 0;
      let toNewPCDEP_DiedM = 0,      toNewPCDEP_DiedF = 0;
      let toNewPCDEP_FailedM = 0,    toNewPCDEP_FailedF = 0;
      let toNewPCDEP_LostToFPM = 0,  toNewPCDEP_LostToFPF = 0;
      let toNewPCDEP_NotEvalM = 0,   toNewPCDEP_NotEvalF = 0;

      let toRelapseM = 0, toRelapseF = 0;
      let toRelapse_CuredM = 0,     toRelapse_CuredF = 0;
      let toRelapse_CompletedM = 0, toRelapse_CompletedF = 0;
      let toRelapse_DiedM = 0,      toRelapse_DiedF = 0;
      let toRelapse_FailedM = 0,    toRelapse_FailedF = 0;
      let toRelapse_LostToFPM = 0,  toRelapse_LostToFPF = 0;
      let toRelapse_NotEvalM = 0,   toRelapse_NotEvalF = 0;

      let toFailure = 0,   toFailure_Cured = 0,   toFailure_Completed = 0,
          toFailure_Died = 0, toFailure_Failed = 0, toFailure_LostToFP = 0, toFailure_NotEval = 0;
      let toLostToFP = 0,  toLostToFP_Cured = 0,  toLostToFP_Completed = 0,
          toLostToFP_Died = 0, toLostToFP_Failed = 0, toLostToFP_LostToFP = 0, toLostToFP_NotEval = 0;
      let toOther = 0,     toOther_Cured = 0,     toOther_Completed = 0,
          toOther_Died = 0, toOther_Failed = 0, toOther_LostToFP = 0, toOther_NotEval = 0;

      let toTestedHIV = 0, toTestedHIVPos = 0, toTestedHIVART = 0, toTestedHIVCPT = 0;
      let toHIVPos_Cured = 0, toHIVPos_Completed = 0, toHIVPos_Died = 0,
          toHIVPos_Failed = 0, toHIVPos_LostToFP = 0, toHIVPos_NotEval = 0;
      let toChn = 0,  toChn_Cured = 0,  toChn_Completed = 0,
          toChn_Died = 0, toChn_Failed = 0, toChn_LostToFP = 0, toChn_NotEval = 0;
      let toAdol = 0, toAdol_Cured = 0, toAdol_Completed = 0,
          toAdol_Died = 0, toAdol_Failed = 0, toAdol_LostToFP = 0, toAdol_NotEval = 0;

      setStatus('Processing Treatment Outcomes data…', 'info');
      {
        const toSql = `
          SELECT pd.PtTypeID, pd.TbTypeID, pd.SexID, pd.Age,
                 COALESCE(fu.Mon0LabResultID,0)   AS Mon0LabResultID,
                 COALESCE(fu.Mon0XpertResultID,0) AS Mon0XpertResultID,
                 COALESCE(fu.HIVTestResultID,0)   AS HIVTestResultID,
                 COALESCE(fu.OnART,0)             AS OnART,
                 COALESCE(fu.OnCPT,0)             AS OnCPT,
                 COALESCE(fu.OutcomeID,0)         AS OutcomeID
          FROM PtDetailsT pd
          LEFT JOIN PtFollowUpT fu ON fu.PtDetailsTID = pd.PtDetailsTID AND fu.Deleted = 0
          WHERE pd.Deleted = 0
            AND pd.PtTypeID IN (1,2,3,4,6)
            AND pd.RegDate BETWEEN ? AND ?
            ${geoClausePt}`;
        const toRows = execSql(toSql, [toStart, toEnd, ...facilityIds]);
        for (const r of toRows) {
          const ptType  = r.PtTypeID || 0;
          const tbType  = r.TbTypeID || 0;
          const sexId   = r.SexID    || 0;
          const age     = r.Age      || 0;
          const lab     = r.Mon0LabResultID   || 0;
          const xpert   = r.Mon0XpertResultID || 0;
          const hivRes  = r.HIVTestResultID   || 0;
          const onART   = r.OnART    || 0;
          const onCPT   = r.OnCPT    || 0;
          const outcome = r.OutcomeID || 0;

          const pbc     = isTbPBC(tbType, lab, xpert);
          const pcdOrEP = isTbPCD(tbType, lab, xpert) || tbType === 3;
          const si      = sexId === 2 ? 1 : 0;

          const isCured     = outcome === 1;
          const isCompleted = outcome === 2;
          const isDied      = outcome === 3;
          const isFailed    = outcome === 4;
          const isLostToFP  = outcome === 5;
          const isNotEval   = outcome === 6 || outcome === 0;

          if (ptType === 1 && pbc) {
            if (si === 0) toNewPBCM++; else toNewPBCF++;
            if (isCured)     { if (si===0) toNewPBC_CuredM++;     else toNewPBC_CuredF++;     }
            if (isCompleted) { if (si===0) toNewPBC_CompletedM++; else toNewPBC_CompletedF++; }
            if (isDied)      { if (si===0) toNewPBC_DiedM++;      else toNewPBC_DiedF++;      }
            if (isFailed)    { if (si===0) toNewPBC_FailedM++;    else toNewPBC_FailedF++;    }
            if (isLostToFP)  { if (si===0) toNewPBC_LostToFPM++; else toNewPBC_LostToFPF++;  }
            if (isNotEval)   { if (si===0) toNewPBC_NotEvalM++;   else toNewPBC_NotEvalF++;   }
          } else if (ptType === 1 && pcdOrEP) {
            if (si === 0) toNewPCDEPM++; else toNewPCDEPF++;
            if (isCompleted) { if (si===0) toNewPCDEP_CompletedM++; else toNewPCDEP_CompletedF++; }
            if (isDied)      { if (si===0) toNewPCDEP_DiedM++;      else toNewPCDEP_DiedF++;      }
            if (isFailed)    { if (si===0) toNewPCDEP_FailedM++;    else toNewPCDEP_FailedF++;    }
            if (isLostToFP)  { if (si===0) toNewPCDEP_LostToFPM++; else toNewPCDEP_LostToFPF++;  }
            if (isNotEval)   { if (si===0) toNewPCDEP_NotEvalM++;   else toNewPCDEP_NotEvalF++;   }
          } else if (ptType === 2) {
            if (si === 0) toRelapseM++; else toRelapseF++;
            if (isCured)     { if (si===0) toRelapse_CuredM++;     else toRelapse_CuredF++;     }
            if (isCompleted) { if (si===0) toRelapse_CompletedM++; else toRelapse_CompletedF++; }
            if (isDied)      { if (si===0) toRelapse_DiedM++;      else toRelapse_DiedF++;      }
            if (isFailed)    { if (si===0) toRelapse_FailedM++;    else toRelapse_FailedF++;    }
            if (isLostToFP)  { if (si===0) toRelapse_LostToFPM++; else toRelapse_LostToFPF++;  }
            if (isNotEval)   { if (si===0) toRelapse_NotEvalM++;   else toRelapse_NotEvalF++;   }
          } else if (ptType === 3) {
            toFailure++;
            if (isCured)     toFailure_Cured++;
            if (isCompleted) toFailure_Completed++;
            if (isDied)      toFailure_Died++;
            if (isFailed)    toFailure_Failed++;
            if (isLostToFP)  toFailure_LostToFP++;
            if (isNotEval)   toFailure_NotEval++;
          } else if (ptType === 4) {
            toLostToFP++;
            if (isCured)     toLostToFP_Cured++;
            if (isCompleted) toLostToFP_Completed++;
            if (isDied)      toLostToFP_Died++;
            if (isFailed)    toLostToFP_Failed++;
            if (isLostToFP)  toLostToFP_LostToFP++;
            if (isNotEval)   toLostToFP_NotEval++;
          } else if (ptType === 6) {
            toOther++;
            if (isCured)     toOther_Cured++;
            if (isCompleted) toOther_Completed++;
            if (isDied)      toOther_Died++;
            if (isFailed)    toOther_Failed++;
            if (isLostToFP)  toOther_LostToFP++;
            if (isNotEval)   toOther_NotEval++;
          }

          if (hivRes > 0) toTestedHIV++;
          if (hivRes === 2) {
            toTestedHIVPos++;
            if (isCured)     toHIVPos_Cured++;
            if (isCompleted) toHIVPos_Completed++;
            if (isDied)      toHIVPos_Died++;
            if (isFailed)    toHIVPos_Failed++;
            if (isLostToFP)  toHIVPos_LostToFP++;
            if (isNotEval)   toHIVPos_NotEval++;
            if (onART === 1) toTestedHIVART++;
            if (onCPT === 1) toTestedHIVCPT++;
          }

          if (age < 15) {
            toChn++;
            if (isCured)     toChn_Cured++;
            if (isCompleted) toChn_Completed++;
            if (isDied)      toChn_Died++;
            if (isFailed)    toChn_Failed++;
            if (isLostToFP)  toChn_LostToFP++;
            if (isNotEval)   toChn_NotEval++;
          }
          if (age >= 10 && age <= 19) {
            toAdol++;
            if (isCured)     toAdol_Cured++;
            if (isCompleted) toAdol_Completed++;
            if (isDied)      toAdol_Died++;
            if (isFailed)    toAdol_Failed++;
            if (isLostToFP)  toAdol_LostToFP++;
            if (isNotEval)   toAdol_NotEval++;
          }
        }
      }

      // ── Presumptive cases ─────────────────────────────────────────────
      setStatus('Counting presumptive TB cases…', 'info');
      {
        const presumptiveSql = `
          SELECT COALESCE(SUM(pc.PresumptiveCase), 0) AS Total
          FROM PresumptiveCaseT pc
          JOIN YearT y ON y.YearID = pc.YearID
          WHERE pc.MonthID IS NOT NULL
            AND pc.YearID IS NOT NULL
            AND (CAST(y.YearName AS TEXT) || '-' || printf('%02d', pc.MonthID) || '-15')
                BETWEEN ? AND ?
            ${geoClausePc}`;
        const pcRows = execSql(presumptiveSql, [cfStart, cfEnd, ...facilityIds]);
        cfSuspectsSeen = pcRows.length ? (pcRows[0].Total || 0) : 0;
      }

      // ── Load and fill Excel template ──────────────────────────────────
      setStatus('Building Excel workbook…', 'info');

      if (typeof ExcelJS === 'undefined') {
        setStatus('Excel library (ExcelJS) is not loaded. Please go online once to cache it, then try again.', 'danger');
        return;
      }

      const templateResp = await fetch('./templates/Template_DSTB_NTP_Report.xlsx');
      if (!templateResp.ok) {
        setStatus('Excel template not found. Please go online once to cache the report templates, then try again.', 'danger');
        return;
      }
      const templateBuf = await templateResp.arrayBuffer();

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(templateBuf);

      // Use positional access (workbook.worksheets is a 0-indexed array in tab order).
      // getWorksheet(N) looks up by internal sheetId which may not match tab position —
      // that was causing the wrong sheets to be written.
      // Template tab order: [0]=Instructions, [1]=Case Finding,
      // [2]=Sputum Conversion, [3]=Treatment Outcomes, [4]=Treatment Summary
      const ws2 = workbook.worksheets[1]; // Case Finding
      const ws3 = workbook.worksheets[2]; // Sputum Conversion
      const ws4 = workbook.worksheets[3]; // Treatment Outcomes
      const ws5 = workbook.worksheets[4]; // Treatment Summary

      if (!ws2 || !ws3 || !ws4 || !ws5) {
        setStatus('Could not locate all required sheets in the TB report template. Please re-cache by going online once.', 'danger');
        return;
      }

      // Helper: write a value into a cell (ExcelJS preserves existing style automatically).
      const sw = (ws, addr, val) => { ws.getCell(addr).value = val; };

      // Helper: write a quarter ordinal with superscript suffix as rich text,
      // matching the server-side WriteQuarterOrdinal output exactly.
      const swOrdinal = (ws, addr, n) => {
        const suffix = n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th';
        ws.getCell(addr).value = {
          richText: [
            { text: String(n) },
            { text: suffix, font: { vertAlign: 'superscript' } }
          ]
        };
      };

      const today = new Date();
      const todayStr = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;

      // NTP age-group column letters (10 groups, skipping sub-total columns K,M,O)
      const agCols = ['D','E','F','G','H','I','J','L','N','P'];

      // ── Sheet 2: Case Finding ─────────────────────────────────────────
      sw(ws2, 'D8', facilityLabel);
      if (cfOrdinal > 0) swOrdinal(ws2, 'N8', cfOrdinal);
      sw(ws2, 'Q8', cfYearStr);
      sw(ws2, 'N9', todayStr);

      sw(ws2, 'I13', cfPBCNew);    sw(ws2, 'K13', cfPBCRelapse);
      sw(ws2, 'M13', cfPBCPrevTreat); sw(ws2, 'O13', cfPBCOther);
      sw(ws2, 'I14', cfPCDNew);    sw(ws2, 'K14', cfPCDRelapse);
      sw(ws2, 'M14', cfPCDPrevTreat); sw(ws2, 'O14', cfPCDOther);
      sw(ws2, 'I15', cfEPNew);     sw(ws2, 'K15', cfEPRelapse);
      sw(ws2, 'M15', cfEPPrevTreat);  sw(ws2, 'O15', cfEPOther);

      for (let i = 0; i < 10; i++) {
        sw(ws2, `${agCols[i]}19`, cfPBCNewRelapse[i][0]); // Male
        sw(ws2, `${agCols[i]}20`, cfPBCNewRelapse[i][1]); // Female
      }

      sw(ws2, 'B24', cfSuspectsSeen);
      sw(ws2, 'E24', cfPBCLab);
      sw(ws2, 'I24', cfTestedHIV);
      sw(ws2, 'M24', cfTestedHIVPos);
      sw(ws2, 'O24', cfTestedHIVART);
      sw(ws2, 'Q24', cfTestedHIVCPT);

      sw(ws2, 'J27', cfGeneXpert);    sw(ws2, 'L27', cfMicroscopy);
      sw(ws2, 'N27', cfTBLam);        sw(ws2, 'P27', cfTrueNat);  sw(ws2, 'R27', cfXray);
      sw(ws2, 'J28', cfGeneXpertPos); sw(ws2, 'L28', cfMicroscopyPos);
      sw(ws2, 'N28', cfTBLam);        sw(ws2, 'P28', cfTrueNatPos);

      for (let i = 0; i < 10; i++) {
        sw(ws2, `${agCols[i]}32`, cfHIVPos[i][0]);
        sw(ws2, `${agCols[i]}33`, cfHIVPos[i][1]);
        sw(ws2, `${agCols[i]}37`, cfARTHIVPos[i][0]);
        sw(ws2, `${agCols[i]}38`, cfARTHIVPos[i][1]);
      }

      // ── Sheet 3: Sputum Conversion ────────────────────────────────────
      sw(ws3, 'D8', facilityLabel);
      if (cfQuarterCount === 1) {
        // Single quarter: write ordinal with superscript (e.g. "4th")
        swOrdinal(ws3, 'L8', scQuarterNums[0]);
      } else {
        // Multi-quarter: write range as plain text (e.g. "4 and 1", "4, 1, 2 and 3")
        sw(ws3, 'L8', formatQuarterList(scQuarterNums));
      }
      sw(ws3, 'P8', scYearStr);
      sw(ws3, 'N9', todayStr);

      sw(ws3, 'A14', scNewPBC);
      sw(ws3, 'F14', scSmearND);
      sw(ws3, 'J14', sc2Months);
      sw(ws3, 'M14', sc3Months);

      // ── Sheet 4: Treatment Outcomes ───────────────────────────────────
      sw(ws4, 'D8', facilityLabel);
      if (toOrdinal > 0) swOrdinal(ws4, 'P8', toOrdinal);
      sw(ws4, 'W8', toYearStr);
      sw(ws4, 'P9', todayStr);

      sw(ws4, 'H16', toNewPBCM);        sw(ws4, 'I16', toNewPBCF);
      sw(ws4, 'J16', toNewPBC_CuredM);  sw(ws4, 'K16', toNewPBC_CuredF);
      sw(ws4, 'L16', toNewPBC_CompletedM); sw(ws4, 'M16', toNewPBC_CompletedF);
      sw(ws4, 'N16', toNewPBC_DiedM);   sw(ws4, 'O16', toNewPBC_DiedF);
      sw(ws4, 'P16', toNewPBC_FailedM); sw(ws4, 'Q16', toNewPBC_FailedF);
      sw(ws4, 'R16', toNewPBC_LostToFPM); sw(ws4, 'S16', toNewPBC_LostToFPF);
      sw(ws4, 'T16', toNewPBC_NotEvalM);  sw(ws4, 'U16', toNewPBC_NotEvalF);

      sw(ws4, 'H17', toNewPCDEPM);     sw(ws4, 'I17', toNewPCDEPF);
      sw(ws4, 'L17', toNewPCDEP_CompletedM); sw(ws4, 'M17', toNewPCDEP_CompletedF);
      sw(ws4, 'N17', toNewPCDEP_DiedM);  sw(ws4, 'O17', toNewPCDEP_DiedF);
      sw(ws4, 'P17', toNewPCDEP_FailedM); sw(ws4, 'Q17', toNewPCDEP_FailedF);
      sw(ws4, 'R17', toNewPCDEP_LostToFPM); sw(ws4, 'S17', toNewPCDEP_LostToFPF);
      sw(ws4, 'T17', toNewPCDEP_NotEvalM); sw(ws4, 'U17', toNewPCDEP_NotEvalF);

      sw(ws4, 'H18', toRelapseM);       sw(ws4, 'I18', toRelapseF);
      sw(ws4, 'J18', toRelapse_CuredM); sw(ws4, 'K18', toRelapse_CuredF);
      sw(ws4, 'L18', toRelapse_CompletedM); sw(ws4, 'M18', toRelapse_CompletedF);
      sw(ws4, 'N18', toRelapse_DiedM);  sw(ws4, 'O18', toRelapse_DiedF);
      sw(ws4, 'P18', toRelapse_FailedM); sw(ws4, 'Q18', toRelapse_FailedF);
      sw(ws4, 'R18', toRelapse_LostToFPM); sw(ws4, 'S18', toRelapse_LostToFPF);
      sw(ws4, 'T18', toRelapse_NotEvalM); sw(ws4, 'U18', toRelapse_NotEvalF);

      sw(ws4, 'G19', toFailure);
      sw(ws4, 'J19', toFailure_Cured);    sw(ws4, 'L19', toFailure_Completed);
      sw(ws4, 'N19', toFailure_Died);     sw(ws4, 'P19', toFailure_Failed);
      sw(ws4, 'R19', toFailure_LostToFP); sw(ws4, 'T19', toFailure_NotEval);

      sw(ws4, 'G20', toLostToFP);
      sw(ws4, 'J20', toLostToFP_Cured);    sw(ws4, 'L20', toLostToFP_Completed);
      sw(ws4, 'N20', toLostToFP_Died);     sw(ws4, 'P20', toLostToFP_Failed);
      sw(ws4, 'R20', toLostToFP_LostToFP); sw(ws4, 'T20', toLostToFP_NotEval);

      sw(ws4, 'G21', toOther);
      sw(ws4, 'J21', toOther_Cured);    sw(ws4, 'L21', toOther_Completed);
      sw(ws4, 'N21', toOther_Died);     sw(ws4, 'P21', toOther_Failed);
      sw(ws4, 'R21', toOther_LostToFP); sw(ws4, 'T21', toOther_NotEval);

      sw(ws4, 'E26', toTestedHIV);
      sw(ws4, 'I26', toTestedHIVPos);
      sw(ws4, 'P26', toTestedHIVART);
      sw(ws4, 'V26', toTestedHIVCPT);

      sw(ws4, 'G31', toTestedHIVPos);
      sw(ws4, 'J31', toHIVPos_Cured);    sw(ws4, 'L31', toHIVPos_Completed);
      sw(ws4, 'N31', toHIVPos_Died);     sw(ws4, 'P31', toHIVPos_Failed);
      sw(ws4, 'R31', toHIVPos_LostToFP); sw(ws4, 'T31', toHIVPos_NotEval);

      sw(ws4, 'G36', toChn);
      sw(ws4, 'J36', toChn_Cured);    sw(ws4, 'L36', toChn_Completed);
      sw(ws4, 'N36', toChn_Died);     sw(ws4, 'P36', toChn_Failed);
      sw(ws4, 'R36', toChn_LostToFP); sw(ws4, 'T36', toChn_NotEval);

      sw(ws4, 'G41', toAdol);
      sw(ws4, 'J41', toAdol_Cured);    sw(ws4, 'L41', toAdol_Completed);
      sw(ws4, 'N41', toAdol_Died);     sw(ws4, 'P41', toAdol_Failed);
      sw(ws4, 'R41', toAdol_LostToFP); sw(ws4, 'T41', toAdol_NotEval);

      // ── Sheet 5: Treatment Summary (header only) ──────────────────────
      sw(ws5, 'D8', facilityLabel);
      if (toOrdinal > 0) swOrdinal(ws5, 'N8', toOrdinal);
      sw(ws5, 'Q8', toYearStr);
      sw(ws5, 'N9', todayStr);

      // ── Download ──────────────────────────────────────────────────────
      const fileName = `${geoFilePrefix}_TB_NTP_${periodLabel}_${cfYearStr}_Offline.xlsx`;
      const wbOut = await workbook.xlsx.writeBuffer();
      const blob  = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url      = URL.createObjectURL(blob);
      const anchor   = document.createElement('a');
      anchor.href = url; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      setStatus(
        '⚠ Offline report downloaded as preliminary data only. ' +
        'Regenerate from the eTBr server after syncing to obtain final figures.',
        'warning'
      );
      clearProgress();
    } catch (err) {
      console.error('[TB Offline Report] Failed:', err?.name, err?.message, err);
      setStatus('Failed to generate the offline report. Please try again or reconnect.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── ART Monthly Offline Report generator ─────────────────────────────
  async function generateArtMonthlyReportOffline() {
    const range = getDateRange();
    if (!range) { setStatus('Please select a valid reporting period.', 'warning'); return; }
    if (new Date(range.startDate) > new Date()) {
      setStatus('Cannot generate a report for a future period.', 'warning');
      return;
    }
    const facilityIds = getSelectedFacilityIds();
    if (facilityIds.length === 0) {
      const _noFacMsg = 'No facilities selected — please select at least one facility, county or state.';
      setStatus(_noFacMsg, 'danger');
      showToast(_noFacMsg, 'error');
      return;
    }

    setStatus('Generating offline ART report…', 'info');
    clearProgress();
    generateBtn.disabled = true;

    try {
      const _db = window._patientDb;
      if (!_db) {
        setStatus('Local database is not ready. Please reload the page and try again.', 'danger');
        return;
      }
      const execSql = (sql, params = []) => {
        const r = _db.exec(sql, params);
        if (!r.length) return [];
        const { columns, values } = r[0];
        return values.map(row => Object.fromEntries(columns.map((c, i) => [c, row[i]])));
      };

      const periodStart = range.startDate; // 'YYYY-MM-DD'
      const periodEnd   = range.endDate;

      const geoClause = facilityIds.length
        ? `AND hf.HealthFacilityID IN (${facilityIds.map(() => '?').join(',')})`
        : '';

      const ageGrpCase = `CASE
        WHEN p.Age = 0                THEN 0
        WHEN p.Age BETWEEN 1  AND 4   THEN 1
        WHEN p.Age BETWEEN 5  AND 9   THEN 2
        WHEN p.Age BETWEEN 10 AND 14  THEN 3
        WHEN p.Age BETWEEN 15 AND 19  THEN 4
        WHEN p.Age BETWEEN 20 AND 24  THEN 5
        WHEN p.Age BETWEEN 25 AND 29  THEN 6
        WHEN p.Age BETWEEN 30 AND 34  THEN 7
        WHEN p.Age BETWEEN 35 AND 39  THEN 8
        WHEN p.Age BETWEEN 40 AND 44  THEN 9
        WHEN p.Age BETWEEN 45 AND 49  THEN 10
        ELSE 11 END`;

      const ageBracketCase = `CASE
        WHEN p.Age < 10               THEN 0
        WHEN p.Age BETWEEN 10 AND 14  THEN 1
        WHEN p.Age BETWEEN 15 AND 49  THEN 2
        ELSE 3 END`;

      // ── Facility label ────────────────────────────────────────────────
      let facilityLabel = 'All Facilities';
      let geoFilePrefix = 'National';
      if (facilityIds.length === 1) {
        const hfRows = execSql('SELECT HealthFacility FROM HealthFacilityT WHERE HealthFacilityID = ?', [facilityIds[0]]);
        if (hfRows.length && hfRows[0].HealthFacility) {
          facilityLabel = hfRows[0].HealthFacility;
          geoFilePrefix = facilityLabel.replace(/[^a-zA-Z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
        }
      } else if (facilityIds.length > 1) {
        facilityLabel = `Multiple Facilities (${facilityIds.length} selected)`;
        geoFilePrefix = `Multi_${facilityIds.length}`;
      }

      // ── Period label helpers ──────────────────────────────────────────
      function derivePeriodLabel(s, e) {
        const sy=+s.slice(0,4), sm=+s.slice(5,7), sd=+s.slice(8,10);
        const ey=+e.slice(0,4), em=+e.slice(5,7), ed=+e.slice(8,10);
        const MN=['','January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
        if (sy===ey) {
          const y=sy;
          if (sm===1&&sd===1&&em===12&&ed===31) return String(y);
          if (sm===1&&sd===1&&em===6&&ed===30)  return `Semester 1 ${y}`;
          if (sm===7&&sd===1&&em===12&&ed===31) return `Semester 2 ${y}`;
          if (sm===1&&sd===1&&em===3&&ed===31)  return `Q1 ${y}`;
          if (sm===4&&sd===1&&em===6&&ed===30)  return `Q2 ${y}`;
          if (sm===7&&sd===1&&em===9&&ed===30)  return `Q3 ${y}`;
          if (sm===10&&sd===1&&em===12&&ed===31) return `Q4 ${y}`;
          if (sm===em) return `${MN[sm]} ${y}`;
        }
        return `${s} \u2013 ${e}`;
      }
      function deriveFilePeriod(s, e) {
        const sy=+s.slice(0,4), sm=+s.slice(5,7), sd=+s.slice(8,10);
        const ey=+e.slice(0,4), em=+e.slice(5,7), ed=+e.slice(8,10);
        const MN=['','January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
        if (sy===ey) {
          const y=sy;
          if (sm===1&&sd===1&&em===12&&ed===31) return `Annual_${y}`;
          if (sm===1&&sd===1&&em===6&&ed===30)  return `Sem1_${y}`;
          if (sm===7&&sd===1&&em===12&&ed===31) return `Sem2_${y}`;
          if (sm===1&&sd===1&&em===3&&ed===31)  return `Q1_${y}`;
          if (sm===4&&sd===1&&em===6&&ed===30)  return `Q2_${y}`;
          if (sm===7&&sd===1&&em===9&&ed===30)  return `Q3_${y}`;
          if (sm===10&&sd===1&&em===12&&ed===31) return `Q4_${y}`;
          if (sm===em) return `${MN[sm]}_${y}`;
        }
        return `${s}_${e}`;
      }

      const periodLabel = derivePeriodLabel(periodStart, periodEnd);
      const filePeriod  = deriveFilePeriod(periodStart, periodEnd);

      // ── Accumulators ──────────────────────────────────────────────────
      // [ageGrp 0-11][0=Male, 1=Female]
      const prevCumul     = Array.from({length:12}, () => [0,0]);
      const newInPeriod   = Array.from({length:12}, () => [0,0]);
      const newPregnant   = Array.from({length:12}, () => [0,0]);
      const newBreastfeed = Array.from({length:12}, () => [0,0]);
      let ctxMale=0, ctxFemale=0, dapsoneMale=0, dapsoneFemale=0;
      let ctxNewMale=0, ctxNewFemale=0, ctxNewPregnant=0, ctxNewBreastfeed=0;
      let dapsoneNewMale=0, dapsoneNewFemale=0, dapsoneNewPregnant=0, dapsoneNewBreastfeed=0;
      const art1stCount = Array.from({length:12}, () => [0,0]);
      const art2ndCount = Array.from({length:12}, () => [0,0]);
      const art1stPreg  = new Array(12).fill(0);
      const art1stBF    = new Array(12).fill(0);
      const art2ndPreg  = new Array(12).fill(0);
      const art2ndBF    = new Array(12).fill(0);
      // tbStatusCount[tbId 1-5][0=M, 1=F, 2=Preg, 3=BF]
      const tbStatusCount = Array.from({length:6}, () => [0,0,0,0]);
      let tbRxM=0, tbRxF=0, tbRxPreg=0, tbRxBF=0;
      // [ageBracket 0-3][0=M, 1=F]
      const ctxPage2    = Array.from({length:4}, () => [0,0]);
      const dapsPage2   = Array.from({length:4}, () => [0,0]);
      const ltfuPage2   = Array.from({length:4}, () => [0,0]);
      const deathsPage2 = Array.from({length:4}, () => [0,0]);
      let ctxBF=0, ctxPreg=0, dapsBF=0, dapsPreg=0;
      let ltfuBF=0, ltfuPreg=0, deathsBF=0, deathsPreg=0;
      const regimenAgeCounts  = {}; // code → [4][2]
      const regimenPregTotals = {};
      const regimenBFTotals   = {};
      const vlSamples    = Array.from({length:12}, () => [0,0]);
      const vlSamplesPreg = new Array(12).fill(0);
      const vlSamplesBF   = new Array(12).fill(0);
      const vlSupp       = Array.from({length:12}, () => [0,0]);
      const vlSuppPreg    = new Array(12).fill(0);
      const vlSuppBF      = new Array(12).fill(0);
      const vlUnsupp     = Array.from({length:12}, () => [0,0]);
      const vlUnsuppPreg  = new Array(12).fill(0);
      const vlUnsuppBF    = new Array(12).fill(0);
      const vlTraced     = Array.from({length:12}, () => [0,0]);
      const vlTracedPreg  = new Array(12).fill(0);
      const vlTracedBF    = new Array(12).fill(0);

      // ── 1. Main patient data (Page 1 rows 13-24) ─────────────────────
      setStatus('Processing patient data…', 'info');
      {
        const sql = `
          SELECT p.SexID,
            ${ageGrpCase} AS AgeGrp,
            SUM(CASE WHEN p.ARTStartDate < ?                    THEN 1 ELSE 0 END) AS PrevCumul,
            SUM(CASE WHEN p.ARTStartDate BETWEEN ? AND ?        THEN 1 ELSE 0 END) AS NewInPeriod,
            SUM(CASE WHEN p.ARTStartDate BETWEEN ? AND ?
                      AND p.BreastfeedingID = 2                THEN 1 ELSE 0 END) AS Breastfeeding,
            SUM(CASE WHEN p.ARTStartDate BETWEEN ? AND ?
                      AND preg.PtDetailsTID IS NOT NULL         THEN 1 ELSE 0 END) AS Pregnant
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            ${geoClause}
          GROUP BY p.SexID, AgeGrp
          ORDER BY AgeGrp, p.SexID`;
        const rows = execSql(sql, [periodStart, periodStart, periodEnd, periodStart, periodEnd, periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const ag = r.AgeGrp; if (ag < 0 || ag > 11) continue;
          const si = r.SexID === 2 ? 1 : 0;
          prevCumul[ag][si]     += r.PrevCumul     || 0;
          newInPeriod[ag][si]   += r.NewInPeriod   || 0;
          newBreastfeed[ag][si] += r.Breastfeeding || 0;
          newPregnant[ag][si]   += r.Pregnant      || 0;
        }
      }

      // ── 2. CTX/Dapsone cumulative (Page 1 rows 26-27 section i) ──────
      setStatus('Processing CTX/Dapsone data…', 'info');
      {
        const sql = `
          SELECT p.CPTDrugID, p.SexID, COUNT(*) AS Total
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0
            AND p.CPTDrugID IN (1,2) AND p.ARTStartDate IS NOT NULL
            AND p.ARTStartDate <= ?
            ${geoClause}
          GROUP BY p.CPTDrugID, p.SexID`;
        const rows = execSql(sql, [periodEnd, ...facilityIds]);
        for (const r of rows) {
          const isMale = r.SexID !== 2;
          if      (r.CPTDrugID === 1 &&  isMale) ctxMale       += r.Total || 0;
          else if (r.CPTDrugID === 1 && !isMale) ctxFemale     += r.Total || 0;
          else if (r.CPTDrugID === 2 &&  isMale) dapsoneMale   += r.Total || 0;
          else if (r.CPTDrugID === 2 && !isMale) dapsoneFemale += r.Total || 0;
        }
      }

      // ── 3. CTX/Dapsone new in period (Page 1 rows 26-27 section ii) ──
      {
        const sql = `
          SELECT p.CPTDrugID, p.SexID,
            COUNT(*) AS Total,
            SUM(CASE WHEN p.BreastfeedingID = 2 THEN 1 ELSE 0 END)              AS Breastfeeding,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)       AS Pregnant
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0
            AND p.CPTDrugID IN (1,2) AND p.ARTStartDate IS NOT NULL
            AND p.ARTStartDate BETWEEN ? AND ?
            ${geoClause}
          GROUP BY p.CPTDrugID, p.SexID`;
        const rows = execSql(sql, [periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const isMale = r.SexID !== 2;
          if (r.CPTDrugID === 1) {
            if (isMale) ctxNewMale += r.Total || 0;
            else { ctxNewFemale += r.Total || 0; ctxNewPregnant += r.Pregnant || 0; ctxNewBreastfeed += r.Breastfeeding || 0; }
          } else if (r.CPTDrugID === 2) {
            if (isMale) dapsoneNewMale += r.Total || 0;
            else { dapsoneNewFemale += r.Total || 0; dapsoneNewPregnant += r.Pregnant || 0; dapsoneNewBreastfeed += r.Breastfeeding || 0; }
          }
        }
      }

      // ── 4. Current on ART by regimen line (Page 2 rows 10-21, 25-36) ─
      setStatus('Processing current ART patients…', 'info');
      {
        const sql = `
          WITH LastFollowUp AS (
            SELECT fu.PtDetailsTID, fu.FollowUpStatusID, fu.RegimenID,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate <= ?
          )
          SELECT p.SexID,
            ${ageGrpCase} AS AgeGrp,
            COALESCE(r.RegimenCategoryID, 1) AS RegimenCatID,
            COUNT(*) AS Total,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2 THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
          LEFT JOIN RegimenARTT r ON r.RegimenID = lv.RegimenID
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            AND p.ARTStartDate <= ?
            AND (lv.FollowUpStatusID = 1 OR lv.PtDetailsTID IS NULL)
            ${geoClause}
          GROUP BY p.SexID, AgeGrp, RegimenCatID
          ORDER BY AgeGrp, p.SexID`;
        const rows = execSql(sql, [periodEnd, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const ag    = r.AgeGrp; if (ag < 0 || ag > 11) continue;
          const si    = r.SexID === 2 ? 1 : 0;
          const catId = r.RegimenCatID || 1;
          const is1st = catId !== 2 && catId !== 4;
          if (is1st) {
            art1stCount[ag][si] += r.Total || 0;
            if (si === 1) { art1stPreg[ag] += r.Pregnant || 0; art1stBF[ag] += r.Breastfeeding || 0; }
          } else {
            art2ndCount[ag][si] += r.Total || 0;
            if (si === 1) { art2ndPreg[ag] += r.Pregnant || 0; art2ndBF[ag] += r.Breastfeeding || 0; }
          }
        }
      }

      // ── 5. TB status at last visit in period (Page 2 rows 41-45) ─────
      setStatus('Processing TB status data…', 'info');
      {
        const sql = `
          WITH LastVisitInPeriod AS (
            SELECT fu.PtDetailsTID, fu.TBStatusID,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate BETWEEN ? AND ?
          )
          SELECT p.SexID, lv.TBStatusID, COUNT(*) AS Total,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2 THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          JOIN LastVisitInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            ${geoClause}
          GROUP BY p.SexID, lv.TBStatusID`;
        const rows = execSql(sql, [periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const tbId = r.TBStatusID; if (tbId < 1 || tbId > 5) continue;
          const si = r.SexID === 2 ? 1 : 0;
          tbStatusCount[tbId][si] += r.Total || 0;
          if (si === 1) { tbStatusCount[tbId][2] += r.Pregnant || 0; tbStatusCount[tbId][3] += r.Breastfeeding || 0; }
        }
      }

      // ── 6. TB treatment started in period (Page 2 row 46) ────────────
      {
        const sql = `
          SELECT p.SexID, COUNT(*) AS Total,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2 THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            AND p.TBRxStartDate BETWEEN ? AND ?
            ${geoClause}
          GROUP BY p.SexID`;
        const rows = execSql(sql, [periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          if (r.SexID !== 2) tbRxM += r.Total || 0;
          else { tbRxF += r.Total || 0; tbRxPreg += r.Pregnant || 0; tbRxBF += r.Breastfeeding || 0; }
        }
      }

      // ── 7. CTX/Dapsone for current patients (Page 2 rows 95-96) ──────
      {
        const sql = `
          WITH LastFollowUp AS (
            SELECT fu.PtDetailsTID, fu.FollowUpStatusID,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate <= ?
          )
          SELECT p.SexID,
            ${ageBracketCase} AS AgeBracket,
            p.CPTDrugID,
            COUNT(*) AS Total,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2 THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            AND p.ARTStartDate <= ? AND p.CPTDrugID IN (1,2)
            AND (lv.FollowUpStatusID = 1 OR lv.PtDetailsTID IS NULL)
            ${geoClause}
          GROUP BY p.SexID, AgeBracket, p.CPTDrugID`;
        const rows = execSql(sql, [periodEnd, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const si = r.SexID === 2 ? 1 : 0;
          const b  = r.AgeBracket; if (b < 0 || b > 3) continue;
          if (r.CPTDrugID === 1) {
            ctxPage2[b][si] += r.Total || 0;
            ctxPreg += r.Pregnant || 0; ctxBF += r.Breastfeeding || 0;
          } else if (r.CPTDrugID === 2) {
            dapsPage2[b][si] += r.Total || 0;
            dapsPreg += r.Pregnant || 0; dapsBF += r.Breastfeeding || 0;
          }
        }
      }

      // ── 8. LTFU and Deaths in period (Page 2 rows 97-98) ─────────────
      {
        const sql = `
          WITH LastVisitInPeriod AS (
            SELECT fu.PtDetailsTID, fu.FollowUpStatusID,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate BETWEEN ? AND ?
          )
          SELECT p.SexID,
            ${ageBracketCase} AS AgeBracket,
            lv.FollowUpStatusID,
            COUNT(*) AS Total,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2 THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          JOIN LastVisitInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            AND lv.FollowUpStatusID IN (2, 5)
            ${geoClause}
          GROUP BY p.SexID, AgeBracket, lv.FollowUpStatusID`;
        const rows = execSql(sql, [periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const si = r.SexID === 2 ? 1 : 0;
          const b  = r.AgeBracket; if (b < 0 || b > 3) continue;
          if (r.FollowUpStatusID === 5) {
            ltfuPage2[b][si] += r.Total || 0;
            ltfuPreg += r.Pregnant || 0; ltfuBF += r.Breastfeeding || 0;
          } else if (r.FollowUpStatusID === 2) {
            deathsPage2[b][si] += r.Total || 0;
            deathsPreg += r.Pregnant || 0; deathsBF += r.Breastfeeding || 0;
          }
        }
      }

      // ── 9. Per-regimen breakdown (Page 2 rows 51-93) ──────────────────
      setStatus('Processing regimen data…', 'info');
      {
        const sql = `
          WITH LastFollowUp AS (
            SELECT fu.PtDetailsTID, fu.FollowUpStatusID, fu.RegimenID,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate <= ?
          )
          SELECT LOWER(TRIM(r.RegimenCode)) AS RegimenCode,
            p.SexID,
            ${ageBracketCase} AS AgeBracket,
            COUNT(*) AS Total,
            SUM(CASE WHEN preg.PtDetailsTID IS NOT NULL AND p.SexID = 2 THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.BreastfeedingID = 2 AND p.SexID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          LEFT JOIN LastFollowUp lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
          JOIN RegimenARTT r ON r.RegimenID = lv.RegimenID
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0 AND p.ARTStartDate IS NOT NULL
            AND p.ARTStartDate <= ? AND lv.FollowUpStatusID = 1
            ${geoClause}
          GROUP BY LOWER(TRIM(r.RegimenCode)), p.SexID, AgeBracket
          ORDER BY RegimenCode`;
        const rows = execSql(sql, [periodEnd, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const code = r.RegimenCode;
          const si   = r.SexID === 2 ? 1 : 0;
          const b    = r.AgeBracket; if (b < 0 || b > 3) continue;
          if (!regimenAgeCounts[code]) regimenAgeCounts[code] = Array.from({length:4}, () => [0,0]);
          regimenAgeCounts[code][b][si] += r.Total || 0;
          regimenPregTotals[code] = (regimenPregTotals[code] || 0) + (r.Pregnant || 0);
          regimenBFTotals[code]   = (regimenBFTotals[code]   || 0) + (r.Breastfeeding || 0);
        }
      }

      // ── 10. Viral Load samples/results (Page 3 rows 11-22) ───────────
      setStatus('Processing viral load data…', 'info');
      {
        const sql = `
          WITH LatestVLInPeriod AS (
            SELECT fu.PtDetailsTID, fu.ViralLoad AS VLValue,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate BETWEEN ? AND ?
              AND fu.ViralLoad IS NOT NULL AND fu.ViralLoad > 0
          )
          SELECT p.SexID,
            ${ageGrpCase} AS AgeGrp,
            COUNT(*)                                                                           AS Samples,
            SUM(CASE WHEN p.SexID = 2 AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)    AS SamplesPreg,
            SUM(CASE WHEN p.SexID = 2 AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)           AS SamplesBF,
            SUM(CASE WHEN lv.VLValue < 1000 THEN 1 ELSE 0 END)                               AS Suppressed,
            SUM(CASE WHEN lv.VLValue < 1000 AND p.SexID = 2
                      AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)                    AS SuppressedPreg,
            SUM(CASE WHEN lv.VLValue < 1000 AND p.SexID = 2
                      AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)                           AS SuppressedBF,
            SUM(CASE WHEN lv.VLValue >= 1000 THEN 1 ELSE 0 END)                              AS Unsuppressed,
            SUM(CASE WHEN lv.VLValue >= 1000 AND p.SexID = 2
                      AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END)                    AS UnsuppressedPreg,
            SUM(CASE WHEN lv.VLValue >= 1000 AND p.SexID = 2
                      AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)                           AS UnsuppressedBF
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          JOIN LatestVLInPeriod lv ON lv.PtDetailsTID = p.PtDetailsTID AND lv.rn = 1
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0
            ${geoClause}
          GROUP BY p.SexID, AgeGrp
          ORDER BY AgeGrp, p.SexID`;
        const rows = execSql(sql, [periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const ag = r.AgeGrp; if (ag < 0 || ag > 11) continue;
          const si = r.SexID === 2 ? 1 : 0;
          vlSamples[ag][si]   += r.Samples       || 0;
          vlSamplesPreg[ag]   += r.SamplesPreg   || 0;
          vlSamplesBF[ag]     += r.SamplesBF     || 0;
          vlSupp[ag][si]      += r.Suppressed    || 0;
          vlSuppPreg[ag]      += r.SuppressedPreg || 0;
          vlSuppBF[ag]        += r.SuppressedBF   || 0;
          vlUnsupp[ag][si]    += r.Unsuppressed   || 0;
          vlUnsuppPreg[ag]    += r.UnsuppressedPreg || 0;
          vlUnsuppBF[ag]      += r.UnsuppressedBF   || 0;
        }
      }

      // ── 11. High VL traced (Page 3 rows 11-22) ───────────────────────
      {
        const sql = `
          WITH HighVLInPeriod AS (
            SELECT fu.PtDetailsTID, fu.VisitDate AS HighVLDate,
              ROW_NUMBER() OVER (PARTITION BY fu.PtDetailsTID
                ORDER BY fu.VisitDate DESC, fu.CreatedOn DESC) AS rn
            FROM PtFollowUpARTT fu
            WHERE fu.Deleted = 0 AND fu.VisitDate BETWEEN ? AND ?
              AND fu.ViralLoad IS NOT NULL AND fu.ViralLoad >= 1000
          )
          SELECT p.SexID,
            ${ageGrpCase} AS AgeGrp,
            COUNT(*) AS Traced,
            SUM(CASE WHEN p.SexID = 2 AND preg.PtDetailsTID IS NOT NULL THEN 1 ELSE 0 END) AS Pregnant,
            SUM(CASE WHEN p.SexID = 2 AND p.BreastfeedingID = 2 THEN 1 ELSE 0 END)        AS Breastfeeding
          FROM PtDetailsARTT p
          JOIN HealthFacilityT hf ON hf.HealthFacilityID = p.NearestHFID
          JOIN HighVLInPeriod hv ON hv.PtDetailsTID = p.PtDetailsTID AND hv.rn = 1
          LEFT JOIN (SELECT DISTINCT PtDetailsTID FROM PMTCTPregnancyT) preg
            ON preg.PtDetailsTID = p.PtDetailsTID
          WHERE p.Deleted = 0 AND p.IsTransferIn = 0
            AND EXISTS (
              SELECT 1 FROM PtFollowUpARTT fu2
              WHERE fu2.PtDetailsTID = p.PtDetailsTID AND fu2.Deleted = 0
                AND fu2.VisitDate > hv.HighVLDate
            )
            ${geoClause}
          GROUP BY p.SexID, AgeGrp
          ORDER BY AgeGrp, p.SexID`;
        const rows = execSql(sql, [periodStart, periodEnd, ...facilityIds]);
        for (const r of rows) {
          const ag = r.AgeGrp; if (ag < 0 || ag > 11) continue;
          const si = r.SexID === 2 ? 1 : 0;
          vlTraced[ag][si]  += r.Traced      || 0;
          vlTracedPreg[ag]  += r.Pregnant    || 0;
          vlTracedBF[ag]    += r.Breastfeeding || 0;
        }
      }

      // ── Load and fill Excel template ──────────────────────────────────
      setStatus('Building Excel workbook…', 'info');
      if (typeof ExcelJS === 'undefined') {
        setStatus('Excel library (ExcelJS) is not loaded. Please go online once to cache it, then try again.', 'danger');
        return;
      }
      const templateResp = await fetch('./templates/ART_Monthly_Report_Form_Rev.xlsx');
      if (!templateResp.ok) {
        setStatus('ART report template not found. Please go online once to cache the report templates, then try again.', 'danger');
        return;
      }
      const templateBuf = await templateResp.arrayBuffer();
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(templateBuf);

      const ws1 = workbook.getWorksheet('Page 1');
      const ws2 = workbook.getWorksheet('Page 2');
      const ws3 = workbook.getWorksheet('Page 3');
      if (!ws1 || !ws2 || !ws3) {
        setStatus('Could not locate all required sheets in the ART report template. Please re-cache by going online once.', 'danger');
        return;
      }

      // Helper: write a value into a cell by address (ExcelJS preserves existing style).
      const sw = (ws, addr, val) => { ws.getCell(addr).value = val; };
      // Helper: write a value into a cell by row/column (1-based).
      const sc = (ws, row, col, val) => { ws.getRow(row).getCell(col).value = val; };

      // ── Page 1 header ─────────────────────────────────────────────────
      sw(ws1, 'B7', facilityLabel);
      sw(ws1, 'I7', periodLabel);

      // ── Page 1 data rows 13-24 (age groups 0-11) ──────────────────────
      // B=Section-i Male, C=Section-i Female,
      // E=Section-ii Male, F=Section-ii Female,
      // G=Section-ii Pregnant, H=Section-ii Breastfeeding
      for (let ag = 0; ag <= 11; ag++) {
        const row = 13 + ag;
        sc(ws1, row, 2, prevCumul[ag][0]);      // B
        sc(ws1, row, 3, prevCumul[ag][1]);      // C
        sc(ws1, row, 5, newInPeriod[ag][0]);    // E
        sc(ws1, row, 6, newInPeriod[ag][1]);    // F
        sc(ws1, row, 7, newPregnant[ag][1]);    // G (female)
        sc(ws1, row, 8, newBreastfeed[ag][1]);  // H (female)
      }

      // ── Page 1 CTX/Dapsone rows 26-27 ────────────────────────────────
      sw(ws1, 'B26', ctxMale);          sw(ws1, 'C26', ctxFemale);
      sw(ws1, 'B27', dapsoneMale);      sw(ws1, 'C27', dapsoneFemale);
      sw(ws1, 'E26', ctxNewMale);       sw(ws1, 'F26', ctxNewFemale);
      sw(ws1, 'G26', ctxNewPregnant);   sw(ws1, 'H26', ctxNewBreastfeed);
      sw(ws1, 'E27', dapsoneNewMale);   sw(ws1, 'F27', dapsoneNewFemale);
      sw(ws1, 'G27', dapsoneNewPregnant); sw(ws1, 'H27', dapsoneNewBreastfeed);

      // ── Page 2 header ─────────────────────────────────────────────────
      sw(ws2, 'B5', facilityLabel);
      sw(ws2, 'J5', periodLabel);

      // ── Page 2 Section A: 1st-line rows 10-21 (age groups 0-11) ──────
      // D=Male, F=Female, H=Pregnant, J=Breastfeeding
      for (let ag = 0; ag <= 11; ag++) {
        const r1 = 10 + ag;
        sc(ws2, r1, 4,  art1stCount[ag][0]);
        sc(ws2, r1, 6,  art1stCount[ag][1]);
        sc(ws2, r1, 8,  art1stPreg[ag]);
        sc(ws2, r1, 10, art1stBF[ag]);
      }

      // ── Page 2 Section A: 2nd-line rows 25-36 (age groups 0-11) ──────
      for (let ag = 0; ag <= 11; ag++) {
        const r2 = 25 + ag;
        sc(ws2, r2, 4,  art2ndCount[ag][0]);
        sc(ws2, r2, 6,  art2ndCount[ag][1]);
        sc(ws2, r2, 8,  art2ndPreg[ag]);
        sc(ws2, r2, 10, art2ndBF[ag]);
      }

      // ── Page 2 TB status rows 41-45, 46 ──────────────────────────────
      // D=Male, F=Female, H=Pregnant, J=Breastfeeding
      [41, 42, 43, 44, 45].forEach((rowTb, i) => {
        const tbId = i + 1;
        sc(ws2, rowTb, 4,  tbStatusCount[tbId][0]);
        sc(ws2, rowTb, 6,  tbStatusCount[tbId][1]);
        sc(ws2, rowTb, 8,  tbStatusCount[tbId][2]);
        sc(ws2, rowTb, 10, tbStatusCount[tbId][3]);
      });
      sc(ws2, 46, 4,  tbRxM);   sc(ws2, 46, 6,  tbRxF);
      sc(ws2, 46, 8,  tbRxPreg); sc(ws2, 46, 10, tbRxBF);

      // ── Page 2 summary rows 95-98 (CTX, Dapsone, LTFU, Deaths) ───────
      // B=<10M(2), C=<10F(3), D=10-14M(4), E=10-14F(5),
      // F=15-49M(6), G=15-49F(7), H=50+M(8), I=50+F(9),
      // K(11)=BF total, L(12)=Pregnant total
      for (let b = 0; b < 4; b++) {
        const colM = 2 + b * 2, colF = 3 + b * 2;
        sc(ws2, 95, colM, ctxPage2[b][0]);    sc(ws2, 95, colF, ctxPage2[b][1]);
        sc(ws2, 96, colM, dapsPage2[b][0]);   sc(ws2, 96, colF, dapsPage2[b][1]);
        sc(ws2, 97, colM, ltfuPage2[b][0]);   sc(ws2, 97, colF, ltfuPage2[b][1]);
        sc(ws2, 98, colM, deathsPage2[b][0]); sc(ws2, 98, colF, deathsPage2[b][1]);
      }
      sc(ws2, 95, 11, ctxBF);    sc(ws2, 95, 12, ctxPreg);
      sc(ws2, 96, 11, dapsBF);   sc(ws2, 96, 12, dapsPreg);
      sc(ws2, 97, 11, ltfuBF);   sc(ws2, 97, 12, ltfuPreg);
      sc(ws2, 98, 11, deathsBF); sc(ws2, 98, 12, deathsPreg);

      // ── Page 2 per-regimen rows 51-93 ────────────────────────────────
      // B(2)=<10M, C(3)=<10F, D(4)=10-14M, E(5)=10-14F,
      // F(6)=15-49M, G(7)=15-49F, H(8)=50+M, I(9)=50+F,
      // K(11)=BF total, L(12)=Pregnant total
      const REGIMEN_ROWS = {
        '1a':51,'1b':52,'1c':53,'1d':54,'1e':55,'1f':56,'1g':57,'1h':58,'1j':59,
        '2a':61,'2b':62,'2c':63,'2d':64,'2e':65,'2f':66,'2g':67,'2h':68,'2i':69,'2j':70,'2k':71,
        '4a':73,'4b':74,'4c':75,'4d':76,'4f':77,'4g':78,'4h':79,'4i':80,'4j':81,'4k':82,'4l':83,
        '5a':85,'5b':86,'5c':87,'5d':88,'5e':89,'5f':90,'5g':91,'5h':92,'5i':93,
      };
      for (const [code, row] of Object.entries(REGIMEN_ROWS)) {
        const counts   = regimenAgeCounts[code];
        const pregTotal = regimenPregTotals[code] || 0;
        const bfTotal   = regimenBFTotals[code]   || 0;
        sc(ws2, row,  2, counts ? counts[0][0] : 0);  // B: <10 Male
        sc(ws2, row,  3, counts ? counts[0][1] : 0);  // C: <10 Female
        sc(ws2, row,  4, counts ? counts[1][0] : 0);  // D: 10-14 Male
        sc(ws2, row,  5, counts ? counts[1][1] : 0);  // E: 10-14 Female
        sc(ws2, row,  6, counts ? counts[2][0] : 0);  // F: 15-49 Male
        sc(ws2, row,  7, counts ? counts[2][1] : 0);  // G: 15-49 Female
        sc(ws2, row,  8, counts ? counts[3][0] : 0);  // H: 50+ Male
        sc(ws2, row,  9, counts ? counts[3][1] : 0);  // I: 50+ Female
        sc(ws2, row, 11, bfTotal);                      // K: BF total
        sc(ws2, row, 12, pregTotal);                    // L: Pregnant total
      }

      // ── Page 3 header ─────────────────────────────────────────────────
      sw(ws3, 'B5', facilityLabel);
      sw(ws3, 'T5', periodLabel);

      // ── Page 3 data rows 11-22 (age groups 0-11) ──────────────────────
      // B(2)=Samples M, C(3)=Samples F, D(4)=Samples Preg, E(5)=Samples BF,
      // G(7)=Supp M,    H(8)=Supp F,    I(9)=Supp Preg,    J(10)=Supp BF,
      // L(12)=Unsupp M, M(13)=Unsupp F, N(14)=Unsupp Preg, O(15)=Unsupp BF,
      // Q(17)=Traced M, R(18)=Traced F, S(19)=Traced Preg, T(20)=Traced BF
      for (let ag = 0; ag <= 11; ag++) {
        const r = 11 + ag;
        sc(ws3, r,  2, vlSamples[ag][0]);    sc(ws3, r,  3, vlSamples[ag][1]);
        sc(ws3, r,  4, vlSamplesPreg[ag]);    sc(ws3, r,  5, vlSamplesBF[ag]);
        sc(ws3, r,  7, vlSupp[ag][0]);        sc(ws3, r,  8, vlSupp[ag][1]);
        sc(ws3, r,  9, vlSuppPreg[ag]);       sc(ws3, r, 10, vlSuppBF[ag]);
        sc(ws3, r, 12, vlUnsupp[ag][0]);      sc(ws3, r, 13, vlUnsupp[ag][1]);
        sc(ws3, r, 14, vlUnsuppPreg[ag]);     sc(ws3, r, 15, vlUnsuppBF[ag]);
        sc(ws3, r, 17, vlTraced[ag][0]);      sc(ws3, r, 18, vlTraced[ag][1]);
        sc(ws3, r, 19, vlTracedPreg[ag]);     sc(ws3, r, 20, vlTracedBF[ag]);
      }

      // ── Download ──────────────────────────────────────────────────────
      const fileName = `${geoFilePrefix}_ART_Report_${filePeriod}_Offline.xlsx`;
      const wbOut = await workbook.xlsx.writeBuffer();
      const blob  = new Blob([wbOut], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const url   = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = fileName;
      document.body.appendChild(anchor); anchor.click(); document.body.removeChild(anchor);
      setTimeout(() => URL.revokeObjectURL(url), 10000);

      setStatus(
        '\u26a0 Offline report downloaded as preliminary data only. ' +
        'Regenerate from the eTBr server after syncing to obtain final figures.',
        'warning'
      );
      clearProgress();
    } catch (err) {
      console.error('[ART Offline Report] Failed:', err?.name, err?.message, err);
      setStatus('Failed to generate the offline ART report. Please try again or reconnect.', 'danger');
      clearProgress();
    } finally {
      generateBtn.disabled = false;
    }
  }

  // ── DHIS2 Prepare button handler ──────────────────────────────────────────
  if (dhis2PrepareBtn) dhis2PrepareBtn.addEventListener('click', async () => {
    if (!_reallyOnline) {
      setStatus('Preparing DHIS2 data requires an internet connection. Please reconnect and try again.', 'warning');
      return;
    }

    const cfQ = parseInt(cfQuarterSel.value, 10);
    const cfY = parseInt(cfYearSel.value,    10);

    if (!cfQ || !cfY) {
      setStatus('Please select a quarter and year.', 'warning');
      return;
    }

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    if (!authToken) {
      setStatus('Your session was signed out due to inactivity.', 'warning');
      statusEl.innerHTML =
        'Your session was signed out due to inactivity. Please ' +
        '<a href="#" style="color:inherit;font-weight:600;text-decoration:underline;" ' +
        'onclick="event.preventDefault();showAuthScreen()">Sign In</a> to continue.';
      return;
    }

    // ── Pre-report data quality check ─────────────────────────────────────
    {
      const _qMonths = { 1:[1,3], 2:[4,6], 3:[7,9], 4:[10,12] };
      const [sm, em] = _qMonths[cfQ];
      const _iso     = (y, m, d) => `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
      const _last    = (y, m) => new Date(y, m, 0).getDate();
      const _cfRange = { startDate: _iso(cfY, sm, 1), endDate: _iso(cfY, em, _last(cfY, em)) };
      const _toRange = {
        startDate: _iso(cfY - 1, sm, 1),
        endDate:   _iso(cfY - 1, em, _last(cfY - 1, em)),
      };
      const _facilityIds = getSelectedFacilityIds();
      if (_facilityIds.length === 0) {
        setStatus('No facilities selected — please select at least one facility.', 'danger');
        return;
      }
      const _ok = await _runPreReportDQCheck(_facilityIds, _cfRange, _toRange, cfY);
      if (!_ok) return;
    }
    // ── End pre-report DQ check ────────────────────────────────────────────

    // Show progress, disable button
    dhis2PrepareBtn.disabled = true;
    setStatus('', '');
    if (dhis2ProgressWrap) dhis2ProgressWrap.style.display = '';

    try {
      const qs  = `cfQuarter=${cfQ}&cfYear=${cfY}`;
      const res = await fetch(`${API_BASE}/dhis2/tb-prepare?${qs}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      // Pass prepared data to Step 2 modal and open it
      window._dhis2PreparedData = { cacheKey: data.cacheKey, facilities: data.facilities || [], cfQ, cfY };
      document.getElementById('dhis2-step2-trigger')?.click();

    } catch (err) {
      setStatus(`Failed to prepare report data: ${err.message}`, 'danger');
    } finally {
      dhis2PrepareBtn.disabled = false;
      if (dhis2ProgressWrap) dhis2ProgressWrap.style.display = 'none';
    }
  });

})();

// ─────────────────────────────────────────────────────────────────────────────
// DHIS2 STEP 2 MODULE — Facility selection & send
// ─────────────────────────────────────────────────────────────────────────────
(function initDhis2Step2Module() {
  const step2Modal      = document.getElementById('dhis2-step2-modal');
  if (!step2Modal) return;

  const facilityTbody   = document.getElementById('rpt-dhis2-facility-tbody');
  const selectAllCb     = document.getElementById('rpt-dhis2-select-all');
  const sendBtn         = document.getElementById('rpt-dhis2-send-btn');
  const doneBtn         = document.getElementById('rpt-dhis2-done-btn');
  const closeBtn        = document.getElementById('rpt-dhis2-step2-close-btn');
  const sendStatusEl    = document.getElementById('rpt-dhis2-send-status');
  const stepTable       = document.getElementById('rpt-dhis2-step-table');
  const stepProgress    = document.getElementById('rpt-dhis2-step-progress');
  const progressBar     = document.getElementById('rpt-dhis2-send-bar');
  const progressLabel   = document.getElementById('rpt-dhis2-progress-label');
  const progressCount   = document.getElementById('rpt-dhis2-progress-count');
  const stepResults     = document.getElementById('rpt-dhis2-step-results');
  const resultsBody     = document.getElementById('rpt-dhis2-results-body');

  let _cacheKey   = null;
  let _facilities = [];
  let _cfQ = 1, _cfY = new Date().getFullYear();

  function escHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showEl(el)  { if (el) el.style.display = ''; }
  function hideEl(el)  { if (el) el.style.display = 'none'; }
  function showAlert(el, cls, msg) {
    if (!el) return;
    el.className = `alert alert-${cls}`;
    el.textContent = msg;
    showEl(el);
  }

  function updateSendBtn() {
    if (!sendBtn) return;
    const anyChecked = !!facilityTbody?.querySelector('.rpt-dhis2-row-cb:checked');
    sendBtn.disabled = !anyChecked;
  }

  // ── Open: receive data from Step 1 ────────────────────────────────────────
  step2Modal.addEventListener('show.bs.modal', () => {
    const d = window._dhis2PreparedData || {};
    _cacheKey   = d.cacheKey   ?? null;
    _facilities = d.facilities ?? [];
    _cfQ        = d.cfQ        ?? 1;
    _cfY        = d.cfY        ?? new Date().getFullYear();

    // Reset UI state
    hideEl(sendStatusEl);
    hideEl(doneBtn);
    showEl(stepTable);
    hideEl(stepProgress);
    hideEl(stepResults);
    if (resultsBody) resultsBody.innerHTML = '';
    if (progressBar)  { progressBar.style.width = '0%'; progressBar.setAttribute('aria-valuenow', '0'); }
    if (progressLabel) progressLabel.textContent = 'Preparing\u2026';
    if (progressCount) progressCount.textContent = '0 / 0';
    if (sendBtn) { sendBtn.disabled = true; showEl(sendBtn); }
    if (closeBtn) closeBtn.disabled = false;

    if (_facilities.length === 0) {
      showAlert(sendStatusEl, 'info',
        'No facilities with DHIS2 UIDs and data were found for this period.');
      hideEl(sendBtn);
      return;
    }

    renderFacilityTable();
  });

  // ── Select All ────────────────────────────────────────────────────────────
  if (selectAllCb) selectAllCb.addEventListener('change', () => {
    facilityTbody?.querySelectorAll('.rpt-dhis2-row-cb').forEach(cb => {
      cb.checked = selectAllCb.checked;
    });
    updateSendBtn();
  });

  // ── Close button — dismissed via data-bs-dismiss; reopen Step 1 after hide ──
  step2Modal.addEventListener('hidden.bs.modal', () => {
    document.getElementById('dhis2-step1-trigger')?.click();
  });

  // ── Done button — return to facility selection table ───────────────────────
  if (doneBtn) doneBtn.addEventListener('click', () => {
    hideEl(stepResults);
    if (resultsBody) resultsBody.innerHTML = '';
    showEl(stepTable);
    showEl(sendBtn);
    updateSendBtn();
    hideEl(doneBtn);
  });

  // ── Render facility table ─────────────────────────────────────────────────
  function renderFacilityTable() {
    if (!facilityTbody) return;
    facilityTbody.innerHTML = '';
    if (selectAllCb) selectAllCb.checked = false;

    _facilities.forEach((fac, idx) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${idx + 1}</td>
        <td>${escHtml(fac.facilityName)}</td>
        <td style="text-align:center;vertical-align:middle">
          <input type="checkbox" class="rpt-dhis2-row-cb" value="${escHtml(fac.uid)}"
                 style="width:18px;height:18px;cursor:pointer;display:block;margin:0 auto">
        </td>
        <td>${escHtml(fac.county)}</td>
        <td>${escHtml(fac.stateShort ?? fac.state)}</td>
        <td>${escHtml(fac.period)}</td>
        <td style="text-align:center">
          <button class="btn btn-primary btn-sm rpt-dhis2-preview-btn"
                  data-uid="${escHtml(fac.uid)}" data-name="${escHtml(fac.facilityName)}"
                  title="Download Excel preview">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"
                 aria-hidden="true"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
            Preview
          </button>
        </td>`;
      facilityTbody.appendChild(tr);
    });

    facilityTbody.querySelectorAll('.rpt-dhis2-preview-btn').forEach(btn => {
      btn.addEventListener('click', () => downloadPreview(btn.dataset.uid, btn.dataset.name));
    });
    facilityTbody.querySelectorAll('.rpt-dhis2-row-cb').forEach(cb => {
      cb.addEventListener('change', updateSendBtn);
    });
  }

  // ── Preview download ──────────────────────────────────────────────────────
  async function downloadPreview(uid, name) {
    if (!_cacheKey) return;
    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    const qs = `uid=${encodeURIComponent(uid)}&cacheKey=${encodeURIComponent(_cacheKey)}`;
    try {
      const res = await fetch(`${API_BASE}/dhis2/tb-preview?${qs}`, {
        headers: { Authorization: `Bearer ${authToken}` }
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        showAlert(sendStatusEl, 'danger', `Preview error: ${d.error}`);
        return;
      }
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href     = URL.createObjectURL(blob);
      a.download = `${name.replace(/\s+/g, '_')}_TB_NTP_Preview_Q${_cfQ}_${_cfY}_SV.xlsx`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(a.href);
    } catch (err) {
      showAlert(sendStatusEl, 'danger', `Preview download failed: ${err.message}`);
    }
  }

  // ── Send-confirmation modal (replaces native confirm()) ─────────────────
  function showDhis2ConfirmModal(message) {
    return new Promise(resolve => {
      const msgEl   = document.getElementById('dhis2-confirm-msg');
      const okBtn   = document.getElementById('dhis2-confirm-ok');
      const canBtn  = document.getElementById('dhis2-confirm-cancel');
      const modalEl = document.getElementById('dhis2-confirm-modal');
      if (!modalEl || !okBtn || !canBtn) { resolve(true); return; }
      if (msgEl) msgEl.textContent = message;

      // Add a backdrop above the already-open Step 2 modal
      const backdrop = document.createElement('div');
      backdrop.id = 'dhis2-confirm-backdrop';
      backdrop.className = 'modal-backdrop fade';
      backdrop.style.zIndex = '1065';
      document.body.appendChild(backdrop);
      requestAnimationFrame(() => backdrop.classList.add('show'));

      // Show confirm modal on top of Step 2 modal
      modalEl.style.display = 'block';
      modalEl.style.zIndex  = '1070';
      modalEl.removeAttribute('aria-hidden');
      modalEl.setAttribute('aria-modal', 'true');
      requestAnimationFrame(() => modalEl.classList.add('show'));

      function cleanup(result) {
        okBtn.removeEventListener('click', onOk);
        canBtn.removeEventListener('click', onCancel);
        modalEl.classList.remove('show');
        modalEl.style.display = '';
        modalEl.setAttribute('aria-hidden', 'true');
        modalEl.removeAttribute('aria-modal');
        const bd = document.getElementById('dhis2-confirm-backdrop');
        if (bd) bd.remove();
        resolve(result);
      }
      function onOk()     { cleanup(true);  }
      function onCancel() { cleanup(false); }
      okBtn.addEventListener('click', onOk);
      canBtn.addEventListener('click', onCancel);
    });
  }

  // ── Send to DHIS2 — one facility at a time with real progress ────────────
  if (sendBtn) sendBtn.addEventListener('click', async () => {
    const selectedUids = Array.from(
      facilityTbody?.querySelectorAll('.rpt-dhis2-row-cb:checked') ?? []
    ).map(cb => cb.value);

    if (selectedUids.length === 0) {
      showAlert(sendStatusEl, 'warning', 'Please select at least one facility.');
      return;
    }

    const confirmed = await showDhis2ConfirmModal(
      `You are about to submit ${selectedUids.length} ` +
      `quarterly TB repor${selectedUids.length === 1 ? 't' : 'ts'} for Q${_cfQ} ${_cfY} to DHIS2.`
    );
    if (!confirmed) return;

    // Lock UI and show progress section
    sendBtn.disabled = true;
    if (closeBtn) closeBtn.disabled = true;
    hideEl(sendStatusEl);
    hideEl(stepTable);
    showEl(stepProgress);
    if (progressBar)  { progressBar.style.width = '0%'; progressBar.setAttribute('aria-valuenow', '0'); }
    if (progressLabel) progressLabel.textContent = 'Preparing\u2026';
    if (progressCount) progressCount.textContent = `0 / ${selectedUids.length}`;

    const authToken = localStorage.getItem(AUTH_TOKEN_KEY);
    const total     = selectedUids.length;
    const succeeded = [];
    const failed    = [];

    for (let i = 0; i < selectedUids.length; i++) {
      const uid  = selectedUids[i];
      const fac  = _facilities.find(f => f.uid === uid);
      const name = fac?.facilityName ?? uid;

      if (progressLabel)
        progressLabel.textContent = `Sending ${i + 1} of ${total}: ${name}\u2026`;

      try {
        const body = { facilityUids: [uid], cfQuarter: _cfQ, cfYear: _cfY };
        const res  = await fetch(`${API_BASE}/dhis2/tb-send`, {
          method:  'POST',
          headers: { Authorization: `Bearer ${authToken}`, 'Content-Type': 'application/json' },
          body:    JSON.stringify(body)
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        succeeded.push(...(data.succeeded || []));
        failed.push(   ...(data.failed    || []));
      } catch (err) {
        failed.push({ facilityName: name, uid, errorDetail: err.message });
      }

      const pct = Math.round(((i + 1) / total) * 100);
      if (progressBar) {
        void progressBar.offsetWidth;
        progressBar.style.width = pct + '%';
        progressBar.setAttribute('aria-valuenow', String(pct));
      }
      if (progressCount) progressCount.textContent = `${i + 1} / ${total}`;
      await new Promise(r => requestAnimationFrame(r));
    }

    if (progressLabel)
      progressLabel.textContent =
        `Done \u2014 ${succeeded.length} succeeded, ${failed.length} failed.`;

    // Hold 100% briefly so the user sees the completed bar
    await new Promise(r => setTimeout(r, 700));

    hideEl(stepProgress);
    renderResults({ succeeded, failed });
    showEl(stepResults);
    hideEl(sendBtn);
    showEl(doneBtn);
    if (closeBtn) closeBtn.disabled = false;
  });

  // ── Render submission results ─────────────────────────────────────────────
  function renderResults(data) {
    if (!resultsBody) return;
    const ok   = data.succeeded || [];
    const fail = data.failed    || [];
    let html = '';

    if (ok.length > 0) {
      html += `<div class="alert alert-success mb-2">
        <strong>&#10003; Submitted successfully (${ok.length})</strong>
        <ul class="mb-0 mt-1">
          ${ok.map(f => `<li>${escHtml(f.facilityName)} <small class="text-muted">(${escHtml(f.uid)})</small></li>`).join('')}
        </ul>
      </div>`;
    }
    if (fail.length > 0) {
      html += `<div class="alert alert-danger mb-2">
        <strong>&#10007; Submission failed (${fail.length})</strong>
        <ul class="mb-0 mt-1">
          ${fail.map(f => `<li>
            ${escHtml(f.facilityName)}
            <small class="text-muted">(${escHtml(f.uid)})</small>
            ${f.errorDetail ? `<br><small class="text-danger fw-semibold">${escHtml(f.errorDetail)}</small>` : ''}
          </li>`).join('')}
        </ul>
      </div>`;
    }
    if (ok.length === 0 && fail.length === 0) {
      html = '<div class="alert alert-info">No facilities were processed.</div>';
    }
    resultsBody.innerHTML = html;
  }

})();

// ─────────────────────────────────────────────────────────────────────────────
// ART FACILITY BASELINE MODULE
// Manages cumulative opening-balance counts per facility so that report
// Section (i) is accurate even when historical patient records are not
// fully entered into the system.
// ─────────────────────────────────────────────────────────────────────────────
(function initBaselineModule() {
  const AGE_LABELS = [
    '<1 yr','1-4 yrs','5-9 yrs','10-14 yrs','15-19 yrs','20-24 yrs',
    '25-29 yrs','30-34 yrs','35-39 yrs','40-44 yrs','45-49 yrs','50+ yrs'
  ];

  // ── DOM refs ──────────────────────────────────────────────────────────────
  const modal         = document.getElementById('baseline-modal');
  if (!modal) return;
  const treeTriggerEl  = document.getElementById('bl-tree-trigger');
  const treeTriggerTxt = document.getElementById('bl-tree-trigger-text');
  const treePanelEl    = document.getElementById('bl-tree-panel');
  const treeSearchEl   = document.getElementById('bl-tree-search');
  const treeFacTreeEl  = document.getElementById('bl-fac-tree');
  const facilityIdEl     = document.getElementById('bl-facility-id');
  const dateEl         = document.getElementById('bl-date');
  const ageRowsTbody   = document.getElementById('bl-age-rows');
  const ctxMEl         = document.getElementById('bl-ctx-m');
  const ctxFEl         = document.getElementById('bl-ctx-f');
  const dapsoneMEl     = document.getElementById('bl-dapsone-m');
  const dapsoneFEl     = document.getElementById('bl-dapsone-f');
  const ctxTotalEl     = document.getElementById('bl-ctx-total');
  const dapsoneTotalEl = document.getElementById('bl-dapsone-total');
  const startedZeroEl  = document.getElementById('bl-started-zero');
  const notesEl        = document.getElementById('bl-notes');
  const saveBtn        = document.getElementById('bl-save-btn');
  const saveSpinner    = document.getElementById('bl-save-spinner');
  const statusEl       = document.getElementById('bl-status');
  const totalMEl       = document.getElementById('bl-total-m');
  const totalFEl       = document.getElementById('bl-total-f');
  const totalAllEl     = document.getElementById('bl-total-all');

  // In-memory cache: { [facilityId]: dto | null | undefined }
  // undefined = not yet loaded; null = 404 (no baseline set); dto = loaded data
  const _cache = {};

  // ── Status helper ─────────────────────────────────────────────────────────
  function _setStatus(msg, type) {
    if (!statusEl) return;
    statusEl.className = `alert alert-${type} mb-0`;
    statusEl.textContent = msg;
    statusEl.classList.remove('d-none');
  }
  function _clearStatus() {
    if (!statusEl) return;
    statusEl.className = 'alert d-none mb-0';
    statusEl.textContent = '';
  }

  // ── Build age-group input rows ────────────────────────────────────────────
  function _buildAgeRows() {
    if (!ageRowsTbody) return;
    ageRowsTbody.innerHTML = AGE_LABELS.map((lbl, ag) => `
      <tr>
        <td style="white-space:nowrap;padding:.2rem .4rem">${lbl}</td>
        <td class="text-center" style="padding:.15rem .25rem">
          <input type="number" min="0" class="form-control form-control-sm text-center bl-count-cell"
                 data-ag="${ag}" data-sex="m" style="width:80px;margin:auto;padding:.15rem .4rem;height:auto" value="0">
        </td>
        <td class="text-center" style="padding:.15rem .25rem">
          <input type="number" min="0" class="form-control form-control-sm text-center bl-count-cell"
                 data-ag="${ag}" data-sex="f" style="width:80px;margin:auto;padding:.15rem .4rem;height:auto" value="0">
        </td>
        <td class="text-center" id="bl-row-total-${ag}"
            style="background:#e9f0fb;font-weight:500;min-width:60px;padding:.2rem .4rem">0</td>
      </tr>`).join('');

    ageRowsTbody.querySelectorAll('.bl-count-cell').forEach(inp => {
      inp.addEventListener('input', _recalcTotals);
    });
  }

  function _recalcTotals() {
    if (!ageRowsTbody) return;
    let sumM = 0, sumF = 0;
    for (let ag = 0; ag < 12; ag++) {
      const mVal = Math.max(0, parseInt(ageRowsTbody.querySelector(`[data-ag="${ag}"][data-sex="m"]`)?.value, 10) || 0);
      const fVal = Math.max(0, parseInt(ageRowsTbody.querySelector(`[data-ag="${ag}"][data-sex="f"]`)?.value, 10) || 0);
      const rowEl = document.getElementById(`bl-row-total-${ag}`);
      if (rowEl) rowEl.textContent = mVal + fVal;
      sumM += mVal; sumF += fVal;
    }
    if (totalMEl)   totalMEl.textContent   = sumM;
    if (totalFEl)   totalFEl.textContent   = sumF;
    if (totalAllEl) totalAllEl.textContent = sumM + sumF;
  }

  function _recalcCptTotals() {
    const ctxM = Math.max(0, parseInt(ctxMEl?.value,     10) || 0);
    const ctxF = Math.max(0, parseInt(ctxFEl?.value,     10) || 0);
    const dapM = Math.max(0, parseInt(dapsoneMEl?.value, 10) || 0);
    const dapF = Math.max(0, parseInt(dapsoneFEl?.value, 10) || 0);
    if (ctxTotalEl)     ctxTotalEl.textContent     = ctxM + ctxF;
    if (dapsoneTotalEl) dapsoneTotalEl.textContent = dapM + dapF;
  }
  ctxMEl?.addEventListener('input',     _recalcCptTotals);
  ctxFEl?.addEventListener('input',     _recalcCptTotals);
  dapsoneMEl?.addEventListener('input', _recalcCptTotals);
  dapsoneFEl?.addEventListener('input', _recalcCptTotals);

  function _getCountsFromForm() {
    const counts = new Array(24).fill(0);
    for (let ag = 0; ag < 12; ag++) {
      counts[ag * 2]     = Math.max(0, parseInt(ageRowsTbody.querySelector(`[data-ag="${ag}"][data-sex="m"]`)?.value, 10) || 0);
      counts[ag * 2 + 1] = Math.max(0, parseInt(ageRowsTbody.querySelector(`[data-ag="${ag}"][data-sex="f"]`)?.value, 10) || 0);
    }
    return counts;
  }

  function _fillFormFromData(dto) {
    if (!dto) return;
    // dto.baselineDate is 'YYYY-MM-DD'; <input type="month"> needs 'YYYY-MM'
    if (dto.baselineDate && dateEl) {
      dateEl.value = dto.baselineDate.substring(0, 7);
    }
    for (let ag = 0; ag < 12; ag++) {
      const mInp = ageRowsTbody.querySelector(`[data-ag="${ag}"][data-sex="m"]`);
      const fInp = ageRowsTbody.querySelector(`[data-ag="${ag}"][data-sex="f"]`);
      if (mInp) mInp.value = dto.counts[ag * 2]     || 0;
      if (fInp) fInp.value = dto.counts[ag * 2 + 1] || 0;
    }
    if (ctxMEl)       ctxMEl.value      = dto.ctxTotalM     || 0;
    if (ctxFEl)       ctxFEl.value      = dto.ctxTotalF     || 0;
    if (dapsoneMEl)   dapsoneMEl.value  = dto.dapsoneTotalM || 0;
    if (dapsoneFEl)   dapsoneFEl.value  = dto.dapsoneTotalF || 0;
    if (startedZeroEl) startedZeroEl.checked = !!dto.startedFromZero;
    if (notesEl)       notesEl.value       = dto.notes || '';
    _recalcTotals();
    _recalcCptTotals();
  }

  function _resetForm() {
    if (dateEl)        dateEl.value        = '';
    if (ctxMEl)       ctxMEl.value     = 0;
    if (ctxFEl)       ctxFEl.value     = 0;
    if (dapsoneMEl)   dapsoneMEl.value = 0;
    if (dapsoneFEl)   dapsoneFEl.value = 0;
    if (startedZeroEl) startedZeroEl.checked = false;
    if (notesEl)       notesEl.value       = '';
    if (ageRowsTbody) {
      ageRowsTbody.querySelectorAll('.bl-count-cell').forEach(inp => { inp.value = 0; });
    }
    _recalcTotals();
    _recalcCptTotals();
  }

  /** Convert 'YYYY-MM' to the last day of that month as 'YYYY-MM-DD'. */
  function _lastDayOfMonth(yearMonth) {
    const [y, m] = yearMonth.split('-').map(Number);
    return new Date(y, m, 0).toISOString().slice(0, 10);
  }

  // ── API helpers ───────────────────────────────────────────────────────────
  async function _authHeader() {
    const token = localStorage.getItem(AUTH_TOKEN_KEY);
    return token ? { 'Authorization': `Bearer ${token}` } : {};
  }

  async function loadBaseline(facilityId) {
    if (_cache[facilityId] !== undefined) return _cache[facilityId];
    try {
      const resp = await fetch(`${API_BASE}/baseline/${facilityId}`, {
        headers: await _authHeader(),
      });
      if (resp.status === 404) { _cache[facilityId] = null; return null; }
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const dto = await resp.json();
      _cache[facilityId] = dto;
      return dto;
    } catch (err) {
      console.warn('[Baseline] loadBaseline error:', err.message);
      return undefined; // network error — caller treats as unknown
    }
  }

  async function saveBaseline(facilityId, payload) {
    const resp = await fetch(`${API_BASE}/baseline/${facilityId}`, {
      method: 'PUT',
      headers: { ...(await _authHeader()), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || `eTBr server error (${resp.status}).`);
    }
    delete _cache[facilityId]; // invalidate so next load fetches fresh data
    return await resp.json();
  }

  /** Pre-flight check used before report generation. Exposed globally. */
  async function checkBaselineStatus(facilityIds, startDate) {
    if (!facilityIds || facilityIds.length === 0) return { status: 'ok', warnings: [] };
    try {
      const qs = new URLSearchParams({ startDate: startDate || '' });
      for (const id of facilityIds) qs.append('facilityIds[]', id);
      const resp = await fetch(`${API_BASE}/baseline/check?${qs}`, {
        headers: await _authHeader(),
      });
      if (!resp.ok) return { status: 'ok', warnings: [] };
      return await resp.json();
    } catch {
      return { status: 'ok', warnings: [] }; // fail-open on network error
    }
  }

  // ── Facility tree picker ─────────────────────────────────────────────────
  let _blItems = []; // cached geo items for filtering

  function _closeTree() {
    if (!treePanelEl) return;
    treePanelEl.hidden = true;
    treeTriggerEl?.setAttribute('aria-expanded', 'false');
  }

  function _renderBlTree(filterText) {
    if (!treeFacTreeEl) return;
    const term = filterText.trim().toLowerCase();
    const visible = term
      ? _blItems.filter(it =>
          it.healthFacility.toLowerCase().includes(term) ||
          it.county.toLowerCase().includes(term) ||
          it.state.toLowerCase().includes(term))
      : _blItems;

    if (!visible.length) {
      treeFacTreeEl.innerHTML =
        `<p class="tree-empty" style="padding:.4rem .6rem;font-size:.83rem;color:#6b7280;margin:0">${
          term ? 'No facilities match that search.' : 'No facilities available.'
        }</p>`;
      return;
    }

    const currentId = parseInt(facilityIdEl?.value, 10) || 0;

    // Group: state → county → facility
    const stateMap = new Map();
    for (const it of visible) {
      if (!stateMap.has(it.stateID))
        stateMap.set(it.stateID, { name: it.state, counties: new Map() });
      const st = stateMap.get(it.stateID);
      if (!st.counties.has(it.countyID))
        st.counties.set(it.countyID, { name: it.county, facilities: [] });
      st.counties.get(it.countyID).facilities.push({ id: it.healthFacilityID, name: it.healthFacility });
    }

    let html = '<ul class="tree-list tree-list--state">';
    for (const [, sd] of [...stateMap.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      html += `<li class="tree-node tree-node--state">
        <details class="tree-details" open>
          <summary class="tree-summary tree-summary--state">
            <span class="tree-toggle-box"></span>
            <span>${escHtml(sd.name)}</span>
          </summary>
          <ul class="tree-list tree-list--county">`;

      for (const [, cd] of [...sd.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
        const countyOpen = term ? ' open' : '';
        html += `<li class="tree-node tree-node--county">
              <details class="tree-details"${countyOpen}>
                <summary class="tree-summary tree-summary--county">
                  <span class="tree-toggle-box"></span>
                  <span>${escHtml(cd.name)} County</span>
                </summary>
                <ul class="tree-list tree-list--facility">`;

        for (const fac of cd.facilities.sort((a, b) => a.name.localeCompare(b.name))) {
          const sel = fac.id === currentId ? ' tree-node--selected' : '';
          html += `<li class="tree-node tree-node--facility${sel}" data-fid="${fac.id}">
                    <button class="tree-facility-btn" type="button"
                            data-fid="${fac.id}" data-fname="${escHtml(fac.name)}">
                      ${escHtml(fac.name)}
                    </button>
                  </li>`;
        }

        html += `</ul></details></li>`;
      }
      html += `</ul></details></li>`;
    }
    html += '</ul>';

    treeFacTreeEl.innerHTML = html;

    treeFacTreeEl.querySelectorAll('.tree-facility-btn').forEach(btn => {
      btn.addEventListener('click', () => _selectBlFacility(
        parseInt(btn.dataset.fid, 10), btn.dataset.fname
      ));
    });

    // Scroll selected item into view
    const sel = treeFacTreeEl.querySelector('.tree-node--selected');
    if (sel) setTimeout(() => sel.scrollIntoView({ block: 'nearest' }), 0);
  }

  async function _selectBlFacility(facId, facName) {
    if (facilityIdEl) facilityIdEl.value = facId;
    if (treeTriggerTxt) {
      treeTriggerTxt.textContent = facName || `Facility #${facId}`;
      treeTriggerTxt.classList.remove('placeholder');
    }
    _closeTree();
    _clearStatus();
    _resetForm();
    _setStatus('Loading existing baseline data…', 'info');
    const existing = await loadBaseline(facId);
    _clearStatus();
    if (existing)              _fillFormFromData(existing);
    else if (existing === undefined) _setStatus('Could not load existing baseline data — eTBr server error. Please try again or check the console.', 'danger');
  }

  // ── Build / populate the facility tree picker ─────────────────────────────
  async function _loadFacilityTree(preselectedId) {
    if (!treeTriggerEl) return;
    if (treeTriggerTxt) { treeTriggerTxt.textContent = '— Loading health facilities… —'; treeTriggerTxt.classList.add('placeholder'); }
    treeTriggerEl.disabled = true;

    let items = [];
    try { items = await fetchGeoTreeData(); } catch { /* fall through */ }

    const user = getUser();
    if (user?.dataSourceID > 0) {
      items = items.filter(it => it.healthFacilityID === user.dataSourceID);
    }

    _blItems = items;

    if (!items.length) {
      if (treeTriggerTxt) treeTriggerTxt.textContent = '— No facilities available —';
      treeTriggerEl.disabled = false;
      return;
    }

    // Single-facility users: disable the picker (no choice to make)
    const locked = user?.dataSourceID > 0;
    treeTriggerEl.disabled = locked;

    if (treeTriggerTxt) { treeTriggerTxt.textContent = '— Select a health facility —'; treeTriggerTxt.classList.add('placeholder'); }

    _renderBlTree('');

    // Determine pre-selection
    const targetId = preselectedId || (items.length === 1 ? items[0].healthFacilityID : 0);
    if (targetId) {
      const item = items.find(it => it.healthFacilityID === targetId);
      if (item) {
        if (facilityIdEl) facilityIdEl.value = targetId;
        if (treeTriggerTxt) { treeTriggerTxt.textContent = item.healthFacility; treeTriggerTxt.classList.remove('placeholder'); }
        _renderBlTree(''); // re-render to show selection highlight
        _setStatus('Loading existing baseline data…', 'info');
        const existing = await loadBaseline(targetId);
        _clearStatus();
        if (existing)              _fillFormFromData(existing);
        else if (existing === undefined) _setStatus('Could not load existing baseline data — eTBr server error. Please try again or check the console.', 'danger');
      }
    }
  }

  // Toggle tree open / closed
  treeTriggerEl?.addEventListener('click', () => {
    if (treeTriggerEl.disabled) return;
    const nowOpen = !treePanelEl.hidden;
    treePanelEl.hidden = nowOpen;
    treeTriggerEl.setAttribute('aria-expanded', nowOpen ? 'false' : 'true');
    if (!nowOpen) {
      if (treeSearchEl) { treeSearchEl.value = ''; }
      _renderBlTree('');
      treeSearchEl?.focus();
    }
  });

  treeSearchEl?.addEventListener('input', () => _renderBlTree(treeSearchEl.value));

  // Close tree when modal closes (reset for next open)
  modal.addEventListener('hidden.bs.modal', () => { _closeTree(); if (treeSearchEl) treeSearchEl.value = ''; });

  // ── Open baseline modal ───────────────────────────────────────────────────
  async function showBaselineModal(facilityId, facilityName) {
    if (!modal) return;
    _buildAgeRows();
    _clearStatus();
    _resetForm();

    // Open the modal using the hidden trigger button (data-bs-toggle pattern).
    // This avoids any dependency on the window.bootstrap global.
    document.getElementById('bl-modal-trigger')?.click();

    // Load facility tree, pre-select facilityId, and load its baseline data.
    await _loadFacilityTree(facilityId || 0);
  }

  // ── Inline facility-selection warning banner ──────────────────────────────
  function _getOrCreateWarnBanner() {
    let banner = document.getElementById('bl-facility-warn-banner');
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'bl-facility-warn-banner';
    banner.className = 'alert alert-warning d-flex align-items-start gap-2';
    banner.style.cssText = 'font-size:.83rem;padding:.45rem .75rem;margin:.4rem 0 0 0;border-radius:.375rem';
    banner.hidden = true;
    const sfb = document.getElementById('selected-facility-banner');
    sfb?.parentNode?.insertBefore(banner, sfb.nextSibling);
    return banner;
  }

  async function checkAndWarnBaseline(facilityId) {
    if (!facilityId || !userCanWrite()) return;
    const banner = _getOrCreateWarnBanner();
    banner.hidden = true;

    const existing = await loadBaseline(facilityId);
    if (existing === undefined) return; // network error — stay silent
    if (existing !== null) return;      // baseline configured — nothing to warn

    // No baseline row at all — warn the user
    const facName = _selectedFacility?.name || `Facility #${facilityId}`;
    banner.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
           width="16" height="16" style="flex-shrink:0;margin-top:1px" aria-hidden="true">
        <circle cx="12" cy="12" r="10"/>
        <line x1="12" y1="8" x2="12" y2="12"/>
        <line x1="12" y1="16" x2="12.01" y2="16"/>
      </svg>
      <span>
        No ART baseline data configured for <strong>${escHtml(facName)}</strong>.
        Section&nbsp;(i) of reports may be inaccurate.
        <button type="button" class="btn btn-sm btn-warning ms-2"
                style="font-size:.75rem;padding:.1rem .45rem;color:#fff" id="bl-banner-set-btn">
          Set Baseline
        </button>
        <button type="button" class="btn btn-sm btn-outline-secondary ms-1"
                style="font-size:.75rem;padding:.1rem .45rem" id="bl-banner-dismiss-btn">
          Dismiss
        </button>
      </span>`;
    banner.hidden = false;

    document.getElementById('bl-banner-set-btn')?.addEventListener('click', () => {
      banner.hidden = true;
      showBaselineModal(facilityId, _selectedFacility?.name || facName);
    }, { once: true });
    document.getElementById('bl-banner-dismiss-btn')?.addEventListener('click', () => {
      banner.hidden = true;
    }, { once: true });
  }

  // ── Save button ───────────────────────────────────────────────────────────
  saveBtn?.addEventListener('click', async () => {
    const facId = parseInt(facilityIdEl?.value, 10) || 0;
    if (!facId) { _setStatus('No facility selected.', 'danger'); return; }

    const monthVal = dateEl?.value; // 'YYYY-MM'
    if (!monthVal) { _setStatus('Please select a baseline month.', 'warning'); return; }

    const baselineDate = _lastDayOfMonth(monthVal);
    const counts = _getCountsFromForm();

    const payload = {
      baselineDate,
      counts,
      ctxTotalM:      Math.max(0, parseInt(ctxMEl?.value,     10) || 0),
      ctxTotalF:      Math.max(0, parseInt(ctxFEl?.value,     10) || 0),
      dapsoneTotalM:  Math.max(0, parseInt(dapsoneMEl?.value, 10) || 0),
      dapsoneTotalF:  Math.max(0, parseInt(dapsoneFEl?.value, 10) || 0),
      startedFromZero: startedZeroEl?.checked ?? false,
      notes:          notesEl?.value?.trim() || null,
    };

    if (saveSpinner) saveSpinner.classList.remove('d-none');
    saveBtn.disabled = true;
    _clearStatus();

    try {
      await saveBaseline(facId, payload);
      _setStatus('Baseline data saved successfully.', 'success');
      // Clear any outdated snooze now that baseline is updated
      localStorage.removeItem(`art.bl.snoozeOutdated.${facId}`);
      // Clear warn banner if visible
      const banner = document.getElementById('bl-facility-warn-banner');
      if (banner) banner.hidden = true;
      // Update the banner button text to reflect that data now exists
      const sfbBtn = document.getElementById('sfb-baseline-btn');
      if (sfbBtn && !sfbBtn.hidden) sfbBtn.textContent = 'Update Baseline Data';
      // Auto-close modal after a moment
      setTimeout(() => {
        modal.querySelector('[data-bs-dismiss="modal"]')?.click();
      }, 1300);
    } catch (err) {
      _setStatus(err.message || 'Failed to save. Please try again.', 'danger');
    } finally {
      if (saveSpinner) saveSpinner.classList.add('d-none');
      saveBtn.disabled = false;
    }
  });

  // ── Dashboard card & ART register button wiring ───────────────────────────
  document.getElementById('dash-goto-baseline')?.addEventListener('click', () => {
    const user  = getUser();
    // Facility-locked users always open for their own facility.
    // Multi-facility users open with whatever facility is currently selected
    // (or none — they can pick from the dropdown).
    const facId = (user?.dataSourceID > 0)
      ? user.dataSourceID
      : (_selectedFacility?.id || 0);
    showBaselineModal(facId).catch(err => {
      console.error('[Baseline] showBaselineModal error:', err);
      showToast('Could not open baseline form: ' + err.message, 'error');
    });
  });

  document.getElementById('sfb-baseline-btn')?.addEventListener('click', () => {
    const fac = _selectedFacility;
    if (!fac) { showToast('No facility selected.', 'warning'); return; }
    showBaselineModal(fac.id, fac.name);
  });

  

  // ── Expose functions needed by other modules ──────────────────────────────
  window._blCheckAndWarnBaseline  = checkAndWarnBaseline;
  window._blCheckBaselineStatus   = checkBaselineStatus;
  window._blShowBaselineModal     = showBaselineModal;
  window._blLoadBaseline          = loadBaseline;
})();


// function truncateDisplayName(name = '') {
//     const raw = name || '';
//     return raw.length > 15 ? raw.substring(0, 15) : raw;
// }

function truncateDisplayName(name = '') {
  const raw = (name || '').trim();
  if (!raw) return '';

  const normalized = raw.replace(/\s+/g, ' ');
  const truncated = normalized.length > 15 ? normalized.substring(0, 15) : normalized;
  return truncated.replace(/\b\w/g, char => char.toUpperCase());
}

// ─── Back-button / exit guard ─────────────────────────────────────────────────
(function () {
  // Push a dummy history entry so the first back-press triggers popstate
  // instead of closing the app immediately.
  history.pushState({ pwaRoot: true }, '');

  // Set to true when the user confirms exit so the next popstate is allowed
  // to pass through without re-showing the modal.
  let _allowExit = false;
  let _guardBusy = false;   // prevent double-fire while modal is open

  window.addEventListener('popstate', async function () {
    if (_allowExit) {
      _allowExit = false;
      return; // let the navigation proceed — app will close / go back naturally
    }

    if (_guardBusy) return;
    _guardBusy = true;

    // Re-push the guard so the next back-press is also intercepted.
    history.pushState({ pwaRoot: true }, '');

    const confirmed = await showGenericConfirmModal(
      'Exit the eTBr?',
      'Are you sure you want to close the eTBr?',
      'Exit'
    );

    _guardBusy = false;

    if (confirmed) {
      // Sign out first so the user's session is cleared even if history.back()
      // does not fully close the PWA on the device.
      setOfflineSession(false);
      _stopInactivityWatcher();
      localStorage.removeItem(AUTH_TOKEN_KEY);
      localStorage.removeItem(AUTH_EXPIRY_KEY);
      showAuthScreen();
      // Then attempt to navigate back (closes the PWA on Android home-screen installs).
      _allowExit = true;
      history.back();
    }
  });
}());

