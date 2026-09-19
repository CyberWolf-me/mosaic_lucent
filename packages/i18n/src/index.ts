/**
 * String extraction and lookup (G2: "string extraction with one non-English
 * locale").
 *
 * The shape follows the way the app's strings are actually written: not as
 * one giant dictionary, but as inline English in components with a few
 * high-traffic surfaces extracted. This package owns the mechanism — the
 * dictionary type, the lookup, the interpolation — and the two things the
 * plan's gate pins: a round-trip (every key in the base locale resolves in
 * every other locale) and a fallback rule (a missing key falls back to the
 * base string, never to an empty render).
 *
 * Deliberately not a framework: no react-intl, no i18next. Both exist and
 * both are excellent, but both would arrive as runtime dependencies for a
 * problem that is, today, a Map lookup. The web package imports only the
 * `t` function and the locale list; when a locale's plural rules or
 * date-format needs exceed this, that is the moment to adopt a library
 * rather than grow one.
 */

/** The base language. Every other locale is defined against this one. */
export type BaseLocale = "en";

/** Locale codes this app builds with. `en` is always first — it is the fallback. */
export const LOCALES = ["en", "hu"] as const;

export type Locale = (typeof LOCALES)[number];

/** Flat dotted keys. Flat rather than nested: greppable both ways. */
export type MessageKey = string;

/** One locale's messages. The base locale's shape is the contract. */
export type Messages = Record<MessageKey, string>;

/**
 * The English strings. The set kept small on purpose: the surfaces a first-
 * time user cannot avoid (auth, the empty canvas, the first paywall), plus
 * the toast pair the palette emits. Growing this is a deliberate act —
 * each key is one more string to translate, and an untranslated key is a
 * worse experience than an English one.
 */
