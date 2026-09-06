/*************************************************************************
 * ПОРТАЛ ПРАЦІВНИКА — Code.gs  (ПОВНА ВИПРАВЛЕНА ВЕРСІЯ)
 *
 * ЯК ВСТАНОВИТИ:
 *   1. Відкрити проєкт Apps Script → файл Code.gs (той, де зараз doPost).
 *   2. Виділити ВЕСЬ старий вміст (Ctrl+A) і вставити цей файл замість нього.
 *   3. Файл Penalties.gs НЕ ЧІПАТИ — він лишається як є.
 *   4. Розгортання → Керувати розгортаннями → олівець → Версія: НОВА ВЕРСІЯ → Розгорнути.
 *      URL веб-застосунку не зміниться.
 *   5. Один раз запустити з редактора: fixCredentialColumnsToText()
 *   6. (Рекомендовано) Тригери → Додати тригер → cleanupOldSessions → раз на день.
 *
 * ЩО ВИПРАВЛЕНО ПОРІВНЯНО ЗІ СТАРОЮ ВЕРСІЄЮ:
 *   [1] БЕЗПЕКА: адмінські запити тепер вимагають ролі admin. Раніше БУДЬ-ЯКИЙ
 *       працівник із валідним токеном міг отримати паролі всіх колег,
 *       схвалити собі заявку та редагувати графік.
 *   [2] Логіни/паролі з провідним «0» більше не ламаються.
 *   [3] Відпустка/лікарняний на кілька днів позначаються за ВЕСЬ період.
 *   [4] LockService у submit_request та add_employee — не буде однакових ID.
 *   [5] Додаткова зміна пишеться кирилічною «З» (а не цифрою «3»).
 *   [6] doOptions більше не містить неіснуючого HtmlOutput.setHeader().
 *   [7] Надійніша генерація пароля; валідація зміни логіна/пароля.
 *************************************************************************/

const MAIN_SHEET_ID = '1t3vF0VtiPyPja24v8P7b8OxwdPd4NjftsVmSkAcbt7o';
const SCHEDULE_SHEET_ID = '1uL5lkZGPk8klJku5dX-eh075aZhFSUTeyIdDHLAQuKg';
const SICK_LEAVE_FOLDER_ID = '1-4Ct8nDBK3FP7tEXU2U5wta1oVzYD85j';

const UKR_MONTHS = ["Січень", "Лютий", "Березень", "Квітень", "Травень", "Червень",
                    "Липень", "Серпень", "Вересень", "Жовтень", "Листопад", "Грудень"];

// Символ додаткової зміни у графіку.
// Раніше бекенд писав цифру '3', а ручне редагування — кирилічну 'З'.
// Тепер завжди 'З'; старі значення '3' і далі коректно розпізнаються.
const SHIFT_EXTRA = 'З';

// Колонки вкладки «Активні» (нумерація з 1, як у getRange)
const COL_PHONE        = 3;   // C — телефон
const COL_DEFAULT_PASS = 7;   // G — початковий пароль
const COL_LOGIN        = 10;  // J — власний логін
const COL_PASS         = 11;  // K — власний пароль

const SESSION_TTL_MS = 86400000; // 24 години

// ================= ДОПОМІЖНІ ФУНКЦІЇ =================

function formatMyDate(dateVal) {
  try {
    if (dateVal instanceof Date && !isNaN(dateVal.getTime())) {
      return String(dateVal.getDate()).padStart(2, '0') + '.' + String(dateVal.getMonth() + 1).padStart(2, '0') + '.' + dateVal.getFullYear();
    }
    if (typeof dateVal === 'string' && dateVal.includes('T')) {
      var dObj = new Date(dateVal);
      if (!isNaN(dObj.getTime())) {
        return String(dObj.getDate()).padStart(2, '0') + '.' + String(dObj.getMonth() + 1).padStart(2, '0') + '.' + dObj.getFullYear();
      }
    }
  } catch (e) {}
  return String(dateVal || '');
}

/**
 * Пароль із гарантованою довжиною 8 символів.
 * Символи 0/O/1/I/l виключено: їх плутають при диктуванні,
 * а суто-цифровий пароль із нуля Google Таблиці зіпсували б (див. loginMatches_).
 */
