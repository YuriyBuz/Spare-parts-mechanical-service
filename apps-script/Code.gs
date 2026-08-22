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

const CODE_VERSION = 'zip-2026-08-22-recipients';

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
const EMP = { id: 0, fullName: 1, shortName: 2, posId: 4, status: 7, email: 14, pin: 16, extraRoles: 17, finalRoles: 18 };
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
  'zip.use':   ['registerUsage', 'cancelOwn'],
  'zip.admin': ['registerUsage', 'registerRestock', 'registerInventory', 'forceReport',
                'cancelOwn', 'cancelAny', 'manageStorage'],
  'admin':     ['registerUsage', 'registerRestock', 'registerInventory', 'forceReport',
                'cancelOwn', 'cancelAny', 'manageStorage']
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
        email: String(row[EMP.email]).trim(),
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

/**
 * Друкує, кому піде звіт і чому. Запускати з редактора Apps Script.
 */
function auditRecipients() {
  const recipients = reportRecipients_();
  const lines = recipients.length
    ? ['Звіт отримають ' + recipients.length + ' співробітників (з колонки O «_REF_Employees»):']
    : ['У довіднику немає жодного співробітника з правом на звіт і заповненим email.'];

  recipients.forEach(function (person) {
    lines.push('  ' + person.name + ' [' + person.roles.join(', ') + '] → ' + person.email);
  });

  // Хто має право на звіт, але без email — найчастіша причина «мені не приходить»
  const missing = readEmployees_().filter(function (employee) {
    return employee.eligible && employee.permissions.indexOf('forceReport') !== -1 &&
      employee.email.indexOf('@') === -1;
  });
  missing.forEach(function (person) {
    lines.push('  ⚠ ' + person.name + ' [' + person.roles.join(', ') + '] — право є, email у колонці O порожній');
  });

  if (!recipients.length) {
    lines.push('Поки що листи йдуть на запасний список: ' + FALLBACK_EMAILS);
  }

  const report = lines.join('\n');
  console.log(report);
  return report;
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

const CAT_WIDTH = 15;   // A..N + O «Місце зберігання»
const EXCESS_FACTOR = 5;     // залишок у стільки разів вище мінімуму = надлишок
const MOVEMENT_DAYS = 7;     // період блоку «Рух»
// Основні засоби: у план закупки не потрапляють (верстати, насоси тощо)
const ASSET_SHEET_PREFIXES = ['Інструменти', 'Контейнер та приміщення'];
const STORAGE_COL = 15; // O
const STORAGE_HEADER = 'Місце зберігання';
const LOG_WIDTH = 11;   // A..K
const FIRST_DATA_ROW = 4;

const OPERATIONS = {
  registerUsage:      { label: 'Видача',         prefix: '-', genitive: 'видачі',         direction: -1 },
  registerRestock:    { label: 'Поповнення',     prefix: '+', genitive: 'поповнення',     direction: 1 },
  registerInventory:  { label: 'Інвентаризація', prefix: '=', genitive: 'інвентаризації', direction: 0 }
};

const CANCELLED_SUFFIX = ' (скасовано)';
const CANCEL_PREFIX = 'Скасування ';
const CANCEL_WINDOW_HOURS = 24;

// ==========================================
// 0. МЕНЮ
// ==========================================
function onOpen() {
  SpreadsheetApp.getUi().createMenu('⚙️ Меню ЗІП')
    .addItem('🧹 Очистити дані операцій (F–K)', 'clearUsageData')
    .addItem('📧 Надіслати звіт зараз', 'manualSendReport')
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
  const report = sendReport(true);
  const message = report
    ? 'Звіт надіслано.\n\nДо замовлення: ' + report.counts.deficit +
      '\nПотребує інвентаризації: ' + report.counts.notCounted +
      '\nВід\'ємний залишок: ' + report.counts.negative +
      '\nНадлишок: ' + report.counts.excess
    : 'Немає жодної адреси для розсилки: заповніть колонку C аркуша «Користувачі».';
  SpreadsheetApp.getUi().alert('Готово', message, SpreadsheetApp.getUi().ButtonSet.OK);
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
            supplierPhone: String(row[13] || ''),
            storage: String(row[14] || '').trim()
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
        const actionType = String(data[i][5]).trim();
        history.push({
          id: normalizeTimestamp_(data[i][0]),
          cancelled: actionType.indexOf(CANCELLED_SUFFIX) !== -1,
          isCancellation: actionType.indexOf(CANCEL_PREFIX) === 0,
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
      const report = sendReport(true);
      if (!report) return json({ success: false, code: 'NO_RECIPIENTS',
        error: 'Немає адрес для розсилки: заповніть колонку C аркуша «Користувачі».' });
      return json({ success: true, message: 'Звіт надіслано', counts: report.counts });
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
    if (payload.action === 'cancelOperation') {
      return json(cancelOperation_(payload));
    }
    if (payload.action === 'setStorage') {
      return json(setStorage_(payload));
    }
    return json(registerOperation_(payload));

  } catch (error) {
    return json({ success: false, code: error.code || 'ERROR', error: error.message || String(error) });
  }
}

/**
 * Видача / поповнення / інвентаризація.
 * Запис у журнал — джерело правди; залишок перераховується з журналу.
 */
function registerOperation_(payload) {
  const operation = OPERATIONS[payload.action];
  if (!operation) throw new Error('Невідома операція: ' + payload.action);

  // Права перевіряються на сервері перед кожним записом — незалежно від того,
  // що показує або ховає інтерфейс
  const session = requirePermission_(payload, payload.action);

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(payload.sheetName);
  if (!sheet) throw new Error('Аркуш не знайдено: ' + payload.sheetName);

  const quantity = Number(payload.quantity);
  const zeroAllowed = payload.action === 'registerInventory';
  if (!isFinite(quantity) || quantity < 0 || (quantity === 0 && !zeroAllowed)) {
    throw new Error('Некоректна кількість: ' + payload.quantity);
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw authError_('BUSY', 'Сервер зайнятий іншим записом. Спробуйте ще раз.');
  try {
    const log = readLog_();

    // Той самий запис міг прийти вдруге з офлайн-черги — повторно не застосовуємо
    const duplicate = findLogEntry_(log, payload.timestamp);
    if (duplicate) {
      return { success: true, duplicate: true, actor: session.name,
               newStock: readStock_(sheet, payload.row).value };
    }

    const stock = readStock_(sheet, payload.row);
    let location = String(payload.location || '').trim() || '-';
    let discrepancy = null;

    if (payload.action === 'registerInventory') {
      // Фіксуємо фактичний залишок і те, наскільки він розійшовся з обліковим.
      // Історія не затирається: попередні рядки лишаються, додається новий.
      const accounted = stock.counted
        ? computeStockFromLog_(log, payload.sheetName, payload.model, stock.value)
        : null;
      discrepancy = {
        accounted: accounted,
        fact: quantity,
        delta: accounted === null ? null : Math.round((quantity - accounted) * 1000) / 1000
      };
      const note = accounted === null
        ? 'Інвентаризація: облік — (не рахували), факт ' + quantity
        : 'Інвентаризація: облік ' + accounted + ', факт ' + quantity +
          ' (' + (discrepancy.delta > 0 ? '+' : '') + discrepancy.delta + ')';
      location = location === '-' ? note : location + ' · ' + note;
    }

    if (payload.action === 'registerUsage') {
      if (!stock.counted) {
        throw authError_('NOT_COUNTED',
          'Залишок цієї позиції не інвентаризовано. Спершу проведіть інвентаризацію — тоді видача матиме від чого відніматися.');
      }
      const available = computeStockFromLog_(log, payload.sheetName, payload.model, stock.value);
      if (quantity > available) {
        const reason = String(payload.overdrawReason || '').trim();
        if (reason.length < 3) {
          return {
            success: false, code: 'OVERDRAW', available: available,
            error: available > 0
              ? 'На складі лише ' + available + ' шт, а ви списуєте ' + quantity + '.'
              : 'На складі 0 шт: зареєструйте поповнення або проведіть інвентаризацію.'
          };
        }
        location += ' (перевитрата: ' + reason + ')';
      }
    }

    const itemNo = sheet.getRange(payload.row, 1).getValue();
    const serial = String(payload.serial || '').trim() || '-';
    // Хто видав і ким використано — завжди з підтвердженої сесії,
    // а не з того, що надіслав клієнт
    const actor = session.name;

    const entry = [payload.timestamp, payload.date, payload.sheetName, itemNo, payload.model,
      operation.label, actor, location, serial, quantity, actor];
    log.sheet.appendRow(entry);
    log.rows.push({ row: log.sheet.getLastRow(), values: entry });

    const newVal = applyStock_(sheet, payload.row, log, payload.sheetName, payload.model, stock, operation, quantity);

    appendOperation(sheet, payload.row, [
      operation.label, formatDate(payload.date), operation.prefix + quantity, serial, location, actor
    ]);

    // Сповіщення лише про перетин порогу — не лист після кожного списання
    if (payload.action === 'registerUsage' || payload.action === 'registerInventory') {
      const info = readItemRow_(sheet, payload.row);
      maybeNotifyThreshold_({
        sheetName: payload.sheetName, model: payload.model,
        equipment: String(info[2] || '').trim() || '—',
        minStock: toNumber(info[3]), stock: newVal,
        supplier: String(info[12] || '').trim() || '—',
        phone: String(info[13] || '').trim() || '—',
        storage: String(info[14] || '').trim() || '—'
      });
    }

    return {
      success: true, newStock: newVal, actor: actor, discrepancy: discrepancy,
      warning: newVal < 0 ? 'Залишок від\'ємний — проведіть інвентаризацію цієї позиції.' : ''
    };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Скасування операції. Рядок журналу не видаляється: початковий помічається
 * як скасований, а поруч дописується рядок «Скасування …» — видно, хто і коли.
 */
function cancelOperation_(payload) {
  const session = requireSession_(payload);

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw authError_('BUSY', 'Сервер зайнятий іншим записом. Спробуйте ще раз.');
  try {
    const log = readLog_();
    const entry = findLogEntry_(log, payload.timestamp);
    if (!entry) throw authError_('NOT_FOUND', 'Операцію не знайдено в журналі.');

    const label = String(entry.values[5]).trim();
    if (label.indexOf(CANCELLED_SUFFIX) !== -1) throw authError_('ALREADY_CANCELLED', 'Цю операцію вже скасовано.');
    if (label.indexOf(CANCEL_PREFIX) === 0) throw authError_('BAD_TARGET', 'Це рядок скасування — його не скасовують.');
    if (label === OPERATIONS.registerInventory.label) {
      throw authError_('BAD_TARGET', 'Інвентаризацію не скасовують: проведіть нову — вона задає залишок наново.');
    }

    const operation = operationByLabel_(label);
    if (!operation) throw authError_('BAD_TARGET', 'Невідомий тип операції: ' + label);

    const author = String(entry.values[10]).trim() || String(entry.values[6]).trim();
    const own = author === session.name || String(entry.values[6]).trim() === session.name;
    if (own && session.permissions.indexOf('cancelOwn') === -1) {
      throw authError_('FORBIDDEN', 'Ваша роль не дозволяє скасовувати операції.');
    }
    if (!own && session.permissions.indexOf('cancelAny') === -1) {
      throw authError_('FORBIDDEN', 'Скасувати чужу операцію може лише zip.admin або admin.');
    }

    const when = new Date(entry.values[0]);
    const hours = isNaN(when.getTime()) ? 0 : (Date.now() - when.getTime()) / 3600000;
    if (hours > CANCEL_WINDOW_HOURS && session.permissions.indexOf('cancelAny') === -1) {
      throw authError_('TOO_LATE', 'Скасувати власну операцію можна протягом ' + CANCEL_WINDOW_HOURS + ' годин.');
    }

    const sheetName = String(entry.values[2]).trim();
    const model = String(entry.values[4]).trim();
    const quantity = toNumber(entry.values[9]);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(sheetName);
    if (!sheet) throw authError_('NOT_FOUND', 'Аркуш не знайдено: ' + sheetName);
    const itemRow = findItemRow_(sheet, model, entry.values[3]);
    if (!itemRow) throw authError_('NOT_FOUND', 'Позицію «' + model + '» не знайдено на аркуші «' + sheetName + '».');

    // 1. Помічаємо початкову операцію
    log.sheet.getRange(entry.row, 6).setValue(label + CANCELLED_SUFFIX);
    entry.values[5] = label + CANCELLED_SUFFIX;

    // 2. Дописуємо рядок скасування
    const now = new Date();
    const note = 'Скасовано операцію від ' + formatTimestamp_(entry.values[0]);
    const cancelEntry = [now.toISOString(), Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      sheetName, entry.values[3], model, CANCEL_PREFIX + operation.genitive, session.name,
      note, String(entry.values[8] || '-'), quantity, session.name];
    log.sheet.appendRow(cancelEntry);
    log.rows.push({ row: log.sheet.getLastRow(), values: cancelEntry });

    // 3. Перераховуємо залишок
    const stock = readStock_(sheet, itemRow);
    const restored = -operation.direction * quantity;   // скасування видачі повертає на склад
    const newVal = applyStock_(sheet, itemRow, log, sheetName, model, stock, { direction: 1 }, restored);

    appendOperation(sheet, itemRow, [
      CANCEL_PREFIX + operation.genitive,
      Utilities.formatDate(now, Session.getScriptTimeZone(), 'dd.MM.yy'),
      (restored >= 0 ? '+' : '') + restored, String(entry.values[8] || '-'), note, session.name
    ]);

    return { success: true, newStock: newVal, actor: session.name, cancelled: label };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Адресне зберігання: змінює місце позиції (колонка O) і лишає слід у журналі.
 * Кількість у такому рядку — 0, тож на залишок і на витрату він не впливає.
 */
function setStorage_(payload) {
  const session = requirePermission_(payload, 'manageStorage');

  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(payload.sheetName);
  if (!sheet) throw new Error('Аркуш не знайдено: ' + payload.sheetName);

  const storage = String(payload.storage || '').trim();
  if (storage.length > 60) throw new Error('Задовга адреса зберігання');

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw authError_('BUSY', 'Сервер зайнятий іншим записом. Спробуйте ще раз.');
  try {
    ensureStorageColumn_(sheet);
    const cell = sheet.getRange(payload.row, STORAGE_COL);
    const previous = String(cell.getDisplayValue()).trim();
    if (previous === storage) return { success: true, storage: storage, unchanged: true };

    cell.setValue(storage);

    const now = new Date();
    setupLogSheet().appendRow([
      now.toISOString(), Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd'),
      payload.sheetName, sheet.getRange(payload.row, 1).getValue(), payload.model,
      'Зміна місця', session.name,
      'Місце: ' + (previous || '—') + ' → ' + (storage || '—'), '-', 0, session.name
    ]);

    return { success: true, storage: storage, previous: previous, actor: session.name };
  } finally {
    lock.releaseLock();
  }
}

/** Створює колонку O із заголовком, якщо її ще немає. */
function ensureStorageColumn_(sheet) {
  if (sheet.getMaxColumns() < STORAGE_COL) {
    sheet.insertColumnsAfter(sheet.getMaxColumns(), STORAGE_COL - sheet.getMaxColumns());
  }
  if (String(sheet.getRange(3, STORAGE_COL).getDisplayValue()).trim() === STORAGE_HEADER) return;

  sheet.getRange(2, STORAGE_COL).setValue(STORAGE_HEADER);
  sheet.getRange(3, STORAGE_COL).setValue(STORAGE_HEADER);
  sheet.getRange(2, STORAGE_COL, 2, 1).merge()
    .setFontWeight('bold').setHorizontalAlignment('center').setVerticalAlignment('middle').setWrap(true);
  sheet.setColumnWidth(STORAGE_COL, 150);
}

/** Одноразово додає колонку «Місце зберігання» на всі аркуші-каталоги. */
function setupStorageColumn() {
  const touched = [];
  forEachCatalogSheet(function (sheet) {
    ensureStorageColumn_(sheet);
    touched.push(sheet.getName());
  });
  const report = 'Колонку «' + STORAGE_HEADER + '» перевірено на аркушах: ' + touched.join(', ');
  console.log(report);
  return report;
}

// ==========================================
// 2.1 ЖУРНАЛ ЯК ДЖЕРЕЛО ПРАВДИ
// ==========================================
function readLog_() {
  const sheet = setupLogSheet();
  const lastRow = sheet.getLastRow();
  const rows = lastRow < 2 ? []
    : sheet.getRange(2, 1, lastRow - 1, LOG_WIDTH).getValues()
        .map(function (values, i) { return { row: i + 2, values: values }; });
  return { sheet: sheet, rows: rows };
}

function findLogEntry_(log, timestamp) {
  const wanted = normalizeTimestamp_(timestamp);
  if (!wanted) return null;
  for (let i = log.rows.length - 1; i >= 0; i--) {
    if (normalizeTimestamp_(log.rows[i].values[0]) === wanted) return log.rows[i];
  }
  return null;
}

/**
 * Залишок із журналу: беремо останню інвентаризацію позиції і застосовуємо
 * все, що після неї. Скасовані операції та рядки скасування пропускаються —
 * вони гасять одне одного. Якщо інвентаризації ще не було, спиратися нема на
 * що: повертаємо fallback (значення з таблиці).
 */
function computeStockFromLog_(log, sheetName, model, fallback) {
  const wantedSheet = String(sheetName).trim();
  const wantedModel = String(model).trim();
  let baseline = null;
  let value = 0;

  log.rows.forEach(function (entry) {
    if (String(entry.values[2]).trim() !== wantedSheet) return;
    if (String(entry.values[4]).trim() !== wantedModel) return;

    const label = String(entry.values[5]).trim();
    if (label.indexOf(CANCEL_PREFIX) === 0) return;
    if (label.indexOf(CANCELLED_SUFFIX) !== -1) return;

    const quantity = toNumber(entry.values[9]);
    if (label === OPERATIONS.registerInventory.label) { baseline = quantity; value = quantity; return; }
    if (baseline === null) return;
    if (label === OPERATIONS.registerUsage.label) value -= quantity;
    else if (label === OPERATIONS.registerRestock.label) value += quantity;
  });

  return baseline === null ? fallback : value;
}

/** Записує перерахований залишок у колонку E. */
function applyStock_(sheet, row, log, sheetName, model, stock, operation, quantity) {
  const fromLog = computeStockFromLog_(log, sheetName, model, null);
  const newVal = fromLog !== null ? fromLog
    : (operation.direction === 0 ? quantity : stock.value + operation.direction * quantity);
  sheet.getRange(row, 5).setValue(newVal);
  return newVal;
}

/** Порожня комірка означає «не інвентаризовано», а не нуль. */
function readStock_(sheet, row) {
  const raw = sheet.getRange(row, 5).getDisplayValue();
  return { counted: String(raw).trim() !== '', value: toNumber(raw) };
}

function findItemRow_(sheet, model, itemNo) {
  const lastRow = sheet.getLastRow();
  if (lastRow < FIRST_DATA_ROW) return 0;

  const values = sheet.getRange(FIRST_DATA_ROW, 1, lastRow - FIRST_DATA_ROW + 1, 2).getDisplayValues();
  const wantedModel = String(model).trim();
  const wantedNo = String(itemNo).trim();
  let fallback = 0;

  for (let i = 0; i < values.length; i++) {
    if (String(values[i][1]).trim() !== wantedModel) continue;
    if (String(values[i][0]).trim() === wantedNo) return i + FIRST_DATA_ROW;
    if (!fallback) fallback = i + FIRST_DATA_ROW;
  }
  return fallback;
}

function operationByLabel_(label) {
  const key = Object.keys(OPERATIONS).filter(function (name) {
    return OPERATIONS[name].label === label;
  })[0];
  return key ? OPERATIONS[key] : null;
}

function normalizeTimestamp_(value) {
  if (value instanceof Date) return value.toISOString();
  return String(value == null ? '' : value).trim();
}

function formatTimestamp_(value) {
  const date = new Date(value);
  return isNaN(date.getTime()) ? String(value)
    : Utilities.formatDate(date, Session.getScriptTimeZone(), 'dd.MM.yy HH:mm');
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
function sendReport(isManual) {
  const targetEmails = getNotificationEmails();
  if (!targetEmails) return null;

  const report = buildReport_();
  if (!report.counts.deficit && !report.counts.negative && !isManual) return report;

  MailApp.sendEmail({ to: targetEmails, subject: report.subject, htmlBody: report.html });
  return report;
}

/** Збирає всі блоки звіту: {subject, html, counts}. */
function buildReport_() {
  const usage30 = collectUsage30();
  const sheetNames = {};
  const deficit = [], notCounted = [], negative = [], excess = [];

  forEachCatalogSheet(function (sheet) {
    const name = sheet.getName();
    sheetNames[name] = true;
    const asset = isAssetSheet_(name);

    readCatalog(sheet).forEach(function (row) {
      if (!row[1] || String(row[1]).trim() === '') return;
      const item = {
        sheetName: name,
        no: row[0] === '' ? '-' : row[0],
        model: String(row[1]).trim(),
        equipment: String(row[2] || '').trim() || '—',
        minStock: toNumber(row[3]),
        stock: toNumber(row[4]),
        counted: String(row[4]).trim() !== '',
        supplier: String(row[12] || '').trim() || '—',
        phone: String(row[13] || '').trim() || '—',
        storage: String(row[14] || '').trim() || '—'
      };

      if (!item.counted) { if (!asset) notCounted.push(item); return; }
      if (item.stock < 0) negative.push(item);
      if (asset) return;                                   // основні засоби не закуповуємо

      if (item.stock < item.minStock) {                    // строгий дефіцит
        item.gap = item.minStock - item.stock;
        item.used30 = usage30[name + '_' + item.model] || 0;
        item.order = item.gap + item.used30;
        deficit.push(item);
      } else if (item.minStock > 0 && item.stock >= item.minStock * EXCESS_FACTOR) {
        excess.push(item);
      }
    });
  });

  // Групуємо закупівлю за постачальником: один дзвінок — один список
  deficit.sort(function (a, b) {
    if (a.supplier !== b.supplier) return a.supplier < b.supplier ? -1 : 1;
    return b.order - a.order;
  });
  excess.sort(function (a, b) { return (b.stock / b.minStock) - (a.stock / a.minStock); });

  const movement = collectMovement_(sheetNames, MOVEMENT_DAYS);
  const counts = {
    deficit: deficit.length,
    orderTotal: round_(deficit.reduce(function (sum, item) { return sum + item.order; }, 0)),
    notCounted: notCounted.length,
    negative: negative.length,
    excess: excess.length,
    movement: movement.total
  };

  return {
    counts: counts,
    subject: counts.deficit
      ? '🚨 ЗІП: до замовлення ' + counts.deficit + ' позицій (' + counts.orderTotal + ' од.) · ' + today_()
      : '✅ ЗІП: дефіциту немає · ' + today_(),
    html: renderReport_(deficit, notCounted, negative, excess, movement, counts)
  };
}

function renderReport_(deficit, notCounted, negative, excess, movement, counts) {
  let html = "<div style='font-family: sans-serif; color:#1e293b;'>";
  html += "<h2>Звіт по ЗІП · " + today_() + "</h2>";
  html += "<p style='color:#475569;'>До замовлення: <b>" + counts.deficit +
    "</b> · потребує інвентаризації: <b>" + counts.notCounted +
    "</b> · від'ємний залишок: <b>" + counts.negative +
    "</b> · надлишок: <b>" + counts.excess + "</b></p>";

  if (deficit.length) {
    let rows = '';
    let supplier = null;
    deficit.forEach(function (item) {
      if (item.supplier !== supplier) {
        supplier = item.supplier;
        rows += "<tr style='background:#f8fafc;'><td colspan='10' style='padding:8px; font-weight:bold;'>" +
          supplier + ' · ' + item.phone + '</td></tr>';
      }
      rows += '<tr>' + td(item.sheetName) + td(item.no, 'center') + td('<b>' + item.model + '</b>') +
        td(item.equipment) + td(item.storage) + td(item.minStock, 'center') +
        td(item.stock, 'center', 'color:#b91c1c; font-weight:bold;') + td(round_(item.gap), 'center') +
        td(round_(item.used30), 'center') +
        td('<b>' + round_(item.order) + '</b>', 'center', 'color:#047857;') + '</tr>';
    });
    html += section_('Потрібно замовити', ['Категорія', '№', 'Модель / Тип', 'Обладнання', '📍 Місце',
      'Мін', 'Залишок', 'Дефіцит', 'Витрата 30 дн', 'Замовити'], rows);
  }

  if (notCounted.length) {
    html += section_('Потребує інвентаризації', ['Категорія', '№', 'Модель / Тип', 'Мін', '📍 Місце'],
      notCounted.map(function (item) {
        return '<tr>' + td(item.sheetName) + td(item.no, 'center') + td(item.model) +
          td(item.minStock, 'center') + td(item.storage) + '</tr>';
      }).join(''));
  }

  if (negative.length) {
    html += section_("Від'ємний залишок — облік розійшовся з полицею",
      ['Категорія', '№', 'Модель / Тип', 'Залишок', '📍 Місце'],
      negative.map(function (item) {
        return '<tr>' + td(item.sheetName) + td(item.no, 'center') + td(item.model) +
          td(item.stock, 'center', 'color:#b91c1c; font-weight:bold;') + td(item.storage) + '</tr>';
      }).join(''));
  }

  if (excess.length) {
    html += section_('Надлишок (залишок ≥ ' + EXCESS_FACTOR + '× мінімуму)',
      ['Категорія', 'Модель / Тип', 'Мін', 'Залишок', 'Кратність'],
      excess.map(function (item) {
        return '<tr>' + td(item.sheetName) + td(item.model) + td(item.minStock, 'center') +
          td(item.stock, 'center') + td(Math.round(item.stock / item.minStock) + '×', 'center') + '</tr>';
      }).join(''));
  }

  html += "<h3 style='margin-top:24px;'>Рух за " + MOVEMENT_DAYS + ' днів</h3>';
  const types = Object.keys(movement.byType);
  html += "<p style='color:#475569;'>Операцій: <b>" + movement.total + '</b>' +
    (types.length ? ' (' + types.map(function (t) { return t + ': ' + movement.byType[t]; }).join(', ') + ')' : '') +
    (movement.cancelled ? ' · скасовано: <b>' + movement.cancelled + '</b>' : '') + '</p>';

  if (movement.top.length) {
    html += section_('Найбільша витрата', ['Позиція', 'Списано'],
      movement.top.map(function (row) {
        return '<tr>' + td(row.name) + td(round_(row.qty), 'center') + '</tr>';
      }).join(''));
  }

  const people = Object.keys(movement.byPerson);
  if (people.length) {
    html += section_('Хто списував', ['Співробітник', 'Списано'],
      people.sort(function (a, b) { return movement.byPerson[b] - movement.byPerson[a]; })
        .map(function (person) {
          return '<tr>' + td(person) + td(round_(movement.byPerson[person]), 'center') + '</tr>';
        }).join(''));
  }

  html += "<p style='font-size:12px; color:#64748b; margin-top:24px;'>Звіт згенеровано автоматично системою «Облік ЗІП» (" +
    CODE_VERSION + ').</p></div>';
  return html;
}

function section_(title, headers, rows) {
  return "<h3 style='margin-top:24px;'>" + title + '</h3>' +
    "<table border='1' cellpadding='6' style='border-collapse:collapse; width:100%; border-color:#cbd5e1; font-size:14px;'>" +
    "<tr style='background:#f1f5f9;'>" + headers.map(function (h) { return '<th>' + h + '</th>'; }).join('') + '</tr>' +
    rows + '</table>';
}

/** Рух за N днів. Рядки з категоріями, яких уже немає в таблиці, ігноруються. */
function collectMovement_(validSheets, days) {
  const result = { byType: {}, byPerson: {}, top: [], cancelled: 0, total: 0, orphans: 0 };
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  if (!logSheet || logSheet.getLastRow() < 2) return result;

  const since = new Date();
  since.setDate(since.getDate() - days);
  const usage = {};

  logSheet.getRange(2, 1, logSheet.getLastRow() - 1, LOG_WIDTH).getValues().forEach(function (row) {
    const when = new Date(row[0]);
    if (isNaN(when.getTime()) || when < since) return;

    const category = String(row[2]).trim();
    if (!validSheets[category]) { result.orphans++; return; }

    const type = String(row[5]).trim();
    result.total++;
    if (type.indexOf(CANCEL_PREFIX) === 0) { result.cancelled++; return; }
    if (type.indexOf(CANCELLED_SUFFIX) !== -1) return;

    result.byType[type] = (result.byType[type] || 0) + 1;
    if (type !== OPERATIONS.registerUsage.label) return;

    const quantity = toNumber(row[9]);
    const person = String(row[10]).trim() || String(row[6]).trim() || '—';
    result.byPerson[person] = (result.byPerson[person] || 0) + quantity;
    const key = category + ' · ' + String(row[4]).trim();
    usage[key] = (usage[key] || 0) + quantity;
  });

  result.top = Object.keys(usage).map(function (name) { return { name: name, qty: usage[name] }; })
    .sort(function (a, b) { return b.qty - a.qty; }).slice(0, 5);
  return result;
}

/**
 * Сповіщення про перетин порогу: короткий лист про одну позицію, яка щойно
 * опустилася нижче мінімуму. Не частіше разу на добу на позицію.
 */
function maybeNotifyThreshold_(item) {
  if (isAssetSheet_(item.sheetName)) return;
  if (!(item.stock < item.minStock)) return;

  const properties = PropertiesService.getScriptProperties();
  const today = today_();
  let notices = {};
  try { notices = JSON.parse(properties.getProperty('thresholdNotices') || '{}'); } catch (e) { notices = {}; }

  // Лишаємо тільки сьогоднішні позначки — сховище не росте
  Object.keys(notices).forEach(function (key) { if (notices[key] !== today) delete notices[key]; });

  const key = item.sheetName + '_' + item.model;
  if (notices[key] === today) return;
  notices[key] = today;
  properties.setProperty('thresholdNotices', JSON.stringify(notices));

  const emails = getNotificationEmails();
  if (!emails) return;

  MailApp.sendEmail({
    to: emails,
    subject: '⚠️ ЗІП: ' + item.model + ' нижче мінімуму (' + item.stock + ' з ' + item.minStock + ')',
    htmlBody: "<div style='font-family:sans-serif; color:#1e293b;'>" +
      '<h3>' + item.model + ' — залишок нижче мінімуму</h3>' +
      "<table border='1' cellpadding='6' style='border-collapse:collapse; border-color:#cbd5e1;'>" +
      '<tr><td>Категорія</td><td><b>' + item.sheetName + '</b></td></tr>' +
      '<tr><td>Обладнання</td><td>' + item.equipment + '</td></tr>' +
      '<tr><td>📍 Місце</td><td>' + item.storage + '</td></tr>' +
      '<tr><td>Мінімум</td><td>' + item.minStock + '</td></tr>' +
      "<tr><td>Залишок</td><td style='color:#b91c1c;'><b>" + item.stock + '</b></td></tr>' +
      '<tr><td>Постачальник</td><td>' + item.supplier + ' · ' + item.phone + '</td></tr></table>' +
      "<p style='color:#64748b; font-size:12px;'>Повний звіт — у понеділок або кнопкою в застосунку.</p></div>"
  });
}

function isAssetSheet_(name) {
  return ASSET_SHEET_PREFIXES.some(function (prefix) { return String(name).indexOf(prefix) === 0; });
}

function today_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'dd.MM.yyyy');
}

function round_(value) {
  return Math.round(Number(value) * 100) / 100;
}

/** Витрата за 30 днів — лише «Видача» і лише за наявними категоріями. */
function collectUsage30() {
  const logSheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(LOG_SHEET_NAME);
  const usage = {};
  if (!logSheet || logSheet.getLastRow() < 2) return usage;

  const valid = {};
  forEachCatalogSheet(function (sheet) { valid[sheet.getName()] = true; });

  const since = new Date();
  since.setDate(since.getDate() - 30);

  logSheet.getRange(2, 1, logSheet.getLastRow() - 1, LOG_WIDTH).getValues().forEach(function (row) {
    if (String(row[5]).trim() !== OPERATIONS.registerUsage.label) return;
    const category = String(row[2]).trim();
    if (!valid[category]) return;
    const when = new Date(row[0]);
    if (isNaN(when.getTime()) || when < since) return;
    const key = category + '_' + String(row[4]).trim();
    usage[key] = (usage[key] || 0) + toNumber(row[9]);
  });
  return usage;
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

/**
 * Кому йде звіт. Основне джерело — колонка O «email» довідника
 * «_REF_Employees»: беруться активні співробітники, чия роль дозволяє звіт
 * (zip.admin, admin). Дав людині роль — вона почала отримувати листи.
 */
function getNotificationEmails() {
  const fromDirectory = reportRecipients_().map(function (person) { return person.email; });
  if (fromDirectory.length) return fromDirectory.join(',');

  const fromSheet = readPeople().emails;          // запасний варіант: аркуш «Користувачі»
  if (fromSheet.length) return fromSheet.join(',');

  return FALLBACK_EMAILS;
}

function reportRecipients_() {
  const seen = {};
  return readEmployees_().filter(function (employee) {
    if (!employee.eligible) return false;
    if (employee.permissions.indexOf('forceReport') === -1) return false;
    if (employee.email.indexOf('@') === -1) return false;
    const key = employee.email.toLowerCase();
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
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

/** Один рядок позиції, доповнений до CAT_WIDTH. */
function readItemRow_(sheet, row) {
  const width = Math.min(CAT_WIDTH, sheet.getMaxColumns());
  const values = sheet.getRange(row, 1, 1, width).getDisplayValues()[0];
  while (values.length < CAT_WIDTH) values.push('');
  return values;
}

/** Читає рядки позицій, доповнюючи їх до CAT_WIDTH, якщо колонки O ще немає. */
function readCatalog(sheet) {
  const width = Math.min(CAT_WIDTH, sheet.getMaxColumns());
  const values = sheet.getRange(FIRST_DATA_ROW, 1, sheet.getLastRow() - FIRST_DATA_ROW + 1, width).getValues();
  return values.map(function (row) {
    while (row.length < CAT_WIDTH) row.push('');
    return row;
  });
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
function setupWeeklyReport() {
  const obsolete = ['weeklyPurchasePlan', 'sendPurchasePlan', 'weeklyReport'];
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (obsolete.indexOf(trigger.getHandlerFunction()) !== -1) ScriptApp.deleteTrigger(trigger);
  });
  ScriptApp.newTrigger('weeklyReport').timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(8).create();
  return 'Щотижневий звіт: понеділок, 08:00';
}

/** Обгортка: тригер передає у функцію об'єкт події, а не прапорець isManual. */
function weeklyReport() {
  sendReport(false);
}
