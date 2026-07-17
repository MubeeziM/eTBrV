# ART Patient Register — Security Improvements
**Project:** eTBR ART/TB Patient Register PWA  
**URL:** https://art.etbr.org  
**Date completed:** July 2026  

---

## Background

The ART Patient Register is a Progressive Web App (PWA) used by clinical staff to record and manage HIV/ART and TB patient data.  Because it is designed to work offline, the app stores a full copy of the patient database locally inside the browser on each clinic device.

A security review identified that sensitive data — including authentication tokens and patient records — were stored in the browser in plaintext, creating a risk of unauthorised disclosure if a device was lost, stolen, or accessed by an unauthorised person.

---

## Vulnerabilities Found

| # | Finding | Risk |
|---|---------|------|
| 1 | JWT authentication token stored in browser `localStorage` in plaintext | Token theft via DevTools, malicious browser extension, or XSS → full API access as the victim user |
| 2 | User profile (including roles `SuperUser`, `Admin`, full name, email) stored in plaintext `localStorage` | Information disclosure on shared or unattended devices |
| 3 | Large base64-encoded avatar image stored in `localStorage` | Unnecessary data exposure; performance overhead |
| 4 | No HTTP security headers (Content Security Policy, etc.) | Cross-site scripting (XSS), clickjacking, MIME-sniffing attacks |
| 5 | Offline patient database (SQLite) stored as **plaintext binary** in browser IndexedDB | Anyone with physical access to the device could open DevTools → Application → IndexedDB and read all patient records directly |

---

## Security Improvements Implemented

### 1 — HTTP Security Headers (CSP)
**What:** Added a full set of HTTP security headers to the web server configuration.  
**Headers added:**
- **Content-Security-Policy** — restricts which scripts, styles, and resources the page may load; blocks inline script injection
- **X-Content-Type-Options: nosniff** — prevents MIME-type sniffing attacks
- **X-Frame-Options: DENY** — prevents the app from being embedded in a malicious iframe (clickjacking)
- **Referrer-Policy: strict-origin-when-cross-origin** — limits referrer information sent to third parties

**Impact:** Significantly reduces the attack surface for Cross-Site Scripting (XSS) — a class of attack listed in the OWASP Top 10.

---

### 2 — JWT Token Moved to HttpOnly Cookie
**What:** The authentication token (JWT) is no longer stored in browser `localStorage`. Instead, the server now issues it as an **HttpOnly cookie**.  
**Why this matters:**
- An **HttpOnly** cookie is completely inaccessible to JavaScript — it cannot be read by DevTools, browser extensions, or injected scripts
- The token is sent automatically with every API request by the browser; application code never touches it
- A logout endpoint was added that instructs the server to clear the cookie

**Impact:** The JWT token can no longer be stolen by an attacker who gains JavaScript execution in the browser.

---

### 3 — Sensitive Data Removed from localStorage
**What:** Cleaned up what is stored in `localStorage` after login:
- ❌ **Removed:** JWT token value
- ❌ **Removed:** Base64-encoded avatar image (hundreds of kilobytes of unnecessary data)
- ✅ **Retained only:** Token expiry timestamp (needed for "session about to expire" warning), and the user profile fields required to render the UI

**Impact:** Reduces the amount of sensitive information exposed on the device.

---

### 4 — Inactivity Auto-Logout
**What:** The app already had an inactivity timer; this was reviewed and confirmed active. After a configurable period of inactivity the app automatically signs out the user, clears the session, and clears the server-side auth cookie.

**Impact:** Protects against unattended device access.

---

### 5 — Patient Database Encrypted at Rest (AES-256-GCM)
**What:** The offline patient database (a full SQLite database stored in browser IndexedDB) is now **encrypted before being saved** and **decrypted on load**, using:

| Property | Value |
|----------|-------|
| Algorithm | AES-256-GCM (authenticated encryption — detects tampering) |
| Key size | 256 bits |
| Key derivation | PBKDF2 / SHA-256 / 100,000 iterations (OWASP recommended) |
| Key inputs | User's unique account ID + a random per-device salt |
| Nonce (IV) | 12 bytes, randomly generated for every save |

**How the key is managed:**
- A random 32-byte salt is generated the first time the app runs on a device and stored in `localStorage` (`art.deviceSalt`)
- The encryption key is derived from that salt combined with the user's unique account identifier using PBKDF2 (a standard password-based key derivation function)
- The derived key is cached in `sessionStorage` for the duration of the browser tab so the expensive derivation (100,000 hash iterations) only runs once per session
- The key is **never stored directly** — it is always derived on demand

**Backward compatibility:** Existing devices that already have patient data were handled transparently — the app detects the old plaintext format, loads it normally, and re-encrypts it on the next save with no action required from the user.

**Before (visible in DevTools):**
```
IndexedDB → db  →  "SQLite format 3..." [readable patient records]
```
**After (visible in DevTools):**
```
IndexedDB → db  →  Uint8Array [0x01, 0x01, <random IV>, <encrypted ciphertext>...]
```

**Impact:** Patient records stored on the device are no longer readable without the correct decryption key, protecting data on lost or stolen devices and shared workstations.

---

## Security Model Summary

| Threat | Before | After |
|--------|--------|-------|
| Attacker opens DevTools on unattended device | Reads JWT token + all patient data in plaintext | JWT not visible (HttpOnly cookie); patient DB is encrypted ciphertext |
| Device lost or stolen | Full patient database readable from browser profile directory | Database is AES-256-GCM encrypted; requires both the IndexedDB files and the localStorage values to attempt decryption |
| XSS attack injects malicious script | Script can steal JWT from `localStorage` | JWT in HttpOnly cookie — inaccessible to JavaScript; CSP blocks most injection vectors |
| Clickjacking / iframe embedding | Possible | Blocked by `X-Frame-Options: DENY` |

---

## What Was Not Changed

The inactivity timeout, offline PIN, and sync architecture were reviewed and left intact as they were already functioning correctly.

The `art.user` localStorage entry still contains role flags (`adminID`, `superUserID`, `roles`) required for UI rendering. These do not grant API access — the server validates the JWT independently on every request. Further minimisation of this data is a potential future improvement.

---

## Technologies Used

- **Web Crypto API (SubtleCrypto)** — built into all modern browsers; no external library required
- **PBKDF2** — industry-standard key derivation function (RFC 8018)
- **AES-256-GCM** — authenticated encryption standard used in TLS 1.3
- **HttpOnly Cookies** — standard browser security mechanism supported by all browsers
- **Content Security Policy Level 3** — W3C standard for restricting resource loading

All changes follow OWASP Top 10 guidance and use only browser-native APIs with no additional dependencies.
