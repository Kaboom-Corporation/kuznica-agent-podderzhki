/**
 * Люди в документах третьих лиц.
 * Словаря людей здесь нет: в решении суда стороны нам неизвестны. Поэтому человека узнаём по самому написанию
 * и связываем формы между собой: «Иванова И.И.», «Иванову Ивану Ивановичу», «И.И. Иванов» — одна метка.
 * Склонение при возврате сознательно осторожное: сомневаемся — отдаём то, что было написано в документе.
 */
import type { PiiGender } from './types'

export type SurnameClass = 'ov' | 'sky' | 'adj' | 'indecl' | 'cons'

export interface SurnameShape {
  /** Основа без падежного и родового окончания: общая для «Иванов», «Иванова», «Ивановой». */
  stem: string
  cls: SurnameClass
  /** Что форма говорит о роде: «Ивановой» — женщина, «Ивановым» — мужчина, «Иванова» — неизвестно. */
  gender?: PiiGender
  /** Форма совпадает с именительным: «Шевчук», «Иванов». */
  nominative: boolean
}

function normalize(word: string): string {
  return word.toLowerCase().replace(/ё/g, 'е')
}

function shapeOfPart(part: string): SurnameShape {
  const w = normalize(part)
  if (/(?:енко|ко|их|ых|аго|яго|ово|дзе|швили|иа)$/.test(w)) return { stem: w, cls: 'indecl', nominative: true }

  const ov = /^(.{2,}(?:ов|ев|ин|ын))(а|у|ым|е|ой|ою)?$/.exec(w)
  if (ov) {
    const end = ov[2] ?? ''
    const gender: PiiGender | undefined = end === '' || end === 'ым' || end === 'е'
      ? 'm'
      : end === 'ой' || end === 'ою' ? 'f' : undefined
    return { stem: ov[1]!, cls: 'ov', gender, nominative: end === '' }
  }
  const sky = /^(.{2,}[сц]к)(ий|ого|ому|им|ом|ая|ой|ую|ою)$/.exec(w)
  if (sky) {
    const end = sky[2]!
    const gender: PiiGender = ['ая', 'ую', 'ой', 'ою'].includes(end) ? 'f' : 'm'
    return { stem: sky[1]!, cls: 'sky', gender, nominative: end === 'ий' || end === 'ая' }
  }
  const adj = /^(.{3,}?)(ый|ая|ого|ому|ым|ую|ою)$/.exec(w)
  if (adj) {
    const gender: PiiGender = ['ая', 'ую', 'ою'].includes(adj[2]!) ? 'f' : 'm'
    return { stem: adj[1]!, cls: 'adj', gender, nominative: adj[2] === 'ый' || adj[2] === 'ая' }
  }
  const cons = /^(.{3,}?)(а|я|у|ю|ом|ем|е|ы|и|ой|ей)$/.exec(w)
  if (cons) return { stem: cons[1]!.replace(/[ьй]$/, ''), cls: 'cons', nominative: false }
  return { stem: w.replace(/[ьй]$/, ''), cls: 'cons', nominative: true }
}

/** Разбор фамилии, в том числе двойной: «Иванова-Петрова» и «Ивановой-Петровой» дают одну основу. */
export function surnameShape(word: string): SurnameShape {
  const parts = word.split('-')
  if (parts.length === 1) return shapeOfPart(word)
  const shapes = parts.map(shapeOfPart)
  // Двойную фамилию не склоняем: класс «несклоняемая» отдаёт при возврате написанную форму.
  return { stem: shapes.map(s => s.stem).join('-'), cls: 'indecl', gender: shapes[shapes.length - 1]!.gender, nominative: false }
}

/**
 * Форма, по которой род не определить: «Иванова» — женщина или родительный падеж мужчины, «Иванову» — винительный
 * женщины или дательный мужчины. Решает только окружение (surnameGenderFromContext в детекторе).
 */
export function isGenderAmbiguousSurname(word: string): boolean {
  const shape = surnameShape(word)
  return shape.cls === 'ov' && !shape.gender && !shape.nominative
}

