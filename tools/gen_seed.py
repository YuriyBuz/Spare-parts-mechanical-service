"""Генерує apps-script/Seed.gs і config/checklist-config.json з реального конфігу + відновлених даних."""
import json, re, collections, os

CL = "/home/user/yuriybuz/mechanic-checklist/index.html"
ROWS = "/tmp/claude-0/-home-user-Spare-parts-mechanical-service/63268d39-83d9-5eb2-8c17-fa439b3aba43/scratchpad/answers.json"
OUT = "/home/user/Spare-parts-mechanical-service"

html = open(CL, encoding="utf-8").read()
block = html[html.index("const checklistConfig = ["):html.index("// --- Custom Dialog System ---")]

# ---------- 1. групи і пункти механіка ----------
groups, cur = [], None
for line in block.splitlines():
    g = re.search(r"id: '([^']+)',\s*$", line)
    t = re.search(r"title: '([^']+)'", line)
    if t and g is None:
        pass
    m = re.search(r"^\s*id: '([^']+)',\s*$", line)
    if m:
        cur = {"id": m.group(1), "title": None, "items": []}
        groups.append(cur)
    m = re.search(r"^\s*title: '([^']+)'", line)
    if m and cur and cur["title"] is None:
        cur["title"] = m.group(1)
    m = re.search(r"\{ id: '([^']+)', text: '(.+?)', type: '(\w+)'", line)
    if m and cur:
        it = {"id": m.group(1), "text": m.group(2).replace("\\'", "'"), "type": m.group(3)}
        o = re.search(r"options: \[([^\]]*)\]", line)
        if o:
            it["options"] = [x.strip().strip("'") for x in o.group(1).split(",")]
        lb = re.search(r"labels: \[([^\]]*)\]", line)
        if lb:
            it["labels"] = [x.strip().strip("'") for x in lb.group(1).split(",")]
        u = re.search(r"unit: '([^']*)'", line)
        if u:
            it["unit"] = u.group(1)
        v = re.search(r"visibleOn: '(\w+)'", line)
        it["visibleOn"] = v.group(1) if v else "all"
        it["photoRequired"] = "photoRequired: true" in line
        cur["items"].append(it)

n = sum(len(g["items"]) for g in groups)
assert n == 43, f"очікували 43 пункти механіка, розпарсили {n}"
print(f"механік: {len(groups)} груп, {n} пунктів")

# ---------- 2. цільові типи ----------
TYPE_MAP = {"binary": "binary", "input": "text", "dual_input": "number"}
FIELDS = {"dual_input": 2, "binary": 0, "input": 0}
# рішення, підтверджені замовником / обґрунтовані даними
OVERRIDE = {
    "5-1": {"type": "number", "fields": 3, "labels": ["Точка 1", "Точка 2", "Точка 3"],
            "note": "було одне текстове поле: 285 унікальних значень на 318 відповідей"},
    "3-4": {"type": "binary", "options": ["Помилок немає", "Є помилка"],
            "note": "було вільне текстове поле: 8 різних написань 'немає помилок'"},
    "7-2": {"type": "number", "fields": 1,
            "note": "числове поле замість текстового"},
}

# ---------- 3. норми (чернетка за фактичними даними, потребує підтвердження) ----------
NORMS = {
    ("1-1", 1): (15, 85, 20, 78), ("1-1", 2): (15, 85, 20, 80),
    ("4-1", 1): (0, 6, 0, 5), ("4-1", 2): (0, 6, 0, 5),
    ("7-1", 1): (0.5, 4.5, 1.0, 4.0), ("7-1", 2): (0.5, 4.5, 1.0, 4.0),
    ("7-2", 1): (3.5, 5.0, 4.0, 4.8),
    ("5-1", 1): (-18, 8, -15, 6), ("5-1", 2): (-18, 8, -15, 6), ("5-1", 3): (-18, 8, -15, 6),
}

# ---------- 4. статуси варіантів ----------
# за замовчуванням: останній варіант = alert, при трьох — другий alert, третій ok
# явні виправлення там, де дані довели хибну тривогу
STATUS_FIX = {
    ("1-3-end", "Не потр."): "ok",          # 77 хибних тривог за пів року
    ("1-4-end", "Відкрито"): "alert",
    ("3-2", "Генератор не запущений"): "ok",
    ("3-3", "Генератор не запущений"): "ok",
    ("6-3-end", "Працює"): "warn",
}


