"""Єдиний парсер вихідних звітів → answers.json. Та сама логіка, що в Migrate.gs."""
import re, json, collections

RAW = "/tmp/claude-0/-home-user-Spare-parts-mechanical-service/63268d39-83d9-5eb2-8c17-fa439b3aba43/scratchpad/checklist_raw.txt"
OUT = "/tmp/claude-0/-home-user-Spare-parts-mechanical-service/63268d39-83d9-5eb2-8c17-fa439b3aba43/scratchpad/answers.json"

MARKS = ["\U0001F4DD", "\U0001F464", "\U0001F4C5", "\U0001F4C1", "\U0001F4F7",
         "\U0001F517", "\U0001F4AC", "✅ |", "❌ |", "----"]


def relines(blob):
    blob = blob.replace(" ❗ ❌ |", "\n\x00")
    for m in MARKS:
        blob = blob.replace(" " + m, "\n" + m)
    return blob.replace("\x00", "❗ ❌ |").split("\n")


d = open(RAW, encoding="utf-8").read()
blobs = [p for p in re.split("(?=\U0001F4DD Чек-лист:)", d) if p.startswith("\U0001F4DD")]

out, tot = [], collections.Counter()
for n, blob in enumerate(blobs):
    lines = relines(blob)
    role, stage, date, who = "Механік", "", "", ""
    for L in lines[:8]:
        if "Чек-лист:" in L:
            stage = L.split("Чек-лист:")[1].strip()
        m = re.search(r"(Механік|Майстер):\s*(.+)$", L)
        if m:
            role, who = m.group(1), m.group(2).strip()
        m = re.search(r"Дата:\s*(\d{2})\.(\d{2})\.(\d{4})", L)
        if m:
            date = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
    cat = ""
    for line in lines:
        t = line.lstrip()
        if t.startswith("\U0001F4C1"):
            cat = t[2:].strip()
            continue
        if t.startswith("\U0001F517"):
            tot["photos"] += 1
            continue
        icon = None
        for cand in ("❗ ❌ | ", "✅ | ", "❌ | "):
            if t.startswith(cand):
                icon = cand.split(" |")[0]
                break
        if not icon:
            continue
        rest = re.sub(r"[\s|]+$", "", t[t.index("| ") + 2:]).strip()   # хвости markdown-експорту
        rest = re.sub(r"\s*\[НЕ НОРМА\]\s*$", "", rest).strip()
        value = ""
        vm = re.search(r"\s\[([^\]]*)\]\s*$", rest)
        if vm:
            value, rest = vm.group(1), rest[:vm.start()].strip()
        if not rest or rest.startswith("Фото:"):
            continue
        tot["answers"] += 1
        tot[{"✅": "ok", "❗ ❌": "alert", "❌": "empty"}[icon]] += 1
        out.append({"report": n, "date": date, "stage": stage, "role": role, "who": who,
                    "cat": cat, "text": rest, "value": value,
                    "status": {"✅": "ok", "❗ ❌": "alert", "❌": "empty"}[icon]})

json.dump(out, open(OUT, "w", encoding="utf-8"), ensure_ascii=False)
print("звітів:", len(blobs), "| відповідей:", tot["answers"],
      "| ok:", tot["ok"], "alert:", tot["alert"], "empty:", tot["empty"], "| фото:", tot["photos"])
