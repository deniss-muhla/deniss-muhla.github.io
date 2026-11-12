// Paradee v1.1 web/misaki.js, Apache-2.0, sahilmahendrakar/paradee.
const conversions: [string, string][] = [
  ["ʔˌn̩", "ʔn"], ["ʔn̩", "ʔn"], ["aɪ", "I"], ["aʊ", "W"],
  ["dʒ", "ʤ"], ["eɪ", "A"], ["e", "A"], ["tʃ", "ʧ"], ["ɔɪ", "Y"],
  ["ʲo", "jo"], ["ʲə", "jə"], ["ʲ", ""], ["ɚ", "əɹ"], ["r", "ɹ"],
  ["x", "k"], ["ç", "k"], ["ɬ", "l"], ["̃", ""],
];
export function toMisaki(value: string): string {
  for (const [from, to] of conversions) value = value.split(from).join(to);
  return value.replace(/(\S)̩/gu, "ᵊ$1").replace(/̩/g, "")
    .replace(/əl(?=[\s;:,.!?—…”“”()]|$)/gu, "ᵊl")
    .replace(/ɐ(?![\s;:,.!?—…”“”()]|$)/gu, "ə")
    .replaceAll("oʊ", "O").replaceAll("ɜːɹ", "ɜɹ").replaceAll("ɜː", "ɜɹ")
    .replaceAll("ɪə", "iə").replaceAll("ː", "").replaceAll("o", "ɔ")
    .replaceAll("ɾ", "T").replaceAll("ʔ", "t");
}

export function tokenizeChunks(phonemes: string, vocab: Record<string, number>): BigInt64Array[] {
  let chars = [...phonemes].filter((ch) => Object.hasOwn(vocab, ch));
  const chunks: BigInt64Array[] = [];
  while (chars.length) {
    let cut = Math.min(510, chars.length);
    if (chars.length > 510) {
      const space = chars.slice(0, 510).lastIndexOf(" ");
      if (space > 0) cut = space;
    }
    const body = chars.slice(0, cut);
    chunks.push(BigInt64Array.from([0, ...body.map((ch) => vocab[ch]), 0], BigInt));
    chars = chars.slice(cut);
    while (chars[0] === " ") chars.shift();
  }
  return chunks;
}
