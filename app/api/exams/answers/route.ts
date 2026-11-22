import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase-admin'
import { getStudentSession } from '@/lib/student-session'
import { attemptIdFor, GRACE_MS } from '@/lib/exam-attempts'

export const runtime = 'nodejs'

/** Autosave: stores the student's answers so a refresh or crash loses nothing. */
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
    const raw: Record<string, unknown> =
      body.answers && typeof body.answers === 'object' && !Array.isArray(body.answers)
        ? body.answers
        : {}

    if (!examId) {
      return NextResponse.json(
        { success: false, message: 'Missing exam information.' },
        { status: 400 }
      )
    }

    const attemptRef = adminDb
      .collection('attempts')
      .doc(attemptIdFor(examId, session.studentId))
    const snapshot = await attemptRef.get()
    const attempt = snapshot.data()

    if (!snapshot.exists || !attempt) {
      return NextResponse.json(
        { success: false, message: 'This examination has not been started.' },
        { status: 404 }
      )
    }

    if (attempt.studentId !== session.studentId || attempt.status !== 'in-progress') {
      return NextResponse.json(
        { success: false, message: 'This examination is no longer open.' },
        { status: 409 }
      )
    }

    const endMs =
      (Number(attempt.startedAtMs) || 0) + (Number(attempt.durationSeconds) || 0) * 1000
    if (Date.now() > endMs + GRACE_MS) {
      return NextResponse.json(
        { success: false, message: 'Time is up.' },
        { status: 409 }
      )
    }

    // Keep only well-formed answers
    const clean: Record<string, string> = {}
    for (const [questionId, letter] of Object.entries(raw).slice(0, 300)) {
      if (
        questionId.length > 0 &&
        questionId.length <= 120 &&
        typeof letter === 'string' &&
        ['A', 'B', 'C', 'D'].includes(letter)
      ) {
        clean[questionId] = letter
      }
    }

    await attemptRef.update({
      answers: clean,
      lastSavedAtISO: new Date().toISOString(),
    })

    return NextResponse.json({ success: true, saved: Object.keys(clean).length })
  } catch (error) {
    console.error('Answer save error:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to save your answers.' },
      { status: 500 }
    )
  }
}