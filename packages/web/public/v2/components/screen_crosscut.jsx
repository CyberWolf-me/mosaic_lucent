// Screens 20-24 — Cross-cutting · Ask, Notifications, Review queue, Integrations, Admin

function ScreenAsk() { return <ScreenIntelKnowledge />; }

// ============================================================
// Screen 21 — Notifications
// ============================================================
function ScreenNotifications() {
  const go = useLucentGo();
  const [readIds, setReadIds] = useState(() => new Set());
  const markRead = (id) => {
    setReadIds(prev => {
      const next = new Set(prev);
      next.add(id);
      // Decrement the badge if this was one of the 3 "needs you" items
      if (id <= 3 && !prev.has(id)) {
        const currentUnread = 3 - next.size;
        setNotifCount(Math.max(0, currentUnread));
      }
      return next;
    });
  };
  const markAllRead = () => {
    setReadIds(new Set([1, 2, 3]));
    setNotifCount(0);
  };
  const groups = [
    {
      label: `Needs you · ${3 - readIds.size}`,
      items: [
        { id: 1, kind: 'approval', title: 'Approve 6 decisions from Checkout design review', meta: 'Extracted by Lucent · 2h ago', time: '2h', to: 22 },
        { id: 2, kind: 'assignment', title: 'You were assigned P0 · Add /pay route to Gateway', meta: 'From decision D#67 · overdue', time: '5h', to: 19 },
        { id: 3, kind: 'mention',  title: 'Sarah mentioned you in Checkout wireframe', meta: '"@Alex should we ship Klarna at launch?"', time: '4h', to: 9 },
      ],
    },
    {
      label: 'Activity · today',
      items: [
        { kind: 'meeting_end', title: 'Checkout design review ended', meta: '3 participants · 6 decisions extracted', time: '46m', to: 13 },
        { kind: 'external',    title: 'LIN-476 marked Blocked by John Torres', meta: 'Add /pay route · Payment launch', time: '2h', to: 19 },
        { kind: 'ai_flag',     title: 'Lucent flagged a conflicting decision', meta: 'Klarna decision may supersede D#42 from Sep 12', time: '3h', to: 14 },
      ],
    },
    {
      label: 'Earlier',
      items: [
        { kind: 'decision',    title: 'Decision superseded · Defer Klarna to Q1', meta: 'Replaced by today\'s Klarna-at-launch decision', time: 'yesterday', to: 14 },
        { kind: 'external',    title: '3 GitHub PRs merged for Payment launch', meta: 'feat(gateway), feat(payment-svc), test(3ds)', time: 'yesterday', to: 19 },
        { kind: 'meeting_end', title: 'Product review ended', meta: '2 decisions · 3 actions · 1 risk', time: 'Sep 18', to: 13 },
      ],
    },
  ];
  return (
    <AppShell activeArea="notif" crumbs={[{ label: 'Notifications', current: true }]}>
      <div style={{ padding: '32px 40px 60px', maxWidth: 900, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 21 · Notifications"
          title="Notifications"
          meta="3 need you · 6 activity today"
          actions={<>
            <button className="icon-btn" onClick={markAllRead} title="Mark all as read">Mark all read</button>
            <button
              className="icon-btn"
              onClick={() => go(24)}
              title="Notification preferences"
            ><Ico.Settings /> Preferences</button>
          </>}
        />
        {groups.map((g, i) => (
          <div key={i} style={{ marginBottom: 28 }}>
            <div className="mono-caps" style={{ marginBottom: 10 }}>{g.label}</div>
            <div style={{ display: 'grid', gap: 6 }}>
              {g.items.map((it, j) => <NotifRow key={it.id || j} {...it} read={it.id && readIds.has(it.id)} onView={() => it.id && markRead(it.id)} />)}
            </div>
          </div>
        ))}
      </div>
    </AppShell>
  );
}

function NotifRow({ kind, title, meta, time, to, read, onView }) {
  const go = useLucentGo();
  const kindMap = {
    approval:    { icon: <Ico.Sparkle />,  color: 'var(--bloom-2)' },
    assignment:  { icon: <ActionIcon />,   color: 'var(--moss)' },
    mention:     { icon: <Ico.Comment />,  color: 'oklch(0.55 0.11 220)' },
    meeting_end: { icon: <Ico.Present />,  color: 'var(--madder)' },
    external:    { icon: <LinearMark />,   color: 'oklch(0.5 0.14 265)' },
    ai_flag:     { icon: <Ico.Sparkle />,  color: 'var(--bloom-2)' },
    decision:    { icon: <DecisionIcon />, color: 'var(--bloom-2)' },
  }[kind];
  return (
    <button
      onClick={() => { if (onView) onView(); if (to) go(to); }}
      style={{
        padding: '12px 14px',
        borderRadius: 10,
        background: 'var(--paper-0)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        display: 'flex', alignItems: 'flex-start', gap: 12,
        textAlign: 'left', cursor: 'pointer',
        transition: 'all 0.12s',
        opacity: read ? 0.55 : 1,
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--paper-1)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'var(--paper-0)'; }}
    >
      {!read && <span style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--bloom-2)', flexShrink: 0, marginTop: 8, boxShadow: '0 0 6px var(--bloom-glow)' }} />}
      <div style={{
        width: 28, height: 28, borderRadius: 7,
        background: `oklch(from ${kindMap.color} l c h / 0.14)`, color: kindMap.color,
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>{kindMap.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 3 }}>{title}</div>
        <div style={{ fontSize: 12, color: 'var(--ink-2)', lineHeight: 1.4, fontFamily: 'var(--font-serif)', fontStyle: 'italic' }}>{meta}</div>
      </div>
      <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', whiteSpace: 'nowrap' }}>{time}</span>
    </button>
  );
}

// ============================================================
// Screen 22 — Review queue
// ============================================================
function ScreenReviewQueue() {
  const go = useLucentGo();
  const [items, setItems] = useState([
    { id: 1, kind: 'decision', status: null },
    { id: 2, kind: 'decision', status: null },
    { id: 3, kind: 'action',   status: null },
    { id: 4, kind: 'risk',     status: null },
    { id: 5, kind: 'question', status: null },
    { id: 6, kind: 'edit',     status: null },
  ]);
  const setStatus = (id, status) => setItems(items => items.map(x => x.id === id ? { ...x, status } : x));
  const remaining = items.filter(x => !x.status).length;
  return (
    <AppShell activeArea="notif" crumbs={[{ label: 'Notifications', screen: 21 }, { label: 'Review queue', current: true }]}>
      <div style={{ padding: '32px 40px 60px', maxWidth: 900, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 22 · Review queue"
          title="AI proposes; you decide."
          meta={remaining === 0 ? "All caught up" : `${remaining} item${remaining === 1 ? '' : 's'} · from Checkout design review`}
          actions={<>
            <button
              className="btn ghost"
              style={{ height: 32, fontSize: 12.5, cursor: remaining ? 'pointer' : 'default', opacity: remaining ? 1 : 0.4 }}
              disabled={!remaining}
              onClick={() => setItems(items => items.map(x => x.status ? x : { ...x, status: 'rejected' }))}
            >Reject all</button>
            <button
              className="btn bloom"
              disabled={!remaining}
              onClick={() => setItems(items => items.map(x => x.status ? x : { ...x, status: 'approved' }))}
              style={{ height: 32, fontSize: 12.5, flex: 'none', padding: '0 16px', cursor: remaining ? 'pointer' : 'default', opacity: remaining ? 1 : 0.4 }}
            >
              <Ico.Check /> Approve all
            </button>
          </>}
        />
        <div style={{ display: 'grid', gap: 14 }}>
          {[
            { id: 1, kind: 'decision', title: 'Payment Service goes behind the API gateway',
              summary: 'Alex proposed placing the new Payment Service inside the existing edge routing rather than as its own external endpoint. Everyone verbally agreed.',
              from: { icon: <Ico.Present />, label: 'Checkout design review · 14:32' }, when: '46m ago' },
            { id: 2, kind: 'decision', title: 'Support Klarna as a payment method at launch',
              summary: 'John noted that Klarna alone lifted conversion +8% at Northbeam. This SUPERSEDES decision D#42 (Sep 12) which deferred Klarna to Q1 2027.',
              from: { icon: <Ico.Present />, label: 'Checkout design review · 14:34' }, when: '42m ago' },
            { id: 3, kind: 'action', title: 'John: integrate Klarna sandbox in staging by Monday',
              summary: 'Direct assignment from the transcript. Creates Linear issue in Payment launch project. P0 priority.',
              from: { icon: <Ico.Present />, label: 'Checkout design review · 14:35' }, when: '41m ago',
              changes: [
                { count: 1, label: 'Linear issue created', color: 'oklch(0.5 0.14 265)' },
                { count: 1, label: 'GitHub milestone updated' },
              ] },
            { id: 4, kind: 'risk', title: 'Stripe 3DS callback validation is untested in staging',
              summary: 'Extracted from John\'s discussion of the retry policy. Medium severity, medium probability.',
              from: { icon: <Ico.Present />, label: 'Checkout design review · 14:38' }, when: '38m ago' },
            { id: 5, kind: 'question', title: 'Should silent retries surface a message to the user after N attempts?',
              summary: 'Unresolved during the meeting. Assigned to Sarah for a UX call before Fri.',
              from: { icon: <Ico.Present />, label: 'Checkout design review · 14:40' }, when: '36m ago' },
            { id: 6, kind: 'edit', title: 'Add Payment Service and Redis Cache to E-commerce architecture',
              summary: 'Canvas change: 2 new nodes, 4 new edges, 1 existing node modified (API Gateway routes).',
              from: { icon: <Ico.Layers />, label: 'E-commerce platform · board' }, when: '34m ago',
              changes: [
                { count: 2, label: 'nodes added', color: 'var(--moss)' },
                { count: 4, label: 'edges added', color: 'var(--moss)' },
                { count: 1, label: 'node modified', color: 'var(--bloom-2)' },
              ] },
          ].map(card => {
            const state = items.find(x => x.id === card.id);
            if (state && state.status) {
              return <SettledApproval key={card.id} card={card} status={state.status} onUndo={() => setStatus(card.id, null)} />;
            }
            return (
              <ApprovalCard
                key={card.id}
                {...card}
                onApprove={() => setStatus(card.id, 'approved')}
                onReject={() => setStatus(card.id, 'rejected')}
                onEdit={() => setStatus(card.id, 'edited')}
              />
            );
          })}
          {remaining === 0 && (
            <div style={{
              padding: '32px 24px', borderRadius: 14,
              background: 'oklch(from var(--moss) l c h / 0.06)',
              border: '1px solid oklch(from var(--moss) l c h / 0.3)',
              textAlign: 'center',
            }}>
              <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, color: 'var(--ink-0)', marginBottom: 6 }}>
                <Ico.Check style={{ display: 'inline', color: 'var(--moss)', marginRight: 6, verticalAlign: -2 }} />
                All caught up
              </div>
              <div style={{ fontSize: 13, color: 'var(--ink-2)' }}>
                6 items reviewed. Lucent will queue anything new here.
              </div>
              <button
                className="btn bloom"
                onClick={() => go(3)}
                style={{ marginTop: 14, height: 32, padding: '0 16px', flex: 'none' }}
              >
                Open board →
              </button>
            </div>
          )}
        </div>
      </div>
    </AppShell>
  );
}

function SettledApproval({ card, status, onUndo }) {
  const styleMap = {
    approved: { color: 'var(--moss)', label: 'Approved', icon: <Ico.Check /> },
    rejected: { color: 'var(--madder)', label: 'Rejected', icon: <Ico.X /> },
    edited:   { color: 'var(--saffron)', label: 'Editing', icon: <Ico.Pen /> },
  };
  const s = styleMap[status];
  return (
    <div style={{
      padding: '12px 16px',
      borderRadius: 12,
      background: 'oklch(from var(--paper-2) l c h / 0.5)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        width: 26, height: 26, borderRadius: 7,
        background: `oklch(from ${s.color} l c h / 0.14)`, color: s.color,
        display: 'grid', placeItems: 'center', flexShrink: 0,
      }}>{s.icon}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--ink-1)', opacity: 0.85 }}>
          <span style={{
            padding: '1px 8px', borderRadius: 4,
            background: `oklch(from ${s.color} l c h / 0.15)`, color: s.color,
            fontFamily: 'var(--font-mono)', fontSize: 9.5, fontWeight: 700, letterSpacing: '0.06em',
            marginRight: 8,
          }}>{s.label.toUpperCase()}</span>
          {card.title}
        </div>
      </div>
      <button
        onClick={onUndo}
        style={{ fontSize: 11.5, padding: '4px 10px', borderRadius: 6, color: 'var(--ink-1)', background: 'var(--paper-0)', border: '1px solid oklch(from var(--paper-4) l c h / 0.6)' }}
      >Undo</button>
    </div>
  );
}

// ============================================================
// Screen 23 — Integrations
// ============================================================
function ScreenIntegrations() {
  const connected = [
    { name: 'Linear',       kind: 'Issues',   mark: <LinearMark />, status: 'active', activity: '4 issues synced today' },
    { name: 'GitHub',       kind: 'Code',     mark: <GithubMark />, status: 'active', activity: '3 PRs · 12 commits linked' },
    { name: 'Slack',        kind: 'Chat',     mark: <SlackMark />,  status: 'active', activity: '2 threads linked to actions' },
    { name: 'Google Meet',  kind: 'Meetings', mark: <GmeetMark />,  status: 'active', activity: '1 meeting joined today' },
    { name: 'Zoom',         kind: 'Meetings', mark: <ZoomMark />,   status: 'idle',   activity: '0 today · idle' },
    { name: 'Google Drive', kind: 'Storage',  mark: <DriveMark />,  status: 'active', activity: '2 files attached this week' },
    { name: 'Notion',       kind: 'Docs',     mark: <NotionMark />, status: 'idle',   activity: 'no activity in 3 weeks' },
  ];
  const available = [
    { name: 'Jira',      kind: 'Issues', mark: <JiraMark /> },
    { name: 'Asana',     kind: 'Tasks',  mark: <Ico.Folder /> },
    { name: 'Confluence',kind: 'Docs',   mark: <Ico.Book /> },
    { name: 'Figma',     kind: 'Design', mark: <FigmaMark /> },
    { name: 'ClickUp',   kind: 'Tasks',  mark: <ActionIcon /> },
    { name: 'GitLab',    kind: 'Code',   mark: <GithubMark /> },
  ];
  return (
    <AppShell activeArea="admin" crumbs={[{ label: 'Admin', screen: 24 }, { label: 'Integrations', current: true }]}>
      <div style={{ padding: '32px 40px 60px', maxWidth: 1100, margin: '0 auto' }}>
        <SectionHeader
          eyebrow="Fig. 23 · Integrations"
          title="Connected systems"
          meta="Lucent is the intelligence layer, not a replacement."
          actions={<button className="icon-btn primary"><Ico.Plus /> Connect more</button>}
        />
        <div className="mono-caps" style={{ marginBottom: 12 }}>Connected · {connected.length}</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
          gap: 12, marginBottom: 36,
        }}>
          {connected.map((c, i) => <IntegrationCard key={i} {...c} connected />)}
        </div>
        <div className="mono-caps" style={{ marginBottom: 12 }}>Available</div>
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
          gap: 10,
        }}>
          {available.map((a, i) => <IntegrationCard key={i} {...a} />)}
        </div>

        <div className="mono-caps" style={{ marginBottom: 12, marginTop: 36 }}>Sync activity · last 24h</div>
        <div style={{
          padding: '16px 20px',
          background: 'var(--paper-0)',
          border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          borderRadius: 12,
        }}>
          {[
            { icon: <LinearMark />, text: 'LIN-476 · marked Blocked · linked to action "Add /pay route"', time: '2h ago' },
            { icon: <GithubMark />, text: 'PR #482 · draft opened by @jtorres · linked to LIN-476',      time: '5h ago' },
            { icon: <SlackMark />,  text: '#payments-launch · 1 thread linked to Payment Service risk',  time: '5h ago' },
            { icon: <LinearMark />, text: 'LIN-473 · closed by @jtorres · action marked Done',           time: 'yesterday' },
            { icon: <GithubMark />, text: 'PR #481 · merged · closes 2 actions',                          time: 'yesterday' },
          ].map((r, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 0',
              borderBottom: i < 4 ? '1px solid oklch(from var(--paper-4) l c h / 0.4)' : 'none',
            }}>
              <span style={{ color: 'var(--ink-2)', display: 'grid', placeItems: 'center' }}>{r.icon}</span>
              <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-0)' }}>{r.text}</span>
              <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{r.time}</span>
            </div>
          ))}
        </div>
      </div>
    </AppShell>
  );
}
function GmeetMark() { return <svg width="11" height="11" viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2" fill="#00832d"/><path d="M16 10l6-2v8l-6-2z" fill="#0066da"/></svg>; }

function IntegrationCard({ name, kind, mark, status, activity, connected }) {
  return (
    <div style={{
      padding: '14px 16px', borderRadius: 12,
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      display: 'flex', alignItems: 'center', gap: 12,
    }}>
      <div style={{
        width: 34, height: 34, borderRadius: 8,
        background: 'var(--paper-2)',
        display: 'grid', placeItems: 'center',
        color: 'var(--ink-1)', flexShrink: 0,
      }}>{mark}</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 13.5, fontWeight: 500, color: 'var(--ink-0)' }}>{name}</span>
          {connected && (
            <span style={{
              width: 7, height: 7, borderRadius: 999,
              background: status === 'active' ? 'var(--moss)' : 'var(--ink-3)',
            }} />
          )}
        </div>
        <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 2, letterSpacing: '0.02em' }}>
          {connected ? activity : kind}
        </div>
      </div>
      {connected ? (
        <button style={{ fontSize: 11.5, color: 'var(--ink-2)', padding: '4px 8px', borderRadius: 6, background: 'var(--paper-2)' }}>Manage</button>
      ) : (
        <button className="icon-btn" style={{ height: 28, fontSize: 12 }}>Connect</button>
      )}
    </div>
  );
}

