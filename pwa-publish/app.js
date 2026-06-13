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
const APP_VERSION = 'v130620261356';

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

/** GUID of the patient currently being edited (null = new-patient mode). */
let _editingTID = null;

// ─── Service Worker Registration ────────────────────────────────────────

// Clear the reload-guard flag that was set during the previous SW-triggered
// reload so it doesn't block future updates in this page session.
sessionStorage.removeItem('sw-reloading');

// If the last reload was triggered by a SW update, show a toast once the app is ready.
const _swJustUpdated = sessionStorage.getItem('sw-updated') === '1';
if (_swJustUpdated) sessionStorage.removeItem('sw-updated');

if ('serviceWorker' in navigator) {

  // ── IMPORTANT: attach controllerchange BEFORE the load event ─────────
  // The new SW can race through install → skipWaiting → activate →
  // clients.claim() while the page is still loading.  If we waited until
  // the load event to add this listener we'd miss the event entirely and
  // the page would never reload to serve the fresh files.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem('sw-reloading')) return;
    sessionStorage.setItem('sw-reloading', '1');
    sessionStorage.setItem('sw-updated', '1');
    console.log('[SW] Controller changed — reloading for fresh assets');
    window.location.reload();
  });

  window.addEventListener('load', async () => {
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
            if (sessionStorage.getItem('sw-reloading')) return;
            sessionStorage.setItem('sw-reloading', '1');
            console.log('[SW] New SW activated via updatefound — reloading');
            window.location.reload();
          }
        });
      });

    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }
  });
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

    if (ua.includes('Firefox')) {
      instructions = 'Firefox: open the browser menu (☰) and choose "Install" or look for the install icon in the address bar.';
    } else if (/iPhone|iPad|iPod/.test(ua) || (/Safari/.test(ua) && !/Chrome/.test(ua))) {
      instructions = 'Safari: tap the Share button (□↑) then "Add to Home Screen".';
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

function updateConnectionStatus() {
  if (navigator.onLine) {
    connectionStatus.innerHTML  = `${_WIFI_ON_SVG} Online`;
    connectionStatus.className  = 'status-badge bg-success text-white';
  } else {
    connectionStatus.innerHTML  = `${_WIFI_OFF_SVG} Offline`;
    connectionStatus.className  = 'status-badge bg-danger text-white';
  }
}

window.addEventListener('online',  updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
updateConnectionStatus();   // set initial state

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

  _toastTimer = setTimeout(() => {
    toast.className = 'toast';
  }, 3000);
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
  // Phone 1 is optional — only validate format when a value is entered
  const phone1El = document.getElementById('phone1');
  if (phone1El && phone1El.value.trim() !== '') {
    check('phone1', v => /^\d{10}$/.test(v.trim()), 'Phone 1 must be exactly 10 digits.');
  }

  const p2 = document.getElementById('phone2');
  if (p2 && p2.value.trim() !== '') {
    if (!/^\d{10}$/.test(p2.value.trim())) {
      p2.classList.add('invalid');
      const e = document.getElementById('phone2-error');
      if (e) e.textContent = 'Phone 2 must be exactly 10 digits.';
      valid = false;
    }
  }

  // INH dates — each must be at least 7 days after the previous
  const inhDates = [...document.querySelectorAll('#inh-rows .dynamic-row input[type="date"]')]
    .map(el => el.value).filter(Boolean);
  for (let i = 1; i < inhDates.length; i++) {
    const diffDays = (new Date(inhDates[i]) - new Date(inhDates[i - 1])) / 86400000;
    if (diffDays < 7) {
      showToast(`INH Date ${i + 1} must be at least 7 days after Date ${i}.`, 'error');
      valid = false;
      break;
    }
  }

  // PMTCT delivery dates — each must be at least 365 days after the previous
  const pregDates = [...document.querySelectorAll('#pregnancy-rows .dynamic-row .preg-del')]
    .map(el => el.value).filter(Boolean);
  for (let i = 1; i < pregDates.length; i++) {
    const diffDays = (new Date(pregDates[i]) - new Date(pregDates[i - 1])) / 86400000;
    if (diffDays < 365) {
      showToast(`Pregnancy ${i + 1} delivery date must be at least 1 year (365 days) after Pregnancy ${i}.`, 'error');
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
  document.getElementById('cancel-edit-btn').hidden  = true;
  document.getElementById('form-title').textContent  = 'New Patient — ART Register';
  submitBtn.innerHTML = SAVE_BTN_HTML;
}

/**
 * Pre-populates the patient form with an existing patient's data and
 * switches the form into edit mode.
 * @param {string} tid  PtDetailsTID (GUID) of the patient to edit.
 */
function loadPatientIntoForm(tid) {
  const pt = getPtDetails(tid);
  if (!pt) { showToast('Patient record not found.', 'error'); return; }

  _editingTID = tid;

  // ── UI: switch to edit mode ────────────────────────────────────────────
  document.getElementById('form-title').textContent       = 'Edit Patient — ART Register';
  document.getElementById('edit-patient-name').textContent = pt.FullName;
  document.getElementById('edit-mode-banner').hidden      = false;
  document.getElementById('cancel-edit-btn').hidden       = false;
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
  document.getElementById('fullName').value = pt.FullName ?? '';
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
  document.querySelector('.form-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  // Keep dashboard stats in sync with the local DB.
  updateDashboardStats();

  patientsTbody.innerHTML = patients.map((p, i) => `
    <tr data-tid="${escHtml(p.PtDetailsTID)}">
      <td>${i + 1}</td>
      <td title="${escHtml(p.ARTNo)}">${escHtml(p.ARTNo)}</td>
      <td title="${escHtml(p.FullName)}">${escHtml(p.FullName)}</td>
      <td>${p.Age}</td>
      <td>${escHtml(p.Sex ?? '')}</td>
      <td>${p.ARTStartDate ? fmtDate(p.ARTStartDate) : ''}</td>
      <td>
        <button class="btn btn-secondary btn-sm visits-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          data-name="${escHtml(p.FullName)}"
          data-artstart="${escHtml(p.ARTStartDate ?? '')}">
          Enter Follow-Up Visits
        </button>
      </td>
      <td>${canWrite ? `
        <button class="btn btn-secondary btn-sm edit-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          aria-label="Edit ${escHtml(p.FullName)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
          Edit
        </button>
        <button class="btn btn-danger delete-btn"
          data-tid="${escHtml(p.PtDetailsTID)}"
          aria-label="Delete ${escHtml(p.FullName)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14H6L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4h6v2"/>
          </svg>
          Delete
        </button>` : ''}
      </td>
    </tr>
  `).join('');

  // Show / refresh the deleted-records section for write users
  if (canWrite) renderDeletedPatients();
}

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
        renderPatients(searchInput?.value || '');
        showToast(`"${name}" has been restored.`, 'success');
        if (navigator.onLine) triggerSync(true);
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
      <div class="table-wrap" style="margin-top:0.75rem;">
        <table aria-label="Deleted patient records">
          <thead>
            <tr>
              <th>#</th><th>ART No</th><th>Full Name</th><th>Age</th>
              <th>Sex</th><th>ART Start</th><th>Deleted On</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            ${deleted.map((p, i) => `
              <tr>
                <td>${i + 1}</td>
                <td>${escHtml(p.ARTNo)}</td>
                <td>${escHtml(p.FullName)}</td>
                <td>${p.Age}</td>
                <td>${escHtml(p.Sex ?? '')}</td>
                <td>${p.ARTStartDate ? fmtDate(p.ARTStartDate) : ''}</td>
                <td>${p.LastModOn ? fmtDate(p.LastModOn.substring(0, 10)) : ''}</td>
                <td>
                  <button class="btn btn-secondary btn-sm undelete-btn"
                    data-tid="${escHtml(p.PtDetailsTID)}"
                    data-name="${escHtml(p.FullName)}">
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

// ─── Event: form submit ──────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  if (!_selectedFacility) {
    showToast('Please select a health facility before saving.', 'error');
    _openSidebar();
    return;
  }

  if (!validateForm()) {
    showToast('Please fix the highlighted errors.', 'error');
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
      FullName:             document.getElementById('fullName').value.trim(),
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
    if (navigator.onLine) triggerSync(true);

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

  // ── Visits button ───────────────────────────────────────────────────────
  const visitsBtn = event.target.closest('.visits-btn');
  if (visitsBtn) {
    _currentVisitPatientTID = visitsBtn.dataset.tid;
    _currentVisitARTStart   = visitsBtn.dataset.artstart;
    visitsPatientNameEl.textContent = visitsBtn.dataset.name;
    visitsPanelEl.hidden = false;
    visitsPanelEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
      if (_currentVisitPatientTID === tid) visitsPanelEl.hidden = true;
      renderPatients(searchInput.value);
      showToast('Patient deleted. Use "Deleted Records" below to restore if needed.', 'success');
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
    const regimens   = getLookupAll('RegimenT');
    const reasons    = getLookupAll('RegimenChangeReasonT');
    const fuStatus   = getLookupAll('FollowUpStatusT');
    const tbSt       = getLookupAll('TBStatusT');
    const stopReas   = getLookupAll('StopReasonT');

    console.log('[DB] SexT rows:', sex.length, '| OccupationT:', occ.length, '| RegimenT:', regimens.length);

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

  // Visit panel — save visit
  saveVisitBtnEl?.addEventListener('click', async () => {
    if (!_currentVisitPatientTID) return;
    const vDate = visitDateInput?.value;
    if (!vDate) { showToast('Visit date is required.', 'error'); return; }

    // Enforce date ordering among this patient's visits.
    const allVisitsSorted = getFollowUps(_currentVisitPatientTID)
      .sort((a, b) => (a.VisitDate ?? '') < (b.VisitDate ?? '') ? -1 : 1);
    if (_editingVisitTID) {
      // Edit mode: new date must sit between the preceding and following visits.
      const idx  = allVisitsSorted.findIndex(v => v.PtFollowUpTID === _editingVisitTID);
      const pred = idx > 0 ? allVisitsSorted[idx - 1].VisitDate : null;
      const succ = idx < allVisitsSorted.length - 1 ? allVisitsSorted[idx + 1].VisitDate : null;
      if (pred && vDate < pred) {
        showToast(`Visit date cannot be before the preceding visit (${fmtDate(pred)}).`, 'error');
        return;
      }
      if (succ && vDate > succ) {
        showToast(`Visit date cannot be after the following visit (${fmtDate(succ)}).`, 'error');
        return;
      }
    } else {
      // New visit: must not be before the most recent existing visit.
      if (allVisitsSorted.length > 0) {
        const latestDate = allVisitsSorted.at(-1).VisitDate;
        if (latestDate && vDate < latestDate) {
          showToast(`Visit date cannot be before the most recent visit (${fmtDate(latestDate)}).`, 'error');
          return;
        }
      }
    }

    const visitData = {
      PtDetailsTID:     _currentVisitPatientTID,
      VisitDate:        vDate,
      FollowUpStatusID: Number(document.getElementById('visitFollowUpStatus')?.value ?? 0),
      RegimenID:        Number(document.getElementById('visitRegimen')?.value ?? 0),
      TBStatusID:       Number(document.getElementById('visitTBStatus')?.value ?? 0),
      StopReasonID:     Number(document.getElementById('visitStopReason')?.value ?? 0),
      StopOtherText:    document.getElementById('visitStopOther')?.value.trim() || null,
      WeeksInterrupted: Number(document.getElementById('visitWeeksInterrupted')?.value ?? 0),
      WeightKg:         parseFloat(document.getElementById('visitWeight')?.value) || null,
      HeightCm:         parseFloat(document.getElementById('visitHeight')?.value) || null,
      CPTDrugID:        Number(document.getElementById('visitCPTDrug')?.value ?? 0),
      CD4Value:         parseFloat(document.getElementById('visitCD4')?.value) || null,
      CD4IsPercent:     document.getElementById('visitCD4IsPercent')?.checked ? 1 : 0,
      ViralLoad:        document.getElementById('visitViralLoad')?.value.trim() || null,
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
      if (navigator.onLine) triggerSync(true);
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
      <td>${escHtml(v.ViralLoad ?? '')}</td>
      <td style="white-space:nowrap">
        <button class="btn btn-secondary btn-sm edit-visit-btn"
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
          data-viral="${escHtml(v.ViralLoad ?? '')}"
          data-notes="${escHtml(v.Notes ?? '')}"
        >Edit</button>
        <button class="btn btn-danger btn-sm delete-visit-btn"
          data-vid="${escHtml(v.PtFollowUpTID)}"
          data-ptid="${escHtml(v.PtDetailsTID)}">Delete</button>
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
  function syncDateColour() {
    input.classList.toggle('date-has-value', !!input.value);
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

const loginForm       = document.getElementById('login-form');
const loginError      = document.getElementById('login-error');
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
  if (new Date() >= new Date(expiry)) { clearAuth(); return null; }
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
    const total    = getAllPtDetails().length;
    const pending  = getAllPtDetailsForSync().length;
    const lastSync = localStorage.getItem('art.lastSync');

    const elPts  = document.getElementById('db-stat-patients');
    const elPend = document.getElementById('db-stat-pending');
    const elSync = document.getElementById('db-stat-lastsync');

    if (elPts)  elPts.textContent  = total;
    if (elPend) elPend.textContent = pending;
    if (elSync) {
      if (lastSync) {
        const diff = Math.round((Date.now() - new Date(lastSync)) / 60000); // minutes
        elSync.textContent = diff < 1   ? 'Just now'
                           : diff < 60  ? `${diff}m ago`
                           : diff < 1440 ? `${Math.round(diff/60)}h ago`
                           : `${Math.round(diff/1440)}d ago`;
      } else {
        elSync.textContent = 'Never';
      }
    }
  } catch { /* DB not ready yet — stats will be refreshed on next call */ }
}

/** Navigate to the dashboard, hiding any open register screen. */
function showDashboard() {
  if (dashboardScreen)   dashboardScreen.hidden   = false;
  if (artRegisterScreen) artRegisterScreen.hidden = true;
  updateDashboardStats();
  // Scroll to top so the welcome banner is visible
  window.scrollTo({ top: 0, behavior: 'smooth' });
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
  authScreen.hidden = true;
  appScreen.hidden  = false;
  const user = getUser();
  if (user) {
    logoutBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14" aria-hidden="true" style="flex-shrink:0"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Log Out`;
    userInfoBar.hidden = false;
    // Populate welcome banner
    const nameEl     = document.getElementById('db-welcome-name');
    const facilityEl = document.getElementById('db-welcome-facility');
    if (nameEl)     nameEl.textContent     = `Welcome back, ${user.fullName ?? user.userName ?? 'User'}!`;
    if (facilityEl) {
      // Show a role label alongside the username/email
      const roleLabel = Array.isArray(user.roles) && user.roles.length
        ? user.roles.join(', ')
        : (user.groupID === 4 ? 'National Level' : user.groupID === 3 ? 'State Coordinator' : user.groupID === 2 ? 'County Supervisor' : 'Data Entrant');
      facilityEl.textContent = `${user.emailAddress ?? user.userName ?? ''}${roleLabel ? '  ·  ' + roleLabel : ''}`;
    }
  }
  // Always land on the dashboard after login
  showDashboard();
}

function showAuthScreen() {
  authScreen.hidden  = false;
  appScreen.hidden   = true;
  userInfoBar.hidden = true;
  _showPanel('login');
}

function _showPanel(name) {
  loginPanel.hidden    = name !== 'login';
  registerPanel.hidden = name !== 'register';
  forgotPanel.hidden   = name !== 'forgot';
  resetPanel.hidden    = name !== 'reset';
  if (name === 'login') { loginError.hidden = true; loginError.textContent = ''; }
}

// ── Panel navigation ─────────────────────────────────────────────────────
document.getElementById('show-register-link').addEventListener('click',     e => { e.preventDefault(); _showPanel('register'); });
document.getElementById('show-forgot-link').addEventListener('click',       e => { e.preventDefault(); _showPanel('forgot'); });
document.getElementById('show-login-link').addEventListener('click',        e => { e.preventDefault(); _showPanel('login'); });
document.getElementById('show-login-from-forgot').addEventListener('click', e => { e.preventDefault(); _showPanel('login'); });
document.getElementById('show-login-from-reset').addEventListener('click',  e => { e.preventDefault(); _showPanel('login'); });

// ── Password show/hide toggles ────────────────────────────────────────────
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
      saveAuth(data);
      loginForm.reset();
      showAppScreen();
    } else {
      loginError.textContent = data.error ?? 'Login failed.';
      loginError.hidden = false;
    }
  } catch {
    loginError.textContent = 'Could not reach the server. Check your connection.';
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
  // GroupID is inferred: has county or facility → 2 (County level), else 4 (National)
  const inferredGroupID = (facilityId !== 0 || countyId !== 0) ? 2 : 4;

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
      registerSuccess.textContent = data.message ?? 'Account created! Awaiting administrator approval.';
      registerSuccess.hidden = false;
      setTimeout(() => _showPanel('login'), 4000);
    } else {
      registerError.textContent = data.error ?? 'Registration failed.';
      registerError.hidden = false;
    }
  } catch {
    registerError.textContent = 'Could not reach the server. Check your connection.';
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
    forgotMsg.textContent = 'Could not reach the server.';
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
    resetMsg.textContent = 'Could not reach the server.';
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
  clearAuth();
  showAuthScreen();
});

// ─── Facility Tree ───────────────────────────────────────────────────────

const FACILITY_KEY = 'art.selectedFacility';   // localStorage key
let _selectedFacility = null;   // { id, name, countyId, county, stateId, state }
let _selectedRegister = null;   // 'art' | null (not persisted — reset on each visit)

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
  if (navigator.onLine && token) {
    try {
      const res = await fetch(`${API_BASE}/patients/geo-tree`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (res.ok) {
        const items = await res.json();
        upsertGeoAreaData(items);   // cache to SQLite
        console.log(`[Tree] Fetched ${items.length} facilities from server`);
        return items;
      }
    } catch (err) {
      console.warn('[Tree] Server fetch failed, using cache:', err.message);
    }
  }
  // Offline or fetch failed — return cached data
  const cached = getGeoAreaData();
  console.log(`[Tree] Using ${cached.length} cached facilities`);
  return cached.map(r => ({
    healthFacilityID: r.HealthFacilityID,
    healthFacility:   r.HealthFacility,
    countyID:         r.CountyID,
    county:           r.County,
    stateID:          r.StateID,
    state:            r.State,
  }));
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

  let html = '<ul class="tree-list tree-list--state">';
  for (const [, stateObj] of [...states.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const stateOpen = term ? ' open' : '';
    html += `<li class="tree-node tree-node--state">
      <details class="tree-details"${stateOpen}>
        <summary class="tree-summary tree-summary--state">
          <svg class="tree-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true" class="tree-icon"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
          <span>${escHtml(stateObj.name)}</span>
        </summary>
        <ul class="tree-list tree-list--county">`;

    for (const [, countyObj] of [...stateObj.counties.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
      const countyOpen = term ? ' open' : '';
      html += `<li class="tree-node tree-node--county">
          <details class="tree-details"${countyOpen}>
            <summary class="tree-summary tree-summary--county">
              <svg class="tree-toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="10" height="10" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14" aria-hidden="true" class="tree-icon"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0118 0z"/><circle cx="12" cy="10" r="3"/></svg>
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
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="12" height="12" aria-hidden="true" class="tree-hf-icon"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>
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
  html += '</ul>';
  container.innerHTML = html;
}

/** Load geo-tree data and render the tree (call when entering the register). */
async function loadAndRenderGeoTree() {
  const container = document.getElementById('facility-tree');
  if (container) container.innerHTML = '<p class="tree-loading">Loading facilities\u2026</p>';
  try {
    const items = await fetchGeoTreeData();
    // Store a flat reference for search filtering
    document.getElementById('facility-tree')._treeData = items;
    renderFacilityTree(items);
  } catch (err) {
    console.error('[Tree] Failed to load tree:', err);
    const container2 = document.getElementById('facility-tree');
    if (container2) container2.innerHTML = '<p class="tree-empty">Could not load facilities.</p>';
  }
}

/**
 * Called when the user taps a facility in the tree.
 * If currently editing a patient, ask for confirmation first.
 * @param {{id,name,countyId,county,stateId,state}} fac
 */
function selectFacility(fac) {
  function doSelect() {
    _saveSelectedFacility(fac);
    updateFacilityBanner();
    applyFacilityGate();
    // Re-render tree to update selected highlight
    const tree = document.getElementById('facility-tree');
    if (tree && tree._treeData) renderFacilityTree(tree._treeData, document.getElementById('tree-search')?.value || '');
    // Close sidebar on mobile after selection
    if (window.innerWidth < 768) _closeSidebar();
  }

  if (_editingTID) {
    // Confirm facility change while editing a patient
    if (!confirm('Changing the facility will exit edit mode and start a new patient.\n\nContinue?')) return;
    exitEditMode();
    form.reset();
    _resetFormUI();
  }
  doSelect();
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
  } else {
    if (reqBanner) reqBanner.hidden = false;
    if (selBanner) selBanner.hidden = true;
    if (topLabel) topLabel.textContent = 'Select a Facility';
  }
}

/** Show or hide the register selector and register content based on facility + register selection. */
function applyFacilityGate() {
  const regSelector = document.getElementById('register-selector');
  const content     = document.getElementById('register-content');
  if (!_selectedFacility) {
    // No facility — hide everything below the facility-required banner
    if (regSelector) regSelector.hidden = true;
    if (content)     content.hidden     = true;
  } else if (!_selectedRegister) {
    // Facility selected, register not yet chosen — show the dropdown
    if (regSelector) regSelector.hidden = false;
    if (content)     content.hidden     = true;
  } else {
    // Both selected — show register content
    if (regSelector) regSelector.hidden = false;
    if (content)     content.hidden     = false;
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

document.getElementById('frb-open-sidebar-btn')?.addEventListener('click', _openSidebar);

// ── Register selector: load the chosen register ──────────────────────────

document.getElementById('register-select')?.addEventListener('change', (e) => {
  _selectedRegister = e.target.value || null;
  applyFacilityGate();
  if (_selectedFacility && _selectedRegister === 'art') renderPatients();
});

// ── Facility tree: click delegation ──────────────────────────────────────

document.getElementById('facility-tree')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.tree-facility-btn');
  if (!btn) return;
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

    await initDB();
    await populateDropdowns();
    initSelectColours();
    setupFormWiring();
    initDateFields();
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
const SYNC_API_URL = 'https://api.etbr.org/api/patients/sync-full';

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

/** Reference to the Sync button injected in index.html. */
const syncBtn = document.getElementById('sync-btn');

/**
 * Keeps the Sync button's visibility in sync with the online/offline state.
 * We don't hide it — we show it but disable it offline so the user knows the
 * feature exists and understands why it isn't clickable.
 */
function updateSyncButtonState() {
  if (!syncBtn) return;

  if (navigator.onLine) {
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
async function triggerSync(silent = false) {
  logSync('INFO', `triggerSync called`, { silent, online: navigator.onLine });

  if (!navigator.onLine) {
    logSync('WARN', 'Aborted — device is offline');
    if (!silent) showToast('You are offline. Sync is not available.', 'error');
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
        FullName:             p.FullName,
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
      logSync('ERROR', 'No auth token — user not signed in or session expired');
      showToast('Please sign in before syncing.', 'error');
      showAuthScreen();
      return;
    }
    logSync('INFO', 'Auth token present');

    // Log token expiry for diagnostics
    const expiry = localStorage.getItem(AUTH_EXPIRY_KEY);
    logSync('INFO', 'Token expiry', { expiry, now: new Date().toISOString() });

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
      updateDashboardStats();
      if (!silent) {
        showToast(data.message ?? 'Sync successful!', 'success');
      } else {
        // Auto-sync after save: let the "Patient saved" toast finish first,
        // then briefly confirm the server received the record.
        setTimeout(() => showToast('Synced to server ✓', 'success'), 1200);
      }
    } else {
      let rawBody = '';
      try { rawBody = await response.text(); } catch { /* ignore */ }
      let errorMsg = `Sync failed (${response.status})`;
      try {
        const errData = JSON.parse(rawBody);
        errorMsg = errData.error ?? errData.message ?? errorMsg;
      } catch { /* non-JSON error body */ }
      logSync('ERROR', `Server error ${response.status}`, { errorMsg, rawBody: rawBody.slice(0, 500) });
      // Always show sync errors — the user needs to know data didn't reach the server.
      showToast(
        silent ? 'Auto-sync failed — tap "Sync Data" to retry.' : `${errorMsg}. Please try again.`,
        'error'
      );
    }

  } catch (err) {
    logSync('ERROR', `Network/JS exception: ${err.message}`, { stack: err.stack?.split('\n').slice(0, 4) });
    showToast(
      silent ? 'Auto-sync failed — check your connection.' : 'Could not reach the server. Check your connection and retry.',
      'error'
    );
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
  }
}

// ─── Auto-sync when connectivity is restored ────────────────────────────
// Fires silently so offline-collected data is uploaded as soon as the
// device comes back online, without the user needing to tap "Sync Data".
window.addEventListener('online', () => {
  if (getToken()) triggerSync(true);
});

// ─── Sync: click handler ──────────────────────────────────────────────────

syncBtn?.addEventListener('click', async () => {
  if (!navigator.onLine) {
    showToast('You are offline. Sync is not available.', 'error');
    return;
  }
  await triggerSync(false);
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
document.getElementById('dash-goto-art')?.addEventListener('click', () => showARTRegister());
document.getElementById('dash-goto-art')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showARTRegister(); }
});

/** Sync Data card — triggers sync (if online) and stays on dashboard */
document.getElementById('dash-goto-sync')?.addEventListener('click', () => {
  if (!navigator.onLine) {
    showToast('You are offline. Sync is not available.', 'error');
    return;
  }
  triggerSync(false).then(() => updateDashboardStats());
});
document.getElementById('dash-goto-sync')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.currentTarget.click(); }
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
  showDashboard();
});

