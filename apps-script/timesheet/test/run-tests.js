/**
 * Офлайн-перевірка логіки скрипта табелю.
 *
 *   node apps-script/timesheet/test/run-tests.js
 *
 * mock.js підміняє SpreadsheetApp/MailApp/Utilities мінімальними заглушками,
 * fixture-month.csv — знеособлена копія реального аркуша «Серпень 2026»
 * (структура 1-в-1, ПІБ вигадані).
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
require('./mock.js');

const SRC = path.join(__dirname, '..');
['Config.gs', 'Roster.gs', 'MonthSheet.gs', 'Report.gs', 'Main.gs'].forEach(f => {
  vm.runInThisContext(fs.readFileSync(path.join(SRC, f), 'utf8'), { filename: f });
});

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r') { /* skip */ }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- фікстура
const WIDTH = 80;
const csv = parseCsv(fs.readFileSync(path.join(__dirname, 'fixture-month.csv'), 'utf8'));
const grid = csv.map(r => { const c = r.slice(); while (c.length < WIDTH) c.push(''); return c.slice(0, WIDTH); });

const merges = [];
[[1, 7], [8, 4], [12, 4], [16, 4], [20, 4], [24, 4], [28, 4], [32, 4]]
  .forEach(([c, n]) => merges.push({ row: 1, col: c, nr: 1, nc: n }));
for (let d = 0; d < 31; d++) {
  merges.push({ row: 2, col: 3 + d * 2, nr: 1, nc: 2 });
  merges.push({ row: 3, col: 3 + d * 2, nr: 1, nc: 2 });
}
merges.push({ row: 2, col: 65, nr: 1, nc: 2 });

const tsSs = new Spreadsheet('timesheet-test', 'Табель 2026');
tsSs.addSheet('Липень 2026', [['Липень 2026']], []);
const aug = tsSs.addSheet('Серпень 2026', grid, merges);
__REGISTER_SS__(tsSs);
global.__ACTIVE_SS__ = tsSs;

// Рядки фікстури, на яких перевіряємо окремі сценарії звірки.
const ROW = { initials: 37, typo: 16, ambiguous: 50, fired: 54, wrongPos: 41, notInRef: 56 };
const nameAt = (r) => String(aug.get(r, 1)).trim();
const posAt = (r) => String(aug.get(r, 2)).trim();

const NAME = {};
Object.keys(ROW).forEach(k => { NAME[k] = nameAt(ROW[k]); });

// У табелі людину записали скорочено — довідник має знайти її за ініціалами.
const shortOf = (full) => {
  const p = full.split(/\s+/);
  return p[0] + ' ' + p.slice(1).map(x => x[0] + '.').join(' ');
};
aug.set(ROW.initials, 1, shortOf(NAME.initials));

// ------------------------------------------------------------- довідник
// Друкарська помилка у першій літері по батькові: ініціал інший, тож збіг
// за ініціалами не спрацює і має відпрацювати саме нечіткий пошук.
const oneCharTypo = (s) => {
  const p = s.split(' ');
  const last = p[p.length - 1];
  p[p.length - 1] = (last[0] === 'О' ? 'А' : 'О') + last.slice(1);
  return p.join(' ');
};
const refRows = [['emp_id', 'ПІБ повне', 'ПІБ короткий', 'прізвище', 'pos_id', 'посада', 'підрозділ',
  'статус', 'дата прийому', 'дата звільнення', 'телефон', 'дата народження', 'екстрений: хто',
  'екстрений: телефон', 'email', 'таб_1С', 'PIN', 'ролі додатково', 'ролі відібрані', 'джерело',
  'оновлено', 'логін порталу', 'пароль']];

