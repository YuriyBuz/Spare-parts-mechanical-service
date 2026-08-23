/**
 * Common.gs — спільні помічники для чек-листа механіків.
 *
 * Прив'язаний скрипт до таблиці check-list-mechanic.
 * Аркуш «Лист1» ніколи не змінюється — тільки читається під час міграції.
 */

var TZ = 'Europe/Kyiv';

var SH = {
  ITEMS:     '01_Пункти',
  OPTIONS:   '02_Варіанти',
  EMPLOYEES: '03_Працівники',
  REPORTS:   '11_Звіти',
  ANSWERS:   '12_Відповіді',
  PHOTOS:    '13_Фото',
  EVENTS:    '14_Журнал_подій',
  SCHEDULE:  '21_Розклад',
  DASH:      '22_Дашборд',
  LEGACY:    'Лист1'
};

/** Статуси відповіді, від найкращого до найгіршого. */
var STATUS_RANK = { ok: 0, empty: 1, unknown: 2, warn: 3, alert: 4 };

function ss() {
  return SpreadsheetApp.getActive();
}

/** Аркуш за іменем. Ніколи не getActiveSheet(). */
function sheetByName(name, optional) {
  var s = ss().getSheetByName(name);
  if (!s && !optional) {
    throw new Error('Немає аркуша «' + name + '». Спочатку запустіть setupSchema().');
  }
  return s;
}

/**
 * Виконує fn під блокуванням скрипта. Результат tryLock ПЕРЕВІРЯЄТЬСЯ —
 * без цього два одночасні виклики роблять read-modify-write наосліп.
 */
function withLock(fn, waitMs) {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(waitMs || 30000)) {
    return { ok: false, retryable: true, error: 'busy' };
  }
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function nowIsoUtc() {
  return Utilities.formatDate(new Date(), 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/** Робоча дата в Europe/Kyiv, а не в UTC. */
function businessDate(d) {
  return Utilities.formatDate(d || new Date(), TZ, 'yyyy-MM-dd');
}

function localTime(d) {
  return Utilities.formatDate(d || new Date(), TZ, 'HH:mm:ss');
}

function hash6(str) {
  var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, String(str), Utilities.Charset.UTF_8);
  var hex = '';
  for (var i = 0; i < 3; i++) {
    hex += ('0' + (bytes[i] & 0xff).toString(16)).slice(-2);
  }
  return hex;
}

/** Детермінований id звіту: той самий вхід завжди дає той самий id. */
function makeReportId(businessDateStr, role, stage, seedStr) {
  var r = role === 'Майстер' ? 'master' : 'mech';
  var s = stage && stage.indexOf('Кінець') === 0 ? 'end' : 'start';
  return businessDateStr + '_' + r + '_' + s + '_' + hash6(seedStr);
}

/** Читає аркуш у { header:[], rows:[[]], col:{назва:індекс} }. */
function readTable(name) {
  var s = sheetByName(name);
  var values = s.getDataRange().getValues();
  var header = values.length ? values[0] : [];
  var col = {};
  for (var i = 0; i < header.length; i++) col[String(header[i]).trim()] = i;
  return { sheet: s, header: header, rows: values.slice(1), col: col };
}

/** Дописує рядки пачкою. Порожній масив — no-op. */
function appendRows(name, rows) {
  if (!rows || !rows.length) return 0;
  var s = sheetByName(name);
  var width = s.getLastColumn();
  var padded = rows.map(function (r) {
    var out = r.slice(0, width);
    while (out.length < width) out.push('');
    return out;
  });
  s.getRange(s.getLastRow() + 1, 1, padded.length, width).setValues(padded);
  return padded.length;
}

function logEvent(type, event, details, ctx) {
  ctx = ctx || {};
  try {
    appendRows(SH.EVENTS, [[
      nowIsoUtc(), type, event, ctx.report_id || '', ctx.user_id || '',
      typeof details === 'string' ? details : JSON.stringify(details),
      ctx.app_version || ''
    ]]);
  } catch (e) {
    // журнал подій ніколи не має ламати основну операцію
  }
}

function jsonOut(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/** Число з тексту: приймає кому як роздільник, повертає null якщо не число. */
function toNumber(x) {
  if (x === null || x === undefined) return null;
  var s = String(x).trim().replace(',', '.').replace(/\s+/g, '');
  if (s === '' || s === '-' || s === '—') return null;
  var n = Number(s);
  return isFinite(n) ? n : null;
}

function worstStatus(list) {
  var out = 'ok';
  for (var i = 0; i < list.length; i++) {
    if (STATUS_RANK[list[i]] > STATUS_RANK[out]) out = list[i];
  }
  return out;
}

/* --- Спільні для Migrate.gs і Code.gs. Живуть тут, щоб бекенд не залежав
   від файлу міграції: його можна видалити після переносу даних. --- */

function existingReportIds_() {
  var t = readTable(SH.REPORTS);
  var set = {};
  t.rows.forEach(function (r) { if (r[0]) set[r[0]] = true; });
  return set;
}

/** Індекси довідників: текст пункту → item_id, ПІБ → user_id, (item,value) → статус. */
function loadDictionaries_() {
  var it = readTable(SH.ITEMS);
  var byText = {}, byId = {};
  it.rows.forEach(function (r) {
    if (!r[it.col.item_id]) return;
    var item = {};
    it.header.forEach(function (h, i) { item[h] = r[i]; });
    byId[item.item_id] = item;
    var keys = [item.text].concat(String(item.text_aliases || '').split(';'));
    keys.forEach(function (k) {
      k = String(k).trim();
      if (k) byText[item.role + '|' + k] = item.item_id;
    });
  });

  var op = readTable(SH.OPTIONS);
  var optStatus = {};
  op.rows.forEach(function (r) {
    if (r[0]) optStatus[r[0] + '|' + String(r[2]).trim()] = String(r[3] || '').trim();
  });

  var em = readTable(SH.EMPLOYEES);
  var byName = {}, byIdUser = {};
  em.rows.forEach(function (r) {
    if (!r[0]) return;
    byIdUser[r[0]] = r[1];
    var keys = [r[1]].concat(String(r[4] || '').split(';'));
    keys.forEach(function (k) {
      k = String(k).trim();
      if (k) byName[k] = r[0];
    });
  });

  return { byText: byText, byId: byId, optStatus: optStatus, byName: byName, byIdUser: byIdUser };
}

function num_(arr, i) {
  return arr.length > i && arr[i] !== null ? arr[i] : '';
}

function numberStatus_(item, field, v) {
  var nmin = toNumber(item['norm_min_' + field]);
  var nmax = toNumber(item['norm_max_' + field]);
  if (nmin === null && nmax === null) return 'ok';        // норму не задано — не сигналимо
  if ((nmin !== null && v < nmin) || (nmax !== null && v > nmax)) return 'alert';
  var wmin = toNumber(item['warn_min_' + field]);
  var wmax = toNumber(item['warn_max_' + field]);
  if ((wmin !== null && v < wmin) || (wmax !== null && v > wmax)) return 'warn';
  return 'ok';
}
