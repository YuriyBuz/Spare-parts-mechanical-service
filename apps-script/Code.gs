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
 *
 * Це ЄДИНИЙ файл скрипта: автентифікація (розділ 0) і облік — разом,
 * щоб не було ситуації, коли одну з частин забули додати в проєкт.
 */

const CODE_VERSION = 'zip-2026-08-22-auth';

// ==========================================
// 0. АВТЕНТИФІКАЦІЯ ТА ПРАВА
// ==========================================
/**
 * Джерело: аркуш «_REF_Employees» таблиці gw-ref (окремий файл).
 *   A emp_id | B ПІБ повне | C ПІБ короткий | E pos_id | H статус
 *   Q PIN    | R ролі додатково | S ролі відібрані
 * Ролі посади — «_REF_Positions», колонка D.
 *
 * У клієнт НІКОЛИ не потрапляють: PIN, список співробітників, чужі ролі.
 */

const EMPLOYEES_SPREADSHEET_ID = '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8';
const EMPLOYEES_SHEET_NAME = '_REF_Employees';
const POSITIONS_SHEET_NAME = '_REF_Positions';

// Індекси колонок (0-based) в «_REF_Employees»
const EMP = { id: 0, fullName: 1, shortName: 2, posId: 4, status: 7, pin: 16, extraRoles: 17, finalRoles: 18 };
const EMP_WIDTH = 19;                 // A..S
const POS = { id: 0, roles: 3 };      // A..D

const SESSION_TTL_MINUTES = 12 * 60;  // одна зміна
const MAX_PIN_ATTEMPTS = 5;
const ATTEMPT_WINDOW_SECONDS = 300;

/**
 * Роль → дозволені дії. Єдине джерело правди: цю ж таблицю використовує
 * і сервер (перед кожним записом), і клієнт (щоб ховати недоступні кнопки).
 */
const ROLE_PERMISSIONS = {
  'zip.use':   ['registerUsage', 'registerInventory'],
  'zip.admin': ['registerUsage', 'registerInventory', 'registerRestock', 'forceReport'],
  'admin':     ['registerUsage', 'registerInventory', 'registerRestock', 'forceReport']
};

// ==========================================
// Вхід за PIN
// ==========================================
function loginWithPin_(pin, deviceId) {
  const cache = CacheService.getScriptCache();
  const attemptsKey = 'pin_attempts_' + (deviceId || 'unknown');
  const attempts = Number(cache.get(attemptsKey) || 0);
  if (attempts >= MAX_PIN_ATTEMPTS) {
    return fail_('THROTTLED', 'Забагато спроб. Спробуйте за 5 хвилин.');
  }

  const value = String(pin === null || pin === undefined ? '' : pin).trim();
  if (!value) return fail_('BAD_PIN', 'Введіть PIN');

  const matches = readEmployees_().filter(function (employee) {
    return employee.eligible && employee.pin === value;
  });

  if (matches.length === 0) {
    cache.put(attemptsKey, String(attempts + 1), ATTEMPT_WINDOW_SECONDS);
    Utilities.sleep(400);   // сповільнює перебір
    return fail_('BAD_PIN', 'Невірний PIN');
  }
  if (matches.length > 1) {
    // Не вгадуємо, хто саме — інакше запис піде не на ту людину
    return fail_('PIN_NOT_UNIQUE',
      'Цей PIN закріплений за кількома співробітниками. Зверніться до адміністратора, щоб вам призначили власний PIN.');
  }

  cache.remove(attemptsKey);
  const employee = matches[0];
  const expiresAt = Date.now() + SESSION_TTL_MINUTES * 60 * 1000;
  return {
    success: true,
    name: employee.name,
    shortName: employee.shortName,
    roles: employee.roles,
    permissions: employee.permissions,
    token: issueToken_(employee, deviceId, expiresAt),
    expiresAt: expiresAt
  };
}

// ==========================================
// Токен сесії: підписаний, без зберігання стану на сервері
// ==========================================
function issueToken_(employee, deviceId, expiresAt) {
  const body = Utilities.base64EncodeWebSafe(JSON.stringify({
    id: employee.id, e: expiresAt, d: deviceId || ''
  }));
  return body + '.' + sign_(body);
}

function sign_(body) {
  return Utilities.base64EncodeWebSafe(
    Utilities.computeHmacSha256Signature(body, getAuthSecret_()));
}

