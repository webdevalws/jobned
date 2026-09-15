export interface CalendarEvent {
  title: string;
  description: string;
  location?: string;
  startTime: Date | number;
  durationMinutes: number;
  url?: string;
  organizerName?: string;
  organizerEmail?: string;
}

function formatDateToICS(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
}

/**
 * Generate 1-Click Google Calendar Add Link
 */
export function generateGoogleCalendarUrl(event: CalendarEvent): string {
  const start = new Date(event.startTime);
  const end = new Date(start.getTime() + event.durationMinutes * 60 * 1000);
  
  const dates = `${formatDateToICS(start)}/${formatDateToICS(end)}`;
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: event.title,
    dates: dates,
    details: event.description + (event.location ? `\n\nMeeting/Location: ${event.location}` : ''),
    location: event.location || '',
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * Generate 1-Click Outlook Web Add Link
 */
export function generateOutlookCalendarUrl(event: CalendarEvent): string {
  const start = new Date(event.startTime);
  const end = new Date(start.getTime() + event.durationMinutes * 60 * 1000);

  const params = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: event.title,
    startdt: start.toISOString(),
    enddt: end.toISOString(),
    body: event.description,
    location: event.location || '',
  });

  return `https://outlook.live.com/calendar/0/action/compose?${params.toString()}`;
}

/**
 * Generate RFC 5545 .ics Calendar file content
 */
export function generateICSContent(event: CalendarEvent): string {
  const start = new Date(event.startTime);
  const end = new Date(start.getTime() + event.durationMinutes * 60 * 1000);
  const now = new Date();
  const uid = `interview-${start.getTime()}-${Math.random().toString(36).substring(2, 9)}@jobned.com`;

  const cleanDescription = (event.description || '').replace(/\r?\n/g, '\\n').replace(/,/g, '\\,');
  const cleanTitle = (event.title || '').replace(/,/g, '\\,');
  const cleanLocation = (event.location || '').replace(/,/g, '\\,');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//JobNed//Interview Scheduling//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${formatDateToICS(now)}`,
    `DTSTART:${formatDateToICS(start)}`,
    `DTEND:${formatDateToICS(end)}`,
    `SUMMARY:${cleanTitle}`,
    `DESCRIPTION:${cleanDescription}`,
    `LOCATION:${cleanLocation}`,
    'STATUS:CONFIRMED',
    'SEQUENCE:0',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Reminder: Upcoming Interview with JobNed',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\r\n');
}
