/**
 * Main.gs — меню, кнопки ручного запуску та автоматичний тригер.
 */

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('⏱ Табель')
      .addItem('➕ Створити аркуш наступного місяця', 'manualCreateNextMonth')
      .addItem('📅 Створити аркуш за вибраний місяць…', 'manualCreateMonthPrompt')
      .addSeparator()
      .addItem('🔍 Звірити ПІБ на цьому аркуші', 'manualSyncActiveSheet')
      .addItem('🆔 Проставити emp_id (з ' + getConfig().EMP_ID_FROM + ' і далі)', 'manualBackfillEmpIds')
      .addSeparator()
      .addItem('🎛 Панель керування', 'showSidebar')
      .addItem('⚙️ Увімкнути автостворення (кінець місяця)', 'installTriggers')
      .addItem('⛔ Вимкнути автостворення', 'removeTriggers')
      .addToUi();
  } catch (e) {
    // Без інтерфейсу (наприклад, у тригері) меню не потрібне.
  }
}

function showSidebar() {
  var html = HtmlService.createHtmlOutputFromFile('Sidebar')
    .setTitle('Табель — керування');
  SpreadsheetApp.getUi().showSidebar(html);
}

/** Бічна панель має власні кнопки й власний вивід — діалоги там зайві. */
var SUPPRESS_DIALOGS = false;

function hasUi_() {
  if (SUPPRESS_DIALOGS) return false;
  try { SpreadsheetApp.getUi(); return true; } catch (e) { return false; }
}

function fromSidebar_(fn) {
  SUPPRESS_DIALOGS = true;
  try { return fn(); } finally { SUPPRESS_DIALOGS = false; }
}

function alert_(title, text) {
  if (!hasUi_()) return;
  SpreadsheetApp.getUi().alert(title, text, SpreadsheetApp.getUi().ButtonSet.OK);
}

function nextMonth_(year, month) {
  return month === 12 ? { year: year + 1, month: 1 } : { year: year, month: month + 1 };
}

/** Місяць, який логічно створювати наступним: після найновішого наявного аркуша. */
function suggestNextMonth_(cfg) {
  var ss = getTimesheetSs_(cfg);
  var months = listMonthSheets_(ss);
  if (!months.length) {
    var now = new Date();
    return {
      year: Number(Utilities.formatDate(now, cfg.TIMEZONE, 'yyyy')),
      month: Number(Utilities.formatDate(now, cfg.TIMEZONE, 'MM'))
    };
  }
  var last = months[months.length - 1];
  return nextMonth_(last.year, last.month);
}

// --------------------------------------------------------------------------
// Ручні дії
// --------------------------------------------------------------------------

/** Кнопка «Створити аркуш наступного місяця». */
function manualCreateNextMonth() {
  var cfg = getConfig();
  var target = suggestNextMonth_(cfg);
  var name = monthSheetName_(target.year, target.month);

  if (hasUi_()) {
    var ui = SpreadsheetApp.getUi();
    var answer = ui.alert(
      'Створення аркуша табелю',
      'Створити аркуш «' + name + '»?\n\n' +
      '• усі працівники будуть скопійовані з попереднього місяця;\n' +
      '• години за минулий місяць будуть очищені;\n' +
      '• ПІБ будуть звірені з довідником gw-ref і проставлені emp_id;\n' +
      '• звіт піде на пошту: ' + (cfg.ADMIN_EMAILS_LIST.join(', ') || '—') + '.',
      ui.ButtonSet.OK_CANCEL);
    if (answer !== ui.Button.OK) return 'Скасовано користувачем.';
  }
  return runCreate_(target.year, target.month, 'manual', cfg);
}

