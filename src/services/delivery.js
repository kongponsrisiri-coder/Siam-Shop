// SiamShop — UK delivery zone classification by postcode (SIAMSHOP-007).
// Three zones (Nick's brief): London / UK Mainland / Remote. We classify on the
// postcode "area" (the leading letters) plus a few district-level exceptions.
// The fee for each zone is configurable per shop in shop_settings.

// Greater London postal areas.
const LONDON_AREAS = new Set([
  'E', 'EC', 'N', 'NW', 'SE', 'SW', 'W', 'WC', // London postal districts
  'BR', 'CR', 'DA', 'EN', 'HA', 'IG', 'KT', 'RM', 'SM', 'TW', 'UB', 'WD', // Greater London
]);

// Remote: Scottish Highlands & Islands, Northern Ireland, Isle of Man,
// Channel Islands, and the Isles of Scilly (handled as a district exception).
const REMOTE_AREAS = new Set([
  'AB', 'IV', 'KW', 'PA', 'PH', 'HS', 'ZE', // Scottish Highlands & Islands
  'BT', // Northern Ireland
  'IM', // Isle of Man
  'GY', 'JE', // Channel Islands
]);

// Parse the outward code (e.g. "SW1A 1AA" -> "SW1A") and its alpha area ("SW").
function parsePostcode(raw) {
  const pc = String(raw || '').toUpperCase().replace(/\s+/g, '');
  if (pc.length < 2) return null;
  // Outward code is everything except the final 3 chars (the inward code).
  const outward = pc.length > 3 ? pc.slice(0, pc.length - 3) : pc;
  const area = (outward.match(/^[A-Z]+/) || [''])[0];
  return { pc, outward, area };
}

// Returns 'london' | 'mainland' | 'remote', or null if the postcode is invalid.
function classifyZone(raw) {
  const p = parsePostcode(raw);
  if (!p || !p.area) return null;
  // Isles of Scilly: TR21–TR25 are remote even though TR (Cornwall) isn't.
  if (p.area === 'TR') {
    const district = Number((p.outward.match(/\d+/) || [0])[0]);
    return district >= 21 && district <= 25 ? 'remote' : 'mainland';
  }
  if (REMOTE_AREAS.has(p.area)) return 'remote';
  if (LONDON_AREAS.has(p.area)) return 'london';
  return 'mainland';
}

const ZONE_LABELS = {
  london: 'London',
  mainland: 'UK Mainland',
  remote: 'Remote (Highlands, NI, Islands)',
};

module.exports = { classifyZone, ZONE_LABELS };