function getAuthSecret_() {
  const properties = PropertiesService.getScriptProperties();
  let secret = properties.getProperty('AUTH_SECRET');
  if (!secret) {
    secret = Utilities.getUuid() + Utilities.getUuid();
    properties.setProperty('AUTH_SECRET', secret);
  }
  return secret;
}

/**
 * Перевіряє токен і ЗАНОВО читає права з таблиці: звільнення або зміна
 * ролі діють негайно, не чекаючи закінчення сесії.
 */
function verifySession_(token, deviceId) {
  if (!token || String(token).indexOf('.') === -1) return null;

  const parts = String(token).split('.');
  if (sign_(parts[0]) !== parts[1]) return null;

  let payload;
  try {
    payload = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (error) {
    return null;
  }
  if (!payload.e || payload.e < Date.now()) return null;
  if (payload.d && deviceId && payload.d !== deviceId) return null;

  const employee = findEmployee_(payload.id);
  if (!employee || !employee.eligible) return null;

  return {
    id: employee.id,
    name: employee.name,
    shortName: employee.shortName,
    roles: employee.roles,
    permissions: employee.permissions,
    expiresAt: payload.e
  };
}

/**
 * Перевірка прав перед КОЖНИМ записом. Викидає помилку, якщо сесія
 * недійсна або дія не дозволена роллю.
 */
function requirePermission_(request, action) {
  const session = requireSession_(request);
  if (session.permissions.indexOf(action) === -1) {
    throw authError_('FORBIDDEN', 'Ваша роль не дозволяє цю дію: ' + action);
  }
  return session;
}

/** Будь-яка дія в застосунку потребує дійсної сесії. */
function requireSession_(request) {
  const session = verifySession_(request.token, request.deviceId);
  if (!session) throw authError_('AUTH', 'Сесію завершено. Увійдіть за PIN.');
  return session;
}

function authError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function fail_(code, message) {
  return { success: false, code: code, error: message };
}

// ==========================================
// Читання довідника співробітників
// ==========================================
function readEmployees_() {
  const ss = SpreadsheetApp.openById(EMPLOYEES_SPREADSHEET_ID);
  const sheet = ss.getSheetByName(EMPLOYEES_SHEET_NAME);
  if (!sheet) throw new Error('Аркуш «' + EMPLOYEES_SHEET_NAME + '» не знайдено');

  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const positionRoles = readPositionRoles_(ss);
  return sheet.getRange(2, 1, lastRow - 1, EMP_WIDTH).getDisplayValues()
    .filter(function (row) { return String(row[EMP.id]).trim() !== ''; })
    .map(function (row) {
      const roles = resolveRoles_(row, positionRoles);
      const permissions = permissionsFor_(roles);
      return {
        id: String(row[EMP.id]).trim(),
        name: String(row[EMP.fullName]).trim(),
        shortName: String(row[EMP.shortName] || row[EMP.fullName]).trim(),
        status: String(row[EMP.status]).trim().toLowerCase(),
        pin: String(row[EMP.pin]).trim(),
        roles: roles,
        permissions: permissions,
        eligible: String(row[EMP.status]).trim().toLowerCase() === 'active' && permissions.length > 0
      };
    });
}

function findEmployee_(id) {
  const wanted = String(id).trim();
  const found = readEmployees_().filter(function (employee) { return employee.id === wanted; });
  return found.length ? found[0] : null;
}

function readPositionRoles_(ss) {
  const sheet = ss.getSheetByName(POSITIONS_SHEET_NAME);
  const map = {};
  if (!sheet || sheet.getLastRow() < 2) return map;

  sheet.getRange(2, 1, sheet.getLastRow() - 1, 4).getDisplayValues().forEach(function (row) {
    const id = String(row[POS.id]).trim();
    if (id) map[id] = splitRoles_(row[POS.roles]);
  });
  return map;
}

/** «ролі відібрані» (S) мають пріоритет; інакше — ролі посади плюс «ролі додатково» (R). */
function resolveRoles_(row, positionRoles) {
  const explicit = splitRoles_(row[EMP.finalRoles]);
  if (explicit.length) return explicit;
  return splitRoles_(positionRoles[String(row[EMP.posId]).trim()])
    .concat(splitRoles_(row[EMP.extraRoles]));
}

/** У таблиці ролі розділені то пробілом, то комою — приймаємо обидва варіанти. */
function splitRoles_(value) {
  if (Array.isArray(value)) return value.slice();
  return String(value || '').split(/[\s,;]+/).filter(function (role) { return role !== ''; });
}

function permissionsFor_(roles) {
  const allowed = {};
  roles.forEach(function (role) {
    (ROLE_PERMISSIONS[role] || []).forEach(function (permission) { allowed[permission] = true; });
  });
  return Object.keys(allowed);
}

// ==========================================
// Службове: перевірка PIN-ів адміністратором
// ==========================================
/**
 * Друкує, кому доступний застосунок і чи не дублюються PIN-и.
 * Повні PIN не виводяться. Запускати з редактора Apps Script.
 */
function auditPins() {
  const eligible = readEmployees_().filter(function (employee) { return employee.eligible; });
  const byPin = {};
  eligible.forEach(function (employee) {
    const key = employee.pin || '(порожній)';
    (byPin[key] = byPin[key] || []).push(employee.name + ' [' + employee.roles.join(', ') + ']');
  });

  const lines = ['Доступ до ЗІП мають ' + eligible.length + ' співробітників:'];
  Object.keys(byPin).sort().forEach(function (pin) {
    const names = byPin[pin];
    const masked = pin === '(порожній)' ? pin : pin.charAt(0) + '***';
    lines.push((names.length > 1 ? '⚠ ' : '  ') + masked + ' → ' + names.join(' | ') +
      (names.length > 1 ? '   ← ДУБЛІКАТ: вхід за цим PIN неможливий' : ''));
  });
  const report = lines.join('\n');
  console.log(report);
  return report;
}

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
    const request = { token: e.parameter.token, deviceId: e.parameter.device };

    if (action === 'getInventory') {
      const session = requireSession_(request);   // застосунок закритий без входу за PIN
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
        employees: people.employees,
        // Права перечитуються щозавантаження: зміна ролі діє одразу
        session: { name: session.name, shortName: session.shortName, permissions: session.permissions }
      });
    }

    if (action === 'getHistory') {
      requireSession_(request);
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

    // Діагностика розгортання: відкрити URL з ?action=ping у браузері
    if (action === 'ping') {
      let employeesSheet = 'недоступний';
      try {
        employeesSheet = SpreadsheetApp.openById(EMPLOYEES_SPREADSHEET_ID)
          .getSheetByName(EMPLOYEES_SHEET_NAME) ? 'ok' : 'аркуш не знайдено';
      } catch (error) { employeesSheet = 'немає доступу'; }
      return json({
        success: true,
        version: CODE_VERSION,
        auth: typeof loginWithPin_ === 'function',
        employeesSheet: employeesSheet
      });
    }

    if (action === 'forceReport') {
      requirePermission_(request, 'forceReport');
      sendPurchasePlan(true);
      return json({ success: true, message: 'План надіслано' });
    }

    return json({ success: false, error: 'Unknown action' });
  } catch (error) {
    return json({ success: false, code: error.code || 'ERROR', error: error.message || String(error) });
  }
}

