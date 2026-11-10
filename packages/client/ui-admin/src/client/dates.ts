/** Beijing calendar dates shared by filters, price forms and displayed records. */
import type { AdminFilter } from '@deepseek-ai/dsh-admin/types'

/**
 * Format a timestamp as a Beijing calendar date for a date input.
 * @param timestamp - epoch milliseconds.
 * @returns a YYYY-MM-DD date.
 */
export function calendarDate(timestamp: number): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(timestamp)
  const field = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find(part => part.type === type)
    if (!found) throw new Error(`Calendar field ${type} is missing`)
    return found.value
  }
  return `${field('year')}-${field('month')}-${field('day')}`
}

/**
 * Interpret an administration date or local datetime in Beijing time.
 * @param value - date input or datetime-local input value.
 * @returns epoch milliseconds, or NaN for invalid input.
 */
export function beijingTimestamp(value: string): number {
  return Date.parse(`${value.includes('T') ? value : `${value}T00:00:00`}+08:00`)
}

/**
 * Select a complete inclusive range ending on the current Beijing calendar day.
 * @param now - current epoch milliseconds.
 * @param days - positive number of calendar days.
 * @returns inclusive start and exclusive end timestamps.
 */
export function initialCalendarFilter(now: number, days: number): AdminFilter {
  const end = beijingTimestamp(calendarDate(now)) + 86400000
  return { from: end - days * 86400000, to: end }
}
