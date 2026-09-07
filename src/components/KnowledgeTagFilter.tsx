"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import type { KnowledgeSort } from "@/lib/knowledge";

type KnowledgeTagFilterProps = {
  knowledgeBaseId: string;
  query?: string;
  status?: string;
  sort: KnowledgeSort;
  selectedTags: string[];
  remainingTags: string[];
};

function buildKnowledgeHref(params: { knowledgeBaseId: string; q?: string; tags?: string[]; status?: string; sort?: string }): string {
  const nextParams = new URLSearchParams();
  nextParams.set("knowledgeBaseId", params.knowledgeBaseId);

  if (params.q) {
    nextParams.set("q", params.q);
  }
  for (const tag of params.tags ?? []) {
    nextParams.append("tag", tag);
  }
  if (params.status && params.status !== "ALL") {
    nextParams.set("status", params.status);
  }
  if (params.sort && params.sort !== "updated-desc") {
    nextParams.set("sort", params.sort);
  }

  const query = nextParams.toString();
  return query ? `/knowledge?${query}` : "/knowledge";
}

export function KnowledgeTagFilter({ knowledgeBaseId, query, status, sort, selectedTags, remainingTags }: KnowledgeTagFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [isOpen]);

  return (
    <section className="stack-panel tag-filter-block">
      <div className="field-header">
        <span>标签筛选</span>
      </div>

      <div className="tag-filter-row">
        {selectedTags.map((tag) => (
          <Link
            key={`active-tag-${tag}`}
            href={buildKnowledgeHref({
              knowledgeBaseId,
              q: query,
              tags: selectedTags.filter((current) => current !== tag),
              status,
              sort,
            })}
            scroll={false}
            className="pill interactive-pill active-pill"
          >
            {tag}
          </Link>
        ))}

        {remainingTags.length > 0 ? (
          <div ref={pickerRef} className="tag-filter-picker">
            <button
              type="button"
              className="tag-filter-add-button"
              aria-label="添加标签筛选条件"
              aria-expanded={isOpen}
              onClick={() => setIsOpen((current) => !current)}
            >
              +
            </button>

            {isOpen ? (
              <div className="tag-filter-menu">
                {remainingTags.map((tag) => (
                  <Link
                    key={`picker-${tag}`}
                    href={buildKnowledgeHref({
                      knowledgeBaseId,
                      q: query,
                      tags: [...selectedTags, tag],
                      status,
                      sort,
                    })}
                    scroll={false}
                    className="pill interactive-pill"
                  >
                    {tag}
                  </Link>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}