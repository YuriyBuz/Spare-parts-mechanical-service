/**
 * MonthSheet.gs — розбір структури місячного аркуша та створення нового місяця.
 *
 * Структура аркуша «<Місяць> <Рік>» (визначається автоматично, не жорстко):
 *   рядок 1        A1 = «Серпень 2026» + легенда (В / Л / Х …)
 *   рядок dateRow  дати «1/8», «2/8» … + «за місяць» (кожна дата — на 2 колонки)
 *   рядок wdRow    дні тижня
 *   рядок headRow  «День» / «Ніч» для кожної дати, далі «Змін» / «Годин»
 *   нижче          A = ПІБ, B = посада, (C = emp_id), далі години по днях
 */

/** Активний або відкритий за ID файл табелю. */
function getTimesheetSs_(cfg) {
  var active = null;
  try { active = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { active = null; }
  if (active && (!cfg.TIMESHEET_ID || active.getId() === cfg.TIMESHEET_ID)) return active;
  if (!cfg.TIMESHEET_ID) {
    throw new Error('Скрипт не прив’язаний до таблиці табелю і TIMESHEET_ID не задано. ' + SETUP_HINT);
  }
  return SpreadsheetApp.openById(cfg.TIMESHEET_ID);
}

/** Посилання на таблиці — для листів. */
function timesheetUrl_(cfg) {
  try { return getTimesheetSs_(cfg).getUrl(); } catch (e) { return ''; }
}

function refUrl_(cfg) {
  return cfg.REF_ID ? 'https://docs.google.com/spreadsheets/d/' + cfg.REF_ID + '/edit' : '';
}

function daysInMonth_(year, month) {
  return new Date(year, month, 0).getDate();
}

function monthSheetName_(year, month) {
  return UA_MONTHS[month - 1] + ' ' + year;
}

/** «Серпень 2026» → {year: 2026, month: 8}; інакше null. */
function parseMonthSheetName_(name) {
  var t = String(name || '').replace(/ /g, ' ').trim().toLowerCase();
  var m = /^([^\d\s]+)\s+(\d{4})$/.exec(t);
  if (!m) return null;
  var word = m[1];
  var year = Number(m[2]);
  for (var i = 0; i < UA_MONTHS.length; i++) {
    if (UA_MONTHS[i].toLowerCase() === word) return { year: year, month: i + 1 };
    if (UA_MONTHS_ALT[i].indexOf(word) >= 0) return { year: year, month: i + 1 };
  }
  return null;
}

/** Усі місячні аркуші, відсортовані хронологічно. */
function listMonthSheets_(ss) {
  var out = [];
  ss.getSheets().forEach(function (sh) {
    var p = parseMonthSheetName_(sh.getName());
    if (p) out.push({ sheet: sh, year: p.year, month: p.month, key: p.year * 100 + p.month });
  });
  out.sort(function (a, b) { return a.key - b.key; });
  return out;
}

/** Аркуш-джерело: попередній місяць, інакше найближчий раніший. */
function findSourceSheet_(ss, year, month) {
  var key = year * 100 + month;
  var months = listMonthSheets_(ss).filter(function (m) { return m.key < key; });
  if (!months.length) return null;
  var prev = new Date(year, month - 2, 1);
  var prevKey = prev.getFullYear() * 100 + (prev.getMonth() + 1);
  for (var i = 0; i < months.length; i++) {
    if (months[i].key === prevKey) return months[i];
  }
  return months[months.length - 1];
}

function normHeader_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/ /g, ' ').trim().toLowerCase();
}

/**
 * Визначає розкладку аркуша. Кидає помилку, якщо аркуш не схожий на табель.
 */