/** Фамилия по типичному окончанию: нужна там, где нет ни инициалов, ни сильного контекста. */
export function looksLikeSurname(word: string): boolean {
  const w = normalize(word)
  return /^.{2,}(?:ов|ев|ин|ын)(?:а|у|ым|е|ой)?$/.test(w)
    || /^.{2,}[сц]к(?:ий|ого|ому|им|ом|ая|ой|ую)$/.test(w)
    || /^.{2,}(?:енко|ук|юк|чук|ян|янц|дзе|швили|их|ых|ман|берг|штейн|ич|ко)(?:а|у|ом|е)?$/.test(w)
}

// ── Имена ──────────────────────────────────────────────────────────────────────

const MALE_NAMES = `Александр Алексей Анатолий Андрей Антон Аркадий Арсений Артём Артем Артур Афанасий Богдан Борис Вадим Валентин Валерий
Василий Виктор Виталий Владимир Владислав Всеволод Вячеслав Гавриил Геннадий Георгий Герман Глеб Григорий Давид Даниил Данил Денис Дмитрий Евгений
Егор Елисей Ефим Захар Игнат Игорь Илья Иван Иннокентий Иосиф Кирилл Климент Константин Леонид Леонтий Макар Максим Марат Марк Матвей Михаил
Назар Никита Николай Олег Павел Пётр Петр Платон Прохор Родион Руслан Рустам Савелий Святослав Семён Семен Сергей Станислав Степан Тарас Тимофей
Тимур Трофим Фёдор Федор Филипп Эдуард Юрий Яков Ярослав Ринат Ильдар Айрат Азамат Али Амир Ахмед Гасан Магомед Мухаммад Шамиль Эльдар Самвел Армен
Роман Лев`.split(/\s+/)

const FEMALE_NAMES = `Агата Агния Алевтина Александра Алина Алиса Алла Альбина Анастасия Ангелина Анна Антонина Арина Валентина Валерия Варвара
Василиса Вероника Виктория Галина Дарья Диана Евгения Екатерина Елена Елизавета Жанна Зинаида Зоя Инна Ирина Карина Кира Клавдия Ксения Лариса
Лидия Лилия Людмила Майя Маргарита Марина Мария Милана Наталья Наталия Нина Оксана Олеся Ольга Полина Раиса Регина Светлана София Софья Тамара
Татьяна Ульяна Юлия Яна Ярослава Эльвира Эмма Гульнара Гузель Динара Лейла Лейсан Камила
Вера Надежда`.split(/\s+/)

/** Имена-слова: сами по себе в тексте значат обычное («Роман», «Вера»), поэтому требуют рядом явную фамилию. */
const RISKY_NAMES = new Set(['роман', 'лев', 'вера', 'надежда', 'майя', 'кира', 'али', 'марк'])

export type GrammarCase = 'nom' | 'gen' | 'dat' | 'ins' | 'pre'

const GRAMMAR_CASES: readonly GrammarCase[] = ['nom', 'gen', 'dat', 'ins', 'pre']

function declineFemaleName(name: string, c: GrammarCase): string {
  if (c === 'nom') return name
  if (name.endsWith('ия')) {
    const b = name.slice(0, -1)
    return { gen: `${b}и`, dat: `${b}и`, ins: `${b}ей`, pre: `${b}и` }[c]
  }
  if (name.endsWith('я')) {
    const b = name.slice(0, -1)
    return { gen: `${b}и`, dat: `${b}е`, ins: `${b}ей`, pre: `${b}е` }[c]
  }
  if (name.endsWith('а')) {
    const b = name.slice(0, -1)
    const afterHush = /[гкхжчшщ]$/.test(b)
    return { gen: `${b}${afterHush ? 'и' : 'ы'}`, dat: `${b}е`, ins: `${b}${/[жчшщц]$/.test(b) ? 'ей' : 'ой'}`, pre: `${b}е` }[c]
  }
  return name
}

