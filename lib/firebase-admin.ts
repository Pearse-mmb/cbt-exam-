import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

// Accepts the key with literal \n text, real line breaks, or wrapping quotes
function cleanPrivateKey(raw: string | undefined) {
  if (!raw) return ''
  let key = raw.trim()
  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1)
  }
  return key.replace(/\\n/g, '\n')
}

const projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim()
const privateKey = cleanPrivateKey(process.env.FIREBASE_PRIVATE_KEY)

if (!projectId || !clientEmail || !privateKey) {
  throw new Error(
    'Firebase Admin is not configured: check FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY and the project ID in the environment variables.'
  )
}

const app = getApps().length
  ? getApps()[0]
  : initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })

export const adminAuth = getAuth(app)
export const adminDb = getFirestore(app)