/**
 * ============================================================
 *  دليل الاتصال — SRU Contact Directory
 *  Sulaiman Al Rajhi University · ICTD · ITOC
 *  Version : 1.9
 *  Backend : Google Apps Script (Web App) + People API (Directory)
 * ============================================================
 *  Data source : synced from the owner's own Google account (no Admin console):
 *                domain directory + My contacts (@sr.edu.sa only) → "Directory" tab
 *  Access      : @sr.edu.sa accounts only (deployment + server check)
 *  Logging     : every sign-in → Google Sheet tab "SignInLog"
 *  Overrides   : optional sheet tab "Overrides" to add/correct
 *                extension, mobile, department, title, or hide a record
 * ============================================================
 */

const CONFIG = {
  VERSION: '1.9',
  APP_NAME_AR: 'دليل الاتصال',
  APP_NAME_EN: 'SRU Contact Directory',
  DOMAIN: 'sr.edu.sa',
  TIMEZONE: 'Asia/Riyadh',

  // Backend Google Sheet (tabs: SignInLog + Overrides) — created in the owner's Drive.
  // https://docs.google.com/spreadsheets/d/1PvaYpkCe8JRPqo_sxsHGE66j0sFbUs2vzDEfhbLprjQ/edit
  SHEET_ID: '1PvaYpkCe8JRPqo_sxsHGE66j0sFbUs2vzDEfhbLprjQ',   // SRU Contact Directory — Backend (Log & Overrides)

  // Cache refresh — the hourly trigger rebuilds the directory snapshot.
  CACHE_SECONDS: 6 * 60 * 60,           // CacheService max = 6 hours
  REFRESH_EVERY_HOURS: 1,

  // How phone numbers in the Workspace profile are interpreted
  MOBILE_TYPES: ['mobile', 'work_mobile', 'cell'],
  EXTENSION_TYPES: ['work', 'extension', 'ext', 'internal', 'company_main'],
  EXTENSION_MAX_DIGITS: 5,              // any number with ≤ 5 digits = internal extension

  AUTO_SYNC: true,                      // hourly trigger re-syncs the Directory tab from the owner's account
  SYNC_SOURCES: ['directory', 'connections'],  // domain directory + My contacts ("Other contacts" is never read)
  SHOW_MOBILE: true,                    // set false to hide mobile numbers for everyone
  ADMINS: [                             // may export CSV + see the "hidden" records count
    'm.elmahdy@sr.edu.sa'
  ],

  // Shared logo source (one place for all ITOC platforms) — update to your shared URLs
  LOGOS: {
    SRU:  'https://ictsru.github.io/ITOC/assets/logos/sru.png',
    ICTD: 'https://ictsru.github.io/ITOC/assets/logos/ictd.png',
    ITOC: 'https://ictsru.github.io/ITOC/assets/logos/itoc.png'
  },
  ITOC_HUB_URL: 'https://ictsru.github.io/ITOC/#forms'
};

/* ------------------------------------------------------------------ */
/*  Web app entry                                                      */
/* ------------------------------------------------------------------ */