def default_status(opts, i):
    if len(opts) == 3:
        return ["ok", "alert", "ok"][i]
    return "ok" if i < len(opts) - 1 else "alert"


# ---------- 5. чек-лист майстра (відновлено з даних) ----------
MASTER = [
    ("start", "m1", "1. Прийом зміни та перевірка персоналу", [
        "Ознайомитись з записами і результатами від попереднього майстра зміни.",
        "Ознайомитись з виробничим планом на зміну.",
        "Перевірити присутність та візуально оцінити стан здоров'я працівників.",
        "Перевірити дотримання працівниками гігієни та належного стану одягу."]),
    ("start", "m2", "2. Контроль санітарного стану та обладнання", [
        "Перевірити санітарний стан виробничих приміщень (цехи варки, фасування).",
        "Перевірити чистоту та справність основного і допоміжного обладнання.",
        "Впевнитись, що інструменти та інвентар на своїх місцях і готові до роботи.",
        "Перевірити цілісність предметів зі скла та крихких матеріалів технологічного інвентарю та колючо-ріжучих предметів."]),
    ("start", "m3", "3. Організація виробничого процесу", [
        "Провести надихаючу нараду по виробничим завданням і техніки безпеки.",
        "Розподілити працівників по робочих місцях згідно з планом.",
        "Перевірити наявність необхідної сировини та матеріалів на зміну.",
        "Проконтролювати візуально якість готової продукції яка залишилась в цеху."]),
    ("start", "m4", "4. Звітність", [
        "Доповісти керівництву про початок виробничого процесу."]),
    ("end", "m5", "1. Завершення виробничих операцій", [
        "Переконатись у виконанні виробничого плану зміни.",
        "Виписати і організувати передачу всіеї виробленої продукції на склад.",
        "Проконтролювати сортування та підготовку виробничих відходів до вивезення.",
        "Забезпечити прибирання робочих місць персоналом та чистоту в цеху.",
        "Переконатись, що залишки сировини та матеріалів накриті та на місцях."]),
    ("end", "m6", "2. Підготовка до наступної зміни", [
        "Сформувати замовлення на сировину та матеріали для наступної зміни.",
        "Перевірити, чи все обладнання вимкнене або переведене у безпечний режим."]),
    ("end", "m7", "3. Звітність та передача зміни", [
        "Заповнити розділ коментарів в оперативному плані результатами роботи.",
        "Підготувати звіт про результати роботи (кількість, якість, брак, простої).",
        "Задокументувати всі випадки браку або невідповідності продукції.",
        "Підготувати звіт про санітарний стан на кінець зміни.",
        "Письмово передати зміну наступному майстру."]),
    ("end", "m8", "4. Завершальні перевірки та безпека", [
        "Забезпечити встановлення Бактерицидних ламп на дільницях фасовки і варки.",
        "Виключити всі непотрібні прилади (кондиціонери, вентилятори, освітлення).",
        "Перевірити розміщення обладнання на відповідних місцях (візки, інвентар).",
        "Перевірити цілісність предметів зі скла та крихких матеріалів."]),
    ("end", "m9", "5. Комунікація та підбиття підсумків", [
        "Провести коротку нараду з командою для підбиття підсумків зміни."]),
]

# ---------- 6. перейменовані та виведені з ужитку ----------
RENAMED = {
    "Увімкнути подачу тиску на ресивери.": "mech.6-4",
    "Вимкнути подачу тиску на ресивери.": "mech.6-4-end",
    "Провести зовнішній візуальний огляд агрегату.": "mech.3-1",
    "Переконатися у відсутності помилок під час процесу регенерації.": "mech.7-3",
    "Проконтролювати робочий тиск повітря.": "mech.7-2",
}
ALIASES = {}
for _t, _i in RENAMED.items():
    ALIASES[_i] = (ALIASES.get(_i, "") + ";" + _t).strip(";")
