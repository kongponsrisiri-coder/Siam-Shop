// SiamShop — courier registry + tracking-URL builder.
// Deep links for the common UK couriers; a universal aggregator (ParcelsApp,
// which auto-detects the carrier from the number) is the fallback for "Other"
// or when no carrier was chosen — so a tracking number always yields a link.

const enc = encodeURIComponent;

const CARRIERS = {
  royal_mail:  { name: 'Royal Mail',   url: (t) => `https://www.royalmail.com/track-your-item#/tracking-results/${enc(t)}` },
  parcelforce: { name: 'Parcelforce',  url: (t) => `https://www.parcelforce.com/track-trace?trackNumber=${enc(t)}` },
  dpd:         { name: 'DPD',          url: (t) => `https://track.dpd.co.uk/search?reference=${enc(t)}` },
  evri:        { name: 'Evri',         url: (t) => `https://www.evri.com/track/parcel/${enc(t)}` },
  ups:         { name: 'UPS',          url: (t) => `https://www.ups.com/track?tracknum=${enc(t)}` },
  dhl:         { name: 'DHL',          url: (t) => `https://www.dhl.com/gb-en/home/tracking.html?tracking-id=${enc(t)}` },
  // APC has no clean deep link — use the universal tracker so the number is honoured.
  apc:         { name: 'APC Overnight', url: (t) => `https://parcelsapp.com/en/tracking/${enc(t)}` },
  other:       { name: 'Other / unknown', url: (t) => `https://parcelsapp.com/en/tracking/${enc(t)}` },
};

function list() {
  return Object.entries(CARRIERS).map(([key, v]) => ({ key, name: v.name }));
}

function nameOf(carrierKey) {
  return (CARRIERS[carrierKey] || CARRIERS.other).name;
}

// Build a tracking URL. Falls back to the universal tracker when carrier is
// unknown/unset, so any tracking number still produces a working link.
function trackingUrl(carrierKey, tracking) {
  if (!tracking) return null;
  const c = CARRIERS[carrierKey] || CARRIERS.other;
  return c.url(String(tracking).trim());
}

module.exports = { list, nameOf, trackingUrl };
