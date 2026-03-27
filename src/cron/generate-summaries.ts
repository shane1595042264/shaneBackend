import { generateSummary } from "@/modules/journal/summarizer";

export async function runSummaryGeneration(date: string): Promise<void> {
  const d = new Date(date);
  const dayOfWeek = d.getDay(); // 0 = Sunday
  const dayOfMonth = d.getDate();
  const month = d.getMonth() + 1; // 1-based

  // Sunday: generate weekly summary (Mon–Sun, where Monday is 6 days before Sunday)
  if (dayOfWeek === 0) {
    const sunday = new Date(d);
    const monday = new Date(d);
    monday.setDate(d.getDate() - 6);

    const startDate = monday.toISOString().slice(0, 10);
    const endDate = sunday.toISOString().slice(0, 10);

    console.log(`[generate-summaries] Generating weekly summary for ${startDate} to ${endDate}...`);
    await generateSummary("weekly", startDate, endDate);
    console.log(`[generate-summaries] Weekly summary generated.`);
  }

  // 1st of month: generate monthly summary (previous month's range)
  if (dayOfMonth === 1) {
    const prevMonthEnd = new Date(d);
    prevMonthEnd.setDate(0); // last day of previous month
    const prevMonthStart = new Date(prevMonthEnd.getFullYear(), prevMonthEnd.getMonth(), 1);

    const startDate = prevMonthStart.toISOString().slice(0, 10);
    const endDate = prevMonthEnd.toISOString().slice(0, 10);

    console.log(`[generate-summaries] Generating monthly summary for ${startDate} to ${endDate}...`);
    await generateSummary("monthly", startDate, endDate);
    console.log(`[generate-summaries] Monthly summary generated.`);
  }

  // Jan 1: generate yearly summary (previous year)
  if (dayOfMonth === 1 && month === 1) {
    const prevYear = d.getFullYear() - 1;
    const startDate = `${prevYear}-01-01`;
    const endDate = `${prevYear}-12-31`;

    console.log(`[generate-summaries] Generating yearly summary for ${prevYear}...`);
    await generateSummary("yearly", startDate, endDate);
    console.log(`[generate-summaries] Yearly summary generated.`);
  }
}
