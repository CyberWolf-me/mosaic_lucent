import type { MeetingTurn } from "./meetings.js";

/**
 * The meeting-evaluation fixtures (2026-09, P0-2): five scripted meetings, the
 * raw material for the offline policy suite and the real-provider scoresheet
 * in docs/16-meeting-evaluation.md.
 *
 * These are NOT clean scripts. The advisory's point was that a demo meeting
 * ("we build X, it has A, B, C") tests nothing — real meetings jump topics,
 * interrupt, correct, joke, and leave things unresolved. The offline suite
 * drives the differential-loop POLICIES against these turns (trigger
 * behaviour, gating, continuity); the scoresheet's job is to measure what the
 * real MODEL does with them.
 *
 * Each fixture names what it is designed to stress.
 */

export interface MeetingFixture {
  id: string;
  /** What this meeting is designed to stress. */
  purpose: string;
  /** The expected topics, named for continuity scoring — order matters. */
  expectedTopics: string[];
  turns: Array<Pick<MeetingTurn, "speaker" | "text"> & { kind?: MeetingTurn["kind"] }>;
}

export const PRODUCT_LAUNCH: MeetingFixture = {
  id: "product-launch",
  purpose:
    "The canonical flow: distinct topics in sequence (audience, positioning, features, timeline, marketing) — extraction should create one region per topic and connect related ideas.",
  expectedTopics: ["Target users", "Positioning", "Features", "Timeline", "Marketing"],
  turns: [
    { speaker: "Sarah", text: "Okay, so we're launching the budgeting app in October." },
    { speaker: "Sarah", text: "Our main users are university students and young professionals." },
    { speaker: "Alex", text: "Students first — they're the ones with the budgeting pain." },
    {
      speaker: "Sarah",
      text: "Right, students are the primary users, professionals can come later.",
    },
    { speaker: "David", text: "Positioning-wise we're the app that finally makes money visible." },
    { speaker: "David", text: "Not another expense tracker — the automation is the difference." },
    {
      speaker: "Alex",
      text: "For the first version we need automatic categorization, budgets, and spending alerts.",
    },
    { speaker: "Sarah", text: "We'll skip investments and crypto for now, too complex." },
    { speaker: "Alex", text: "Marketing should start two weeks before launch." },
    {
      speaker: "David",
      text: "I'll own the launch campaign, we'll need landing page and socials.",
    },
  ],
};

export const ARCHITECTURE_JUMPING: MeetingFixture = {
  id: "architecture-jumping",
  purpose:
    "Topic switching within one domain: frontend → backend → infra → APIs → data → BACK to frontend. Continuity must UPDATE the existing frontend region, never create a second one.",
  expectedTopics: ["Frontend", "Backend", "Infrastructure", "APIs", "Data"],
  turns: [
    { speaker: "Priya", text: "The frontend is a React SPA talking to an API gateway." },
    { speaker: "Priya", text: "Backend-wise we'll have a payments service and an orders service." },
    { speaker: "Marcus", text: "Orders needs its own database, payments can share the cluster." },
    {
      speaker: "Marcus",
      text: "Infrastructure is Kubernetes with an ingress controller and cert manager.",
    },
    { speaker: "Priya", text: "The APIs are REST for now, gRPC between services." },
    { speaker: "Marcus", text: "Data flows through an event bus into the analytics pipeline." },
    {
      speaker: "Priya",
      text: "Back on the frontend — we should add a service worker for offline.",
    },
  ],
};

export const BRAINSTORM_DISAGREEMENT: MeetingFixture = {
  id: "brainstorm-disagreement",
  purpose:
    "Speculation and disagreement: maybe/what-if/alternatives everywhere, and one explicit rejection. Proposals must NOT become decisions; the rejection must visibly supersede.",
  expectedTopics: ["Pricing ideas", "Rejected options"],
  turns: [
    { speaker: "Jin", text: "Maybe we could do a freemium tier with usage limits." },
    { speaker: "Lena", text: "What if we just went all-in on a single paid plan?" },
    { speaker: "Jin", text: "Or perhaps usage-based pricing — pay for what you track." },
    { speaker: "Lena", text: "I think freemium attracts tire-kickers who never convert." },
    { speaker: "Marcus", text: "We could try a 30-day trial instead of freemium." },
    {
      speaker: "Lena",
      text: "No, we're not doing usage-based pricing — too unpredictable for users.",
    },
    { speaker: "Jin", text: "So trial plus a single plan, we'll decide after beta." },
  ],
};

export const PLANNING_OWNERS: MeetingFixture = {
  id: "planning-owners",
  purpose:
    "Execution talk: owners, deadlines, dependencies, and one scope change. Attribution must land the RIGHT person on each action; the scope change must update, not duplicate.",
  expectedTopics: ["Onboarding redesign", "Actions"],
  turns: [
    { speaker: "Sarah", text: "We need to redesign onboarding before the launch." },
    { speaker: "Alex", text: "I'll research onboarding drop-off this week." },
    { speaker: "David", text: "I can prototype the new flow by Friday." },
    { speaker: "Sarah", text: "Sarah will review both and pick a direction Monday." },
    { speaker: "Alex", text: "The prototype depends on the research findings." },
    { speaker: "David", text: "Let's cut the social signup from scope — email only for now." },
    { speaker: "Sarah", text: "Agreed, email-only for v1, social later." },
  ],
};

export const MESSY_MEETING: MeetingFixture = {
  id: "messy-meeting",
  purpose:
    "The adversarial one: interruptions, corrections, side conversations, a joke, and unrelated chatter. Measures precision (how much junk lands on the board) and correction handling (the final target user must be the corrected one).",
  expectedTopics: ["Checkout flow", "Target users"],
  turns: [
    { speaker: "Alex", text: "Okay so the checkout flow, the customer adds to cart and then—" },
    { speaker: "Sarah", text: "Sorry, quick thing — did everyone see the game last night?" },
    { speaker: "David", text: "Ha, yes, devastating. Anyway — checkout." },
    { speaker: "Alex", text: "Right, so cart, then payment, then confirmation." },
    { speaker: "Sarah", text: "We're targeting students for this, right?" },
    { speaker: "David", text: "Actually, young professionals — students were last quarter." },
    { speaker: "Alex", text: "Yes, young professionals, sorry." },
    {
      speaker: "Sarah",
      text: "Oh and my sister needs a babysitter this weekend, remind me later.",
    },
    { speaker: "David", text: "What if the payment step had a one-click option?" },
    { speaker: "Alex", text: "Hmm, maybe, let's test it after launch." },
  ],
};

/** All fixtures, in the order the scoresheet lists them. */
export const MEETING_FIXTURES: MeetingFixture[] = [
  PRODUCT_LAUNCH,
  ARCHITECTURE_JUMPING,
  BRAINSTORM_DISAGREEMENT,
  PLANNING_OWNERS,
  MESSY_MEETING,
];
