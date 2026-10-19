/**
 * How full a distribution point (or a cabinet, from its ports added up) is. The one rule behind the colours on the map and the levels on the Ports and waitlist page,
 * so both always agree. The thresholds are the Overview settings "Low when this few ports are free" and "this share is free (%)".
 */
export type PortLevel = 'EXHAUSTED' | 'LOW' | 'OK';
export interface LowPortSettings { lowPortsAbsolute: number; lowPortsPercent: number }
export interface PortCounts { available: number; total: number; faulty: number }

/** The share is of the usable ports (faulty ones do not count, and there is always at least one, so an empty point never divides by zero). */
export const usablePorts = (c: PortCounts): number => Math.max(1, c.total - c.faulty);

/** EXHAUSTED when none is free; LOW when the free count is at or under the count threshold OR the free share is at or under the percentage threshold (either one is enough). */
export function classifyPorts(c: PortCounts, s: LowPortSettings): PortLevel {
  if (c.available <= 0) return 'EXHAUSTED';
  return c.available <= s.lowPortsAbsolute || (c.available / usablePorts(c)) * 100 <= s.lowPortsPercent ? 'LOW' : 'OK';
}