/** Кнопка «Створити аркуш за вибраний місяць…». */
function manualCreateMonthPrompt() {
  var cfg = getConfig();
  if (!hasUi_()) return manualCreateNextMonth();
  var ui = SpreadsheetApp.getUi();
  var suggestion = suggestNextMonth_(cfg);
  var res = ui.prompt(
    'Створення аркуша табелю',
    'Вкажіть місяць у форматі РРРР-ММ (напр. ' +
    suggestion.year + '-' + ('0' + suggestion.month).slice(-2) + ')' +
    ' або назву аркуша «Вересень 2026»:',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return 'Скасовано користувачем.';

  var text = String(res.getResponseText() || '').trim();
  var target = null;
  var m = /^(\d{4})\s*[-.\/]\s*(\d{1,2})$/.exec(text);
  if (m) {
    target = { year: Number(m[1]), month: Number(m[2]) };
  } else {
    target = parseMonthSheetName_(text);
  }
  if (!target || target.month < 1 || target.month > 12) {
    alert_('Табель', 'Не вдалося розпізнати місяць «' + text + '».');
    return 'Не розпізнано місяць.';
  }
  return runCreate_(target.year, target.month, 'manual', cfg);
}

function runCreate_(year, month, mode, cfg) {
  cfg = cfg || getConfig();
  var report;
  try {
    report = buildMonthSheet_(year, month, mode, cfg);
  } catch (e) {
    var text = '❌ Не вдалося створити аркуш «' + monthSheetName_(year, month) + '»:\n' + e.message;
    alert_('Табель', text);
    notifyFailure_(cfg, monthSheetName_(year, month), e);
    return text;
  }
  if (mode === 'auto' || cfg.SEND_EMAIL_ON_MANUAL) sendReportEmail_(report, cfg);
  var summary = summaryText_(report) +
    (report.emailSentTo ? '\n\n📧 Звіт надіслано: ' + report.emailSentTo : '');
  alert_('Табель', summary);
  return summary;
}

/** Звірка ПІБ/emp_id для аркуша, який зараз відкритий. */
function manualSyncActiveSheet() {
  var cfg = getConfig();
  var ss = getTimesheetSs_(cfg);
  var sheet = ss.getActiveSheet();
  var parsed = parseMonthSheetName_(sheet.getName());
  if (!parsed) {
    alert_('Табель', 'Аркуш «' + sheet.getName() + '» не схожий на місячний ' +
      '(очікується назва на кшталт «Вересень 2026»).');
    return 'Аркуш не є місячним.';
  }
  var report = newReport_('sync', parsed.year, parsed.month, cfg);
  report.sheetName = sheet.getName();
  try {
    var layout = ensureEmpIdColumn_(sheet, report);
    syncRoster_(sheet, layout, report, cfg);
  } catch (e) {
    report.errors.push(e.message);
  }
  finishReport_(report, cfg);
  if (cfg.SEND_EMAIL_ON_MANUAL) sendReportEmail_(report, cfg);
  var summary = summaryText_(report) +
    (report.emailSentTo ? '\n\n📧 Звіт надіслано: ' + report.emailSentTo : '');
  alert_('Табель', summary);
  return summary;
}

/** Додає emp_id у Серпень, Вересень і всі наступні місяці. */
function manualBackfillEmpIds() {
  var cfg = getConfig();
  var reports = backfillEmpIds_(cfg);
  if (!reports.length) {
    var none = 'Не знайдено аркушів місяців, починаючи з ' + cfg.EMP_ID_FROM + '.';
    alert_('Табель', none);
    return none;
  }
  sendBatchEmail_(reports, cfg,
    'Табель: emp_id у місяцях з ' + cfg.EMP_ID_FROM);
  var lines = reports.map(function (r) {
    return '• ' + r.sheetName + ': працівників ' + r.employeesInSheet +
      ', emp_id ' + r.idsWritten + ', невідповідностей ' + r.issuesCount;
  });
  var summary = 'Оброблено аркушів: ' + reports.length + '\n' + lines.join('\n');
  alert_('Табель', summary);
  return summary;
}

function backfillEmpIds_(cfg) {
  var ss = getTimesheetSs_(cfg);
  var from = cfg.EMP_ID_FROM_YEAR * 100 + cfg.EMP_ID_FROM_MONTH;
  var reports = [];
  listMonthSheets_(ss).forEach(function (ms) {
    if (ms.key < from) return;
    var report = newReport_('sync', ms.year, ms.month, cfg);
    report.sheetName = ms.sheet.getName();
    try {
      var layout = ensureEmpIdColumn_(ms.sheet, report);
      syncRoster_(ms.sheet, layout, report, cfg);
    } catch (e) {
      report.errors.push(e.message);
    }
    finishReport_(report, cfg);
    reports.push(report);
  });
  return reports;
}

// --------------------------------------------------------------------------
// Автоматичний запуск
// --------------------------------------------------------------------------

/**
 * Виконується щодня. Діє лише в останній день місяця (створює наступний)
 * і 1-го числа (страховка, якщо ввечері тригер не спрацював).
 */
function dailyEndOfMonthCheck() {
  var cfg = getConfig();
  try {
    var now = new Date();
    var y = Number(Utilities.formatDate(now, cfg.TIMEZONE, 'yyyy'));
    var m = Number(Utilities.formatDate(now, cfg.TIMEZONE, 'MM'));
    var d = Number(Utilities.formatDate(now, cfg.TIMEZONE, 'dd'));

    var target = null;
    if (d === daysInMonth_(y, m)) target = nextMonth_(y, m);
    else if (d === 1) target = { year: y, month: m };
    if (!target) return;

    var ss = getTimesheetSs_(cfg);
    if (ss.getSheetByName(monthSheetName_(target.year, target.month))) return;

    var report = buildMonthSheet_(target.year, target.month, 'auto', cfg);
    sendReportEmail_(report, cfg);
  } catch (e) {
    notifyFailure_(cfg, 'автоматичне створення аркуша', e);
    throw e;
  }
}

function notifyFailure_(cfg, what, err) {
  if (!cfg.ADMIN_EMAILS_LIST.length) return;
  try {
    MailApp.sendEmail({
      to: cfg.ADMIN_EMAILS_LIST.join(','),
      subject: '❌ Табель: помилка — ' + what,
      body: 'Не вдалося виконати «' + what + '».\n\n' + (err && err.stack ? err.stack : err) +
        '\n\nhttps://docs.google.com/spreadsheets/d/' + cfg.TIMESHEET_ID + '/edit',
      name: cfg.EMAIL_SENDER_NAME
    });
  } catch (e) {
    Logger.log('Не вдалося надіслати лист про помилку: ' + e.message);
  }
}

function installTriggers() {
  var cfg = getConfig();
  removeTriggers();
  ScriptApp.newTrigger('dailyEndOfMonthCheck')
    .timeBased()
    .everyDays(1)
    .atHour(23)
    .inTimezone(cfg.TIMEZONE)
    .create();
  var text = 'Автостворення увімкнено.\n\n' +
    'Щодня близько 23:00 (' + cfg.TIMEZONE + ') скрипт перевіряє дату. ' +
    'В останній день місяця він створює аркуш наступного місяця; 1-го числа — ' +
    'створює поточний, якщо його ще немає.';
  alert_('Табель', text);
  return text;
}

function removeTriggers() {
  var n = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'dailyEndOfMonthCheck') {
      ScriptApp.deleteTrigger(t);
      n++;
    }
  });
  return 'Вилучено тригерів: ' + n;
}

