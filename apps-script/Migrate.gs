/**
 * Migrate.gs — одноразова міграція «Лист1» у структуру 11/12/13.
 *
 * «Лист1» ТІЛЬКИ ЧИТАЄТЬСЯ. Жодного запису, перейменування чи сортування.
 *
 * Порядок: setupSchema() → seedDictionaries() → migrateLegacy() → verifyMigration()
 *
 * Ідемпотентність: report_id детермінований, уже перенесені звіти пропускаються.
 * Тому migrateLegacy() можна запускати повторно — зокрема якщо впав ліміт часу.
 */

var ICON_STATUS = { '✅': 'ok', '❗ ❌': 'alert', '❌': 'empty' };

/**
 * mech.3-4 історично був вільним текстом: 8+ написань одного й того самого.
 * Зводимо до двох варіантів. Якщо впевнено звести не можна — повертаємо null,
 * відповідь дістає статус «unknown». Вигадувати аварію з незрозумілого тексту
 * гірше, ніж чесно сказати «не розпізнано».
 */
var NO_ERROR_RE = /(нема|немає|нет|відс|отс|норма|^ок$|^ok$|без помил|не ошиб|помилки відсут|помилок нема|^так$|^не$)/;

function normalizeFreeText_(itemId, text) {
  if (itemId !== 'mech.3-4') return text;
  var s = String(text).toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (NO_ERROR_RE.test(s)) return 'Помилок немає';
  if (/^\d+$/.test(s)) return 'Є помилка';
  return null;
}

function migrateLegacy() {
  var legacy = sheetByName(SH.LEGACY);
  var data = legacy.getDataRange().getValues();
  var dict = loadDictionaries_();
  var done = existingReportIds_();

  var reports = [], answers = [], photos = [];
  var skipped = 0, failed = 0;

  for (var i = 0; i < data.length; i++) {
    var row = data[i];
    var blob = String(row[6] || '');
    if (blob.indexOf('Чек-лист') === -1) continue;   // не рядок звіту

    var parsed;
    try {
      parsed = parseLegacyRow_(row, i + 1, dict);
    } catch (e) {
      failed++;
      logEvent('Міграція', 'parse.error', 'рядок ' + (i + 1) + ': ' + e, {});
      continue;
    }
    if (done[parsed.report[0]]) { skipped++; continue; }
    done[parsed.report[0]] = true;

    reports.push(parsed.report);
    answers = answers.concat(parsed.answers);
    photos = photos.concat(parsed.photos);
  }

  appendRows(SH.REPORTS, reports);
  appendRows(SH.ANSWERS, answers);
  appendRows(SH.PHOTOS, photos);

  var msg = 'Перенесено звітів: ' + reports.length + ', відповідей: ' + answers.length +
            ', фото: ' + photos.length + '. Пропущено (вже є): ' + skipped +
            '. Не розпарсено: ' + failed + '.';
  logEvent('Міграція', 'migrateLegacy', msg);
  return msg;
}

