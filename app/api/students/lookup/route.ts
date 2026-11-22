import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase-admin";
import { createStudentToken } from "@/lib/student-session";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    const studentId = String(body.studentId || "")
      .trim()
      .toUpperCase();

    const classLevel = String(body.classLevel || "").trim();
    const category = String(body.category || "").trim();
    const password = String(body.password || "");

    if (!studentId || !classLevel || !password) {
      return NextResponse.json(
        { error: "Please provide your Student ID, class and password." },
        { status: 400 }
      );
    }

    const isSenior = classLevel.startsWith("SS");

    if (isSenior && !category) {
      return NextResponse.json(
        { error: "Please select your department." },
        { status: 400 }
      );
    }

    const loginKey = isSenior
      ? `${classLevel}-${category}`
      : classLevel;

    const configuredLogins = process.env.STUDENT_CLASS_LOGINS;

    if (!configuredLogins) {
      return NextResponse.json(
        { error: "Student class login has not been configured." },
        { status: 500 }
      );
    }

    let classLogins: Record<string, string>;

    try {
      classLogins = JSON.parse(configuredLogins);
    } catch {
      return NextResponse.json(
        { error: "Student login configuration is invalid." },
        { status: 500 }
      );
    }

    if (
      !classLogins[loginKey] ||
      classLogins[loginKey] !== password
    ) {
      return NextResponse.json(
        { error: "Incorrect class password." },
        { status: 401 }
      );
    }

    const snapshot = await adminDb
      .collection("students")
      .where("studentId", "==", studentId)
      .where("classLevel", "==", classLevel)
      .limit(1)
      .get();

    if (snapshot.empty) {
      return NextResponse.json(
        { error: "Student ID was not found in this class." },
        { status: 404 }
      );
    }

    const studentDoc = snapshot.docs[0];
    const student = studentDoc.data();

    if (student.status !== "active") {
      return NextResponse.json(
        { error: "This student account is not active." },
        { status: 403 }
      );
    }

    if (isSenior && student.category !== category) {
      return NextResponse.json(
        { error: "This student is not registered in this department." },
        { status: 403 }
      );
    }

    // Signed login token: the exam routes only trust this, never a typed Student ID
    let token: string;
    try {
      token = createStudentToken(String(student.studentId), studentDoc.id);
    } catch (error) {
      console.error("Session token error:", error);
      return NextResponse.json(
        { error: "Exam sessions are not configured. Ask the administrator to set STUDENT_SESSION_SECRET." },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      token,
      student: {
        id: student.studentId,
        studentId: student.studentId,
        firestoreId: studentDoc.id,
        name: student.name,
        surname: student.surname,
        firstName: student.firstName,
        otherNames: student.otherNames,
        classLevel: student.classLevel,
        category: student.category,
        lin: student.lin || "",
      },
    });
  } catch (error) {
    console.error("Student lookup error:", error);

    return NextResponse.json(
      { error: "Unable to verify student. Please try again." },
      { status: 500 }
    );
  }
}