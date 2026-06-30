// Fuzzy matches spoken item names (English/Tamil/Tanglish, brand names,
// abbreviations) against the shop's live product catalog, and normalizes
// spoken units/quantities. This runs both (a) server-side as a safety net
// validator on whatever Gemini Live extracts via function-calling, and
// (b) is exposed in the system prompt as the canonical catalog the model
// must constrain its answers to.

import { readAll } from "../state/store.js";

// Common Tamil/Tanglish aliases -> canonical English catalog terms.
// Extend this table per shop / per region as real call data comes in.
export const ALIASES = {
  arisi: "rice",
  sakkarai: "sugar",
  sakkara: "sugar",
  ennai: "oil",
  uppu: "salt",
  paruppu: "dal",
  thuvaram: "toor",
  milagai: "chilli",
  thool: "powder",
  saaman: "items",
  sabu: "soap",
};

const UNIT_MAP = {
  kg: "kg", kilo: "kg", kilos: "kg", kgs: "kg",
  g: "g", gram: "g", grams: "g",
  litre: "litre", liter: "litre", l: "litre", litres: "litre",
  ml: "ml",
  packet: "packet", packets: "packet", pack: "packet",
  box: "box", boxes: "box",
  dozen: "dozen", dozens: "dozen",
  piece: "piece", pieces: "piece", pc: "piece",
  bag: "bag", bags: "bag",
};

const WORD_NUMBERS = {
  oru: 1, onnu: 1, one: 1, rendu: 2, two: 2, moonu: 3, three: 3,
  naalu: 4, four: 4, anju: 5, five: 5, half: 0.5, "half kg": 0.5,
};

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

function normalizeToken(tok) {
  const t = tok.toLowerCase().trim();
  return ALIASES[t] || t;
}

/**
 * Normalize a spoken unit string ("kilo", "litre la") to a canonical unit.
 */
export function normalizeUnit(spoken) {
  if (!spoken) return null;
  const t = spoken.toLowerCase().replace(/[^a-z]/g, "");
  return UNIT_MAP[t] || null;
}

/**
 * Parse a spoken quantity ("rendu", "half kg", "2.5") into a number.
 */
export function parseQuantity(spoken) {
  if (typeof spoken === "number") return spoken;
  const t = String(spoken).toLowerCase().trim();
  if (WORD_NUMBERS[t] != null) return WORD_NUMBERS[t];
  const num = parseFloat(t.replace(/[^0-9.]/g, ""));
  return Number.isFinite(num) ? num : null;
}

/**
 * Fuzzy-match a spoken item phrase against the shop's catalog.
 * Returns ranked candidates with a confidence score 0..1.
 */
export function matchItem(spokenPhrase, shopId = "default") {
  const catalog = readAll(`catalog_${shopId}`, []);
  const needle = normalizeToken(spokenPhrase);

  const scored = catalog.map((p) => {
    const haystacks = [p.name, p.brand, `${p.brand} ${p.name}`].map((s) => s.toLowerCase());
    let best = 0;
    for (const h of haystacks) {
      const dist = levenshtein(needle, h);
      const sim = 1 - dist / Math.max(needle.length, h.length, 1);
      if (h.includes(needle) || needle.includes(h)) best = Math.max(best, 0.85);
      best = Math.max(best, sim);
    }
    return { product: p, confidence: Math.round(best * 100) / 100 };
  });

  scored.sort((a, b) => b.confidence - a.confidence);
  return scored.slice(0, 5).filter((s) => s.confidence > 0.35);
}

/**
 * Full order-line resolver: spoken item + qty + unit -> catalog line item
 * or a clarification request if ambiguous / out of stock.
 */
export function resolveOrderLine({ itemPhrase, quantity, unit }, shopId = "default") {
  const matches = matchItem(itemPhrase, shopId);
  const qty = parseQuantity(quantity);
  const normUnit = normalizeUnit(unit);

  if (matches.length === 0) {
    return { status: "not_found", itemPhrase };
  }
  const top = matches[0];
  const ambiguous = matches.length > 1 && matches[1].confidence > top.confidence - 0.08;

  if (ambiguous) {
    return { status: "ambiguous", candidates: matches.slice(0, 3) };
  }
  if (top.product.stock <= 0) {
    return { status: "out_of_stock", product: top.product, substitutes: matches.slice(1, 3) };
  }
  return {
    status: "resolved",
    product: top.product,
    quantity: qty,
    unit: normUnit || top.product.unit,
    lineTotal: qty && top.product.price ? Math.round(qty * top.product.price) : null,
    confidence: top.confidence,
  };
}
