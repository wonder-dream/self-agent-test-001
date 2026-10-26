const MICRO = 1_000_000n;

export function decimalToMicro(value: string): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`无法解析金额：${value}`);
  }
  const [whole, frac = ""] = value.split(".");
  const head = (frac + "000000").slice(0, 6);
  const micros = BigInt(whole) * MICRO + BigInt(head);
  const rest = frac.slice(6);
  return rest.split("").some((digit) => digit !== "0") ? micros + 1n : micros;
}

export function tokenCostMicro(tokens: number, cnyPerMillion: string, multiplier: bigint): bigint {
  if (!Number.isFinite(tokens) || tokens <= 0) return 0n;
  const numerator = BigInt(Math.ceil(tokens)) * decimalToMicro(cnyPerMillion) * multiplier;
  return (numerator + MICRO - 1n) / MICRO;
}

export function formatCny(micro: bigint): string {
  const negative = micro < 0n;
  const abs = negative ? -micro : micro;
  const whole = abs / MICRO;
  const frac = (abs % MICRO).toString().padStart(6, "0").slice(0, 4);
  return `${negative ? "-" : ""}${whole}.${frac} 元`;
}
