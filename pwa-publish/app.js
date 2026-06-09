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
const APP_VERSION = 'v090620261314';

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

/** GUID of the patient currently being edited (null = new-patient mode). */
let _editingTID = null;

// ─── Service Worker Registration ────────────────────────────────────────

// Clear the reload-guard flag that was set during the previous SW-triggered
// reload so it doesn't block future updates in this page session.
sessionStorage.removeItem('sw-reloading');

if ('serviceWorker' in navigator) {

  // ── IMPORTANT: attach controllerchange BEFORE the load event ─────────
  // The new SW can race through install → skipWaiting → activate →
  // clients.claim() while the page is still loading.  If we waited until
  // the load event to add this listener we'd miss the event entirely and
  // the page would never reload to serve the fresh files.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem('sw-reloading')) return;
    sessionStorage.setItem('sw-reloading', '1');
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

  // Don't show if user already installed (e.g. they cleared localStorage but not the app)
  if (localStorage.getItem('pwaInstalled') === '1') {
    console.log('[PWA] Install prompt captured but app already installed — ignoring');
    return;
  }

  _deferredInstallPrompt = event;
  installBtn.hidden = false;
  console.log('[PWA] Install prompt captured — "Install App" button shown');
});

installBtn.addEventListener('click', async () => {
  // Fallback mode: browser doesn't support beforeinstallprompt — show instructions
  if (installBtn.dataset.fallback === 'true') {
    showToast(installBtn.dataset.instructions, '');
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
  console.log('[PWA] App installed successfully');
  _deferredInstallPrompt = null;
  installBtn.hidden = true;
  installBtn.removeAttribute('data-fallback');
  localStorage.setItem('pwaInstalled', '1');
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

  // User already installed the app previously (persisted across visits)
  if (localStorage.getItem('pwaInstalled') === '1') {
    console.log('[PWA] Previously installed — install button suppressed');
    return;
  }

  // beforeinstallprompt fires before/during load in supporting browsers.
  // A short defer ensures we don't race against it.
  setTimeout(() => {
    if (_deferredInstallPrompt !== null) return; // Chrome/Edge already handled it

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
  }, 300);
});

// ─── Online / Offline indicator ──────────────────────────────────────────

function updateConnectionStatus() {
  if (navigator.onLine) {
    connectionStatus.textContent = 'Online';
    connectionStatus.className   = 'status-badge online';
  } else {
    connectionStatus.textContent = 'Offline';
    connectionStatus.className   = 'status-badge offline';
  }
}

window.addEventListener('online',  updateConnectionStatus);
window.addEventListener('offline', updateConnectionStatus);
updateConnectionStatus();   // set initial state

// Stamp the version badge
const versionEl = document.getElementById('app-version');
if (versionEl) versionEl.textContent = APP_VERSION;

// ─── Toast helper ────────────────────────────────────────────────────────

let _toastTimer;

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

  const hasRows = patients.length > 0;
  emptyState.style.display = hasRows ? 'none' : 'block';
  document.querySelector('.table-wrap table').style.display = hasRows ? '' : 'none';
  patientCount.textContent = `${patients.length} record${patients.length !== 1 ? 's' : ''}`;

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
          Follow-up Visits
        </button>
      </td>
      <td>
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
        </button>
      </td>
    </tr>
  `).join('');
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

  if (!confirm(`Delete all records for "${name}"? This cannot be undone.`)) return;

  try {
    await deletePtDetails(tid);
    if (_currentVisitPatientTID === tid) visitsPanelEl.hidden = true;
    renderPatients(searchInput.value);
    showToast('Patient deleted.', 'success');
  } catch (err) {
    console.error('[App] Delete failed:', err);
    showToast('Could not delete patient.', 'error');
  }
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

    saveVisitBtnEl.disabled = true;
    try {
      await insertFollowUp({
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
      }, _currentVisitARTStart);

      // Clear visit form fields
      ['visitDate','visitWeight','visitHeight','visitBMI','visitCD4','visitViralLoad','visitNotes','visitWeeksInterrupted']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
      ['visitFollowUpStatus','visitRegimen','visitTBStatus','visitCPTDrug','visitStopReason']
        .forEach(id => { const el = document.getElementById(id); if (el) el.value = '0'; });
      document.getElementById('visitCD4IsPercent').checked = false;
      if (visitMonthDisplay) visitMonthDisplay.textContent = '';
      if (stopReasonRow) stopReasonRow.hidden = true;

      renderVisits(_currentVisitPatientTID);
      showToast('Visit saved.', 'success');
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
      <td>${escHtml(v.VisitDate ?? '')}</td>
      <td>${escHtml(v.FollowUpStatus ?? '')}</td>
      <td title="${escHtml(v.Regimen ?? '')}">${escHtml(v.RegimenCode ?? '')}</td>
      <td>${escHtml(v.TBStatus ?? '')}</td>
      <td>${v.WeightKg ?? ''}</td>
      <td>${v.CD4Value ?? ''}</td>
      <td>${escHtml(v.ViralLoad ?? '')}</td>
      <td>
        <button class="btn btn-danger btn-sm delete-visit-btn"
          data-vid="${escHtml(v.PtFollowUpTID)}"
          data-ptid="${escHtml(v.PtDetailsTID)}">Del</button>
      </td>
    </tr>
  `).join('');
}

