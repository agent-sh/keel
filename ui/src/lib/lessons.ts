// Lessons from repeated failures (src/automation/lessons.ts) as the page reads
// them: the list in Customize > Lessons and the owner's acts on a lesson.
import { GraduationCap } from "lucide-react";
import { createElement, lazy } from "react";
import type { Lesson, LessonState, Outcome } from "../../../src/automation/lessons.ts";
import { settingsSections } from "./extend.ts";
import { api } from "./store.ts";

export type { Lesson, LessonState, Outcome };
export type Lessons = { lessons: Lesson[]; mine: { ts: number; found: number; ms: number } | null; metric: string; days: number };

export const listLessons = () => api<Lessons>("/api/lessons");
export const mineLessons = () => api<{ found: number; added: number }>("/api/lessons/mine", { method: "POST" });
const act = (id: string, what: "accept" | "edit" | "drop" | "propose", text?: string) =>
  api<{ lesson: Lesson }>(`/api/lessons/${id}/${what}`, { method: "POST", ...(text === undefined ? {} : { body: JSON.stringify({ text }) }) }).then((r) => r.lesson);
export const acceptLesson = (id: string, text: string) => act(id, "accept", text);
export const editLesson = (id: string, text: string) => act(id, "edit", text);
export const dropLesson = (id: string) => act(id, "drop");
export const proposeLesson = (id: string) => act(id, "propose");

settingsSections.add({
  id: "lessons",
  label: "Lessons",
  words: "lessons learned failures repeated recurring mistakes notes agents repository trial accept drop",
  icon: createElement(GraduationCap, { className: "size-4" }),
  order: 22,
  component: lazy(() => import("../components/LessonsPanel.tsx").then((m) => ({ default: m.LessonsPanel }))),
});
