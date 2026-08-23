/**
 * Report.gs — розсилка і щоденний контроль.
 *
 * Головна відмінність від старого листа: блок «Відхилень: N» стоїть УГОРІ,
 * до всього іншого. Раніше 303 сигнали за пів року були розкидані по 352
 * листах серед 38 зелених рядків, і на них ніхто не реагував.
 *
 * Одержувачі беруться зі Script Properties, а НЕ з payload клієнта.
 */

function recipients_(key) {
  var v = PropertiesService.getScriptProperties().getProperty(key || 'MAIL_TO');
  return (v || '').split(',').map(function (s) { return s.trim(); }).filter(String);
}

function sendReportEmail_(p, user, bizDate, cnt, alerts, photos) {
  var to = recipients_('MAIL_TO');
  if (!to.length) {
    logEvent('Техніка', 'mail.skipped', 'MAIL_TO не заданий у властивостях скрипта', {});
    return;
  }

  var head = cnt.alert
    ? '⚠️ Відхилень: ' + cnt.alert + (cnt.warn ? ' · попереджень: ' + cnt.warn : '')
    : (cnt.warn ? '⚠️ Попереджень: ' + cnt.warn : '✅ Без відхилень');

  var subject = '[' + (cnt.alert ? 'ВІДХИЛЕННЯ ' + cnt.alert : 'OK') + '] ' +
                p.stage + ' · ' + (user.name || p.user_name) + ' · ' + bizDate;

  var html = '<div style="font-family:sans-serif;font-size:14px;color:#1e293b">';
  html += '<div style="background:' + (cnt.alert ? '#fef2f2' : '#f0fdf4') +
          ';border-left:5px solid ' + (cnt.alert ? '#dc2626' : '#16a34a') +
          ';padding:14px 16px;margin-bottom:18px">' +
          '<div style="font-size:18px;font-weight:700">' + esc_(head) + '</div>' +
          '<div style="color:#64748b;margin-top:4px">' + esc_(p.stage) + ' · ' +
          esc_(user.name || p.user_name || '') + ' · ' + esc_(bizDate) + '</div></div>';

  if (alerts.length) {
    html += '<table style="border-collapse:collapse;width:100%;margin-bottom:18px">';
    alerts.forEach(function (a) {
      var color = a.status === 'alert' ? '#b91c1c' : '#b45309';
      html += '<tr><td style="border:1px solid #e2e8f0;padding:9px 12px;color:' + color + '">' +
              (a.status === 'alert' ? '❗ ' : '⚠️ ') + esc_(a.text) +
              ' <b>[' + esc_(a.value) + ']</b>' +
              (a.comment ? '<br><i style="color:#64748b;font-size:12px">💬 ' + esc_(a.comment) + '</i>' : '') +
              '</td></tr>';
    });
    html += '</table>';
  }

  html += '<div style="color:#64748b">Пунктів: ' + ((p.items || []).length) +
          ' · у нормі ' + cnt.ok + ' · не заповнено ' + cnt.empty + '</div>';

  if (photos.failed) {
    html += '<div style="background:#fffbeb;border:1px solid #fcd34d;padding:10px;margin-top:14px">' +
            'Не збереглося фото: <b>' + photos.failed + '</b>. Перевірте доступ скрипта до Drive.</div>';
  }
  html += '<div style="color:#94a3b8;font-size:12px;margin-top:20px">' +
          esc_(p.report_id) + '</div></div>';

  MailApp.sendEmail({ to: to.join(','), subject: subject, htmlBody: html });
}

