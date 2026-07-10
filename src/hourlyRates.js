import { normalizeEmployeeName } from './parser';

// One-time input: hourly pay rates from Book2.xlsx. Update this list and
// redeploy if a rate changes — no upload step needed at runtime.
//
// NOTE: Book2.xlsx spelled two names slightly differently from the hours/
// sales reports. Spelled here to MATCH the hours/sales reports so they line
// up correctly — double check these are the right people:
//   - "Jasmine Chrystal" in Book2.xlsx -> written below as "Jasmin Chrystal"
//   - "Zakiya Harris-Jones" in Book2.xlsx -> written below as "Zakiya Harris Jones"
const RATES = [
  { name: 'Aaliyah Ezekiel', rate: 14 },
  { name: 'Alaijah Pharr', rate: 15 },
  { name: 'Alicia Petrucci', rate: 18 },
  { name: 'Alivia Burkett', rate: 16 },
  { name: 'Alyssa Bachman', rate: 15 },
  { name: 'Amaya Harrington', rate: 14 },
  { name: 'Charlotte Talbot', rate: 18 },
  { name: 'Hannah Schakel', rate: 14 },
  { name: 'Ivy Anthony', rate: 15 },
  { name: 'Jaida Gibson', rate: 16 },
  { name: 'Jasmin Chrystal', rate: 15 },
  { name: 'Jaylynn Muniz', rate: 16 },
  { name: 'Kelitza Zavala', rate: 15 },
  { name: 'Zakiya Harris Jones', rate: 15 },
];

export const PAYROLL_TAX_RATE = 0.08;

const rateByName = {};
RATES.forEach(r => { rateByName[normalizeEmployeeName(r.name)] = r.rate; });

export function getHourlyRate(name) {
  const rate = rateByName[normalizeEmployeeName(name)];
  return rate == null ? null : rate;
}

// Labor cost for a period: hours * rate, with payroll tax added on top.
export function laborCost(hoursDecimal, rate) {
  if (hoursDecimal == null || rate == null) return null;
  return hoursDecimal * rate * (1 + PAYROLL_TAX_RATE);
}