export const en: Messages = {
  "auth.signin.title": "Sign in",
  "auth.signup.title": "Create an account",
  "auth.email.label": "Email",
  "auth.password.label": "Password",
  "auth.name.label": "Name",
  "auth.submit.signup": "Create account",
  "auth.submit.signin": "Sign in",
  "canvas.empty.title": "Describe what you're building",
  "canvas.empty.hint":
    "Say it in your own words — a flow, an architecture, a journey. The diagram appears, editable.",
  "canvas.generating": "Receiving response…",
  "canvas.generating.characters": "Receiving response… {n} characters",
  "plan.limit.title": "You've reached your plan limit",
  "plan.limit.upgrade": "Upgrade",
  "palette.hint.placeholder": "Search actions, views, or ask Lucent to build something…",
  "palette.group.views": "Views",
  "palette.group.board": "On this board",
  "palette.group.nodes": "Nodes",
  "palette.group.transcript": "Transcript",
  "palette.group.revisions": "Revisions",
  "palette.empty.none": "No matches",
  "palette.empty.ask": 'No matches · Press Enter to ask Lucent to build "{q}"',
  "palette.matched": "Matching: {q}",
  "palette.window.truncated": "Only the latest {depth} revisions were searched",
  "palette.ask.bridge": "Ask Lucent about these results",
  "palette.ask.placeholder": "Ask a question about this board…",
  "palette.ask.hint": "Enter sends your question to Ask; Esc returns to search",
  "toast.inserted": "Inserted {name}.",
  "toast.insert.conflict": "Couldn't insert {name} — it conflicts with the current board.",
  "intel.title": "Intelligence",
  "exec.title": "Execution",
  "exec.subtitle":
    "How the work is going and what's blocking it — a projection of the board's executable actions.",
  "exec.counts.completed": "Completed",
  "exec.counts.inProgress": "In progress",
  "exec.counts.blocked": "Blocked",
  "exec.counts.atRisk": "At risk",
  "exec.counts.overdue": "Overdue",
  "exec.atRisk.title":
    "An upstream item is past due and unfinished — an analytical signal, never a status.",
  "exec.blocking.title": "What's blocking us",
  "exec.blocking.empty": "Nothing is blocked.",
  "exec.decisions.title": "Decisions behind the work",
  "exec.decisions.empty": "No decisions are linked to in-progress work yet.",
  "exec.empty.title": "No executable work yet",
  "exec.empty.hint": "Ask Lucent to create the work, then track it here.",
  "exec.attention.title": "NEEDS ATTENTION",
  "intel.subtitle":
    "A projection of the current semantic workspace — what is true now, every row traceable to its source.",
  "intel.section.decision": "Decisions",
  "intel.section.proposal": "Proposals",
  "intel.section.question": "Open questions",
  "intel.section.action": "Actions",
  "intel.section.requirement": "Requirements",
  "intel.section.risk": "Risks",
  "intel.empty.section": "No {kind} yet — statements come from meetings, the HUD editor, and Ask.",
  "intel.empty.view": "Nothing to show yet",
  "intel.empty.view.hint":
    "Statements appear here as meetings, edits, and conversations add them to the board.",
  "intel.row.assignee": "→ {name}",
  "intel.row.supersedes": "supersedes {n}",
  "intel.row.due": "due {date}",
  "intel.row.drives": "→ {n} actions",
  "intel.plan.from": "Plan from selection ({n})",
  "integrations.sync.button": "Sync to Linear",
  "integrations.sync.with": "Sync with {provider}",
  "integrations.send.to": "Send to {provider}",
  "integrations.sync.title": "Propose external tasks for this board's executable actions",
  "integrations.not_connected": "{provider} not connected",
  "integrations.connection_disabled": "The {provider} connection is disabled",
  "integrations.team": "Team: {team}",
  "integrations.repo": "Repo: {repo}",
  "integrations.project": "Project: {project}",
  "integrations.warnings.title": "This provider cannot represent some fields faithfully:",
  "integrations.panel.title": "External actions — {provider}",
  "integrations.panel.hint":
    "Propose a batch of external tasks; review the preview; approve to execute.",
  "integrations.panel.propose": "Propose",
  "integrations.panel.approve": "Approve",
  "integrations.panel.sendAnyway": "Send anyway",
  "integrations.panel.cancel": "Cancel",
  "integrations.panel.reject": "Reject",
  "integrations.panel.done": "Done",
  "integrations.preview.statement": "What will happen",
  "integrations.preview.creates": "Create ({n})",
  "integrations.preview.updates": "Update ({n})",
  "integrations.results.title": "Result",
  "integrations.results.duplicate": "Already decided — the original outcome stands.",
  "integrations.results.counts": "{applied} applied · {failed} failed",
  "integrations.chip.title": "synced {at} · shows: {external}",
  "integrations.error.offline": "You're working offline. Sign in to sync this board.",
  "integrations.context.title": "External execution",
  "integrations.context.body":
    "Lucent creates and updates tasks in the connected external system only through this preview-and-approve flow. Nothing is deleted; existing tasks change only in the fields shown. The board itself never carries provider data — links live in Lucent's integration registry.",
  "integrations.inbound.title": "External changes",
  "integrations.inbound.hint":
    "Changes detected in the connected system queue here. Nothing applies to the board until you accept it.",
  "integrations.inbound.empty": "No queued external changes.",
  "integrations.inbound.accept": "Accept",
  "integrations.inbound.dismiss": "Keep ours",
  "integrations.inbound.warning":
    '{provider} says "{value}" — Lucent has no translation for that; the board keeps its state.',
  "integrations.inbound.resolved": "The board already says {value}.",
  "integrations.inbound.row": "{provider} says {external} — the board says {board}",
  "integrations.inbound.applied": "accepted",
  "integrations.inbound.dismissed": "kept ours",
  "integrations.inbound.superseded": "overtaken by a sync",
  "integrations.inbound.decidedBy": "by {name}",
  "integrations.ai.placeholder": "Ask Lucent to draft — e.g. the launch-critical ones",
  "integrations.ai.aria": "Ask Lucent to draft a selection",
  "integrations.ai.draft": "Ask Lucent",
  "integrations.ai.ratio": "{selected} of {total} actions selected",
  "integrations.ai.rationale": "Lucent's rationale (a recommendation — you decide):",
  "integrations.ai.requested": "asked: “{request}”",
  "intel.row.blocked": "blocked by {n}",
  "intel.row.atrisk": "at risk ({n})",
  "intel.inbox.title": "Recommendations",
  "intel.inbox.empty": "No open recommendations — topics look consistent.",
  "intel.inbox.dup": "Possible duplicate topic: “{dup}” ≈ “{existing}”",
  "intel.inbox.evidence": "{a} statements on “{existing}”, {b} on “{dup}”, from {m} meeting(s)",
  "intel.inbox.merge": "Merge",
  "intel.inbox.keep": "Keep separate",
  "intel.inbox.merge.preview":
    "Merge “{dup}” → “{existing}”. This will update {n} statement(s). Nothing will be deleted.",
  "intel.inbox.merge.confirm": "Merge",
  "intel.inbox.merge.cancel": "Cancel",
  "intel.inbox.merge.failed": "The merge did not validate against the current board.",
  "a11y.skip.link": "Skip to main content",
  "canvas.status.summary": "Board {name}: {nodes} nodes, {shapes} shapes.",
  "canvas.status.selected": "Selected {n} objects.",
  "canvas.status.nothing": "Nothing selected.",
};

