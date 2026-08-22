/**
 * «Облік ЗІП: Механік» — серверна частина (Google Apps Script).
 * Структура таблиці — за еталоном «Миючі та дезинфікуючі засоби»:
 *
 *   Аркуш-каталог (дані з рядка 4), 14 колонок:
 *     A №            B Модель / Тип   C Обладнання      D Мін. залишок
 *     E Залишок      F Операція       G Дата            H Кількість
 *     I Заводський № / партія         J Де використано  K Ким було використано
 *     L Залишок на дату               M Постачальник    N Телефон
 *
 *   Лог_використання, 11 колонок:
 *     A Час запису   B Дата          C Категорія  D №          E Назва
 *     F Вид операції G Хто видав     H Де використано
 *     I Заводський № / партія        J Кількість  K Ким було використано
 *
 *   Користувачі: A Контролери | B Працівники | C email
 */

const LOG_SHEET_NAME = 'Лог_використання';
const USERS_SHEET_NAME = 'Користувачі';
const SERVICE_SHEETS = [LOG_SHEET_NAME, USERS_SHEET_NAME, 'Контакти', 'Довідник', 'Зведення', 'Історія'];

// Використовується, доки аркуш «Користувачі» не заповнено.
const FALLBACK_EMAILS = 'Buznitskiy7@gmail.com, dyndarnastia@gmail.com';

// Порожня комірка залишку означає «не інвентаризовано», а не «нуль на складі».
// true  — такі позиції не потрапляють у план закупки (на 22.08.2026 це 48 рядків зі 189);
// false — стара поведінка: порожньо = 0 і позиція завжди в плані.
const SKIP_UNCOUNTED_POSITIONS = true;

const CAT_WIDTH = 14;   // A..N
const LOG_WIDTH = 11;   // A..K
const FIRST_DATA_ROW = 4;

const OPERATIONS = {
  registerUsage:      { label: 'Видача',         prefix: '-' },
  registerRestock:    { label: 'Поповнення',     prefix: '+' },
  registerInventory:  { label: 'Інвентаризація', prefix: '=' }
};

// ==========================================
// 0. МЕНЮ
// ==========================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚙️ Меню ЗІП')
    .addItem('🧹 Очистити дані операцій (F–K)', 'clearUsageData')
    .addItem('📧 Відправити план закупки зараз', 'manualSendReport')
    .addToUi();
}

function clearUsageData() {
  const ui = SpreadsheetApp.getUi();
  const response = ui.alert('Увага!',
    'Очистити колонки операцій (F–K) на ВСІХ аркушах?\n(Історія у «' + LOG_SHEET_NAME + '» залишиться цілою)',
    ui.ButtonSet.YES_NO);
  if (response !== ui.Button.YES) return;

  forEachCatalogSheet((sheet) => {
    const lastRow = sheet.getLastRow();
    if (lastRow >= FIRST_DATA_ROW) {
      sheet.getRange(FIRST_DATA_ROW, 6, lastRow - FIRST_DATA_ROW + 1, 6).clearContent();
    }
  });
  ui.alert('Готово', 'Дані про операції очищено.', ui.ButtonSet.OK);
}

function manualSendReport() {
  sendPurchasePlan(true);
  SpreadsheetApp.getUi().alert('Готово', 'План закупки надіслано.', SpreadsheetApp.getUi().ButtonSet.OK);
}

// ==========================================
// 1. GET
// ==========================================
function doGet(e) {
  try {
    const action = e.parameter.action;

    if (action === 'getInventory') {
      const people = readPeople();
      const categories = [];

      forEachCatalogSheet((sheet) => {
        const values = readCatalog(sheet);
        const items = [];
        values.forEach((row, i) => {
          if (!row[1] || String(row[1]).trim() === '') return;
          items.push({
            sheetName: sheet.getName(),
            row: i + FIRST_DATA_ROW,
            no: row[0] || '-',
            model: String(row[1]),
            equipment: String(row[2] || ''),
            minStock: toNumber(row[3]),
            currentStock: toNumber(row[4]),
            hasStock: String(row[4]).trim() !== '',   // порожньо ≠ нуль
            supplierName: String(row[12] || ''),
            supplierPhone: String(row[13] || '')
          });
        });
        if (items.length) categories.push({ name: sheet.getName(), items: items });
      });

      return json({
        success: true,
        categories: categories,
        controllers: people.controllers,
        employees: people.employees
      });
    }

    if (action === 'getHistory') {
      const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
      if (!logSheet || logSheet.getLastRow() < 2) return json({ success: true, history: [] });

      const data = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, LOG_WIDTH).getValues();
      const history = [];
      for (let i = data.length - 1; i >= 0 && history.length < 100; i--) {
        history.push({
          time: formatTime(data[i][0]),
          date: data[i][1],
          sheetName: data[i][2],
          model: data[i][4],
          actionType: data[i][5],
          controller: data[i][6],
          location: data[i][7],
          serial: data[i][8],
          quantity: data[i][9],
          usedBy: data[i][10]
        });
      }
      return json({ success: true, history: history });
    }

    if (action === 'forceReport') {
      sendPurchasePlan(true);
      return json({ success: true, message: 'План надіслано' });
    }

    return json({ success: false, error: 'Unknown action' });
  } catch (error) {
    return json({ success: false, error: error.toString() });
  }
}

