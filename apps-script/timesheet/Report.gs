/**
 * Report.gs — накопичення результату запуску, лист адміністратору, журнал.
 */

function newReport_(mode, year, month, cfg) {
  return {
    mode: mode,                       // 'auto' | 'manual' | 'sync'
    startedAt: new Date(),
    year: year,
    month: month,
    monthLabel: monthSheetName_(year, month),
    sheetName: monthSheetName_(year, month),
    sourceSheetName: '',
    created: false,
    skipped: false,
    message: '',
    daysInMonth: daysInMonth_(year, month),
    employeesInSheet: 0,
    idsWritten: 0,
    aliasesWritten: 0,
    refTotal: 0,
    refActive: 0,
    matched: [],
    added: [],
    structure: [],
    issues: {
      notFound: [],
      ambiguous: [],
      fuzzy: [],
      fired: [],
      positionMismatch: [],
      duplicates: [],
      missingInSheet: [],
      unknownId: [],
      idNameMismatch: [],
      refProblems: []
    },
    errors: []
  };
}

function issuesCount_(report) {
  var n = 0;
  Object.keys(report.issues).forEach(function (k) { n += report.issues[k].length; });
  return n;
}

function finishReport_(report, cfg) {
  report.finishedAt = new Date();
  report.issuesCount = issuesCount_(report);
  if (!report.message) {
    report.message = report.created
      ? 'Створено аркуш «' + report.sheetName + '» на основі «' + report.sourceSheetName + '».'
      : 'Звірку виконано для аркуша «' + report.sheetName + '».';
  }
  if (cfg.WRITE_LOG) {
    try { writeLog_(report, cfg); } catch (e) { report.errors.push('Журнал: ' + e.message); }
  }
  return report;
}

function modeLabel_(mode) {
  if (mode === 'auto') return 'автоматично (кінець місяця)';
  if (mode === 'manual') return 'вручну (кнопка)';
  return 'звірка';
}

/** Короткий текст для діалогу в таблиці. */
function summaryText_(report) {
  var lines = [];
  lines.push(report.created
    ? '✅ Створено аркуш «' + report.sheetName + '»'
    : (report.skipped ? 'ℹ️ Аркуш «' + report.sheetName + '» уже існував' : '✅ ' + report.sheetName));
  if (report.sourceSheetName) lines.push('Джерело: ' + report.sourceSheetName);
  lines.push('Працівників у табелі: ' + report.employeesInSheet +
    ' • днів у місяці: ' + report.daysInMonth);
  lines.push('Проставлено/оновлено emp_id: ' + report.idsWritten);

  var i = report.issues;
  var parts = [];
  if (i.notFound.length) parts.push('немає в довіднику: ' + i.notFound.length);
  if (i.fuzzy.length) parts.push('нечіткий збіг: ' + i.fuzzy.length);
  if (i.ambiguous.length) parts.push('неоднозначно: ' + i.ambiguous.length);
  if (i.fired.length) parts.push('звільнені: ' + i.fired.length);
  if (i.positionMismatch.length) parts.push('розбіжність посад: ' + i.positionMismatch.length);
  if (i.duplicates.length) parts.push('дублі: ' + i.duplicates.length);
  if (i.missingInSheet.length) parts.push('немає в табелі: ' + i.missingInSheet.length);
  if (i.unknownId.length) parts.push('невідомий emp_id: ' + i.unknownId.length);
  if (i.idNameMismatch.length) parts.push('emp_id ≠ ПІБ: ' + i.idNameMismatch.length);

  lines.push(parts.length ? '⚠️ Невідповідності — ' + parts.join(', ') : '✔ Невідповідностей немає');
  if (report.added.length) lines.push('Додано працівників: ' + report.added.length);
  if (report.structure.length) lines.push('Структура: ' + report.structure.join(' '));
  if (report.errors.length) lines.push('❌ Помилки: ' + report.errors.join('; '));
  return lines.join('\n');
}

