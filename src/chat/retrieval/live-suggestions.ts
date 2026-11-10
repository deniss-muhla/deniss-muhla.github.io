import type { ScoredCard } from "./scoring.ts";

/** Promote an exact perspective only for explicit workplace questions; other queries retain cosine order. */
export function selectLiveSuggestions(query: string, ranked: readonly ScoredCard[]): ScoredCard[] {
  const text = query.toLowerCase();
  let preferred: ScoredCard | undefined;
  const workplace = /\b(?:workplaces?|employers?|companies|company|jobs?|work(?:ed)?)\b/.test(text);
  if (workplace && !/\b(?:not|except|excluding)\b/.test(text)) {
    const ordinals = [
      ["first", /\b(?:first|1st|earliest)\b/],
      ["second", /\b(?:second|2nd)\b/],
      ["third", /\b(?:third|3rd)\b/],
      ["fourth", /\b(?:fourth|4th|last|latest)\b/],
    ] as const;
    const matches = ordinals.filter(([, pattern]) => pattern.test(text));
    if (matches.length === 1) {
      preferred = ranked.find((item) => item.id === `experience-${matches[0][0]}-by-start-date-position`);
    } else if (matches.length === 0 && /\b(?:how many|number of|count of)\b/.test(text)) {
      preferred = ranked.find((item) => item.id === "experience-listed-positions-count");
    } else if (matches.length === 0 && /\b(?:which|what)\b/.test(text) && /\b(?:use|used|using|uses)\b/.test(text)) {
      const matches = ranked.filter((item) => {
        if (!item.id.startsWith("technology-position-count-")) return false;
        const technology = item.topic.replace(/ position count$/i, "").toLowerCase();
        const escaped = technology.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(?:^|[^a-z0-9])${escaped}(?=$|[^a-z0-9])`, "i").test(text);
      });
      if (matches.length === 1) preferred = matches[0];
    }
  }
  const eligible = ranked.filter((item) => item.score >= 0.3 && item.id !== preferred?.id);
  return [...(preferred ? [preferred] : []), ...eligible].slice(0, 3);
}
