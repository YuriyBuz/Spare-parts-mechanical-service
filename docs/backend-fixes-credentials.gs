/*************************************************************************
 * ВИПРАВЛЕННЯ: логіни та паролі з провідним «0» не приймаються.
 *
 * Причина: Google Sheets зберігає суто-цифрове значення як ЧИСЛО і
 * відкидає провідний нуль ("0508328999" -> 508328999, "09" -> 9).
 * Бекенд порівнює це як рядок, тому вхід із нулем не збігається.
 *
 * ЯК ЗАСТОСУВАТИ (Apps Script):
 *  1) Додати сюди наведені нижче функції-хелпери (loginMatches_ / passwordMatches_
 *     / fixCredentialColumnsToText / _digits / _stripLeadZeros / _allDigits).
 *  2) У doPost замінити три ділянки — див. коментарі "БУЛО / СТАЛО".
 *  3) Розгортання → Керувати розгортаннями → олівець → Версія: Нова версія → Розгорнути.
 *  4) Один раз запустити fixCredentialColumnsToText() з редактора.
 *  5) Рядки, що вже втратили нуль, перевписати вручну (тепер нуль збережеться).
 *************************************************************************/

// ================= ХЕЛПЕРИ =================

function _digits(s)        { return String(s == null ? '' : s).replace(/\D/g, ''); }
function _stripLeadZeros(s){ return String(s == null ? '' : s).replace(/^0+/, ''); }
function _allDigits(s)     { return /^\d+$/.test(String(s == null ? '' : s).trim()); }

/**
 * Порівняння логінів, стійке до втрати провідного нуля в таблиці.
 * Збіг, якщо: точний / без пробілів і дефісів / однакові цифри без провідних нулів.
 */
function loginMatches_(inputLogin, storedLogin) {
  var a = String(inputLogin == null ? '' : inputLogin).trim();
  var b = String(storedLogin == null ? '' : storedLogin).trim();
  if (!a || !b) return false;
  if (a === b) return true;

  var ca = a.replace(/[\s\-]/g, '');
  var cb = b.replace(/[\s\-]/g, '');
  if (ca && ca === cb) return true;

  // Головне: "0508328999" (ввід) vs 508328999 (число з таблиці)
  var da = _digits(a), db = _digits(b);
  if (da && db && _stripLeadZeros(da) === _stripLeadZeros(db)) return true;

  return false;
}

/**
 * Порівняння паролів, стійке до втрати провідного нуля ("09" vs 9).
 * Толерантність до нуля вмикається лише для суто-цифрових паролів.
 */
function passwordMatches_(inputPass, storedPass) {
  var a = String(inputPass == null ? '' : inputPass).trim();
  var b = String(storedPass == null ? '' : storedPass).trim();
  if (a === b) return true;
  if (_allDigits(a) && _allDigits(b) && _stripLeadZeros(a) === _stripLeadZeros(b)) return true;
  return false;
}

/**
 * Разова функція: перевести колонки з логінами/паролями у ТЕКСТОВИЙ формат,
 * щоб Sheets більше не з'їдав провідні нулі.
 * Колонки вкладки «Активні»: C(3)=телефон, G(7)=дефолт-пароль, J(10)=логін, K(11)=пароль.
 * ⚠️ Не відновлює вже втрачені нулі — такі рядки треба перевписати вручну.
 */
function fixCredentialColumnsToText() {
  var ss = SpreadsheetApp.openById(MAIN_SHEET_ID);
  var sh = ss.getSheetByName('Активні');
  if (!sh) { Logger.log('Вкладки "Активні" немає'); return; }
  var rows = sh.getMaxRows();
  [3, 7, 10, 11].forEach(function (col) {
    sh.getRange(1, col, rows, 1).setNumberFormat('@');
  });
  Logger.log('Колонки C, G, J, K вкладки "Активні" переведено у текстовий формат.');
}


/*************************************************************************
 * ЗМІНА 1 — блок логіну працівника у doPost (requestType === 'login').
 *
 * БУЛО:
 *   if ((inputLogin === activeLogin || cleanInputLogin === cleanActiveLogin) && inputPassword === activePass) {
 *
 * СТАЛО (рядки cleanInputLogin/cleanActiveLogin більше не потрібні):
 *   if (loginMatches_(inputLogin, activeLogin) && passwordMatches_(inputPassword, activePass)) {
 *
 * Повний виправлений цикл для зручності:
 *************************************************************************/
/*
    var empSheet = ssMain.getSheetByName('Активні');
    if (empSheet) {
      var empData = empSheet.getDataRange().getValues();
      for (var j = 1; j < empData.length; j++) {
        var phone       = String(empData[j][2]).trim();
        var defaultPass = String(empData[j][6]).trim();
        var newLogin    = String(empData[j][9]).trim();
        var newPass     = String(empData[j][10]).trim();

        var activeLogin = newLogin !== "" ? newLogin : phone;
        var activePass  = newPass  !== "" ? newPass  : defaultPass;

        if (loginMatches_(inputLogin, activeLogin) && passwordMatches_(inputPassword, activePass)) {
          userFound = true;
          userName  = empData[j][1];
          role      = "user";
          break;
        }
      }
    }
*/

