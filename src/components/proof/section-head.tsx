/** A proof section's heading: a small station sign over each check, so the paper half keeps the night stage's signage. */
export function SectionHead({ id, kicker, title, children }: { id: string; kicker: string; title: string; children?: React.ReactNode }) {
  return (
    <header className="flex max-w-prose flex-col gap-2">
      <p className="sign-band sign-rule label w-fit rounded-sm px-3 pb-1.5 pt-3.5">{kicker}</p>
      <h2 id={id} className="scroll-mt-20 font-display text-3xl font-bold leading-tight tracking-tight">
        {title}
      </h2>
      {children ? <div className="text-ink-700">{children}</div> : null}
    </header>
  );
}

export const REPO = "https://github.com/SaudSatopay/detour/blob/main";

export const n = (x: number) => Math.round(x).toLocaleString("en-US");

export function SourceLink({ path, children }: { path: string; children?: React.ReactNode }) {
  return (
    <a className="underline decoration-line-strong underline-offset-4" href={`${REPO}/${path}`}>
      {children ?? path}
    </a>
  );
}