function parseLegacyRow_(row, rawRow, dict) {
  var blob = String(row[6]);
  var lines = blob.split('\n');

  var stage = String(row[4] || '').trim();
  var who = String(row[3] || '').trim();
  var role = 'Механік';
  var dateStr = '';

  for (var i = 0; i < lines.length && i < 8; i++) {
    var L = lines[i];
    if (L.indexOf('Чек-лист:') > -1 && !stage) stage = L.split('Чек-лист:')[1].trim();
    var m = L.match(/(Механік|Майстер):\s*(.+)$/);
    if (m) { role = m[1]; if (!who) who = m[2].trim(); }
    var d = L.match(/Дата:\s*(\d{2})\.(\d{2})\.(\d{4})/);
    if (d) dateStr = d[3] + '-' + d[2] + '-' + d[1];
  }
  if (!dateStr) dateStr = legacyDate_(row[1]) || legacyDate_(row[0]) || '';

  var tsServer = toIso_(row[0]);
  var reportId = makeReportId(dateStr, role, stage, tsServer + '|' + who + '|' + stage);

  // --- відповіді ---
  var answers = [], photoLines = [];
  var seq = 0, last = null;
  var cnt = { ok: 0, warn: 0, alert: 0, empty: 0, unknown: 0 };

  for (var j = 0; j < lines.length; j++) {
    var line = lines[j];
    var t = line.replace(/^\s+/, '');

    if (t.indexOf('🔗') === 0) { photoLines.push(t.substring(1).trim()); continue; }
    if (t.indexOf('💬 Коментар:') === 0 && last) {
      last[15] = t.split('Коментар:')[1].trim();
      continue;
    }

    var icon = null;
    if (t.indexOf('❗ ❌ | ') === 0) icon = '❗ ❌';
    else if (t.indexOf('✅ | ') === 0) icon = '✅';
    else if (t.indexOf('❌ | ') === 0) icon = '❌';
    if (!icon) continue;

    var rest = t.substring(t.indexOf('| ') + 2).trim();
    rest = rest.replace(/\s*\[НЕ НОРМА\]\s*$/, '');
    var value = '';
    var vm = rest.match(/\s\[([^\]]*)\]\s*$/);
    if (vm) { value = vm[1]; rest = rest.substring(0, vm.index).trim(); }
    if (!rest || rest.indexOf('Фото:') === 0) continue;

    seq++;
    var itemId = dict.byText[role + '|' + rest] || '';
    var item = dict.byId[itemId];
    var norm = normalizeValue_(item, itemId, value);
    var statusOrig = ICON_STATUS[icon];
    var status = statusOrig === 'empty'
      ? 'empty'
      : computeStatus_(item, itemId, norm, dict, statusOrig);
    cnt[status] = (cnt[status] || 0) + 1;

    last = [
      reportId + '#' + seq, reportId, dateStr, stage, role, dict.byName[who] || 'U-000',
      itemId, rest, seq,
      norm.text, num_(norm.nums, 0), num_(norm.nums, 1), num_(norm.nums, 2),
      status, statusOrig, '', ''
    ];
    answers.push(last);
  }

  // --- фото ---
  var photos = [], saved = 0, lost = 0;
  var byText = {};
  answers.forEach(function (a) { byText[a[7]] = a; });

  photoLines.forEach(function (pl, k) {
    var pid = reportId + '#p' + (k + 1);
    var httpAt = pl.indexOf('https://');
    if (httpAt > -1) {
      var url = pl.substring(httpAt).trim();
      var label = pl.substring(0, httpAt).replace(/:\s*$/, '').trim();
      var fid = (url.match(/\/d\/([^\/]+)/) || [])[1] || '';
      var a = byText[label];
      if (a) a[16] = url;
      photos.push([pid, reportId, a ? a[6] : '', url, fid, 'saved', '']);
      saved++;
    } else if (pl.indexOf('Помилка') > -1) {
      photos.push([pid, reportId, '', '', '', 'failed', pl]);
      lost++;
    }
  });

  var total = totalFromSummary_(row[5], seq);
  return {
    report: [
      reportId, tsServer, dateStr, stage, role, dict.byName[who] || 'U-000', who,
      configVersion_(role, total), total,
      cnt.ok, cnt.warn, cnt.alert, cnt.empty,
      saved, lost, 'migrated', rawRow, ''
    ],
    answers: answers,
    photos: photos
  };
}

/**
 * Приводить історичне значення до цільового типу пункту.
 * Оригінал ЗАВЖДИ зберігається у value_text — нічого не втрачається.
 */
function normalizeValue_(item, itemId, raw) {
  var text = String(raw === null || raw === undefined ? '' : raw).trim();
  var nums = [];
  if (!item) return { text: text, nums: nums };

  if (item.type === 'number') {
    if (text.indexOf(':') > -1) {
      // формат dual_input: «№1: 55 / №2: 89»
      text.split('/').forEach(function (part) {
        if (part.indexOf(':') > -1) nums.push(toNumber(part.split(':')[1]));
      });
    } else {
      // вільний текст: «-3,-2,-2» або «-3/-2/-1»
      text.split(/[,;/]/).forEach(function (p) { nums.push(toNumber(p)); });
    }
    nums = nums.filter(function (n) { return n !== null; }).slice(0, 3);
  } else if (item.type === 'binary') {
    var mapped = normalizeFreeText_(itemId, text);
    if (mapped === null) return { text: text, nums: nums, unmapped: true };
    text = mapped;
  }
  return { text: text, nums: nums };
}

/** Статус за поточними правилами: довідник варіантів або діапазон норм. */
function computeStatus_(item, itemId, norm, dict, fallback) {
  if (!item) return fallback === 'alert' ? 'alert' : 'unknown';

  if (item.type === 'binary') {
    if (norm.unmapped) return 'unknown';
    var st = dict.optStatus[itemId + '|' + String(norm.text).trim()];
    return st || (norm.text ? 'unknown' : 'empty');
  }

  if (item.type === 'number') {
    if (!norm.nums.length) return norm.text ? 'unknown' : 'empty';
    var out = [];
    for (var f = 0; f < norm.nums.length && f < 3; f++) {
      out.push(numberStatus_(item, f + 1, norm.nums[f]));
    }
    return worstStatus(out);
  }

  return norm.text ? 'ok' : 'empty';
}

