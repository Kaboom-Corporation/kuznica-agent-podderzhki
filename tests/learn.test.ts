import { describe, expect, it } from 'vitest'
import { learnedText } from '../server/lib/learn'

// Заказчик, чат 27.11: менеджер ответил → агент запомнил → следующий клиент получил ответ сам
describe('ответ менеджера в базу знаний', () => {
  it('вопрос и ответ складываются в один документ с понятным заголовком', () => {
    const r = learnedText('Можно ли перенести лицензию на другой компьютер?', 'Да, через личный кабинет: удалите ключ на старом ПК и введите на новом.')
    expect(r.title).toBe('Ответ менеджера: Можно ли перенести лицензию на другой компьютер?')
    expect(r.content).toContain('Вопрос клиента: Можно ли перенести')
    expect(r.content).toContain('Ответ менеджера: Да, через личный кабинет')
  })
  it('почта и телефон не попадают в базу знаний', () => {
    const r = learnedText('Пишу с ivan.petrov@example.com, +7 916 123-45-67, ключ не пришёл', 'Отправили повторно на ivan.petrov@example.com, проверьте папку «Спам».')
    expect(r.content).not.toContain('ivan.petrov@example.com')
    expect(r.content).not.toContain('123-45-67')
    expect(r.title).not.toContain('ivan.petrov')
  })
  it('ключ лицензии клиента в базу знаний не попадает', () => {
    const r = learnedText('Не активируется ключ ABCDE-12345-FGHIJ-67890', 'Ключ ABCDE-12345-FGHIJ-67890 привязан к другой редакции, напишите номер заказа.')
    expect(r.content).not.toContain('ABCDE-12345')
    expect(r.content).toContain('[ключ скрыт]')
  })
  it('длинный вопрос в заголовке обрезается', () => {
    expect(learnedText('а'.repeat(300), 'ответ достаточно длинный').title.length).toBeLessThanOrEqual('Ответ менеджера: '.length + 90)
  })
})