function analyzeLayout_(sheet) {
  var maxRow = Math.min(10, sheet.getMaxRows());
  var maxCol = Math.max(sheet.getLastColumn(), 4);
  var probe = sheet.getRange(1, 1, maxRow, maxCol).getDisplayValues();

  var headerRow = 0;
  for (var r = 0; r < probe.length; r++) {
    var days = 0;
    for (var c = 0; c < probe[r].length; c++) {
      if (normHeader_(probe[r][c]) === 'день') days++;
    }
    if (days >= 5) { headerRow = r + 1; break; }
  }
  if (!headerRow || headerRow < 3) {
    throw new Error('Аркуш «' + sheet.getName() + '»: не знайдено рядок з «День»/«Ніч». ' +
      'Перевірте, що це аркуш табелю.');
  }

  var dateRow = headerRow - 2;
  var weekdayRow = headerRow - 1;

  var dayCols = [];
  var dateCells = probe[dateRow - 1];
  for (var i = 0; i < dateCells.length; i++) {
    if (/^\s*\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*$/.test(String(dateCells[i]))) dayCols.push(i + 1);
  }
  if (dayCols.length < 28) {
    throw new Error('Аркуш «' + sheet.getName() + '»: у рядку ' + dateRow +
      ' знайдено лише ' + dayCols.length + ' дат — розкладку не розпізнано.');
  }

  var firstDayCol = dayCols[0];
  var lastDayStart = dayCols[dayCols.length - 1];
  var dayCount = dayCols.length;
  if (lastDayStart - firstDayCol !== (dayCount - 1) * 2) {
    throw new Error('Аркуш «' + sheet.getName() + '»: колонки днів розташовані нерівномірно ' +
      '(очікується по 2 колонки на день).');
  }
  var lastDayCol = lastDayStart + 1;

  var shiftsCol = 0;
  for (var j = lastDayCol; j < dateCells.length; j++) {
    if (normHeader_(dateCells[j]) === TOTALS_LABEL) { shiftsCol = j + 1; break; }
  }
  if (!shiftsCol) shiftsCol = lastDayCol + 1;

  var empIdCol = 0;
  for (var rr = 0; rr < headerRow; rr++) {
    for (var cc = 0; cc < firstDayCol; cc++) {
      if (normHeader_(probe[rr][cc]) === EMP_ID_HEADER) { empIdCol = cc + 1; break; }
    }
    if (empIdCol) break;
  }

  return {
    sheet: sheet,
    dateRow: dateRow,
    weekdayRow: weekdayRow,
    headerRow: headerRow,
    firstDataRow: headerRow + 1,
    lastDataRow: sheet.getLastRow(),
    firstDayCol: firstDayCol,
    lastDayCol: lastDayCol,
    dayCount: dayCount,
    shiftsCol: shiftsCol,
    hoursCol: shiftsCol + 1,
    empIdCol: empIdCol
  };
}

/** Пише значення з урахуванням об'єднаних комірок. */
function setCellSafe_(sheet, row, col, value) {
  var rng = sheet.getRange(row, col);
  if (rng.isPartOfMerge()) {
    var merged = rng.getMergedRanges();
    if (merged.length) { merged[0].getCell(1, 1).setValue(value); return; }
  }
  rng.setValue(value);
}

/** Гарантує наявність колонки emp_id перед першим днем. Повертає нову розкладку. */
function ensureEmpIdColumn_(sheet, report) {
  var layout = analyzeLayout_(sheet);
  if (layout.empIdCol) return layout;

  sheet.insertColumnBefore(layout.firstDayCol);
  var col = layout.firstDayCol;
  sheet.getRange(layout.headerRow, col).setValue(EMP_ID_HEADER);
  sheet.getRange(layout.headerRow, col)
    .setHorizontalAlignment('center')
    .setFontWeight('bold');
  sheet.setColumnWidth(col, 92);
  // Свіжа колонка не має успадковувати числовий формат сусіда.
  sheet.getRange(layout.headerRow + 1, col, Math.max(sheet.getMaxRows() - layout.headerRow, 1), 1)
    .setNumberFormat('@')
    .setHorizontalAlignment('center');

  if (report) report.structure.push('Додано колонку «emp_id» (' + columnLetter_(col) + ').');
  return analyzeLayout_(sheet);
}