// ============================================================
// Screen 24 — Admin console
// ============================================================
function ScreenAdmin() {
  const go = useLucentGo();
  const [section, setSection] = useState('members');
  return (
    <AppShell activeArea="admin" crumbs={[{ label: 'Northbeam', current: false }, { label: 'Admin', current: true }]}>
      <div style={{ display: 'flex', height: '100%' }}>
        <div style={{
          width: 220, flexShrink: 0,
          borderRight: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          padding: '24px 12px',
          overflow: 'auto',
        }}>
          <div className="mono-caps" style={{ padding: '0 12px', marginBottom: 10 }}>Organization</div>
          <AdminNavItem label="Members · 14"  active={section === 'members'} onClick={() => setSection('members')} icon={<TeamIcon2 />} />
          <AdminNavItem label="Teams · 4"      active={section === 'teams'}   onClick={() => setSection('teams')}   icon={<TeamIcon2 />} />
          <AdminNavItem label="Roles"          active={section === 'roles'}   onClick={() => setSection('roles')}   icon={<Ico.User />} />
          <AdminNavItem label="Guests · 2"     active={section === 'guests'}  onClick={() => setSection('guests')}  icon={<Ico.User />} />

          <div className="mono-caps" style={{ padding: '20px 12px 10px' }}>Security</div>
          <AdminNavItem label="Authentication · SSO" active={section === 'sso'}      onClick={() => setSection('sso')}      icon={<AuthIcon2 />} />
          <AdminNavItem label="Sessions · MFA"       active={section === 'sessions'} onClick={() => setSection('sessions')} icon={<AuthIcon2 />} />
          <AdminNavItem label="AI policies"          active={section === 'ai'}       onClick={() => setSection('ai')}       icon={<Ico.Sparkle />} />
          <AdminNavItem label="Classification"       active={section === 'classification'} onClick={() => setSection('classification')} icon={<Ico.Layers />} />
          <AdminNavItem label="Audit log"            active={section === 'audit'}    onClick={() => setSection('audit')}    icon={<Ico.History />} />

          <div className="mono-caps" style={{ padding: '20px 12px 10px' }}>Data</div>
          <AdminNavItem label="Retention"          active={section === 'retention'} onClick={() => setSection('retention')} icon={<Ico.History />} />
          <AdminNavItem label="Integrations"       onClick={() => go(23)} icon={<Ico.Layers />} />
          <AdminNavItem label="Data export"        active={section === 'export'}   onClick={() => setSection('export')}   icon={<Ico.Folder />} />
          <AdminNavItem label="Data deletion"      active={section === 'deletion'} onClick={() => setSection('deletion')} icon={<Ico.X />} />

          <div className="mono-caps" style={{ padding: '20px 12px 10px' }}>Billing</div>
          <AdminNavItem label="Plan · Team"        active={section === 'billing'}  onClick={() => setSection('billing')}  icon={<Ico.Book />} />
          <AdminNavItem label="Usage"              active={section === 'usage'}    onClick={() => setSection('usage')}    icon={<Ico.Book />} />
          <AdminNavItem label="Invoices"           active={section === 'invoices'} onClick={() => setSection('invoices')} icon={<Ico.Book />} />
        </div>

        <div style={{ flex: 1, overflow: 'auto', padding: '32px 40px 60px' }}>
          {section === 'members' && <AdminMembers />}
          {section === 'teams'   && <AdminMembers />}
          {section === 'roles'   && <AdminRoles />}
          {section === 'guests'  && <AdminStub title="Guests" desc="External collaborators granted limited access to specific workspaces." kind="Guest access" />}
          {section === 'sso'     && <AdminStub title="Authentication · SSO" desc="Configure SAML 2.0 or OIDC with your identity provider." kind="Identity provider" />}
          {section === 'sessions'&& <AdminStub title="Sessions · MFA" desc="Active device sessions and multi-factor enrolment." kind="Session policy" />}
          {section === 'ai'      && <AdminAI />}
          {section === 'classification' && <AdminStub title="Classification" desc="Internal / Confidential / Restricted labels and policies." kind="Data classification" />}
          {section === 'audit'   && <AdminAudit />}
          {section === 'retention' && <AdminStub title="Retention" desc="How long AI conversation context, transcripts, and audit trails are kept." kind="Retention policy" />}
          {section === 'export'  && <AdminStub title="Data export" desc="Export your entire organization's data as a signed archive." kind="Export request" />}
          {section === 'deletion'&& <AdminStub title="Data deletion" desc="Permanently delete an object, workspace, or the entire organization (audited)." kind="Deletion request" danger />}
          {section === 'billing' && <AdminBilling />}
          {section === 'usage'   && <AdminStub title="Usage" desc="Detailed breakdown by member and project." kind="Usage report" />}
          {section === 'invoices'&& <AdminStub title="Invoices" desc="Past invoices, receipts, and billing history." kind="Invoice" />}
        </div>
      </div>
    </AppShell>
  );
}