/* Також в адмін-блоці варто зробити пароль стійким до нуля:
 * БУЛО:  String(adminData[i][2]).trim() === inputPassword
 * СТАЛО: passwordMatches_(inputPassword, adminData[i][2])
 */


/*************************************************************************
 * ЗМІНА 2 — запис нових логіна/пароля у 'update_credentials'.
 * Текстовий формат ПЕРЕД setValue зберігає провідні нулі.
 *
 * БУЛО:
 *   sheetContacts.getRange(k+1, 10).setValue(params.newPhone);
 *   sheetContacts.getRange(k+1, 11).setValue(params.newPassword);
 *
 * СТАЛО:
 *   sheetContacts.getRange(k+1, 10).setNumberFormat('@').setValue(String(params.newPhone));
 *   sheetContacts.getRange(k+1, 11).setNumberFormat('@').setValue(String(params.newPassword));
 *************************************************************************/


/*************************************************************************
 * ЗМІНА 3 — запис нового працівника у 'add_employee'.
 * Після appendRow перевести телефон/дефолт-пароль/логін/пароль у текст і перезаписати.
 *
 * БУЛО:
 *   sheetContactsAdd.appendRow([
 *       nextIdAdd, params.name, params.phone, params.dob, '', '', defaultPassAdd, '', '', defaultLoginAdd, defaultPassAdd
 *   ]);
 *   return buildCorsResponse({status: "OK"});
 *
 * СТАЛО:
 *   sheetContactsAdd.appendRow([
 *       nextIdAdd, params.name, params.phone, params.dob, '', '', defaultPassAdd, '', '', defaultLoginAdd, defaultPassAdd
 *   ]);
 *   var newRowA = sheetContactsAdd.getLastRow();
 *   [3, 7, 10, 11].forEach(function (col) { sheetContactsAdd.getRange(newRowA, col).setNumberFormat('@'); });
 *   sheetContactsAdd.getRange(newRowA, 3 ).setValue(String(params.phone));
 *   sheetContactsAdd.getRange(newRowA, 7 ).setValue(String(defaultPassAdd));
 *   sheetContactsAdd.getRange(newRowA, 10).setValue(String(defaultLoginAdd));
 *   sheetContactsAdd.getRange(newRowA, 11).setValue(String(defaultPassAdd));
 *   return buildCorsResponse({status: "OK"});
 *************************************************************************/


/*************************************************************************
 * ДОДАТКОВО (HIGH #3) — багатоденні відпустки/лікарняні позначати за ВЕСЬ період.
 *
 * Зараз updateShiftStatus бере лише першу дату діапазону "12.08.2026 - 15.08.2026",
 * тому в графіку заповнюється тільки перший день. Нижче — хелпер, що повертає всі дати
 * періоду. У updateShiftStatus замість роботи з однією датою пройдіть циклом by getDatesInRange_.
 *************************************************************************/

/** Повертає масив {day, monthIdx, year} для всіх днів у рядку дати або діапазону "d1 - d2". */
function getDatesInRange_(cleanDate) {
  function parseOne(s) {
    s = String(s).replace(/['"]/g, '').trim();
    var iso = s.match(/(\d{4})[\.\-](\d{1,2})[\.\-](\d{1,2})/);
    if (iso) return new Date(parseInt(iso[1],10), parseInt(iso[2],10)-1, parseInt(iso[3],10));
    var ua = s.match(/(\d{1,2})[\.\-](\d{1,2})[\.\-](\d{2,4})/);
    if (ua) { var y = parseInt(ua[3],10); if (y < 100) y += 2000;
              return new Date(y, parseInt(ua[2],10)-1, parseInt(ua[1],10)); }
    var d = new Date(s); return isNaN(d.getTime()) ? null : d;
  }
  // Розділювач діапазону — дефіс/тире З ПРОБІЛАМИ обабіч ("12.08.2026 - 15.08.2026").
  // Пробіли обов'язкові, щоб не розрізати внутрішні дефіси ISO-дати "2026-08-12".
  var parts = String(cleanDate).split(/\s+[-–—]\s+/);
  var start = parseOne(parts[0]);
  var end   = parts[1] ? parseOne(parts[1]) : start;
  if (!start) return [];
  if (!end || end < start) end = start;

  var out = [], cur = new Date(start.getTime());
  var guard = 0;
  while (cur <= end && guard < 400) {           // guard від нескінченного циклу
    out.push({ day: cur.getDate(), monthIdx: cur.getMonth(), year: cur.getFullYear() });
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return out;
}
