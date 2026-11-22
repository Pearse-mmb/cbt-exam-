import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase-admin'
import { getStudentSession } from '@/lib/student-session'
import {
  attemptIdFor,
  finalizeAttempt,
  isAlreadyExists,
  loadStudentExam,
  secondsRemaining,
} from '@/lib/exam-attempts'

export const runtime = 'nodejs'

/**
 * Called when the student clicks "Start Exam" or "Resume Exam".
 * First call: records the start time on the server (the clock starts now).
 * Later calls: returns the time that is really left and the saved answers.
 */
export async function POST(request: NextRequest) {
  try {
    const session = getStudentSession(request)

    if (!session) {
      return NextResponse.json(
        { success: false, message: 'Your session has expired. Please log in again.' },
        { status: 401 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const requestedExamId = String(body.examId || '').trim()

    const loaded = await loadStudentExam(session)

    if (!loaded.ok) {
      return NextResponse.json(
        { success: false, message: loaded.message },
        { status: loaded.status }
      )
    }

    const { student, examId, exam } = loaded

    if (requestedExamId && requestedExamId !== examId) {
      return NextResponse.json(
        { success: false, message: 'This examination is not assigned to you.' },
        { status: 403 }
      )
    }

    const id = attemptIdFor(examId, session.studentId)

    const resultSnapshot = await adminDb.collection('results').doc(id).get()
    if (resultSnapshot.exists) {
      return NextResponse.json(
        { success: false, message: 'You have already taken this examination.' },
        { status: 409 }
      )
    }

    const durationSeconds = (Number(exam.duration) || 0) * 60
    if (durationSeconds <= 0) {
      return NextResponse.json(
        { success: false, message: 'This examination is not configured correctly.' },
        { status: 409 }
      )
    }

    const attemptRef = adminDb.collection('attempts').doc(id)

    try {
      const now = Date.now()
      await attemptRef.create({
        studentId: session.studentId,
        firestoreId: session.firestoreId,
        examId,
        startedAtMs: now,
        startedAtISO: new Date(now).toISOString(),
        durationSeconds,
        status: 'in-progress',
        answers: {},
      })
    } catch (error) {
      // Already started earlier (refresh / re-login): fall through and resume
      if (!isAlreadyExists(error)) throw error
    }

    const attemptSnapshot = await attemptRef.get()
    const attempt = attemptSnapshot.data() ?? {}

    if (attempt.status === 'submitted') {
      return NextResponse.json(
        { success: false, message: 'You have already taken this examination.' },
        { status: 409 }
      )
    }

    const remainingSeconds = secondsRemaining(
      Number(attempt.startedAtMs) || 0,
      Number(attempt.durationSeconds) || 0
    )

    if (remainingSeconds <= 0) {
      try {
        await finalizeAttempt({
          studentId: session.studentId,
          firestoreId: session.firestoreId,
          examId,
          student,
          exam,
          answers: (attempt.answers as Record<string, unknown>) || {},
        })
      } catch (error) {
        console.error('Auto-finalise failed:', error)
      }
      return NextResponse.json(
        {
          success: false,
          message: 'Your time has ended. Your saved answers were submitted automatically.',
        },
        { status: 409 }
      )
    }

    return NextResponse.json({
      success: true,
      remainingSeconds,
      answers: (attempt.answers as Record<string, string>) || {},
    })
  } catch (error) {
    console.error('Exam start error:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to start the examination. Please try again.' },
      { status: 500 }
    )
  }
}