/**
 * Міграція структури таблиці «ЗІП мех служба» до еталона
 * «Миючі та дезинфікуючі засоби».
 *
 * Аркуш-каталог:  10/11 колонок  →  14 колонок (A–N)
 * Лог_використання:      8 колонок  →  11 колонок (A–K)
 * Додається аркуш «Користувачі» (Контролери | Працівники | email).
 *
 * ЯК ЗАПУСКАТИ
 *   1. Розширення → Apps Script, додати цей файл у проєкт таблиці.
 *   2. Виконати migrateStructure() з DRY_RUN = true — буде лише звіт.
 *   3. Звірити звіт, поставити DRY_RUN = false і виконати ще раз.
 *
 * Скрипт нічого не видаляє: нові колонки ВСТАВЛЯЮТЬСЯ, наявні значення
 * зсуваються разом із форматуванням. Повторний запуск безпечний —
 * мігровані аркуші розпізнаються за шапкою і пропускаються.
 */

const DRY_RUN = true;

const LOG_SHEET_NAME = 'Лог_використання';
const USERS_SHEET_NAME = 'Користувачі';
const SERVICE_SHEETS = [LOG_SHEET_NAME, USERS_SHEET_NAME, 'Контакти', 'Довідник', 'Зведення', 'Історія'];

const CAT_HEADER_ROW3 = ['№', 'Модель / Тип', 'Обладнання де використовується', '', '',
  'Операція', 'Дата', 'Кількість', 'Заводський № / партія', 'Де було використано',
  'Ким було використано', '', 'Назва', 'Телефон'];
const CAT_MERGES = ['A2:C2', 'D2:D3', 'E2:E3', 'F2:K2', 'L2:L3', 'M2:N2'];
const DEFAULT_STOCK_DATE_HEADER = 'Залишок на ____.____.2026 (шт)';

const LOG_HEADER = ['Час запису', 'Дата використання', 'Категорія', '№', 'Назва', 'Вид операції',
  'Хто видав', 'Де використано', 'Заводський № / партія', 'Кількість', 'Ким було використано'];
const USERS_HEADER = ['Контролери', 'Працівники', 'email для відправки повідомлень'];

// «7шт- Галагін Євгеній Ярославович 21.08.26 (Twist off-натяжні ролики)»
const FRAGMENT_RE = /^\s*(\d+(?:[.,]\d+)?)\s*шт-\s*(.+?)\s+(\d{1,2}\.\d{1,2}\.\d{2,4})\s*\((.*)\)\s*$/;
const SPLIT_RE = /,\s*\n/;

// ==========================================
// Головна функція
// ==========================================
function migrateStructure() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const report = [DRY_RUN
    ? '=== DRY RUN: жодних змін не вноситься ==='
    : '=== ЗАСТОСУВАННЯ ЗМІН ==='];

  ss.getSheets().forEach((sheet) => {
    const name = sheet.getName();
    if (name === LOG_SHEET_NAME) { report.push(migrateLogSheet(sheet)); return; }
    if (SERVICE_SHEETS.indexOf(name) !== -1) { report.push('· ' + name + ': службовий аркуш, пропущено'); return; }
    report.push(migrateCategorySheet(sheet));
  });

  report.push(ensureUsersSheet(ss));

  const text = report.join('\n');
  console.log(text);
  try {
    SpreadsheetApp.getUi().alert(DRY_RUN ? 'Звіт (DRY RUN)' : 'Міграцію завершено',
      text.slice(0, 1400), SpreadsheetApp.getUi().ButtonSet.OK);
  } catch (e) { /* запуск не з таблиці — звіт лишається в журналі виконання */ }
  return text;
}

