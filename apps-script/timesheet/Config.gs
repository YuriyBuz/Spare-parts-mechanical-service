/**
 * Config.gs — налаштування автоматизації табелю.
 *
 * Будь-яке значення можна перевизначити без правки коду:
 * Розширення → Apps Script → ⚙ Налаштування проєкту → Властивості скрипта
 * (ключ = назва параметра нижче, напр. ADMIN_EMAILS).
 */

var DEFAULT_CONFIG = {
  // --- Джерела даних ---
  // Табель 2026
  TIMESHEET_ID: '1IkEuZx471RLdpoWlOwfWjNsgrlkhD6mITU4GlQR8urI',
  // gw-ref (довідник працівників)
  REF_ID: '1UhdO9ALcSXk8fgWhUnMiluO4Aao6R4EP6iN4Ie__rY8',
  REF_EMPLOYEES_SHEET: '_REF_Employees',

  // --- Отримувачі звіту (через кому) ---
  ADMIN_EMAILS: 'buznitskiy7@gmail.com',
  EMAIL_SENDER_NAME: 'Табель — автоматизація',

  // --- Поведінка ---
  // З якого місяця у табелі має бути колонка emp_id (формат YYYY-MM).
  EMP_ID_FROM: '2026-08',
  // Додавати у новий аркуш активних працівників, яких немає в табелі.
  // false = лише повідомляти у звіті (рекомендовано).
  AUTO_ADD_NEW_EMPLOYEES: false,
  // Видаляти рядки звільнених. Ніколи не вмикайте без потреби —
  // звільнений міг відпрацювати частину місяця.
  AUTO_REMOVE_FIRED: false,
  // Нечіткий збіг ПІБ (кількість помилок у написанні, які пробачаємо).
  FUZZY_MAX_DISTANCE: 2,
  // Проставляти emp_id за нечітким збігом (позначається у звіті як «перевірте»).
  FUZZY_AUTO_APPLY: true,
  // Записувати знайдені варіанти написання в аркуш псевдонімів довідника.
  WRITE_ALIASES: true,
  // Додавати примітки до комірок ПІБ з описом проблеми.
  ADD_NOTES: true,
  // Очищати примітки в колонці ПІБ при створенні нового місяця.
  CLEAR_NAME_NOTES: true,
  // Вести журнал запусків в окремому (прихованому) аркуші табелю.
  WRITE_LOG: true,
  LOG_SHEET_NAME: '_Журнал_табелю',
  // Надсилати лист і при ручному створенні (не лише при автоматичному).
  SEND_EMAIL_ON_MANUAL: true,

  // --- Технічне ---
  TIMEZONE: 'Europe/Kyiv',
  ALIAS_SHEET_DEFAULT_NAME: '_REF_Aliases',
  ALIAS_HEADER: 'варіант написання'
};

/** Колонки табелю, які не залежать від місяця. */
var NAME_COL = 1; // A — ПІБ
var POS_COL = 2;  // B — посада

var UA_MONTHS = [
  'Січень', 'Лютий', 'Березень', 'Квітень', 'Травень', 'Червень',
  'Липень', 'Серпень', 'Вересень', 'Жовтень', 'Листопад', 'Грудень'
];

/** Додаткові форми, які теж розпізнаємо в назвах аркушів. */
var UA_MONTHS_ALT = [
  ['січня'], ['лютого'], ['березня'], ['квітня'], ['травня'], ['червня'],
  ['липня'], ['серпня'], ['вересня'], ['жовтня'], ['листопада'], ['грудня']
];

/** Індекс = Date.getDay(): 0 — неділя. Апостроф — U+02BC, як у таблиці. */
var UA_WEEKDAYS = [
  'неділя', 'понеділок', 'вівторок', 'середа', 'четвер', 'пʼятниця', 'субота'
];

var HEADER_WORDS = ['День', 'Ніч', 'Змін', 'Годин'];
var TOTALS_LABEL = 'за місяць';
var EMP_ID_HEADER = 'emp_id';

/**
 * Повертає конфігурацію з урахуванням Властивостей скрипта.
 */
function getConfig() {
  var cfg = {};
  Object.keys(DEFAULT_CONFIG).forEach(function (k) { cfg[k] = DEFAULT_CONFIG[k]; });

  var props;
  try {
    props = PropertiesService.getScriptProperties().getProperties();
  } catch (e) {
    props = {};
  }

  Object.keys(cfg).forEach(function (k) {
    if (!Object.prototype.hasOwnProperty.call(props, k)) return;
    var raw = String(props[k]).trim();
    if (raw === '') return;
    if (typeof cfg[k] === 'boolean') {
      cfg[k] = /^(1|true|так|yes|on)$/i.test(raw);
    } else if (typeof cfg[k] === 'number') {
      var num = Number(raw);
      if (!isNaN(num)) cfg[k] = num;
    } else {
      cfg[k] = raw;
    }
  });

  cfg.ADMIN_EMAILS_LIST = String(cfg.ADMIN_EMAILS)
    .split(/[,;\s]+/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) { return s.indexOf('@') > 0; });

  var m = /^(\d{4})-(\d{1,2})$/.exec(String(cfg.EMP_ID_FROM).trim());
  cfg.EMP_ID_FROM_YEAR = m ? Number(m[1]) : 2026;
  cfg.EMP_ID_FROM_MONTH = m ? Number(m[2]) : 8;

  return cfg;
}
