import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase-admin'
import { getStudentSession } from '@/lib/student-session'
import { attemptIdFor, finalizeAttempt, GRACE_MS } from '@/lib/exam-attempts'

export const runtime = 'nodejs'

export async function POST(request: NextRequest) {
  try {
    const session = getStudentSession(request)

    if (!session) {
      return NextResponse.json(
        { success: false, message: 'Your session has expired. Please log in again.' },
        { status: 401 }
      )
    }

    const body = await request.json()
    const examId = String(body.examId || '').trim()
    const submitted: Record<string, unknown> =
      body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
        ? body.answers
        : {}

    if (!examId) {
      return NextResponse.json(
        { success: false, message: 'Missing exam information.' },
        { status: 400 }
      )
    }

    const id = attemptIdFor(examId, session.studentId)

    // Already submitted (for example a retry after a lost response): return the stored score
    const existing = await adminDb.collection('results').doc(id).get()
    if (existing.exists) {
      const r = existing.data() ?? {}
      return NextResponse.json({
        success: true,
        alreadySubmitted: true,
        result: {
          id,
          score: Number(r.score) || 0,
          total: Number(r.total) || 0,
          submittedAt: String(r.submittedAt || ''),
        },
      })
    }

    const attemptSnapshot = await adminDb.collection('attempts').doc(id).get()
    const attempt = attemptSnapshot.data()

    if (!attemptSnapshot.exists || !attempt || attempt.studentId !== session.studentId) {
      return NextResponse.json(
        { success: false, message: 'This examination was not started.' },
        { status: 409 }
      )
    }

    const studentDoc = await adminDb.collection('students').doc(session.firestoreId).get()
    const student = studentDoc.data()

    if (
      !studentDoc.exists ||
      !student ||
      String(student.studentId || '').toUpperCase() !== session.studentId ||
      student.status !== 'active'
    ) {
      return NextResponse.json(
        { success: false, message: 'Student record could not be verified.' },
        { status: 403 }
      )
    }

    const examDoc = await adminDb.collection('exams').doc(examId).get()
    const exam = examDoc.data()

    if (!examDoc.exists || !exam) {
      return NextResponse.json(
        { success: false, message: 'Examination not found.' },
        { status: 404 }
      )
    }

    if (
      exam.classLevel !== student.classLevel ||
      String(exam.category || 'General') !== String(student.category || 'General')
    ) {
      return NextResponse.json(
        { success: false, message: 'This examination is not assigned to your class.' },
        { status: 403 }
      )
    }

    // The server decides which answers count. Inside the time limit (plus a short grace
    // for slow networks) the student's final answers are used; after that only the
    // answers that were already auto-saved on the server count.
    const saved = (attempt.answers as Record<string, unknown>) || {}
    const endMs =
      (Number(attempt.startedAtMs) || 0) + (Number(attempt.durationSeconds) || 0) * 1000
    const withinTime = Date.now() <= endMs + GRACE_MS
    const answers = withinTime ? { ...saved, ...submitted } : saved

    const result = await finalizeAttempt({
      studentId: session.studentId,
      firestoreId: session.firestoreId,
      examId,
      student,
      exam,
      answers,
    })

    return NextResponse.json({
      success: true,
      alreadySubmitted: result.alreadySubmitted,
      result: {
        id: result.id,
        score: result.score,
        total: result.total,
        submittedAt: result.submittedAt,
      },
    })
  } catch (error) {
    if (error instanceof Error && error.message === 'NO_QUESTIONS') {
      return NextResponse.json(
        { success: false, message: 'This examination has no questions.' },
        { status: 409 }
      )
    }

    console.error('Result submission error:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to submit your exam. Please try again.' },
      { status: 500 }
    )
  }
}