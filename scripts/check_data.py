#!/usr/bin/env python3
"""Проверка согласованности синтетических данных: каталог, правила цен, база знаний, вопросы.

Только стандартная библиотека. Запуск из корня репозитория: python3 -I scripts/check_data.py
Код возврата 0 — всё сходится, 1 — есть ошибки.
"""
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
errors = []


def err(msg):
    errors.append(msg)


def norm(s):
    """Для сравнения: нижний регистр, без пробелов, NBSP и тире-вариантов, ё -> е."""
    s = s.lower().replace("ё", "е").replace(" ", "")
    return re.sub(r"\s+", "", s)


# ---------- каталог ----------
CAT_COLS = ["sku", "name", "vendor", "category", "unit", "term_months", "price_rub",
            "stock", "lead_days", "in_registry", "description"]
CATEGORIES = {"антивирусы", "офис", "ОС", "бухгалтерия/1С", "СУБД", "САПР/графика", "разработка",
              "криптография/ЭП", "удалённый доступ", "резервное копирование",
              "серверные лицензии (CAL)", "продление подписок"}
catalog = {}
with open(DATA / "catalog.csv", encoding="utf-8", newline="") as f:
    rd = csv.DictReader(f)
    if rd.fieldnames != CAT_COLS:
        err(f"catalog.csv: колонки {rd.fieldnames} != {CAT_COLS}")
    for i, r in enumerate(rd, start=2):
        sku = r["sku"]
        if sku in catalog:
            err(f"catalog.csv:{i}: дубль sku {sku}")
        catalog[sku] = r
        if r["category"] not in CATEGORIES:
            err(f"catalog.csv:{i}: неизвестная категория {r['category']!r}")
        if not re.fullmatch(r"\d+\.\d{2}", r["price_rub"]):
            err(f"catalog.csv:{i}: price_rub {r['price_rub']!r} не в формате 2490.00")
        if r["term_months"] and not r["term_months"].isdigit():
            err(f"catalog.csv:{i}: term_months {r['term_months']!r}")
        if r["in_registry"] not in ("true", "false"):
            err(f"catalog.csv:{i}: in_registry {r['in_registry']!r}")
        try:
            stock, lead = int(r["stock"]), int(r["lead_days"])
        except ValueError:
            err(f"catalog.csv:{i}: stock/lead_days не числа")
            continue
        if stock < -1:
            err(f"catalog.csv:{i}: stock < -1")
        if stock == -1 and lead != 0:
            err(f"catalog.csv:{i}: электронная поставка с lead_days > 0")
        if sku.endswith("-RENEW") and r["category"] != "продление подписок":
            err(f"catalog.csv:{i}: {sku} не в категории «продление подписок»")
        if r["category"] == "продление подписок" and not sku.endswith("-RENEW"):
            err(f"catalog.csv:{i}: {sku} в категории продлений без суффикса -RENEW")

if not 60 <= len(catalog) <= 80:
    err(f"каталог: {len(catalog)} позиций, ожидалось 60-80")

for sku, r in catalog.items():
    price = float(r["price_rub"])
    if sku.endswith("-RENEW"):
        base = sku[: -len("-RENEW")]
        if base in catalog and price >= float(catalog[base]["price_rub"]):
            err(f"{sku}: продление не дешевле новой лицензии {base}")
    desc = r["description"]
    if desc.startswith("Снято с продажи"):
        m = re.match(r"Снято с продажи, замена: ([A-Z0-9-]+)", desc)
        if not m or m.group(1) not in catalog:
            err(f"{sku}: замена снятой позиции не найдена в каталоге")
        elif catalog[m.group(1)]["description"].startswith("Снято с продажи"):
            err(f"{sku}: замена {m.group(1)} тоже снята")
        if int(r["stock"]) != 0 or int(r["lead_days"]) != 0:
            err(f"{sku}: у снятой позиции stock и lead_days должны быть 0")

backorder = [s for s, r in catalog.items() if int(r["stock"]) == 0 and int(r["lead_days"]) > 0]
discont = [s for s, r in catalog.items() if r["description"].startswith("Снято с продажи")]
renews = [s for s in catalog if s.endswith("-RENEW")]
if len(backorder) < 3:
    err("мало позиций «под заказ»")