function AdminNavItem({ label, active, onClick, icon }) {
  return (
    <button onClick={onClick} style={{
      display: 'flex', alignItems: 'center', gap: 8,
      width: '100%',
      padding: '6px 12px',
      borderRadius: 6,
      fontSize: 12.5,
      color: active ? 'var(--ink-0)' : 'var(--ink-1)',
      background: active ? 'var(--paper-2)' : 'transparent',
      fontWeight: active ? 500 : 400,
      textAlign: 'left',
    }}
      onMouseEnter={e => !active && (e.currentTarget.style.background = 'var(--paper-2)')}
      onMouseLeave={e => !active && (e.currentTarget.style.background = 'transparent')}
    >
      <span style={{ color: 'var(--ink-3)', display: 'grid', placeItems: 'center' }}>{icon}</span>
      {label}
    </button>
  );
}
function TeamIcon2() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="9" r="3"/><circle cx="16" cy="11" r="2.5"/><path d="M3 20c1-3 3-4.5 5-4.5s4 1.5 5 4.5M14 20c1-2.5 2-3.5 3-4"/></svg>; }
function AuthIcon2() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2a10 10 0 0 1 10 10c0 5.5-4.5 10-10 10S2 17.5 2 12a10 10 0 0 1 10-10z"/><path d="M9 12l2 2 4-4"/></svg>; }
function SCIMIcon() { return <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"><path d="M12 3v18M3 12h18"/><circle cx="12" cy="12" r="9"/></svg>; }

function AdminMembers() {
  const members = [
    { name: 'Alex Kim',    email: 'alex@northbeam.co',    role: 'Owner',  color: 'oklch(0.55 0.16 25)', last: 'now' },
    { name: 'Sarah Chen',  email: 'sarah@northbeam.co',   role: 'Admin',  color: 'oklch(0.55 0.11 220)', last: '2h ago' },
    { name: 'John Torres', email: 'john@northbeam.co',    role: 'Editor', color: 'oklch(0.55 0.14 148)', last: '1h ago' },
    { name: 'Kim Park',    email: 'kim@northbeam.co',     role: 'Editor', color: 'oklch(0.55 0.16 300)', last: 'yesterday' },
    { name: 'Marco Rossi', email: 'marco@northbeam.co',   role: 'Editor', color: 'oklch(0.55 0.14 200)', last: '3 days ago' },
    { name: 'Ana López',   email: 'ana@northbeam.co',     role: 'Editor', color: 'oklch(0.55 0.16 40)',  last: 'yesterday' },
    { name: 'Guest · Stripe', email: 'partner@stripe.com', role: 'Guest', color: 'oklch(0.6 0.005 60)',  last: 'Sep 15', guest: true },
  ];
  return (
    <>
      <SectionHeader
        eyebrow="Fig. 24 · Admin"
        title="Members"
        meta="14 members · 2 guests · 1 pending invite"
        actions={<>
          <button className="icon-btn"><SCIMIcon /> SCIM · syncing</button>
          <button className="icon-btn primary"><Ico.Plus /> Invite</button>
        </>}
      />
      <FilterBar
        filters={[
          { id: 'all', label: 'All', count: members.length },
          { id: 'admin', label: 'Admins', count: 2 },
          { id: 'editor', label: 'Editors', count: 5 },
          { id: 'guest', label: 'Guests', count: 1 },
          { id: 'invite', label: 'Pending', count: 1 },
        ]}
        active="all"
      />
      <div style={{
        background: 'var(--paper-0)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        borderRadius: 12,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 100px 100px 40px',
          padding: '10px 16px',
          borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
          background: 'oklch(from var(--paper-2) l c h / 0.5)',
        }} className="mono-caps">
          <span>Name</span>
          <span>Role</span>
          <span>Last active</span>
          <span>MFA</span>
          <span></span>
        </div>
        {members.map((m, i) => (
          <div key={i} style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 100px 100px 40px',
            padding: '10px 16px',
            borderBottom: i < members.length - 1 ? '1px solid oklch(from var(--paper-4) l c h / 0.4)' : 'none',
            alignItems: 'center',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{
                width: 28, height: 28, borderRadius: 999,
                background: m.color, color: 'white',
                display: 'grid', placeItems: 'center',
                fontFamily: 'var(--font-mono)', fontSize: 10, fontWeight: 700,
              }}>{m.name.split(' ').map(n => n[0]).join('')}</div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{m.name}</div>
                <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)' }}>{m.email}</div>
              </div>
            </div>
            <div>
              <span style={{
                padding: '2px 8px', borderRadius: 4,
                fontSize: 11, fontWeight: 500,
                background: m.role === 'Owner' ? 'var(--ink-0)' : m.role === 'Admin' ? 'var(--bloom-wash-2)' : m.role === 'Guest' ? 'oklch(from var(--ink-3) l c h / 0.2)' : 'oklch(from var(--paper-3) l c h / 0.9)',
                color: m.role === 'Owner' ? 'var(--paper-0)' : m.role === 'Admin' ? 'var(--bloom-2)' : 'var(--ink-1)',
              }}>{m.role}</span>
            </div>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{m.last}</span>
            <span>{!m.guest && <Ico.Check style={{ color: 'var(--moss)' }} />}</span>
            <span style={{ color: 'var(--ink-3)', textAlign: 'right', cursor: 'pointer' }}>⋯</span>
          </div>
        ))}
      </div>
    </>
  );
}

