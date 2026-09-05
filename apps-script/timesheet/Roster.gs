/**
 * Roster.gs — довідник працівників (gw-ref) і звірка ПІБ з табелем.
 */

/** Нормалізація ПІБ: регістр, пробіли, апострофи, латинські двійники кирилиці. */
function normName_(value) {
  var t = String(value === null || value === undefined ? '' : value);
  t = t.replace(/[’‘ʼ'`´]/g, "'");
  var homoglyphs = {
    'A': 'А', 'B': 'В', 'C': 'С', 'E': 'Е', 'H': 'Н', 'I': 'І', 'K': 'К', 'M': 'М',
    'O': 'О', 'P': 'Р', 'T': 'Т', 'X': 'Х', 'Y': 'У',
    'a': 'а', 'c': 'с', 'e': 'е', 'i': 'і', 'o': 'о', 'p': 'р', 'x': 'х', 'y': 'у'
  };
  t = t.replace(/[ABCEHIKMOPTXYaceiopxy]/g, function (ch) { return homoglyphs[ch] || ch; });
  t = t.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
  t = t.toLowerCase();
  t = t.replace(/[ \s]+/g, ' ').trim();
  return t;
}

/** «Бондаренко Валерій Валентинович» і «Бондаренко В. В.» → «бондаренко в. в.» */
function initialsKey_(value) {
  var parts = normName_(value).replace(/\./g, ' ').split(/\s+/).filter(String);
  if (!parts.length) return '';
  var key = parts[0];
  for (var i = 1; i < parts.length; i++) key += ' ' + parts[i].charAt(0) + '.';
  return key;
}

function levenshtein_(a, b) {
  if (a === b) return 0;
  var la = a.length, lb = b.length;
  if (!la) return lb;
  if (!lb) return la;
  if (Math.abs(la - lb) > 4) return Math.abs(la - lb);
  var prev = new Array(lb + 1);
  for (var j = 0; j <= lb; j++) prev[j] = j;
  for (var i = 1; i <= la; i++) {
    var cur = [i];
    var ca = a.charAt(i - 1);
    for (var k = 1; k <= lb; k++) {
      var cost = ca === b.charAt(k - 1) ? 0 : 1;
      cur[k] = Math.min(cur[k - 1] + 1, prev[k] + 1, prev[k - 1] + cost);
    }
    prev = cur;
  }
  return prev[lb];
}

function isAdminOnly_(emp) {
  return /(^|\s)admin(\s|$)/i.test(String(emp.roles || '')) && !emp.posId && !emp.position;
}

/** Читає _REF_Employees та аркуш псевдонімів. */
function loadReference_(cfg) {
  if (!cfg.REF_ID) throw new Error('Не вказано довідник працівників. ' + SETUP_HINT);
  var ss = SpreadsheetApp.openById(cfg.REF_ID);
  var sh = ss.getSheetByName(cfg.REF_EMPLOYEES_SHEET);
  if (!sh) {
    throw new Error('У довіднику (gw-ref) немає аркуша «' + cfg.REF_EMPLOYEES_SHEET + '».');
  }
  var values = sh.getDataRange().getDisplayValues();
  if (values.length < 2) throw new Error('Аркуш «' + cfg.REF_EMPLOYEES_SHEET + '» порожній.');

  var head = values[0].map(normHeader_);
  function idx(title) { return head.indexOf(normHeader_(title)); }
  var cId = idx('emp_id');
  var cFull = idx('ПІБ повне');
  var cShort = idx('ПІБ короткий');
  var cSurname = idx('прізвище');
  var cPosId = idx('pos_id');
  var cPos = idx('посада');
  var cUnit = idx('підрозділ');
  var cStatus = idx('статус');
  var cRoles = idx('ролі додатково');
  if (cId < 0 || cFull < 0) {
    throw new Error('У «' + cfg.REF_EMPLOYEES_SHEET + '» не знайдено колонок emp_id / ПІБ повне.');
  }

  var ref = {
    list: [], byId: {}, byFull: {}, byShort: {}, byInitials: {}, byAlias: {},
    duplicateIds: [], noPosition: []
  };

  // Один і той самий працівник може дати однаковий ключ і з повного, і з короткого
  // ПІБ — інакше він виглядав би як два кандидати й давав хибну «неоднозначність».
  function push(map, key, emp) {
    if (!key) return;
    if (!map[key]) map[key] = [];
    for (var n = 0; n < map[key].length; n++) {
      if (map[key][n] === emp) return;
    }
    map[key].push(emp);
  }

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var id = String(row[cId] || '').trim();
    var full = String(row[cFull] || '').trim();
    if (!id && !full) continue;
    var emp = {
      row: r + 1,
      id: id,
      full: full,
      short: cShort >= 0 ? String(row[cShort] || '').trim() : '',
      surname: cSurname >= 0 ? String(row[cSurname] || '').trim() : '',
      posId: cPosId >= 0 ? String(row[cPosId] || '').trim() : '',
      position: cPos >= 0 ? String(row[cPos] || '').trim() : '',
      unit: cUnit >= 0 ? String(row[cUnit] || '').trim() : '',
      status: cStatus >= 0 ? String(row[cStatus] || '').trim().toLowerCase() : '',
      roles: cRoles >= 0 ? String(row[cRoles] || '').trim() : ''
    };
    emp.fullKey = normName_(emp.full);
    emp.active = emp.status !== 'fired';

    if (emp.id && ref.byId[emp.id]) ref.duplicateIds.push(emp.id);
    if (emp.id) ref.byId[emp.id] = emp;
    ref.list.push(emp);
    push(ref.byFull, emp.fullKey, emp);
    push(ref.byShort, normName_(emp.short), emp);
    push(ref.byInitials, initialsKey_(emp.full), emp);
    if (emp.short) push(ref.byInitials, initialsKey_(emp.short), emp);
    if (emp.active && !emp.posId && !emp.position && !isAdminOnly_(emp)) ref.noPosition.push(emp);
  }

  var alias = findAliasSheet_(ss, cfg);
  ref.aliasSheet = alias;
  if (alias) {
    var av = alias.getDataRange().getDisplayValues();
    for (var i = 1; i < av.length; i++) {
      var variant = normName_(av[i][0]);
      var empId = String(av[i][1] || '').trim();
      if (variant && empId) ref.byAlias[variant] = empId;
    }
  }
  return ref;
}

/** Аркуш псевдонімів шукаємо за заголовком A1, а не за назвою. */
function findAliasSheet_(refSs, cfg) {
  var sheets = refSs.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    if (normHeader_(sheets[i].getRange(1, 1).getDisplayValue()) === normHeader_(cfg.ALIAS_HEADER)) {
      return sheets[i];
    }
  }
  return null;
}

