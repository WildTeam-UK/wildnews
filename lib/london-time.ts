const londonDateTimePartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function londonDateTimeParts(date: Date) {
  const values = Object.fromEntries(londonDateTimePartsFormatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

export function isSameLondonDay(left: Date, right: Date) {
  const a = londonDateTimeParts(left);
  const b = londonDateTimeParts(right);
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

export function londonLocalDateTimeToUtc(year: number, month: number, day: number, hour = 0, minute = 0, second = 0) {
  const target = Date.UTC(year, month - 1, day, hour, minute, second);
  let timestamp = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const actual = londonDateTimeParts(new Date(timestamp));
    const represented = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    const difference = represented - target;
    if (!difference) break;
    timestamp -= difference;
  }
  return timestamp;
}