function AdminAI() {
  return (
    <>
      <SectionHeader eyebrow="Fig. 24 · Admin · AI policies" title="AI governance" meta="What Lucent's AI is allowed to do, and where the data flows." />
      <div style={{ display: 'grid', gap: 14 }}>
        <PolicyCard
          label="Approved providers"
          desc="Which model providers Lucent can call for this organization."
          value={<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <ProviderChip name="Anthropic" model="Claude 3.5 Sonnet" allowed />
            <ProviderChip name="OpenAI"    model="GPT-4o" allowed />
            <ProviderChip name="Google" model="Gemini 1.5" blocked />
          </div>}
        />
        <PolicyCard
          label="Data egress"
          desc="Which classifications are allowed to be sent to external providers."
          value={<div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <span className="mono" style={{ padding: '3px 10px', borderRadius: 4, background: 'var(--moss)', color: 'white', fontSize: 10, fontWeight: 700 }}>INTERNAL</span>
            <span className="mono" style={{ padding: '3px 10px', borderRadius: 4, background: 'var(--saffron)', color: 'oklch(0.2 0.04 60)', fontSize: 10, fontWeight: 700 }}>CONFIDENTIAL</span>
            <span className="mono" style={{ padding: '3px 10px', borderRadius: 4, background: 'oklch(from var(--madder) l c h / 0.2)', color: 'var(--madder)', fontSize: 10, fontWeight: 700 }}>RESTRICTED · blocked</span>
          </div>}
        />
        <PolicyCard
          label="Auto-approval"
          desc="Which AI actions can execute without a human in the loop."
          value={<div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <PolicyPill label="Draft board · always require review" />
            <PolicyPill label="Meeting intelligence · always require review" />
            <PolicyPill label="Comments only · auto-approved" on />
            <PolicyPill label="Layout / geometry · auto-approved" on />
          </div>}
        />
        <PolicyCard
          label="Retention"
          desc="How long AI conversation context and audit trails are kept."
          value={<span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--ink-1)' }}>
            Prompts &amp; responses · <b>90 days</b> · Audit trail · <b>7 years</b> · Transcripts · <b>2 years</b>
          </span>}
        />
      </div>
    </>
  );
}
function PolicyCard({ label, desc, value }) {
  return (
    <div style={{
      padding: '18px 20px',
      background: 'var(--paper-0)',
      border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
      borderRadius: 12,
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 6 }}>
        <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--ink-0)' }}>{label}</div>
        <div style={{ flex: 1 }} />
        <button style={{ fontSize: 11.5, color: 'var(--bloom-2)' }}>Edit</button>
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--ink-2)', lineHeight: 1.5, marginBottom: 12 }}>{desc}</div>
      {value}
    </div>
  );
}
function ProviderChip({ name, model, allowed, blocked }) {
  return (
    <div style={{
      padding: '4px 10px',
      borderRadius: 6,
      background: allowed ? 'oklch(from var(--moss) l c h / 0.1)' : 'oklch(from var(--madder) l c h / 0.08)',
      border: `1px solid ${allowed ? 'oklch(from var(--moss) l c h / 0.3)' : 'oklch(from var(--madder) l c h / 0.3)'}`,
      color: allowed ? 'var(--moss)' : 'var(--madder)',
      fontFamily: 'var(--font-mono)', fontSize: 10.5, fontWeight: 600,
      textDecoration: blocked ? 'line-through' : 'none',
    }}>{name} · {model}</div>
  );
}
function PolicyPill({ label, on }) {
  return (
    <span style={{
      padding: '4px 10px', borderRadius: 999,
      background: on ? 'oklch(from var(--moss) l c h / 0.12)' : 'oklch(from var(--paper-3) l c h / 0.7)',
      color: on ? 'var(--moss)' : 'var(--ink-2)',
      border: `1px solid ${on ? 'oklch(from var(--moss) l c h / 0.3)' : 'oklch(from var(--paper-4) l c h / 0.5)'}`,
      fontSize: 11.5, fontWeight: 500,
      display: 'inline-flex', alignItems: 'center', gap: 5,
    }}>
      {on && <Ico.Check style={{ width: 11, height: 11 }} />}
      {label}
    </span>
  );
}