function declineMaleName(name: string, c: GrammarCase): string {
  if (c === 'nom') return name
  if (name === 'Павел') return { gen: 'Павла', dat: 'Павлу', ins: 'Павлом', pre: 'Павле' }[c]
  if (name === 'Лев') return { gen: 'Льва', dat: 'Льву', ins: 'Львом', pre: 'Льве' }[c]
  if (name === 'Пётр') return { gen: 'Петра', dat: 'Петру', ins: 'Петром', pre: 'Петре' }[c]
  if (name === 'Али') return name
  if (/[ая]$/.test(name)) return declineFemaleName(name, c) // Никита, Илья — склоняются как на -а/-я
  if (name.endsWith('ий')) {
    const b = name.slice(0, -1)
    return { gen: `${b}я`, dat: `${b}ю`, ins: `${b}ем`, pre: `${b}и` }[c]
  }
  if (/[йь]$/.test(name)) {
    const b = name.slice(0, -1)
    return { gen: `${b}я`, dat: `${b}ю`, ins: `${b}ем`, pre: `${b}е` }[c]
  }
  return { gen: `${name}а`, dat: `${name}у`, ins: `${name}ом`, pre: `${name}е` }[c]
}

export interface GivenName {
  nominative: string
  gender: PiiGender
  risky: boolean
}

/** Все падежные формы имён (и винительный: «Анну», «Марию») → именительный. */
const GIVEN_NAMES: Map<string, GivenName> = (() => {
  const out = new Map<string, GivenName>()
  const add = (form: string, info: GivenName) => {
    const key = normalize(form)
    if (!out.has(key)) out.set(key, info)
  }
  const addAll = (names: string[], gender: PiiGender, decline: (n: string, c: GrammarCase) => string) => {
    for (const n of names) {
      const info: GivenName = { nominative: n, gender, risky: RISKY_NAMES.has(normalize(n)) }
      for (const c of GRAMMAR_CASES) add(decline(n, c), info)
      if (n.endsWith('а')) add(`${n.slice(0, -1)}у`, info)
      if (n.endsWith('я')) add(`${n.slice(0, -1)}ю`, info)
    }
  }
  addAll(FEMALE_NAMES, 'f', declineFemaleName)
  addAll(MALE_NAMES, 'm', declineMaleName)
  return out
})()

export function givenName(word: string): GivenName | undefined {
  return GIVEN_NAMES.get(normalize(word))
}

// ── Отчества ───────────────────────────────────────────────────────────────────

/** Прилагательные с тем же хвостом, что у отчеств: «Основной», «Уголовная», «Верховной». */
const NOT_PATRONYMIC = /^(?:основн|уголовн|виновн|условн|верховн|духовн|нормативн|ежедневн|безусловн|невиновн|дословн|поголовн|ровн|неровн|полновн|душевн|вещевн|плановн)/

const FEMALE_ICH = /^(?:ильинич|никитич|кузьминич|лукинич|фоминич|саввич|ильич)н/

export interface Patronymic {
  nominative: string
  gender: PiiGender
}

export function titleCase(word: string): string {
  return word.toLowerCase().split('-').map(p => (p ? p[0]!.toUpperCase() + p.slice(1) : p)).join('-')
}

/** Разбор отчества: «Ивановичу» → «Иванович», м.р.; «Сергеевной» → «Сергеевна», ж.р. Не отчество — undefined. */
export function patronymic(word: string): Patronymic | undefined {
  const w = word.toLowerCase()
  const male = /^(.{2,}(?:ович|евич|ёвич|ьич|инич))(а|у|ем|ом|е)?$/.exec(w)
  if (male) return { nominative: titleCase(male[1]!), gender: 'm' }
  const female = /^(.{2,}(?:овн|евн|ёвн|ичн))(а|ы|е|у|ой|ою)$/.exec(w)
  if (!female) return undefined
  const base = female[1]!
  if (NOT_PATRONYMIC.test(base)) return undefined
  if (base.endsWith('ичн') && !FEMALE_ICH.test(base)) return undefined
  return { nominative: titleCase(`${base}а`), gender: 'f' }
}

function declinePatronymic(p: Patronymic, c: GrammarCase): string {
  if (c === 'nom') return p.nominative
  if (p.gender === 'm') {
    const n = p.nominative
    return { gen: `${n}а`, dat: `${n}у`, ins: `${n}${n.endsWith('ьич') ? 'ом' : 'ем'}`, pre: `${n}е` }[c]
  }
  const b = p.nominative.slice(0, -1)
  return { gen: `${b}ы`, dat: `${b}е`, ins: `${b}ой`, pre: `${b}е` }[c]
}

