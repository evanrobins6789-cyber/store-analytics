import { normalizeEmployeeName } from './parser';

// One-time input: this is the employee → store list from Book1.xlsx.
// To update it later, just edit the arrays below and redeploy — no
// upload step needed at runtime.
const STORES = [
  { name: 'PIKE CREEK', employees: ['Alicia Petrucci', 'Jaylynn Muniz', 'Charlotte Talbot', 'Alivia Burkett', 'Jasmin Chrystal'] },
  { name: 'MEDIA', employees: ['Amaya Harrington', 'Alaijah Pharr', 'Hannah Schakel', 'Aaliyah Ezekiel'] },
  { name: 'CONCORD', employees: ['Jaida Gibson', 'Alyssa Bachman', 'Zakiya Harris Jones', 'Ivy Anthony', 'Kelitza Zavala'] },
];

const storeByName = {};
STORES.forEach(s => {
  s.employees.forEach(n => { storeByName[normalizeEmployeeName(n)] = s.name; });
});

export const STORE_ROSTER = { stores: STORES, storeByName };
