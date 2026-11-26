import { describe, expect, it } from 'vitest'
import { absorb, checkRegistry, emptyFacts } from '../server/agent/verify'

function factsFromCatalog() {
  const f = emptyFacts(new Date('2026-11-26'))
  absorb(f, {
    items: [
      { sku: 'SL-517991', name: 'Astra Linux Special Edition 1.8, x86-64, «Орел»', price: '3 100,00 ₽', in_registry: 'в реестре российского ПО' },
      { sku: 'SL-542338', name: 'РЕД СОФТ РЕД ОС, Простая лицензия', price: '21 000,00 ₽', in_registry: 'нет в реестре' },
    ],
  })
  return f
}

describe('утверждения «в реестре»', () => {
  it('позиция с отметкой — можно', () => {
    expect(checkRegistry('**Astra Linux Special Edition** (в реестре российского ПО):\n- 3 100 ₽ (SL-517991)', factsFromCatalog())).toEqual([])
  })
  it('позиция без отметки, по артикулу и по названию — нельзя', () => {
    const f = factsFromCatalog()
    expect(checkRegistry('**РЕД ОС** (в реестре российского ПО):\n- 21 000 ₽ (арт. SL-542338)', f)).toEqual([{ kind: 'реестр', value: 'SL-542338' }])
    expect(checkRegistry('Ред Софт РЕД ОС — тоже в реестре.', f)).toEqual([{ kind: 'реестр', value: 'ред софт ред ос' }])
  })
  it('«нет в реестре» и разные абзацы не путаются', () => {
    const f = factsFromCatalog()
    expect(checkRegistry('РЕД СОФТ РЕД ОС (SL-542338) — в каталоге нет в реестре.', f)).toEqual([])
    expect(checkRegistry('Astra (SL-517991) — в реестре.\n\nРЕД СОФТ РЕД ОС (SL-542338) — 21 000 ₽.', f)).toEqual([])
  })
})
