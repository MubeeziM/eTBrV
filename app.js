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

// ─── Service Worker Registration ────────────────────────────────────────

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      const reg = await navigator.serviceWorker.register('./service-worker.js');
      console.log('[SW] Registered, scope:', reg.scope);
    } catch (err) {
      console.warn('[SW] Registration failed:', err);
    }
  });
}

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

/**
 * Validates all form fields.
 * Marks invalid fields with an .invalid class and displays an error message.
 * @returns {boolean} true if all fields pass validation.
 */
function validateForm() {
  let valid = true;

  const fields = [
    {
      id: 'name',
      label: 'Full Name',
      test: (v) => v.trim().length >= 2,
      msg: 'Please enter the patient\'s full name (min 2 characters).'
    },
    {
      id: 'age',
      label: 'Age',
      test: (v) => v !== '' && Number(v) >= 0 && Number(v) <= 150,
      msg: 'Please enter a valid age between 0 and 150.'
    },
    {
      id: 'sex',
      label: 'Sex',
      test: (v) => ['Male', 'Female', 'Other'].includes(v),
      msg: 'Please select a sex.'
    },
    {
      id: 'phone',
      label: 'Phone',
      // Basic: at least 6 digits/chars, allows +, spaces, dashes
      test: (v) => /^[\d\s\+\-\(\)]{6,30}$/.test(v.trim()),
      msg: 'Please enter a valid phone number (6–30 characters).'
    },
    {
      id: 'address',
      label: 'Address',
      test: (v) => v.trim().length >= 5,
      msg: 'Please enter a full address (min 5 characters).'
    }
  ];

  // Clear all previous error states first
  fields.forEach(({ id }) => {
    const el  = document.getElementById(id);
    const err = document.getElementById(`${id}-error`);
    el.classList.remove('invalid');
    if (err) err.textContent = '';
  });

  // Then validate each field
  fields.forEach(({ id, test, msg }) => {
    const el  = document.getElementById(id);
    const err = document.getElementById(`${id}-error`);
    const val = el.value;

    if (!test(val)) {
      el.classList.add('invalid');
      if (err) err.textContent = msg;
      valid = false;
    }
  });

  return valid;
}

// ─── Patient table renderer ──────────────────────────────────────────────

/**
 * Fetches all patients (optionally filtered) and re-renders the table.
 * @param {string} [searchTerm='']
 */
function renderPatients(searchTerm = '') {
  const patients = getAllPatients(searchTerm);  // from db.js

  // Toggle empty state message
  const hasRows = patients.length > 0;
  emptyState.style.display = hasRows ? 'none' : 'block';
  document.querySelector('.table-wrap table').style.display = hasRows ? '' : 'none';

  // Update count badge
  patientCount.textContent = `${patients.length} record${patients.length !== 1 ? 's' : ''}`;

  // Build table rows
  patientsTbody.innerHTML = patients
    .map((p) => `
      <tr data-id="${p.id}">
        <td>${p.id}</td>
        <td title="${escHtml(p.name)}">${escHtml(p.name)}</td>
        <td>${p.age}</td>
        <td>${escHtml(p.sex)}</td>
        <td title="${escHtml(p.phone)}">${escHtml(p.phone)}</td>
        <td title="${escHtml(p.address)}">${escHtml(p.address)}</td>
        <td>
          <button
            class="btn btn-danger delete-btn"
            data-id="${p.id}"
            aria-label="Delete patient ${escHtml(p.name)}"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
              <polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/>
              <path d="M10 11v6M14 11v6"/><path d="M9 6V4h6v2"/>
            </svg>
            Delete
          </button>
        </td>
      </tr>
    `)
    .join('');
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

// ─── Event: form submit ──────────────────────────────────────────────────

form.addEventListener('submit', async (event) => {
  event.preventDefault();

  // 1. Validate
  if (!validateForm()) {
    showToast('Please fix the highlighted errors.', 'error');
    return;
  }

  // 2. Disable button to prevent double-submit
  submitBtn.disabled    = true;
  submitBtn.textContent = 'Saving…';

  try {
    // 3. Collect form values
    const patient = {
      name:    document.getElementById('name').value.trim(),
      age:     Number(document.getElementById('age').value),
      sex:     document.getElementById('sex').value,
      phone:   document.getElementById('phone').value.trim(),
      address: document.getElementById('address').value.trim()
    };

    // 4. Insert into SQLite and persist to IndexedDB
    await insertPatient(patient);   // from db.js

    // 5. Clear the form
    form.reset();

    // 6. Refresh the displayed list (clear search filter too)
    searchInput.value = '';
    renderPatients();

    showToast('Patient saved successfully!', 'success');

  } catch (err) {
    console.error('[App] Error saving patient:', err);
    showToast('Error saving patient. Please try again.', 'error');
  } finally {
    submitBtn.disabled    = false;
    submitBtn.innerHTML   = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      Save Patient
    `;
  }
});

// ─── Event: delete patient (event delegation on tbody) ───────────────────

patientsTbody.addEventListener('click', async (event) => {
  const btn = event.target.closest('.delete-btn');
  if (!btn) return;

  const id   = Number(btn.dataset.id);
  const name = btn.closest('tr')?.querySelector('td:nth-child(2)')?.textContent || 'this patient';

  // Confirm before deleting
  if (!confirm(`Delete record for "${name}"?`)) return;

  try {
    await deletePatient(id);   // from db.js
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

// ─── Bootstrap ───────────────────────────────────────────────────────────

/**
 * Entry point: initialise the database then render the patient list.
 */
async function bootstrap() {
  try {
    // Show a loading state on the submit button while sql.js WASM loads
    submitBtn.disabled    = true;
    submitBtn.textContent = 'Loading database…';

    await initDB();   // from db.js — loads sql.js WASM, restores from IndexedDB

    renderPatients();
  } catch (err) {
    console.error('[App] Failed to initialise database:', err);
    showToast('Database initialisation failed. Reload the page.', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 01-2-2V5a2 2 0 012-2h11l5 5v14a2 2 0 01-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
      Save Patient
    `;
  }
}

bootstrap();
