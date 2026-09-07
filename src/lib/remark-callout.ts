/**
 * remark plugin: parse Obsidian-style callout blocks.
 *
 * Converts blockquotes starting with `> [!KEYWORD]` into a custom `callout` node
 * rendered as a `<div class="callout" data-callout="keyword">`.
 *
 * Supports:
 * - `> [!NOTE]`, `> [!WARNING]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!CAUTION]`
 * - `> [!ABSTRACT]`, `> [!INFO]`, `> [!SUCCESS]`, `> [!QUESTION]`, `> [!FAILURE]`
 * - Custom title: `> [!NOTE] My Title`
 * - Collapsible: `> [!NOTE]+` or `> [!NOTE]-`
 * - Theorem environments: `> [!THM]`, `> [!DEF]`, `> [!LEM]`, etc. with auto-numbering
 * - PDF color variants: `> [!PDF|red]`, `> [!PDF|yellow]`, `> [!PDF|important]`, `> [!PDF|note]`
 * - Callout style variants: `> [!NOTE|style-1]`, etc.
 * - Fallback to NOTE style for unknown keywords
 */

import { visit } from "unist-util-visit";
import type { Root, Blockquote, Paragraph, PhrasingContent, Text } from "mdast";

// ── Callout configuration ──────────────────────────────────────────────

interface CalloutConfig {
  defaultTitle: string;
  icon: string;
  color: string;
}