rows = json.load(open(ROWS))
cfg_texts = {it["text"] for g in groups for it in g["items"]}
master_texts = {t for _, _, _, ts in MASTER for t in ts}
LEGACY_STATUS = {"Є": "alert", "Забито": "alert", "Несправні": "alert", "Несправне": "alert",
                 "Пошкоджені": "alert", "Низький": "alert", "Збій": "alert", "Не видно": "alert",
                 "Пропуск": "alert", "Витік": "alert"}


def clean(t):
    return re.sub(r"[\s|]+$", "", str(t)).strip()


legacy = collections.Counter()
for r in rows:
    t = clean(r["text"])
    if r["role"] == "Механік" and t not in cfg_texts and t not in RENAMED:
        legacy[t] += 1

# ---------- 7. збірка ----------
items, options = [], []
for gi, g in enumerate(groups, 1):
    for si, it in enumerate(g["items"], 1):
        iid = "mech." + it["id"]
        ov = OVERRIDE.get(it["id"], {})
        typ = ov.get("type", TYPE_MAP[it["type"]])
        fields = ov.get("fields", FIELDS[it["type"]])
        labels = ov.get("labels", it.get("labels", []))
        opts = ov.get("options", it.get("options", []))
        row = {
            "item_id": iid, "role": "Механік", "group_id": g["id"], "group_title": g["title"],
            "seq": si, "text": it["text"], "type": typ, "fields": fields,
            "unit": "" if it.get("unit", "").startswith("Внести") else it.get("unit", ""),
            "labels": ";".join(labels), "visible_on": it["visibleOn"],
            "photo_required": bool(it["photoRequired"]), "active_from": "2026-02-14",
            "active_to": "", "text_aliases": ALIASES.get(iid, ""), "notes": ov.get("note", ""),
        }
        for f in range(1, max(fields, 1) + 1):
            key = (it["id"], f)
            if key in NORMS:
                nmin, nmax, wmin, wmax = NORMS[key]
                row[f"norm_min_{f}"] = nmin
                row[f"norm_max_{f}"] = nmax
                row[f"warn_min_{f}"] = wmin
                row[f"warn_max_{f}"] = wmax
        items.append(row)
        for i, o in enumerate(opts):
            options.append({"item_id": iid, "seq": i + 1, "value": o, "active": "так",
                            "status": STATUS_FIX.get((it["id"], o), default_status(opts, i))})

for stage, gid, title, texts in MASTER:
    for si, t in enumerate(texts, 1):
        iid = f"master.{gid}-{si}"
        items.append({"item_id": iid, "role": "Майстер", "group_id": gid, "group_title": title,
                      "seq": si, "text": t, "type": "binary", "fields": 0, "unit": "", "labels": "",
                      "visible_on": stage, "photo_required": False, "active_from": "2026-07-23",
                      "active_to": "", "text_aliases": "",
                      "notes": "відновлено з даних; звірити з фронтендом майстра"})
        options.append({"item_id": iid, "seq": 1, "value": "Виконано", "active": "так", "status": "ok"})
        options.append({"item_id": iid, "seq": 2, "value": "Не виконано", "active": "так", "status": "alert"})

for i, (t, c) in enumerate(sorted(legacy.items(), key=lambda x: -x[1]), 1):
    items.append({"item_id": f"mech.legacy.{i:02d}", "role": "Механік", "group_id": "legacy",
                  "group_title": "Виведені з ужитку", "seq": i, "text": t, "type": "binary",
                  "fields": 0, "unit": "", "labels": "", "visible_on": "none",
                  "photo_required": False, "active_from": "2026-02-14", "active_to": "2026-08-23", "text_aliases": "", "notes": f"{c} історичних відповідей; статуси варіантів виведені з історії — перевірте перед аналітикою"})

# ---------- 7b. історичні варіанти відповіді (щоб міграція не давала unknown) ----------
text2id = {}
for _it in items:
    for _k in [_it["text"]] + str(_it.get("text_aliases", "")).split(";"):
        _k = _k.strip()
        if _k:
            text2id[_it["role"] + "|" + _k] = _it["item_id"]
have = {(o["item_id"], o["value"]) for o in options}
seen = collections.defaultdict(collections.Counter)
for r in rows:
    iid = text2id.get(r["role"] + "|" + clean(r["text"]))
    v = clean(r["value"] or "")
    if iid and v:
        seen[(iid, v)][r["status"]] += 1
