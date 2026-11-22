import { NextRequest, NextResponse } from 'next/server'
import { adminAuth } from '@/lib/firebase-admin'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
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