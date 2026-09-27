/**
 * Calendar invites for scheduled meetings (docs/28 A3.4): one iCalendar
 * (RFC 5545) event per meeting, sent with the invite mail and offered as
 * "Add to calendar". The meeting id is the event's UID, so an update or a
 * cancellation replaces the same event in the person's calendar instead of
 * adding a second one; SEQUENCE orders the versions.
 *
 * Hand-written, like the SMTP client: the format is small, and owning it
 * keeps the escaping — the part that goes wrong — in one tested place.
 */

export interface CalendarPerson {
  name: string;
  email: string;
}

export interface MeetingEvent {
  /** The meeting id; becomes the event UID. */
  meetingId: string;
  /** REQUEST invites or updates; CANCEL withdraws; PUBLISH is a plain download. */
  method: "REQUEST" | "CANCEL" | "PUBLISH";
  /** Increases with every change the invitees are told about. */
  sequence: number;
  start: number;
  durationMin: number;
  title: string;
  description: string;
  /** Where the meeting is: its page in Lucent. */
  url: string;
  organizer: CalendarPerson;
  attendees: CalendarPerson[];
  /** When this version was made (DTSTAMP). */
  now: number;
  /** The host's domain, for the UID. */
  domain: string;
}

/** YYYYMMDDTHHMMSSZ — UTC, so no time zone table is needed. */
export function icsTime(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** TEXT value escaping (RFC 5545 §3.3.11). */
export function icsText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

/** A name inside a parameter: quoted, with the characters a quote can't hold removed. */
function paramValue(value: string): string {
  return `"${value.replace(/["\r\n]/g, "")}"`;
}

/**
 * Fold a content line at 75 octets (RFC 5545 §3.1): continuation lines start
 * with one space. Folds between characters, never inside a UTF-8 sequence.
 */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let size = 0;
  for (const ch of line) {
    const n = encoder.encode(ch).length;
    const limit = out.length === 0 ? 75 : 74;
    if (size + n > limit) {
      out.push(current);
      current = "";
      size = 0;
    }
    current += ch;
    size += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

export function meetingIcs(event: MeetingEvent): string {
  const end = event.start + event.durationMin * 60_000;
  const lines = [
    "BEGIN:VCALENDAR",
    "PRODID:-//Lucent//Meetings//EN",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `METHOD:${event.method}`,
    "BEGIN:VEVENT",
    `UID:${event.meetingId}@${event.domain}`,
    `SEQUENCE:${event.sequence}`,
    `DTSTAMP:${icsTime(event.now)}`,
    `DTSTART:${icsTime(event.start)}`,
    `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(event.title)}`,
    `DESCRIPTION:${icsText(`${event.description}\n\n${event.url}`)}`,
    `URL:${event.url}`,
    `LOCATION:${icsText(event.url)}`,
    `ORGANIZER;CN=${paramValue(event.organizer.name)}:mailto:${event.organizer.email}`,
    ...event.attendees.map(
      (a) =>
        `ATTENDEE;CN=${paramValue(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`,
    ),
    `STATUS:${event.method === "CANCEL" ? "CANCELLED" : "CONFIRMED"}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** The attachment a mail carries for this event. */
export function icsAttachment(event: MeetingEvent): {
  filename: string;
  contentType: string;
  content: string;
} {
  return {
    filename: event.method === "CANCEL" ? "cancel.ics" : "invite.ics",
    contentType: `text/calendar; charset=utf-8; method=${event.method}`,
    content: meetingIcs(event),
  };
}