visitsTbody?.addEventListener('click', async (e) => {
  const btn = e.target.closest('.delete-visit-btn');
  if (!btn) return;
  if (!confirm('Delete this visit record?')) return;
  // Direct DB delete (no helper for single visit yet)
  try {
    // _db is internal to db.js; use getPtDetails to verify then re-render
    // For now remove via deletePtDetails-style: visit has its own GUID
    // Workaround: call db.js internal via a small exposed helper
    await deleteVisit(btn.dataset.vid);
    renderVisits(btn.dataset.ptid);
    showToast('Visit deleted.', 'success');
  } catch (err) {
    showToast('Could not delete visit.', 'error');
  }
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
const SYNC_API_URL = 'https://api.etbr.org/api/patients/sync';

/**
 * Shared API key — must match the "ApiKey" value in appsettings.json.
 *
 * SECURITY: See the note above.  Do NOT commit a real production key here.
 * Consider loading it from a build-time environment variable or a separate
 * config file excluded from source control.
 */
const SYNC_API_KEY = 'mzr/st5M8oo+napv3tfX1gY6zyA32hkb7ow4g3lVm28=';

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
  if (!navigator.onLine) {
    if (!silent) showToast('You are offline. Sync is not available.', 'error');
    return;
  }

  const patients = getAllPtDetailsForSync();
  if (patients.length === 0) {
    if (!silent) showToast('No local records to sync.', '');
    return;
  }

  if (!silent) {
    syncBtn.disabled = true;
    syncBtn.classList.add('syncing');
    syncBtn.textContent = 'Syncing…';
  }

  try {
    // Build a complete payload — every field that the API/MERGE statement expects.
    const payload = patients.map(p => ({
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
    }));

    const response = await fetch(SYNC_API_URL, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key':    SYNC_API_KEY
      },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      const data = await response.json();
      // Silent mode: log only — don't override the "Patient saved" toast.
      if (!silent) showToast(data.message ?? 'Sync successful!', 'success');
      else         console.log('[Sync] Auto-sync succeeded:', data.message);
    } else {
      let errorMsg = `Sync failed (${response.status})`;
      try {
        const errData = await response.json();
        errorMsg = errData.error ?? errorMsg;
      } catch { /* non-JSON error body */ }
      // Always show sync errors — the user needs to know data didn't reach the server.
      showToast(
        silent ? 'Auto-sync failed — tap "Sync Data" to retry.' : `${errorMsg}. Please try again.`,
        'error'
      );
      console.warn('[Sync] Server error:', response.status, errorMsg);
    }

  } catch (err) {
    console.error('[Sync] Network error:', err);
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

// ─── Sync: click handler ──────────────────────────────────────────────────

syncBtn?.addEventListener('click', async () => {
  if (!navigator.onLine) {
    showToast('You are offline. Sync is not available.', 'error');
    return;
  }
  await triggerSync(false);
});