function columnLetter_(col) {
  var s = '';
  while (col > 0) {
    var r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

/**
 * Підганяє кількість колонок днів під довжину місяця.
 *
 * Розкладку після правки рахуємо арифметично, а не повторним розбором: поки
 * rebuildHeaders_ не заповнив нові колонки датами, аркуш у проміжному стані
 * (у щойно вставлених колонках дат ще немає) і analyzeLayout_ його відхилив би.
 */
function adjustDayColumns_(sheet, year, month, report) {
  var layout = analyzeLayout_(sheet);
  var want = daysInMonth_(year, month);
  var have = layout.dayCount;
  if (want === have) return layout;

  var delta = (want - have) * 2;
  if (want < have) {
    var del = -delta;
    sheet.deleteColumns(layout.lastDayCol - del + 1, del);
    report.structure.push('Вилучено ' + del + ' колонок: у місяці ' + want +
      ' днів замість ' + have + '.');
  } else {
    var at = layout.lastDayCol - 1; // перед останньою парою — щоб формули підсумків розширились
    sheet.insertColumnsBefore(at, delta);
    var srcPair = sheet.getRange(1, layout.firstDayCol, sheet.getMaxRows(), 2);
    var dst = sheet.getRange(1, at, sheet.getMaxRows(), delta);
    srcPair.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
    srcPair.copyTo(dst, SpreadsheetApp.CopyPasteType.PASTE_DATA_VALIDATION, false);
    dst.clearContent();
    report.structure.push('Додано ' + delta + ' колонок: у місяці ' + want +
      ' днів замість ' + have + '.');
  }

  layout.dayCount = want;
  layout.lastDayCol += delta;
  layout.shiftsCol += delta;
  layout.hoursCol += delta;
  return layout;
}

/** Переписує шапку (заголовок, дати, дні тижня, «День»/«Ніч», «за місяць»). */
function rebuildHeaders_(sheet, layout, year, month) {
  var days = layout.dayCount;
  var width = days * 2;

  setCellSafe_(sheet, 1, 1, monthSheetName_(year, month));

  var headRows = layout.headerRow - layout.dateRow; // рядки дат + днів тижня
  sheet.getRange(layout.dateRow, layout.firstDayCol, headRows, width).breakApart();

  var asDate = sheet.getRange(layout.dateRow, layout.firstDayCol).getValue() instanceof Date;
  var dateRange = sheet.getRange(layout.dateRow, layout.firstDayCol, 1, width);
  var dates = [];
  var weekdays = [];
  var heads = [];
  for (var d = 1; d <= days; d++) {
    var dt = new Date(year, month - 1, d);
    dates.push(asDate ? dt : d + '/' + month, '');
    weekdays.push(UA_WEEKDAYS[dt.getDay()], '');
    heads.push('День', 'Ніч');
  }
  if (!asDate) dateRange.setNumberFormat('@');
  dateRange.setValues([dates]);
  sheet.getRange(layout.weekdayRow, layout.firstDayCol, 1, width).setValues([weekdays]);
  sheet.getRange(layout.headerRow, layout.firstDayCol, 1, width).setValues([heads]);

  for (var i = 0; i < days; i++) {
    var c = layout.firstDayCol + i * 2;
    sheet.getRange(layout.dateRow, c, 1, 2).merge();
    sheet.getRange(layout.weekdayRow, c, 1, 2).merge();
  }

  sheet.getRange(layout.dateRow, layout.shiftsCol, headRows, 2).breakApart();
  sheet.getRange(layout.dateRow, layout.shiftsCol, 1, 2).merge().setValue(TOTALS_LABEL);
  sheet.getRange(layout.headerRow, layout.shiftsCol).setValue('Змін');
  sheet.getRange(layout.headerRow, layout.hoursCol).setValue('Годин');

  cleanStaleHeaderCells_(sheet, layout);
}

/**
 * Прибирає залишки шапки праворуч від «Годин» (у Серпні 2026 там висіли
 * зайві «День/Ніч/Змін/Годин» від старішої розкладки).
 */
function cleanStaleHeaderCells_(sheet, layout) {
  var last = sheet.getLastColumn();
  if (last <= layout.hoursCol) return;
  var width = last - layout.hoursCol;
  var rng = sheet.getRange(layout.headerRow, layout.hoursCol + 1, 1, width);
  var vals = rng.getDisplayValues()[0];
  for (var i = 0; i < vals.length; i++) {
    if (HEADER_WORDS.indexOf(String(vals[i]).trim()) >= 0) {
      sheet.getRange(layout.headerRow, layout.hoursCol + 1 + i).clearContent();
    }
  }
}

/** Очищає години попереднього місяця, лишаючи ПІБ, посаду, emp_id і формули. */
function clearMonthData_(sheet, layout, cfg, report) {
  var rows = layout.lastDataRow - layout.firstDataRow + 1;
  if (rows <= 0) return;

  var body = sheet.getRange(layout.firstDataRow, layout.firstDayCol, rows,
    layout.lastDayCol - layout.firstDayCol + 1);
  body.clearContent();
  body.clearNote();

  if (cfg.CLEAR_NAME_NOTES) {
    sheet.getRange(layout.firstDataRow, NAME_COL, rows, 1).clearNote();
  }

  // Підсумки: формули лишаємо, «вбиті» руками числа — прибираємо.
  var totals = sheet.getRange(layout.firstDataRow, layout.shiftsCol, rows, 2);
  var formulas = totals.getFormulas();
  var values = totals.getValues();
  var stale = 0;
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < 2; c++) {
      if (!formulas[r][c] && values[r][c] !== '' && values[r][c] !== null) {
        sheet.getRange(layout.firstDataRow + r, layout.shiftsCol + c).clearContent();
        stale++;
      }
    }
  }
  if (stale) {
    report.structure.push('Очищено ' + stale +
      ' підсумкових комірок, у яких були числа замість формул.');
  }
}

