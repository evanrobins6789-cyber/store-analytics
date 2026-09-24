import { normalizeEmployeeName } from './parser';

// One-time input: this is the employee → store list from Book1.xlsx.
// To update it later, just edit the arrays below and redeploy — no
// upload step needed at runtime.
const STORES = [
  { name: 'PIKE CREEK', employees: ['Alicia Petrucci', 'Jaylynn Muniz', 'Charlotte Talbot', 'Alivia Burkett', 'Jasmin Chrystal', 'Jaida Gibson', 'Samantha Sullivan', 'Ciana Santiago'] },
  { name: 'MEDIA', employees: ['Alaijah Pharr', 'Hannah Schakel', 'Alanna Baker', 'Emily DuHaime', "Ni'Jay Black", 'Samantha Sullivan', 'Ciana Santiago'] },
  { name: 'CONCORD', employees: ['Jaida Gibson', 'Alyssa Bachman', 'Zakiya Harris Jones', 'Ivy Anthony', 'Kelitza Zavala', 'Samantha Sullivan', 'Ciana Santiago'] },
];

const storeByName = {};
STORES.forEach(s => {
  s.employees.forEach(n => { storeByName[normalizeEmployeeName(n)] = s.name; });
});

export const STORE_ROSTER = { stores: STORES, storeByName };
