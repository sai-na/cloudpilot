/** How the cluster rules write quantities and durations, so every report words them the same way. */

const MI = 2 ** 20;

/** "500m", or "2" for whole cores: the form a manifest uses. */
export function cpuQuantity(cores: number): string {
  const millicores = Math.round(cores * 1000);
  return millicores % 1000 === 0 ? String(millicores / 1000) : `${millicores}m`;
}

/** "64Mi", or "1Gi" for whole gibibytes. */
export function memoryQuantity(bytes: number): string {
  const mebibytes = Math.round(bytes / MI);
  return mebibytes % 1024 === 0 && mebibytes > 0 ? `${mebibytes / 1024}Gi` : `${mebibytes}Mi`;
}

/** "6 minutes", "1 hour", "7.5 hours". */
export function hours(h: number): string {
  if (h < 1) {
    const minutes = Math.max(1, Math.round(h * 60));
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const rounded = Number(h.toFixed(1));
  return `${rounded} ${rounded === 1 ? "hour" : "hours"}`;
}