let idx = 0;
for (let r = 5; r <= aug.getLastRow(); r++) {
  const sheetName = nameAt(r);
  if (!sheetName) continue;
  if (r === ROW.notInRef) continue;                       // → «немає в довіднику»
  let full = r === ROW.initials ? NAME.initials : sheetName;
  if (r === ROW.typo) full = oneCharTypo(full);           // → «нечіткий збіг»
  let position = posAt(r);
  position = position.charAt(0).toUpperCase() + position.slice(1).trim();
  if (r === ROW.wrongPos) position = 'Налагоджувальник';  // → «розбіжність посади»
  const status = r === ROW.fired ? 'fired' : 'active';    // → «звільнений»
  const short = r === ROW.initials ? '' : shortOf(full);  // порожньо → шукаємо за ініціалами
  idx++;
  refRows.push(['EMP-' + String(idx).padStart(4, '0'), full, short, full.split(' ')[0],
    'POS-001', position, 'Виробництво', status, '', '', '', '', '', '', '', '', '1111',
    '', '', '', '', '', '']);
}
refRows.push(['EMP-9001', 'Приходько90 Ярослав Ігорович', 'Приходько90 Я. І.', 'Приходько90',
  'POS-001', 'Вантажник', 'Виробництво', 'active', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
refRows.push(['EMP-9002', NAME.ambiguous, shortOf(NAME.ambiguous), NAME.ambiguous.split(' ')[0],
  'POS-011', 'Працівник', 'Виробництво', 'active', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']);
refRows.push(['EMP-9003', 'Адмін Адміністратор Адмінович', 'Адмін А. А.', 'Адмін', '', '', '',
  'active', '', '', '', '', '', '', 'admin@example.com', '', '9988', 'admin', '', '', '', '', '']);

const refSs = new Spreadsheet('ref-test', 'Довідник працівників');
refSs.addSheet('_REF_Employees', refRows.map(r => r.slice()), []);
refSs.addSheet('_REF_Aliases', [['варіант написання', 'emp_id', 'джерело', 'додано']], []);
__REGISTER_SS__(refSs);

// ------------------------------------------------------------------ тести
let failed = 0;
function assert(ok, msg) { console.log((ok ? '  ✓ ' : '  ✗ ') + msg); if (!ok) failed++; }

// Довідник і пошта задаються через властивості скрипта, як у реальній таблиці.
global.__PROPS__ = { REF_ID: 'ref-test', ADMIN_EMAILS: 'admin@example.test' };
const cfg = getConfig();

console.log('\n== Розкладка «Серпень 2026» ==');
const lay = analyzeLayout_(aug);
console.log('  ' + JSON.stringify({
  headerRow: lay.headerRow, dateRow: lay.dateRow, firstDayCol: lay.firstDayCol,
  dayCount: lay.dayCount, lastDayCol: lay.lastDayCol, shiftsCol: lay.shiftsCol, empIdCol: lay.empIdCol
}));
assert(lay.headerRow === 4 && lay.dateRow === 2 && lay.firstDayCol === 3 && lay.dayCount === 31 &&
  lay.lastDayCol === 64 && lay.shiftsCol === 65 && lay.empIdCol === 0, 'розкладку розпізнано вірно');

console.log('\n== Створення «Вересень 2026» ==');
const report = buildMonthSheet_(2026, 9, 'manual', cfg);
sendReportEmail_(report, cfg);
const sep = tsSs.getSheetByName('Вересень 2026');
assert(!!sep, 'аркуш «Вересень 2026» створено');
assert(sep.getIndex() === 3, 'стоїть одразу після «Серпень 2026»');

const l2 = analyzeLayout_(sep);
assert(l2.empIdCol === 3, 'emp_id — колонка C');
assert(l2.dayCount === 30, 'у вересні 30 колонок-днів');
assert(l2.firstDayCol === 4 && l2.lastDayCol === 63 && l2.shiftsCol === 64 && l2.hoursCol === 65,
  'дні та підсумки на місці');
assert(sep.get(1, 1) === 'Вересень 2026', 'заголовок A1');
assert(sep.get(4, 3) === 'emp_id', 'шапка emp_id');
assert(sep.getRange(2, 4).getDisplayValue() === '1/9' &&
  sep.getRange(2, 62).getDisplayValue() === '30/9', 'дати 1/9…30/9');
assert(sep.get(3, 4) === 'вівторок' && sep.get(3, 6) === 'середа',
  'дні тижня (1 вересня 2026 — вівторок)');
assert(sep.get(4, 4) === 'День' && sep.get(4, 5) === 'Ніч', 'День/Ніч');
assert(sep.get(2, 64) === 'за місяць' && sep.get(4, 64) === 'Змін' && sep.get(4, 65) === 'Годин',
  'шапка підсумків');
let stale = 0;
for (let c = 66; c <= sep.getMaxColumns(); c++) {
  if (['День', 'Ніч', 'Змін', 'Годин'].includes(sep.get(4, c))) stale++;
}
assert(stale === 0, 'залишки старої шапки праворуч прибрано');

let leftovers = 0, ids = 0, kept = 0, totalsLeft = 0;
for (let r = 5; r <= sep.getLastRow(); r++) {
  if (String(sep.get(r, 1)).trim()) kept++;
  if (String(sep.get(r, 3)).trim()) ids++;
  for (let c = l2.firstDayCol; c <= l2.lastDayCol; c++) if (String(sep.get(r, c)).trim()) leftovers++;
  for (let c = l2.shiftsCol; c <= l2.hoursCol; c++) if (String(sep.get(r, c)).trim()) totalsLeft++;
}
assert(leftovers === 0, 'години попереднього місяця очищено');
assert(kept === 46, 'усіх 46 працівників скопійовано (маємо ' + kept + ')');
assert(ids === 44, 'emp_id проставлено всім, крім «немає в довіднику» і «неоднозначно» (' + ids + ')');
assert(totalsLeft === 0, 'статичні підсумки очищено');

console.log('\n== Звірка з довідником ==');
const i = report.issues;
['notFound', 'fuzzy', 'ambiguous', 'fired', 'positionMismatch', 'duplicates',
  'missingInSheet', 'unknownId', 'idNameMismatch', 'refProblems'].forEach(k => {
    console.log('  ' + k + ': ' + i[k].length);
  });
assert(i.notFound.length === 1 && i.notFound[0].name === NAME.notInRef, 'ПІБ поза довідником');
assert(i.fuzzy.length === 1 && i.fuzzy[0].name === NAME.typo && i.fuzzy[0].distance === 1,
  'нечіткий збіг при друкарській помилці');
assert(i.fired.length === 1 && i.fired[0].name === NAME.fired, 'позначено звільненого');
assert(i.positionMismatch.length === 1 && i.positionMismatch[0].name === NAME.wrongPos,
  'розбіжність посади');
assert(i.ambiguous.length === 1 && i.ambiguous[0].name === NAME.ambiguous, 'неоднозначний збіг');
assert(i.missingInSheet.length === 1 && i.missingInSheet[0].empId === 'EMP-9001',
  'є в довіднику, немає в табелі: адмін і кандидати неоднозначного збігу не рахуються');
assert(report.matched.some(m => m.name === shortOf(NAME.initials) && m.how === 'прізвище + ініціали'),
  'збіг за прізвищем та ініціалами');
const aliases = refSs.getSheetByName('_REF_Aliases');
assert(aliases.getLastRow() === 2 && String(aliases.get(2, 1)) === NAME.typo,
  'варіант написання записано в довідник');

console.log('\n== Лист адміністратору ==');
const mail = (global.__MAIL__ || [])[0];
assert(!!mail, 'лист сформовано');
assert(/Вересень 2026/.test(mail.subject) && /⚠/.test(mail.subject), 'тема: ' + mail.subject);
assert(mail.htmlBody.indexOf(NAME.notInRef) > 0 && mail.htmlBody.indexOf('EMP-9001') > 0,
  'у листі перелічені невідповідності');
assert(mail.to === 'admin@example.test', 'лист пішов на адресу з налаштувань');
assert(mail.htmlBody.indexOf('https://example.test/timesheet-test') > 0,
  'посилання на табель узято з самої таблиці');

console.log('\n== Повторний запуск ==');
global.__MAIL__ = [];
const again = buildMonthSheet_(2026, 9, 'manual', cfg);
assert(again.skipped === true, 'аркуш не дублюється');
assert(tsSs.getSheets().filter(s => s.getName() === 'Вересень 2026').length === 1, 'аркуш один');
assert(analyzeLayout_(sep).dayCount === 30, 'структура не зіпсована');
assert(aliases.getLastRow() === 2, 'варіант написання не дублюється');
assert(again.issues.idNameMismatch.length === 0,
  'emp_id, проставлений за нечітким збігом, більше не вважається помилкою');

console.log('\n== Жовтень (31 день) з вересня (30) ==');
const oct = buildMonthSheet_(2026, 10, 'manual', cfg);
const octSheet = tsSs.getSheetByName('Жовтень 2026');
const l3 = analyzeLayout_(octSheet);
assert(l3.dayCount === 31, 'у жовтні 31 колонка-день');
assert(octSheet.getRange(2, l3.lastDayCol - 1).getDisplayValue() === '31/10', 'остання дата 31/10');
assert(octSheet.get(2, l3.shiftsCol) === 'за місяць' && octSheet.get(4, l3.shiftsCol) === 'Змін',
  'підсумки після розширення');
assert(l3.empIdCol === 3, 'emp_id збережено');
console.log('  ' + JSON.stringify(oct.structure));

console.log('\n== Налаштування ==');
assert(extractSpreadsheetId_('https://docs.google.com/spreadsheets/d/AbC-123_xY/edit?gid=7#gid=7')
  === 'AbC-123_xY', 'ID видобувається з посилання');
assert(extractSpreadsheetId_('AbC-123_xY') === 'AbC-123_xY', 'голий ID приймається як є');
assert(getConfig().ADMIN_EMAILS_LIST.length === 1, 'пошта читається з властивостей скрипта');
(function () {
  const saved = global.__PROPS__;
  global.__PROPS__ = { ADMIN_EMAILS: 'admin@example.test' };
  let msg = '';
  try { loadReference_(getConfig()); } catch (e) { msg = e.message; }
  assert(/Не вказано довідник/.test(msg), 'без довідника — зрозуміла помилка, а не збій: ' + msg);
  global.__PROPS__ = saved;
})();

console.log('\n== Розпізнавання назв аркушів ==');
assert(JSON.stringify(parseMonthSheetName_('Вересень 2026')) === '{"year":2026,"month":9}', 'Вересень 2026');
assert(parseMonthSheetName_('_Журнал_табелю') === null, 'службовий аркуш не є місяцем');
assert(monthSheetName_(2027, 1) === 'Січень 2027', 'назва наступного року');
assert(daysInMonth_(2028, 2) === 29, 'високосний лютий');
assert(normName_('  Іванчук   О.А. ') === normName_('Іванчук О.А.'), 'нормалізація пробілів');
assert(normName_('Kopoль Юpiй') === 'король юрій', 'латинські двійники кирилиці');

console.log('\n== Дати в шапці як справжні дати, а не текст ==');
// У Google Таблицях «1/8» може бути і текстом, і датою з форматом d/M.
// Перевіряємо другу гілку rebuildHeaders_.
const dateGrid = csv.map(r => { const c = r.slice(); while (c.length < WIDTH) c.push(''); return c.slice(0, WIDTH); });
for (let d = 0; d < 31; d++) dateGrid[1][2 + d * 2] = new Date(2026, 7, d + 1);
const ss2 = new Spreadsheet('ts-dates', 'Табель (дати)');
ss2.addSheet('Серпень 2026', dateGrid, merges.map(m => ({ ...m })));
__REGISTER_SS__(ss2);
global.__ACTIVE_SS__ = ss2;
const cfg2 = getConfig();
cfg2.TIMESHEET_ID = 'ts-dates';
cfg2.WRITE_LOG = false;
buildMonthSheet_(2026, 9, 'manual', cfg2);
const sepD = ss2.getSheetByName('Вересень 2026');
const layD = analyzeLayout_(sepD);
assert(sepD.get(2, layD.firstDayCol) instanceof Date, 'дати лишились датами, а не стали текстом');
assert(sepD.getRange(2, layD.firstDayCol).getDisplayValue() === '1/9', 'відображаються як 1/9');
assert(layD.dayCount === 30, 'кількість днів теж підігнана');
global.__ACTIVE_SS__ = tsSs;

console.log(failed ? '\n✗ ПОМИЛОК: ' + failed : '\n✓ УСІ ПЕРЕВІРКИ ПРОЙДЕНО');
process.exit(failed ? 1 : 0);