// ==========================================
// 2. POST — операції
// ==========================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    const operation = OPERATIONS[payload.action];
    if (!operation) throw new Error('Невідома операція: ' + payload.action);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(payload.sheetName);
    if (!sheet) throw new Error('Аркуш не знайдено: ' + payload.sheetName);

    const quantity = Number(payload.quantity);
    if (!isFinite(quantity) || quantity <= 0) throw new Error('Некоректна кількість: ' + payload.quantity);

    const itemNo = sheet.getRange(payload.row, 1).getValue();
    const serial = String(payload.serial || '').trim() || '-';
    const controller = payload.controller || payload.mechanic || '-';
    const usedBy = payload.action === 'registerUsage' ? (payload.usedBy || controller) : '-';
    const location = payload.location || '-';

    // 2.1 Журнал
    setupLogSheet().appendRow([
      payload.timestamp, payload.date, payload.sheetName, itemNo, payload.model,
      operation.label, controller, location, serial, quantity, usedBy
    ]);

    // 2.2 Залишок (E)
    const stockCell = sheet.getRange(payload.row, 5);
    const minStock = toNumber(sheet.getRange(payload.row, 4).getValue());
    const currentVal = toNumber(stockCell.getValue());
    let newVal = currentVal;
    if (payload.action === 'registerUsage') newVal = currentVal - quantity;
    else if (payload.action === 'registerRestock') newVal = currentVal + quantity;
    else if (payload.action === 'registerInventory') newVal = quantity;
    stockCell.setValue(newVal);

    // 2.3 Накопичувальні колонки F..K
    appendOperation(sheet, payload.row, [
      operation.label,
      formatDate(payload.date),
      operation.prefix + quantity,
      serial,
      location,
      usedBy
    ]);

    // 2.4 Сповіщення про досягнення мінімуму
    if ((payload.action === 'registerUsage' || payload.action === 'registerInventory') && newVal <= minStock) {
      sendPurchasePlan(false);
    }

    return json({ success: true, newStock: newVal });
  } catch (error) {
    return json({ success: false, error: error.toString() });
  }
}

/** Дописує операцію в колонки F..K через кому з переносом рядка. */
function appendOperation(sheet, row, values) {
  const range = sheet.getRange(row, 6, 1, 6);
  const old = range.getDisplayValues()[0];
  range.setValues([values.map((value, i) => {
    const previous = String(old[i] || '').trim();
    const next = previous ? previous + ',\n' + value : String(value);
    // Апостроф не дає таблиці перетворити перелік дат на власний формат
    return (i === 1 || i === 2) ? "'" + next : next;
  })]);
}

// ==========================================
// 3. ПЛАН ЗАКУПКИ
// ==========================================
function sendPurchasePlan(isManual) {
  const targetEmails = getNotificationEmails();
  if (!targetEmails) return;

  const usage30 = collectUsage30();
  let needsOrder = false;
  let rows = '';

  forEachCatalogSheet((sheet) => {
    const sheetName = sheet.getName();
    readCatalog(sheet).forEach((row) => {
      if (!row[1] || String(row[1]).trim() === '') return;
      const stockFilled = String(row[4]).trim() !== '';
      if (SKIP_UNCOUNTED_POSITIONS && !stockFilled) return;   // не інвентаризовано — не вигадуємо дефіцит

      const model = String(row[1]);
      const minStock = toNumber(row[3]);
      const currentStock = toNumber(row[4]);
      if (currentStock > minStock) return;

      needsOrder = true;
      const used30 = usage30[sheetName + '_' + model] || 0;
      const recommendBuy = Math.max(minStock - currentStock, used30);

      rows += '<tr>' +
        td(sheetName) + td('<strong>' + model + '</strong>') + td(row[2] || '-') +
        td(minStock, 'center') +
        td(currentStock, 'center', 'color:#b91c1c; font-weight:bold;') +
        td(used30 + ' шт.', 'center') +
        td(recommendBuy + ' шт.', 'center', 'color:#047857; font-weight:bold;') +
        td(row[12] || '-') + td(row[13] || '-') +
        '</tr>';
    });
  });

  if (needsOrder) {
    MailApp.sendEmail({
      to: targetEmails,
      subject: '🚨 УВАГА! План закупки ЗІП (Потрібне поповнення)',
      htmlBody: buildReportHtml(rows)
    });
  } else if (isManual) {
    MailApp.sendEmail({
      to: targetEmails,
      subject: '✅ ЗІП: План закупки пустий',
      body: 'Усі запчастини в межах норми (більше мінімальних залишків). Закупівля не потрібна.'
    });
  }
}