extra = 0
nseq = collections.Counter()
for (iid, v), st in sorted(seen.items()):
    if (iid, v) in have:
        continue
    itm = next((x for x in items if x["item_id"] == iid), None)
    if not itm or itm["type"] != "binary":
        continue
    status = LEGACY_STATUS.get(v) or ("alert" if st["alert"] > st["ok"] else "ok")
    nseq[iid] += 1
    options.append({"item_id": iid, "seq": 90 + nseq[iid], "value": v,
                    "active": "ні", "status": status})
    extra += 1
print(f"історичних варіантів додано: {extra}")

EMPLOYEES = [
    ["U-001", "Галагін Євгеній Ярославович", "Механік", True, "Галагін Евгеній"],
    ["U-002", "Сабадаш Геннадій Петрович", "Механік", True, ""],
    ["U-003", "Гора Андрій Олександрович", "Механік", True, "Гора Андрій"],
    ["U-004", "Свінцов Михайло", "Механік", False, ""],
    ["U-005", "Гончарук Ольга", "Майстер", True, ""],
    ["U-006", "Шута Олександра", "Майстер", True, ""],
    ["U-000", "(особу не встановлено)", "Механік", False, "Заміна"],
]

os.makedirs(f"{OUT}/apps-script", exist_ok=True)
os.makedirs(f"{OUT}/config", exist_ok=True)


def js(v):
    return json.dumps(v, ensure_ascii=False)


ITEM_COLS = ["item_id", "role", "group_id", "group_title", "seq", "text", "type", "fields", "unit",
             "labels", "visible_on", "photo_required",
             "norm_min_1", "norm_max_1", "warn_min_1", "warn_max_1",
             "norm_min_2", "norm_max_2", "warn_min_2", "warn_max_2",
             "norm_min_3", "norm_max_3", "warn_min_3", "warn_max_3",
             "active_from", "active_to", "text_aliases", "notes"]

with open(f"{OUT}/apps-script/Seed.gs", "w", encoding="utf-8") as f:
    f.write("""/**
 * Seed.gs — довідники чек-листа. ЗГЕНЕРОВАНО, не редагувати руками.
 * Джерела: checklistConfig клієнта (43 пункти механіка), відновлений із 352 звітів
 * чек-лист майстра (%d пунктів) і виведені з ужитку пункти (%d).
 *
 * Норми (norm_min, norm_max, warn_min, warn_max) — ЧЕРНЕТКА за фактичними значеннями за 14.02-10.08.2026.
 * Потребують підтвердження технолога. Порожня норма = сигнал не спрацьовує.
 *
 * Запуск: seedDictionaries()  (ідемпотентно — оновлює за item_id, нічого не видаляє)
 */

var SEED_ITEM_COLS = %s;

var SEED_ITEMS = [
""" % (sum(1 for i in items if i["role"] == "Майстер"), len(legacy), js(ITEM_COLS)))
    for it in items:
        f.write("  " + js([it.get(c, "") for c in ITEM_COLS]) + ",\n")
    f.write("];\n\nvar SEED_OPTIONS = [\n")
    for o in options:
        f.write("  " + js([o["item_id"], o["seq"], o["value"], o["status"], o["active"]]) + ",\n")
    f.write("];\n\nvar SEED_EMPLOYEES = [\n")
    for e in EMPLOYEES:
        f.write("  " + js(e) + ",\n")
    f.write("];\n")

json.dump({"items": items, "options": options, "employees": EMPLOYEES},
          open(f"{OUT}/config/checklist-config.json", "w", encoding="utf-8"),
          ensure_ascii=False, indent=2)

print(f"пунктів усього : {len(items)}  (механік {sum(1 for i in items if i['role']=='Механік' and i['group_id']!='legacy')}, "
      f"майстер {sum(1 for i in items if i['role']=='Майстер')}, legacy {sum(1 for i in items if i['group_id']=='legacy')})")
print(f"варіантів      : {len(options)}")
print(f"працівників    : {len(EMPLOYEES)}")
print("статуси-виправлення:", {f"{k[0]}/{k[1]}": v for k, v in STATUS_FIX.items()})