// ==========================================
// 2. POST — операції
// ==========================================
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    // Вхід за PIN — єдина дія, доступна без сесії
    if (payload.action === 'login') {
      return json(loginWithPin_(payload.pin, payload.deviceId));
    }

    const operation = OPERATIONS[payload.action];
    if (!operation) throw new Error('Невідома операція: ' + payload.action);

    // Права перевіряються на сервері перед кожним записом — незалежно від того,
    // що показує або ховає інтерфейс
    const session = requirePermission_(payload, payload.action);

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(payload.sheetName);
    if (!sheet) throw new Error('Аркуш не знайдено: ' + payload.sheetName);

    const quantity = Number(payload.quantity);
    if (!isFinite(quantity) || quantity <= 0) throw new Error('Некоректна кількість: ' + payload.quantity);

    const itemNo = sheet.getRange(payload.row, 1).getValue();
    const serial = String(payload.serial || '').trim() || '-';
    // Хто видав — завжди з підтвердженої сесії, а не з того, що надіслав клієнт
    const controller = session.name;
    // Для поповнення та інвентаризації фіксуємо, хто саме їх зробив
    const usedBy = payload.action === 'registerUsage'
      ? (String(payload.usedBy || '').trim() || session.name)
      : session.name;
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

    return json({ success: true, newStock: newVal, actor: session.name });
  } catch (error) {
    return json({ success: false, code: error.code || 'ERROR', error: error.message || String(error) });
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