/**
 * Hungarian, the one non-English locale the plan asked for. Chosen because
 * it is a genuinely different language family (agglutinative, heavy
 * compounding) rather than a neighbouring Latin-script dialect, which makes
 * it an honest test of layout assumptions: strings grow, word order moves,
 * and a UI that survives `hu` survives most things.
 */
export const hu: Messages = {
  "auth.signin.title": "Bejelentkezés",
  "auth.signup.title": "Fiók létrehozása",
  "auth.email.label": "E-mail",
  "auth.password.label": "Jelszó",
  "auth.name.label": "Név",
  "auth.submit.signup": "Fiók létrehozása",
  "auth.submit.signin": "Bejelentkezés",
  "canvas.empty.title": "Írd le, mit építesz",
  "canvas.empty.hint":
    "Mondd el a saját szavaiddal — egy folyamat, egy architektúra, egy út. A diagram szerkeszthető formában jelenik meg.",
  "canvas.generating": "Válasz fogadása…",
  "canvas.generating.characters": "Válasz fogadása… {n} karakter",
  "plan.limit.title": "Elérted a csomagod korlátját",
  "plan.limit.upgrade": "Váltás nagyobb csomagra",
  "palette.hint.placeholder": "Műveletek, nézetek keresése, vagy kérd Lucenttől…",
  "palette.group.views": "Nézetek",
  "palette.group.board": "Ezen a táblán",
  "palette.group.nodes": "Csomópontok",
  "palette.group.transcript": "Átirat",
  "palette.group.revisions": "Revíziók",
  "palette.empty.none": "Nincs találat",
  "palette.empty.ask": 'Nincs találat · Nyomd meg az Entert: "{q}"',
  "palette.matched": "Találatok: {q}",
  "palette.window.truncated": "Csak az utolsó {depth} revízióban kerestünk",
  "palette.ask.bridge": "Kérd Lucentet ezekről a találatokról",
  "palette.ask.placeholder": "Kérdezz valamit erről a tábláról…",
  "palette.ask.hint": "Az Enter elküldi a kérdést; az Esc visszaáll keresésre",
  "toast.inserted": "{name} beszúrva.",
  "toast.insert.conflict": "{name} nem szúrható be — ütközik a tábla jelenlegi állapotával.",
  "intel.title": "Intelligencia",
  "exec.title": "Végrehajtás",
  "exec.subtitle": "Hogy áll a munka és mi blokkolja — a tábla végrehajtható teendőinek vetülete.",
  "exec.counts.completed": "Kész",
  "exec.counts.inProgress": "Folyamatban",
  "exec.counts.blocked": "Blokkolva",
  "exec.counts.atRisk": "Kockázat",
  "exec.counts.overdue": "Késésben",
  "exec.atRisk.title": "Egy felsőbb teendő lejárt és nincs kész — elemző jelzés, sosem állapot.",
  "exec.blocking.title": "Mi blokkol minket",
  "exec.blocking.empty": "Semmi sincs blokkolva.",
  "exec.decisions.title": "A munka mögötti döntések",
  "exec.decisions.empty": "Még nincs döntés kapcsolva folyamatban lévő munkához.",
  "exec.empty.title": "Még nincs végrehajtható munka",
  "exec.empty.hint": "Kérd Lucentet, hogy létrehozza a munkát, aztán itt kövesd nyomon.",
  "exec.attention.title": "FIGYELMET IGÉNYEL",
  "intel.subtitle":
    "A jelenlegi szemantikai munkaterület vetülete — mi igaz most, minden sor visszavezethető a forrására.",
  "intel.section.decision": "Döntések",
  "intel.section.proposal": "Javaslatok",
  "intel.section.question": "Nyitott kérdések",
  "intel.section.action": "Teendők",
  "intel.section.requirement": "Követelmények",
  "intel.section.risk": "Kockázatok",
  "intel.empty.section":
    "Még nincs {kind} — a statementek érkeznek meetingekből, a szerkesztőből és a Kérdezésből.",
  "intel.empty.view": "Még nincs mit mutatni",
  "intel.empty.view.hint":
    "A statementek akkor jelennek meg itt, ahogy meetingek, szerkesztések és beszélgetések hozzáadják őket a táblához.",
  "intel.row.assignee": "felelős: {name}",
  "intel.row.supersedes": "váltja: {n}",
  "intel.row.due": "határidő: {date}",
  "intel.row.drives": "→ {n} teendő",
  "intel.plan.from": "Terv a kijelölésből ({n})",
  "integrations.sync.button": "Szinkronizálás Linearba",
  "integrations.sync.with": "Szinkronizálás: {provider}",
  "integrations.send.to": "Küldés: {provider}",
  "integrations.sync.title": "Külső feladatok javaslása a tábla végrehajtható teendőihez",
  "integrations.not_connected": "{provider} nincs csatlakoztatva",
  "integrations.connection_disabled": "A(z) {provider} kapcsolat le van tiltva",
  "integrations.team": "Csapat: {team}",
  "integrations.repo": "Tároló: {repo}",
  "integrations.project": "Projekt: {project}",
  "integrations.warnings.title": "Ez a szolgáltató nem tud hűen minden mezőt megjeleníteni:",
  "integrations.panel.title": "Külső teendők — {provider}",
  "integrations.panel.hint":
    "Javasolj egy kötet külső feladatot; nézd át az előnézetet; hagyd jóvá a végrehajtáshoz.",
  "integrations.panel.propose": "Javaslat",
  "integrations.panel.approve": "Jóváhagyás",
  "integrations.panel.sendAnyway": "Küldés mégis",
  "integrations.panel.cancel": "Mégse",
  "integrations.panel.reject": "Elutasítás",
  "integrations.panel.done": "Kész",
  "integrations.preview.statement": "Mi fog történni",
  "integrations.preview.creates": "Létrehozás ({n})",
  "integrations.preview.updates": "Frissítés ({n})",
  "integrations.results.title": "Eredmény",
  "integrations.results.duplicate": "Már eldöntve — az eredeti eredmény érvényes.",
  "integrations.results.counts": "{applied} alkalmazva · {failed} sikertelen",
  "integrations.chip.title": "szinkronizálva {at} · ott: {external}",
  "integrations.error.offline": "Offline dolgozol. Jelentkezz be a szinkronizáláshoz.",
  "integrations.context.title": "Külső végrehajtás",
  "integrations.context.body":
    "A Lucent csak ezen az előnézet-jóváhagyás folyamaton keresztül hoz létre és frissít feladatokat a csatlakoztatott külső rendszerben. Semmi nem törlődik; a meglévő feladatok csak a mutatott mezőkben változnak. A tábla maga sosem hordoz szolgáltatói adatot — a hivatkozások a Lucent integrációs regisztrumában élnek.",
  "integrations.inbound.title": "Külső változások",
  "integrations.inbound.hint":
    "A csatlakoztatott rendszerben észlelt változások itt sorakoznak fel. Semmi nem kerül a táblára, amíg el nem fogadod.",
  "integrations.inbound.empty": "Nincs sorban álló külső változás.",
  "integrations.inbound.accept": "Elfogadás",
  "integrations.inbound.dismiss": "Maradjon a mienk",
  "integrations.inbound.warning":
    "A(z) {provider} ezt mondja: „{value}” — a Lucent nem tudja lefordítani; a tábla megtartja az állapotát.",
  "integrations.inbound.resolved": "A tábla már ezt mondja: {value}.",
  "integrations.inbound.row": "A(z) {provider} ezt mondja: {external} — a tábla ezt: {board}",
  "integrations.inbound.applied": "elfogadva",
  "integrations.inbound.dismissed": "a mienk maradt",
  "integrations.inbound.superseded": "egy szinkronizálás felülírta",
  "integrations.inbound.decidedBy": "{name} által",
  "integrations.ai.placeholder": "Kérd meg a Lucentet a vázlatra — pl. a beindítás-kritikusak",
  "integrations.ai.aria": "Kérd meg a Lucentet a szelekció megvázlatára",
  "integrations.ai.draft": "Lucent megkérése",
  "integrations.ai.ratio": "{selected} / {total} teendő kiválasztva",
  "integrations.ai.rationale": "A Lucent indoklása (javaslat — te döntesz):",
  "integrations.ai.requested": "kérés: „{request}”",
  "intel.row.blocked": "blokkolva ({n})",
  "intel.row.atrisk": "kockázat ({n})",
  "intel.inbox.title": "Javaslatok",
  "intel.inbox.empty": "Nincs nyitott javaslat — a témák konzisztentének tűnnek.",
  "intel.inbox.dup": "Lehetséges kettős téma: „{dup}” ≈ „{existing}”",
  "intel.inbox.evidence":
    "{a} statement a(z) „{existing}” témán, {b} a(z) „{dup}” témán, {m} meetingből",
  "intel.inbox.merge": "Egyesítés",
  "intel.inbox.keep": "Külön tartás",
  "intel.inbox.merge.preview":
    "„{dup}” → „{existing}” egyesítés. Ez {n} statementet frissít. Semmi nem törlődik.",
  "intel.inbox.merge.confirm": "Egyesítés",
  "intel.inbox.merge.cancel": "Mégse",
  "intel.inbox.merge.failed": "Az egyesítés nem validálódott a jelenlegi tábla ellen.",
  "a11y.skip.link": "Ugrás a fő tartalomra",
  "canvas.status.summary": "{name} tábla: {nodes} csomópont, {shapes} alakzat.",
  "canvas.status.selected": "{n} objektum kijelölve.",
  "canvas.status.nothing": "Nincs kijelölés.",
};