function AdminAudit() {
  const lines = [
    '[2026-09-20 14:38:12] alex@northbeam.co  · action.approve · decision "Payment Service goes behind the gateway" · provider=Anthropic model=claude-sonnet-4.5 confidence=0.94',
    '[2026-09-20 14:32:04] LUCENT_SYSTEM      · ai.extract       · decision proposed from meeting "Checkout design review" utterance@14:28',
    '[2026-09-20 14:12:00] alex@northbeam.co  · meeting.start    · Checkout design review · participants=3 · classification=INTERNAL',
    '[2026-09-20 11:04:33] LUCENT_SYSTEM      · integration.sync · Linear · LIN-476 status=Blocked · linked action id=a_67f',
    '[2026-09-20 09:22:41] sarah@northbeam.co · board.edit       · E-commerce platform · 3 nodes added · 2 edges',
    '[2026-09-20 09:14:00] alex@northbeam.co  · session.start    · SSO · Google · MFA=TOTP · ip=203.0.113.42',
    '[2026-09-19 18:44:12] LUCENT_SYSTEM      · retention.purge  · prompts>90d · 1,204 records',
    '[2026-09-19 16:02:08] admin@northbeam.co · policy.edit      · ai.provider blocked=Google (gemini-1.5)',
    '[2026-09-19 11:28:56] john@northbeam.co  · export.decisions · scope="Payment launch" · format=JSON · size=42kb',
  ];
  return (
    <>
      <SectionHeader eyebrow="Fig. 24 · Admin · Audit" title="Audit log" meta="Every AI action, every human approval, every sync." />
      <FilterBar
        filters={[
          { id: 'all', label: 'All' },
          { id: 'ai', label: 'AI actions' },
          { id: 'auth', label: 'Auth' },
          { id: 'perm', label: 'Permissions' },
          { id: 'export', label: 'Data export' },
        ]}
        active="all"
      />
      <div style={{
        background: 'oklch(0.14 0.014 55)',
        borderRadius: 12,
        padding: '18px 22px',
        fontFamily: 'var(--font-mono)',
        fontSize: 11.5,
        lineHeight: 1.7,
        overflow: 'auto',
      }}>
        {lines.map((line, i) => (
          <div key={i} style={{ padding: '4px 0', borderBottom: i < lines.length - 1 ? '1px solid oklch(0.22 0.014 55)' : 'none' }}>
            <span style={{ color: 'oklch(0.55 0.012 60)' }}>{line.substring(0, 22)}</span>
            <span style={{ color: 'oklch(0.7 0.05 60)' }}>{line.substring(22, 42)}</span>
            <span style={{ color: 'oklch(0.72 0.15 300)' }}>{line.substring(42, 60)}</span>
            <span style={{ color: 'oklch(0.9 0.008 82)' }}>{line.substring(60)}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function AdminBilling() {
  return (
    <>
      <SectionHeader eyebrow="Fig. 24 · Admin · Billing" title="Team plan" meta="$40 / member / month · 14 members" actions={<button className="icon-btn primary">Upgrade plan</button>} />
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
        <StatCard label="AI tokens this month" value="2.4M" delta="+18%" sub="of 5M included" />
        <StatCard label="Meeting minutes"      value="612"  delta="+42h" sub="unlimited" />
        <StatCard label="Storage"              value="18GB" sub="of 100GB" />
        <StatCard label="Members · seats"      value="14 / 20" />
      </div>
      <div style={{
        padding: '20px 22px',
        background: 'var(--paper-0)',
        border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
        borderRadius: 12,
      }}>
        <div className="mono-caps" style={{ marginBottom: 12 }}>Usage · September</div>
        <UsageChart />
      </div>
    </>
  );
}

function UsageChart() {
  const bars = Array.from({ length: 20 }, (_, i) => 20 + Math.round(Math.abs(Math.sin(i * 0.6)) * 60) + i * 2);
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 4, height: 120 }}>
        {bars.map((h, i) => (
          <div key={i} style={{
            flex: 1, height: `${h}%`,
            background: `linear-gradient(180deg, var(--bloom-1), var(--bloom-2))`,
            borderRadius: '3px 3px 0 0',
            opacity: 0.6 + (i / bars.length) * 0.4,
          }} />
        ))}
      </div>
      <div style={{ display: 'flex', marginTop: 12, fontFamily: 'var(--font-mono)', fontSize: 10.5, color: 'var(--ink-3)' }}>
        <span>Sep 1</span>
        <div style={{ flex: 1 }} />
        <span>Sep 10</span>
        <div style={{ flex: 1 }} />
        <span>Sep 20 · today</span>
      </div>
    </div>
  );
}

// Reusable stub for admin sections that don't have a full detail view yet
function AdminStub({ title, desc, kind, danger }) {
  return (
    <>
      <SectionHeader eyebrow={`Fig. 24 · Admin · ${title}`} title={title} meta={desc} />
      <div style={{
        padding: '48px 32px',
        background: 'var(--paper-0)',
        border: `1px dashed ${danger ? 'oklch(from var(--madder) l c h / 0.4)' : 'oklch(from var(--paper-4) l c h / 0.6)'}`,
        borderRadius: 14,
        textAlign: 'center',
      }}>
        <div style={{
          width: 44, height: 44, borderRadius: 12,
          background: danger ? 'oklch(from var(--madder) l c h / 0.1)' : 'var(--paper-2)',
          color: danger ? 'var(--madder)' : 'var(--ink-2)',
          display: 'grid', placeItems: 'center',
          margin: '0 auto 14px',
        }}><Ico.Settings /></div>
        <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontWeight: 500, color: 'var(--ink-0)', marginBottom: 6 }}>
          {kind} configuration
        </div>
        <div style={{ fontSize: 13.5, color: 'var(--ink-2)', maxWidth: 420, margin: '0 auto', lineHeight: 1.55 }}>
          This detail view is scaffolded but not fully populated in this prototype.
          The endpoints exist in <span className="mono" style={{ background: 'var(--paper-2)', padding: '1px 6px', borderRadius: 3, fontSize: 11 }}>docs/API.md § 20</span> under the corresponding section.
        </div>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center', marginTop: 20 }}>
          <button className="btn ghost">Learn more</button>
          <button className={`btn ${danger ? 'danger' : 'primary'}`} style={{ flex: 'none', padding: '0 18px' }}>
            {danger ? 'Request…' : 'Configure'}
          </button>
        </div>
      </div>
    </>
  );
}

