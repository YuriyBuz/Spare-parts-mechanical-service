/**
 * Автентифікація за PIN та перевірка прав.
 *
 * Джерело: аркуш «_REF_Employees» таблиці gw-ref (окремий файл).
 *   A emp_id | B ПІБ повне | C ПІБ короткий | E pos_id | H статус
 *   Q PIN    | R ролі додатково | S ролі відібрані
 * Ролі посади — «_REF_Positions», колонка D («ролі типові»).
 *
 * У клієнт НІКОЛИ не потрапляють: PIN, список співробітників, ролі інших людей.
 * Клієнт надсилає лише введений PIN і отримує у відповідь ім'я, роль
 * і перелік дозволених дій.
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
