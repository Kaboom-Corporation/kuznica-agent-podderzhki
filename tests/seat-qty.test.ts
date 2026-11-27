import { describe, expect, it } from 'vitest'
import { perSeat, seatCount } from '../server/agent/catalog-search'

// КП-109 (27.11): почта Kaspersky за место ушла в КП с qty 1 при 50 сотрудниках, а Dr.Web — комплект «на 50 ПК».
describe('цена за место или комплект', () => {
  it('почтовая защита за место, Dr.Web на 50 ПК — комплект', () => {
    expect(perSeat('Kaspersky Security для почтовых серверов базовая лицензия на 1 год по количеству почтовых адресов')).toBe(true)
    expect(perSeat('Доктор Веб Комплексная защита, без компонентов на 1 год на 50 ПК')).toBe(false)
  })
  it('число мест берётся из реплики клиента', () => {
    expect(seatCount('Доктор Веб на 50 ПК и защиту почтового сервера SL-3853')).toBe(50)
    expect(seatCount('Надо защитить почту и файлы на 50 сотрудников')).toBe(50)
  })
})
