/**
 * Code.gs — новий бекенд чек-листа.
 *
 * Відмінності від старого doPost:
 *   • пише рядок на кожен пункт, а не текстовий блок в одну комірку;
 *   • статус рахує з довідників 01_Пункти / 02_Варіанти, а не з позиції кнопки;
 *   • report_id перевіряється — повтор із офлайн-черги не створює дубль;
 *   • tryLock перевіряється, аркуш береться за іменем;
 *   • повертає справжній JSON, тож клієнт може перестати слати mode:'no-cors';
 *   • невдале збереження фото ВИДНО у відповіді, а не ховається в текст звіту.
 *
 * Клієнт має слати POST БЕЗ власного заголовка Content-Type — тоді браузер
 * поставить text/plain, preflight не виникне і відповідь буде читабельною.
 */

var APP_VERSION = 'checklist-2026-08-23';

function doGet(e) {
  var action = (e && e.parameter && e.parameter.action) || 'getConfig';
  try {
    if (action === 'getConfig') return jsonOut({ ok: true, config: buildClientConfig_() });
    if (action === 'ping') return jsonOut({ ok: true, version: APP_VERSION, ts: nowIsoUtc() });
    return jsonOut({ ok: false, error: 'unknown action: ' + action });
  } catch (err) {
    return jsonOut({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  var payload;
  try {
    payload = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOut({ ok: false, error: 'bad json' });
  }

  var result = withLock(function () { return submitReport_(payload); });
  if (!result.ok && result.retryable) {
    logEvent('Техніка', 'submit.busy', 'не вдалося взяти блокування', {});
  }
  return jsonOut(result);
}

function submitReport_(p) {
  var problems = validatePayload_(p);
  if (problems.length) {
    logEvent('Техніка', 'submit.invalid', problems.join('; '), { report_id: p && p.report_id });
    return { ok: false, error: 'invalid payload', details: problems };
  }

  // --- ідемпотентність ---
  var existing = existingReportIds_();
  if (existing[p.report_id]) {
    logEvent('Техніка', 'submit.duplicate', 'повтор ' + p.report_id, { report_id: p.report_id });
    return { ok: true, duplicate: true, report_id: p.report_id };
  }

  var dict = loadDictionaries_();
  var user = resolveUser_(dict, p.user_id, p.user_name);
  var now = new Date();
  var bizDate = p.business_date || businessDate(now);

  var answers = [], cnt = { ok: 0, warn: 0, alert: 0, empty: 0, unknown: 0 };
  var alerts = [];

  (p.items || []).forEach(function (it, i) {
    var item = dict.byId[it.item_id];
    var nums = (it.values || []).map(toNumber).filter(function (n) { return n !== null; });
    var status;
    if (!item) {
      status = 'unknown';
    } else if (it.value === '' && !nums.length) {
      status = 'empty';
    } else if (item.type === 'binary') {
      status = dict.optStatus[it.item_id + '|' + String(it.value).trim()] || 'unknown';
    } else if (item.type === 'number') {
      status = nums.length ? worstStatus(nums.map(function (v, f) {
        return numberStatus_(item, f + 1, v);
      })) : 'empty';
    } else {
      status = it.value ? 'ok' : 'empty';
    }
    cnt[status] = (cnt[status] || 0) + 1;
    if (status === 'alert' || status === 'warn') {
      alerts.push({ status: status, text: item ? item.text : it.item_id,
                    value: it.value || nums.join(' / '), comment: it.comment || '' });
    }

    answers.push([
      p.report_id + '#' + (i + 1), p.report_id, bizDate, p.stage, p.role, user.user_id,
      it.item_id, item ? item.text : '', i + 1,
      it.value || '', num_(nums, 0), num_(nums, 1), num_(nums, 2),
      status, '', it.comment || '', ''
    ]);
  });

  // --- фото ---
  var photos = savePhotos_(p, answers, dict);

  appendRows(SH.REPORTS, [[
    p.report_id, nowIsoUtc(), bizDate, p.stage, p.role, user.user_id, user.name,
    p.config_version || '', (p.items || []).length,
    cnt.ok, cnt.warn, cnt.alert, cnt.empty,
    photos.saved, photos.failed, 'app', '', p.app_version || APP_VERSION
  ]]);
  appendRows(SH.ANSWERS, answers);
  appendRows(SH.PHOTOS, photos.rows);

  try {
    sendReportEmail_(p, user, bizDate, cnt, alerts, photos);
  } catch (mailErr) {
    // звіт уже збережено — розсилка не має його скасовувати, але мовчати теж не можна
    logEvent('Техніка', 'mail.failed', String(mailErr), { report_id: p.report_id });
    return { ok: true, report_id: p.report_id, counts: cnt,
             warnings: ['Звіт збережено, але лист не відправлено: ' + mailErr] };
  }

  var warnings = [];
  if (photos.failed) warnings.push('Не збереглося фото: ' + photos.failed);
  if (cnt.unknown) warnings.push('Пунктів без довідника: ' + cnt.unknown);

  logEvent('Звіт', 'submit.ok', 'alert=' + cnt.alert + ' warn=' + cnt.warn,
           { report_id: p.report_id, user_id: user.user_id, app_version: p.app_version });

  return { ok: true, report_id: p.report_id, counts: cnt, warnings: warnings };
}

function validatePayload_(p) {
  var out = [];
  if (!p) return ['порожній payload'];
  if (!p.report_id) out.push('немає report_id');
  if (['Початок зміни', 'Кінець зміни'].indexOf(p.stage) === -1) out.push('невідома стадія');
  if (['Механік', 'Майстер'].indexOf(p.role) === -1) out.push('невідома роль');
  if (!p.user_id && !p.user_name) out.push('немає автора');
  if (!p.items || !p.items.length) out.push('немає жодного пункту');
  return out;
}

function resolveUser_(dict, userId, userName) {
  if (userId && dict.byIdUser && dict.byIdUser[userId]) {
    return { user_id: userId, name: dict.byIdUser[userId] };
  }
  var uid = dict.byName[String(userName || '').trim()];
  return { user_id: uid || 'U-000', name: userName || '' };
}

/**
 * Зберігає фото на Drive. Доступ перевіряється ОДИН раз наперед: якщо папка
 * недоступна, ми одразу знаємо про це і повідомляємо, а не пишемо 134 рядки
 * «Помилка фото» всередину звіту, як робив старий скрипт.
 */
function savePhotos_(p, answers, dict) {
  var out = { rows: [], saved: 0, failed: 0 };
  var items = (p.items || []).filter(function (it) { return it.photoData; });
  if (!items.length) return out;

  var folderId = PropertiesService.getScriptProperties().getProperty('PHOTO_FOLDER_ID');
  var folder = null, folderError = '';
  try {
    folder = folderId ? DriveApp.getFolderById(folderId) : null;
    if (!folder) folderError = 'PHOTO_FOLDER_ID не заданий у властивостях скрипта';
  } catch (err) {
    folderError = String(err);
  }

  items.forEach(function (it, k) {
    var pid = p.report_id + '#p' + (k + 1);
    if (!folder) {
      out.rows.push([pid, p.report_id, it.item_id, '', '', 'failed', folderError]);
      out.failed++;
      return;
    }
    try {
      var b64 = it.photoData.indexOf('base64,') > -1 ? it.photoData.split('base64,')[1] : it.photoData;
      var name = [businessDate(), p.stage === 'Кінець зміни' ? 'end' : 'start',
                  it.item_id, p.report_id].join('_') + '.jpg';
      var file = folder.createFile(Utilities.newBlob(Utilities.base64Decode(b64), MimeType.JPEG, name));
      var url = file.getUrl();
      out.rows.push([pid, p.report_id, it.item_id, url, file.getId(), 'saved', '']);
      out.saved++;
      for (var a = 0; a < answers.length; a++) {
        if (answers[a][6] === it.item_id) { answers[a][16] = url; break; }
      }
    } catch (err) {
      out.rows.push([pid, p.report_id, it.item_id, '', '', 'failed', String(err)]);
      out.failed++;
      logEvent('Техніка', 'photo.failed', String(err), { report_id: p.report_id });
    }
  });
  return out;
}

/** Конфігурація для клієнта: пункти, варіанти, працівники — з довідників. */
function buildClientConfig_() {
  var it = readTable(SH.ITEMS), op = readTable(SH.OPTIONS), em = readTable(SH.EMPLOYEES);
  var today = businessDate();

  var opts = {};
  op.rows.forEach(function (r) {
    if (!r[0] || String(r[4]).trim() === 'ні') return;   // історичні варіанти не показуємо
    (opts[r[0]] = opts[r[0]] || []).push({ value: r[2], status: r[3] });
  });

  var items = it.rows.filter(function (r) {
    var o = {};
    it.header.forEach(function (h, i) { o[h] = r[i]; });
    if (!o.item_id || o.visible_on === 'none') return false;
    return !o.active_to || String(o.active_to) >= today;
  }).map(function (r) {
    var o = {};
    it.header.forEach(function (h, i) { o[h] = r[i]; });
    o.options = opts[o.item_id] || [];
    o.labels = String(o.labels || '').split(';').filter(String);
    return o;
  });

  var staff = em.rows.filter(function (r) { return r[0] && String(r[3]).trim() !== 'ні'; })
    .map(function (r) { return { user_id: r[0], name: r[1], role: r[2] }; });

  return { version: APP_VERSION, items: items, employees: staff };
}
