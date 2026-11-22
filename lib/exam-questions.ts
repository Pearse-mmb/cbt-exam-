import { adminDb } from '@/lib/firebase-admin'

export interface StoredQuestion {
  id: string
  examId: string
  text: string
  optionA: string
  optionB: string
  optionC: string
  optionD: string
  correct: 'A' | 'B' | 'C' | 'D'
}

const isText = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0

export async function getExamQuestions(
  examId: string,
  numQuestions: number
): Promise<StoredQuestion[]> {
  const snapshot = await adminDb
    .collection('questions')
    .where('examId', '==', examId)
    .get()

  const questions: StoredQuestion[] = []

  for (const document of snapshot.docs) {
    const q = document.data()
    if (
      isText(q.text) &&
      isText(q.optionA) &&
      isText(q.optionB) &&
      isText(q.optionC) &&
      isText(q.optionD) &&
      ['A', 'B', 'C', 'D'].includes(q.correct)
    ) {
      questions.push({
        id: document.id,
        examId,
        text: q.text,
        optionA: q.optionA,
        optionB: q.optionB,
        optionC: q.optionC,
        optionD: q.optionD,
        correct: q.correct,
      })
    }
  }

  questions.sort((a, b) => a.id.localeCompare(b.id))

  return numQuestions > 0 ? questions.slice(0, numQuestions) : questions
}