for s in backorder:
    if not 10 <= int(catalog[s]["lead_days"]) <= 15:
        err(f"{s}: lead_days вне 10-15")
if len(discont) < 2:
    err("нужно минимум 2 снятые с продажи позиции")
if len(renews) < 5:
    err("мало SKU -RENEW")

# ---------- правила цен ----------
RULE_COLS = ["code", "title", "applies_to", "min_qty", "discount_pct", "requires", "stackable", "note"]
REQUIRES = {"", "renewal", "partner", "edu", "gov", "migration", "regular"}
vendors = {r["vendor"] for r in catalog.values()}
rules = {}
with open(DATA / "price_rules.csv", encoding="utf-8", newline="") as f:
    rd = csv.DictReader(f)
    if rd.fieldnames != RULE_COLS:
        err(f"price_rules.csv: колонки {rd.fieldnames}")
    for i, r in enumerate(rd, start=2):
        rules[r["code"]] = r
        if r["requires"] not in REQUIRES:
            err(f"price_rules.csv:{i}: requires {r['requires']!r}")
        if r["stackable"] not in ("true", "false"):
            err(f"price_rules.csv:{i}: stackable {r['stackable']!r}")
        if not (r["min_qty"].isdigit() and r["discount_pct"].isdigit()):
            err(f"price_rules.csv:{i}: min_qty/discount_pct не целые")
        a = r["applies_to"]
        if a == "*":
            pass
        elif a.startswith("category:"):
            if a[9:] not in CATEGORIES:
                err(f"{r['code']}: категория {a[9:]!r} не существует")
        elif a.startswith("vendor:"):
            if a[7:] not in vendors:
                err(f"{r['code']}: вендор {a[7:]!r} не найден в каталоге")
        elif a.startswith("sku:"):
            if a[4:] not in catalog:
                err(f"{r['code']}: sku {a[4:]!r} не найден")
        else:
            err(f"{r['code']}: applies_to {a!r}")
if not 8 <= len(rules) <= 12:
    err(f"правил {len(rules)}, ожидалось 8-12")

# ---------- база знаний ----------
kb = {}
kb_files = sorted((DATA / "kb").glob("*.md"))
if not 12 <= len(kb_files) <= 16:
    err(f"kb: {len(kb_files)} документов, ожидалось 12-16")
for p in kb_files:
    text = p.read_text(encoding="utf-8")
    m = re.match(r"---\n(.*?)\n---\n(.*)", text, re.S)
    if not m:
        err(f"{p.name}: нет front matter")
        continue
    meta = {}
    for line in m.group(1).splitlines():
        k, _, v = line.partition(":")
        meta[k.strip()] = v.strip()
    body = m.group(2)
    for k in ("title", "valid_from", "valid_to"):
        if k not in meta:
            err(f"{p.name}: нет поля {k}")
    words = len(re.findall(r"\w+", body))
    if not 300 <= words <= 900:
        err(f"{p.name}: {words} слов, ожидалось 300-900")
    if len(re.findall(r"^## ", body, re.M)) < 3:
        err(f"{p.name}: меньше трёх заголовков ##")
    kb[p.stem] = {"meta": meta, "body": body, "text": norm(body)}

outdated = [s for s, d in kb.items() if d["meta"].get("valid_to")]
if not outdated:
    err("нет устаревших документов kb")
for s in outdated:
    if kb[s]["meta"]["valid_to"] >= "2026-01-01":
        err(f"{s}: valid_to не в прошлом")

# проценты в базе знаний только из правил (+НДС, потолок, предоплата)
allowed_pct = {int(r["discount_pct"]) for r in rules.values() if int(r["discount_pct"]) > 0}
allowed_pct |= {22, 20, 100}
for s, d in kb.items():
    for m in re.finditer(r"(\d+)\s?%", d["body"]):
        if int(m.group(1)) not in allowed_pct:
            err(f"kb/{s}: процент {m.group(0)} не подтверждён правилами")

