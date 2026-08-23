import { createPasswordHash } from '../src/auth/provider.js'

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  throw new Error('Run this command in an interactive terminal.')
}

const first = await readHidden('New private OAuth access password: ')
const second = await readHidden('Confirm private OAuth access password: ')
if (first !== second) throw new Error('The passwords did not match.')

process.stdout.write(`${await createPasswordHash(first)}\n`)

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let value = ''
    const input = process.stdin
    const previousRawMode = input.isRaw

    const finish = (error?: Error): void => {
      input.off('data', onData)
      input.setRawMode(previousRawMode)
      input.pause()
      process.stdout.write('\n')
      if (error) reject(error)
      else resolve(value)
    }

    const onData = (chunk: Buffer): void => {
      for (const character of chunk.toString('utf8')) {
        if (character === '\r' || character === '\n') {
          finish()
          return
        }
        if (character === '\u0003') {
          finish(new Error('Cancelled.'))
          return
        }
        if (character === '\u007f' || character === '\b') {
          value = value.slice(0, -1)
        } else if (character >= ' ') {
          value += character
        }
      }
    }

    process.stdout.write(prompt)
    input.setRawMode(true)
    input.resume()
    input.on('data', onData)
  })
}