function appendAliases_(cfg, ref, rows) {
  if (!rows.length || !cfg.WRITE_ALIASES) return 0;
  var sheet = ref.aliasSheet;
  if (!sheet) {
    var ss = SpreadsheetApp.openById(cfg.REF_ID);
    sheet = ss.insertSheet(cfg.ALIAS_SHEET_DEFAULT_NAME);
    sheet.getRange(1, 1, 1, 4)
      .setValues([[cfg.ALIAS_HEADER, 'emp_id', 'джерело', 'додано']])
      .setFontWeight('bold');
    ref.aliasSheet = sheet;
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 4).setValues(rows);
  return rows.length;
}

/** Підбирає працівника довідника за ПІБ з табелю. */
function matchEmployee_(ref, name, cfg) {
  var key = normName_(name);
  if (!key) return { status: 'empty' };

  if (ref.byAlias[key] && ref.byId[ref.byAlias[key]]) {
    return { status: 'ok', emp: ref.byId[ref.byAlias[key]], how: 'псевдонім' };
  }

  var chain = [
    { map: ref.byFull, key: key, how: 'ПІБ повне' },
    { map: ref.byShort, key: key, how: 'ПІБ коротке' },
    { map: ref.byInitials, key: initialsKey_(name), how: 'прізвище + ініціали' }
  ];
  for (var i = 0; i < chain.length; i++) {
    var hit = chain[i].key ? chain[i].map[chain[i].key] : null;
    if (!hit) continue;
    if (hit.length === 1) return { status: 'ok', emp: hit[0], how: chain[i].how };
    return { status: 'ambiguous', candidates: hit, how: chain[i].how };
  }

  var surname = key.split(' ')[0];
  var best = null, bestDist = 1e9, ties = 0;
  for (var j = 0; j < ref.list.length; j++) {
    var emp = ref.list[j];
    if (!emp.fullKey) continue;
    if (levenshtein_(emp.fullKey.split(' ')[0], surname) > 1) continue;
    var d = levenshtein_(emp.fullKey, key);
    if (d < bestDist) { bestDist = d; best = emp; ties = 1; }
    else if (d === bestDist) ties++;
  }
  if (best && bestDist <= cfg.FUZZY_MAX_DISTANCE && ties === 1) {
    return { status: 'fuzzy', emp: best, how: 'нечіткий збіг', distance: bestDist };
  }
  return { status: 'notfound' };
}

