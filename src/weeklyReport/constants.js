// Ported from Lauren's wtc-weekly-report app (lib/constants.js).

// Zenoti "Center Name" -> our studio keys
export const CENTER_TO_STUDIO = {
  'PA-Media': 'Media',
  'DE-Wilmington Pike Creek': 'Pike Creek',
  'DE-Wilmington (Concord)': 'Concord',
};

export const STUDIOS = ['Media', 'Pike Creek', 'Concord'];

// Sales-Accrual "Item Subcategory" values that count as non-waxing add-ons
// (everything else is a waxing service and is excluded from Add-On Services).
export const NON_WAXING_SUBCATEGORIES = [
  'Enhancements',
  'EyelashEyebrow Tinting',
  'Enhancement Add On',
  'Detoxifying',
];

// Service-revenue commission tiers (per pay period), confirmed against the
// studio's own bonus schedule screenshot.
export const SR_TIERS = [
  { min: 10000, rate: 0.12 },
  { min: 8000, rate: 0.10 },
  { min: 6000, rate: 0.08 },
  { min: 4000, rate: 0.06 },
  { min: 2000, rate: 0.04 },
  { min: 0, rate: 0.0 },
];

// Distance-to-tier reference thresholds, matching the studio's own sheet formula exactly.
export const SR_TIER_THRESHOLDS = [2001, 4001, 6001, 8001];

export function srRate(serviceRev) {
  for (const tier of SR_TIERS) {
    if (serviceRev > tier.min) return tier.rate;
  }
  return 0;
}

export function normalizeName(name) {
  if (!name) return '';
  return name
    .replace(/\([^)]*\)/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Standard monthly price per membership type, PER STUDIO (Media prices
// differ from Concord/Pike Creek for several membership types) — derived from
// the most common (mode) Sales value seen for each Studio + Membership Name
// combination across historical Memberships.csv uploads. Used for New
// Memberships / Newly Cancelled so the dollar figure is consistent regardless
// of any one-off quirk (proration, promo pricing, etc.) in a specific row.
// Falls back to that row's own Sales value if a combination isn't recognized.
export const MEMBERSHIP_STANDARD_PRICE = {
  Media: {
    'Basic Bikini (V) + Membership': 36,
    'Brow Wax + Membership': 20,
    'Full Brazilian (V) + Membership': 52,
    'Full Buttocks + Membership': 32,
    'Full Face + Membership': 38.4,
    'Full Legs + Membership': 68,
    'Modified Bikini (V) + Membership': 44,
    'Underarms + Membership': 24,
  },
  'Pike Creek': {
    'Basic Bikini (V) + Membership': 40,
    'Brow Lamination + Membership': 36,
    'Brow Tint + Membership': 24,
    'Brow Wax + Membership': 20,
    'Calming Skin Treatment - Brazilian (V) + Membership': 36,
    'Full Brazilian (V) + Membership': 56,
    'Full Buttocks + Membership': 28,
    'Full Face + Membership': 40,
    'Full Legs + Membership': 72,
    'Half Leg + Membership': 44,
    'Inner Buttocks + Membership': 20,
    'Modified Bikini (V) + Membership': 48,
    'Underarms + Membership': 24,
  },
  Concord: {
    'Basic Bikini (V) + Membership': 40,
    'Brow Lamination + Membership': 72,
    'Brow Wax + Membership': 20,
    'Full Back + Membership': 60,
    'Full Brazilian (V) + Membership': 56,
    'Full Face + Membership': 40,
    'Full Legs + Membership': 72,
    'Half Leg + Membership': 44,
    'Smooth & Soothe Brazilian (V) + Membership': 80,
    'Underarms + Membership': 24,
  },
};

export function standardMembershipPrice(studio, membershipName, fallback) {
  return MEMBERSHIP_STANDARD_PRICE[studio]?.[membershipName] ?? fallback;
}