function generateSecurePassword() {
  var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  var out = '';
  for (var i = 0; i < 8; i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function generateToken() {
  return Utilities.getUuid();
}

function normName_(s) {
  return String(s == null ? '' : s).trim().toLowerCase().replace(/\s+/g, ' ');
}

// --------- Порівняння логінів/паролів, стійке до втрати «0» ----------
// Google Таблиці зберігають суто-цифрове значення як ЧИСЛО і відкидають
// провідний нуль: "0508328999" -> 508328999, "09" -> 9.
// Тому порівнюємо ще й «цифри без провідних нулів».

function _digits(s)         { return String(s == null ? '' : s).replace(/\D/g, ''); }
function _stripLeadZeros(s) { return String(s == null ? '' : s).replace(/^0+/, ''); }
function _allDigits(s)      { return /^\d+$/.test(String(s == null ? '' : s).trim()); }

function loginMatches_(inputLogin, storedLogin) {
  var a = String(inputLogin == null ? '' : inputLogin).trim();
  var b = String(storedLogin == null ? '' : storedLogin).trim();
  if (!a || !b) return false;
  if (a === b) return true;

  var ca = a.replace(/[\s\-]/g, '');
  var cb = b.replace(/[\s\-]/g, '');
  if (ca && ca === cb) return true;

  var da = _digits(a), db = _digits(b);
  if (da && db && _stripLeadZeros(da) === _stripLeadZeros(db)) return true;

  return false;
}

function passwordMatches_(inputPass, storedPass) {
  var a = String(inputPass == null ? '' : inputPass).trim();
  var b = String(storedPass == null ? '' : storedPass).trim();
  if (a === b) return true;
  if (_allDigits(a) && _allDigits(b) && _stripLeadZeros(a) === _stripLeadZeros(b)) return true;
  return false;
}

/**
 * Логін для показу в адмін-панелі.
 * Якщо збережений логін — це «хвіст» телефону, який Таблиці вже позбавили нуля,
 * показуємо правильний варіант із нулем.
 */
function displayLogin_(storedLogin, phone) {
  var login = String(storedLogin == null ? '' : storedLogin).trim();
  var phoneDigits = String(phone == null ? '' : phone).replace(/\D/g, '');
  var tail = phoneDigits.slice(-10);
  if (!login) return tail;
  if (/^\d+$/.test(login) && tail && _stripLeadZeros(tail) === _stripLeadZeros(login)) return tail;
  return login;
}

/**
 * Повертає масив {day, monthIdx, year} для одної дати АБО діапазону "d1 - d2".
 * Саме через це раніше багатоденна відпустка позначалась лише першим днем.
 */
function getDatesInRange_(rawDate) {
  if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
    return [{ day: rawDate.getDate(), monthIdx: rawDate.getMonth(), year: rawDate.getFullYear() }];
  }

  function parseOne(s) {
    s = String(s).replace(/['"]/g, '').trim();
    var iso = s.match(/(\d{4})[\.\-](\d{1,2})[\.\-](\d{1,2})/);
    if (iso) return new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    var ua = s.match(/(\d{1,2})[\.\-](\d{1,2})[\.\-](\d{2,4})/);
    if (ua) {
      var y = parseInt(ua[3], 10); if (y < 100) y += 2000;
      return new Date(y, parseInt(ua[2], 10) - 1, parseInt(ua[1], 10));
    }
    var d = new Date(s);
    return isNaN(d.getTime()) ? null : d;
  }

  var str = String(rawDate == null ? '' : rawDate).replace(/['"]/g, '').trim();
  if (!str) return [];

  // Розділювач діапазону — дефіс/тире З ПРОБІЛАМИ обабіч ("12.08.2026 - 15.08.2026").
  // Пробіли обов'язкові, щоб не розрізати внутрішні дефіси ISO-дати "2026-08-12".
  var parts = str.split(/\s+[-–—]\s+/);
  var start = parseOne(parts[0]);
  var end   = parts[1] ? parseOne(parts[1]) : start;
  if (!start) return [];
  if (!end || end < start) end = start;

  var out = [], cur = new Date(start.getTime()), guard = 0;
  while (cur <= end && guard < 366) {
    out.push({ day: cur.getDate(), monthIdx: cur.getMonth(), year: cur.getFullYear() });
    cur.setDate(cur.getDate() + 1);
    guard++;
  }
  return out;
}

// ================= СИСТЕМА СЕСІЙ =================

function validateSession(token) {
  if (!token) return false;

  var ss = SpreadsheetApp.openById(MAIN_SHEET_ID);
  var sheet = ss.getSheetByName('Сесії');
  if (!sheet) return false;

  var data = sheet.getDataRange().getValues();
  var now = new Date().getTime();

  for (var i = 1; i < data.length; i++) {
    if (data[i][0] === token) {
      var tokenTime = new Date(data[i][2]).getTime();
      if (now - tokenTime < SESSION_TTL_MS) {
        return { user: data[i][1], role: data[i][3] || 'user' };
      } else {
        sheet.deleteRow(i + 1);
        return false;
      }
    }
  }
  return false;
}

// ================= CORS =================

/**
 * УВАГА: Apps Script не дозволяє задавати власні HTTP-заголовки і не обслуговує
 * preflight OPTIONS. У старій версії тут викликався HtmlOutput.setHeader(),
 * якого не існує — цей код кинув би помилку, якби його справді викликали.
 *
 * Запити працюють лише тому, що фронтенд шле Content-Type: 'text/plain;charset=utf-8'
 * — це «простий» CORS-запит без preflight.
 * НЕ МІНЯЙТЕ Content-Type на 'application/json' у фронтенді: браузер почне слати
 * preflight OPTIONS, Apps Script його не обслужить і ВСІ запити впадуть.
 */
function doOptions(e) {
  return ContentService.createTextOutput('');
}

function buildCorsResponse(dataPayload) {
  var output = ContentService.createTextOutput(JSON.stringify(dataPayload));
  output.setMimeType(ContentService.MimeType.JSON);
  return output;
}

function denyResponse_() {
  return buildCorsResponse({ error: "Недостатньо прав для цієї операції" });
}

// ================= ГОЛОВНИЙ ОБРОБНИК =================

function doPost(e) {
  try {
    if (!e.postData || !e.postData.contents) return buildCorsResponse({ error: "Пустий запит" });

    var params = JSON.parse(e.postData.contents);
    var ssMain = SpreadsheetApp.openById(MAIN_SHEET_ID);

    // 1. ЛОГІКА АВТОРИЗАЦІЇ (ЛОГІН)
    if (params.requestType === 'login') {
      var userFound = false;
      var userName = "";
      var role = "user";
      var inputLogin = String(params.login == null ? '' : params.login).trim();
      var inputPassword = String(params.password == null ? '' : params.password).trim();

      var adminSheet = ssMain.getSheetByName('Адміністрація');
      if (adminSheet) {
        var adminData = adminSheet.getDataRange().getValues();
        for (var i = 1; i < adminData.length; i++) {
          var adminLogin = String(adminData[i][1]).trim();
          // E-mail порівнюємо без урахування регістру; пароль — стійко до втрати «0»
          if (adminLogin && adminLogin.toLowerCase() === inputLogin.toLowerCase() &&
              passwordMatches_(inputPassword, adminData[i][2])) {
            userFound = true;
            userName = adminData[i][0];
            role = "admin";
            break;
          }
        }
      }

      if (!userFound) {
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

            // ГОЛОВНЕ ВИПРАВЛЕННЯ: стійко до «з'їденого» таблицею провідного нуля
            if (loginMatches_(inputLogin, activeLogin) && passwordMatches_(inputPassword, activePass)) {
              userFound = true;
              userName = empData[j][1];
              role = "user";
              break;
            }
          }
        }
      }

      if (userFound) {
        var token = generateToken();
        var sessionSheet = ssMain.getSheetByName('Сесії') || ssMain.insertSheet('Сесії');
        sessionSheet.appendRow([token, userName, new Date().toISOString(), role]);
        return buildCorsResponse({ status: "OK", token: token, user: userName, role: role });
      } else {
        return buildCorsResponse({ error: "Невірний логін або пароль" });
      }
    }

    // 2. ЗАХИСТ ІНШИХ ЗАПИТІВ (ПЕРЕВІРКА СЕСІЇ)
    var sessionData = validateSession(params.token);
    if (!sessionData) {
      return buildCorsResponse({ error: "Unauthorized", message: "Сесія недійсна або закінчилась. Авторизуйтесь знову." });
    }

    var activeUser = sessionData.user;
    var activeRole = sessionData.role;
    var isAdmin = (activeRole === 'admin');

    var ssSched = SpreadsheetApp.openById(SCHEDULE_SHEET_ID);

    // --- ЗМІНА ЛОГІНУ ТА ПАРОЛЮ (працівник міняє СВОЇ дані) ---
    if (params.requestType === 'update_credentials') {
        var sheetContacts = ssMain.getSheetByName('Активні');
        if (!sheetContacts) return buildCorsResponse({error: "Таблиця не знайдена"});

        var inputNewLogin = String(params.newPhone == null ? '' : params.newPhone).trim();
        var inputNewPassword = String(params.newPassword == null ? '' : params.newPassword).trim();

        if (!inputNewLogin || !inputNewPassword) {
            return buildCorsResponse({error: "Логін і пароль не можуть бути порожніми"});
        }
        if (inputNewPassword.length < 4) {
            return buildCorsResponse({error: "Пароль має містити щонайменше 4 символи"});
        }

        var dataContacts = sheetContacts.getDataRange().getValues();
        var searchName = normName_(activeUser);

        var isDuplicate = false;
        for (var c = 1; c < dataContacts.length; c++) {
            var existingName = normName_(dataContacts[c][1]);
            if (existingName !== searchName && existingName !== "") {
                var phoneExisting    = String(dataContacts[c][2]).trim();
                var defPassExisting  = String(dataContacts[c][6]).trim();
                var newLogExisting   = String(dataContacts[c][9]).trim();
                var newPassExisting  = String(dataContacts[c][10]).trim();

                var actLogExisting  = newLogExisting  !== "" ? newLogExisting  : phoneExisting;
                var actPassExisting = newPassExisting !== "" ? newPassExisting : defPassExisting;

                if (loginMatches_(inputNewLogin, actLogExisting) && passwordMatches_(inputNewPassword, actPassExisting)) {
                    isDuplicate = true;
                    break;
                }
            }
        }

        if (isDuplicate) {
            return buildCorsResponse({error: "Ця комбінація логіну та паролю не пройшла перевірку по безпеці (вже використовується). Будь ласка, придумайте іншу."});
        }

        for (var k = 1; k < dataContacts.length; k++) {
            if (normName_(dataContacts[k][1]) === searchName) {
                // Текстовий формат ПЕРЕД записом — інакше "0500..." стане числом і втратить нуль
                sheetContacts.getRange(k + 1, COL_LOGIN).setNumberFormat('@').setValue(inputNewLogin);
                sheetContacts.getRange(k + 1, COL_PASS ).setNumberFormat('@').setValue(inputNewPassword);
                return buildCorsResponse({status: "OK"});
            }
        }
        return buildCorsResponse({error: "Працівника не знайдено"});
    }

    // --- ОБРОБКА ЛОГУВАННЯ ---
    if (params.requestType === 'log_action') {
      var sheetLogs = ssMain.getSheetByName('Логи');
      if (sheetLogs) {
        var logName = isAdmin ? 'Адміністратор' : activeUser;
        sheetLogs.appendRow([new Date(), logName, params.action]);
      }
      return buildCorsResponse({ status: "OK" });
    }

    // --- СТВОРЕННЯ НОВОЇ ЗАЯВКИ (З ФОТО) ТА ВІДПРАВКА HTML-ЛИСТА ---
    if (params.requestType === 'submit_request') {
      var sheetReq = ssMain.getSheetByName('Заявки');
      if (!sheetReq) return buildCorsResponse({ error: "Таблиця Заявки не знайдена" });

      var finalComment = params.comment || "немає";
      var attachments = [];

      // Обробка прикріпленого фото (довідки) — до блокування, бо Диск повільний
      if (params.fileData && params.fileName) {
        try {
          var decodedData = Utilities.base64Decode(params.fileData);
          var blob = Utilities.newBlob(decodedData, params.mimeType || 'image/jpeg', params.fileName);

          attachments.push(blob);

          var folder = DriveApp.getFolderById(SICK_LEAVE_FOLDER_ID);
          var driveFile = folder.createFile(blob);
          driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
          var fileUrl = driveFile.getUrl();

          finalComment += "\n\n" + fileUrl;
        } catch (ePhoto) {
          console.error("Помилка збереження або обробки фото: ", ePhoto);
        }
      }

      // ID під блокуванням — інакше дві одночасні заявки отримають однаковий номер
      var nextId;
      var lockReq = LockService.getScriptLock();
      try {
        lockReq.waitLock(30000);
      } catch (eLock) {
        return buildCorsResponse({ error: "Система зайнята, спробуйте ще раз" });
      }
      try {
        var dataReq = sheetReq.getDataRange().getValues();
        var ids = dataReq.slice(1)
          .map(function (r) { return parseInt(r[0], 10); })
          .filter(function (id) { return !isNaN(id); });
        nextId = ids.length > 0 ? Math.max.apply(null, ids) + 1 : 1;

        sheetReq.appendRow([nextId, params.date, activeUser, params.type, finalComment, "Очікує"]);
      } finally {
        lockReq.releaseLock();
      }

      var sheetLogsReq = ssMain.getSheetByName('Логи');
      if (sheetLogsReq) {
        var logRoleName = isAdmin ? 'Адміністратор' : activeUser;
        sheetLogsReq.appendRow([new Date(), logRoleName, "Відправка заявки: " + params.type + " на " + params.date]);
      }

      try {
        var adminSheetMail = ssMain.getSheetByName('Адміністрація');
        var adminEmails = [];

        if (adminSheetMail) {
          var adminDataMail = adminSheetMail.getDataRange().getValues();
          for (var a = 1; a < adminDataMail.length; a++) {
            var email = String(adminDataMail[a][1]).trim();
            if (email && email.indexOf('@') !== -1) {
              adminEmails.push(email);
            }
          }
        }

        if (adminEmails.length > 0) {
          var adminEmailStr = adminEmails.join(',');

          var requestTitle = "Нова заявка на зміну";
          var typeStr = String(params.type);
          if (typeStr.indexOf("Лікарняний") !== -1) {
            requestTitle = "Нова заявка на лікарняний";
          } else if (typeStr.indexOf("Відпустка") !== -1) {
            requestTitle = "Нова заявка на відпустку";
          }

          var subject = requestTitle + " від " + activeUser;

          var htmlMessage = `
            <div style="font-family: Arial, sans-serif; background-color: #f8fafc; padding: 20px;">
              <div style="background-color: #ffffff; border: 1px solid #e2e8f0; border-radius: 8px; padding: 20px; max-width: 600px; margin: 0 auto; box-shadow: 0 1px 3px rgba(0,0,0,0.05);">
                <h2 style="color: #059669; font-size: 20px; margin-top: 0; padding-bottom: 10px; border-bottom: 2px solid #059669;">
                  ${requestTitle}
                </h2>
                <div style="font-size: 16px; color: #1e293b; line-height: 1.6; margin-top: 15px;">
                  <p style="margin: 10px 0;"><strong>Працівник:</strong> ${activeUser}</p>
                  <p style="margin: 10px 0;"><strong>Дата виходу/період:</strong> ${params.date}</p>
                  <p style="margin: 10px 0;"><strong>Тип зміни:</strong> ${params.type}</p>
                  <p style="margin: 10px 0;"><strong>Коментар / Довідка:</strong> ${params.comment || "немає"}</p>
                </div>
              </div>
            </div>
          `;

          MailApp.sendEmail({
            to: adminEmailStr,
            subject: subject,
            htmlBody: htmlMessage,
            attachments: attachments
          });
        }
      } catch (eMail) {
        console.error("Помилка відправки листа: " + eMail.toString());
      }

      return buildCorsResponse({ status: "OK", id: nextId });
    }

    // --- ОТРИМАННЯ ЗАЯВОК (ПРАЦІВНИК бачить лише свої) ---
    if (params.requestType === 'get_my_requests') {
      var sheetReqPortal = ssMain.getSheetByName('Заявки');
      if (!sheetReqPortal) return buildCorsResponse([]);

      var dataReqPortal = sheetReqPortal.getDataRange().getValues();
      var myReqs = [];
      var targetUser = normName_(activeUser);

      for (var m = 1; m < dataReqPortal.length; m++) {
        if (normName_(dataReqPortal[m][2]) === targetUser) {
          myReqs.push({
            id: String(dataReqPortal[m][0]),
            date: formatMyDate(dataReqPortal[m][1]),
            type: String(dataReqPortal[m][3]),
            comment: String(dataReqPortal[m][4] || ''),
            status: String(dataReqPortal[m][5] || 'Очікує')
          });
        }
      }
      return buildCorsResponse(myReqs.reverse());
    }

    // 3. ОТРИМАННЯ ВСІХ ЗАЯВОК (ТІЛЬКИ АДМІН)
    if (params.requestType === 'get_requests') {
      if (!isAdmin) return denyResponse_();

      var sheetReqAll = ssMain.getSheetByName('Заявки');
      if (!sheetReqAll) return buildCorsResponse([]);

      var dataReqAll = sheetReqAll.getDataRange().getValues();
      var allReqs = [];
      for (var n = 1; n < dataReqAll.length; n++) {
        if (!dataReqAll[n][0] || !dataReqAll[n][2]) continue;
        allReqs.push({
          id: String(dataReqAll[n][0]),
          date: formatMyDate(dataReqAll[n][1]),
          user: String(dataReqAll[n][2]),
          type: String(dataReqAll[n][3]),
          comment: String(dataReqAll[n][4] || ''),
          status: String(dataReqAll[n][5] || '')
        });
      }
      return buildCorsResponse(allReqs.reverse());
    }

    // 4. СПИСОК ПРАЦІВНИКІВ (ТІЛЬКИ АДМІН — тут віддаються паролі!)
    if (params.requestType === 'get_employees_list') {
        if (!isAdmin) return denyResponse_();

        var sheetContactsList = ssMain.getSheetByName('Активні');
        if (!sheetContactsList) return buildCorsResponse([]);
        var dataList = sheetContactsList.getDataRange().getValues();
        var emps = [];
        for (var p = 1; p < dataList.length; p++) {
            if (!dataList[p][1]) continue;
            var startPhone = String(dataList[p][2] || '');
            var newLoginEmp = String(dataList[p][9] || '');

            var defaultPassEmp = String(dataList[p][6] || '');
            var newPassEmp = String(dataList[p][10] || '');
            var activePassEmp = newPassEmp !== "" ? newPassEmp : defaultPassEmp;

            emps.push({
                name: String(dataList[p][1]),
                phone: startPhone,
                dob: formatMyDate(dataList[p][3]),
                login: displayLogin_(newLoginEmp, startPhone),
                password: activePassEmp
            });
        }
        return buildCorsResponse(emps);
    }

    // 5. ДОДАТИ ПРАЦІВНИКА (ТІЛЬКИ АДМІН)
    if (params.requestType === 'add_employee') {
        if (!isAdmin) return denyResponse_();

        var sheetContactsAdd = ssMain.getSheetByName('Активні');
        if (!sheetContactsAdd) return buildCorsResponse({error: "Таблиця не знайдена"});

        var defaultLoginAdd = String(params.phone).replace(/\D/g, '').slice(-10);
        var defaultPassAdd = generateSecurePassword();

        var lockAdd = LockService.getScriptLock();
        try {
          lockAdd.waitLock(30000);
        } catch (eLockAdd) {
          return buildCorsResponse({ error: "Система зайнята, спробуйте ще раз" });
        }
        try {
          var dataAdd = sheetContactsAdd.getDataRange().getValues();
          var idsAdd = dataAdd.slice(1)
            .map(function (r) { return parseInt(r[0], 10); })
            .filter(function (id) { return !isNaN(id); });
          var nextIdAdd = idsAdd.length > 0 ? Math.max.apply(null, idsAdd) + 1 : 1;

          sheetContactsAdd.appendRow([
              nextIdAdd, params.name, params.phone, params.dob, '', '', defaultPassAdd, '', '', defaultLoginAdd, defaultPassAdd
          ]);

          // Текстовий формат + перезапис, щоб провідні нулі не зникли
          var newRowA = sheetContactsAdd.getLastRow();
          [COL_PHONE, COL_DEFAULT_PASS, COL_LOGIN, COL_PASS].forEach(function (col) {
            sheetContactsAdd.getRange(newRowA, col).setNumberFormat('@');
          });
          sheetContactsAdd.getRange(newRowA, COL_PHONE       ).setValue(String(params.phone));
          sheetContactsAdd.getRange(newRowA, COL_DEFAULT_PASS).setValue(String(defaultPassAdd));
          sheetContactsAdd.getRange(newRowA, COL_LOGIN       ).setValue(String(defaultLoginAdd));
          sheetContactsAdd.getRange(newRowA, COL_PASS        ).setValue(String(defaultPassAdd));
        } finally {
          lockAdd.releaseLock();
        }

        return buildCorsResponse({status: "OK", login: defaultLoginAdd, password: defaultPassAdd});
    }

    // 7. ОТРИМАТИ ГРАФІК (ТІЛЬКИ АДМІН — це графік усіх працівників)
    if (params.requestType === 'get_full_schedule') {
        if (!isAdmin) return denyResponse_();

        var sheetSchedFull = ssSched.getSheetByName(params.monthYear);
        if (!sheetSchedFull) return buildCorsResponse({error: "Графік відсутній"});
        var dataSchedFull = sheetSchedFull.getDataRange().getValues();
        var resultSched = [];
        for (var y = 4; y < dataSchedFull.length; y++) {
            var nameSched = dataSchedFull[y][0];
            if (!nameSched) continue;
            var posSched = String(dataSchedFull[y][1] || '').trim();
            var schedArr = [];
            for (var d = 1; d <= 31; d++) {
                var dIdx = 2 + (d - 1) * 2;
                var nIdx = 3 + (d - 1) * 2;
                if (dIdx < dataSchedFull[y].length) {
                    schedArr.push({
                        day: d,
                        dVal: String(dataSchedFull[y][dIdx] || '').trim(),
                        nVal: String(dataSchedFull[y][nIdx] || '').trim()
                    });
                }
            }
            resultSched.push({name: String(nameSched), position: posSched, schedule: schedArr});
        }
        return buildCorsResponse(resultSched);
    }

    // 8. РЕДАГУВАТИ КЛІТИНКУ ГРАФІКА (ТІЛЬКИ АДМІН)
    if (params.requestType === 'edit_schedule_cell') {
        if (!isAdmin) return denyResponse_();

        var sheetSchedEdit = ssSched.getSheetByName(params.monthYear);
        if (!sheetSchedEdit) return buildCorsResponse({error: "Місяць не знайдено"});

        var dataSchedEdit = sheetSchedEdit.getDataRange().getValues();
        var searchNameEdit = normName_(params.empName);
        var foundEdit = false;

        for (var r = 4; r < dataSchedEdit.length; r++) {
            if (normName_(dataSchedEdit[r][0]) === searchNameEdit) {
                var colD = 3 + (params.day - 1) * 2;
                var colN = 4 + (params.day - 1) * 2;

                if (params.newValue === 'CLEAR') {
                    if (params.shiftTime === 'Обидві') {
                        sheetSchedEdit.getRange(r + 1, colD).clearContent();
                        sheetSchedEdit.getRange(r + 1, colN).clearContent();
                    }
                } else {
                    if (params.shiftTime === 'День') {
                        sheetSchedEdit.getRange(r + 1, colD).setValue(params.newValue);
                        sheetSchedEdit.getRange(r + 1, colN).clearContent();
                    } else if (params.shiftTime === 'Ніч') {
                        sheetSchedEdit.getRange(r + 1, colN).setValue(params.newValue);
                        sheetSchedEdit.getRange(r + 1, colD).clearContent();
                    }
                }
                foundEdit = true;
                break;
            }
        }
        if (!foundEdit) return buildCorsResponse({error: "Працівника не знайдено"});
        return buildCorsResponse({status: "OK"});
    }

    // 9. ОНОВИТИ СТАТУС ЗАЯВКИ (ТІЛЬКИ АДМІН — інакше працівник схвалить собі сам)
    if (params.requestType === 'update_request_status') {
      if (!isAdmin) return denyResponse_();
      return buildCorsResponse({status: updateShiftStatus(params)});
    }

    var penaltyResp = handlePenaltyRequests(params, ssMain, activeUser, activeRole);
    if (penaltyResp) return penaltyResp;

    return buildCorsResponse({ error: "Невідомий запит" });

  } catch (err) {
    return buildCorsResponse({ error: err.toString() });
  }
}

// ================= ПРОВЕДЕННЯ ЗАЯВКИ У ГРАФІК =================

function updateShiftStatus(p) {
  var ssMain = SpreadsheetApp.openById(MAIN_SHEET_ID);
  var ssSched = SpreadsheetApp.openById(SCHEDULE_SHEET_ID);
  var sheetReq = ssMain.getSheetByName('Заявки');
  if (!sheetReq) return "NO_SHEET";

  var dataReq = sheetReq.getDataRange().getValues();

  for (var i = 1; i < dataReq.length; i++) {
    if (String(dataReq[i][0]) !== String(p.id)) continue;

    sheetReq.getRange(i + 1, 6).setValue(p.status);

    try {
      // ВИПРАВЛЕНО: беремо ВЕСЬ період, а не лише першу дату діапазону
      var days = getDatesInRange_(p.date ? p.date : dataReq[i][1]);
      if (!days.length) break;

      var reqType = p.type || String(dataReq[i][3]);
      var isNight = reqType && reqType.toLowerCase().indexOf('ніч') !== -1;

      var valToSet = SHIFT_EXTRA;
      if (reqType.indexOf('Відпустка') !== -1) valToSet = 'В';
      if (reqType.indexOf('Лікарняний') !== -1) valToSet = 'Л';

      var reqUser = normName_(p.user || dataReq[i][2]);

      // Групуємо дні по місяцях, щоб не читати той самий лист двічі
      var byMonth = {};
      days.forEach(function (d) {
        var key = UKR_MONTHS[d.monthIdx] + ' ' + d.year;
        if (!byMonth[key]) byMonth[key] = [];
        byMonth[key].push(d.day);
      });

      Object.keys(byMonth).forEach(function (monthName) {
        var sheetMonth = ssSched.getSheetByName(monthName);
        if (!sheetMonth) return;

        var dataMonth = sheetMonth.getDataRange().getValues();
        var rowIdx = -1;
        for (var row = 4; row < dataMonth.length; row++) {
          var schedUser = normName_(dataMonth[row][0]);
          if (schedUser && schedUser === reqUser) { rowIdx = row; break; }
        }
        if (rowIdx === -1) return;

        byMonth[monthName].forEach(function (day) {
          var colIdx = 3 + (day - 1) * 2 + (isNight ? 1 : 0);
          var cell = sheetMonth.getRange(rowIdx + 1, colIdx);

          if (p.status === 'Схвалено' || p.status === 'Погоджено') {
            cell.setValue(valToSet);
          } else if (p.status === 'Відхилено' || p.status === 'Очікує') {
            var currentVal = String(cell.getValue()).toUpperCase().trim();
            // '3' — застаріле значення зі старої версії, теж прибираємо
            if (currentVal === '3' || currentVal === 'З' || currentVal === 'В' || currentVal === 'Л') {
              cell.clearContent();
            }
          }
        });
      });
    } catch (err) {
      console.error("Update Shift Error: ", err);
    }
    break;
  }
  return "OK";
}

// ================= ОБСЛУГОВУВАННЯ (запускати з редактора) =================

/**
 * ЗАПУСТИТИ ОДИН РАЗ після встановлення.
 * Переводить телефон/логін/пароль у ТЕКСТОВИЙ формат, щоб Таблиці
 * більше не з'їдали провідний нуль.
 *
 * УВАГА: уже втрачені нулі функція НЕ відновлює. Рядки, де логін/пароль
 * виглядає без нуля (напр. 508328999 замість 0508328999), треба один раз
 * перевписати вручну — після цієї функції нуль збережеться.
 */
function fixCredentialColumnsToText() {
  var ss = SpreadsheetApp.openById(MAIN_SHEET_ID);
  var sh = ss.getSheetByName('Активні');
  if (!sh) { Logger.log('Вкладки "Активні" немає'); return; }

  var rows = sh.getMaxRows();
  [COL_PHONE, COL_DEFAULT_PASS, COL_LOGIN, COL_PASS].forEach(function (col) {
    sh.getRange(1, col, rows, 1).setNumberFormat('@');
  });
  Logger.log('Готово: колонки C, G, J, K вкладки "Активні" переведено у текстовий формат.');
}

/**
 * Прибирає прострочені сесії. Раніше вони видалялися лише випадково,
 * тому вкладка «Сесії» росла нескінченно, а validateSession читав її повністю
 * на КОЖЕН запит.
 *
 * Працює одним перезаписом діапазону, а не тисячами deleteRow — інакше
 * на великій вкладці функція впирається в ліміт виконання 6 хвилин.
 *
 * Рекомендовано повісити тригер: Тригери → Додати тригер → cleanupOldSessions → раз на день.
 */
function cleanupOldSessions() {
  var ss = SpreadsheetApp.openById(MAIN_SHEET_ID);
  var sheet = ss.getSheetByName('Сесії');
  if (!sheet) { Logger.log('Вкладки "Сесії" немає'); return; }

  var lastRow = sheet.getLastRow();
  if (lastRow < 2) { Logger.log('Сесій немає'); return; }

  var lastCol = Math.max(sheet.getLastColumn(), 4);
  var data = sheet.getRange(1, 1, lastRow, lastCol).getValues();
  var now = new Date().getTime();

  var keep = [];
  for (var i = 1; i < data.length; i++) {
    if (!data[i][0]) continue;                    // порожній рядок — не зберігаємо
    var t = new Date(data[i][2]).getTime();
    if (!isNaN(t) && now - t < SESSION_TTL_MS) keep.push(data[i]);
  }

  var removed = (lastRow - 1) - keep.length;
  if (removed <= 0) {
    Logger.log('Прострочених сесій немає. Активних: ' + keep.length);
    return;
  }

  sheet.getRange(2, 1, lastRow - 1, lastCol).clearContent();
  if (keep.length) sheet.getRange(2, 1, keep.length, lastCol).setValues(keep);

  Logger.log('Видалено прострочених сесій: ' + removed + '. Лишилось активних: ' + keep.length);
}

/**
 * Діагностика виправлення «0»: показує, у кого логін/пароль
 * втратив провідний нуль. Нічого не змінює — лише звіт у журналі.
 */
function auditCredentialZeros() {
  var ss = SpreadsheetApp.openById(MAIN_SHEET_ID);
  var sh = ss.getSheetByName('Активні');
  if (!sh) { Logger.log('Вкладки "Активні" немає'); return; }

  var data = sh.getDataRange().getValues();
  var problems = [];

  for (var i = 1; i < data.length; i++) {
    var name = String(data[i][1] || '').trim();
    if (!name) continue;

    var phoneDigits = String(data[i][2] || '').replace(/\D/g, '');
    var login = String(data[i][9] || '').trim();
    var tail = phoneDigits.slice(-10);

    if (login && /^\d+$/.test(login) && tail &&
        _stripLeadZeros(tail) === _stripLeadZeros(login) && tail !== login) {
      problems.push('рядок ' + (i + 1) + ' · ' + name + ' · логін "' + login + '" → має бути "' + tail + '"');
    }
    if (typeof data[i][10] === 'number') {
      problems.push('рядок ' + (i + 1) + ' · ' + name + ' · пароль збережено ЯК ЧИСЛО (' + data[i][10] + ') — перевірте провідний нуль');
    }
  }

  Logger.log(problems.length
    ? 'Знайдено проблем: ' + problems.length + '\n' + problems.join('\n')
    : 'Проблем із провідними нулями не знайдено.');
}
