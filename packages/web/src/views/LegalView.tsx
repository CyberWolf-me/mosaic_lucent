import { navigate } from "../routes.js";
import { Ico } from "../ui/icons.js";

interface LegalViewProps {
  mode: "privacy" | "terms";
}

export function LegalView({ mode }: LegalViewProps) {
  const isPrivacy = mode === "privacy";

  return (
    <div className="legal-shell">
      <header className="legal-header">
        <div className="legal-header-inner">
          <div className="legal-brand" onClick={() => navigate("/")} role="button" tabIndex={0}>
            <div className="legal-logo">L</div>
            <div className="legal-brand-text">
              <strong>Lucent</strong>
              <span>Visual Workspace</span>
            </div>
          </div>

          <nav className="legal-nav">
            <button
              className={`legal-nav-btn ${isPrivacy ? "active" : ""}`}
              onClick={() => navigate("/privacy")}
            >
              Privacy Policy
            </button>
            <button
              className={`legal-nav-btn ${!isPrivacy ? "active" : ""}`}
              onClick={() => navigate("/terms")}
            >
              Terms of Service
            </button>
          </nav>

          <button className="legal-back-btn" onClick={() => navigate("/")}>
            <Ico.Left />
            <span>Back to Lucent</span>
          </button>
        </div>
      </header>

      <main className="legal-main">
        <div className="legal-card">
          <div className="legal-meta">
            <span className="legal-badge">Official Legal Document</span>
            <span className="legal-updated">Last Updated: September 18, 2026</span>
          </div>

          {isPrivacy ? <PrivacyContent /> : <TermsContent />}

          <footer className="legal-footer">
            <div className="legal-footer-links">
              <a
                href="/privacy"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("/privacy");
                }}
              >
                Privacy Policy
              </a>
              <span>·</span>
              <a
                href="/terms"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("/terms");
                }}
              >
                Terms of Service
              </a>
              <span>·</span>
              <a
                href="/"
                onClick={(e) => {
                  e.preventDefault();
                  navigate("/");
                }}
              >
                Workspace
              </a>
            </div>
            <p className="legal-copy">
              &copy; {new Date().getFullYear()} Lucent. All rights reserved. Your data and boards
              belong exclusively to you.
            </p>
          </footer>
        </div>
      </main>
    </div>
  );
}