/** Чи відповідає ПІБ з табелю працівнику довідника (з урахуванням псевдонімів). */
function nameMatchesEmp_(ref, nameKey, rawName, emp) {
  if (!emp) return false;
  if (emp.fullKey === nameKey) return true;
  if (emp.short && normName_(emp.short) === nameKey) return true;
  if (ref.byAlias[nameKey] === emp.id) return true;
  var key = initialsKey_(rawName);
  return !!key && (key === initialsKey_(emp.full) || (emp.short && key === initialsKey_(emp.short)));
}

var NOTE_MARK = '[auto]';

/**
 * Звіряє ПІБ аркуша з довідником, проставляє emp_id, наповнює звіт.
 */
function syncRoster_(sheet, layout, report, cfg) {
  var ref = loadReference_(cfg);
  report.refTotal = ref.list.length;
  report.refActive = ref.list.filter(function (e) { return e.active; }).length;
  ref.duplicateIds.forEach(function (id) {
    report.issues.refProblems.push('Дубль emp_id у довіднику: ' + id);
  });
  ref.noPosition.forEach(function (e) {
    report.issues.refProblems.push('У довіднику без посади: ' + e.full + ' (' + e.id + ')');
  });

  var lastRow = sheet.getLastRow();
  var rows = lastRow - layout.firstDataRow + 1;
  if (rows <= 0) {
    report.message = (report.message || '') + ' Рядків з працівниками не знайдено.';
    return;
  }

  var names = sheet.getRange(layout.firstDataRow, NAME_COL, rows, 1).getDisplayValues();
  var positions = sheet.getRange(layout.firstDataRow, POS_COL, rows, 1).getDisplayValues();
  var idRange = sheet.getRange(layout.firstDataRow, layout.empIdCol, rows, 1);
  var currentIds = idRange.getDisplayValues();
  var noteRange = sheet.getRange(layout.firstDataRow, NAME_COL, rows, 1);
  var currentNotes = noteRange.getNotes();

  var outIds = [];
  var outNotes = [];
  var seenNames = {};
  var usedIds = {};
  var ambiguousIds = {};
  var aliasRows = [];
  var today = Utilities.formatDate(new Date(), cfg.TIMEZONE, 'dd.MM.yyyy');

  for (var i = 0; i < rows; i++) {
    var rowNum = layout.firstDataRow + i;
    var rawName = String(names[i][0]).trim();
    var rawPos = String(positions[i][0]).trim();
    var keepId = String(currentIds[i][0]).trim();
    var problems = [];

    if (!rawName) {
      outIds.push(['']); // рядок-роздільник між групами
      outNotes.push([keepNote_(currentNotes[i][0], '')]);
      continue;
    }

    report.employeesInSheet++;
    var nameKey = normName_(rawName);
    if (seenNames[nameKey]) {
      report.issues.duplicates.push({ name: rawName, rows: [seenNames[nameKey], rowNum] });
      problems.push('ПІБ дублюється (рядок ' + seenNames[nameKey] + ').');
    } else {
      seenNames[nameKey] = rowNum;
    }

    var emp = null;
    var how = '';
    if (keepId && ref.byId[keepId]) {
      emp = ref.byId[keepId];
      how = 'наявний emp_id';
      if (!nameMatchesEmp_(ref, nameKey, rawName, emp)) {
        report.issues.idNameMismatch.push({
          row: rowNum, name: rawName, empId: keepId, refName: emp.full
        });
        problems.push('emp_id ' + keepId + ' у довіднику — це «' + emp.full + '».');
      }
    } else {
      if (keepId && !ref.byId[keepId]) {
        report.issues.unknownId.push({ row: rowNum, name: rawName, empId: keepId });
        problems.push('emp_id ' + keepId + ' відсутній у довіднику.');
      }
      var m = matchEmployee_(ref, rawName, cfg);
      if (m.status === 'ok') {
        emp = m.emp; how = m.how;
      } else if (m.status === 'fuzzy') {
        report.issues.fuzzy.push({
          row: rowNum, name: rawName, empId: m.emp.id,
          refName: m.emp.full, distance: m.distance, applied: !!cfg.FUZZY_AUTO_APPLY
        });
        problems.push('Нечіткий збіг з «' + m.emp.full + '» — перевірте написання.');
        if (cfg.FUZZY_AUTO_APPLY) {
          emp = m.emp; how = m.how;
          if (ref.byAlias[nameKey] !== m.emp.id) {
            ref.byAlias[nameKey] = m.emp.id;
            aliasRows.push([rawName, m.emp.id, 'авто: нечіткий збіг (' + report.sheetName + ')', today]);
          }
        }
      } else if (m.status === 'ambiguous') {
        report.issues.ambiguous.push({
          row: rowNum, name: rawName,
          candidates: m.candidates.map(function (c) { return c.full + ' (' + c.id + ')'; })
        });
        m.candidates.forEach(function (c) { ambiguousIds[c.id] = true; });
        problems.push('Декілька кандидатів у довіднику — оберіть вручну.');
      } else {
        report.issues.notFound.push({ row: rowNum, name: rawName, position: rawPos });
        problems.push('ПІБ відсутній у довіднику gw-ref.');
      }
    }

    if (emp) {
      if (usedIds[emp.id]) {
        report.issues.duplicates.push({ name: rawName, rows: [usedIds[emp.id], rowNum] });
        problems.push('Той самий emp_id уже стоїть у рядку ' + usedIds[emp.id] + '.');
      } else {
        usedIds[emp.id] = rowNum;
      }
      outIds.push([emp.id]);
      if (keepId !== emp.id) {
        report.idsWritten++;
        report.matched.push({ row: rowNum, name: rawName, empId: emp.id, how: how });
      }
      if (!emp.active) {
        report.issues.fired.push({ row: rowNum, name: rawName, empId: emp.id });
        problems.push('У довіднику статус «звільнений».');
      }
      var pSheet = normHeader_(rawPos);
      var pRef = normHeader_(emp.position);
      if (pSheet && pRef && pSheet !== pRef) {
        report.issues.positionMismatch.push({
          row: rowNum, name: rawName, empId: emp.id, sheetPosition: rawPos, refPosition: emp.position
        });
        problems.push('Посада: у табелі «' + rawPos + '», у довіднику «' + emp.position + '».');
      }
    } else {
      outIds.push([keepId]);
    }

    outNotes.push([keepNote_(currentNotes[i][0], problems.join('\n'))]);
  }

  idRange.setValues(outIds);
  if (cfg.ADD_NOTES) noteRange.setNotes(outNotes);

  ref.list.forEach(function (emp) {
    if (!emp.active || usedIds[emp.id] || ambiguousIds[emp.id]) return;
    if (isAdminOnly_(emp)) return;
    if (!emp.posId && !emp.position) return;
    report.issues.missingInSheet.push({
      empId: emp.id, name: emp.full, position: emp.position, unit: emp.unit
    });
  });

  if (cfg.AUTO_ADD_NEW_EMPLOYEES && report.issues.missingInSheet.length) {
    addMissingEmployees_(sheet, layout, report, cfg);
  }

  report.aliasesWritten = appendAliases_(cfg, ref, aliasRows);
}

