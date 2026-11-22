'use client'
import { useState, useEffect, useRef, useCallback } from 'react'
import Image from 'next/image'
import {
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth, db } from '@/lib/firebase'

import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  setDoc,
} from 'firebase/firestore'
const SCHOOL = {
  name: 'DOTAYIB Royal College',
  location: 'Oke-Oko',
  motto: 'Learning with Passion, Leading with Purpose',
  email: 'Dotayibroyal@gmail.com',
  address: '15/17, Ewejobi Street, Oke-Oko, Ijeja Gasline-Adiyan, Agbado Railway Station, Ifo LGA',
}

/* ═══════════════════════════════════════════════════════════════
   TYPES
═══════════════════════════════════════════════════════════════ */

interface Student {
  id: string
  firestoreId: string
  name: string
  surname: string
  firstName: string
  otherNames: string
  classLevel: string
  category: string
  lin: string
  createdAt?: string
}

interface Exam {
  id: string
  subject: string
  classLevel: string
  category: string
  duration: number // minutes
  numQuestions: number
}

interface Question {
  id: string
  examId: string
  text: string
  optionA: string
  optionB: string
  optionC: string
  optionD: string
  correct: 'A' | 'B' | 'C' | 'D'
}

interface Result {
  id: string
  studentId: string
  studentName: string
  examId: string
  subject: string
  classLevel: string
  score: number
  total: number
  submittedAt: string
}

/** Question as sent to the student's browser. Never includes the correct answer. */
interface StudentQuestion {
  id: string
  examId: string
  text: string
  optionA: string
  optionB: string
  optionC: string
  optionD: string
}

const OPTION_KEYS = {
  A: 'optionA',
  B: 'optionB',
  C: 'optionC',
  D: 'optionD',
} as const

interface ExamProblem {
  title: string
  detail: string
  retryable: boolean
}

interface ExamResume {
  remainingSeconds: number
}

interface ExamSession {
  remainingSeconds: number
  answers: Record<string, string>
}

type ExamLoadResult =
  | { status: 'ready'; exam: Exam; questions: StudentQuestion[]; resume: ExamResume | null }
  | { status: 'no-exam' }
  | { status: 'no-questions'; exam: Exam }
  | { status: 'blocked'; message: string }
  | { status: 'error'; message: string }

interface ExamsApiResponse {
  success?: boolean
  message?: string
  exam?: Partial<Exam> | null
  questions?: Partial<StudentQuestion>[]
  attempt?: { inProgress?: boolean; remainingSeconds?: number }
}

function authHeaders(token: string) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
}

/* ═══════════════════════════════════════════════════════════════
   HELPERS
═══════════════════════════════════════════════════════════════ */

function fmtTime(s: number) {
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
}

function letterGrade(score: number, total: number) {
  const p = (score / total) * 100
  return p >= 70 ? 'A' : p >= 60 ? 'B' : p >= 50 ? 'C' : p >= 40 ? 'D' : 'F'
}

/**
 * Loads the student's real exam and questions from Firestore via /api/exams.
 * The signed login token tells the server who the student is.
 * Never throws: always resolves to a status the caller can act on.
 */
async function findExam(student: Student, token: string): Promise<ExamLoadResult> {
  try {
    const response = await fetch('/api/exams', {
      method: 'POST',
      headers: authHeaders(token),
      body: JSON.stringify({}),
    })

    const text = await response.text()
    let data: ExamsApiResponse | null = null
    try {
      data = text ? (JSON.parse(text) as ExamsApiResponse) : null
    } catch {
      data = null
    }

    if (response.status === 404) return { status: 'no-exam' }

    if (response.status === 401 || response.status === 409) {
      return {
        status: 'blocked',
        message:
          data?.message ||
          (response.status === 401
            ? 'Your session has expired. Please log in again.'
            : 'You cannot take this examination.'),
      }
    }

    if (!response.ok || !data?.success) {
      return {
        status: 'error',
        message: data?.message || `Unable to load your examination (HTTP ${response.status}).`,
      }
    }

    if (!data.exam || !data.exam.id) return { status: 'no-exam' }

    const exam: Exam = {
      id: String(data.exam.id),
      subject: String(data.exam.subject || ''),
      classLevel: String(data.exam.classLevel || student.classLevel),
      category: String(data.exam.category || student.category),
      duration: Number(data.exam.duration) || 0,
      numQuestions: Number(data.exam.numQuestions) || 0,
    }

    if (!exam.subject || exam.duration <= 0) {
      return {
        status: 'error',
        message: 'This examination is not configured correctly. Please contact your teacher.',
      }
    }

    // Copy only the allowed fields so a stray `correct` field can never reach the exam screen
    const questions: StudentQuestion[] = (Array.isArray(data.questions) ? data.questions : [])
      .filter(q => q && q.id && q.text && q.optionA && q.optionB && q.optionC && q.optionD)
      .map(q => ({
        id: String(q.id),
        examId: String(q.examId || exam.id),
        text: String(q.text),
        optionA: String(q.optionA),
        optionB: String(q.optionB),
        optionC: String(q.optionC),
        optionD: String(q.optionD),
      }))

    const limit = exam.numQuestions > 0 ? exam.numQuestions : questions.length
    const finalQuestions = questions.slice(0, limit)

    if (finalQuestions.length === 0) return { status: 'no-questions', exam }

    const remaining = Math.floor(Number(data.attempt?.remainingSeconds) || 0)
    const resume: ExamResume | null =
      data.attempt?.inProgress && remaining > 0 ? { remainingSeconds: remaining } : null

    // Keep "x of N" counters in the exam UI consistent with what was actually loaded
    return {
      status: 'ready',
      exam: { ...exam, numQuestions: finalQuestions.length },
      questions: finalQuestions,
      resume,
    }
  } catch (error) {
    console.error('Failed to load examination:', error)
    return {
      status: 'error',
      message: 'Network error while loading your examination. Check your connection and try again.',
    }
  }
}

/** Loads real exam results through the staff-only API. Never throws. */
async function fetchAdminResults(): Promise<{ results: Result[]; error: string }> {
  try {
    const user = auth.currentUser
    if (!user) {
      return { results: [], error: 'Your session has expired. Please log in again.' }
    }

    const token = await user.getIdToken()
    const response = await fetch('/api/admin/results', {
      headers: { Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })

    const data = await response.json().catch(() => null)

    if (!response.ok || !data?.success) {
      return {
        results: [],
        error: data?.message || `Unable to load results (HTTP ${response.status}).`,
      }
    }

    return { results: Array.isArray(data.results) ? (data.results as Result[]) : [], error: '' }
  } catch (error) {
    console.error('Failed to load results:', error)
    return { results: [], error: 'Network error while loading results.' }
  }
}

/* ═══════════════════════════════════════════════════════════════
   BASE UI COMPONENTS
═══════════════════════════════════════════════════════════════ */

function Input({ className = '', ...p }: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...p}
      className={`w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 focus:border-transparent ${className}`}
    />
  )
}

function SelectField({
  className = '',
  children,
  ...p
}: React.SelectHTMLAttributes<HTMLSelectElement> & { children: React.ReactNode }) {
  return (
    <select
      {...p}
      className={`w-full border border-gray-300 rounded px-3 py-2 text-sm bg-white focus:outline-none focus:ring-2 focus:ring-green-600 ${className}`}
    >
      {children}
    </select>
  )
}

function Btn({
  variant = 'primary',
  size = 'md',
  className = '',
  children,
  ...p
}: {
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost'
  size?: 'sm' | 'md' | 'lg'
  className?: string
  children: React.ReactNode
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const v = {
    primary: 'bg-green-700 text-white hover:bg-green-800 disabled:bg-gray-200 disabled:text-gray-400 disabled:cursor-not-allowed',
    secondary: 'bg-white text-gray-700 border border-gray-300 hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed',
    danger: 'bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-not-allowed',
    ghost: 'text-green-700 hover:bg-green-50',
  }[variant]
  const s = { sm: 'px-3 py-1.5 text-xs', md: 'px-4 py-2 text-sm', lg: 'px-5 py-2.5 text-sm' }[size]
  return (
    <button {...p} className={`font-semibold rounded transition-colors ${v} ${s} ${className}`}>
      {children}
    </button>
  )
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
      {children}
    </label>
  )
}

