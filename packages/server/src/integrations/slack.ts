/**
 * Slack, outbound only (docs/26 A5): a meeting's summary posted to a channel
 * the org chose, through a Slack incoming webhook.
 *
 * The webhook URL is a secret (it carries its own token), so it follows the
 * reference-first rule every credential here does (ADR 0030): the
 * connection names a server environment variable that holds it, and the URL
 * never passes through a browser. It is also an outbound destination the
 * server calls, so it must be Slack's — https on hooks.slack.com — or an
 * owner could point the server anywhere.
 */

export const SLACK_WEBHOOK_HOST = "hooks.slack.com";

export class SlackError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "SlackError";
  }
}

/** The webhook URL, or the honest reason it can't be one. */
export function slackWebhookUrl(value: string | undefined, ref: string): URL {
  if (!value) {
    throw new SlackError(`credential ref "${ref}" is not set in the environment`, 0);
  }
  // An unusable URL is the credential's problem, like a refused key (401).
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SlackError(`"${ref}" doesn't hold a URL`, 401);
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== SLACK_WEBHOOK_HOST ||
    !url.pathname.startsWith("/services/")
  ) {
    throw new SlackError(
      `"${ref}" must hold a Slack incoming-webhook URL (https://${SLACK_WEBHOOK_HOST}/services/…)`,
      401,
    );
  }
  return url;
}

export interface SlackMessage {
  /** The notification and fallback text. */
  text: string;
  blocks?: unknown[];
}

export interface SlackPoster {
  post(url: URL, message: SlackMessage): Promise<void>;
}

/** The wire: one POST, bounded; a refusal carries Slack's status for health. */
export function httpSlackPoster(fetchImpl: typeof fetch = fetch, timeoutMs = 10_000): SlackPoster {
  return {
    async post(url, message) {
      const res = await fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(message),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 120);
        throw new SlackError(
          `slack responded ${res.status}${detail ? `: ${detail}` : ""}`,
          // Slack answers a revoked or deleted webhook with 403/404/410:
          // all three mean the URL no longer works — the credential's problem.
          res.status === 404 || res.status === 410 ? 403 : res.status,
        );
      }
    },
  };
}

/** Slack's mrkdwn treats these three as control characters. */
function escape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_SECTIONS = 4;
const MAX_ITEMS = 6;

/**
 * A meeting's summary as a Slack message: the title linking to the meeting,
 * each section's first lines, and where it came from. Short on purpose — the
 * whole summary, with its citations, is one click away.
 */
export function recapMessage(input: {
  title: string;
  boardName: string;
  link: string;
  sections: ReadonlyArray<{ title: string; items: ReadonlyArray<{ text: string }> }>;
}): SlackMessage {
  const sections = input.sections.filter((s) => s.items.length > 0).slice(0, MAX_SECTIONS);
  const blocks: unknown[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: `*<${input.link}|${escape(input.title)}>* — summary` },
    },
    ...sections.map((s) => {
      const lines = s.items.slice(0, MAX_ITEMS).map((i) => `• ${escape(i.text)}`);
      const more = s.items.length > MAX_ITEMS ? `\n_…and ${s.items.length - MAX_ITEMS} more_` : "";
      return {
        type: "section",
        text: { type: "mrkdwn", text: `*${escape(s.title)}*\n${lines.join("\n")}${more}` },
      };
    }),
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: `From Lucent · ${escape(input.boardName)}` }],
    },
  ];
  return { text: `${input.title} — summary from ${input.boardName}`, blocks };
}
