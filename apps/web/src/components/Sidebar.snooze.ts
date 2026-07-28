export interface SnoozePreset {
  readonly id: "hour" | "evening" | "tomorrow" | "next-week";
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;

function timeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function atHour(base: Date, hour: number): Date {
  const next = new Date(base);
  next.setHours(hour, 0, 0, 0);
  return next;
}

function addDays(base: Date, days: number): Date {
  const next = new Date(base);
  next.setDate(next.getDate() + days);
  return next;
}

export function resolveSnoozePresets(now: Date): ReadonlyArray<SnoozePreset> {
  const inAnHour = new Date(now.getTime() + HOUR_MS);
  const presets: SnoozePreset[] = [
    {
      id: "hour",
      label: "In 1 hour",
      whenLabel: timeOfDayLabel(inAnHour),
      snoozedUntil: inAnHour.toISOString(),
    },
  ];

  const evening = atHour(now, 18);
  if (evening.getTime() - now.getTime() > HOUR_MS) {
    presets.push({
      id: "evening",
      label: "This evening",
      whenLabel: timeOfDayLabel(evening),
      snoozedUntil: evening.toISOString(),
    });
  }

  const tomorrow = atHour(addDays(now, 1), 9);
  presets.push({
    id: "tomorrow",
    label: "Tomorrow",
    whenLabel: timeOfDayLabel(tomorrow),
    snoozedUntil: tomorrow.toISOString(),
  });

  const daysUntilMonday = (1 - now.getDay() + 7) % 7 || 7;
  const nextWeek = atHour(addDays(now, daysUntilMonday), 9);
  presets.push({
    id: "next-week",
    label: "Next week",
    whenLabel: `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${timeOfDayLabel(nextWeek)}`,
    snoozedUntil: nextWeek.toISOString(),
  });
  return presets;
}

export function snoozeWakeLabel(snoozedUntil: string, now: Date): string {
  const wakeAt = Date.parse(snoozedUntil);
  if (!Number.isFinite(wakeAt)) return "now";
  const remainingMs = wakeAt - now.getTime();
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}
