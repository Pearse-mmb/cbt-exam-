import { NextRequest, NextResponse } from 'next/server'
import { adminAuth, adminDb } from '@/lib/firebase-admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Same staff check as /api/admin/verify. Returns an error response, or null if allowed. */
async function rejectIfNotStaff(request: NextRequest) {
  const authorization = request.headers.get('Authorization')

  if (!authorization?.startsWith('Bearer ')) {
    return NextResponse.json(
      { success: false, message: 'Authentication required.' },
      { status: 401 }
    )
  }

  const decodedToken = await adminAuth.verifyIdToken(authorization.slice(7))

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

  return null
}

export async function GET(request: NextRequest) {
  try {
    const rejected = await rejectIfNotStaff(request)
    if (rejected) return rejected

    const snapshot = await adminDb.collection('results').get()

    const results = snapshot.docs
      .map(document => {
        const r = document.data()
        return {
          id: document.id,
          studentId: String(r.studentId || ''),
          studentName: String(r.studentName || ''),
          examId: String(r.examId || ''),
          subject: String(r.subject || ''),
          classLevel: String(r.classLevel || ''),
          score: Number(r.score) || 0,
          total: Number(r.total) || 0,
          submittedAt: String(r.submittedAt || ''),
          submittedAtISO: String(r.submittedAtISO || ''),
        }
      })
      // Newest first
      .sort((a, b) => b.submittedAtISO.localeCompare(a.submittedAtISO))
      .map(({ submittedAtISO, ...rest }) => {
        void submittedAtISO
        return rest
      })

    return NextResponse.json({ success: true, results })
  } catch (error) {
    console.error('ADMIN RESULTS ERROR:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to load results.' },
      { status: 500 }
    )
  }
}

/** Removes a result AND the saved attempt, so the student can sit the exam again. */
export async function DELETE(request: NextRequest) {
  try {
    const rejected = await rejectIfNotStaff(request)
    if (rejected) return rejected

    const body = await request.json().catch(() => ({}))
    const id = String(body.id || '').trim()

    if (!id || id.includes('/')) {
      return NextResponse.json(
        { success: false, message: 'Invalid result.' },
        { status: 400 }
      )
    }

    await adminDb.collection('results').doc(id).delete()
    await adminDb.collection('attempts').doc(id).delete()

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('ADMIN RESULT DELETE ERROR:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to delete this result.' },
      { status: 500 }
    )
  }
}