function PrivacyContent() {
  return (
    <article className="legal-body">
      <h1>Lucent Privacy Policy</h1>
      <p className="legal-lead">
        Your privacy, intellectual property, and data sovereignty are fundamental to Lucent. This
        Privacy Policy explains how Lucent collects, uses, protects, and handles your information
        when you use our conversational visual workspace, websites, APIs, and associated
        applications.
      </p>

      <div className="legal-callout">
        <div className="legal-callout-title">
          <span className="legal-callout-icon">🛡️</span>
          <strong>Strict "No AI Training" Guarantee</strong>
        </div>
        <p>
          Lucent does <strong>never</strong> use your board content, diagrams, code snippets,
          prompts, voice audio, or meeting transcripts to train, retrain, fine-tune, or improve
          foundation AI models. Your content remains strictly confidential and isolated to your
          workspace.
        </p>
      </div>

      <section className="legal-section">
        <h2>1. Information We Collect</h2>
        <p>
          We collect only the minimum necessary information required to provide the visual workspace
          service:
        </p>
        <ul>
          <li>
            <strong>Account Information:</strong> When you register an account or authenticate via
            Google OAuth or GitHub OAuth, we collect your name, email address, and profile picture
            to identify your session and associate your boards with your profile.
          </li>
          <li>
            <strong>Canvas &amp; Workspace Content:</strong> We store the structured semantic
            diagrams, nodes, connectors, sticky notes, wireframes, comments, and project metadata
            that you create, import, or direct the AI to generate on your boards.
          </li>
          <li>
            <strong>Voice &amp; Audio Streams:</strong> When you activate push-to-talk voice mode or
            participate in meeting huddles, audio is converted to text in real time. We do not
            persist raw audio recordings once the transcription is finished. Transcripts are
            retained solely within your workspace if you choose to extract meeting intelligence or
            minutes.
          </li>
          <li>
            <strong>System &amp; Operational Telemetry:</strong> We collect standard operational
            metadata including IP address, browser type, and security logs strictly for fraud
            prevention, rate limiting, and CSRF protection.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>2. Google User Data &amp; OAuth Policy Compliance</h2>
        <p>
          Lucent allows sign-in using Google OAuth. When you use Google Sign-In, we access your
          basic profile data (name, email address, and profile photo) solely to authenticate your
          identity and establish your user session.
        </p>
        <ul>
          <li>
            <strong>Limited Use:</strong> Lucent&apos;s use and transfer to any other app of
            information received from Google APIs will adhere to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements.
          </li>
          <li>
            <strong>No Sale or Third-Party Sharing:</strong> We never sell Google user data or
            transfer it to data brokers, advertising networks, or unauthorized third parties.
          </li>
          <li>
            <strong>No Model Training:</strong> Google user data and associated canvas content are
            never used to train generalized AI or machine learning models.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>3. How We Process AI Invocations</h2>
        <p>
          When you submit a natural language or voice prompt to construct or modify a diagram,
          Lucent packages the prompt alongside relevant graph context and submits it via a secure,
          stateless API call to our configured enterprise inference provider (such as Anthropic
          Claude, Google Gemini, or OpenAI).
        </p>
        <p>
          These API requests operate under enterprise agreements with zero data retention for
          training. The AI provider acts strictly as a data processor to return structured JSON
          operations (e.g., node creation, edge connections), which our deterministic layout engine
          renders onto your canvas.
        </p>
      </section>

      <section className="legal-section">
        <h2>4. Data Isolation, Storage, and Security</h2>
        <p>
          We employ enterprise-grade safeguards to protect your data across our entire architecture:
        </p>
        <ul>
          <li>
            <strong>Encryption:</strong> All data in transit is encrypted using modern TLS 1.3. Data
            at rest in our PostgreSQL database and object stores is encrypted using
            industry-standard cryptographic algorithms.
          </li>
          <li>
            <strong>Workspace Isolation:</strong> Boards and workspaces are strictly isolated by
            organization and membership permissions. Access is gated by server-authoritative token
            validation.
          </li>
          <li>
            <strong>Session &amp; CSRF Protection:</strong> Authentication cookies are protected
            with HTTP-only, SameSite strict flags, and all state-mutating requests require
            cryptographic CSRF token validation.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>5. Your Rights &amp; Data Portability</h2>
        <p>You have full ownership and sovereignty over your data:</p>
        <ul>
          <li>
            <strong>Export:</strong> You can export your boards, diagrams, and assets at any time in
            standard formats (SVG, PNG, JSON, Markdown).
          </li>
          <li>
            <strong>Account Deletion:</strong> You have the right to delete your account, boards,
            and associated personal data at any time. Upon deletion, your data is permanently
            expunged from our active database.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>6. Contact Us</h2>
        <p>
          If you have questions about this Privacy Policy, your personal data, or wish to exercise
          your data privacy rights, please contact our Data Protection Officer at:
        </p>
        <div className="legal-contact-card">
          <strong>Lucent Privacy Team</strong>
          <div>
            Email: <a href="mailto:privacy@lucent.dev">privacy@lucent.dev</a>
          </div>
          <div>
            Domain: <code>161.33.167.15.sslip.io</code>
          </div>
        </div>
      </section>
    </article>
  );
}

