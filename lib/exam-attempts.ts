import { adminDb } from '@/lib/firebase-admin'
import { getExamQuestions } from '@/lib/exam-questions'
import type { StudentSession } from '@/lib/student-session'

/** Extra seconds allowed after the timer ends, for slow networks. */
export const GRACE_MS = 60_000

export const attemptIdFor = (examId: string, studentId: string) => `${examId}_${studentId}`

export function formatSubmittedAt(date: Date) {
  return date.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'Africa/Lagos',
  })
}

export function isAlreadyExists(error: unknown) {
  const code = (error as { code?: number | string }).code
  return code === 6 || code === 'already-exists'
}

export function secondsRemaining(startedAtMs: number, durationSeconds: number) {
  return Math.ceil((startedAtMs + durationSeconds * 1000 - Date.now()) / 1000)
}

type Loaded =
  | { ok: true; student: Record<string, unknown>; examId: string; exam: Record<string, unknown> }
  | { ok: false; status: number; message: string }

/** Finds the logged-in student's record and the exam for their class + category. */
export async function loadStudentExam(session: StudentSession): Promise<Loaded> {
  const studentDoc = await adminDb.collection('students').doc(session.firestoreId).get()
  const student = studentDoc.data()

  if (
    !studentDoc.exists ||
    !student ||
    String(student.studentId || '').toUpperCase() !== session.studentId ||
    student.status !== 'active'
  ) {
    return { ok: false, status: 403, message: 'Student record could not be verified.' }
  }

  const classLevel = String(student.classLevel || '')
  const category = String(student.category || 'General')

  const examSnapshot = await adminDb
    .collection('exams')
    .where('classLevel', '==', classLevel)
    .where('category', '==', category)
    .get()

  if (examSnapshot.empty) {
    return { ok: false, status: 404, message: 'No exam is available for your class.' }
  }

  // Stable choice if more than one exam exists for the same class and category
  const examDoc = [...examSnapshot.docs].sort((a, b) => a.id.localeCompare(b.id))[0]

  return { ok: true, student, examId: examDoc.id, exam: examDoc.data() }
}

export interface FinalResult {
  id: string
  score: number
  total: number
  submittedAt: string
  alreadySubmitted: boolean
}

function fromStored(id: string, r: Record<string, unknown>): FinalResult {
  return {
    id,
    score: Number(r.score) || 0,
    total: Number(r.total) || 0,
    submittedAt: String(r.submittedAt || ''),
    alreadySubmitted: true,
  }
}

/**
 * Marks the answers on the server and saves ONE result per student per exam.
 * Safe to call twice: the second call returns the stored result.
 * Throws Error('NO_QUESTIONS') if the exam has no valid questions.
 */
export async function finalizeAttempt(params: {
  studentId: string
  firestoreId: string
  examId: string
  student: Record<string, unknown>
  exam: Record<string, unknown>
  answers: Record<string, unknown>
}): Promise<FinalResult> {
  const { studentId, firestoreId, examId, student, exam, answers } = params
  const id = attemptIdFor(examId, studentId)
  const resultRef = adminDb.collection('results').doc(id)

  const existing = await resultRef.get()
  if (existing.exists) return fromStored(id, existing.data() ?? {})

  const questions = await getExamQuestions(examId, Number(exam.numQuestions) || 0)
  if (questions.length === 0) throw new Error('NO_QUESTIONS')

  const cleanAnswers: Record<string, string> = {}
  let score = 0

  for (const question of questions) {
    const answer = answers[question.id]
    if (typeof answer === 'string' && ['A', 'B', 'C', 'D'].includes(answer)) {
      cleanAnswers[question.id] = answer
      if (answer === question.correct) score += 1
    }
  }

  const now = new Date()
  const record = {
    studentId,
    firestoreId,
    studentName: String(student.name || ''),
    examId,
    subject: String(exam.subject || ''),
    classLevel: String(student.classLevel || ''),
    category: String(student.category || 'General'),
    score,
    total: questions.length,
    answers: cleanAnswers,
    submittedAt: formatSubmittedAt(now),
    submittedAtISO: now.toISOString(),
  }

  try {
    // create() fails if the document exists, so nothing can overwrite a result
    await resultRef.create(record)
  } catch (error) {
    if (isAlreadyExists(error)) {
      const stored = await resultRef.get()
      return fromStored(id, stored.data() ?? {})
    }
    throw error
  }

  await adminDb
    .collection('attempts')
    .doc(id)
    .set(
      { status: 'submitted', submittedAtISO: now.toISOString(), answers: cleanAnswers },
      { merge: true }
    )

  return {
    id,
    score,
    total: questions.length,
    submittedAt: record.submittedAt,
    alreadySubmitted: false,
  }
}
