"use client";

import { useId, useState } from "react";
import type { KnowledgeFragment } from "../lib/knowledge-schema";

function KnowledgeSource({ fragment }: { fragment: KnowledgeFragment }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <li className="kb-source">
      <div className="kb-source-head">
        <span className="kb-source-title">{fragment.tytul}</span>
        <span className="kb-source-score" title="Podobieństwo fragmentu do pytania">
          {Math.round(fragment.podobienstwo * 100)}%
        </span>
        <button type="button" className="kb-source-toggle" aria-expanded={open} aria-controls={id}
          onClick={() => setOpen((value) => !value)}>
          {open ? "Ukryj fragment" : "Pokaż fragment"}
        </button>
      </div>
      {open && <blockquote id={id} className="kb-source-text">{fragment.tresc}</blockquote>}
    </li>
  );
}

export default function KnowledgeSources({ fragments }: { fragments: KnowledgeFragment[] }) {
  if (!fragments.length) return null;
  return (
    <section className="sources kb-sources" aria-label="Źródła z bazy wiedzy">
      <h2>Źródła z bazy wiedzy</h2>
      <ul>
        {fragments.map((fragment) => (
          <KnowledgeSource key={`${fragment.tytul}\n${fragment.tresc}`} fragment={fragment} />
        ))}
      </ul>
    </section>
  );
}