function TopBar({
  title,
  subtitle,
  onBack,
  right,
}: {
  title: string
  subtitle?: string
  onBack?: () => void
  right?: React.ReactNode
}) {
  return (
    <div className="bg-green-700 text-white px-5 py-3.5 flex items-center justify-between shrink-0">
      <div className="flex items-center gap-3">
        {onBack && (
          <button onClick={onBack} className="text-green-200 hover:text-white text-sm mr-1">
            ←
          </button>
        )}
        <div className="w-8 h-8 bg-white rounded flex items-center justify-center shrink-0">
          <span className="text-green-700 font-black text-sm">N</span>
        </div>
        <div>
          <p className="font-bold text-sm leading-tight">{title}</p>
          {subtitle && <p className="text-green-200 text-xs leading-tight">{subtitle}</p>}
        </div>
      </div>
      {right}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   PORTAL HOME
═══════════════════════════════════════════════════════════════ */

function PortalHome({ onSelect }: { onSelect: (p: 'student' | 'admin') => void }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <div className="bg-green-700 text-white px-6 py-4">
        <div className="max-w-4xl mx-auto flex items-center gap-3">
          <div className="w-11 h-11 bg-white rounded flex items-center justify-center shrink-0 overflow-hidden">
            <Image
              src="/images/logo.jpeg"
              alt="DOTAYIB Royal College Logo"
              width={44}
              height={44}
              className="object-contain"
            />
          </div>
          <div>
            <h1 className="font-bold text-lg leading-tight">DOTAYIB Royal College</h1>
            <p className="text-green-200 text-xs">Computer-Based Test Portal</p>
          </div>
        </div>
      </div>

      <div className="flex-1 flex items-center justify-center p-8">
        <div className="w-full max-w-md">
          <div className="text-center mb-8">
            <h2 className="text-2xl font-bold text-gray-800 mb-1">Welcome</h2>
            <p className="text-gray-500 text-sm">Select your portal to continue</p>
          </div>

          <div className="grid grid-cols-2 gap-5">
            <button
              onClick={() => onSelect('student')}
              className="bg-white border-2 border-gray-200 rounded-xl p-8 text-center hover:border-green-500 hover:shadow-md transition-all group cursor-pointer"
            >
              <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:bg-green-100 transition-colors">
                <svg className="w-7 h-7 text-green-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                </svg>
              </div>
              <h3 className="font-bold text-gray-800 mb-1">Student</h3>
              <p className="text-gray-400 text-xs">Take your exam</p>
            </button>

            <button
              onClick={() => onSelect('admin')}
              className="bg-white border-2 border-gray-200 rounded-xl p-8 text-center hover:border-green-500 hover:shadow-md transition-all group cursor-pointer"
            >
              <div className="w-14 h-14 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-4 group-hover:bg-green-100 transition-colors">
                <svg className="w-7 h-7 text-green-700" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <h3 className="font-bold text-gray-800 mb-1">Admin / Teacher</h3>
              <p className="text-gray-400 text-xs">Manage exams</p>
            </button>
          </div>
        </div>
      </div>

      <div className="text-center py-3 text-xs text-gray-400 border-t border-gray-200">
        CBT Portal &copy; {new Date().getFullYear()} —  DOTAYIB Royal College
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   STUDENT: LOGIN
═══════════════════════════════════════════════════════════════ */

function StudentLogin({
  onLogin,
  onBack,
}: {
  onLogin: (s: Student, token: string) => void | Promise<void>
  onBack: () => void
}) {
  const [classLevel, setClassLevel] = useState('JSS1')
  const [category, setCategory] = useState('General')
  const [pw, setPw] = useState('')
  const [studentId, setStudentId] = useState('')
  const [loading, setLoading] = useState(false)
  const [phase, setPhase] = useState<'verifying' | 'loading-exam'>('verifying')
  const [err, setErr] = useState('')

  const isSenior = classLevel.startsWith('SS')
  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (loading) return

    setErr('')
    setLoading(true)
    setPhase('verifying')

    try {
      const enteredId = studentId.trim().toUpperCase()
      if (!enteredId) {
        setErr('Enter your Student ID.')
        return
      }

      const response = await fetch('/api/students/lookup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          studentId: enteredId,
          classLevel,
          category: isSenior ? category : 'General',
          password: pw,
        }),
      })

      const responseText = await response.text()

      let result
      try {
        result = JSON.parse(responseText)
      } catch {
        throw new Error('Server did not return valid JSON. Check the terminal.')
      }

      if (!response.ok || !result.success || !result.student) {
        setErr(result.message || result.error || 'Unable to verify your Student ID.')
        return
      }

      const data = result.student
      const token = String(result.token || '')

      if (!token) {
        setErr('Login worked but no exam session was issued. Ask the administrator to check the server settings.')
        return
      }

      // Wait for the real exam to be loaded before leaving the login screen
      setPhase('loading-exam')
      await onLogin({
        id: String(data.studentId),
        firestoreId: String(data.firestoreId),
        name: String(data.name || ''),
        surname: String(data.surname || ''),
        firstName: String(data.firstName || ''),
        otherNames: String(data.otherNames || ''),
        classLevel: String(data.classLevel || ''),
        category: String(data.category || 'General'),
        lin: String(data.lin || ''),
      }, token)
    } catch (error) {
      console.error('Student lookup failed:', error)
      setErr('Unable to verify your Student ID. Please try again.')
    } finally {
      setLoading(false)
      setPhase('verifying')
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <TopBar
        title="DOTAYIB Royal College"
        subtitle="Student Examination Portal"
        onBack={onBack}
      />

      <div className="flex-1 flex items-center justify-center p-6">
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-8 w-full max-w-sm">
          <h2 className="text-xl font-bold text-gray-800 mb-1">
            Student Login
          </h2>

          <p className="text-gray-500 text-sm mb-6">
            Select your class and enter the examination password.
          </p>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">
              {err}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">
            <div>
              <FieldLabel>Class</FieldLabel>
              <SelectField
                value={classLevel}
                disabled={loading}
                onChange={e => {
                  setClassLevel(e.target.value)
                  setPw('')
                  setErr('')
                  setCategory('Science')
                }}
              >
                {['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'].map(c => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </SelectField>
            </div>

            {isSenior && (
              <div>
                <FieldLabel>Department</FieldLabel>
                <SelectField
                  value={category}
                  disabled={loading}
                  onChange={e => {
                    setCategory(e.target.value)
                    setPw('')
                    setErr('')
                  }}
                >
                  <option value="Science">Science</option>
                  <option value="Arts">Humanities</option>
                  <option value="Commercial">Business / Commercial</option>
                </SelectField>
              </div>
            )}

            <div>
              <FieldLabel>Personal Student ID</FieldLabel>
              <Input
                type="text"
                placeholder="e.g. DRC-0001"
                value={studentId}
                onChange={e => setStudentId(e.target.value.toUpperCase())}
                required
                disabled={loading}
              />
            </div>

            <div>
              <FieldLabel>Class Examination Password</FieldLabel>
              <Input
                type="password"
                placeholder="Enter class password"
                value={pw}
                onChange={e => setPw(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <Btn type="submit" size="lg" className="w-full" disabled={loading}>
              {loading
                ? phase === 'loading-exam'
                  ? 'Loading your examination...'
                  : 'Verifying student...'
                : 'Continue to Examination'}
            </Btn>
          </form>

          <p className="text-xs text-gray-400 mt-5 text-center">
            {SCHOOL.name} • Oke-Oko
          </p>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   STUDENT: INSTRUCTIONS
═══════════════════════════════════════════════════════════════ */

function ExamInstructions({
  student,
  exam,
  problem,
  resume,
  onStart,
  onRetry,
  onLogout,
}: {
  student: Student
  exam: Exam | null
  problem: ExamProblem | null
  resume: ExamResume | null
  onStart: () => Promise<void>
  onRetry: () => void
  onLogout: () => void
}) {
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState('')

  const start = async () => {
    if (starting) return
    setStarting(true)
    setStartError('')
    try {
      await onStart()
    } catch (error) {
      setStartError(
        error instanceof Error ? error.message : 'Unable to start the examination. Please try again.'
      )
    } finally {
      setStarting(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <TopBar
        title="Student Portal"
        subtitle="DOTAYIB Royal College"
        right={
          <button onClick={onLogout} className="text-green-200 hover:text-white text-sm">
            Logout
          </button>
        }
      />

      <div className="flex-1 flex items-center justify-center p-6">
        {!exam ? (
          <div className="text-center max-w-sm">
            <div className="w-14 h-14 bg-amber-100 rounded-full flex items-center justify-center mx-auto mb-4">
              <svg className="w-7 h-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-gray-800 mb-2">{problem?.title || 'No Active Exam'}</h2>
            <p className="text-gray-500 text-sm mb-5">
              {problem?.detail ||
                `There is no active exam scheduled for ${student.classLevel} (${student.category}) at this time.`}
            </p>
            <div className="flex justify-center gap-3">
              {problem?.retryable && <Btn onClick={onRetry}>Try Again</Btn>}
              <Btn variant="secondary" onClick={onLogout}>Logout</Btn>
            </div>
          </div>
        ) : (
          <div className="bg-white border border-gray-200 rounded-lg shadow-sm w-full max-w-2xl">
            <div className="bg-green-700 text-white rounded-t-lg px-6 py-5">
              <h2 className="font-bold text-xl">{exam.subject}</h2>
              <p className="text-green-200 text-sm mt-0.5">Examination Instructions</p>
            </div>

            <div className="p-6">
              {resume && (
                <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded px-4 py-3 mb-5">
                  <p className="font-semibold">You have an exam in progress.</p>
                  <p className="mt-0.5">
                    Time remaining: <strong>{fmtTime(resume.remainingSeconds)}</strong>. Your saved
                    answers will be restored when you resume. The timer kept running while you were away.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-3 gap-3 mb-6">
                {[
                  ['Student Name', student.name],
                  ['Student ID', student.id],
                  ['Class', student.classLevel],
                  ['Category', student.category],
                  ['Subject', exam.subject],
                  ['Duration', `${exam.duration} Minutes`],
                  ['Total Questions', `${exam.numQuestions} Questions`],
                ].map(([k, v]) => (
                  <div key={k} className="p-3 bg-gray-50 border border-gray-100 rounded">
                    <p className="text-xs text-gray-400 uppercase font-medium mb-0.5">{k}</p>
                    <p className="font-semibold text-gray-800 text-sm">{v}</p>
                  </div>
                ))}
              </div>

              <div className="mb-6">
                <h3 className="font-bold text-gray-800 text-sm mb-3 uppercase tracking-wide">Examination Rules</h3>
                <ol className="space-y-2">
                  {[
                    'The exam begins immediately when you click "Start Exam". The countdown timer starts automatically.',
                    `You have ${exam.duration} minutes to answer all ${exam.numQuestions} questions.`,
                    'Each question has exactly one correct answer: A, B, C, or D.',
                    'Use the Previous/Next buttons or the numbered question panel to navigate.',
                    'Answered questions appear in green in the question panel on the right.',
                    'You may change your answer at any time before final submission.',
                    'Your answers are saved automatically. If the page refreshes or the computer restarts, log in again and click "Resume Exam". The timer does not stop.',
                    'The exam submits automatically when the timer reaches zero.',
                  ].map((rule, i) => (
                    <li key={i} className="flex gap-2.5 text-sm text-gray-600">
                      <span className="text-green-700 font-bold shrink-0 w-5">{i + 1}.</span>
                      {rule}
                    </li>
                  ))}
                </ol>
              </div>

              {startError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">
                  {startError}
                </div>
              )}

              <Btn size="lg" onClick={() => void start()} disabled={starting} className="w-full">
                {starting ? 'Starting...' : resume ? 'Resume Exam →' : 'Start Exam →'}
              </Btn>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   STUDENT: EXAM SCREEN
═══════════════════════════════════════════════════════════════ */

function ExamScreen({
  student,
  exam,
  questions,
  initialRemaining,
  initialAnswers,
  onSaveAnswers,
  onSubmit,
}: {
  student: Student
  exam: Exam
  questions: StudentQuestion[]
  initialRemaining: number
  initialAnswers: Record<string, string>
  onSaveAnswers: (answers: Record<string, string>) => Promise<void>
  onSubmit: (answers: Record<string, string>) => void | Promise<void>
}) {
  const [idx, setIdx] = useState(0)
  const [answers, setAnswers] = useState<Record<string, string>>(initialAnswers)
  const [timeLeft, setTimeLeft] = useState(initialRemaining)
  const [showConfirm, setShowConfirm] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')

  // Refs so timer / autosave / submit callbacks always read the latest values
  const answersRef = useRef<Record<string, string>>(initialAnswers)
  const dirtyRef = useRef(false)
  const savingRef = useRef(false)
  const submittedRef = useRef(false)
  const endTimeRef = useRef(0)
  const onSubmitRef = useRef(onSubmit)
  const onSaveRef = useRef(onSaveAnswers)

  useEffect(() => {
    onSubmitRef.current = onSubmit
    onSaveRef.current = onSaveAnswers
  }, [onSubmit, onSaveAnswers])

  const handleAnswer = (questionId: string, letter: string) => {
    const updated = { ...answersRef.current, [questionId]: letter }
    answersRef.current = updated
    dirtyRef.current = true
    setAnswers(updated)
  }

  const doSubmit = useCallback(async () => {
    if (submittedRef.current) return
    submittedRef.current = true
    setSubmitting(true)
    setSubmitError('')
    try {
      await onSubmitRef.current(answersRef.current)
      // On success the parent switches to the "completed" view and unmounts this screen
    } catch (error) {
      // Allow the student to retry without losing any answers
      submittedRef.current = false
      setSubmitting(false)
      setShowConfirm(true)
      setSubmitError(
        error instanceof Error ? error.message : 'Submission failed. Please try again.'
      )
    }
  }, [])

  // Countdown based on a fixed end time (stays accurate even if the tab is in the background).
  // State is only set inside the interval callback, never synchronously in the effect body.
  useEffect(() => {
    endTimeRef.current = Date.now() + initialRemaining * 1000
    const id = setInterval(() => {
      const remaining = Math.max(0, Math.ceil((endTimeRef.current - Date.now()) / 1000))
      setTimeLeft(remaining)
      if (remaining === 0) {
        clearInterval(id)
        void doSubmit()
      }
    }, 1000)
    return () => clearInterval(id)
  }, [initialRemaining, doSubmit])

  // Autosave: every 3 seconds, send the answers to the server if anything changed
  useEffect(() => {
    const id = setInterval(() => {
      if (savingRef.current || !dirtyRef.current || submittedRef.current) return
      savingRef.current = true
      dirtyRef.current = false
      setSaveState('saving')
      onSaveRef
        .current(answersRef.current)
        .then(() => setSaveState('saved'))
        .catch(() => {
          dirtyRef.current = true
          setSaveState('error')
        })
        .finally(() => {
          savingRef.current = false
        })
    }, 3000)
    return () => clearInterval(id)
  }, [])

  const q = questions[idx]
  const answeredCount = Object.keys(answers).length
  const timerUrgent = timeLeft < 300
  const timerWarning = timeLeft < 600
  const totalQuestions = questions.length

  const saveLabel =
    saveState === 'saving'
      ? 'Saving...'
      : saveState === 'saved'
      ? 'Saved ✓'
      : saveState === 'error'
      ? 'Not saved - check connection'
      : 'Answers save automatically'

  return (
    <div className="h-screen flex flex-col overflow-hidden bg-gray-100">
      {/* Top bar */}
      <div className="bg-green-700 text-white px-5 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="w-7 h-7 bg-white rounded flex items-center justify-center shrink-0">
            <span className="text-green-700 font-black text-xs">N</span>
          </div>
          <span className="font-bold text-sm">{exam.subject}</span>
          <span className="text-green-300 mx-1">|</span>
          <span className="text-green-200 text-xs">{student.name} &bull; {student.classLevel}</span>
        </div>
        <Btn variant="danger" size="sm" disabled={submitting} onClick={() => setShowConfirm(true)}>
          Submit Exam
        </Btn>
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0">
        {/* Question area */}
        <div className="flex-1 overflow-y-auto p-5">
          <div className="bg-white border border-gray-200 rounded-lg h-full flex flex-col p-6">
            {/* Header */}
            <div className="flex items-center justify-between mb-5 pb-4 border-b border-gray-100">
              <p className="text-sm text-gray-500 font-medium">
                Question{' '}
                <span className="text-green-700 font-bold text-lg">{idx + 1}</span>
                <span className="text-gray-300"> / {totalQuestions}</span>
              </p>
              <div className="flex items-center gap-2">
                <span
                  className={`text-xs ${saveState === 'error' ? 'text-red-600 font-semibold' : 'text-gray-400'}`}
                >
                  {saveLabel}
                </span>
                <span className="text-xs text-gray-400 bg-gray-100 px-2.5 py-1 rounded-full">
                  {answeredCount} of {totalQuestions} answered
                </span>
              </div>
            </div>

            {/* Question text */}
            <p className="text-gray-800 font-semibold text-base mb-6 leading-relaxed">{q.text}</p>

            {/* Options */}
            <div className="space-y-2.5">
              {(['A', 'B', 'C', 'D'] as const).map(letter => {
                const val = q[OPTION_KEYS[letter]]
                const selected = answers[q.id] === letter
                return (
                  <button
                    key={letter}
                    onClick={() => handleAnswer(q.id, letter)}
                    className={`w-full text-left flex items-center gap-3 px-4 py-3 rounded-lg border-2 transition-all ${
                      selected
                        ? 'bg-green-700 border-green-700 text-white'
                        : 'bg-white border-gray-200 text-gray-700 hover:border-green-400 hover:bg-green-50'
                    }`}
                  >
                    <span
                      className={`w-8 h-8 rounded-full border-2 flex items-center justify-center text-xs font-bold shrink-0 ${
                        selected ? 'border-white/60 text-white' : 'border-gray-300 text-gray-500'
                      }`}
                    >
                      {letter}
                    </span>
                    <span className="text-sm">{val}</span>
                  </button>
                )
              })}
            </div>

            {/* Navigation */}
            <div className="flex justify-between mt-auto pt-6 border-t border-gray-100">
              <Btn variant="secondary" disabled={idx === 0} onClick={() => setIdx(i => i - 1)}>
                ← Previous
              </Btn>
              {idx < questions.length - 1 ? (
                <Btn variant="secondary" onClick={() => setIdx(i => i + 1)}>
                  Next →
                </Btn>
              ) : (
                <Btn disabled={submitting} onClick={() => setShowConfirm(true)}>Finish →</Btn>
              )}
            </div>
          </div>
        </div>

        {/* Right sidebar */}
        <div className="w-56 bg-white border-l border-gray-200 flex flex-col shrink-0">
          {/* Timer */}
          <div className={`p-4 border-b border-gray-200 ${timerUrgent ? 'bg-red-50' : ''}`}>
            <p className="text-xs text-gray-500 uppercase font-semibold mb-1">Time Remaining</p>
            <p
              className={`text-2xl font-mono font-bold tabular-nums tracking-tight ${
                timerUrgent ? 'text-red-600' : timerWarning ? 'text-amber-600' : 'text-gray-800'
              }`}
            >
              {fmtTime(timeLeft)}
            </p>
            {timerUrgent && (
              <p className="text-xs text-red-500 font-semibold mt-1">Less than 5 minutes!</p>
            )}
          </div>

          {/* Legend */}
          <div className="px-3 py-2.5 border-b border-gray-100 flex items-center gap-3 text-xs text-gray-400">
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-green-700 inline-block" />
              Current
            </span>
            <span className="flex items-center gap-1.5">
              <span className="w-3 h-3 rounded bg-green-100 border border-green-300 inline-block" />
              Answered
            </span>
          </div>

          {/* Question grid */}
          <div className="flex-1 overflow-y-auto p-2.5">
            <div className="grid grid-cols-6 gap-1">
              {questions.map((qs, i) => {
                const isAnswered = !!answers[qs.id]
                const isCurrent = i === idx
                return (
                  <button
                    key={qs.id}
                    onClick={() => setIdx(i)}
                    title={`Question ${i + 1}`}
                    className={`aspect-square text-xs font-bold rounded transition-colors ${
                      isCurrent
                        ? 'bg-green-700 text-white'
                        : isAnswered
                        ? 'bg-green-100 text-green-800 border border-green-300'
                        : 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    }`}
                  >
                    {i + 1}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Submit confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg p-6 max-w-sm w-full shadow-xl">
            <h3 className="font-bold text-gray-800 text-lg mb-3">Submit Examination?</h3>
            <p className="text-sm text-gray-600">
              You have answered{' '}
              <strong className="text-green-700">{answeredCount}</strong> of{' '}
              <strong>{totalQuestions}</strong> questions.
            </p>
            {answeredCount < totalQuestions && (
              <p className="text-sm text-amber-600 mt-2">
                {totalQuestions - answeredCount} question(s) remain unanswered.
              </p>
            )}
            <p className="text-sm text-gray-400 mt-2">Once submitted, you cannot make any changes.</p>
            {submitError && <p className="text-sm text-red-600 mt-2">{submitError}</p>}
            <div className="flex gap-3 mt-5">
              {timeLeft > 0 && (
                <Btn
                  variant="secondary"
                  className="flex-1"
                  disabled={submitting}
                  onClick={() => setShowConfirm(false)}
                >
                  Cancel
                </Btn>
              )}
              <Btn className="flex-1" disabled={submitting} onClick={() => void doSubmit()}>
                {submitting ? 'Submitting...' : submitError ? 'Retry Submit' : 'Submit'}
              </Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   STUDENT: COMPLETED
═══════════════════════════════════════════════════════════════ */

function ExamCompleted({
  student,
  exam,
  result,
  onLogout,
}: {
  student: Student
  exam: Exam
  result: Result
  onLogout: () => void
}) {
  const pct = result.total > 0 ? Math.round((result.score / result.total) * 100) : 0
  const g = letterGrade(result.score, result.total)
  const gradeColor =
    g === 'A'
      ? 'bg-green-100 text-green-800'
      : g === 'B'
      ? 'bg-blue-100 text-blue-800'
      : g === 'C'
      ? 'bg-yellow-100 text-yellow-800'
      : g === 'D'
      ? 'bg-orange-100 text-orange-800'
      : 'bg-red-100 text-red-800'

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <TopBar title="Student Portal" subtitle="DOTAYIB Royal College" />
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm w-full max-w-sm">
          <div className="bg-green-700 text-white rounded-t-lg px-6 py-6 text-center">
            <div className="w-14 h-14 bg-white/20 rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-7 h-7 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="font-bold text-xl">Exam Submitted!</h2>
            <p className="text-green-200 text-sm mt-0.5">{student.name}</p>
          </div>

          <div className="p-6">
            <div className="text-center p-5 bg-gray-50 border border-gray-200 rounded-lg mb-5">
              <p className="text-xs text-gray-400 uppercase font-semibold mb-1">{exam.subject}</p>
              <p className="text-5xl font-black text-green-700 my-2">
                {result.score}
                <span className="text-2xl text-gray-300 font-normal">/{result.total}</span>
              </p>
              <div className="flex items-center justify-center gap-2 mt-1">
                <span className="text-sm text-gray-600">{pct}%</span>
                <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold ${gradeColor}`}>
                  Grade {g}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2.5 mb-5">
              {[
                ['Student ID', student.id],
                ['Class', student.classLevel],
                ['Submitted', result.submittedAt],
                ['Questions', `${result.total}`],
              ].map(([k, v]) => (
                <div key={k} className="p-3 bg-gray-50 border border-gray-100 rounded">
                  <p className="text-xs text-gray-400">{k}</p>
                  <p className="font-semibold text-gray-800 text-sm mt-0.5">{v}</p>
                </div>
              ))}
            </div>

            <Btn size="lg" className="w-full" onClick={onLogout}>
              Logout
            </Btn>
          </div>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN: LOGIN
═══════════════════════════════════════════════════════════════ */

function AdminLogin({
  onLogin,
  onBack,
}: {
  onLogin: () => void
  onBack: () => void
}) {
  const [email, setEmail] = useState('')
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()

    if (loading) return

    setErr('')
    setLoading(true)

    try {
      // 1. Authenticate the staff member with Firebase
      const credential = await signInWithEmailAndPassword(
        auth,
        email.trim(),
        pw
      )

      // 2. Get the Firebase ID token
      const idToken = await credential.user.getIdToken()

      // 3. Verify staff permissions on the server
      const response = await fetch('/api/admin/verify', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${idToken}`,
        },
      })

      const responseText = await response.text()

      console.log('VERIFY STATUS:', response.status)
      console.log('VERIFY RESPONSE:', responseText)

      const result = responseText
        ? JSON.parse(responseText)
        : {
            success: false,
            message: `Server returned an empty response. HTTP ${response.status}`,
          }

      // 4. Reject accounts without staff permissions
      if (!response.ok || !result.success) {
        await signOut(auth)

        setErr(
          result.message ||
          'You are not authorised to access this portal.'
        )

        return
      }

      // 5. Enter dashboard after successful verification
      onLogin()

    } catch (error: unknown) {
      console.error('Staff login error:', error)

      const firebaseError = error as {
        code?: string
        message?: string
      }

      console.error('Error code:', firebaseError.code)
      console.error('Error message:', firebaseError.message)

      switch (firebaseError.code) {
        case 'auth/invalid-email':
          setErr('Please enter a valid email address.')
          break

        case 'auth/user-not-found':
        case 'auth/wrong-password':
        case 'auth/invalid-credential':
          setErr('Invalid email or password.')
          break

        case 'auth/too-many-requests':
          setErr('Too many attempts. Please try again later.')
          break

        case 'auth/network-request-failed':
          setErr('Network error. Check your internet connection.')
          break

        default:
          setErr(
            `Login error: ${
              firebaseError.code ||
              firebaseError.message ||
              'Unknown error'
            }`
          )
      }

    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <TopBar
        title="Admin / Teacher Portal"
        subtitle="DOTAYIB Royal College"
        onBack={onBack}
      />

      <div className="flex-1 flex items-center justify-center p-8">
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm p-8 w-full max-w-sm">

          <h2 className="text-xl font-bold text-gray-800 mb-1">
            Staff Login
          </h2>

          <p className="text-gray-500 text-sm mb-6">
            Sign in to manage exams and results
          </p>

          {err && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">
              {err}
            </div>
          )}

          <form onSubmit={submit} className="space-y-4">

            <div>
              <FieldLabel>Email Address</FieldLabel>

              <Input
                type="email"
                placeholder="Enter your staff email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <div>
              <FieldLabel>Password</FieldLabel>

              <Input
                type="password"
                placeholder="Enter your password"
                value={pw}
                onChange={e => setPw(e.target.value)}
                required
                disabled={loading}
              />
            </div>

            <Btn
              type="submit"
              size="lg"
              className="w-full"
              disabled={loading}
            >
              {loading ? 'Authenticating...' : 'Login'}
            </Btn>

          </form>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN: EXAM FORM
═══════════════════════════════════════════════════════════════ */

function ExamForm({
  exam,
  onSave,
  onCancel,
}: {
  exam: Exam | null
  onSave: (e: Exam) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState({
    subject: exam?.subject || '',
    classLevel: exam?.classLevel || 'SS1',
    category: exam?.category || 'General',
    duration: exam?.duration || 120,
    numQuestions: exam?.numQuestions || 70,
  })
  const [err, setErr] = useState('')

  const save = () => {
    if (!form.subject.trim()) {
      setErr('Subject is required.')
      return
    }
    onSave({
      id: exam?.id || `EXM${Date.now()}`,
      subject: form.subject.trim(),
      classLevel: form.classLevel,
      category: form.category,
      duration: Number(form.duration),
      numQuestions: Number(form.numQuestions),
    })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-lg">
      <h2 className="font-bold text-gray-800 text-base mb-5">
        {exam ? 'Edit Exam' : 'Add New Exam'}
      </h2>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">
          {err}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <FieldLabel>Subject</FieldLabel>
          <Input
            placeholder="e.g. Mathematics, English Language"
            value={form.subject}
            onChange={e => setForm(f => ({ ...f, subject: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Class</FieldLabel>
            <SelectField
              value={form.classLevel}
              onChange={e => setForm(f => ({ ...f, classLevel: e.target.value }))}
            >
              {['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'].map(c => (
                <option key={c}>{c}</option>
              ))}
            </SelectField>
          </div>
          <div>
            <FieldLabel>Category</FieldLabel>
            <SelectField
              value={form.category}
              onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
            >
              {['General', 'Arts', 'Science', 'Commercial'].map(c => (
                <option key={c}>{c}</option>
              ))}
            </SelectField>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <FieldLabel>Duration (minutes)</FieldLabel>
            <Input
              type="number"
              min={10}
              max={300}
              value={form.duration}
              onChange={e => setForm(f => ({ ...f, duration: +e.target.value }))}
            />
          </div>
          <div>
            <FieldLabel>No. of Questions</FieldLabel>
            <Input
              type="number"
              min={1}
              max={200}
              value={form.numQuestions}
              onChange={e => setForm(f => ({ ...f, numQuestions: +e.target.value }))}
            />
          </div>
        </div>
      </div>

      <div className="flex gap-3 mt-6">
        <Btn variant="secondary" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn onClick={save}>{exam ? 'Save Changes' : 'Add Exam'}</Btn>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN: QUESTION FORM
═══════════════════════════════════════════════════════════════ */

function QuestionForm({
  question,
  exams,
  defaultExamId,
  onSave,
  onCancel,
}: {
  question: Question | null
  exams: Exam[]
  defaultExamId: string
  onSave: (q: Question) => void
  onCancel: () => void
}) {
  const [form, setForm] = useState({
    examId: question?.examId || defaultExamId || exams[0]?.id || '',
    text: question?.text || '',
    optionA: question?.optionA || '',
    optionB: question?.optionB || '',
    optionC: question?.optionC || '',
    optionD: question?.optionD || '',
    correct: (question?.correct || 'A') as 'A' | 'B' | 'C' | 'D',
  })
  const [err, setErr] = useState('')

  const save = () => {
    if (
      !form.text.trim() ||
      !form.optionA.trim() ||
      !form.optionB.trim() ||
      !form.optionC.trim() ||
      !form.optionD.trim()
    ) {
      setErr('All fields are required.')
      return
    }
    onSave({
      id: question?.id || `Q${Date.now()}`,
      examId: form.examId,
      text: form.text.trim(),
      optionA: form.optionA.trim(),
      optionB: form.optionB.trim(),
      optionC: form.optionC.trim(),
      optionD: form.optionD.trim(),
      correct: form.correct,
    })
  }

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-6 max-w-2xl">
      <h2 className="font-bold text-gray-800 text-base mb-5">
        {question ? 'Edit Question' : 'Add Question'}
      </h2>

      {err && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">
          {err}
        </div>
      )}

      <div className="space-y-4">
        <div>
          <FieldLabel>Exam</FieldLabel>
          <SelectField
            value={form.examId}
            onChange={e => setForm(f => ({ ...f, examId: e.target.value }))}
          >
            {exams.map(e => (
              <option key={e.id} value={e.id}>
                {e.subject} — {e.classLevel} ({e.category})
              </option>
            ))}
          </SelectField>
        </div>

        <div>
          <FieldLabel>Question Text</FieldLabel>
          <textarea
            className="w-full border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-green-600 resize-none"
            rows={3}
            placeholder="Enter the question text here..."
            value={form.text}
            onChange={e => setForm(f => ({ ...f, text: e.target.value }))}
          />
        </div>

        <div className="space-y-3">
          <FieldLabel>Options &amp; Correct Answer</FieldLabel>
          {(['A', 'B', 'C', 'D'] as const).map(letter => (
            <div key={letter} className="flex items-center gap-3">
              <span className="w-8 h-8 rounded-full bg-gray-100 text-gray-600 text-xs font-bold flex items-center justify-center shrink-0">
                {letter}
              </span>
              <Input
                placeholder={`Option ${letter}`}
                value={form[OPTION_KEYS[letter]]}
                onChange={e => setForm(f => ({ ...f, [OPTION_KEYS[letter]]: e.target.value }))}
                className="flex-1"
              />
              <label className="flex items-center gap-1.5 text-xs text-gray-600 whitespace-nowrap cursor-pointer">
                <input
                  type="radio"
                  name="correct"
                  value={letter}
                  checked={form.correct === letter}
                  onChange={() => setForm(f => ({ ...f, correct: letter }))}
                  className="accent-green-700"
                />
                Correct
              </label>
            </div>
          ))}
        </div>
      </div>

      <div className="flex gap-3 mt-6">
        <Btn variant="secondary" onClick={onCancel}>
          Cancel
        </Btn>
        <Btn onClick={save}>{question ? 'Save Changes' : 'Add Question'}</Btn>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN: STUDENT MANAGEMENT
═══════════════════════════════════════════════════════════════ */

function StudentManagement({
  students,
  onSave,
  onAssignIds,
  onDelete,
}: {
  students: Student[]
  onSave: (student: Omit<Student, 'id' | 'firestoreId'> & { id?: string; firestoreId?: string }) => Promise<void>
  onAssignIds: () => Promise<void>
  onDelete: (student: Student) => Promise<void>
}) {
  const emptyForm = {
    surname: '',
    firstName: '',
    otherNames: '',
    classLevel: 'JSS1',
    category: 'General',
    lin: '',
  }
  const [form, setForm] = useState(emptyForm)
  const [editing, setEditing] = useState<Student | null>(null)
  const [search, setSearch] = useState('')
  const [saving, setSaving] = useState(false)
  const [assigning, setAssigning] = useState(false)

  const filteredStudents = students
    .filter(student => `${student.name} ${student.id} ${student.classLevel}`.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => a.surname.localeCompare(b.surname) || a.firstName.localeCompare(b.firstName))

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.surname.trim() || !form.firstName.trim()) {
      alert('Surname and first name are required.')
      return
    }

    const name = [form.surname.trim(), form.firstName.trim(), form.otherNames.trim()]
      .filter(Boolean)
      .join(' ')

    setSaving(true)
    try {
      await onSave({
        ...form,
        surname: form.surname.trim(),
        firstName: form.firstName.trim(),
        otherNames: form.otherNames.trim(),
        lin: form.lin.trim(),
        name,
        id: editing?.id,
        firestoreId: editing?.firestoreId,
      })
      setForm(emptyForm)
      setEditing(null)
    } finally {
      setSaving(false)
    }
  }

  const beginEdit = (student: Student) => {
    setEditing(student)
    setForm({
      surname: student.surname,
      firstName: student.firstName,
      otherNames: student.otherNames,
      classLevel: student.classLevel,
      category: student.category,
      lin: student.lin || '',
    })
  }

  const unassignedCount = students.filter(student => !student.id).length

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h2 className="text-lg font-bold text-gray-800">Student Management</h2>
          <p className="text-sm text-gray-500 mt-1">Register students and allocate permanent DRC IDs in surname order.</p>
        </div>
        <Btn
          disabled={unassignedCount === 0 || assigning}
          onClick={async () => {
            setAssigning(true)
            try {
              await onAssignIds()
            } finally {
              setAssigning(false)
            }
          }}
        >
          {assigning ? 'Assigning IDs...' : `Assign IDs alphabetically (${unassignedCount})`}
        </Btn>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg p-5 mb-5">
        <h3 className="font-bold text-gray-800 mb-4">{editing ? `Edit ${editing.id || 'student'}` : 'Register Student'}</h3>
        <form onSubmit={submit} className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <FieldLabel>Surname *</FieldLabel>
            <Input value={form.surname} onChange={e => setForm(f => ({ ...f, surname: e.target.value }))} placeholder="Family name" required />
          </div>
          <div>
            <FieldLabel>First Name *</FieldLabel>
            <Input value={form.firstName} onChange={e => setForm(f => ({ ...f, firstName: e.target.value }))} placeholder="First name" required />
          </div>
          <div>
            <FieldLabel>Other Names</FieldLabel>
            <Input value={form.otherNames} onChange={e => setForm(f => ({ ...f, otherNames: e.target.value }))} placeholder="Middle / other names" />
          </div>
          <div>
            <FieldLabel>Class</FieldLabel>
            <SelectField value={form.classLevel} onChange={e => setForm(f => ({ ...f, classLevel: e.target.value }))}>
              {['JSS1', 'JSS2', 'JSS3', 'SS1', 'SS2', 'SS3'].map(level => <option key={level}>{level}</option>)}
            </SelectField>
          </div>
          <div>
            <FieldLabel>Department / Category</FieldLabel>
            <SelectField value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))}>
              {['General', 'Arts', 'Science', 'Commercial'].map(category => <option key={category}>{category}</option>)}
            </SelectField>
          </div>
          <div>
            <FieldLabel>Ogun State LIN (Optional)</FieldLabel>
            <Input value={form.lin} onChange={e => setForm(f => ({ ...f, lin: e.target.value }))} placeholder="Enter LIN if available" />
          </div>
          <div className="md:col-span-2 flex gap-2">
            <Btn type="submit" disabled={saving}>{saving ? 'Saving...' : editing ? 'Save Student Changes' : 'Add Student'}</Btn>
            {editing && <Btn type="button" variant="secondary" onClick={() => { setEditing(null); setForm(emptyForm) }}>Cancel Edit</Btn>}
          </div>
        </form>
        <p className="text-xs text-gray-400 mt-3">New students are first saved without an ID. When the initial class list is ready, allocate IDs alphabetically. Existing IDs are never changed.</p>
      </div>

      <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
        <div className="p-4 border-b border-gray-200 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-bold text-gray-800">Registered Students ({students.length})</h3>
            <p className="text-xs text-gray-500 mt-1">{students.filter(student => student.id).length} with IDs · {unassignedCount} awaiting ID allocation</p>
          </div>
          <Input className="md:max-w-xs" placeholder="Search name, ID or class..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200">
              <tr>
                {['Student ID', 'Surname', 'First Name', 'Other Names', 'Class', 'LIN', 'Actions'].map(label => (
                  <th key={label} className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase whitespace-nowrap">{label}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filteredStudents.map(student => (
                <tr key={student.firestoreId} className="hover:bg-gray-50">
                  <td className="px-3 py-3 font-mono text-xs font-bold text-green-700">{student.id || 'Pending'}</td>
                  <td className="px-3 py-3 font-medium text-gray-800">{student.surname}</td>
                  <td className="px-3 py-3 text-gray-700">{student.firstName}</td>
                  <td className="px-3 py-3 text-gray-600">{student.otherNames}</td>
                  <td className="px-3 py-3 text-gray-600">{student.classLevel}</td>
                  <td className="px-3 py-3 text-gray-500">{student.lin || '—'}</td>
                  <td className="px-3 py-3">
                    <div className="flex gap-1">
                      <Btn size="sm" variant="secondary" onClick={() => beginEdit(student)}>Edit</Btn>
                      <Btn size="sm" variant="danger" onClick={() => void onDelete(student)}>Delete</Btn>
                    </div>
                  </td>
                </tr>
              ))}
              {filteredStudents.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-gray-400">No students found. Register the first student above.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   ADMIN: DASHBOARD SHELL
═══════════════════════════════════════════════════════════════ */

type AdminView = 'dashboard' | 'students' | 'exams' | 'exam-form' | 'questions' | 'question-form' | 'results'

function AdminDashboard({ onLogout }: { onLogout: () => void }) {
  const [view, setView] = useState<AdminView>('dashboard')
  const [exams, setExams] = useState<Exam[]>([])
  const [questions, setQuestions] = useState<Question[]>([])
  const [students, setStudents] = useState<Student[]>([])
  const [results, setResults] = useState<Result[]>([])
  const [resultsLoading, setResultsLoading] = useState(true)
  const [resultsError, setResultsError] = useState('')
  const [resultsReloadKey, setResultsReloadKey] = useState(0)
  const [selectedExamId, setSelectedExamId] = useState('')
  const [editExam, setEditExam] = useState<Exam | null>(null)
  const [editQuestion, setEditQuestion] = useState<Question | null>(null)

  const activeExam = exams.find(e => e.id === selectedExamId)
  const examQuestions = questions.filter(q => q.examId === selectedExamId)

  const navItems: { id: AdminView; label: string }[] = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'students', label: 'Students' },
    { id: 'exams', label: 'Exams' },
    { id: 'questions', label: 'Questions' },
    { id: 'results', label: 'Results' },
  ]

  useEffect(() => {
    let cancelled = false

    const loadAdminData = async () => {
      try {
        const [examSnapshot, questionSnapshot, studentSnapshot] = await Promise.all([
          getDocs(collection(db, 'exams')),
          getDocs(collection(db, 'questions')),
          getDocs(collection(db, 'students')),
        ])

        const loadedExams = examSnapshot.docs.map(item => ({
          ...item.data(),
          id: item.id,
        })) as Exam[]

        const loadedQuestions = questionSnapshot.docs.map(item => ({
          ...item.data(),
          id: item.id,
        })) as Question[]

        const loadedStudents = studentSnapshot.docs.map(item => {
          const data = item.data()
          return {
            ...data,
            firestoreId: item.id,
            id: String(data.studentId || ''),
          }
        }) as Student[]

        if (!cancelled) {
          setExams(loadedExams)
          setQuestions(loadedQuestions)
          setStudents(loadedStudents)
          setSelectedExamId(current =>
            current && loadedExams.some(exam => exam.id === current)
              ? current
              : loadedExams[0]?.id || ''
          )
        }
      } catch (error) {
        console.error('Failed to load admin data:', error)
        if (!cancelled) {
          alert('Unable to load exams or questions from Firebase. Check your staff access and Firestore rules.')
        }
      }
    }

    void loadAdminData()

    return () => {
      cancelled = true
    }
  }, [])

  // Load real results (state is only set after the request finishes)
  useEffect(() => {
    let cancelled = false

    const run = async () => {
      const outcome = await fetchAdminResults()
      if (cancelled) return
      setResults(outcome.results)
      setResultsError(outcome.error)
      setResultsLoading(false)
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [resultsReloadKey])

  const saveExam = async (saved: Exam) => {
    try {
      await setDoc(doc(db, 'exams', saved.id), {
        subject: saved.subject,
        classLevel: saved.classLevel,
        category: saved.category,
        duration: saved.duration,
        numQuestions: saved.numQuestions,
      })

      setExams(previous =>
        previous.some(exam => exam.id === saved.id)
          ? previous.map(exam => (exam.id === saved.id ? saved : exam))
          : [...previous, saved]
      )
      setSelectedExamId(saved.id)
      setEditExam(null)
      setView('exams')
    } catch (error) {
      console.error('Failed to save exam:', error)
      alert('Unable to save this exam to Firebase. Please check your connection and staff permissions.')
    }
  }

  const deleteExam = async (examId: string) => {
    const confirmed = window.confirm('Delete this exam? This action cannot be undone.')
    if (!confirmed) return

    try {
      await deleteDoc(doc(db, 'exams', examId))
      setExams(previous => previous.filter(exam => exam.id !== examId))
      setSelectedExamId(current => current === examId ? '' : current)
    } catch (error) {
      console.error('Failed to delete exam:', error)
      alert('Unable to delete this exam from Firebase. Please check your staff permissions.')
    }
  }

  const saveQuestion = async (saved: Question) => {
    try {
      await setDoc(doc(db, 'questions', saved.id), {
        examId: saved.examId,
        text: saved.text,
        optionA: saved.optionA,
        optionB: saved.optionB,
        optionC: saved.optionC,
        optionD: saved.optionD,
        correct: saved.correct,
      })

      setQuestions(previous =>
        previous.some(question => question.id === saved.id)
          ? previous.map(question => question.id === saved.id ? saved : question)
          : [...previous, saved]
      )
      setSelectedExamId(saved.examId)
      setEditQuestion(null)
      setView('questions')
    } catch (error) {
      console.error('Failed to save question:', error)
      alert('Unable to save this question to Firebase. Check your connection and staff permissions.')
    }
  }

  const deleteQuestion = async (questionId: string) => {
    const confirmed = window.confirm('Delete this question? This action cannot be undone.')
    if (!confirmed) return

    try {
      await deleteDoc(doc(db, 'questions', questionId))
      setQuestions(previous => previous.filter(question => question.id !== questionId))
    } catch (error) {
      console.error('Failed to delete question:', error)
      alert('Unable to delete this question from Firebase. Check your connection and staff permissions.')
    }
  }

  const saveStudent = async (saved: Omit<Student, 'id' | 'firestoreId'> & { id?: string; firestoreId?: string }) => {
    try {
      const recordId = saved.firestoreId || `STUDENT-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const existing = students.find(student => student.firestoreId === recordId)
      const studentId = existing?.id || saved.id || ''
      const studentData = {
        studentId,
        name: saved.name,
        surname: saved.surname,
        firstName: saved.firstName,
        otherNames: saved.otherNames,
        classLevel: saved.classLevel,
        category: saved.category,
        lin: saved.lin || '',
        status: 'active',
        updatedAt: new Date().toISOString(),
      }

      await setDoc(doc(db, 'students', recordId), {
        ...studentData,
        createdAt: existing?.createdAt || new Date().toISOString(),
      })

      setStudents(previous => {
        const updated = { ...studentData, id: studentId, firestoreId: recordId } as Student
        return existing
          ? previous.map(student => student.firestoreId === recordId ? updated : student)
          : [...previous, updated]
      })
    } catch (error) {
      console.error('Failed to save student:', error)
      alert('Unable to save this student to Firebase. Check your connection and Firestore permissions.')
      throw error
    }
  }

  const assignStudentIds = async () => {
    const unassigned = students
      .filter(student => !student.id)
      .sort((a, b) => a.surname.localeCompare(b.surname) || a.firstName.localeCompare(b.firstName) || a.otherNames.localeCompare(b.otherNames))

    if (unassigned.length === 0) return

    const highestNumber = students.reduce((highest, student) => {
      const match = student.id.match(/^DRC-(\d+)$/i)
      return match ? Math.max(highest, Number(match[1])) : highest
    }, 0)

    try {
      const updates = unassigned.map((student, index) => ({
        ...student,
        id: `DRC-${String(highestNumber + index + 1).padStart(4, '0')}`,
      }))

      for (const student of updates) {
        await setDoc(doc(db, 'students', student.firestoreId), {
          studentId: student.id,
          name: student.name,
          surname: student.surname,
          firstName: student.firstName,
          otherNames: student.otherNames,
          classLevel: student.classLevel,
          category: student.category,
          lin: student.lin || '',
          status: 'active',
          updatedAt: new Date().toISOString(),
        }, { merge: true })
      }

      setStudents(previous => previous.map(student => {
        const updated = updates.find(item => item.firestoreId === student.firestoreId)
        return updated ? { ...student, id: updated.id } : student
      }))
      alert(`${updates.length} Student ID(s) assigned successfully in surname order.`)
    } catch (error) {
      console.error('Failed to assign student IDs:', error)
      alert('Unable to assign Student IDs. Please check Firebase permissions and try again.')
    }
  }

  const deleteStudent = async (student: Student) => {
    if (!window.confirm(`Delete ${student.name} (${student.id || 'ID pending'})? This cannot be undone.`)) return
    try {
      await deleteDoc(doc(db, 'students', student.firestoreId))
      setStudents(previous => previous.filter(item => item.firestoreId !== student.firestoreId))
    } catch (error) {
      console.error('Failed to delete student:', error)
      alert('Unable to delete this student. Check Firebase permissions.')
    }
  }

  const deleteResult = async (r: Result) => {
    if (
      !window.confirm(
        `Delete ${r.studentName}'s ${r.subject} result? The student will be able to take this exam again.`
      )
    ) {
      return
    }
    try {
      const user = auth.currentUser
      if (!user) throw new Error('Your session has expired. Please log in again.')
      const token = await user.getIdToken()
      const response = await fetch('/api/admin/results', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ id: r.id }),
      })
      const data = await response.json().catch(() => null)
      if (!response.ok || !data?.success) {
        throw new Error(data?.message || 'Unable to delete this result.')
      }
      setResults(previous => previous.filter(item => item.id !== r.id))
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Unable to delete this result.')
    }
  }

  const activeNav =
    view === 'exam-form' ? 'exams' : view === 'question-form' ? 'questions' : view

  return (
    <div className="h-screen flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="bg-green-700 text-white px-5 py-3 flex items-center justify-between shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 bg-white rounded flex items-center justify-center shrink-0">
            <span className="text-green-700 font-black text-sm">N</span>
          </div>
          <div>
            <p className="font-bold text-sm leading-tight">DOTAYIB Royal College</p>
            <p className="text-green-200 text-xs">Admin / Teacher Portal</p>
          </div>
        </div>
        <button onClick={onLogout} className="text-green-200 hover:text-white text-sm">
          Logout
        </button>
      </div>

      {/* Main layout */}
      <div className="flex-1 flex min-h-0">
        {/* Sidebar */}
        <div className="w-44 bg-gray-800 flex flex-col shrink-0">
          <nav className="flex-1 py-3">
            {navItems.map(item => (
              <button
                key={item.id}
                onClick={() => setView(item.id)}
                className={`w-full text-left px-5 py-3 text-sm font-medium transition-colors ${
                  activeNav === item.id
                    ? 'bg-green-700 text-white'
                    : 'text-gray-400 hover:bg-gray-700 hover:text-white'
                }`}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="px-5 pb-4 text-xs text-gray-600">v1.0</div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto bg-gray-50 p-6">
          {/* ── DASHBOARD ── */}
          {view === 'dashboard' && (
            <div>
              <h2 className="text-lg font-bold text-gray-800 mb-5">Dashboard</h2>

              <div className="grid grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
                {[
                  { label: 'Total Students', val: students.length, cls: 'bg-amber-50 border-amber-200 text-amber-700' },
                  { label: 'Total Exams', val: exams.length, cls: 'bg-blue-50 border-blue-200 text-blue-700' },
                  { label: 'Total Questions', val: questions.length, cls: 'bg-purple-50 border-purple-200 text-purple-700' },
                  { label: 'Results Recorded', val: results.length, cls: 'bg-green-50 border-green-200 text-green-700' },
                ].map(s => (
                  <div key={s.label} className={`border rounded-lg p-5 ${s.cls}`}>
                    <p className="text-xs font-semibold uppercase tracking-wide mb-1">{s.label}</p>
                    <p className="text-4xl font-black">{s.val}</p>
                  </div>
                ))}
              </div>

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <div className="px-5 py-3 border-b border-gray-200 flex items-center justify-between">
                  <h3 className="font-bold text-gray-700 text-sm">Recent Exams</h3>
                  <Btn
                    size="sm"
                    onClick={() => {
                      setEditExam(null)
                      setView('exam-form')
                    }}
                  >
                    + Add Exam
                  </Btn>
                </div>
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Subject', 'Class', 'Category', 'Questions', 'Duration'].map(h => (
                        <th key={h} className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {exams.map(e => (
                      <tr key={e.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2.5 font-medium text-gray-800">{e.subject}</td>
                        <td className="px-4 py-2.5 text-gray-600">{e.classLevel}</td>
                        <td className="px-4 py-2.5 text-gray-600">{e.category}</td>
                        <td className="px-4 py-2.5 text-gray-600">{e.numQuestions}</td>
                        <td className="px-4 py-2.5 text-gray-600">{e.duration} min</td>
                      </tr>
                    ))}
                    {exams.length === 0 && (
                      <tr>
                        <td colSpan={5} className="px-4 py-8 text-center text-gray-400 text-sm">
                          No exams yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── STUDENTS ── */}
          {view === 'students' && (
            <StudentManagement
              students={students}
              onSave={saveStudent}
              onAssignIds={assignStudentIds}
              onDelete={deleteStudent}
            />
          )}

          {/* ── EXAMS ── */}
          {view === 'exams' && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-800">Exams</h2>
                <Btn
                  onClick={() => {
                    setEditExam(null)
                    setView('exam-form')
                  }}
                >
                  + Add Exam
                </Btn>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Subject', 'Class', 'Category', 'Questions', 'Duration', 'Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {exams.map(e => (
                      <tr key={e.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-medium text-gray-800">{e.subject}</td>
                        <td className="px-4 py-3 text-gray-600">{e.classLevel}</td>
                        <td className="px-4 py-3 text-gray-600">{e.category}</td>
                        <td className="px-4 py-3 text-gray-600">{e.numQuestions}</td>
                        <td className="px-4 py-3 text-gray-600">{e.duration} min</td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <Btn
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setSelectedExamId(e.id)
                                setView('questions')
                              }}
                            >
                              Questions
                            </Btn>
                            <Btn
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setEditExam(e)
                                setView('exam-form')
                              }}
                            >
                              Edit
                            </Btn>
                            <Btn
                              size="sm"
                              variant="danger"
                              onClick={() => void deleteExam(e.id)}
                            >
                              Delete
                            </Btn>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {exams.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-8 text-center text-gray-400 text-sm">
                          No exams added yet. Click Add Exam to get started.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── EXAM FORM ── */}
          {view === 'exam-form' && (
            <div>
              <div className="flex items-center gap-2 mb-5 text-sm text-gray-500">
                <button
                  onClick={() => setView('exams')}
                  className="hover:text-green-700 font-medium"
                >
                  ← Exams
                </button>
                <span>/</span>
                <span className="text-gray-800 font-medium">{editExam ? 'Edit Exam' : 'Add Exam'}</span>
              </div>
              <ExamForm
                exam={editExam}
                onSave={saved => void saveExam(saved)}
                onCancel={() => setView('exams')}
              />
            </div>
          )}

          {/* ── QUESTIONS ── */}
          {view === 'questions' && (
            <div>
              <div className="flex items-center justify-between mb-4">
                <div>
                  <h2 className="text-lg font-bold text-gray-800">Questions</h2>
                  <div className="flex items-center gap-2 mt-1.5">
                    <span className="text-xs text-gray-500">Exam:</span>
                    <SelectField
                      className="w-auto text-xs py-1"
                      value={selectedExamId}
                      onChange={e => setSelectedExamId(e.target.value)}
                    >
                      {exams.map(e => (
                        <option key={e.id} value={e.id}>
                          {e.subject} — {e.classLevel} ({e.category})
                        </option>
                      ))}
                    </SelectField>
                  </div>
                </div>
                <Btn
                  disabled={exams.length === 0}
                  onClick={() => {
                    setEditQuestion(null)
                    setView('question-form')
                  }}
                >
                  + Add Question
                </Btn>
              </div>

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-10">#</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Question</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-24">A</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-24">B</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-24">C</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-24">D</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">Ans</th>
                      <th className="px-3 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {examQuestions.map((q, i) => (
                      <tr key={q.id} className="hover:bg-gray-50">
                        <td className="px-3 py-3 text-gray-400 text-xs font-mono">{i + 1}</td>
                        <td className="px-3 py-3 text-gray-800 max-w-[200px]">
                          <span className="line-clamp-2 text-xs">{q.text}</span>
                        </td>
                        {(['A', 'B', 'C', 'D'] as const).map(l => (
                          <td key={l} className="px-3 py-3 text-gray-500 text-xs">
                            <span
                              style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '88px' }}
                            >
                              {q[OPTION_KEYS[l]]}
                            </span>
                          </td>
                        ))}
                        <td className="px-3 py-3">
                          <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-100 text-green-800 text-xs font-bold">
                            {q.correct}
                          </span>
                        </td>
                        <td className="px-3 py-3">
                          <div className="flex items-center gap-1">
                            <Btn
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                setEditQuestion(q)
                                setView('question-form')
                              }}
                            >
                              Edit
                            </Btn>
                            <Btn
                              size="sm"
                              variant="danger"
                              onClick={() => void deleteQuestion(q.id)}
                            >
                              Del
                            </Btn>
                          </div>
                        </td>
                      </tr>
                    ))}
                    {examQuestions.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-gray-400 text-sm">
                          No questions for this exam yet. Click Add Question to start.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                {examQuestions.length > 0 && (
                  <div className="px-4 py-2 border-t border-gray-100 text-xs text-gray-400">
                    {examQuestions.length} question{examQuestions.length !== 1 ? 's' : ''} &bull;{' '}
                    {activeExam && `Target: ${activeExam.numQuestions}`}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── QUESTION FORM ── */}
          {view === 'question-form' && (
            <div>
              <div className="flex items-center gap-2 mb-5 text-sm text-gray-500">
                <button
                  onClick={() => setView('questions')}
                  className="hover:text-green-700 font-medium"
                >
                  ← Questions
                </button>
                <span>/</span>
                <span className="text-gray-800 font-medium">
                  {editQuestion ? 'Edit Question' : 'Add Question'}
                </span>
              </div>
              <QuestionForm
                question={editQuestion}
                exams={exams}
                defaultExamId={selectedExamId}
                onSave={saved => void saveQuestion(saved)}
                onCancel={() => setView('questions')}
              />
            </div>
          )}

          {/* ── RESULTS ── */}
          {view === 'results' && (
            <div>
              <div className="flex items-center justify-between mb-5">
                <h2 className="text-lg font-bold text-gray-800">Student Results</h2>
                <Btn
                  size="sm"
                  variant="secondary"
                  disabled={resultsLoading}
                  onClick={() => {
                    setResultsLoading(true)
                    setResultsError('')
                    setResultsReloadKey(k => k + 1)
                  }}
                >
                  {resultsLoading ? 'Loading...' : 'Refresh'}
                </Btn>
              </div>

              {resultsError && (
                <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-3 py-2 mb-4">
                  {resultsError}
                </div>
              )}

              <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      {['Student Name', 'ID', 'Subject', 'Class', 'Score', 'Grade', 'Submitted', 'Actions'].map(h => (
                        <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {results.map(r => {
                      const g = letterGrade(r.score, r.total)
                      const pct = r.total > 0 ? Math.round((r.score / r.total) * 100) : 0
                      const gc =
                        g === 'A'
                          ? 'bg-green-100 text-green-800'
                          : g === 'B'
                          ? 'bg-blue-100 text-blue-800'
                          : g === 'C'
                          ? 'bg-yellow-100 text-yellow-800'
                          : g === 'D'
                          ? 'bg-orange-100 text-orange-800'
                          : 'bg-red-100 text-red-800'
                      return (
                        <tr key={r.id} className="hover:bg-gray-50">
                          <td className="px-4 py-3 font-medium text-gray-800">{r.studentName}</td>
                          <td className="px-4 py-3 text-gray-500 font-mono text-xs">{r.studentId}</td>
                          <td className="px-4 py-3 text-gray-600">{r.subject}</td>
                          <td className="px-4 py-3 text-gray-600">{r.classLevel}</td>
                          <td className="px-4 py-3">
                            <span className="font-semibold text-gray-800">
                              {r.score}/{r.total}
                            </span>
                            <span className="text-gray-400 text-xs ml-1">({pct}%)</span>
                          </td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-xs font-bold ${gc}`}
                            >
                              {g}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-gray-500 text-xs">{r.submittedAt}</td>
                          <td className="px-4 py-3">
                            <Btn size="sm" variant="danger" onClick={() => void deleteResult(r)}>
                              Delete / Allow retake
                            </Btn>
                          </td>
                        </tr>
                      )
                    })}
                    {results.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-gray-400 text-sm">
                          {resultsLoading ? 'Loading results...' : 'No results recorded yet.'}
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/* ═══════════════════════════════════════════════════════════════
   APP ROOT
═══════════════════════════════════════════════════════════════ */

type Portal = 'home' | 'student' | 'admin'
type StudentView = 'login' | 'instructions' | 'exam' | 'completed'

export default function App() {
  const [portal, setPortal] = useState<Portal>('home')
  const [studentView, setStudentView] = useState<StudentView>('login')
  const [adminLoggedIn, setAdminLoggedIn] = useState(false)
  const [currentStudent, setCurrentStudent] = useState<Student | null>(null)
  const [studentToken, setStudentToken] = useState('')
  const [currentExam, setCurrentExam] = useState<Exam | null>(null)
  const [currentQuestions, setCurrentQuestions] = useState<StudentQuestion[]>([])
  const [examProblem, setExamProblem] = useState<ExamProblem | null>(null)
  const [examResume, setExamResume] = useState<ExamResume | null>(null)
  const [examSession, setExamSession] = useState<ExamSession | null>(null)
  const [examResult, setExamResult] = useState<Result | null>(null)
  const loadRequestRef = useRef(0)

  const resetExamState = () => {
    setCurrentExam(null)
    setCurrentQuestions([])
    setExamProblem(null)
    setExamResume(null)
    setExamSession(null)
    setExamResult(null)
  }

  const handleStudentLogin = async (student: Student, token: string) => {
    const requestId = ++loadRequestRef.current

    // Clear anything left over from a previous student or attempt
    resetExamState()
    setCurrentStudent(student)
    setStudentToken(token)

    const outcome = await findExam(student, token)

    // Ignore this response if the student logged out or logged in again meanwhile
    if (requestId !== loadRequestRef.current) return

    if (outcome.status === 'ready') {
      setCurrentExam(outcome.exam)
      setCurrentQuestions(outcome.questions)
      setExamResume(outcome.resume)
    } else if (outcome.status === 'no-exam') {
      setExamProblem({
        title: 'No Active Exam',
        detail: `There is no exam available for ${student.classLevel} (${student.category}) at this time.`,
        retryable: false,
      })
    } else if (outcome.status === 'no-questions') {
      setExamProblem({
        title: 'Exam Not Ready',
        detail: `The ${outcome.exam.subject} exam has no questions yet. Please inform your teacher.`,
        retryable: true,
      })
    } else if (outcome.status === 'blocked') {
      setExamProblem({
        title: 'Exam Unavailable',
        detail: outcome.message,
        retryable: false,
      })
    } else {
      setExamProblem({
        title: 'Unable to Load Exam',
        detail: outcome.message,
        retryable: true,
      })
    }

    setStudentView('instructions')
  }

  // Start (or resume) the exam: the SERVER records the start time and returns the time left
  const handleStartExam = async () => {
    if (!currentExam) throw new Error('No examination is loaded.')

    const response = await fetch('/api/exams/start', {
      method: 'POST',
      headers: authHeaders(studentToken),
      body: JSON.stringify({ examId: currentExam.id }),
    })

    const text = await response.text()
    let data: {
      success?: boolean
      message?: string
      remainingSeconds?: number
      answers?: Record<string, unknown>
    } = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      /* handled below */
    }

    if (!response.ok || !data.success) {
      throw new Error(data.message || 'Unable to start the examination. Please try again.')
    }

    const remainingSeconds = Math.floor(Number(data.remainingSeconds) || 0)
    if (remainingSeconds <= 0) throw new Error('Your time for this examination has ended.')

    const savedAnswers: Record<string, string> = {}
    for (const [questionId, letter] of Object.entries(data.answers || {})) {
      if (typeof letter === 'string' && ['A', 'B', 'C', 'D'].includes(letter)) {
        savedAnswers[questionId] = letter
      }
    }

    setExamSession({ remainingSeconds, answers: savedAnswers })
    setStudentView('exam')
  }

  // Autosave. Throws on failure so the exam screen can show "Not saved" and retry.
  const handleSaveAnswers = async (answers: Record<string, string>) => {
    if (!currentExam) throw new Error('No examination is loaded.')

    const response = await fetch('/api/exams/answers', {
      method: 'POST',
      headers: authHeaders(studentToken),
      body: JSON.stringify({ examId: currentExam.id, answers }),
    })

    if (!response.ok) throw new Error('Unable to save answers.')
  }

  // Scoring happens on the server because correct answers are never sent to the browser.
  // Throws on failure so ExamScreen can show the error and let the student retry.
  const handleExamSubmit = async (answers: Record<string, string>) => {
    if (!currentStudent || !currentExam) {
      throw new Error('Session expired. Please log in again.')
    }

    const response = await fetch('/api/results', {
      method: 'POST',
      headers: authHeaders(studentToken),
      body: JSON.stringify({ examId: currentExam.id, answers }),
    })

    const text = await response.text()
    let data: {
      success?: boolean
      message?: string
      result?: { id?: string; score?: number; total?: number; submittedAt?: string }
    } = {}
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      /* handled by the check below */
    }

    if (!response.ok || !data.success || !data.result) {
      throw new Error(data.message || 'Unable to submit your exam. Please try again.')
    }

    setExamResult({
      id: data.result.id || `RES${Date.now()}`,
      studentId: currentStudent.id,
      studentName: currentStudent.name,
      examId: currentExam.id,
      subject: currentExam.subject,
      classLevel: currentStudent.classLevel,
      score: Number(data.result.score ?? 0),
      total: Number(data.result.total ?? currentExam.numQuestions),
      submittedAt:
        data.result.submittedAt ||
        new Date().toLocaleString('en-GB', {
          day: '2-digit',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
    })
    setStudentView('completed')
  }

  const handleStudentLogout = () => {
    loadRequestRef.current++ // cancel any in-flight exam load
    setCurrentStudent(null)
    setStudentToken('')
    resetExamState()
    setStudentView('login')
    setPortal('home')
  }

  if (portal === 'home') {
    return <PortalHome onSelect={p => setPortal(p)} />
  }

  if (portal === 'student') {
    if (studentView === 'login') {
      return (
        <StudentLogin
          onLogin={handleStudentLogin}
          onBack={() => setPortal('home')}
        />
      )
    }
    if (studentView === 'instructions' && currentStudent) {
      return (
        <ExamInstructions
          student={currentStudent}
          exam={currentExam}
          problem={examProblem}
          resume={examResume}
          onStart={handleStartExam}
          onRetry={() => void handleStudentLogin(currentStudent, studentToken)}
          onLogout={handleStudentLogout}
        />
      )
    }
    if (
      studentView === 'exam' &&
      currentStudent &&
      currentExam &&
      examSession &&
      currentQuestions.length > 0
    ) {
      return (
        <ExamScreen
          student={currentStudent}
          exam={currentExam}
          questions={currentQuestions}
          initialRemaining={examSession.remainingSeconds}
          initialAnswers={examSession.answers}
          onSaveAnswers={handleSaveAnswers}
          onSubmit={handleExamSubmit}
        />
      )
    }
    if (studentView === 'completed' && currentStudent && currentExam && examResult) {
      return (
        <ExamCompleted
          student={currentStudent}
          exam={currentExam}
          result={examResult}
          onLogout={handleStudentLogout}
        />
      )
    }
  }

  if (portal === 'admin') {
    if (!adminLoggedIn) {
      return (
        <AdminLogin
          onLogin={() => setAdminLoggedIn(true)}
          onBack={() => setPortal('home')}
        />
      )
    }
    return (
      <AdminDashboard
        onLogout={() => {
          setAdminLoggedIn(false)
          setPortal('home')
        }}
      />
    )
  }

  return null
}