function AdminRoles() {
  return (
    <>
      <SectionHeader eyebrow="Fig. 24 · Admin · Roles" title="Roles &amp; permissions" />
      <div style={{ display: 'grid', gap: 12 }}>
        {[
          { role: 'Owner',    scope: 'Everything · billing · deletion · policies',   count: 1 },
          { role: 'Admin',    scope: 'Members · integrations · classification',       count: 2 },
          { role: 'Editor',   scope: 'Boards · meetings · actions · comments',        count: 8 },
          { role: 'Commenter',scope: 'View + comment · no editing',                    count: 2 },
          { role: 'Viewer',   scope: 'View only',                                      count: 1 },
          { role: 'Guest',    scope: 'Limited · per invitation',                        count: 1 },
        ].map((r, i) => (
          <div key={i} style={{
            padding: '14px 16px',
            background: 'var(--paper-0)',
            border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
            borderRadius: 10,
            display: 'flex', alignItems: 'center', gap: 14,
          }}>
            <div style={{
              padding: '4px 12px', borderRadius: 6,
              background: 'var(--ink-0)', color: 'var(--paper-0)',
              fontSize: 12, fontWeight: 600,
              minWidth: 100, textAlign: 'center',
            }}>{r.role}</div>
            <span style={{ flex: 1, fontSize: 12.5, color: 'var(--ink-2)' }}>{r.scope}</span>
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-3)' }}>{r.count} member{r.count === 1 ? '' : 's'}</span>
          </div>
        ))}
      </div>
    </>
  );
}

Object.assign(window, { ScreenAsk, ScreenNotifications, ScreenReviewQueue, ScreenIntegrations, ScreenAdmin });
