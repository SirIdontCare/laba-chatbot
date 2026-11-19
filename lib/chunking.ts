export const MAX_CHUNK_CHARS = 800;

// Jeden akapit (tekst oddzielony pustą linią) = jeden fragment. Krótkich akapitów nie łączymy.
// Akapit dłuższy niż MAX_CHUNK_CHARS dzielimy na granicy zdania.
export function splitIntoChunks(text: string): string[] {
  return text
    .replace(/\r\n?/g, "\n")
    .split(/\n[ \t]*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)
    .flatMap(paragraph => paragraph.length <= MAX_CHUNK_CHARS ? [paragraph] : splitLongParagraph(paragraph));
}

function splitLongParagraph(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?…])\s+/).flatMap(splitOverlongSentence);
  const pieces: string[] = [];
  let current = "";
  for (const sentence of sentences) {
    if (current && current.length + 1 + sentence.length > MAX_CHUNK_CHARS) {
      pieces.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

// Zdanie dłuższe niż limit (np. lista bez kropek) tniemy na najbliższej spacji przed limitem.
function splitOverlongSentence(sentence: string): string[] {
  const parts: string[] = [];
  let rest = sentence;
  while (rest.length > MAX_CHUNK_CHARS) {
    const space = rest.lastIndexOf(" ", MAX_CHUNK_CHARS);
    const cut = space > 0 ? space : MAX_CHUNK_CHARS;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
