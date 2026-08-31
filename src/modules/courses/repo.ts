// src/modules/courses/repo.ts
export const COURSE_CATEGORIES = [
  "math",
  "physics",
  "computer-science",
  "engineering",
  "biology",
  "chemistry",
  "history",
  "economics",
  "philosophy",
  "language",
  "art",
  "music",
  "other",
] as const;
export type CourseCategory = (typeof COURSE_CATEGORIES)[number];

export const COURSE_DIFFICULTIES = ["intro", "intermediate", "advanced"] as const;
export type CourseDifficulty = (typeof COURSE_DIFFICULTIES)[number];
