// Lucent v2 — Screen 00: Design System reference page
// Editorial layout that documents tokens + components in situ.

function ScreenDesignSystem() {
  const colors = [
    { name: '--paper-0', v: 'oklch(0.980 0.014 85)', bg: 'var(--paper-0)', fg: 'var(--ink-0)' },
    { name: '--paper-1', v: 'oklch(0.965 0.020 85)', bg: 'var(--paper-1)', fg: 'var(--ink-0)' },
    { name: '--paper-2', v: 'oklch(0.945 0.024 84)', bg: 'var(--paper-2)', fg: 'var(--ink-0)' },
    { name: '--paper-3', v: 'oklch(0.910 0.028 83)', bg: 'var(--paper-3)', fg: 'var(--ink-0)' },
    { name: '--paper-4', v: 'oklch(0.870 0.032 82)', bg: 'var(--paper-4)', fg: 'var(--ink-0)' },
    { name: '--ink-0',   v: 'oklch(0.20 0.030 45)',  bg: 'var(--ink-0)',  fg: 'var(--paper-0)' },
    { name: '--ink-1',   v: 'oklch(0.32 0.028 45)',  bg: 'var(--ink-1)',  fg: 'var(--paper-0)' },
    { name: '--ink-2',   v: 'oklch(0.46 0.024 48)',  bg: 'var(--ink-2)',  fg: 'var(--paper-0)' },
    { name: '--ink-3',   v: 'oklch(0.60 0.022 52)',  bg: 'var(--ink-3)',  fg: 'var(--paper-0)' },
    { name: '--ink-4',   v: 'oklch(0.72 0.020 60)',  bg: 'var(--ink-4)',  fg: 'var(--ink-0)' },
  ];
  const accents = [
    { name: '--bloom-1', v: 'cobalt · bright',bg: 'var(--bloom-1)', fg: 'white' },
    { name: '--bloom-2', v: 'cobalt · mid',   bg: 'var(--bloom-2)', fg: 'white' },
    { name: '--bloom-3', v: 'cobalt · deep',  bg: 'var(--bloom-3)', fg: 'white' },
    { name: '--madder',  v: 'rose · alarm',   bg: 'var(--madder)',  fg: 'white' },
    { name: '--moss',    v: 'green · confirm',bg: 'var(--moss)',    fg: 'white' },
    { name: '--saffron', v: 'yellow · notes', bg: 'var(--saffron)', fg: 'oklch(0.22 0.04 60)' },
  ];

  return (
    <div className="ds-page">
      <PaperBackdrop grid={false} grain={true} />
      <div style={{ position: 'relative', zIndex: 1 }}>
        <TopBar
          crumbs={[{ label: 'System', current: true }]}
          actions={<>
            <button className="icon-btn"><Ico.Book /> Docs</button>
            <button className="icon-btn primary"><Ico.Play /> Play</button>
            <div style={{ width: 8 }} />
            <div className="avatar">AK</div>
          </>}
        />
        <div className="ds-content">
          {/* ---- Hero ---- */}
          <div className="ds-hero">
            <div className="ds-eyebrow">Design System · v2.0 · "Atelier"</div>
            <div className="ds-h1">
              The user <em>describes.</em><br/>
              The AI <em>constructs.</em>
            </div>
            <div className="ds-lede">
              Lucent's interface is a warm paper atelier where AI ink blooms into structured
              diagrams. Every element is tactile, tuned for calm focus, and lets the model's
              output feel like something being drawn — not generated.
            </div>
            <div style={{ display: 'flex', gap: 22, marginTop: 32, alignItems: 'center' }}>
              <div className="mono-caps">Paper · Cobalt bloom · Plex trio · Hand-drawn edges</div>
            </div>
          </div>

          {/* ---- Motto card ---- */}
          <div className="ds-motto" style={{ marginBottom: 56 }}>
            <div className="mono" style={{ fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', opacity: 0.6, marginBottom: 20 }}>
              Signature
            </div>
            <div className="quote">
              "The differentiator isn't voice or the LLM — it's the <em>semantic canvas</em>: every object has meaning, and one underlying model renders into many representations."
            </div>
          </div>

          {/* ---- 01 Foundations · Color ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">01</span>
              <h2 className="ds-h2">Palette</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Cream paper is the substrate. Ink is the same warm espresso in both themes,
              contrasted against paper or charcoal. A saturated cobalt is reserved for AI
              illumination — the moment the model draws something new.
            </p>

            <div className="mono-caps" style={{ marginBottom: 12 }}>Paper &amp; Ink</div>
            <div className="ds-grid ds-grid-6" style={{ marginBottom: 28 }}>
              {colors.map(c => (
                <div key={c.name} className="ds-swatch" style={{ background: c.bg, color: c.fg }}>
                  <div className="sw-name">{c.name}</div>
                  <div className="sw-value">{c.v}</div>
                </div>
              ))}
            </div>

            <div className="mono-caps" style={{ marginBottom: 12 }}>Accents · Semantic</div>
            <div className="ds-grid ds-grid-6">
              {accents.map(c => (
                <div key={c.name} className="ds-swatch" style={{ background: c.bg, color: c.fg }}>
                  <div className="sw-name">{c.name}</div>
                  <div className="sw-value">{c.v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- 02 Type ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">02</span>
              <h2 className="ds-h2">Typography</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Three IBM Plex cuts, each with a job. Serif for editorial moments where the
              product breathes. Sans for the working interface. Mono for meta, coordinates,
              and diegetic labels — margin notes in a technical notebook.
            </p>

            <div className="ds-grid ds-grid-3" style={{ marginBottom: 24 }}>
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 10 }}>Plex Serif · Display</div>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 44, lineHeight: 1.05, letterSpacing: '-0.02em', fontWeight: 400 }}>
                  What should we build?
                </div>
                <div style={{ fontFamily: 'var(--font-serif)', fontSize: 20, fontStyle: 'italic', color: 'var(--ink-2)', marginTop: 8 }}>
                  Editorial voice · italic emphasis
                </div>
              </div>
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 10 }}>Plex Sans · UI</div>
                <div style={{ fontSize: 18, fontWeight: 500, marginBottom: 4 }}>Payment gateway</div>
                <div style={{ fontSize: 14, color: 'var(--ink-1)', lineHeight: 1.5 }}>
                  Handles Stripe intents, retries, and receipts. Runs behind the API gateway.
                </div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)', marginTop: 8 }}>Meta caption · 12</div>
              </div>
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 10 }}>Plex Mono · Meta</div>
                <div className="mono" style={{ fontSize: 12, color: 'var(--ink-0)', marginBottom: 6 }}>
                  fig. 03 · arch/v3 · 2s ago
                </div>
                <div className="mono" style={{ fontSize: 11, color: 'var(--ink-2)' }}>
                  {'{'} nodes: 12, edges: 18, layout: "elk-mrtree" {'}'}
                </div>
              </div>
            </div>

            <div className="ds-grid ds-grid-4">
              {[
                { size: 68, weight: 400, label: 'display · 68' },
                { size: 30, weight: 400, label: 'title · 30' },
                { size: 20, weight: 500, label: 'section · 20' },
                { size: 14, weight: 400, label: 'body · 14' },
              ].map(t => (
                <div key={t.label} style={{
                  padding: 20,
                  borderRadius: 12,
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                  background: 'var(--paper-0)',
                }}>
                  <div style={{
                    fontFamily: t.size > 22 ? 'var(--font-serif)' : 'var(--font-sans)',
                    fontSize: t.size, fontWeight: t.weight,
                    letterSpacing: t.size > 22 ? '-0.02em' : '-0.005em',
                    lineHeight: 1,
                    color: 'var(--ink-0)',
                  }}>Aa</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', marginTop: 12, letterSpacing: '0.06em' }}>
                    {t.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- 03 Nodes ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">03</span>
              <h2 className="ds-h2">Nodes</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Every canvas object is a semantic node. Default state is calm. Emerging means
              the AI just drew it. Ghost is a possibility, not yet committed. Proposed is
              staged for review.
            </p>
            <div style={{
              position: 'relative', height: 260,
              background: 'var(--paper-2)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              borderRadius: 16,
              overflow: 'hidden',
            }}>
              <div className="paper-grid" />
              <Node x={40}  y={60} meta="SERVICE" dot="bloom" title="Payment Gateway" sub="Stripe · retries" />
              <Node x={230} y={60} meta="SERVICE" dot="moss"  title="Order API" sub="internal" state="selected" />
              <Node x={420} y={60} meta="AI · NEW" dot="bloom" title="Notification Bus" sub="webhook fanout" state="emerging" />
              <Node x={610} y={60} meta="OPTIONAL" dot="graphite" title="Analytics Sink" sub="ghost — not committed" state="ghost" />
              <Node x={40}  y={165} meta="PROPOSED" dot="saffron" title="Redis Cache" sub="review before applying" state="proposed" />
              <Node x={230} y={165} meta="DATA" dot="madder" title="Legacy Auth" sub="pending removal" />
              <Node x={420} y={165} meta="SERVICE" title="Search Index" sub="OpenSearch" rot={-1.2} />
              <Node x={610} y={165} meta="CLIENT" title="Web App" sub="React + Vite" rot={0.8} />
            </div>
          </div>

          {/* ---- 04 Connectors ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">04</span>
              <h2 className="ds-h2">Connectors</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Edges are drawn by hand — bezier paths with a gentle jitter so they never feel
              mechanical. Emerging edges are cobalt and animate their stroke-dashoffset in.
            </p>
            <div style={{
              position: 'relative', height: 220,
              background: 'var(--paper-2)',
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
              borderRadius: 16,
              overflow: 'hidden',
            }}>
              <div className="paper-grid" />
              <svg className="connectors" viewBox="0 0 900 220">
                <ConnectorDefs />
                <path d={handPath({x: 80, y: 60}, {x: 300, y: 60}, 'h', 8, 1)} markerEnd="url(#arr)" />
                <path d={handPath({x: 80, y: 110}, {x: 300, y: 110}, 'h', 8, 2)} className="dashed" markerEnd="url(#arr)" />
                <path d={handPath({x: 80, y: 160}, {x: 300, y: 160}, 'h', 8, 3)} className="emerging" markerEnd="url(#arr-bloom)" />
                <text x="150" y="52" style={{ fill: 'var(--ink-2)' }}>calls</text>
                <text x="150" y="102" style={{ fill: 'var(--ink-2)' }}>optional</text>
                <text x="150" y="152" style={{ fill: 'var(--bloom-2)' }}>emerging · AI</text>

                <path d={handPath({x: 500, y: 40}, {x: 780, y: 180}, 'h', 12, 4)} markerEnd="url(#arr-ink)" style={{ stroke: 'var(--ink-0)', strokeWidth: 2 }} />
                <text x="620" y="85" style={{ fill: 'var(--ink-1)' }}>primary flow</text>
              </svg>
              <div style={{
                position: 'absolute', bottom: 14, left: 16,
                display: 'flex', gap: 20, fontFamily: 'var(--font-mono)', fontSize: 10.5,
                letterSpacing: '0.05em', color: 'var(--ink-3)',
              }}>
                <span>WOBBLE ±8px</span>
                <span>STROKE 1.5</span>
                <span>ROUND CAPS</span>
              </div>
            </div>
          </div>

          {/* ---- 05 Components ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">05</span>
              <h2 className="ds-h2">Components</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Buttons commit; ghosts consider; bloom is reserved for AI actions. Stickies
              carry annotations. Change items summarize AI-proposed edits.
            </p>

            <div className="ds-grid ds-grid-2" style={{ gap: 20 }}>
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 14 }}>Buttons</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
                  <button className="btn primary" style={{ flex: 'none' }}>Apply all</button>
                  <button className="btn bloom" style={{ flex: 'none' }}><Ico.Sparkle /> Ask Lucent</button>
                  <button className="btn ghost">Cancel</button>
                  <button className="btn danger"><Ico.X /> Discard</button>
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                  <button className="icon-btn"><Ico.Share /> Share</button>
                  <button className="icon-btn"><Ico.Present /> Present</button>
                  <button className="icon-btn primary"><Ico.Play /> Run</button>
                </div>
              </div>

              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 14 }}>Change items</div>
                <div className="change-item">
                  <span className="change-op add">Add</span>
                  <div style={{ flex: 1 }}>
                    <div className="change-title">Payment Service</div>
                    <div className="change-sub">Between Checkout and Orders DB · Stripe intents</div>
                  </div>
                </div>
                <div className="change-item">
                  <span className="change-op mod">Mod</span>
                  <div style={{ flex: 1 }}>
                    <div className="change-title">API Gateway</div>
                    <div className="change-sub">Route /payments to new service</div>
                  </div>
                </div>
                <div className="change-item" style={{ marginBottom: 0 }}>
                  <span className="change-op del">Del</span>
                  <div style={{ flex: 1 }}>
                    <div className="change-title">Legacy Auth</div>
                    <div className="change-sub">Replaced by OAuth session store</div>
                  </div>
                </div>
              </div>
            </div>

            {/* AI pill preview */}
            <div className="ds-card" style={{ marginTop: 20, position: 'relative' }}>
              <div className="mono-caps" style={{ marginBottom: 14 }}>AI pill</div>
              <div style={{ position: 'relative', height: 140 }}>
                <div style={{ position: 'absolute', left: '50%', top: 40, transform: 'translateX(-50%)' }}>
                  <div className="pill-status" style={{ marginBottom: 10 }}>
                    <span className="pulse" /> Listening · "add a redis cache…"
                  </div>
                  <div className="ai-pill listening" style={{ minWidth: 520 }}>
                    <span className="pill-icon"><Ico.Sparkle /></span>
                    <input readOnly value="add a redis cache in front of the orders database" />
                    <span className="kbd">⌘K</span>
                    <button className="mic-btn active"><Waveform bars={7} /></button>
                    <button className="send-btn"><Ico.Send /></button>
                  </div>
                </div>
              </div>
            </div>

            {/* Stickies row */}
            <div className="ds-card" style={{ marginTop: 20 }}>
              <div className="mono-caps" style={{ marginBottom: 14 }}>Sticky annotations</div>
              <div style={{ position: 'relative', height: 180 }}>
                <Sticky x={30}  y={20} rot={-3}>needs latency SLA
                  <div className="sticky-author">— Sarah</div>
                </Sticky>
                <Sticky x={260} y={30} rot={2} color="blue">idempotency key required
                  <div className="sticky-author">— John</div>
                </Sticky>
                <Sticky x={490} y={16} rot={-1} color="pink">move behind gateway?
                  <div className="sticky-author">— AI</div>
                </Sticky>
                <Sticky x={720} y={36} rot={3} color="green">approved · ship
                  <div className="sticky-author">— Alex</div>
                </Sticky>
              </div>
            </div>
          </div>

          {/* ---- 05b Service icons (Eraser-style branded nodes) ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">05b</span>
              <h2 className="ds-h2">Service catalog</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Canvas nodes carry branded service icons — Postgres, Redis, Stripe, Nginx — so
              architectures read at a glance. Generic Service / Cache / Queue icons cover
              anything unknown.
            </p>
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
              gap: 10,
              padding: 20,
              background: 'var(--paper-0)',
              borderRadius: 16,
              border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
            }}>
              {[
                ['postgres', 'Postgres'], ['redis', 'Redis'], ['stripe', 'Stripe'], ['react', 'React'],
                ['node', 'Node'], ['s3', 'S3'], ['nginx', 'Nginx'], ['auth', 'Auth0'],
                ['queue', 'Queue'], ['db', 'Database'], ['service', 'Service'], ['cache', 'Cache'],
                ['gateway', 'Gateway'], ['client', 'Client'], ['mobile', 'Mobile'],
              ].map(([k, l]) => (
                <div key={k} style={{
                  padding: '12px 10px',
                  borderRadius: 10,
                  background: 'var(--paper-1)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                }}>
                  {Svc[k]({})}
                  <span className="mono" style={{ fontSize: 10.5, color: 'var(--ink-1)', letterSpacing: '0.02em' }}>{l}</span>
                </div>
              ))}
            </div>
          </div>

          {/* ---- 05c Voice + transcript patterns (Granola/Otter) ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">05c</span>
              <h2 className="ds-h2">Voice &amp; transcript</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Voice sessions transcribe live with speaker chips, timestamps, and confidence.
              AI-authored notes cite the transcript with numbered pills — click a citation to
              jump to the source utterance.
            </p>

            <div className="ds-grid ds-grid-2" style={{ gap: 20 }}>
              <div className="ds-card" style={{ padding: 20 }}>
                <div className="mono-caps" style={{ marginBottom: 14 }}>Transcript row</div>
                <TranscriptRow
                  speaker="Sarah"
                  initials="S"
                  color="oklch(0.55 0.11 220)"
                  time="00:12:04"
                  text="For checkout, I think we need a cart review step first, then an address form."
                  active={true}
                  cited="1"
                />
                <TranscriptRow
                  speaker="Lucent"
                  initials="L"
                  color="var(--bloom-2)"
                  time="00:12:41"
                  text="I've captured a 4-step flow — Cart → Address → Payment → Confirmation."
                />
              </div>

              <div className="ds-card" style={{ padding: 20 }}>
                <div className="mono-caps" style={{ marginBottom: 14 }}>AI note with citations</div>
                <NoteBlock>
                  <NoteH3>Decisions</NoteH3>
                  <NoteBullet>
                    <b>Guest checkout is default</b> — no forced signup <CitationPill n="3" />
                  </NoteBullet>
                  <NoteBullet>
                    <b>Payment methods:</b> Cards, Apple Pay, Klarna <CitationPill n="2" />
                  </NoteBullet>
                  <NoteBullet>
                    <b>Silent retry policy</b> — two retries on Stripe intermittency <CitationPill n="5" />
                  </NoteBullet>
                </NoteBlock>
              </div>
            </div>

            <div className="ds-card" style={{ marginTop: 20, padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '16px 20px 12px', borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)' }}>
                <div className="mono-caps">Live recording pill · REC state</div>
              </div>
              <div style={{ padding: 20, display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '5px 12px 5px 8px',
                  background: 'oklch(from var(--madder) l c h / 0.1)',
                  border: '1px solid oklch(from var(--madder) l c h / 0.3)',
                  borderRadius: 999,
                  fontFamily: 'var(--font-mono)', fontSize: 11,
                  color: 'var(--madder)', fontWeight: 600, letterSpacing: '0.03em',
                }}>
                  <span style={{ width: 8, height: 8, borderRadius: 999, background: 'var(--madder)', animation: 'pulse-bloom 1.4s ease-in-out infinite' }} />
                  REC · 00:14:32
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '5px 12px', borderRadius: 999,
                  background: 'oklch(from var(--bloom-1) l c h / 0.08)',
                  border: '1px solid var(--bloom-wash-2)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--bloom-2)', fontWeight: 600,
                }}>
                  <span className="pulse" style={{ width: 6, height: 6, borderRadius: 999, background: 'var(--bloom-1)', animation: 'pulse-bloom 1.4s ease-in-out infinite' }} />
                  LIVE · extracting
                </div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 4,
                  padding: '5px 12px', borderRadius: 999,
                  background: 'oklch(from var(--paper-2) l c h / 0.8)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.5)',
                  fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--ink-2)',
                }}>
                  <SpeakerChip initials="A" name="Alex" color="oklch(0.55 0.16 25)" size={18} />
                  <SpeakerChip initials="S" name="Sarah" color="oklch(0.55 0.11 220)" size={18} />
                  <SpeakerChip initials="J" name="John" color="oklch(0.55 0.14 148)" size={18} />
                  <span style={{ marginLeft: 6 }}>3 speakers</span>
                </div>
              </div>
            </div>
          </div>

          {/* ---- 05d Canvas patterns (Miro/Eraser) ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">05d</span>
              <h2 className="ds-h2">Canvas patterns</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Grouped containers with colored labels for logical zones. Live cursor chips
              show collaborators. Minimap for overview. Alt / opt / loop frames for
              conditional branches in sequence diagrams.
            </p>

            <div className="ds-grid ds-grid-2" style={{ gap: 20 }}>
              <div className="ds-card" style={{ padding: 0, overflow: 'hidden', height: 260 }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)' }}>
                  <div className="mono-caps">Container groupings</div>
                </div>
                <div style={{ position: 'relative', height: 200 }}>
                  <Container x={20}  y={20} w={140} h={160} label="Frontend" kind="default" />
                  <Container x={180} y={20} w={140} h={160} label="Production" kind="production" />
                  <Container x={340} y={20} w={140} h={160} label="Data" kind="data" />
                </div>
              </div>

              <div className="ds-card" style={{ padding: 0, overflow: 'hidden', height: 260 }}>
                <div style={{ padding: '14px 18px', borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)' }}>
                  <div className="mono-caps">Live cursors</div>
                </div>
                <div style={{ position: 'relative', height: 200 }}>
                  <CursorChip x={50}  y={40}  name="Sarah" color="oklch(0.55 0.11 220)" />
                  <CursorChip x={160} y={110} name="John"  color="oklch(0.55 0.14 148)" />
                  <CursorChip x={280} y={70}  name="Alex"  color="oklch(0.55 0.16 25)" />
                </div>
              </div>
            </div>

            <div className="ds-card" style={{ marginTop: 20, padding: 0, overflow: 'hidden', height: 280 }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)' }}>
                <div className="mono-caps">Sequence frames · alt / opt / loop</div>
              </div>
              <div style={{ position: 'relative', height: 220 }}>
                <SeqFrame kind="alt"  x={20}  y={20}  w={280} h={70} label="success" />
                <SeqFrame kind="opt"  x={20}  y={100} w={280} h={70} label="if user is signed in" />
                <SeqFrame kind="loop" x={320} y={20}  w={280} h={70} label="for each item" />
                <SeqFrame kind="par"  x={320} y={100} w={280} h={70} label="in parallel" />
              </div>
            </div>
          </div>

          {/* ---- 05e Excalidraw sketchy mode ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">05e</span>
              <h2 className="ds-h2">Sketchy mode</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              For early-stage thinking, nodes can render in an Excalidraw-style sketchy mode —
              hand-wobbled borders, hatched fills, and italic serif labels. Toggle per-canvas
              from the tools menu.
            </p>
            <div className="ds-card" style={{ padding: 0, overflow: 'hidden', height: 260 }}>
              <div style={{ padding: '14px 18px', borderBottom: '1px solid oklch(from var(--paper-4) l c h / 0.4)' }}>
                <div className="mono-caps">Sketchy nodes</div>
              </div>
              <div style={{ position: 'relative', height: 200 }}>
                <SketchyNode x={30}  y={40} w={180} h={70}  title="Start" meta="STATE" seed={1} fill="oklch(0.72 0.11 235)" color="oklch(0.30 0.14 235)" />
                <SketchyNode x={260} y={40} w={180} h={70}  title="ok?" meta="DECISION" seed={2} fill="var(--saffron)" color="oklch(0.36 0.14 55)" rot={-1} />
                <SketchyNode x={490} y={20} w={180} h={70}  title="Fail" meta="END" seed={3} fill="var(--madder)" color="oklch(0.32 0.18 25)" rot={1.5} />
                <SketchyNode x={490} y={110} w={180} h={70} title="End" meta="END" seed={4} fill="var(--moss)" color="oklch(0.30 0.12 148)" rot={-1} />
              </div>
            </div>
          </div>

          {/* ---- 06 Motion ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">06</span>
              <h2 className="ds-h2">Motion</h2>
            </div>
            <p className="ds-p" style={{ marginBottom: 24 }}>
              Motion is calm and material. AI-emerged content blooms — opacity, blur, and a
              subtle upward drift — as if ink is spreading into paper.
            </p>
            <div className="ds-grid ds-grid-3">
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 14 }}>ink-bloom · 700ms</div>
                <BloomPreview />
              </div>
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 14 }}>draw-line · 1.1s</div>
                <DrawLinePreview />
              </div>
              <div className="ds-card">
                <div className="mono-caps" style={{ marginBottom: 14 }}>pulse · 1.4s loop</div>
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: 16,
                  fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--ink-1)',
                }}>
                  <span className="pulse" style={{
                    width: 14, height: 14, borderRadius: 999,
                    background: 'var(--bloom-1)',
                    boxShadow: '0 0 16px var(--bloom-glow)',
                    animation: 'pulse-bloom 1.4s ease-in-out infinite',
                  }} />
                  Listening…
                </div>
              </div>
            </div>
          </div>

          {/* ---- 07 Radius + elevation ---- */}
          <div className="ds-section">
            <div className="ds-section-head">
              <span className="ds-section-num">07</span>
              <h2 className="ds-h2">Surfaces</h2>
            </div>
            <div className="ds-grid ds-grid-4">
              {[
                { r: 6,  s: 'shadow-1', label: 'inline · 6' },
                { r: 14, s: 'shadow-node', label: 'node · 14' },
                { r: 18, s: 'shadow-2', label: 'panel · 18' },
                { r: 24, s: 'shadow-3', label: 'modal · 24' },
              ].map((t, i) => (
                <div key={i} style={{
                  padding: 24, minHeight: 120,
                  borderRadius: t.r,
                  background: 'var(--paper-0)',
                  border: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
                  boxShadow: `var(--${t.s})`,
                  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
                }}>
                  <div style={{ fontSize: 15, fontWeight: 500 }}>Surface</div>
                  <div className="mono" style={{ fontSize: 10.5, color: 'var(--ink-3)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
                    {t.label}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* ---- 08 Principles ---- */}
          <div className="ds-section" style={{ borderBottom: 0 }}>
            <div className="ds-section-head">
              <span className="ds-section-num">08</span>
              <h2 className="ds-h2">Principles</h2>
            </div>
            <div className="ds-grid ds-grid-2" style={{ gap: 20 }}>
              {[
                { n: 'i.',  t: 'Describe, don\'t decorate', b: 'Chrome is quiet. The canvas — and the ideas on it — is the interface.' },
                { n: 'ii.', t: 'Ink over neon',              b: 'Emergent things bloom like ink in paper. No glowing rims, no gradient sludge.' },
                { n: 'iii.',t: 'Notation, not chrome',       b: 'Meta lives in Plex Mono margin notes. Coordinates, timestamps, versions.' },
                { n: 'iv.', t: 'Warm technical',             b: 'Grain, cast shadows, slight rotations. A workbench, not a spaceship.' },
              ].map(p => (
                <div key={p.n} className="ds-card" style={{ padding: 24 }}>
                  <div className="serif" style={{ fontSize: 32, fontStyle: 'italic', color: 'var(--bloom-2)', marginBottom: 8, fontWeight: 400 }}>
                    {p.n}
                  </div>
                  <div style={{ fontSize: 17, fontWeight: 500, marginBottom: 6, letterSpacing: '-0.01em' }}>{p.t}</div>
                  <div style={{ fontSize: 13.5, color: 'var(--ink-2)', lineHeight: 1.55 }}>{p.b}</div>
                </div>
              ))}
            </div>
          </div>

          <div style={{
            marginTop: 40, paddingTop: 24,
            borderTop: '1px solid oklch(from var(--paper-4) l c h / 0.4)',
            display: 'flex', gap: 20,
            fontFamily: 'var(--font-mono)', fontSize: 11,
            color: 'var(--ink-3)', letterSpacing: '0.04em',
          }}>
            <span>lucent · atelier</span>
            <span>·</span>
            <span>v2.0</span>
            <span>·</span>
            <span>IBM Plex Sans + Mono + Serif</span>
            <div style={{ flex: 1 }} />
            <span>fig. 00 / design.system.md</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function BloomPreview() {
  const [k, setK] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setK(x => x + 1), 2200);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ position: 'relative', height: 100 }}>
      <Node
        key={k}
        x={20} y={26}
        w={240}
        meta="AI · NEW" dot="bloom"
        title="Payment Service"
        sub="drafted by Lucent"
        state="emerging"
      />
    </div>
  );
}

function DrawLinePreview() {
  const [k, setK] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setK(x => x + 1), 2200);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ position: 'relative', height: 100 }}>
      <svg className="connectors" viewBox="0 0 300 100" style={{ width: '100%', height: '100%' }}>
        <ConnectorDefs />
        <path
          key={k}
          d={handPath({x: 20, y: 50}, {x: 280, y: 50}, 'h', 10, k)}
          className="emerging drawing"
          style={{ '--dash': 280 }}
          markerEnd="url(#arr-bloom)"
        />
      </svg>
      <div style={{ position: 'absolute', left: 6, top: 32, width: 8, height: 8, borderRadius: 999, background: 'var(--bloom-1)' }} />
    </div>
  );
}

Object.assign(window, { ScreenDesignSystem });
