import { NextRequest, NextResponse } from 'next/server'
import { adminDb } from '@/lib/firebase-admin'
import { getExamQuestions } from '@/lib/exam-questions'
import { getStudentSession } from '@/lib/student-session'
import {
  attemptIdFor,
  finalizeAttempt,
  loadStudentExam,
  secondsRemaining,
} from '@/lib/exam-attempts'

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

    // Class and category come from the student's own record, not from the request
    const loaded = await loadStudentExam(session)

    if (!loaded.ok) {
      return NextResponse.json(
        { success: false, message: loaded.message },
        { status: loaded.status }
      )
    }

    const { student, examId, exam } = loaded
    const id = attemptIdFor(examId, session.studentId)

    // One attempt per student per exam
    const resultSnapshot = await adminDb.collection('results').doc(id).get()
    if (resultSnapshot.exists) {
      return NextResponse.json(
        { success: false, message: 'You have already taken this examination.' },
        { status: 409 }
      )
    }

    // Is there an exam already in progress? (student refreshed or logged back in)
    let inProgress = false
    let remainingSeconds = (Number(exam.duration) || 0) * 60

    const attemptSnapshot = await adminDb.collection('attempts').doc(id).get()
    const attempt = attemptSnapshot.data()

    if (attemptSnapshot.exists && attempt && attempt.status === 'in-progress') {
      const remaining = secondsRemaining(
        Number(attempt.startedAtMs) || 0,
        Number(attempt.durationSeconds) || 0
      )

      if (remaining <= 0) {
        // Time ran out while the student was away: mark the saved answers now
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

      inProgress = true
      remainingSeconds = remaining
    }

    const questions = await getExamQuestions(examId, Number(exam.numQuestions) || 0)

    return NextResponse.json({
      success: true,
      exam: {
        id: examId,
        subject: exam.subject,
        classLevel: exam.classLevel,
        category: exam.category,
        duration: exam.duration,
        numQuestions: exam.numQuestions,
      },
      // Whitelist the fields: `correct` is never sent to the browser
      questions: questions.map(q => ({
        id: q.id,
        examId: q.examId,
        text: q.text,
        optionA: q.optionA,
        optionB: q.optionB,
        optionC: q.optionC,
        optionD: q.optionD,
      })),
      attempt: { inProgress, remainingSeconds },
    })
  } catch (error) {
    console.error('Exam load error:', error)

    return NextResponse.json(
      { success: false, message: 'Unable to load the examination. Please try again.' },
      { status: 500 }
    )
  }
}