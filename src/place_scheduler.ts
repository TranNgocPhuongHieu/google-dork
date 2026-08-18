import { CadenceGroup, CadenceSpec, PlaceEntry } from './profiles/types';

// Chọn địa điểm đến hạn — profile-agnostic, không chứa dữ liệu ngôn ngữ.
// Service tự tính; Airflow không cần biết gì về địa điểm.

export interface PlaceChunk {
  /** Stable key used for cadence spreading and diagnostics. */
  key: string;
  provinceSlug: string;
  cadence: CadenceGroup;
  index: number;
  places: PlaceEntry[];
}

/** Hash a stable chunk key so a chunk stays together across cadence cycles. */
function stableHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function daysSinceEpoch(d: Date): number {
  return Math.floor(d.getTime() / 86_400_000);
}

export function isDueToday(
  chunk: PlaceChunk,
  table: Record<CadenceGroup, CadenceSpec>,
  today: Date = new Date(),
): boolean {
  const { cadenceDays } = table[chunk.cadence];
  if (cadenceDays <= 1) return true;
  const offset = stableHash(chunk.key) % cadenceDays;
  return (daysSinceEpoch(today) - offset) % cadenceDays === 0;
}

export function selectDuePlaces(
  chunks: PlaceChunk[],
  table: Record<CadenceGroup, CadenceSpec>,
  today: Date = new Date(),
): PlaceChunk[] {
  return chunks.filter((chunk) => isDueToday(chunk, table, today));
}

/** Cửa sổ ngày cho một địa điểm, tính lùi từ hôm nay. Rộng hơn cadence = chồng lấn. */
export function windowFor(
  chunk: PlaceChunk,
  table: Record<CadenceGroup, CadenceSpec>,
  today: Date = new Date(),
): { dateFrom: string; dateTo: string } {
  const { windowDays } = table[chunk.cadence];
  const to = new Date(today);
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - windowDays);
  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: to.toISOString().slice(0, 10),
  };
}

/** Gộp N địa điểm CÙNG tỉnh + CÙNG cadence thành một OR-group.
 *  Cùng cadence là bắt buộc: khác cadence thì cửa sổ ngày khác nhau. */
export function chunkPlaces(places: PlaceEntry[], perQuery: number): PlaceChunk[] {
  if (!Number.isInteger(perQuery) || perQuery < 1) {
    throw new Error('perQuery must be a positive integer');
  }

  const byKey = new Map<string, PlaceEntry[]>();
  for (const p of places) {
    const k = `${p.provinceSlug}|${p.cadence}`;
    const arr = byKey.get(k) ?? [];
    arr.push(p);
    byKey.set(k, arr);
  }
  const out: PlaceChunk[] = [];
  for (const [groupKey, arr] of byKey) {
    const [provinceSlug, cadence] = groupKey.split('|') as [string, CadenceGroup];
    let index = 0;
    for (let i = 0; i < arr.length; i += perQuery) {
      out.push({
        key: `${groupKey}|${index}`,
        provinceSlug,
        cadence,
        index,
        places: arr.slice(i, i + perQuery),
      });
      index += 1;
    }
  }
  return out;
}