# цены, названные в тексте, совпадают с каталогом
def money(v):
    return f"{int(float(v)):,}".replace(",", " ")


PRICE_FACTS = [
    ("prodlenie-podpiski", "KAV-ES-1Y-5-RENEW"), ("prodlenie-podpiski", "KAV-ES-1Y-5"),
    ("prodlenie-podpiski", "DRW-DSS-1Y-5-RENEW"), ("prodlenie-podpiski", "DRW-DSS-1Y-5"),
]
for slug, sku in PRICE_FACTS:
    if money(catalog[sku]["price_rub"]) not in kb[slug]["body"].replace(" ", " "):
        err(f"kb/{slug}: цена {sku} ({money(catalog[sku]['price_rub'])}) не найдена в тексте")

# ключевые цифры: (slug, подстрока) — должны присутствовать и совпадать с правилами
def rule(code, field):
    return rules[code][field]


KEY_FACTS = [
    ("skidki-i-osobye-usloviya", f"от 10 штук: {rule('VOL-10','discount_pct')}%"),
    ("skidki-i-osobye-usloviya", f"от 25 штук: {rule('VOL-25','discount_pct')}%"),
    ("skidki-i-osobye-usloviya", f"от 50 штук: {rule('VOL-50','discount_pct')}%"),
    ("skidki-i-osobye-usloviya", f"Партнёрская цена: {rule('PARTNER-STD','discount_pct')}%"),
    ("skidki-i-osobye-usloviya", f"Образовательная скидка: {rule('EDU-STD','discount_pct')}%"),
    ("skidki-i-osobye-usloviya", f"Госзаказчикам: {rule('GOV-REG','discount_pct')}%"),
    ("skidki-i-osobye-usloviya", f"Раннее продление: {rule('RENEW-EARLY','discount_pct')}%"),
    ("partnerskaya-programma", f"{rule('PARTNER-STD','discount_pct')}%"),
    ("obrazovatelnye-licenzii", f"{rule('EDU-STD','discount_pct')}%"),
    ("faq", "14 календарных дней"),
    ("oplata-i-scheta", "14 календарных дней"),
    ("oplata-i-scheta", "500 000"),
    ("oplata-i-scheta", "22%"),
    ("kp-sostav-i-srok", "10 рабочих дней"),
    ("faq", "10 рабочих дней"),
    ("dostavka-2026", "2 рабочих часов"),
    ("dostavka-2026", "от 10 до 15 рабочих дней"),
]
for slug, frag in KEY_FACTS:
    if slug not in kb or norm(frag) not in kb[slug]["text"]:
        err(f"kb/{slug}: нет фрагмента {frag!r}")

# 2025 и 2026 действительно различаются
if "dostavka-2025" in kb and "dostavka-2026" in kb:
    if "1 рабочего дня" not in kb["dostavka-2025"]["body"] or "2 рабочих часов" not in kb["dostavka-2026"]["body"]:
        err("dostavka-2025/2026: сроки ключей не различаются как задумано")
else:
    err("нет пары dostavka-2025 / dostavka-2026")

# срок отсрочки в note правила совпадает с kb
if "14 календарных" not in rules["NET14"]["note"]:
    err("NET14: в note нет 14 календарных дней")

# ---------- вопросы ----------
questions = json.loads((ROOT / "eval" / "questions.json").read_text(encoding="utf-8"))
if len(questions) != 45:
    err(f"вопросов {len(questions)}, ожидалось 45")
ids = [q["id"] for q in questions]
if len(set(ids)) != len(ids):
    err("дубли id вопросов")
kinds = {"answer": 0, "proposal": 0, "escalate": 0}

# пересчёт сумм для КП: (sku, qty, коды правил)
SCENARIOS = {
    "q31": ("MYO-STD-PERP", 15, ["VOL-10", "EDU-STD"]),
    "q32": ("DRW-DSS-1Y-5", 30, ["VOL-25"]),
    "q33": ("KAV-ES-1Y-10-RENEW", 2, []),
    "q34": ("R7-OFF-PERP", 20, ["VOL-10", "GOV-REG"]),
    "q35": ("JB-IJU-1Y", 12, ["PARTNER-STD"]),
    "q36": ("MYO-STD-PERP", 30, ["VOL-25", "MIGR-MYO"]),
    "q37": ("AST-SE-WS-12", 10, ["VOL-10"]),
    "q38": ("CPRO-CSP-5-WS", 3, []),
}


