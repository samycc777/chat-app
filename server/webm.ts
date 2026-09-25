import fs from 'fs';

// A browser records WebM as a live stream: the file never says how long it is, and it has no index
// of where each part starts. Players then show no length and cannot skip ahead without downloading
// everything before that point. Once a recording is finished, it is rewritten once with its length
// and an index (Cues) in front of the video, which is what lets an hour-long lesson be skipped
// through straight from the server. Only the headers are rewritten; the video itself is copied.

const EBML = 0x1a45dfa3;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const CLUSTER = 0x1f43b675;
const TIMECODE = 0xe7;
const SIMPLE_BLOCK = 0xa3;
const TIMECODE_SCALE = 0x2ad7b1;
const DURATION = 0x4489;
const TRACK_ENTRY = 0xae;
const TRACK_NUMBER = 0xd7;
const TRACK_TYPE = 0x83;
// Elements that can only appear directly in the Segment; meeting one ends a cluster of unknown size.
const TOP_LEVEL = new Set([EBML, SEGMENT, INFO, TRACKS, CLUSTER, 0x1c53bb6b, 0x114d9b74, 0x1254c367, 0x1043a770, 0x1941a469]);

const WINDOW = 4 * 1024 * 1024;

/** Reads a file through a moving window, so walking thousands of small headers stays fast. */
class Reader {
  private buffer = Buffer.alloc(WINDOW);
  private start = 0;
  private length = 0;
  constructor(private fd: number, readonly size: number) {}

  bytes(position: number, count: number): Buffer | null {
    if (position < 0 || position + count > this.size) return null;
    if (position < this.start || position + count > this.start + this.length) {
      this.start = position;
      this.length = fs.readSync(this.fd, this.buffer, 0, WINDOW, position);
    }
    return this.buffer.subarray(position - this.start, position - this.start + count);
  }

  /** An element's ID and size, and where its body starts. */
  header(position: number): { id: number; size: number | null; body: number } | null {
    const first = this.bytes(position, 1)?.[0];
    if (!first) return null;
    const idLength = Math.clz32(first) - 23;
    if (idLength < 1 || idLength > 4) return null;
    const idBytes = this.bytes(position, idLength);
    if (!idBytes) return null;
    const id = idBytes.readUIntBE(0, idLength);
    const sizeFirst = this.bytes(position + idLength, 1)?.[0];
    if (!sizeFirst) return null;
    const sizeLength = Math.clz32(sizeFirst) - 23;
    if (sizeLength < 1 || sizeLength > 8) return null;
    const sizeBytes = this.bytes(position + idLength, sizeLength);
    if (!sizeBytes) return null;
    let size = sizeFirst & (0xff >> sizeLength);
    let unknown = size === (0xff >> sizeLength);
    for (let index = 1; index < sizeLength; index++) {
      size = size * 256 + sizeBytes[index];
      if (sizeBytes[index] !== 0xff) unknown = false;
    }
    return { id, size: unknown ? null : size, body: position + idLength + sizeLength };
  }

  read(position: number, count: number): Buffer {
    const out = Buffer.alloc(count);
    fs.readSync(this.fd, out, 0, count, position);
    return out;
  }
}

function readUint(bytes: Buffer) {
  let value = 0;
  for (const byte of bytes) value = value * 256 + byte;
  return value;
}

/** Walks the children of an element's body, stopping at its end or at a partial child. */
function* children(reader: Reader, from: number, to: number) {
  let position = from;
  while (position < to) {
    const child = reader.header(position);
    if (!child || child.size === null || child.body + child.size > to) return;
    yield { id: child.id, size: child.size, body: child.body, start: position, end: child.body + child.size };
    position = child.body + child.size;
  }
}

