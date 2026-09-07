"use client";

import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from "react";

export const HIGHLIGHT_THEMES = [
  { id: "github", label: "GitHub" },
  { id: "github-dark", label: "GitHub Dark" },
  { id: "atom-one-light", label: "Atom One Light" },
  { id: "atom-one-dark", label: "Atom One Dark" },
  { id: "vs2015", label: "VS2015" },
  { id: "stackoverflow-light", label: "StackOverflow Light" },
  { id: "stackoverflow-dark", label: "StackOverflow Dark" },
] as const;

export type HighlightThemeId = (typeof HIGHLIGHT_THEMES)[number]["id"];

type HighlightThemeContextValue = {
  theme: HighlightThemeId;
  setTheme: (id: HighlightThemeId) => void;
};

const HighlightThemeContext = createContext<HighlightThemeContextValue | null>(null);

export function HighlightThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<HighlightThemeId>("atom-one-dark");

  const value = useMemo(() => ({ theme, setTheme }), [theme]);

  return (
    <HighlightThemeContext.Provider value={value}>
      {children}
    </HighlightThemeContext.Provider>
  );
}

export function useHighlightTheme(): HighlightThemeContextValue {
  const ctx = useContext(HighlightThemeContext);
  if (!ctx) {
    throw new Error("useHighlightTheme must be used within a HighlightThemeProvider");
  }
  return ctx;
}
