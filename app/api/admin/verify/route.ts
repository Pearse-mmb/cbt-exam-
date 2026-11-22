import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function describe(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

// TEMPORARY: open /api/admin/verify in the browser to see what the server has.
// Shows only yes/no and lengths, never the secret values. Delete this after we fix it.
export async function GET() {
  const info: Record<string, string | number | boolean> = {
    FIREBASE_CLIENT_EMAIL_set: Boolean(process.env.FIREBASE_CLIENT_EMAIL),
    ADMIN_EMAIL_set: Boolean(process.env.ADMIN_EMAIL),
    PROJECT_ID_set: Boolean(
      process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    ),
    FIREBASE_PRIVATE_KEY_length: (process.env.FIREBASE_PRIVATE_KEY || '').length,
    FIREBASE_PRIVATE_KEY_BASE64_length: (process.env.FIREBASE_PRIVATE_KEY_BASE64 || '').length,
  }

  try {
    await import('@/lib/firebase-admin')
    info.firebaseAdmin = 'ok'
  } catch (error) {
    info.firebaseAdmin = describe(error)
  }

  return NextResponse.json(info)
}

export async function POST(request: NextRequest) {
  // Load Firebase Admin here so a setup problem shows a readable message
  let adminAuth: typeof import('@/lib/firebase-admin')['adminAuth']
  try {
    ;({ adminAuth } = await import('@/lib/firebase-admin'))
  } catch (error) {
    console.error('FIREBASE ADMIN SETUP ERROR:', error)
    return NextResponse.json(
      { success: false, message: `Server setup problem: ${describe(error)}` },
      { status: 500 }
    )
  }

  try {
    const authorization = request.headers.get('Authorization')

    if (!authorization?.startsWith('Bearer ')) {
      return NextResponse.json(
        { success: false, message: 'Authentication required.' },
        { status: 401 }
      )
    }

    const token = authorization.slice(7)
    const decodedToken = await adminAuth.verifyIdToken(token)

    const adminEmail = process.env.ADMIN_EMAIL?.trim().toLowerCase()
    const userEmail = decodedToken.email?.toLowerCase()

    if (
      !adminEmail ||
      !userEmail ||
      userEmail !== adminEmail ||
      decodedToken.email_verified !== true
    ) {
      return NextResponse.json(
        { success: false, message: 'You are not authorised as staff.' },
        { status: 403 }
      )
    }

    return NextResponse.json({
      success: true,
      role: 'admin',
      uid: decodedToken.uid,
      message: 'Authentication successful.',
    })
  } catch (error) {
    console.error('ADMIN VERIFY ERROR:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to verify your account.' },
      { status: 500 }
    )
  }
}