const size8 = (value: number) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); out[0] = 0x01; return out; };
const uint8 = (value: number) => { const out = Buffer.alloc(8); out.writeBigUInt64BE(BigInt(value)); return out; };
const idBytes = (id: number) => { const hex = id.toString(16); return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex'); };
const element = (id: number, body: Buffer) => Buffer.concat([idBytes(id), size8(body.length), body]);

// A cluster is listed in the index only if its first picture is a whole one (a keyframe), because
// a player that starts anywhere else shows garbage until the next keyframe.
interface Cluster { start: number; end: number; keyTime: number | null }

/**
 * Rewrites a finished WebM recording with its length and an index. Returns false, leaving the file
 * as it was, if the file is not laid out as a browser records it.
 */
export async function indexWebm(filePath: string, durationMs: number): Promise<boolean> {
  const fd = fs.openSync(filePath, 'r');
  let layout: { ebml: Buffer; info: Buffer; tracks: Buffer; clusters: Cluster[]; videoTrack: number } | null = null;
  try {
    const reader = new Reader(fd, fs.fstatSync(fd).size);
    const ebml = reader.header(0);
    if (ebml?.id !== EBML || ebml.size === null) return false;
    const segment = reader.header(ebml.body + ebml.size);
    if (segment?.id !== SEGMENT) return false;
    const segmentEnd = segment.size === null ? reader.size : Math.min(reader.size, segment.body + segment.size);

    let info: Buffer | null = null;
    let tracks: Buffer | null = null;
    let videoTrack = 1;
    const clusters: Cluster[] = [];
    let position = segment.body;
    while (position < segmentEnd) {
      const top = reader.header(position);
      if (!top) break;
      if (top.id === CLUSTER) {
        // A live recording's clusters have no size: they end where the next top-level element starts.
        const limit = top.size === null ? segmentEnd : Math.min(segmentEnd, top.body + top.size);
        let end = top.body;
        let timecode: number | null = null;
        let keyTime: number | null = null;
        let videoSeen = false;
        for (const child of children(reader, top.body, limit)) {
          if (top.size === null && TOP_LEVEL.has(child.id)) break;
          if (child.id === TIMECODE) timecode = readUint(reader.read(child.body, child.size));
          if (child.id === SIMPLE_BLOCK && !videoSeen && child.size >= 4) {
            const block = reader.read(child.body, 4);
            if (block[0] === (0x80 | videoTrack)) {
              videoSeen = true;
              if (block[3] & 0x80 && timecode !== null) keyTime = Math.max(0, timecode + block.readInt16BE(1));
            }
          }
          end = child.end;
        }
        if (end > top.body) clusters.push({ start: top.body, end, keyTime });
        if (end === position || end <= top.body) break;
        position = end;
        continue;
      }
      if (top.size === null || top.body + top.size > segmentEnd) break;
      if (top.id === INFO) {
        // The length goes into Info, in its time units (a millionth of a second by default).
        const parts: Buffer[] = [];
        let scale = 1_000_000;
        for (const child of children(reader, top.body, top.body + top.size)) {
          if (child.id === DURATION) continue;
          if (child.id === TIMECODE_SCALE) scale = readUint(reader.read(child.body, child.size)) || scale;
          parts.push(reader.read(child.start, child.end - child.start));
        }
        const duration = Buffer.alloc(8);
        duration.writeDoubleBE(durationMs * 1_000_000 / scale);
        parts.push(Buffer.concat([idBytes(DURATION), Buffer.from([0x88]), duration]));
        info = element(INFO, Buffer.concat(parts));
      } else if (top.id === TRACKS) {
        tracks = reader.read(position, top.body + top.size - position);
        for (const entry of children(reader, top.body, top.body + top.size)) {
          if (entry.id !== TRACK_ENTRY) continue;
          let number = 0;
          let type = 0;
          for (const field of children(reader, entry.body, entry.end)) {
            if (field.id === TRACK_NUMBER) number = readUint(reader.read(field.body, field.size));
            if (field.id === TRACK_TYPE) type = readUint(reader.read(field.body, field.size));
          }
          if (type === 1 && number) { videoTrack = number; break; }
        }
      }
      // Anything else (an old index, padding) is left out; it would point to the wrong places.
      position = top.body + top.size;
    }
    if (!info || !tracks || !clusters.length || videoTrack > 126) return false;
    layout = { ebml: reader.read(0, ebml.body + ebml.size), info, tracks, clusters, videoTrack };
  } finally {
    fs.closeSync(fd);
  }
  if (!layout) return false;
  const { videoTrack } = layout;

  // The index comes before the video and has a fixed size per entry, so where each cluster will
  // land is known before anything is written.
  const indexed = layout.clusters.filter(cluster => cluster.keyTime !== null);
  const cuesSize = 4 + 8 + indexed.length * 27;
  const clusterSize = (cluster: Cluster) => 4 + 8 + cluster.end - cluster.start;
  const positions = new Map<Cluster, number>();
  let offset = layout.info.length + layout.tracks.length + cuesSize;
  for (const cluster of layout.clusters) { positions.set(cluster, offset); offset += clusterSize(cluster); }
  const cuePoints = indexed.map(cluster => Buffer.concat([
    Buffer.from([0xbb, 0x80 | 25]),
    Buffer.from([0xb3, 0x88]), uint8(cluster.keyTime!),
    Buffer.from([0xb7, 0x80 | 13, 0xf7, 0x81, videoTrack, 0xf1, 0x88]), uint8(positions.get(cluster)!),
  ]));
  const cues = element(0x1c53bb6b, Buffer.concat(cuePoints));

  const temporary = `${filePath}.indexing`;
  const source = await fs.promises.open(filePath, 'r');
  const target = await fs.promises.open(temporary, 'w');
  try {
    await target.write(Buffer.concat([layout.ebml, idBytes(SEGMENT), size8(offset), layout.info, layout.tracks, cues]));
    const buffer = Buffer.alloc(1024 * 1024);
    for (const cluster of layout.clusters) {
      await target.write(Buffer.concat([idBytes(CLUSTER), size8(cluster.end - cluster.start)]));
      for (let position = cluster.start; position < cluster.end;) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, cluster.end - position), position);
        if (!bytesRead) throw new Error('Recording ended early');
        await target.write(buffer.subarray(0, bytesRead));
        position += bytesRead;
      }
    }
  } catch (cause) {
    await target.close();
    await source.close();
    fs.rmSync(temporary, { force: true });
    throw cause;
  }
  await target.close();
  await source.close();
  fs.renameSync(temporary, filePath);
  return true;
}