// ── Человек ────────────────────────────────────────────────────────────────────

/** Чем был найден человек в тексте. */
export interface PersonCandidate {
  start: number
  end: number
  /** Слово фамилии, как в тексте (без инициалов). Нет — только имя с отчеством. */
  surname?: string
  first?: string
  patronymic?: string
  /** Инициалы без точек: «ИИ», «И». Для полного ФИО считаются из имени и отчества. */
  initials: string
  /** Род по окружению, когда сама форма его не показывает: «с Иванова» — мужчина, «ответчик Иванова» — женщина. */
  contextGender?: PiiGender
}

/** Что известно о роде из самой формы: отчество надёжнее имени, имя надёжнее фамилии, окружение последнее. */
function candidateGender(c: PersonCandidate): PiiGender | undefined {
  return (c.patronymic ? patronymic(c.patronymic)?.gender : undefined)
    ?? (c.first ? givenName(c.first)?.gender : undefined)
    ?? (c.surname ? surnameShape(c.surname).gender : undefined)
    ?? c.contextGender
}

/** Падеж склонённой метки: «Человеку_1» — окончание «у», значит дательный. Неизвестное окончание — undefined. */
export function caseFromLabelEnding(ending: string): GrammarCase | undefined {
  switch (ending) {
    case '': return 'nom'
    case 'а': return 'gen'
    case 'у': return 'dat'
    case 'ом':
    case 'ем': return 'ins'
    case 'е': return 'pre'
    default: return undefined
  }
}

export class DocumentPerson {
  surname?: SurnameShape
  firstNominative?: string
  patr?: Patronymic
  initials = ''
  gender?: PiiGender
  /** Именительный согласной фамилии, если он встретился: только тогда её можно склонять уверенно. */
  private nominativeSurname?: string

  /** written — как написано в документе при первой встрече: запасной ответ, когда склонять рискованно. */
  constructor(readonly id: number, readonly written: string) {}

  /** Дополнить карточку человека тем, что дала новая форма. */
  absorb(c: PersonCandidate): void {
    if (c.surname) {
      const shape = surnameShape(c.surname)
      if (!this.surname) this.surname = shape
      if (shape.gender && !this.gender) this.gender = shape.gender
      if (shape.nominative && shape.cls === 'cons') this.nominativeSurname = titleCase(c.surname)
    }
    if (c.first) {
      const g = givenName(c.first)
      if (g) {
        this.firstNominative = g.nominative
        if (!this.gender) this.gender = g.gender
      }
    }
    if (c.patronymic) {
      const p = patronymic(c.patronymic)
      if (p) {
        this.patr = p
        this.gender = p.gender
      }
    }
    if (c.contextGender && !this.gender) this.gender = c.contextGender
    if (c.initials.length > this.initials.length) this.initials = c.initials
  }

  private surnameIn(c: GrammarCase): string | undefined {
    const s = this.surname
    if (!s) return undefined
    const stem = titleCase(s.stem)
    if (s.cls === 'ov') {
      if (this.gender === 'f') return `${stem}${c === 'nom' ? 'а' : 'ой'}`
      return `${stem}${{ nom: '', gen: 'а', dat: 'у', ins: 'ым', pre: 'е' }[c]}`
    }
    if (s.cls === 'sky') {
      if (this.gender === 'f') return `${stem}${c === 'nom' ? 'ая' : 'ой'}`
      return `${stem}${{ nom: 'ий', gen: 'ого', dat: 'ому', ins: 'им', pre: 'ом' }[c]}`
    }
    if (s.cls === 'cons' && this.nominativeSurname) {
      const n = this.nominativeSurname
      if (this.gender === 'f') return n
      if (!/[бвгджзклмнпрстфхцчшщ]$/.test(n)) return undefined
      return `${n}${{ nom: '', gen: 'а', dat: 'у', ins: /[жчшщц]$/.test(n) ? 'ем' : 'ом', pre: 'е' }[c]}`
    }
    return undefined
  }

