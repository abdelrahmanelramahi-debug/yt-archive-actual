import type { Metadata } from "next";
import { LegalShell } from "../legal-shell";

export const metadata: Metadata = {
  title: "Privacy Policy · La Tafti",
  description: "How La Tafti handles your account and data.",
};

export default function PrivacyPage() {
  return (
    <LegalShell title="Privacy Policy" updated="30 October 2026">
      <p>
        La Tafti (&ldquo;the service&rdquo;, &ldquo;we&rdquo;) is a free tool for searching and asking
        questions across a library of Islamic lecture transcripts. This policy explains what we collect,
        why, and what choices you have. We keep it short because we collect little.
      </p>

      <h2>What we collect</h2>
      <ul>
        <li>
          <strong>Your account.</strong> When you sign in with Google or with an email and password, we
          receive your email address and a unique account identifier from Firebase Authentication. We do
          not receive or store your Google password.
        </li>
        <li>
          <strong>Your questions and answers.</strong> Each question you ask and the answer you receive are
          saved to your account so your history appears in the sidebar. You can delete any of them at any
          time.
        </li>
        <li>
          <strong>Usage count.</strong> We keep a simple daily count of how many answers you&rsquo;ve
          requested, to enforce the free daily limit. It resets each day.
        </li>
      </ul>
      <p>
        We do not use tracking cookies or third-party advertising, and we do not build advertising profiles.
        Sign-in uses only the storage needed to keep you signed in.
      </p>

      <h2>How your questions are processed</h2>
      <p>
        To produce an answer, your question is sent to our search service and to an AI provider
        (Anthropic&rsquo;s Claude) which generates the answer from the relevant transcript excerpts. Please
        avoid including sensitive personal information in your questions. Answers link to public YouTube
        videos at the cited moments; opening a link takes you to YouTube under its own terms and privacy
        policy.
      </p>

      <h2>Where your data lives</h2>
      <p>
        Accounts, usage counts, and saved history are stored in Google Firebase (Firestore and Firebase
        Authentication). Your saved history is readable only by your own signed-in account. We do not sell
        your data or share it with anyone except the providers needed to run the service (Google Firebase,
        Anthropic, and our hosting providers).
      </p>

      <h2>Keeping and deleting your data</h2>
      <ul>
        <li>Delete any saved question from the sidebar whenever you like.</li>
        <li>
          To delete your entire account and its data, contact us (below) and we will remove it. You can
          also stop using the service at any time.
        </li>
      </ul>

      <h2>Children</h2>
      <p>
        The service is not directed to children under 13 (or the minimum age of digital consent in your
        country), and we do not knowingly collect their data.
      </p>

      <h2>Changes</h2>
      <p>
        We may update this policy as the service evolves. Material changes will be reflected by the
        &ldquo;last updated&rdquo; date above.
      </p>

      <h2>Contact</h2>
      <p>
        Questions or requests about your data: <a href="mailto:omniveradigital@gmail.com">omniveradigital@gmail.com</a>.
      </p>
    </LegalShell>
  );
}
