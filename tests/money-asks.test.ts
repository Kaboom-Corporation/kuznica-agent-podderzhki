import { describe, expect, it } from 'vitest'
import { deferralAsk, discountAsk } from '../server/agent/money-asks'

describe('discountAsk', () => {
  it('просьба о скидке без цифры или до 5% — агент даёт сам', () => {
    expect(discountAsk('Сумма великовата. Можете сделать скидку?')).toBe('goodwill')
    expect(discountAsk('А подешевле никак?')).toBe('goodwill')
    expect(discountAsk('Дадите скидку 5%?')).toBe('goodwill')
  })
  it('больше 5% — менеджер', () => {
    expect(discountAsk('Нужна скидка 15%, иначе не согласуют')).toBe('manager')
    expect(discountAsk('Уступите 10 процентов?')).toBe('manager')
  })
  it('без просьбы о скидке — null', () => {
    expect(discountAsk('Сколько стоит Dr.Web на 50 ПК?')).toBeNull()
    expect(discountAsk('НДС 22% включён в цену?')).toBeNull()
    expect(discountAsk('Скиньте ссылку на счёт')).toBeNull()
  })
})

describe('deferralAsk', () => {
  it('распознаёт отсрочку и рассрочку', () => {
    expect(deferralAsk('А отсрочку платежа на 30 дней дадите?')).toBe(true)
    expect(deferralAsk('Можно в рассрочку?')).toBe(true)
    expect(deferralAsk('Работаете по постоплате?')).toBe(true)
  })
  it('обычная оплата — нет', () => {
    expect(deferralAsk('Как оплатить счёт?')).toBe(false)
  })
})