def calc(sku, qty, codes):
    pct = 0
    best = 0
    for c in codes:
        r = rules[c]
        if qty < int(r["min_qty"]):
            err(f"сценарий {sku}: {c} требует min_qty {r['min_qty']}, а qty={qty}")
        if r["stackable"] == "true":
            pct += int(r["discount_pct"])
        else:
            best = max(best, int(r["discount_pct"]))
    pct = min(pct + best, 20)
    total = round(float(catalog[sku]["price_rub"]) * qty * (100 - pct) / 100, 2)
    return pct, total


for q in questions:
    e = q["expect"]
    qid = q["id"]
    if q["channel"] not in ("chat", "email"):
        err(f"{qid}: channel")
    if e["kind"] not in kinds:
        err(f"{qid}: kind {e['kind']!r}")
        continue
    kinds[e["kind"]] += 1
    for s in e["skus"]:
        if s not in catalog:
            err(f"{qid}: sku {s} нет в каталоге")
    slug = e.get("source_slug")
    if slug:
        if slug not in kb:
            err(f"{qid}: source_slug {slug} не существует")
        elif kb[slug]["meta"].get("valid_to"):
            err(f"{qid}: source_slug {slug} устарел")
    cat_text = norm(" ".join(" ".join(catalog[s].values()) for s in e["skus"] if s in catalog))
    if e["kind"] == "answer":
        for t in e["must_include"]:
            nt = norm(t)
            m = re.fullmatch(r"(\d+)раб", nt)
            if m:
                if not any(int(catalog[s]["lead_days"]) == int(m.group(1)) for s in e["skus"] if s in catalog):
                    err(f"{qid}: срок {t!r} не совпадает с lead_days у skus")
                continue
            doc_text = kb[slug]["text"] if slug in kb else ""
            if nt not in doc_text and nt not in cat_text:
                err(f"{qid}: must_include {t!r} не найден ни в kb/{slug}, ни в каталоге по skus")
        for t in e["must_not_include"]:
            nt = norm(t)
            if slug in kb and nt in kb[slug]["text"] and e["kind"] == "answer":
                err(f"{qid}: must_not_include {t!r} присутствует в актуальном документе kb/{slug}")
    if e["kind"] == "proposal":
        if qid not in SCENARIOS:
            err(f"{qid}: нет сценария пересчёта")
            continue
        sku, qty, codes = SCENARIOS[qid]
        if sku not in e["skus"]:
            err(f"{qid}: sku сценария {sku} не указан в skus")
        pct, total = calc(sku, qty, codes)
        got = norm(" ".join(e["must_include"]))
        total_s = str(int(total)) if total == int(total) else f"{total:.2f}"
        if pct and f"{pct}%" not in e["must_include"]:
            err(f"{qid}: ожидался процент {pct}%, в must_include {e['must_include']}")
        if str(int(total)) not in got and total_s not in got:
            err(f"{qid}: итог {total} не найден в must_include {e['must_include']}")
        if not pct and int(total) != int(total):
            err(f"{qid}: дробный итог")
        for t in e["must_include"]:
            m = re.fullmatch(r"(\d+) раб", t)
            if m and int(catalog[sku]["lead_days"]) != int(m.group(1)):
                err(f"{qid}: срок {t!r} не совпадает с каталогом")

expected = {"answer": 30, "proposal": 8, "escalate": 7}
if kinds != expected:
    err(f"распределение kind {kinds}, ожидалось {expected}")

# ---------- итог ----------
print(f"каталог: {len(catalog)} позиций (под заказ {len(backorder)}, снято {len(discont)}, продлений {len(renews)})")
print(f"правила: {len(rules)}")
print(f"kb: {len(kb)} документов, устаревших {len(outdated)}")
print(f"вопросы: {len(questions)} {kinds}")
if errors:
    print(f"\nОШИБОК: {len(errors)}")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("OK")