/** Не чіпаємо примітки, написані людьми: перезаписуємо лише свої. */
function keepNote_(existing, text) {
  var old = String(existing || '').trim();
  var mine = text ? NOTE_MARK + ' ' + text : '';
  if (!old || old.indexOf(NOTE_MARK) === 0) return mine;
  return mine ? old + '\n' + mine : old;
}

/**
 * Додає активних працівників, яких немає в табелі, у групу з такою ж посадою.
 * Вмикається прапорцем AUTO_ADD_NEW_EMPLOYEES.
 */
function addMissingEmployees_(sheet, layout, report, cfg) {
  var pending = report.issues.missingInSheet.slice();
  for (var i = 0; i < pending.length; i++) {
    var emp = pending[i];
    var lay = analyzeLayout_(sheet);
    var rows = sheet.getLastRow() - lay.firstDataRow + 1;
    if (rows <= 0) return;
    var names = sheet.getRange(lay.firstDataRow, NAME_COL, rows, 1).getDisplayValues();
    var positions = sheet.getRange(lay.firstDataRow, POS_COL, rows, 1).getDisplayValues();

    var anchor = -1;
    for (var r = 0; r < rows; r++) {
      if (names[r][0] && normHeader_(positions[r][0]) === normHeader_(emp.position)) anchor = r;
    }
    if (anchor < 0) {
      for (var r2 = rows - 1; r2 >= 0; r2--) {
        if (names[r2][0]) { anchor = r2; break; }
      }
    }
    if (anchor < 0) return;

    var anchorRow = lay.firstDataRow + anchor;
    sheet.insertRowAfter(anchorRow);
    sheet.getRange(anchorRow, 1, 1, sheet.getLastColumn())
      .copyTo(sheet.getRange(anchorRow + 1, 1, 1, sheet.getLastColumn()));
    var newRow = anchorRow + 1;
    sheet.getRange(newRow, lay.firstDayCol, 1, lay.lastDayCol - lay.firstDayCol + 1).clearContent();
    sheet.getRange(newRow, NAME_COL).setValue(emp.name);
    sheet.getRange(newRow, POS_COL).setValue(emp.position);
    sheet.getRange(newRow, lay.empIdCol).setValue(emp.empId);
    report.added.push({ row: newRow, name: emp.name, empId: emp.empId, position: emp.position });
  }
  report.issues.missingInSheet = [];
}
