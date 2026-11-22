import { createHmac, timingSafeEqual } from 'crypto'

export interface StudentSession {
  studentId: string
  firestoreId: string
  exp: number
}

// A student's login lasts 12 hours
const TTL_MS = 12 * 60 * 60 * 1000

function secret() {
  const value = process.env.STUDENT_SESSION_SECRET
  if (!value || value.length < 16) {
    throw new Error('STUDENT_SESSION_SECRET is not configured.')
  }
  return value
}

function sign(data: string) {
  return createHmac('sha256', secret()).update(data).digest('base64url')
}

export function createStudentToken(studentId: string, firestoreId: string) {
  const payload = Buffer.from(
    JSON.stringify({ studentId, firestoreId, exp: Date.now() + TTL_MS })
  ).toString('base64url')
  return `${payload}.${sign(payload)}`
}

export function verifyStudentToken(token: string): StudentSession | null {
  try {
    const [payload, signature] = token.split('.')
    if (!payload || !signature) return null

    const expected = Buffer.from(sign(payload))
    const given = Buffer.from(signature)
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (
      !data.studentId ||
      !data.firestoreId ||
      typeof data.exp !== 'number' ||
      data.exp < Date.now()
    ) {
      return null
    }

    return {
      studentId: String(data.studentId),
      firestoreId: String(data.firestoreId),
      exp: data.exp,
    }
  } catch {
    return null
  }
}

/** Reads and checks the "Authorization: Bearer <token>" header. */
export function getStudentSession(request: Request): StudentSession | null {
  const header = request.headers.get('Authorization')
  if (!header?.startsWith('Bearer ')) return null
  return verifyStudentToken(header.slice(7))
}