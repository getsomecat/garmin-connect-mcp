import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export const dateRangeSchema: Tool['inputSchema'] = {
  type: 'object',
  properties: {
    start_date: {
      type: 'string',
      description: 'First date in YYYY-MM-DD format. Defaults to today.',
    },
    end_date: {
      type: 'string',
      description: 'Last date in YYYY-MM-DD format. Defaults to start_date.',
    },
  },
  additionalProperties: false,
}

export function datesFromArgs(args: Record<string, unknown>, maxDays = 31): string[] {
  const start = optionalString(args.start_date) ?? todayLocal()
  const end = optionalString(args.end_date) ?? start
  const current = parseDate(start, 'start_date')
  const last = parseDate(end, 'end_date')
  if (current.getTime() > last.getTime()) {
    throw new Error('start_date must be on or before end_date.')
  }

  const dates: string[] = []
  while (current.getTime() <= last.getTime()) {
    if (dates.length >= maxDays) {
      throw new Error(`Date ranges are limited to ${maxDays} days.`)
    }
    dates.push(localDateString(current))
    current.setDate(current.getDate() + 1)
  }
  return dates
}

export function boundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  name: string,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}.`)
  }
  return value
}

export function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('Expected a non-empty string.')
  }
  return value
}

export function optionalBoolean(value: unknown, fallback: boolean, name: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`)
  return value
}

export async function mapDates<T>(
  dates: string[],
  fetch: (date: string) => Promise<T>,
): Promise<T | T[]> {
  const results: T[] = []
  for (const date of dates) results.push(await fetch(date))
  return results.length === 1 ? results[0] as T : results
}

export function oneOrMany<T>(results: T[]): T | T[] {
  return results.length === 1 ? results[0] as T : results
}

function parseDate(value: string, name: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!match) throw new Error(`${name} must use YYYY-MM-DD format.`)
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const date = new Date(year, month - 1, day, 12)
  if (
    date.getFullYear() !== year
    || date.getMonth() !== month - 1
    || date.getDate() !== day
  ) {
    throw new Error(`${name} is not a valid calendar date.`)
  }
  return date
}

function todayLocal(): string {
  return localDateString(new Date())
}

function localDateString(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}
