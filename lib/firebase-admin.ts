import { cert, getApps, initializeApp } from 'firebase-admin/app'
import { getAuth } from 'firebase-admin/auth'
import { getFirestore } from 'firebase-admin/firestore'

// Accepts the key as: literal \n text, real line breaks, wrapped in quotes,
// or damaged spacing. Rebuilds a clean PEM from the base64 body.
function cleanPrivateKey(raw: string | undefined) {
  if (!raw) return ''
  let key = raw.trim()

  if (
    (key.startsWith('"') && key.endsWith('"')) ||
    (key.startsWith("'") && key.endsWith("'"))
  ) {
    key = key.slice(1, -1)
  }

  // Turn escaped "\n" text (one or more backslashes) into real line breaks
  key = key.replace(/\\+n/g, '\n')

  const match = key.match(
    /-----BEGIN PRIVATE KEY-----([\s\S]*?)-----END PRIVATE KEY-----/
  )
  if (!match) return key

  const body = match[1].replace(/\s+/g, '')
  const lines = body.match(/.{1,64}/g) ?? []

  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`
}

function readPrivateKey() {
  // Optional: a base64 copy of the key, immune to line-break problems
  const encoded = process.env.FIREBASE_PRIVATE_KEY_BASE64?.trim()
  if (encoded) {
    return cleanPrivateKey(Buffer.from(encoded, 'base64').toString('utf8'))
  }
  return cleanPrivateKey(process.env.FIREBASE_PRIVATE_KEY)
}

const projectId =
  process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL?.trim()
const privateKey = readPrivateKey()

if (!projectId || !clientEmail || !privateKey) {
  throw new Error(
    'Firebase Admin is not configured: check FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY and the project ID in the environment variables.'
  )
}

function createApp() {
  try {
    return initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  } catch (error) {
    console.error(error)
    // Safe diagnostics: lengths and markers only, never the key itself.
    // A healthy key is about 1700 characters with both markers found.
    throw new Error(
      `Firebase private key could not be read (length ${privateKey.length}, ` +
        `header found: ${privateKey.includes('BEGIN PRIVATE KEY')}, ` +
        `footer found: ${privateKey.includes('END PRIVATE KEY')}). ` +
        'Re-enter FIREBASE_PRIVATE_KEY.'
    )
  }
}

const app = getApps().length ? getApps()[0] : createApp()

export const adminAuth = getAuth(app)
export const adminDb = getFirestore(app)