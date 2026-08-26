const MAX_CHUNK_WORDS = 300;
const CHUNK_OVERLAP_WORDS = 40;

export interface TextChunk {
  content: string;
  contentHash: string;
}

export function chunkMessage(content: string): TextChunk[] {
  const words = content.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return [];

  const chunks: TextChunk[] = [];
  const step = MAX_CHUNK_WORDS - CHUNK_OVERLAP_WORDS;
  for (let start = 0; start < words.length; start += step) {
    const chunk = words.slice(start, start + MAX_CHUNK_WORDS).join(" ");
    chunks.push({ content: chunk, contentHash: hashContent(chunk) });
    if (start + MAX_CHUNK_WORDS >= words.length) break;
  }
  return chunks;
}

function hashContent(content: string): string {
  return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}