function esc_(v) {
  return String(v === null || v === undefined ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function htmlTable_(headers, rows) {
  var th = headers.map(function (h) {
    return '<th style="text-align:left;padding:6px 10px;border-bottom:2px solid #cbd5e1;' +
      'font-size:12px;color:#475569;">' + esc_(h) + '</th>';
  }).join('');
  var tr = rows.map(function (r) {
    var tds = r.map(function (c) {
      return '<td style="padding:6px 10px;border-bottom:1px solid #e2e8f0;font-size:13px;">' +
        esc_(c) + '</td>';
    }).join('');
    return '<tr>' + tds + '</tr>';
  }).join('');
  return '<table style="border-collapse:collapse;width:100%;margin:6px 0 16px;">' +
    '<thead><tr>' + th + '</tr></thead><tbody>' + tr + '</tbody></table>';
}

function section_(title, note, headers, rows) {
  if (!rows.length) return '';
  return '<h3 style="margin:18px 0 2px;font-size:15px;color:#0f172a;">' + esc_(title) +
    ' <span style="color:#64748b;font-weight:normal;">(' + rows.length + ')</span></h3>' +
    (note ? '<div style="font-size:12px;color:#64748b;margin-bottom:4px;">' + esc_(note) + '</div>' : '') +
    htmlTable_(headers, rows);
}

function buildEmailHtml_(report, cfg, ssUrl) {
  var i = report.issues;
  var head =
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a;' +
    'max-width:860px;">' +
    '<h2 style="margin:0 0 4px;font-size:20px;">' +
    (report.created ? 'Створено аркуш табелю «' + esc_(report.sheetName) + '»'
      : 'Звірка табелю «' + esc_(report.sheetName) + '»') + '</h2>' +
    '<div style="color:#64748b;font-size:13px;margin-bottom:14px;">' +
    esc_(Utilities.formatDate(report.startedAt, cfg.TIMEZONE, 'dd.MM.yyyy HH:mm')) +
    ' • режим: ' + esc_(modeLabel_(report.mode)) + '</div>';

  var facts = htmlTable_(['Показник', 'Значення'], [
    ['Аркуш', report.sheetName],
    ['Джерело (попередній місяць)', report.sourceSheetName || '—'],
    ['Днів у місяці', report.daysInMonth],
    ['Працівників у табелі', report.employeesInSheet],
    ['Проставлено / оновлено emp_id', report.idsWritten],
    ['У довіднику всього / активних', report.refTotal + ' / ' + report.refActive],
    ['Невідповідностей', report.issuesCount],
    ['Записано варіантів написання', report.aliasesWritten]
  ]);

  var body = '';
  body += section_('Немає в довіднику gw-ref',
    'ПІБ є в табелі, але не знайдено в _REF_Employees. emp_id не проставлено.',
    ['Рядок', 'ПІБ', 'Посада в табелі'],
    i.notFound.map(function (x) { return [x.row, x.name, x.position]; }));

  body += section_('Нечіткий збіг ПІБ — перевірте',
    'Написання відрізняється від довідника. ' +
    (cfg.FUZZY_AUTO_APPLY ? 'emp_id проставлено автоматично.' : 'emp_id НЕ проставлено.'),
    ['Рядок', 'ПІБ у табелі', 'ПІБ у довіднику', 'emp_id', 'Відмінностей'],
    i.fuzzy.map(function (x) { return [x.row, x.name, x.refName, x.empId, x.distance]; }));

  body += section_('Неоднозначний збіг', 'Кілька кандидатів — оберіть вручну.',
    ['Рядок', 'ПІБ', 'Кандидати'],
    i.ambiguous.map(function (x) { return [x.row, x.name, x.candidates.join('; ')]; }));

  body += section_('Звільнені за довідником', 'Рядок залишено — місяць міг бути відпрацьований частково.',
    ['Рядок', 'ПІБ', 'emp_id'],
    i.fired.map(function (x) { return [x.row, x.name, x.empId]; }));

  body += section_('Розбіжність посади', '',
    ['Рядок', 'ПІБ', 'У табелі', 'У довіднику'],
    i.positionMismatch.map(function (x) {
      return [x.row, x.name, x.sheetPosition, x.refPosition];
    }));

  body += section_('Дублікати', '',
    ['ПІБ', 'Рядки'],
    i.duplicates.map(function (x) { return [x.name, x.rows.join(', ')]; }));

  body += section_('Є в довіднику, немає в табелі',
    cfg.AUTO_ADD_NEW_EMPLOYEES ? 'Автододавання увімкнено.'
      : 'Активні працівники з посадою. Додайте вручну, якщо потрібні.',
    ['emp_id', 'ПІБ', 'Посада', 'Підрозділ'],
    i.missingInSheet.map(function (x) { return [x.empId, x.name, x.position, x.unit]; }));

  body += section_('Невідомий emp_id у табелі', 'Такого emp_id немає в довіднику.',
    ['Рядок', 'ПІБ', 'emp_id'],
    i.unknownId.map(function (x) { return [x.row, x.name, x.empId]; }));

  body += section_('emp_id не збігається з ПІБ', '',
    ['Рядок', 'ПІБ у табелі', 'emp_id', 'ПІБ у довіднику'],
    i.idNameMismatch.map(function (x) { return [x.row, x.name, x.empId, x.refName]; }));

  body += section_('Додано працівників у табель', '',
    ['Рядок', 'ПІБ', 'emp_id', 'Посада'],
    report.added.map(function (x) { return [x.row, x.name, x.empId, x.position]; }));

  body += section_('Проставлено emp_id', '',
    ['Рядок', 'ПІБ', 'emp_id', 'Спосіб звірки'],
    report.matched.map(function (x) { return [x.row, x.name, x.empId, x.how]; }));

  body += section_('Зауваження до довідника', '', ['Опис'],
    i.refProblems.map(function (x) { return [x]; }));

  if (report.structure.length) {
    body += section_('Зміни структури аркуша', '', ['Опис'],
      report.structure.map(function (x) { return [x]; }));
  }
  if (report.errors.length) {
    body += section_('Помилки', '', ['Опис'], report.errors.map(function (x) { return [x]; }));
  }
  if (!body) {
    body = '<p style="font-size:14px;color:#16a34a;">✔ Невідповідностей не знайдено — ' +
      'усі ПІБ звірені з довідником.</p>';
  }

  var links = '<p style="margin-top:20px;font-size:13px;">' +
    '<a href="' + esc_(ssUrl) + '" style="color:#2563eb;">Відкрити табель</a> &nbsp;•&nbsp; ' +
    '<a href="https://docs.google.com/spreadsheets/d/' + esc_(cfg.REF_ID) +
    '/edit" style="color:#2563eb;">Відкрити довідник gw-ref</a></p>' +
    '<p style="color:#94a3b8;font-size:11px;margin-top:14px;">' +
    'Лист сформовано скриптом «Табель — автоматизація». Налаштування отримувачів — ' +
    'у властивостях скрипта (ADMIN_EMAILS).</p></div>';

  return head + '<p style="margin:0;font-size:14px;">' + esc_(report.message) + '</p>' +
    facts + body + links;
}

function sendReportEmail_(report, cfg) {
  if (!cfg.ADMIN_EMAILS_LIST.length) {
    report.errors.push('Не задано ADMIN_EMAILS — лист не надіслано.');
    return false;
  }
  var ssUrl = 'https://docs.google.com/spreadsheets/d/' + cfg.TIMESHEET_ID + '/edit';
  var flag = report.issuesCount ? '⚠️ ' : '✅ ';
  var subject = flag + 'Табель: ' +
    (report.created ? 'створено аркуш «' : 'звірка аркуша «') + report.sheetName + '»' +
    (report.issuesCount ? ' — невідповідностей: ' + report.issuesCount : '');
  try {
    MailApp.sendEmail({
      to: cfg.ADMIN_EMAILS_LIST.join(','),
      subject: subject,
      body: summaryText_(report) + '\n\n' + ssUrl,
      htmlBody: buildEmailHtml_(report, cfg, ssUrl),
      name: cfg.EMAIL_SENDER_NAME
    });
    report.emailSentTo = cfg.ADMIN_EMAILS_LIST.join(', ');
    return true;
  } catch (e) {
    report.errors.push('Не вдалося надіслати лист: ' + e.message);
    return false;
  }
}

function writeLog_(report, cfg) {
  var ss = getTimesheetSs_(cfg);
  var sh = ss.getSheetByName(cfg.LOG_SHEET_NAME);
  if (!sh) {
    sh = ss.insertSheet(cfg.LOG_SHEET_NAME);
    sh.getRange(1, 1, 1, 9).setValues([[
      'Дата', 'Режим', 'Аркуш', 'Джерело', 'Працівників',
      'emp_id', 'Невідповідностей', 'Повідомлення', 'Помилки'
    ]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  sh.appendRow([
    Utilities.formatDate(report.startedAt, cfg.TIMEZONE, 'dd.MM.yyyy HH:mm:ss'),
    modeLabel_(report.mode),
    report.sheetName,
    report.sourceSheetName,
    report.employeesInSheet,
    report.idsWritten,
    report.issuesCount,
    report.message,
    report.errors.join('; ')
  ]);
}