// ==========================================
// Аркуш-каталог
// ==========================================
function migrateCategorySheet(sheet) {
  const name = sheet.getName();
  const layout = detectLayout(sheet);

  if (layout === 'migrated') return '= ' + name + ': вже мігровано, пропущено';
  if (layout === 'unknown') return '! ' + name + ': не схожий на аркуш-каталог (рядок 3 ≠ «№ / Модель / Тип»), пропущено';

  const width = layout === 'no-date-col' ? 10 : 11;
  const lastRow = sheet.getLastRow();
  const dataRows = Math.max(lastRow - 3, 0);
  const before = dataRows ? sheet.getRange(4, 1, dataRows, width).getDisplayValues() : [];

  const parsedRows = before.map(parseOperations);
  const withHistory = parsedRows.filter((p) => p !== null);
  const unparsed = withHistory.filter((p) => !p.fullyParsed).length;
  const positions = before.filter((r) => String(r[1]).trim() !== '').length;

  const summary = '~ ' + name + ': ' + positions + ' позицій, ' + width + ' → 14 колонок' +
    (withHistory.length ? ', рядків з історією ' + withHistory.length +
      (unparsed ? ' (з них не розібрано ' + unparsed + ' — переносяться дослівно)' : '') : '') +
    (layout === 'no-date-col' ? ' [+ створюється колонка «Залишок на дату»]' : '');

  if (DRY_RUN) return summary;

  // Заголовки, які треба зберегти, читаємо ДО перебудови
  const row2 = sheet.getRange(2, 1, 1, width).getDisplayValues()[0];
  const title = row2[0];
  const minHeader = row2[3] || 'Мінімальни товарний залишок, шт';
  const stockDateHeader = (layout === 'with-date-col' ? row2[8] : '') || DEFAULT_STOCK_DATE_HEADER;

  // 1. Знімаємо об'єднання в шапці, щоб вставлення колонок їх не розтягнуло
  sheet.getRange(1, 1, 3, sheet.getMaxColumns()).breakApart();

  // 2. Вставляємо нові колонки (наявні значення зсуваються праворуч разом з форматом)
  sheet.insertColumnBefore(6);   // F — Операція
  sheet.insertColumnBefore(9);   // I — Заводський № / партія
  sheet.insertColumnBefore(11);  // K — Ким було використано
  if (layout === 'no-date-col') sheet.insertColumnBefore(12);  // L — Залишок на дату
  SpreadsheetApp.flush();

  // 3. Шапка за еталоном
  sheet.getRange(2, 1, 1, 14).setValues([[title, '', '', minHeader, 'Поточний залишок',
    'Операції', '', '', '', '', '', stockDateHeader, 'Постачальник', '']]);
  sheet.getRange(3, 1, 1, 14).setValues([CAT_HEADER_ROW3]);
  CAT_MERGES.forEach((a1) => sheet.getRange(a1).merge());
  sheet.getRange(2, 1, 2, 14).setFontWeight('bold').setHorizontalAlignment('center')
    .setVerticalAlignment('middle').setWrap(true);

  // 4. Заповнюємо нові колонки F..K
  if (dataRows) {
    const block = parsedRows.map((p) => p
      ? [p.ops, p.dates, p.qtys, p.batches, p.locations, p.people]
      : ['', '', '', '', '', '']);
    sheet.getRange(4, 6, dataRows, 6).setValues(block);
  }

  return summary.replace('~ ', '+ ');
}

/**
 * Розбирає накопичений текст старих колонок F/G/H в операції еталонного формату.
 * Повертає null, якщо історії немає.
 */
function parseOperations(row) {
  const oldDates = String(row[5] || '').trim();
  const oldQty = String(row[6] || '').trim();
  const oldText = String(row[7] || '').trim();
  if (!oldDates && !oldQty && !oldText) return null;

  const fragments = oldText ? oldText.split(SPLIT_RE).filter((s) => s.trim()) : [];
  const dates = oldDates ? oldDates.split(SPLIT_RE).map((s) => s.trim()) : [];
  const items = fragments.map((f) => FRAGMENT_RE.exec(f));
  const fullyParsed = fragments.length > 0 && items.every((m) => m !== null);

  if (!fullyParsed) {
    // Хоч один фрагмент написано вручну — переносимо все дослівно, нічого не вигадуючи
    return {
      ops: 'Видача', dates: oldDates, qtys: oldQty, batches: '-',
      locations: oldText, people: '-', fullyParsed: false
    };
  }

  const join = (arr) => arr.join(',\n');
  return {
    ops: join(items.map(() => 'Видача')),
    dates: join(items.map((m, i) => m[3] || dates[i] || '-')),
    qtys: join(items.map((m) => '-' + m[1].replace(',', '.'))),
    batches: join(items.map(() => '-')),
    locations: join(items.map((m) => m[4] || '-')),
    people: join(items.map((m) => m[2])),
    fullyParsed: true
  };
}

