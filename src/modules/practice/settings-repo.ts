import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { practiceSettings } from "@/db/schema";

export interface PracticeSettings {
  setsPerStrike: number;
  strikesPerLoadedLocation: number;
  locationsToSolidify: number;
  updatedAt: Date;
  updatedBy: string | null;
}

const DEFAULT: PracticeSettings = {
  setsPerStrike: 5,
  strikesPerLoadedLocation: 5,
  locationsToSolidify: 7,
  updatedAt: new Date(0),
  updatedBy: null,
};

/**
 * Singleton row at id=1. If somehow missing (shouldn't happen — migration
 * 0011 seeds it), return safe defaults so the app stays up.
 */
export async function getSettings(): Promise<PracticeSettings> {
  const [row] = await db
    .select({
      setsPerStrike: practiceSettings.setsPerStrike,
      strikesPerLoadedLocation: practiceSettings.strikesPerLoadedLocation,
      locationsToSolidify: practiceSettings.locationsToSolidify,
      updatedAt: practiceSettings.updatedAt,
      updatedBy: practiceSettings.updatedBy,
    })
    .from(practiceSettings)
    .where(eq(practiceSettings.id, 1))
    .limit(1);
  return row ?? DEFAULT;
}

export interface SettingsPatch {
  setsPerStrike?: number;
  strikesPerLoadedLocation?: number;
  locationsToSolidify?: number;
}

export async function updateSettings(
  updatedBy: string,
  patch: SettingsPatch,
): Promise<PracticeSettings> {
  const set: Record<string, unknown> = { updatedAt: new Date(), updatedBy };
  if (patch.setsPerStrike !== undefined) set.setsPerStrike = patch.setsPerStrike;
  if (patch.strikesPerLoadedLocation !== undefined)
    set.strikesPerLoadedLocation = patch.strikesPerLoadedLocation;
  if (patch.locationsToSolidify !== undefined) set.locationsToSolidify = patch.locationsToSolidify;

  const [row] = await db
    .update(practiceSettings)
    .set(set)
    .where(eq(practiceSettings.id, 1))
    .returning({
      setsPerStrike: practiceSettings.setsPerStrike,
      strikesPerLoadedLocation: practiceSettings.strikesPerLoadedLocation,
      locationsToSolidify: practiceSettings.locationsToSolidify,
      updatedAt: practiceSettings.updatedAt,
      updatedBy: practiceSettings.updatedBy,
    });
  return row;
}