const BUNDLES: Record<Locale, Messages> = { en, hu };

/**
 * The `hu` bundle must carry every key `en` does — the round-trip the tests
 * pin. A key that exists only in `hu` is dead (unreachable: lookup falls
 * back before it is found); a key that exists only in `en` renders English
 * in Hungarian UIs, which the fallback rule makes tolerable but the
 * round-trip makes deliberate.
 */
export function bundleFor(locale: Locale): Messages {
  return BUNDLES[locale] ?? BUNDLES.en;
}

/**
 * Look up `key` in `locale`, falling back to English, then to the key
 * itself. The last step — the key as the value — is what makes a missing
 * string diagnosable: a rendered "toast.inserted" is a bug you can grep,
 * an empty string is a bug you have to find by screenshot.
 *
 * `params` interpolate `{name}` tokens; unknown tokens are left as-is for
 * the same reason. Replacement is single-pass over the string, so a param's
 * value containing another token's pattern cannot recurse.
 */
export function t(
  key: MessageKey,
  locale: Locale = "en",
  params?: Record<string, string | number>,
): string {
  const raw = bundleFor(locale)[key] ?? en[key] ?? key;
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/** Negotiate a locale from a BCP-47-ish tag ("hu-HU" → "hu"). */
export function resolveLocale(tag: string | undefined | null): Locale {
  if (!tag) return "en";
  const prefix = tag.toLowerCase().split("-")[0]!;
  return (LOCALES as readonly string[]).includes(prefix) ? (prefix as Locale) : "en";
}