/** Витрата за 30 днів — лише операції «Видача». */
function collectUsage30() {
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const usage = {};
  if (!logSheet || logSheet.getLastRow() < 2) return usage;

  const data = logSheet.getRange(2, 1, logSheet.getLastRow() - 1, LOG_WIDTH).getValues();
  const since = new Date();
  since.setDate(since.getDate() - 30);

  data.forEach((row) => {
    if (row[5] !== 'Видача') return;
    const when = new Date(row[0]);
    if (isNaN(when.getTime()) || when < since) return;
    const key = row[2] + '_' + row[4];
    usage[key] = (usage[key] || 0) + toNumber(row[9]);
  });
  return usage;
}

function buildReportHtml(rows) {
  return "<h2 style='color:#1e293b; font-family: sans-serif;'>План закупки запасних частин (Залишок ≤ Мінімуму)</h2>" +
    "<table border='1' cellpadding='8' style='border-collapse: collapse; font-family: sans-serif; width: 100%; border-color: #cbd5e1;'>" +
    "<tr style='background-color: #f1f5f9; color: #0f172a;'>" +
    '<th>Категорія</th><th>Модель / Тип</th><th>Обладнання</th><th>Мін. Запас</th>' +
    "<th style='color:#b91c1c;'>Поточний Залишок</th><th>Використано за 30 днів</th>" +
    '<th>Рекомендовано замовити</th><th>Постачальник</th><th>Телефон</th></tr>' +
    rows + '</table>' +
    "<br><p style='font-size:12px; color:#64748b; font-family: sans-serif;'>Звіт згенеровано автоматично системою «Облік ЗІП».</p>";
}

function td(value, align, extra) {
  const style = (align ? 'text-align:' + align + ';' : '') + (extra || '');
  return style ? "<td style='" + style + "'>" + value + '</td>' : '<td>' + value + '</td>';
}

// ==========================================
// 4. ДОВІДКОВІ ДАНІ
// ==========================================
function readPeople() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(USERS_SHEET_NAME);
  const people = { controllers: [], employees: [], emails: [] };
  if (!sheet || sheet.getLastRow() < 2) return people;

  sheet.getRange(2, 1, sheet.getLastRow() - 1, 3).getValues().forEach((row) => {
    const controller = String(row[0] || '').trim();
    const employee = String(row[1] || '').trim();
    const email = String(row[2] || '').trim();
    if (controller) people.controllers.push(controller);
    if (employee) people.employees.push(employee);
    if (email && email.indexOf('@') !== -1) people.emails.push(email);
  });
  return people;
}

function getNotificationEmails() {
  const emails = readPeople().emails;
  return emails.length ? emails.join(',') : FALLBACK_EMAILS;
}

function setupLogSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(LOG_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(LOG_SHEET_NAME);
    sheet.appendRow(['Час запису', 'Дата використання', 'Категорія', '№', 'Назва', 'Вид операції',
      'Хто видав', 'Де використано', 'Заводський № / партія', 'Кількість', 'Ким було використано']);
    sheet.getRange(1, 1, 1, LOG_WIDTH).setFontWeight('bold').setBackground('#d9ead3');
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ==========================================
// 5. СЛУЖБОВЕ
// ==========================================
function forEachCatalogSheet(callback) {
  SpreadsheetApp.getActiveSpreadsheet().getSheets().forEach((sheet) => {
    if (SERVICE_SHEETS.indexOf(sheet.getName()) !== -1) return;
    if (sheet.getLastRow() < FIRST_DATA_ROW) return;
    callback(sheet);
  });
}

function readCatalog(sheet) {
  return sheet.getRange(FIRST_DATA_ROW, 1, sheet.getLastRow() - FIRST_DATA_ROW + 1, CAT_WIDTH).getValues();
}

function toNumber(value) {
  if (value === '' || value === '-' || value === null || value === undefined) return 0;
  const n = Number(String(value).replace(',', '.'));
  return isFinite(n) ? n : 0;
}

function formatDate(isoDate) {
  if (!isoDate || String(isoDate).indexOf('-') === -1) return isoDate;
  const parts = String(isoDate).split('-');
  return parts[2] + '.' + parts[1] + '.' + parts[0].substring(2);
}

function formatTime(value) {
  const date = new Date(value);
  return isNaN(date.getTime()) ? '' : Utilities.formatDate(date, Session.getScriptTimeZone(), 'HH:mm');
}

function json(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

// ==========================================
// 6. ЩОТИЖНЕВИЙ ТРИГЕР (понеділок, 08:00)
// ==========================================
function setupMondayTrigger() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === 'weeklyPurchasePlan') ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('weeklyPurchasePlan').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
}

/** Обгортка: тригер передає у функцію об'єкт події, а не прапорець isManual. */
function weeklyPurchasePlan() {
  sendPurchasePlan(false);
}