const CALLOUT_META: Record<string, CalloutConfig> = {
  NOTE:       { defaultTitle: "Note",       color: "#1775d9", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"></path><path d="m15 5 4 4"></path></svg>' },
  ABSTRACT:   { defaultTitle: "Abstract",   color: "#16a6ab", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="M12 11h4"></path><path d="M12 16h4"></path><path d="M8 11h.01"></path><path d="M8 16h.01"></path></svg>' },
  SUMMARY:    { defaultTitle: "Summary",    color: "#16a6ab", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="2" width="8" height="4" rx="1" ry="1"></rect><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"></path><path d="M12 11h4"></path><path d="M12 16h4"></path><path d="M8 11h.01"></path><path d="M8 16h.01"></path></svg>' },
  INFO:       { defaultTitle: "Info",       color: "#1775d9", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M12 16v-4"></path><path d="M12 8h.01"></path></svg>' },
  TODO:       { defaultTitle: "Todo",       color: "#1775d9", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="m9 12 2 2 4-4"></path></svg>' },
  TIP:        { defaultTitle: "Tip",        color: "#16a6ab", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg>' },
  HINT:       { defaultTitle: "Hint",       color: "#16a6ab", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg>' },
  IMPORTANT:  { defaultTitle: "Important",  color: "#16a6ab", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"></path></svg>' },
  SUCCESS:    { defaultTitle: "Success",    color: "#1da51d", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>' },
  CHECK:      { defaultTitle: "Check",      color: "#1da51d", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>' },
  DONE:       { defaultTitle: "Done",       color: "#1da51d", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>' },
  QUESTION:   { defaultTitle: "Question",   color: "#de7417", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>' },
  HELP:       { defaultTitle: "Help",       color: "#de7417", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>' },
  FAQ:        { defaultTitle: "Faq",        color: "#de7417", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>' },
  WARNING:    { defaultTitle: "Warning",    color: "#de7417", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>' },
  CAUTION:    { defaultTitle: "Caution",    color: "#de7417", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>' },
  ATTENTION:  { defaultTitle: "Attention", color: "#de7417", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>' },
  FAILURE:    { defaultTitle: "Failure",    color: "#dd2c38", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>' },
  FAIL:       { defaultTitle: "Fail",       color: "#dd2c38", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>' },
  MISSING:    { defaultTitle: "Missing",    color: "#dd2c38", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>' },
  DANGER:     { defaultTitle: "Danger",     color: "#dd2c38", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path></svg>' },
  ERROR:      { defaultTitle: "Error",      color: "#dd2c38", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"></path></svg>' },
  BUG:        { defaultTitle: "Bug",        color: "#dd2c38", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m8 2 1.88 1.88"></path><path d="M14.12 3.88 16 2"></path><path d="M9 7.13v-1a3.003 3.003 0 1 1 6 0v1"></path><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6"></path><path d="M12 20v-9"></path><path d="M6.53 9C4.6 8.8 3 7.1 3 5"></path><path d="M6 13H2"></path><path d="M3 21c0-2.1 1.7-3.9 3.8-4"></path><path d="M20.97 5c0 2.1-1.6 3.8-3.5 4"></path><path d="M22 13h-4"></path><path d="M17.2 17c2.1.1 3.8 1.9 3.8 4"></path></svg>' },
  EXAMPLE:    { defaultTitle: "Example",    color: "#8f47e1", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>' },
  QUOTE:      { defaultTitle: "Quote",      color: "#9e9e9e", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path></svg>' },
  CITE:       { defaultTitle: "Cite",       color: "#9e9e9e", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path><path d="M5 3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2 1 1 0 0 1 1 1v1a2 2 0 0 1-2 2 1 1 0 0 0-1 1v2a1 1 0 0 0 1 1 6 6 0 0 0 6-6V5a2 2 0 0 0-2-2z"></path></svg>' },
  PDF:        { defaultTitle: "Pdf",        color: "#ffd000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 11-6 6v3h9l3-3"></path><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"></path></svg>' },
  BORDER:     { defaultTitle: "Border",     color: "#000000", icon: '' },
  "MULTI-COLUMN": { defaultTitle: "Columns", color: "#000000", icon: '' },
  // Theorem environments
  THM: { defaultTitle: "Theorem",   color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>' },
  DEF: { defaultTitle: "Definition", color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"></path><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"></path></svg>' },
  LEM: { defaultTitle: "Lemma",      color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10v6M2 10l10-5 10 5-10 5z"></path><path d="M6 12v5c3 3 9 3 12 0v-5"></path></svg>' },
  PRP: { defaultTitle: "Proposition",color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v4"></path><path d="M16 2v4"></path><path d="M7 13h10"></path><path d="M3 6h18"></path><rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect></svg>' },
  COR: { defaultTitle: "Corollary",  color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>' },
  RMK: { defaultTitle: "Remark",     color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>' },
  CLM: { defaultTitle: "Claim",        color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>' },
  ASM: { defaultTitle: "Assumption",   color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20"></path></svg>' },
  EXM: { defaultTitle: "Example",      color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line></svg>' },
  EXR: { defaultTitle: "Exercise",     color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>' },
  HYP: { defaultTitle: "Hypothesis",   color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>' },
  AXM: { defaultTitle: "Axiom",        color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"></path><path d="M2 17l10 5 10-5"></path><path d="M2 12l10 5 10-5"></path></svg>' },
  CNJ: { defaultTitle: "Conjecture",   color: "#000000", icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path><path d="M12 17h.01"></path></svg>' },
};

const SUPPORTED_KEYWORDS = new Set(Object.keys(CALLOUT_META));
const THEOREM_KEYWORDS = new Set(["THM", "DEF", "LEM", "PRP", "COR", "CLM", "ASM", "EXM", "EXR", "HYP", "RMK", "AXM", "CNJ"]);
const SPECIAL_CALLOUTS = new Set(["MULTI-COLUMN", "BORDER"]);
const KEYWORD_PATTERN = /^\[!([A-Za-z0-9_ -]+(?:\|[^\]]*)?)\]([+-]?)\s*(.*)$/;
const BLANK_SUFFIX = "-BLANK";

/** Whether a keyword represents a theorem environment. */
export function isTheoremKeyword(keyword: string): boolean {
  return THEOREM_KEYWORDS.has(keyword.toUpperCase());
}

/** Whether a keyword is a special structural callout (MULTI-COLUMN, BORDER). */
export function isSpecialCallout(keyword: string): boolean {
  return SPECIAL_CALLOUTS.has(keyword.toUpperCase());
}

/** Whether a keyword ends with `-BLANK` (decoration-free variant). */
export function isBlankVariant(keyword: string): boolean {
  return keyword.toUpperCase().endsWith(BLANK_SUFFIX);
}

/** Strip `-BLANK` suffix to get the base keyword. */
export function stripBlankSuffix(keyword: string): string {
  const upper = keyword.toUpperCase();
  if (upper.endsWith(BLANK_SUFFIX)) {
    return keyword.slice(0, -BLANK_SUFFIX.length);
  }
  return keyword;
}

/** Convert hex color to comma-separated RGB (e.g. "#1775d9" → "23, 117, 217"). */
export function hexToRgbTuple(hex: string): string {
  const normalized = hex.trim().replace(/^#/, "");
  if (!/^[\da-fA-F]{6}$/.test(normalized)) return "23, 117, 217";
  const value = Number.parseInt(normalized, 16);
  return `${(value >> 16) & 0xff}, ${(value >> 8) & 0xff}, ${value & 0xff}`;
}

// ── Fold icon & SVG normalization ─────────────────────────────────────

/** Chevron-down SVG used as the collapse/expand fold icon in collapsible callouts. */
export const CALLOUT_FOLD_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="svg-icon lucide-chevron-down"><path d="m6 9 6 6 6-6"></path></svg>';

/** Add CSS class names to an icon SVG string so it inherits callout icon sizing. */
export function normalizeIconSvg(icon: string): string {
  if (!icon) return "";
  if (/\bclass=/.test(icon)) {
    return icon.replace(/class="([^"]*)"/, 'class="$1 svg-icon callout-icon-svg"');
  }
  return icon.replace(/<svg\b/, '<svg class="svg-icon callout-icon-svg"');
}

// ── PDF color variants ────────────────────────────────────────────────

/** Resolve a PDF callout color based on metadata option (red / yellow / important / note). */
function getPdfColor(option: string): string {
  switch (option.toLowerCase()) {
    case "red":       return "#ea5252";
    case "yellow":    return CALLOUT_META.PDF.color;
    case "important": return "#bb61e5";
    case "note":      return CALLOUT_META.NOTE.color;
    default:          return CALLOUT_META.PDF.color;
  }
}

// ── CalloutComponent: rendered by react-markdown ───────────────────────

export const CALLOUT_CSS_VAR = "--callout-color";

/** Resolve config: strip `-BLANK` suffix, fall back to NOTE for unknown keywords. */
function resolveConfig(keyword: string): CalloutConfig {
  const base = stripBlankSuffix(keyword).toUpperCase();
  return CALLOUT_META[base] ?? CALLOUT_META.NOTE;
}

/**
 * Build an inline style object for a callout container.
 * Sets --callout-color as comma-separated RGB so CSS can use rgb(var(--callout-color)).
 */
export function getCalloutStyle(keyword: string): React.CSSProperties {
  const meta = resolveConfig(keyword);
  const rgb = hexToRgbTuple(meta.color);
  return { [CALLOUT_CSS_VAR as string]: rgb } as React.CSSProperties;
}

/** Title text for a callout type. */
export function getCalloutDefaultTitle(keyword: string): string {
  const meta = resolveConfig(keyword);
  return meta.defaultTitle;
}

/** Icon SVG for a callout type. Returns empty string for blank variants. */
export function getCalloutIcon(keyword: string): string {
  if (isBlankVariant(keyword)) return "";
  const meta = resolveConfig(keyword);
  return meta.icon;
}

/**
 * Resolve the effective hex color for a callout type.
 * For PDF callouts, respects the metadata option (red/yellow/important/note).
 */
export function getCalloutColor(keyword: string, metadataOption?: string): string {
  const upper = keyword.toUpperCase();
  if (upper === "PDF" && metadataOption) {
    return getPdfColor(metadataOption);
  }
  const meta = resolveConfig(keyword);
  return meta.color;
}

// ── Theorem numbering state ──────────────────────────────────────────

/** Per-document counters for theorem-type auto-numbering. */
export type TheoremCounters = Record<string, number>;

/** Create a fresh set of theorem counters. */
export function createTheoremCounters(): TheoremCounters {
  return {};
}

// ── Remark plugin ──────────────────────────────────────────────────────

export default function remarkCallout() {
  return (tree: Root) => {
    // ── First pass: count theorem-type callouts for auto-numbering ──
    const theoremCounters: TheoremCounters = {};

    visit(tree, "blockquote", (node: Blockquote) => {
      if (!node.children?.length) return;

      const firstPara = node.children[0] as Paragraph | undefined;
      if (firstPara?.type !== "paragraph" || !firstPara.children?.length) return;

      const firstText = firstPara.children[0] as Text | undefined;
      if (firstText?.type !== "text") return;

      const match = firstText.value.match(KEYWORD_PATTERN);
      if (!match) return;

      const rawKeyword = match[1];
      const parts = rawKeyword.split("|");
      const rawType = parts[0].trim();
      const keyword = rawType.toUpperCase();
      const metadata = parts.slice(1).join("|").trim();

      if (isTheoremKeyword(keyword) && metadata !== "*") {
        theoremCounters[keyword] = (theoremCounters[keyword] || 0) + 1;
      }
    });

    // Reset counters so the second pass increments from 1 again
    const runningCounters: TheoremCounters = {};

    // ── Second pass: transform blockquotes into callout divs ──
    visit(tree, "blockquote", (node: Blockquote, index: number | undefined, parent: any | undefined) => {
      if (index === undefined || !parent || !node.children?.length) return;

      const firstPara = node.children[0] as Paragraph | undefined;
      if (firstPara?.type !== "paragraph" || !firstPara.children?.length) return;

      const firstText = firstPara.children[0] as Text | undefined;
      if (firstText?.type !== "text") return;

      const match = firstText.value.match(KEYWORD_PATTERN);
      if (!match) return;

      const rawKeyword = match[1];
      const parts = rawKeyword.split("|");
      const rawType = parts[0].trim();
      const keyword = rawType.toUpperCase();
      const metadata = parts.slice(1).join("|").trim();
      const collapseFlag = match[2] || ""; // '+' | '-' | ''
      let customTitle = (match[3] || "").trim();

      // Determine effective keyword (fallback to NOTE if unknown)
      const effectiveKeyword = SUPPORTED_KEYWORDS.has(keyword) ? keyword : "NOTE";

      // Determine assigned number for theorem types
      let assignedNumber: number | null = null;
      if (isTheoremKeyword(keyword)) {
        if (metadata === "*") {
          assignedNumber = null; // unnumbered
        } else if (metadata && /^\d/.test(metadata)) {
          assignedNumber = NaN; // custom label (starts with digit, treat as string in rendering)
        } else {
          runningCounters[keyword] = (runningCounters[keyword] || 0) + 1;
          assignedNumber = runningCounters[keyword];
        }
      }

      // Resolve the correct color (PDF variants supported)
      const colorHex = keyword === "PDF" && metadata
        ? getPdfColor(metadata)
        : CALLOUT_META[effectiveKeyword]?.color ?? "#1775d9";

      // Remove the callout title marker from the first paragraph
      if (customTitle) {
        // Remove marker text; custom title is stored separately in data-callout-title
        firstPara.children.shift();
        if (firstPara.children[0]?.type === "text" && /^\n/.test((firstPara.children[0] as Text).value)) {
          (firstPara.children[0] as Text).value = (firstPara.children[0] as Text).value.replace(/^\n+/, "");
        }
        if (firstPara.children.length === 0 || (firstPara.children.length === 1 && firstPara.children[0].type === "text" && !(firstPara.children[0] as Text).value.trim())) {
          node.children.shift();
        }
      } else {
        // Remove the marker line entirely
        firstPara.children.shift();
        if (firstPara.children[0]?.type === "text" && /^\n/.test((firstPara.children[0] as Text).value)) {
          (firstPara.children[0] as Text).value = (firstPara.children[0] as Text).value.replace(/^\n+/, "");
        }
        if (firstPara.children.length === 0 || (firstPara.children.length === 1 && firstPara.children[0].type === "text" && !(firstPara.children[0] as Text).value.trim())) {
          node.children.shift();
        }

        // If no same-line custom title, try to extract title from the next paragraph
        // Only for non-collapsible callouts; collapsible ones use default title
        if (!customTitle && !collapseFlag && node.children.length > 0) {
          const nextPara = node.children[0] as Paragraph | undefined;
          if (nextPara?.type === "paragraph" && nextPara.children.length === 1) {
            const firstChild = nextPara.children[0];
            let extracted: string | null = null;

            if (firstChild.type === "text") {
              extracted = (firstChild as Text).value.trim();
            } else if (firstChild.type === "link" && firstChild.children?.length === 1 && firstChild.children[0].type === "text") {
              const linkText = (firstChild.children[0] as Text).value.trim();
              const linkUrl = (firstChild as any).url || "";
              extracted = `[${linkText}](${linkUrl})`;
            } else if (firstChild.type === "inlineCode") {
              extracted = (firstChild as any).value?.trim() || "";
            }

            // Only accept short titles that don't look like body text
            if (
              extracted &&
              extracted.length <= 40 &&
              !extracted.includes("\n") &&
              !/[。！？]/.test(extracted)
            ) {
              node.children.shift(); // remove this paragraph — it's the title
              customTitle = extracted;
            }
          }
        }
      }

      // Build data attributes
      const dataAttrs: Record<string, string> = {
        "data-callout": rawType.toLowerCase(),
        "data-callout-metadata": metadata,
        "data-callout-fold": collapseFlag,
      };

      if (customTitle) {
        dataAttrs["data-callout-title"] = customTitle;
      }

      if (isTheoremKeyword(keyword)) {
        if (assignedNumber === null) {
          dataAttrs["data-callout-number"] = "none";
        } else if (Number.isNaN(assignedNumber)) {
          dataAttrs["data-callout-number"] = metadata; // custom label string
        } else {
          dataAttrs["data-callout-number"] = String(assignedNumber);
        }
      }

      // Attach metadata for rendering
      (node as any).data = {
        hName: "div",
        hProperties: {
          className: ["callout"],
          ...dataAttrs,
          style: `--callout-color: ${hexToRgbTuple(colorHex)}`,
        },
      };
    });
  };
}
