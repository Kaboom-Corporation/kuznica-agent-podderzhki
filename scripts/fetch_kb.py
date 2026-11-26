"""
База знаний из публичных справочных страниц магазина → data/kb-softline/*.md (не в git).

Бережно: проверка robots.txt перед каждой страницей, один запрос в 4 секунды,
закрытые и личные разделы не трогаем, защиты не обходим. Тексты принадлежат магазину —
в репозиторий кладём только этот скрипт.

Запуск: python3 -I scripts/fetch_kb.py [папка]   (только стандартная библиотека)
"""
import datetime, html.parser, pathlib, re, sys, time, urllib.request, urllib.robotparser

BASE = "https://store.softline.ru"
UA = "Mozilla/5.0 (demo-kb-fetch; 1 req/4s)"
PAGES = {
    "dostavka": "/delivery_info/",
    "pravila-prodazhi": "/sale-rules/",
    "rekomendatelnye-pravila": "/recomendations_rules/",
    "b2b": "/b2b/",
    "tendery": "/tenders/",
    "kontakty": "/contacts/",
    "akcii": "/specials/",
    "akciya-astra-do-500": "/specials/detail/astra-linux-dlya-kompanij-do-500-sotrudnikov/",
    "akciya-pro32-migraciya": "/specials/detail/migraciya-na-pro32-so-skidkoj-40/",
}
SKIP = {"script", "style", "noscript", "svg", "header", "footer", "nav", "form", "button", "iframe"}
# личная почта сотрудника вида Имя.Фамилия@ — в базу знаний не берём; общие ящики (store@, sales.s@) оставляем
PERSONAL_EMAIL = re.compile(r"\b[a-z]+\.[a-z]{3,}@", re.I)
BLOCK = {"p", "div", "li", "tr", "br", "section", "article", "h1", "h2", "h3", "h4", "td", "th", "dd", "dt"}


class Text(html.parser.HTMLParser):
    """Текст страницы: заголовки → markdown, списки → «- », служебные блоки выкидываем."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.out, self.skip, self.title = [], 0, ""
        self.in_title = False

    def handle_starttag(self, tag, attrs):
        if tag in SKIP:
            self.skip += 1
        if tag == "title":
            self.in_title = True
        if self.skip:
            return
        if tag in BLOCK:
            self.out.append("\n")
        if tag in ("h1", "h2"):
            self.out.append("## ")
        elif tag in ("h3", "h4"):
            self.out.append("### ")
        elif tag == "li":
            self.out.append("- ")
        elif tag in ("td", "th"):
            self.out.append(" | ")

    def handle_endtag(self, tag):
        if tag in SKIP and self.skip:
            self.skip -= 1
        if tag == "title":
            self.in_title = False
        if not self.skip and tag in BLOCK:
            self.out.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        elif not self.skip:
            self.out.append(data)


def to_markdown(page: str) -> tuple[str, str]:
    p = Text()
    p.feed(page)
    lines = [re.sub(r"[ \t ]+", " ", l).strip() for l in "".join(p.out).splitlines()]
    lines = [l for l in lines if l and l not in ("-", "- ​", "|", "## ", "##", "###")]
    body, prev, i = [], None, 0
    while i < len(lines):
        l = lines[i]
        # карточка «Нужна помощь?» — имя, добавочный и личная почта сотрудника: агенту раздавать не нужно
        if l == "Нужна помощь?":
            j = i + 1
            while j < min(i + 5, len(lines)) and not PERSONAL_EMAIL.search(lines[j]):
                j += 1
            i = j + 1 if j < len(lines) and PERSONAL_EMAIL.search(lines[j]) else i + 1
            continue
        if PERSONAL_EMAIL.search(l) or l == prev:
            i += 1
            continue
        body.append(l)
        prev = l
        i += 1
    return p.title.strip(), "\n\n".join(body)


def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "data/kb-softline")
    out.mkdir(parents=True, exist_ok=True)
    robots = urllib.robotparser.RobotFileParser(BASE + "/robots.txt")
    robots.read()
    today = datetime.date.today().isoformat()
    for slug, path in PAGES.items():
        url = BASE + path
        if not robots.can_fetch(UA, url):
            print(f"пропуск (robots.txt): {url}")
            continue
        time.sleep(4)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=30) as r:
                page = r.read().decode("utf-8", "replace")
        except Exception as e:  # noqa: BLE001 — страницу пропускаем, остальные качаем
            print(f"ошибка {url}: {e}")
            continue
        title, body = to_markdown(page)
        title = title.split("|")[0].split(" – ")[0].strip() or slug
        (out / f"{slug}.md").write_text(
            f"---\ntitle: {title}\nsource: {url}\nfetched: {today}\nvalid_from: \nvalid_to: \n---\n\n{body}\n",
            encoding="utf-8",
        )
        print(f"{slug}: {len(body)} символов — {title}")


if __name__ == "__main__":
    main()
