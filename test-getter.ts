import { formatLogLine } from './packages/core/src/logger.ts'
const payload = {
  get thrower() {
    throw new Error('getter threw')
  }
}
try {
  const line = formatLogLine('info', 'test', 'msg', payload)
  console.log('LINE:', line)
} catch (e) {
  console.log('THREW:', e.message)
}