  /**
   * Что вернуть вместо метки с данным окончанием. Без рода и без склоняемой фамилии — как написано в документе:
   * «Иванова И.И.» без других форм может быть и женщиной в именительном, и мужчиной в родительном.
   */
  render(ending: string): string {
    const c = caseFromLabelEnding(ending)
    if (!c || !this.gender) return this.written
    const surname = this.surname ? this.surnameIn(c) : ''
    if (surname === undefined) return this.written
    if (this.firstNominative && this.patr) {
      const declineName = this.gender === 'f' ? declineFemaleName : declineMaleName
      return [surname, declineName(this.firstNominative, c), declinePatronymic(this.patr, c)].filter(Boolean).join(' ')
    }
    if (!surname) return this.written
    if (!this.initials) return surname
    return `${surname} ${[...this.initials].map(i => `${i}.`).join('')}`
  }
}

/** Совместимы ли инициалы: «И» и «ИП» — да, «ИП» и «ИИ» — нет. Пустые совместимость не доказывают. */
function initialsCompatible(a: string, b: string): boolean {
  if (!a || !b) return false
  return a.startsWith(b) || b.startsWith(a)
}

/**
 * Реестр людей на один вызов модели. Сначала регистрируются формы с инициалами и отчеством, потом голые фамилии:
 * голую «Иванов» можно связать только когда известны все Ивановы документа.
 */
export class PersonRegistry {
  private readonly people: DocumentPerson[] = []
  private readonly byStem = new Map<string, DocumentPerson[]>()
  /** Люди, у которых есть только имя и отчество: «Иван Иванович». */
  private readonly byFirstPatr = new Map<string, DocumentPerson>()

  private create(written: string, stem?: string): DocumentPerson {
    const p = new DocumentPerson(this.people.length + 1, written)
    this.people.push(p)
    if (stem) {
      const list = this.byStem.get(stem) ?? []
      list.push(p)
      this.byStem.set(stem, list)
    }
    return p
  }

  /** Человек для формы; нет подходящего — заводится новый. */
  resolve(c: PersonCandidate, written: string): DocumentPerson {
    const person = c.surname ? this.lookupBySurname(c, c.surname, written) : this.lookupByGiven(c, written)
    person.absorb(c)
    return person
  }

  private lookupBySurname(c: PersonCandidate, surname: string, written: string): DocumentPerson {
    const stem = surnameShape(surname).stem
    const same = this.byStem.get(stem) ?? []
    const gender = candidateGender(c)
    const sameGender = same.filter(p => !(gender && p.gender && gender !== p.gender))
    // Истец и ответчик-однофамильцы хуже двух меток у одного человека: модель решила бы, что он судится сам с собой.
    // Поэтому «Иванова» без подсказки окружения к известному мужчине не присоединяется, хотя может быть его родительным.
    const open = !gender && isGenderAmbiguousSurname(surname) ? sameGender.filter(p => p.gender !== 'm') : sameGender
    if (c.initials) {
      // Совпавшие инициалы сильнее сомнения в форме: «с Иванова И.И.» при «Иванов И.И.» — один человек.
      const hit = sameGender.find(p => initialsCompatible(p.initials, c.initials))
      if (hit) return hit
      return open.find(p => !p.initials) ?? this.create(written, stem)
    }
    const withInitials = open.filter(p => p.initials)
    if (withInitials.length === 1) return withInitials[0]!
    return open.find(p => !p.initials) ?? this.create(written, stem)
  }

  /** «Иван Иванович» при уже известном «Иванов Иван Иванович» — тот же человек, если он один такой. */
  private lookupByGiven(c: PersonCandidate, written: string): DocumentPerson {
    const first = c.first ? givenName(c.first)?.nominative ?? c.first : ''
    const patr = c.patronymic ? patronymic(c.patronymic)?.nominative ?? c.patronymic : ''
    const hits = this.people.filter(p => p.surname && p.firstNominative === first && p.patr?.nominative === patr)
    if (hits.length === 1) return hits[0]!
    const key = `${first}|${patr}`.toLowerCase()
    const known = this.byFirstPatr.get(key)
    if (known) return known
    const created = this.create(written)
    this.byFirstPatr.set(key, created)
    return created
  }

  /** Известна ли такая фамилия: слово встречается в документе и без инициалов («Иванов пояснил»). */
  knowsStem(stem: string): boolean {
    return stem.length >= 4 && this.byStem.has(stem)
  }
}
