export function calculateThreshold(price: number, remainingBudget: number): number {
  if (remainingBudget <= 0) return 21;
  return Math.round((price / remainingBudget) * 20);
}

export function rollD20(): number {
  return Math.floor(Math.random() * 20) + 1;
}

interface VerdictInput {
  isEntertainment: boolean;
  isBanned: boolean;
  threshold: number;
  roll: number;
}

export type Verdict = "approved" | "denied" | "necessity" | "banned" | "too_expensive";

export function determineVerdict(input: VerdictInput): Verdict {
  if (!input.isEntertainment) return "necessity";
  if (input.isBanned) return "banned";
  if (input.threshold > 20) return "too_expensive";
  if (input.threshold <= 0) return "approved";
  if (input.roll >= input.threshold) return "approved";
  return "denied";
}
