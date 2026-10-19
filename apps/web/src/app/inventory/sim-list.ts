/** Card numbers (ICCIDs) pasted as text: split on any whitespace, comma or semicolon, trimmed, without blanks or repeats, in the order given. */
export function parseSimList(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((x) => x.trim()).filter(Boolean))];
}