function doGet(e) {
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  const allowed = email.endsWith('@' + CONFIG.DOMAIN);
  const isAdmin = CONFIG.ADMINS.map(s => String(s).toLowerCase()).indexOf(email) > -1;

  // Admin actions from the browser — avoids running from the editor:
  //   …/exec?admin=diagnose   …/exec?admin=setup   …/exec?admin=refresh
  const action = e && e.parameter && e.parameter.admin;
  if (action) return adminPage_(action, email, isAdmin);

  const t = HtmlService.createTemplateFromFile(allowed ? 'Index' : 'Denied');
  t.cfg = CONFIG;
  t.userEmail = email;
  t.isAdmin = CONFIG.ADMINS.map(String).map(s => s.toLowerCase()).indexOf(email) > -1;

  return t.evaluate()
    .setTitle(CONFIG.APP_NAME_AR + ' | ' + CONFIG.APP_NAME_EN + ' v' + CONFIG.VERSION)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/* ------------------------------------------------------------------ */
/*  Client API (google.script.run)                                     */
/* ------------------------------------------------------------------ */

/** Returns the directory snapshot. Logs the sign-in once per page load. */
function getDirectory(logVisit) {
  const email = assertDomainUser_();
  if (logVisit) logSignIn_(email);

  let data = cacheGet_('DIR');
  if (!data) data = refreshDirectory();

  if (!CONFIG.SHOW_MOBILE) data.people.forEach(p => { p.mobile = ''; });
  return data;
}

/** Forces a rebuild (admins only, from the UI refresh button). */
function forceRefresh() {
  const email = assertDomainUser_();
  if (CONFIG.ADMINS.map(s => s.toLowerCase()).indexOf(email) === -1) {
    throw new Error('صلاحية التحديث متاحة للمشرفين فقط.');
  }
  return refreshDirectory();
}

/* ------------------------------------------------------------------ */
/*  Directory build                                                    */
/* ------------------------------------------------------------------ */

/**
 * Builds the directory snapshot from the "Directory" tab.
 * Unless skipSync is true and when AUTO_SYNC is on, it first syncs that tab
 * from the owner's Google account (domain directory + contacts).
 */
function refreshDirectory(skipSync) {
  let source = 'sheet';
  if (CONFIG.AUTO_SYNC && skipSync !== true) {
    try { const r = syncToSheet_(); source = 'account-sync'; console.log(r.summary); }
    catch (e) { console.warn('Account sync skipped: ' + e.message); }
  } else if (skipSync === true) {
    source = 'account-sync';
  }
  const people = readSheetDirectory_();

  const overrides = readOverrides_();
  let hidden = 0;
  const merged = [];
  people.forEach(p => {
    const o = overrides[p.email];
    if (o) {
      if (o.hidden) { hidden++; return; }
      ['extension', 'mobile', 'department', 'title', 'nameAr'].forEach(k => { if (o[k]) p[k] = o[k]; });
    }
    merged.push(p);
  });

  merged.sort((a, b) => a.name.localeCompare(b.name, 'ar'));

  const data = {
    version: CONFIG.VERSION,
    updatedAt: Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm'),
    total: merged.length,
    hidden: hidden,
    source: source,
    people: merged
  };
  // Never cache an empty directory — otherwise a fixed setting stays invisible for 6 hours
  if (data.total > 0) cachePut_('DIR', data); else CacheService.getScriptCache().remove('DIR_n');
  return data;
}

/* ------------------------------------------------------------------ */
/*  Sync from the owner's own Google account (no Admin console needed) */
/* ------------------------------------------------------------------ */

const PEOPLE_FIELDS_ = 'names,emailAddresses,phoneNumbers,organizations,photos';

/**
 * Calls the People API with the script owner's own permissions.
 * Uses the People advanced service when it is added; otherwise calls the
 * REST endpoint directly with the owner's OAuth token (no service needed).
 */
function peopleCall_(kind, params) {
  if (typeof People !== 'undefined') {
    if (kind === 'directory') return People.People.listDirectoryPeople(params);
    if (kind === 'connections') return People.People.Connections.list('people/me', params);
  }
  const base = 'https://people.googleapis.com/v1/';
  const path = { directory: 'people:listDirectoryPeople', connections: 'people/me/connections' }[kind];
  if (!path) throw new Error('Source not allowed: ' + kind);
  const qs = Object.keys(params).filter(k => params[k] != null).map(k =>
    [].concat(params[k]).map(v => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&')).join('&');
  const res = UrlFetchApp.fetch(base + path + '?' + qs, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true
  });
  const body = JSON.parse(res.getContentText() || '{}');
  if (res.getResponseCode() !== 200) {
    const msg = (body.error && body.error.message) || ('HTTP ' + res.getResponseCode());
    throw new Error(msg);
  }
  return body;
}

/** Reads every page of one source and returns mapped @sr.edu.sa records. */
function readSource_(kind) {
  const out = [];
  let pageToken = null, guard = 0;
  do {
    let params;
    if (kind === 'directory') params = { readMask: PEOPLE_FIELDS_, pageSize: 1000, pageToken: pageToken,
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE', 'DIRECTORY_SOURCE_TYPE_DOMAIN_CONTACT'] };
    else if (kind === 'connections') params = { personFields: PEOPLE_FIELDS_, pageSize: 1000, pageToken: pageToken };
    else throw new Error('Source not allowed: ' + kind);
    const res = peopleCall_(kind, params);
    const list = res.people || res.connections || [];
    list.forEach(p => {
      const rec = mapPerson_(p);
      if (rec.email && rec.email.endsWith('@' + CONFIG.DOMAIN)) { rec.src = kind; out.push(rec); }
    });
    pageToken = res.nextPageToken;
  } while (pageToken && ++guard < 100);
  return out;
}

/**
 * Pulls the domain directory + "My contacts" (@sr.edu.sa only) from the
 * owner's account, merges them by e-mail and writes the "Directory" tab.
 * Existing rows are kept; synced values fill or update them; blanks never
 * erase a value already in the sheet.
 */
function syncToSheet_() {
  const report = [], byEmail = {};
  const LABEL = { directory: 'دليل النطاق', connections: 'جهات اتصالي' };
  CONFIG.SYNC_SOURCES.filter(k => LABEL[k]).forEach(kind => {
    try {
      const recs = readSource_(kind);
      report.push('✅ ' + LABEL[kind] + ': ' + recs.length);
      recs.forEach(r => {
        const cur = byEmail[r.email] || (byEmail[r.email] = { email: r.email, src: [] });
        ['name', 'mobile', 'extension', 'department', 'title', 'photo'].forEach(k => { if (!cur[k] && r[k]) cur[k] = r[k]; });
        if (cur.src.indexOf(kind) < 0) cur.src.push(kind);
      });
    } catch (e) {
      report.push('❌ ' + LABEL[kind] + ': ' + e.message);
    }
  });

  const synced = Object.keys(byEmail).length;
  if (!synced) throw new Error('لم تُجلب أي سجلات من الحساب.\n' + report.join('\n'));

  // Merge with what is already in the sheet (manual rows are preserved)
  const sh = getSheet_().getSheetByName('Directory') || getSheet_().insertSheet('Directory');
  const HEAD = ['Name (الاسم)', 'Email (البريد)', 'Mobile (الجوال)', 'Extension (التحويلة)',
                'Department (الإدارة)', 'Title (المسمى)', 'Photo', 'Source (المصدر)', 'Synced At'];
  const existing = {};
  readSheetDirectory_().forEach(p => {
    if (String(p.src || '').trim() === 'other') return;   // remove rows imported from "Other contacts" by v1.8
    existing[p.email] = p;
  });
  const now = Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd HH:mm');
  const emails = Object.keys(Object.assign({}, existing, byEmail)).sort();
  const rows = emails.map(e => {
    const s = byEmail[e] || {}, x = existing[e] || {};
    const pick = k => s[k] || x[k] || '';
    return [pick('name') || e, e, pick('mobile'), pick('extension'), pick('department'), pick('title'),
            pick('photo'), s.src ? s.src.join(', ') : 'manual', s.src ? now : (x.syncedAt || '')];
  });

  sh.clearContents();
  sh.getRange(1, 1, 1, HEAD.length).setValues([HEAD]).setFontWeight('bold').setBackground('#501e8c').setFontColor('#ffffff');
  sh.getRange(2, 1, rows.length, HEAD.length).setNumberFormat('@').setValues(rows);
  sh.setFrozenRows(1);

  report.push('— الإجمالي في ورقة Directory: ' + rows.length + ' (جديد/محدَّث من الحساب: ' + synced + ')');
  return { summary: report.join('\n'), total: rows.length, at: now };
}

/** UI button «مزامنة من حسابي» (admins only). Returns the report + fresh directory. */
function syncFromMyAccount() {
  const email = assertDomainUser_();
  if (CONFIG.ADMINS.map(s => s.toLowerCase()).indexOf(email) === -1) {
    throw new Error('المزامنة متاحة للمشرفين فقط.');
  }
  const r = syncToSheet_();
  const data = refreshDirectory(true);
  data.syncReport = r.summary;
  return data;
}

/**
 * Source 2 — "Directory" tab. Columns are matched by header name, so a raw
 * Google Admin user export (First Name, Last Name, Email Address, Mobile Phone,
 * Work Phone, Department, Employee Title …) can be pasted as-is.
 */
function readSheetDirectory_() {
  const sh = getSheet_().getSheetByName('Directory');
  if (!sh || sh.getLastRow() < 2) return [];
  const rows = sh.getDataRange().getDisplayValues();
  const head = rows.shift().map(h => String(h).toLowerCase());
  const col = (...keys) => head.findIndex(h => keys.some(k => h.indexOf(k) > -1));
  const c = {
    name: (i => i > -1 ? i : head.findIndex(h => h.trim() === 'name'))(col('full name', 'name (', 'الاسم')),
    first: col('first name'), last: col('last name'),
    email: col('email', 'البريد'),
    mobile: col('mobile', 'الجوال'),
    ext: col('extension', 'التحويلة', 'work phone', 'الهاتف الداخلي'),
    dept: col('department', 'الإدارة'),
    title: col('title', 'المسمى'),
    photo: col('photo'), synced: col('synced at'), src: col('source')
  };
  const v = (r, i) => (i > -1 ? String(r[i] || '').trim() : '');
  return rows.map(r => {
    const email = v(r, c.email).toLowerCase();
    const name = v(r, c.name) || [v(r, c.first), v(r, c.last)].filter(Boolean).join(' ');
    let ext = v(r, c.ext);
    const m = ext.match(/(?:ext\.?|x|تحويلة)\s*(\d{2,6})\s*$/i);
    if (m) ext = m[1];
    return { name: name || email, nameAr: '', email: email, mobile: v(r, c.mobile), extension: ext,
             workPhone: '', department: v(r, c.dept), title: v(r, c.title), photo: v(r, c.photo),
             syncedAt: v(r, c.synced), src: v(r, c.src) };
  }).filter(p => p.email && p.email.endsWith('@' + CONFIG.DOMAIN));
}

/** Smallest possible test: if this fails too, the problem is the account/project, not the code. */
function ping() {
  console.log('pong — ' + new Date() + ' — v' + CONFIG.VERSION);
}

function mapPerson_(p) {
  const name = (p.names && p.names[0] && p.names[0].displayName) || '';
  const mails = (p.emailAddresses || []).map(e => String(e.value || '').trim());
  const email = mails.find(m => m.toLowerCase().endsWith('@' + CONFIG.DOMAIN)) || '';   // university address only
  const org = (p.organizations || [])[0] || {};
  const photo = (p.photos || []).find(ph => !ph.default);

  let mobile = '', extension = '', work = '';
  (p.phoneNumbers || []).forEach(ph => {
    const type = String(ph.type || '').toLowerCase();
    const raw = String(ph.value || '').trim();
    const digits = raw.replace(/\D/g, '');
    const extMatch = raw.match(/(?:ext\.?|x|تحويلة)\s*(\d{2,6})\s*$/i);

    if (extMatch && !extension) extension = extMatch[1];
    else if (digits.length && digits.length <= CONFIG.EXTENSION_MAX_DIGITS && !extension) extension = digits;
    else if (CONFIG.MOBILE_TYPES.indexOf(type) > -1 && !mobile) mobile = raw;
    else if (CONFIG.EXTENSION_TYPES.indexOf(type) > -1 && !work) work = raw;
    else if (!mobile && /^(\+?966|0)?5\d{8}$/.test(digits)) mobile = raw;  // Saudi mobile pattern
  });

  return {
    name: name,
    nameAr: '',
    email: email.toLowerCase(),
    mobile: mobile,
    extension: extension || '',
    workPhone: work,
    department: org.department || '',
    title: org.title || '',
    photo: photo ? photo.url : ''
  };
}

/* ------------------------------------------------------------------ */
/*  Sheet: SignInLog + Overrides                                       */
/* ------------------------------------------------------------------ */

function getSheet_() {
  const id = CONFIG.SHEET_ID || PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('شغّل الدالة setup() مرة واحدة لإنشاء ورقة السجل.');
  return SpreadsheetApp.openById(id);
}

function logSignIn_(email) {
  try {
    const now = new Date();
    getSheet_().getSheetByName('SignInLog').appendRow([
      email,
      Utilities.formatDate(now, CONFIG.TIMEZONE, 'yyyy-MM-dd'),
      Utilities.formatDate(now, CONFIG.TIMEZONE, 'HH:mm:ss'),
      CONFIG.VERSION
    ]);
  } catch (e) { console.error('SignIn log failed: ' + e); }
}

/** Overrides tab columns: Email | NameAr | Extension | Mobile | Department | Title | Hidden */
function readOverrides_() {
  const map = {};
  try {
    const sh = getSheet_().getSheetByName('Overrides');
    const rows = sh.getDataRange().getDisplayValues().slice(1);
    rows.forEach(r => {
      const email = String(r[0] || '').trim().toLowerCase();
      if (!email) return;
      map[email] = {
        nameAr: r[1], extension: r[2], mobile: r[3], department: r[4], title: r[5],
        hidden: /^(true|yes|نعم|1)$/i.test(String(r[6] || '').trim())
      };
    });
  } catch (e) { console.warn('Overrides not read: ' + e); }
  return map;
}

/* ------------------------------------------------------------------ */
/*  One-time setup + automation                                        */
/* ------------------------------------------------------------------ */

/** Run once from the editor: creates the log sheet, the hourly refresh trigger, and a first snapshot. */
function setup() {
  const props = PropertiesService.getScriptProperties();
  let id = CONFIG.SHEET_ID || props.getProperty('SHEET_ID');
  if (!id) {
    const ss = SpreadsheetApp.create('SRU Contact Directory — Log & Overrides');
    id = ss.getId();
    props.setProperty('SHEET_ID', id);
  }
  const ss = SpreadsheetApp.openById(id);
  ensureTab_(ss, 'SignInLog', ['Email', 'Date', 'Time', 'App Version']);
  ensureTab_(ss, 'Directory', ['Name (الاسم)', 'Email (البريد)', 'Mobile (الجوال)', 'Extension (التحويلة)',
                               'Department (الإدارة)', 'Title (المسمى)', 'Photo', 'Source (المصدر)', 'Synced At']);
  ensureTab_(ss, 'Overrides', ['Email', 'NameAr (الاسم بالعربي)', 'Extension (التحويلة)',
                               'Mobile (الجوال)', 'Department (الإدارة)', 'Title (المسمى)', 'Hidden (إخفاء)']);
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ورقة1');
  if (def && ss.getSheets().length > 2) ss.deleteSheet(def);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'refreshDirectory')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshDirectory').timeBased().everyHours(CONFIG.REFRESH_EVERY_HOURS).create();

  const data = refreshDirectory();
  const msg = 'Setup done. Source: ' + data.source + ' | records: ' + data.total + ' | Sheet: ' + ss.getUrl();
  console.log(msg);
  return msg;
}

/**
 * Run from the editor when setup() fails with an unclear error.
 * Tests each dependency on its own and logs ✅ / ❌ with the fix.
 */
function diagnose() {
  const out = [];
  const step = (name, fn, fix) => {
    let line;
    try { line = '✅ ' + name + ' — ' + (fn() || 'OK'); console.log(line); out.push(line); return true; }
    catch (e) { line = '❌ ' + name + ' — ' + e.message + (fix ? '\n   → ' + fix : ''); console.error(line); out.push(line); return false; }
  };

  step('1. Signed-in account', () => {
    const me = Session.getActiveUser().getEmail() || Session.getEffectiveUser().getEmail();
    if (!me) throw new Error('No account e-mail returned');
    if (!me.toLowerCase().endsWith('@' + CONFIG.DOMAIN)) throw new Error('Running as ' + me);
    return me;
  }, 'Open script.google.com in an incognito window signed in ONLY with your @' + CONFIG.DOMAIN + ' account.');

  step('2. Backend sheet access', () => {
    const ss = SpreadsheetApp.openById(CONFIG.SHEET_ID || PropertiesService.getScriptProperties().getProperty('SHEET_ID'));
    return ss.getName() + ' | tabs: ' + ss.getSheets().map(s => s.getName()).join(', ');
  }, 'Check SHEET_ID in CONFIG and that this account can edit the sheet.');

  step('3. Domain directory (your account)', () => readSource_('directory').length + ' @' + CONFIG.DOMAIN + ' record(s)',
    'If 0: the domain directory is hidden for your account (Contact sharing). My contacts below still work.');

  step('4. My contacts (@' + CONFIG.DOMAIN + ' only)', () => readSource_('connections').length + ' record(s)',
    'Redeploy (Manage deployments → New version) and approve the Contacts permissions.');

  step('5. Triggers permission', () => {
    return ScriptApp.getProjectTriggers().length + ' trigger(s) currently installed';
  }, 'Run again and approve all permissions (scope: script.scriptapp).');

  step('6. Cache service', () => {
    cachePut_('DIAG', { t: Date.now() });
    if (!cacheGet_('DIAG')) throw new Error('Cache read-back failed');
    return 'write/read OK';
  });

  step('7. Directory sheet fallback', () => readSheetDirectory_().length + ' record(s) in the "Directory" tab',
    'Paste staff rows (or a Google Admin user export) into the "Directory" tab.');

  out.push('Diagnostics finished — version ' + CONFIG.VERSION);
  console.log(out[out.length - 1]);
  return out.join('\n');
}

/** Renders the result of an admin action as a simple branded page (admins only). */
function adminPage_(action, email, isAdmin) {
  let title, body;
  if (!isAdmin) {
    title = 'غير مصرّح';
    body = 'هذه الإجراءات متاحة لمشرفي الدليل فقط.\nالحساب: ' + email;
  } else {
    title = 'Admin · ' + action;
    try {
      if (action === 'diagnose') body = diagnose();
      else if (action === 'setup') body = setup();
      else if (action === 'refresh') { const d = refreshDirectory(); body = 'Refreshed. Source: ' + d.source + ' | records: ' + d.total; }
      else if (action === 'sync') { const r = syncToSheet_(); const d = refreshDirectory(true); body = r.summary + '\n\nRecords now shown: ' + d.total; }
      else body = 'Unknown action. Use: sync | diagnose | setup | refresh';
    } catch (err) {
      body = '❌ ' + err.message + '\n\n' + (err.stack || '');
    }
  }
  const esc = t => String(t).replace(/[&<>]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;'}[c]));
  const html = '<!DOCTYPE html><html dir="ltr"><head><meta charset="utf-8">' +
    '<style>body{font-family:Cairo,Tahoma,Arial,sans-serif;background:#f7f5fb;margin:0;padding:24px;color:#241436}' +
    '.box{max-width:900px;margin:auto;background:#fff;border:1px solid rgba(80,30,140,.12);border-top:4px solid #501e8c;border-radius:4px;padding:20px}' +
    'h2{color:#501e8c;margin:0 0 12px}pre{white-space:pre-wrap;font-size:14px;line-height:1.8;background:#f0ebf8;padding:14px;border-radius:4px}' +
    'a{color:#0a6eaa}</style></head><body><div class="box"><h2>' + esc(title) + '</h2><pre>' + esc(body) + '</pre>' +
    '<p>' + ['sync', 'diagnose', 'setup', 'refresh'].map(a => '<a href="?admin=' + a + '">' + a + '</a>').join(' · ') +
    ' · <a href="?">فتح الدليل</a> — v' + CONFIG.VERSION + '</p></div></body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('Contact Directory · ' + action);
}

function ensureTab_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.appendRow(headers);
    sh.getRange(1, 1, 1, headers.length).setFontWeight('bold').setBackground('#501e8c').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.setRightToLeft(true);
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function assertDomainUser_() {
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (!email.endsWith('@' + CONFIG.DOMAIN)) throw new Error('الدخول مقصور على حسابات ' + CONFIG.DOMAIN);
  return email;
}

/** CacheService allows 100 KB per key — store the snapshot in chunks. */
function cachePut_(key, obj) {
  const cache = CacheService.getScriptCache();
  const json = JSON.stringify(obj);
  const size = 90000, parts = {};
  const n = Math.ceil(json.length / size);
  for (let i = 0; i < n; i++) parts[key + '_' + i] = json.slice(i * size, (i + 1) * size);
  parts[key + '_n'] = String(n);
  cache.putAll(parts, CONFIG.CACHE_SECONDS);
}

function cacheGet_(key) {
  const cache = CacheService.getScriptCache();
  const n = Number(cache.get(key + '_n') || 0);
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(key + '_' + i);
  const got = cache.getAll(keys);
  let json = '';
  for (let i = 0; i < n; i++) { if (!got[keys[i]]) return null; json += got[keys[i]]; }
  try { return JSON.parse(json); } catch (e) { return null; }
}