function detectLayout(sheet) {
  const h3 = readRow(sheet, 3, 14);
  if (h3[10] === 'Ким було використано' && h3[13] === 'Телефон') return 'migrated';
  if (String(h3[0]).trim() !== '№') return 'unknown';
  if (h3[9] === 'Назва' && h3[10] === 'Телефон') return 'with-date-col';  // 11 колонок
  if (h3[8] === 'Назва' && h3[9] === 'Телефон') return 'no-date-col';     // 10 колонок («Підшипники»)
  return 'unknown';
}

// ==========================================
// Лог_використання
// ==========================================
function migrateLogSheet(sheet) {
  const header = readRow(sheet, 1, 11);
  if (header[10] === 'Ким було використано') return '= ' + LOG_SHEET_NAME + ': вже мігровано, пропущено';
  if (String(header[0]).trim() !== 'Час запису') return '! ' + LOG_SHEET_NAME + ': несподівана шапка, пропущено';

  const rows = Math.max(sheet.getLastRow() - 1, 0);
  const summary = '~ ' + LOG_SHEET_NAME + ': ' + rows + ' записів, 8 → 11 колонок';
  if (DRY_RUN) return summary;

  sheet.insertColumnBefore(6);  // F — Вид операції
  sheet.insertColumnBefore(9);  // I — Заводський № / партія
  if (sheet.getMaxColumns() < 11) sheet.insertColumnsAfter(sheet.getMaxColumns(), 11 - sheet.getMaxColumns());
  SpreadsheetApp.flush();

  sheet.getRange(1, 1, 1, 11).setValues([LOG_HEADER]).setFontWeight('bold').setBackground('#d9ead3');
  sheet.setFrozenRows(1);

  if (rows) {
    const mechanics = sheet.getRange(2, 7, rows, 1).getDisplayValues();  // G — колишній «Механік»
    sheet.getRange(2, 6, rows, 1).setValues(mechanics.map(() => ['Видача']));
    sheet.getRange(2, 9, rows, 1).setValues(mechanics.map(() => ['-']));
    sheet.getRange(2, 11, rows, 1).setValues(mechanics.map((m) => [m[0] || '-']));
  }

  return summary.replace('~ ', '+ ');
}

// ==========================================
// Користувачі
// ==========================================
function ensureUsersSheet(ss) {
  const existing = ss.getSheetByName(USERS_SHEET_NAME);
  if (existing) return '= ' + USERS_SHEET_NAME + ': аркуш уже існує, не змінюється';
  if (DRY_RUN) return '~ ' + USERS_SHEET_NAME + ': буде створено (порожній, лише заголовки)';

  const sheet = ss.insertSheet(USERS_SHEET_NAME);
  sheet.getRange(1, 1, 1, 3).setValues([USERS_HEADER]).setFontWeight('bold').setBackground('#c9daf8');
  sheet.setFrozenRows(1);
  sheet.setColumnWidths(1, 3, 220);
  return '+ ' + USERS_SHEET_NAME + ': створено (заповніть вручну)';
}

// ==========================================
// Допоміжне
// ==========================================
function readRow(sheet, row, count) {
  const width = Math.min(count, sheet.getMaxColumns());
  const values = sheet.getRange(row, 1, 1, width).getDisplayValues()[0];
  while (values.length < count) values.push('');
  return values;
}
