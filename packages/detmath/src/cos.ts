// A cosine the simulation may use: Math.cos differs between engines in the last bits, so this is a
// Taylor series in plain multiplications and additions (exactly rounded on every engine). Angles
// are degrees, folded into 0…180; past 90 it uses cos(180° − x) = −cos x, so the series only ever
// runs on 0…π/2, where fourteen terms leave it within 1e-15 of the true value.
const RAD = 0.017453292519943295; // π / 180

export function cosDeg(deg: number): number {
  let d = deg % 360;
  if (d < 0) d += 360;
  if (d > 180) d = 360 - d;
  const flip = d > 90;
  const x = (flip ? 180 - d : d) * RAD;
  const x2 = x * x;
  let term = 1;
  let sum = 1;
  for (let k = 1; k <= 14; k++) {
    term = (-term * x2) / ((2 * k - 1) * (2 * k));
    sum += term;
  }
  return flip ? -sum : sum;
}