function esc_(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Щоденна перевірка: чи здано обидві зміни за вчора.
 * Саме цього бракувало — 13 днів без жодного звіту і 18 днів з однією зміною
 * з двох пройшли непоміченими за пів року.
 *
 * Повісити тригер: щодня ~09:00.
 */
function checkSchedule() {
  var d = new Date();
  d.setDate(d.getDate() - 1);
  var day = businessDate(d);

  var rep = readTable(SH.REPORTS);
  var got = {};
  rep.rows.forEach(function (r) {
    if (String(r[rep.col.business_date]) !== day) return;
    var k = r[rep.col.role] + '|' + r[rep.col.stage];
    got[k] = (got[k] || 0) + 1;
  });

  // повторний запуск за той самий день не має дублювати рядки
  var sch = readTable(SH.SCHEDULE);
  var already = {};
  sch.rows.forEach(function (r) { already[r[0] + '|' + r[1] + '|' + r[2]] = true; });

  var expect = [['Механік', 'Початок зміни'], ['Механік', 'Кінець зміни']];
  var rows = [], missing = [], dupes = [];
  expect.forEach(function (e) {
    var n = got[e[0] + '|' + e[1]] || 0;
    var st = n === 0 ? 'пропущено' : (n > 1 ? 'дубль' : 'ok');
    if (!already[day + '|' + e[1] + '|' + e[0]]) rows.push([day, e[1], e[0], 1, n, st]);
    if (st === 'пропущено') missing.push(e[0] + ' · ' + e[1]);
    if (st === 'дубль') dupes.push(e[0] + ' · ' + e[1] + ' (' + n + ')');
  });
  appendRows(SH.SCHEDULE, rows);
  if (!rows.length) return 'за ' + day + ' перевірку вже виконано';

  if (!missing.length && !dupes.length) return 'за ' + day + ' усе на місці';

  var to = recipients_('MAIL_ALERT_TO').length ? recipients_('MAIL_ALERT_TO') : recipients_('MAIL_TO');
  if (to.length) {
    var body = '<div style="font-family:sans-serif">' +
      (missing.length ? '<p><b>Не здано чек-лист за ' + esc_(day) + ':</b><br>' +
        missing.map(esc_).join('<br>') + '</p>' : '') +
      (dupes.length ? '<p><b>Здано більше одного разу:</b><br>' + dupes.map(esc_).join('<br>') + '</p>' : '') +
      '</div>';
    MailApp.sendEmail({ to: to.join(','), subject: 'Чек-лист за ' + day + ': є питання', htmlBody: body });
  }
  var msg = 'пропущено: ' + (missing.join(', ') || '—') + '; дублі: ' + (dupes.join(', ') || '—');
  logEvent('Контроль', 'checkSchedule', msg);
  return msg;
}

/**
 * Тижневий дайджест: що повторюється. Повісити тригер на понеділок.
 * Саме він мав би ще в березні показати, що UF-знезараження не працює 55 разів.
 */
function weeklyDigest() {
  var since = new Date();
  since.setDate(since.getDate() - 7);
  var from = businessDate(since);

  var ans = readTable(SH.ANSWERS);
  var byItem = {};
  ans.rows.forEach(function (r) {
    if (String(r[ans.col.business_date]) < from) return;
    var st = r[ans.col.status];
    if (st !== 'alert' && st !== 'warn') return;
    var k = r[ans.col.item_text_snapshot] || r[ans.col.item_id];
    byItem[k] = byItem[k] || { alert: 0, warn: 0 };
    byItem[k][st]++;
  });

  var list = Object.keys(byItem).map(function (k) {
    return { text: k, a: byItem[k].alert, w: byItem[k].warn };
  }).sort(function (x, y) { return (y.a * 10 + y.w) - (x.a * 10 + x.w); });

  var to = recipients_('MAIL_ALERT_TO').length ? recipients_('MAIL_ALERT_TO') : recipients_('MAIL_TO');
  if (!to.length) return 'MAIL_TO не заданий';

  var html = '<div style="font-family:sans-serif;font-size:14px">' +
             '<h3>Відхилення за тиждень (з ' + esc_(from) + ')</h3>';
  if (!list.length) {
    html += '<p>Відхилень немає.</p>';
  } else {
    html += '<table style="border-collapse:collapse">';
    list.slice(0, 20).forEach(function (x) {
      html += '<tr><td style="border:1px solid #e2e8f0;padding:7px 10px">' + esc_(x.text) + '</td>' +
              '<td style="border:1px solid #e2e8f0;padding:7px 10px;text-align:center;color:#b91c1c"><b>' +
              x.a + '</b></td>' +
              '<td style="border:1px solid #e2e8f0;padding:7px 10px;text-align:center;color:#b45309">' +
              x.w + '</td></tr>';
    });
    html += '</table><p style="color:#64748b;font-size:12px">колонки: відхилень · попереджень</p>';
  }
  html += '</div>';
  MailApp.sendEmail({ to: to.join(','), subject: 'Чек-лист: відхилення за тиждень', htmlBody: html });
  logEvent('Контроль', 'weeklyDigest', 'позицій у дайджесті: ' + list.length);
  return 'відправлено, позицій: ' + list.length;
}

/** Разова установка тригерів. Повторний запуск не дублює. */
function installTriggers() {
  var have = {};
  ScriptApp.getProjectTriggers().forEach(function (t) { have[t.getHandlerFunction()] = true; });
  if (!have.checkSchedule) {
    ScriptApp.newTrigger('checkSchedule').timeBased().atHour(9).everyDays(1).inTimezone(TZ).create();
  }
  if (!have.weeklyDigest) {
    ScriptApp.newTrigger('weeklyDigest').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY)
      .atHour(8).inTimezone(TZ).create();
  }
  return 'тригери на місці';
}