// --------------------------------------------------------------------------
// Зведений лист для пакетної обробки
// --------------------------------------------------------------------------

function sendBatchEmail_(reports, cfg, subject) {
  if (!cfg.ADMIN_EMAILS_LIST.length) return false;
  var ssUrl = 'https://docs.google.com/spreadsheets/d/' + cfg.TIMESHEET_ID + '/edit';
  var totalIssues = reports.reduce(function (a, r) { return a + r.issuesCount; }, 0);
  var summary = htmlTable_(
    ['Аркуш', 'Працівників', 'emp_id', 'Невідповідностей'],
    reports.map(function (r) {
      return [r.sheetName, r.employeesInSheet, r.idsWritten, r.issuesCount];
    }));
  var body = reports.map(function (r) { return buildEmailHtml_(r, cfg, ssUrl); }).join('<hr>');
  try {
    MailApp.sendEmail({
      to: cfg.ADMIN_EMAILS_LIST.join(','),
      subject: (totalIssues ? '⚠️ ' : '✅ ') + subject +
        (totalIssues ? ' — невідповідностей: ' + totalIssues : ''),
      htmlBody: '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">' +
        '<h2 style="font-size:20px;margin:0 0 8px;">' + esc_(subject) + '</h2>' +
        summary + body + '</div>',
      body: reports.map(function (r) { return summaryText_(r); }).join('\n\n---\n\n'),
      name: cfg.EMAIL_SENDER_NAME
    });
    reports.forEach(function (r) { r.emailSentTo = cfg.ADMIN_EMAILS_LIST.join(', '); });
    return true;
  } catch (e) {
    Logger.log('Пакетний лист не надіслано: ' + e.message);
    return false;
  }
}

// --------------------------------------------------------------------------
// Виклики з бічної панелі
// --------------------------------------------------------------------------

function uiCreateNextMonth() {
  return fromSidebar_(function () { return manualCreateNextMonth(); });
}
function uiCreateChosenMonth(text) {
  return fromSidebar_(function () {
    var cfg = getConfig();
    var t = String(text || '').trim();
    var m = /^(\d{4})\s*[-.\/]\s*(\d{1,2})$/.exec(t);
    var target = m ? { year: Number(m[1]), month: Number(m[2]) } : parseMonthSheetName_(t);
    if (!target) return 'Не вдалося розпізнати місяць «' + t + '».';
    return runCreate_(target.year, target.month, 'manual', cfg);
  });
}
function uiSyncActiveSheet() {
  return fromSidebar_(function () { return manualSyncActiveSheet(); });
}
function uiBackfillEmpIds() {
  return fromSidebar_(function () { return manualBackfillEmpIds(); });
}
function uiNextMonthName() {
  var cfg = getConfig();
  var t = suggestNextMonth_(cfg);
  return monthSheetName_(t.year, t.month);
}