/**
 * Створює аркуш місяця. Повертає звіт (див. Report.gs).
 */
function buildMonthSheet_(year, month, mode, cfg) {
  cfg = cfg || getConfig();
  var report = newReport_(mode, year, month, cfg);
  var ss = getTimesheetSs_(cfg);
  var name = monthSheetName_(year, month);
  report.sheetName = name;

  var existing = ss.getSheetByName(name);
  if (existing) {
    report.skipped = true;
    report.message = 'Аркуш «' + name + '» вже існує — нічого не створювали. ' +
      'Виконано лише звірку ПІБ та emp_id.';
    var layout = ensureEmpIdColumn_(existing, report);
    syncRoster_(existing, layout, report, cfg);
    finishReport_(report, cfg);
    return report;
  }

  var src = findSourceSheet_(ss, year, month);
  if (!src) {
    throw new Error('Не знайдено жодного попереднього місячного аркуша, з якого копіювати.');
  }
  report.sourceSheetName = src.sheet.getName();

  var copy = src.sheet.copyTo(ss);
  copy.setName(name);
  ss.setActiveSheet(copy);
  ss.moveActiveSheet(src.sheet.getIndex() + 1);

  var lay = ensureEmpIdColumn_(copy, report);
  lay = adjustDayColumns_(copy, year, month, report);
  rebuildHeaders_(copy, lay, year, month);
  lay = analyzeLayout_(copy);
  clearMonthData_(copy, lay, cfg, report);

  report.created = true;
  report.daysInMonth = lay.dayCount;
  syncRoster_(copy, lay, report, cfg);
  finishReport_(report, cfg);
  return report;
}