function totalFromSummary_(summary, fallback) {
  var m = String(summary || '').match(/з\s+(\d+)/);
  return m ? Number(m[1]) : fallback;
}

function configVersion_(role, total) {
  if (role === 'Майстер') return 'master-v1';
  if (total === 37) return 'mech-v1';
  if (total === 35) return 'mech-v2';
  if (total === 38 || total === 39) return 'mech-v3';
  return 'mech-v' + total;
}

function legacyDate_(v) {
  if (v instanceof Date) return businessDate(v);
  var m = String(v || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  return m ? m[3] + '-' + m[2] + '-' + m[1] : '';
}

function toIso_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
  var m = String(v || '').match(/(\d{2})\.(\d{2})\.(\d{4})[ ,]+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return String(v || '');
  var d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
  return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm:ss'Z'");
}

/**
 * Звірка після міграції. Рахує вихідні дані просто по «Лист1» і порівнює
 * з тим, що лягло в нову структуру. Розбіжність = міграція не зарахована.
 */
function verifyMigration() {
  var data = sheetByName(SH.LEGACY).getDataRange().getValues();
  var src = { reports: 0, answers: 0, ok: 0, alert: 0, empty: 0, photos: 0 };
  data.forEach(function (row) {
    var b = String(row[6] || '');
    if (b.indexOf('Чек-лист') === -1) return;
    src.reports++;
    src.alert += (b.match(/❗ ❌ \| /g) || []).length;
    src.ok += (b.match(/✅ \| /g) || []).length;
    src.empty += (b.match(/(^|\n)\s*❌ \| /g) || []).length;
    src.photos += (b.match(/🔗/g) || []).length;
  });
  src.answers = src.ok + src.alert + src.empty;

  var rep = readTable(SH.REPORTS), ans = readTable(SH.ANSWERS), pho = readTable(SH.PHOTOS);
  var got = {
    reports: rep.rows.filter(function (r) { return r[0]; }).length,
    answers: ans.rows.filter(function (r) { return r[0]; }).length,
    photos: pho.rows.filter(function (r) { return r[0]; }).length,
    ok: 0, alert: 0, empty: 0
  };
  ans.rows.forEach(function (r) {
    var s = r[ans.col.status_original];
    if (got[s] !== undefined) got[s]++;
  });

  var lines = [], allOk = true;
  ['reports', 'answers', 'ok', 'alert', 'empty', 'photos'].forEach(function (k) {
    var same = src[k] === got[k];
    if (!same) allOk = false;
    lines.push((same ? '✅' : '❌') + ' ' + k + ': у Лист1 ' + src[k] + ', перенесено ' + got[k]);
  });
  var msg = (allOk ? 'ЗВІРКА ПРОЙДЕНА\n' : 'Є РОЗБІЖНОСТІ\n') + lines.join('\n');
  logEvent('Міграція', 'verifyMigration', msg);
  return msg;
}

/**
 * Перепризначає user_id у вже мігрованих рядках після правки 03_Працівники.
 * Знадобиться, коли з'ясується, кого записували як «Заміна».
 */
function relinkUsers() {
  var dict = loadDictionaries_();
  var rep = readTable(SH.REPORTS);
  var changed = 0;
  var col = rep.col;
  rep.rows.forEach(function (r, i) {
    if (!r[0]) return;
    var uid = dict.byName[String(r[col.user_name_snapshot]).trim()];
    if (uid && uid !== r[col.user_id]) {
      rep.sheet.getRange(i + 2, col.user_id + 1).setValue(uid);
      changed++;
    }
  });

  var ans = readTable(SH.ANSWERS);
  var repUser = {};
  readTable(SH.REPORTS).rows.forEach(function (r) { if (r[0]) repUser[r[0]] = r[col.user_id]; });
  var out = ans.rows.map(function (r) { return [repUser[r[1]] || r[ans.col.user_id]]; });
  if (out.length) ans.sheet.getRange(2, ans.col.user_id + 1, out.length, 1).setValues(out);

  var msg = 'Оновлено user_id у звітах: ' + changed + ', у відповідях: ' + out.length;
  logEvent('Міграція', 'relinkUsers', msg);
  return msg;
}
