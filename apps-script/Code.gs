/**
 * ============================================================
 *  دليل الاتصال — SRU Contact Directory
 *  Sulaiman Al Rajhi University · ICTD · ITOC
 *  Version : 1.3
 *  Backend : Google Apps Script (Web App) + People API (Directory)
 * ============================================================
 *  Data source : Google Workspace directory of sr.edu.sa
 *                (People API → listDirectoryPeople, DOMAIN_PROFILE)
 *  Access      : @sr.edu.sa accounts only (deployment + server check)
 *  Logging     : every sign-in → Google Sheet tab "SignInLog"
 *  Overrides   : optional sheet tab "Overrides" to add/correct
 *                extension, mobile, department, title, or hide a record
 * ============================================================
 */

const CONFIG = {
  VERSION: '1.3',
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

  SHOW_MOBILE: true,                    // set false to hide mobile numbers for everyone
  ADMINS: [                             // may export CSV + see the "hidden" records count
    // 'm.elmahdy@sr.edu.sa'
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

function doGet() {
  const email = (Session.getActiveUser().getEmail() || '').toLowerCase();
  const allowed = email.endsWith('@' + CONFIG.DOMAIN);

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

/** Reads the whole sr.edu.sa directory, merges overrides, caches the result. */
function refreshDirectory() {
  const people = [];
  let pageToken = null;

  do {
    const res = People.People.listDirectoryPeople({
      readMask: 'names,emailAddresses,phoneNumbers,organizations,photos',
      sources: ['DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE'],
      pageSize: 1000,
      pageToken: pageToken
    });
    (res.people || []).forEach(p => {
      const rec = mapPerson_(p);
      if (rec.email && rec.email.endsWith('@' + CONFIG.DOMAIN)) people.push(rec);
    });
    pageToken = res.nextPageToken;
  } while (pageToken);

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
    people: merged
  };
  cachePut_('DIR', data);
  return data;
}

function mapPerson_(p) {
  const name = (p.names && p.names[0] && p.names[0].displayName) || '';
  const email = ((p.emailAddresses || []).find(e => e.metadata && e.metadata.primary) ||
                 (p.emailAddresses || [])[0] || {}).value || '';
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
  ensureTab_(ss, 'Overrides', ['Email', 'NameAr (الاسم بالعربي)', 'Extension (التحويلة)',
                               'Mobile (الجوال)', 'Department (الإدارة)', 'Title (المسمى)', 'Hidden (إخفاء)']);
  const def = ss.getSheetByName('Sheet1') || ss.getSheetByName('ورقة1');
  if (def && ss.getSheets().length > 2) ss.deleteSheet(def);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'refreshDirectory')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refreshDirectory').timeBased().everyHours(CONFIG.REFRESH_EVERY_HOURS).create();

  const data = refreshDirectory();
  console.log('Setup done. Sheet: ' + ss.getUrl() + ' | records: ' + data.total);
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
  for (let i = 0; i < n; i++) parts[key + '_' + i] = json.substr(i * size, size);
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