function TermsContent() {
  return (
    <article className="legal-body">
      <h1>Lucent Terms of Service</h1>
      <p className="legal-lead">
        Welcome to Lucent. These Terms of Service (&quot;Terms&quot;) govern your access to and use
        of the Lucent platform, visual canvas, AI-assisted diagramming tools, and collaborative
        workspace services.
      </p>

      <section className="legal-section">
        <h2>1. Acceptance of Terms</h2>
        <p>
          By creating an account, accessing, or using Lucent (located at{" "}
          <code>https://161.33.167.15.sslip.io</code> or related domains), you acknowledge that you
          have read, understood, and agree to be bound by these Terms and our Privacy Policy.
        </p>
      </section>

      <section className="legal-section">
        <h2>2. Content Ownership and Intellectual Property</h2>
        <p>
          <strong>Your Content Is Yours:</strong> You retain complete ownership, copyright, and all
          intellectual property rights to any diagrams, architectures, wireframes, text, designs,
          and data you create or upload to Lucent.
        </p>
        <p>
          Lucent claims no ownership or intellectual property rights over your workspace content. We
          use your content solely to host, render, and execute operations on your boards as directed
          by you.
        </p>
        <p>
          <strong>Lucent Platform Rights:</strong> The Lucent software, source code, user interface,
          branding, layout engines, and deterministic algorithms are the exclusive property of
          Lucent and its licensors, protected by copyright and intellectual property laws.
        </p>
      </section>

      <section className="legal-section">
        <h2>3. Account Responsibilities</h2>
        <ul>
          <li>You must provide accurate information when creating an account.</li>
          <li>
            You are responsible for maintaining the confidentiality of your credentials and for all
            actions conducted through your account.
          </li>
          <li>
            You must notify us immediately if you discover or suspect unauthorized access to your
            account.
          </li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>4. Acceptable Use Policy</h2>
        <p>You agree not to use Lucent to:</p>
        <ul>
          <li>Violate any applicable national or international laws or regulations.</li>
          <li>Upload or transmit malicious code, viruses, worms, or disruptive scripts.</li>
          <li>
            Attempt to gain unauthorized access to other users&apos; workspaces, server
            infrastructure, or networks.
          </li>
          <li>
            Abuse, overwhelm, or attempt denial-of-service attacks against our API endpoints or
            layout engines.
          </li>
          <li>Use automated scrapers or crawlers without prior written authorization.</li>
        </ul>
      </section>

      <section className="legal-section">
        <h2>5. AI Features and Human Verification</h2>
        <p>
          Lucent provides AI-assisted diagram generation, natural language layout, and intelligence
          synthesis. The AI generates proposed operations based on your prompts.
        </p>
        <p>
          <strong>Human Review:</strong> You acknowledge that AI-generated diagrams and architecture
          recommendations should be reviewed for technical accuracy, security considerations, and
          completeness prior to implementation in production environments.
        </p>
      </section>

      <section className="legal-section">
        <h2>6. Service Availability &amp; Limitation of Liability</h2>
        <p>
          Lucent is provided on an &quot;as is&quot; and &quot;as available&quot; basis. While we
          strive for high availability and seamless real-time synchronization, we do not guarantee
          that the service will be uninterrupted, error-free, or entirely bug-free.
        </p>
        <p>
          To the maximum extent permitted by applicable law, Lucent and its operators shall not be
          liable for any indirect, incidental, special, or consequential damages resulting from your
          use or inability to use the service.
        </p>
      </section>

      <section className="legal-section">
        <h2>7. Termination</h2>
        <p>
          You may terminate your account and stop using the service at any time. We reserve the
          right to suspend or terminate your access if you materially breach these Terms.
        </p>
      </section>

      <section className="legal-section">
        <h2>8. Contact Information</h2>
        <p>
          For any questions or legal notices regarding these Terms, please contact our legal counsel
          at:
        </p>
        <div className="legal-contact-card">
          <strong>Lucent Legal Team</strong>
          <div>
            Email: <a href="mailto:legal@lucent.dev">legal@lucent.dev</a>
          </div>
          <div>
            Domain: <code>161.33.167.15.sslip.io</code>
          </div>
        </div>
      </section>
    </article>
  );
}
