// Heads-up river CFR+ solver over a discretized bet tree. Returns per-node,
// per-combo strategies + EV + exploitability (% pot). Amounts in big blinds.
// Exploit mode (opts.exploit) locks the villain's first river decisions to
// observed tendencies and best-responds for the hero.

import { cardToId, evaluate7 } from './pokerEngine.js';

const RANK_ORDER = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const SUITS = ['s', 'h', 'd', 'c'];
export const CAT_NAME = ['High card', 'Pair', 'Two pair', 'Three of a kind', 'Straight', 'Flush', 'Full house', 'Quads', 'Straight flush'];

export function rangeKey(r, c) {
  const a = RANK_ORDER[r], b = RANK_ORDER[c];
  if (r === c) return a + b;
  if (r < c) return a + b + 's';
  return b + a + 'o';
}

export function comboCardsFor(key) {
  const out = [];
  if (key.length === 2) {
    const v = key[0];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) out.push([{ v, s: SUITS[i] }, { v, s: SUITS[j] }]);
    return out;
  }
  const hi = key[0], lo = key[1], suited = key[2] === 's';
  if (suited) for (const s of SUITS) out.push([{ v: hi, s }, { v: lo, s }]);
  else for (const s1 of SUITS) for (const s2 of SUITS) if (s1 !== s2) out.push([{ v: hi, s: s1 }, { v: lo, s: s2 }]);
  return out;
}

// One side's live combos on the board (board removal + optional hand restrict).
function buildCombos(rangeKeys, board, restrictIds) {
  const bIds = board.map(cardToId);
  const boardSet = new Set(board.map((c) => c.v + c.s));
  const out = [];
  for (const hkey of rangeKeys) {
    for (const cc of comboCardsFor(hkey)) {
      const a = cc[0].v + cc[0].s, b = cc[1].v + cc[1].s;
      if (restrictIds && !restrictIds.has(a + b) && !restrictIds.has(b + a)) continue;
      if (boardSet.has(a) || boardSet.has(b)) continue;
      const c0 = cardToId(cc[0]), c1 = cardToId(cc[1]);
      const score = evaluate7(c0, c1, bIds[0], bIds[1], bIds[2], bIds[3], bIds[4]);
      out.push({
        id: a + b, hkey, cards: cc, score, cat: score >>> 20, c0, c1,
        lo: ((c0 < 32 ? (1 << c0) : 0) | (c1 < 32 ? (1 << c1) : 0)) >>> 0,
        hi: ((c0 >= 32 ? (1 << (c0 - 32)) : 0) | (c1 >= 32 ? (1 << (c1 - 32)) : 0)) >>> 0,
      });
    }
  }
  return out;
}

// HU river betting tree; terminals resolve by showdown or fold.
function buildTree(spot) {
  const onSizes = spot.betSizes.filter((b) => b.on);
  const S = spot.stack;

  let repId = null, repPct = 75, bestD = Infinity;
  for (const b of onSizes) { const d = Math.abs(b.pct - 75); if (d < bestD) { bestD = d; repId = b.id; repPct = b.pct; } }

  function showdown(pot, inv) { return { terminal: true, type: 'showdown', pot, inv }; }
  function foldT(pot, inv, winner) { return { terminal: true, type: 'fold', pot, inv, winner }; }
  function dec(player, actions, children, extra) { return { terminal: false, player, actions, children, ...extra }; }

  // Options when `toAct` faces no bet: check + each distinct bet/all-in amount.
  function betOptions(pot, inv, toAct) {
    const rem = S - inv[toAct];
    const acts = [], amts = [];
    const seen = new Set();
    for (const b of onSizes) {
      let amt = Math.round(pot * b.pct / 100);
      if (amt >= rem) amt = rem;
      if (amt <= 0) continue;
      if (seen.has(amt)) continue;
      seen.add(amt);
      acts.push({ id: b.id, kind: 'bet', pct: b.pct }); amts.push(amt);
    }
    if (spot.allIn && rem > 0 && !seen.has(rem)) { acts.push({ id: 'allin', kind: 'bet', pct: 999 }); amts.push(rem); }
    return { acts, amts };
  }

  // No bet pending. afterCheck = the other player already checked to us.
  function buildOpen(toAct, pot, inv, afterCheck) {
    const { acts, amts } = betOptions(pot, inv, toAct);
    const actions = [{ id: 'check', kind: 'check' }, ...acts];
    const children = [];
    // check
    children.push(afterCheck ? showdown(pot, inv.slice()) : buildOpen(1 - toAct, pot, inv.slice(), true));
    // bets
    for (let i = 0; i < acts.length; i++) {
      const amt = amts[i];
      const ninv = inv.slice(); ninv[toAct] += amt;
      children.push(buildFacing(1 - toAct, pot + amt, ninv, { toCall: amt, agg: toAct, depth: 0 }));
    }
    return dec(toAct, actions, children, { kind: 'open' });
  }

  // Facing a bet/raise: fold / call / (raise|all-in by depth).
  function buildFacing(toAct, pot, inv, st) {
    const rem = S - inv[toAct];
    const toCall = Math.min(st.toCall, rem);
    const actions = [{ id: 'fold', kind: 'fold' }, { id: 'call', kind: 'call' }];
    const children = [foldT(pot, inv.slice(), st.agg)];
    const cinv = inv.slice(); cinv[toAct] += toCall;
    children.push(showdown(pot + toCall, cinv));
    // raise (depth 0) → pot-sized raise; all-in (depth 1) → shove; depth 2 → none
    if (st.depth < 2 && rem > toCall) {
      let add;
      if (st.depth === 0) add = Math.min(toCall + (pot + toCall), rem);  // pot-sized raise
      else add = rem;                                                     // re-raise = all-in
      const rinv = inv.slice(); rinv[toAct] += add;
      const newCall = rinv[toAct] - inv[1 - toAct];
      actions.push(st.depth === 0 ? { id: 'raise', kind: 'raise' } : { id: 'allin', kind: 'raise' });
      children.push(buildFacing(1 - toAct, pot + add, rinv, { toCall: newCall, agg: toAct, depth: st.depth + 1 }));
    }
    return dec(toAct, actions, children, { kind: 'facing', depth: st.depth });
  }

  const root = buildOpen(0, spot.pot, [0, 0], false);                  // OOP first
  const ipVsCheck = root.children[0];                                   // OOP checked → IP
  const repIdx = root.actions.findIndex((a) => a.id === repId);
  const ipVsBet = repIdx > 0 ? root.children[repIdx] : null;            // OOP bet rep → IP faces
  const repIdx2 = ipVsCheck.actions ? ipVsCheck.actions.findIndex((a) => a.id === repId) : -1;
  const oopVsBet = repIdx2 > 0 ? ipVsCheck.children[repIdx2] : null;    // check, IP bet rep → OOP faces

  return { root, repPct, display: { oop_first: root, ip_vs_check: ipVsCheck, ip_vs_bet: ipVsBet, oop_vs_bet: oopVsBet } };
}

// Attach CFR storage to every decision node, sized by the acting player's combos.
function initNodes(node, nOOP, nIP) {
  if (node.terminal) return;
  const N = node.player === 0 ? nOOP : nIP;
  const A = node.actions.length;
  const maxN = Math.max(nOOP, nIP);
  node.N = N; node.A = A;
  node.regret = new Float64Array(N * A);
  node.strat = new Float64Array(N * A);  // accumulated (linear-weighted) strategy
  // scratch reused across all iterations — cfr/evalValue never run concurrently
  node.sBuf = new Float64Array(N * A);
  node.reachBuf = Array.from({ length: A }, () => new Float64Array(N));
  node.cfvBuf = Array.from({ length: A }, () => new Float64Array(maxN));
  for (const ch of node.children) initNodes(ch, nOOP, nIP);
}

// Regret-matching+ strategy for one combo into `out` (length A).
function strategyOf(node, i, out) {
  const A = node.A, base = i * A;
  let sum = 0;
  for (let a = 0; a < A; a++) { const r = node.regret[base + a]; out[a] = r > 0 ? r : 0; sum += out[a]; }
  if (sum > 0) { for (let a = 0; a < A; a++) out[a] /= sum; }
  else { const u = 1 / A; for (let a = 0; a < A; a++) out[a] = u; }
}

export function solve(board, oopKeys, ipKeys, spot, opts = {}, onProgress) {
  const iters = opts.iterations || 256;
  const oop = buildCombos(oopKeys, board, opts.oopRestrict);
  const ip = buildCombos(ipKeys, board, opts.ipRestrict);
  const nO = oop.length, nI = ip.length;
  const sides = [oop, ip];

  // typed arrays for the hot showdown loop
  const sc = [new Int32Array(nO), new Int32Array(nI)];
  const lo = [new Uint32Array(nO), new Uint32Array(nI)];
  const hi = [new Uint32Array(nO), new Uint32Array(nI)];
  const cA = [new Int32Array(nO), new Int32Array(nI)];
  const cB = [new Int32Array(nO), new Int32Array(nI)];
  for (let p = 0; p < 2; p++) for (let i = 0; i < sides[p].length; i++) {
    const cb = sides[p][i];
    sc[p][i] = cb.score; lo[p][i] = cb.lo; hi[p][i] = cb.hi; cA[p][i] = cb.c0; cB[p][i] = cb.c1;
  }
  // river scores never change, so terminals are linear sweeps in score order;
  // blockers correct in O(1) via per-card cumulative sums + an exact-pair lookup
  const ord = [null, null];
  const pairIdx = [null, null];
  for (let p = 0; p < 2; p++) {
    const n = sides[p].length, s = sc[p];
    const o = Int32Array.from({ length: n }, (_, i) => i);
    o.sort((a, b) => s[a] - s[b]);
    ord[p] = o;
    const m = new Int32Array(52 * 52).fill(-1);
    for (let i = 0; i < n; i++) { m[cA[p][i] * 52 + cB[p][i]] = i; m[cB[p][i] * 52 + cA[p][i]] = i; }
    pairIdx[p] = m;
  }
  const cardTot = new Float64Array(52), cardLow = new Float64Array(52), cardLeq = new Float64Array(52);

  const tree = buildTree(spot);
  initNodes(tree.root, nO, nI);

  // number of valid (oop,ip) deals — normaliser for EV / exploitability
  let Z = 0;
  for (let i = 0; i < nO; i++) for (let j = 0; j < nI; j++) if (!((lo[0][i] & lo[1][j]) || (hi[0][i] & hi[1][j]))) Z++;
  if (Z === 0 || nO === 0 || nI === 0) {
    return { empty: true, oopCount: nO, ipCount: nI };
  }

  // showdown counterfactual values for traverser p's combos, given opp reach.
  function showdownCFV(p, terminal, reachOpp, out) {
    const me = p, opp = 1 - p, msc = sc[me], osc = sc[opp];
    const no = sides[opp].length, nm = sides[me].length;
    const ordM = ord[me], ordO = ord[opp], oA = cA[opp], oB = cB[opp], oPair = pairIdx[opp];
    const inv = terminal.inv, pot = terminal.pot;
    const winPay = pot - inv[me], tiePay = pot / 2 - inv[me], losePay = -inv[me];
    cardTot.fill(0);
    let total = 0;
    for (let j = 0; j < no; j++) {
      const rj = reachOpp[j];
      if (rj !== 0) { total += rj; cardTot[oA[j]] += rj; cardTot[oB[j]] += rj; }
    }
    if (total === 0) { out.fill(0, 0, nm); return; }
    cardLow.fill(0); cardLeq.fill(0);
    // sweep opp combos by score, tracking total and per-card reach below (low) and at (leq) si
    let jLow = 0, jLeq = 0, sumLow = 0, sumLeq = 0, curScore = -1;
    for (let k = 0; k < nm; k++) {
      const i = ordM[k], si = msc[i];
      if (si !== curScore) {
        while (jLow < no) {
          const j = ordO[jLow];
          if (osc[j] >= si) break;
          const rj = reachOpp[j];
          if (rj !== 0) { sumLow += rj; cardLow[oA[j]] += rj; cardLow[oB[j]] += rj; }
          jLow++;
        }
        while (jLeq < no) {
          const j = ordO[jLeq];
          if (osc[j] > si) break;
          const rj = reachOpp[j];
          if (rj !== 0) { sumLeq += rj; cardLeq[oA[j]] += rj; cardLeq[oB[j]] += rj; }
          jLeq++;
        }
        curScore = si;
      }
      const a = cA[me][i], b = cB[me][i];
      // the (a,b) opp combo sits in both per-card sums — put back one count
      let pw = 0, pt = 0, pl = 0;
      const pj = oPair[a * 52 + b];
      if (pj >= 0) {
        const rj = reachOpp[pj];
        if (rj !== 0) { const sj = osc[pj]; if (sj < si) pw = rj; else if (sj === si) pt = rj; else pl = rj; }
      }
      const lowShare = cardLow[a] + cardLow[b] - pw;
      const leqShare = cardLeq[a] + cardLeq[b] - pw - pt;
      const totShare = cardTot[a] + cardTot[b] - pw - pt - pl;
      const w = sumLow - lowShare;
      const t = (sumLeq - sumLow) - (leqShare - lowShare);
      const l = (total - sumLeq) - (totShare - leqShare);
      out[i] = winPay * w + tiePay * t + losePay * l;
    }
  }
  function foldCFV(p, terminal, reachOpp, out) {
    const me = p, opp = 1 - p;
    const no = sides[opp].length, nm = sides[me].length;
    const oA = cA[opp], oB = cB[opp], oPair = pairIdx[opp];
    const inv = terminal.inv, pot = terminal.pot;
    const pay = terminal.winner === me ? (pot - inv[me]) : (-inv[me]);
    cardTot.fill(0);
    let total = 0;
    for (let j = 0; j < no; j++) {
      const rj = reachOpp[j];
      if (rj !== 0) { total += rj; cardTot[oA[j]] += rj; cardTot[oB[j]] += rj; }
    }
    if (total === 0) { out.fill(0, 0, nm); return; }
    for (let i = 0; i < nm; i++) {
      const a = cA[me][i], b = cB[me][i];
      const pj = oPair[a * 52 + b];
      const pr = pj >= 0 ? reachOpp[pj] : 0;
      out[i] = pay * (total - (cardTot[a] + cardTot[b] - pr));
    }
  }

  // vector CFR (alternating): fills `out` (length sides[p]) with p's counterfactual values.
  const tmpStrat = new Float64Array(16);
  function cfr(node, p, reachP, reachOpp, iterW, out) {
    if (node.terminal) {
      if (node.type === 'showdown') showdownCFV(p, node, reachOpp, out);
      else foldCFV(p, node, reachOpp, out);
      return;
    }
    const A = node.A, N = node.N, sBuf = node.sBuf;
    if (node.player === p) {
      for (let i = 0; i < N; i++) { strategyOf(node, i, tmpStrat); for (let a = 0; a < A; a++) sBuf[i * A + a] = tmpStrat[a]; }
      for (let a = 0; a < A; a++) {
        const rp = node.reachBuf[a];
        for (let i = 0; i < N; i++) rp[i] = reachP[i] * sBuf[i * A + a];
        cfr(node.children[a], p, rp, reachOpp, iterW, node.cfvBuf[a]);
      }
      for (let i = 0; i < N; i++) {
        let v = 0;
        for (let a = 0; a < A; a++) v += sBuf[i * A + a] * node.cfvBuf[a][i];
        out[i] = v;
      }
      // regret (CFR+) + linear strategy accumulation
      for (let i = 0; i < N; i++) {
        const base = i * A, rpi = reachP[i], vi = out[i];
        for (let a = 0; a < A; a++) {
          let r = node.regret[base + a] + (node.cfvBuf[a][i] - vi);
          if (r < 0) r = 0;
          node.regret[base + a] = r;
          node.strat[base + a] += iterW * rpi * sBuf[base + a];
        }
      }
      return;
    }
    // opponent acts: split opp reach by their strategy, sum child values
    const np = sides[p].length;
    for (let j = 0; j < N; j++) { strategyOf(node, j, tmpStrat); for (let a = 0; a < A; a++) sBuf[j * A + a] = tmpStrat[a]; }
    for (let i = 0; i < np; i++) out[i] = 0;
    for (let a = 0; a < A; a++) {
      const ro = node.reachBuf[a];
      for (let j = 0; j < N; j++) ro[j] = reachOpp[j] * sBuf[j * A + a];
      const c = node.cfvBuf[a];
      cfr(node.children[a], p, reachP, ro, iterW, c);
      for (let i = 0; i < np; i++) out[i] += c[i];
    }
  }

  // avg-strategy matrix for a node into its scratch buffer (a locked/fixed one wins)
  function fillAvg(node) {
    const A = node.A, N = node.N, sBuf = node.sBuf, acc = node.strat;
    if (node.fixed) { sBuf.set(node.fixed); return; }
    for (let i = 0; i < N; i++) {
      const base = i * A;
      let sum = 0;
      for (let a = 0; a < A; a++) sum += acc[base + a];
      if (sum > 0) for (let a = 0; a < A; a++) sBuf[base + a] = acc[base + a] / sum;
      else { const u = 1 / A; for (let a = 0; a < A; a++) sBuf[base + a] = u; }
    }
  }

  // value of p's avg strategy vs opp avg strategy (or best response if br===p);
  // record=true also writes the pure best response into node.brStrat
  function evalValue(node, p, reachP, reachOpp, br, out, record) {
    if (node.terminal) {
      if (node.type === 'showdown') showdownCFV(p, node, reachOpp, out);
      else foldCFV(p, node, reachOpp, out);
      return;
    }
    const A = node.A, N = node.N, sBuf = node.sBuf;
    fillAvg(node);
    if (node.player === p) {
      const useAvg = br !== p;
      for (let a = 0; a < A; a++) {
        const rp = node.reachBuf[a];
        for (let i = 0; i < N; i++) rp[i] = useAvg ? reachP[i] * sBuf[i * A + a] : reachP[i];
        evalValue(node.children[a], p, rp, reachOpp, br, node.cfvBuf[a], record);
      }
      if (br === p) { // best response: max over actions per combo
        let rec = null;
        if (record) {
          if (!node.brStrat) node.brStrat = new Float64Array(N * A);
          rec = node.brStrat; rec.fill(0);
        }
        for (let i = 0; i < N; i++) {
          let m = -Infinity, bi = 0;
          for (let a = 0; a < A; a++) { const v = node.cfvBuf[a][i]; if (v > m) { m = v; bi = a; } }
          out[i] = m;
          if (rec) rec[i * A + bi] = 1;
        }
      } else {
        for (let i = 0; i < N; i++) { let v = 0; for (let a = 0; a < A; a++) v += sBuf[i * A + a] * node.cfvBuf[a][i]; out[i] = v; }
      }
      return;
    }
    const np = sides[p].length;
    for (let i = 0; i < np; i++) out[i] = 0;
    for (let a = 0; a < A; a++) {
      const ro = node.reachBuf[a];
      for (let j = 0; j < N; j++) ro[j] = reachOpp[j] * sBuf[j * A + a];
      const c = node.cfvBuf[a];
      evalValue(node.children[a], p, reachP, ro, br, c, record);
      for (let i = 0; i < np; i++) out[i] += c[i];
    }
  }
  function avgStrat(node, i, a) {
    const A = node.A, base = i * A;
    let sum = 0; for (let x = 0; x < A; x++) sum += node.strat[base + x];
    return sum > 0 ? node.strat[base + a] / sum : 1 / A;
  }
  const rootReach = [new Float64Array(nO).fill(1), new Float64Array(nI).fill(1)];
  const rootOut = [new Float64Array(nO), new Float64Array(nI)];
  function rootValue(p, br) {
    evalValue(tree.root, p, rootReach[p], rootReach[1 - p], br, rootOut[p]);
    const cfv = rootOut[p];
    let s = 0; for (let i = 0; i < cfv.length; i++) s += cfv[i];
    return s / Z;
  }
  function exploitabilityPctPot() {
    const evO = rootValue(0, -1), evI = rootValue(1, -1);
    const brO = rootValue(0, 0), brI = rootValue(1, 1);
    const ev = ((brO - evO) + (brI - evI)) / 2;
    return { evOOP: evO, evIP: evI, exploit: spot.pot > 0 ? Math.max(0, ev) / spot.pot * 100 : 0, brO, brI };
  }

  // ── run CFR+ ──
  const trace = [];
  const traceEvery = Math.max(1, Math.floor(iters / 32));
  for (let t = 1; t <= iters; t++) {
    const w = t; // linear averaging
    cfr(tree.root, 0, rootReach[0], rootReach[1], w, rootOut[0]);
    cfr(tree.root, 1, rootReach[1], rootReach[0], w, rootOut[1]);
    if (t % traceEvery === 0 || t === iters) {
      const e = exploitabilityPctPot();
      trace.push(e.exploit);
      if (onProgress) onProgress({ iter: t, total: iters, exploit: e.exploit, pct: t / iters });
    }
  }

  const fin = exploitabilityPctPot();
  const sizeCount = onSizesCount(spot);

  // ── format per display node into the UI contract ──
  function nodeMeta(id) {
    const node = tree.display[id];
    if (!node) return null;
    const actor = node.player === 0 ? 'OOP' : 'IP';
    const facing = node.actions.some((a) => a.kind === 'fold') ? 'bet' : null;
    let label;
    if (id === 'oop_first') label = 'OOP — first to act';
    else if (id === 'ip_vs_check') label = 'IP — facing check';
    else if (id === 'ip_vs_bet') label = `IP — facing OOP bet ${tree.repPct}%`;
    else label = `OOP — facing IP bet ${tree.repPct}%`;
    return { id, actor, facing, label, actions: node.actions.map((a) => actionMeta(a)) };
  }
  function buildNodeSolve(id, restrictIds, weightOf = avgStrat) {
    const node = tree.display[id];
    if (!node) return null;
    const p = node.player, side = sides[p], A = node.A;
    const combosOut = [];
    // strength percentile across this actor's live combos
    const order = side.map((_, i) => i).sort((a, b) => side[a].score - side[b].score);
    const strRank = new Float64Array(side.length);
    order.forEach((idx, k) => { strRank[idx] = side.length > 1 ? k / (side.length - 1) : 0.5; });
    for (let i = 0; i < side.length; i++) {
      const cmb = side[i];
      const rev = cmb.cards[1].v + cmb.cards[1].s + cmb.cards[0].v + cmb.cards[0].s;
      if (restrictIds && !restrictIds.has(cmb.id) && !restrictIds.has(rev)) continue;
      const weights = {};
      for (let a = 0; a < A; a++) weights[node.actions[a].id] = weightOf(node, i, a);
      combosOut.push({ id: cmb.id, hkey: cmb.hkey, cards: cmb.cards, cat: cmb.cat, str: strRank[i], weights });
    }
    const byKey = {};
    for (const c of combosOut) {
      let g = byKey[c.hkey];
      if (!g) g = byKey[c.hkey] = { hkey: c.hkey, combos: [], agg: {}, count: 0 };
      g.combos.push(c); g.count++;
      for (const aid in c.weights) g.agg[aid] = (g.agg[aid] || 0) + c.weights[aid];
    }
    for (const k in byKey) {
      const g = byKey[k];
      for (const aid in g.agg) g.agg[aid] /= g.count;
      let best = null, bv = -1; for (const aid in g.agg) if (g.agg[aid] > bv) { bv = g.agg[aid]; best = aid; }
      g.dominant = best;
      g.combos.sort((a, b) => b.cat - a.cat || 0);
    }
    return { byKey, combos: combosOut, count: combosOut.length };
  }

  const nodes = ['oop_first', 'ip_vs_check', 'ip_vs_bet', 'oop_vs_bet'].map(nodeMeta).filter(Boolean);
  const nodeSolves = {};
  for (const n of nodes) nodeSolves[n.id] = buildNodeSolve(n.id, n.actor === 'OOP' ? opts.oopRestrict : opts.ipRestrict);

  // ── exploit mode ──
  function forEachNode(fn, node = tree.root) {
    if (node.terminal) return;
    fn(node);
    for (const ch of node.children) forEachNode(fn, ch);
  }
  const idxOf = (node, pred) => node.actions.map((a, i) => (pred(a) ? i : -1)).filter((i) => i >= 0);

  // move probability between action groups until the reach-weighted frequency of
  // G hits the target. hands closest to indifference flip first, so an over-folder
  // gives up its weakest calls and an over-bettor adds its most marginal bets.
  function lockGroup(node, G, target, reach, pool) {
    const A = node.A, N = node.N, cfv = node.lockCfv;
    if (!node.fixed) { fillAvg(node); node.fixed = Float64Array.from(node.sBuf); }
    const st = node.fixed;
    const massOf = () => {
      let W = 0, cur = 0;
      for (let i = 0; i < N; i++) {
        const w = reach[i]; if (w <= 0) continue;
        let g = 0; for (const a of G) g += st[i * A + a];
        W += w; cur += w * g;
      }
      return { W, cur };
    };
    const before = massOf();
    if (before.W <= 0) return null;
    const eq = before.cur / before.W;
    let need = target * before.W - before.cur;
    if (Math.abs(need) > 1e-12) {
      const gMix = new Float64Array(A), pMix = new Float64Array(A);
      for (let i = 0; i < N; i++) {
        const w = reach[i]; if (w <= 0) continue;
        for (const a of G) gMix[a] += w * st[i * A + a];
        for (const a of pool) pMix[a] += w * st[i * A + a];
      }
      const adv = new Float64Array(N);
      for (let i = 0; i < N; i++) {
        let mg = -Infinity, mp = -Infinity;
        for (const a of G) if (cfv[a][i] > mg) mg = cfv[a][i];
        for (const a of pool) if (cfv[a][i] > mp) mp = cfv[a][i];
        adv[i] = mg - mp;
      }
      const grow = need > 0;
      const order = [];
      for (let i = 0; i < N; i++) if (reach[i] > 0) order.push(i);
      order.sort((x, y) => (grow ? adv[y] - adv[x] : adv[x] - adv[y]) || x - y);
      const from = grow ? pool : G, to = grow ? G : pool, toMix = grow ? gMix : pMix;
      let rem = Math.abs(need);
      for (const i of order) {
        if (rem <= 1e-12) break;
        const base = i * A, w = reach[i];
        let avail = 0; for (const a of from) avail += st[base + a];
        if (avail <= 0) continue;
        const shift = Math.min(avail, rem / w);
        for (const a of from) st[base + a] -= st[base + a] / avail * shift;
        let toSum = 0; for (const a of to) toSum += st[base + a];
        if (toSum > 0) for (const a of to) st[base + a] += st[base + a] / toSum * shift;
        else {
          let m = 0; for (const a of to) m += toMix[a];
          if (m > 0) for (const a of to) st[base + a] += toMix[a] / m * shift;
          else for (const a of to) st[base + a] += shift / to.length;
        }
        rem -= shift * w;
      }
      // float dust: clamp and renormalise each combo
      for (let i = 0; i < N; i++) {
        const base = i * A; let sum = 0;
        for (let a = 0; a < A; a++) { if (st[base + a] < 0) st[base + a] = 0; sum += st[base + a]; }
        if (sum > 0) for (let a = 0; a < A; a++) st[base + a] /= sum;
      }
    }
    const after = massOf();
    return { eq, target, achieved: after.cur / after.W, weight: before.W };
  }

  function runExploit(cfg) {
    const V = cfg.villain, H = 1 - V;
    const K = cfg.priorWeight == null ? 20 : Math.max(0, Number(cfg.priorWeight) || 0);
    const model = cfg.model || {};
    const evEq = V === 0 ? fin.evIP : fin.evOOP;

    // equilibrium action values at the villain's first decisions decide flip order
    evalValue(tree.root, V, rootReach[V], rootReach[H], -1, rootOut[V]);
    forEachNode((n) => {
      if (n.player !== V || !(n.kind === 'open' || (n.kind === 'facing' && n.depth === 0))) return;
      n.lockCfv = n.cfvBuf.map((b) => Float64Array.from(b.subarray(0, n.N)));
    });

    // a stat is either an observed count (shrunk toward the node's own GTO rate) or a fixed rate
    const spec = (stat) => {
      const m = model[stat];
      if (!m) return null;
      if (typeof m.rate === 'number' && Number.isFinite(m.rate)) return { rate: Math.max(0, Math.min(1, m.rate)) };
      const hits = Number(m.hits), opps = Number(m.opps);
      if (!(opps > 0) || !(hits >= 0)) return null;
      return { hits: Math.min(hits, opps), opps };
    };
    const specs = { bet: spec('bet'), fold: spec('fold'), raise: spec('raise') };
    const acc = { bet: null, fold: null, raise: null };

    // walk top-down so a locked open node feeds the right reach into facing nodes
    (function walk(node, reach) {
      if (node.terminal) return;
      if (node.player === V) {
        if (node.kind === 'open') lock('bet', node, idxOf(node, (a) => a.kind === 'bet'), idxOf(node, (a) => a.kind === 'check'), reach);
        if (node.kind === 'facing' && node.depth === 0) {
          lock('fold', node, idxOf(node, (a) => a.kind === 'fold'), idxOf(node, (a) => a.kind !== 'fold'), reach);
          lock('raise', node, idxOf(node, (a) => a.kind === 'raise'), idxOf(node, (a) => a.kind === 'call'), reach);
        }
        fillAvg(node);
        const A = node.A, N = node.N;
        for (let a = 0; a < A; a++) {
          const r = new Float64Array(N);
          for (let i = 0; i < N; i++) r[i] = reach[i] * node.sBuf[i * A + a];
          walk(node.children[a], r);
        }
        return;
      }
      for (const ch of node.children) walk(ch, reach);
    })(tree.root, new Float64Array(sides[V].length).fill(1));

    function lock(stat, node, G, pool, reach) {
      const sp = specs[stat];
      if (!sp || !G.length || !pool.length) return;
      // current frequency first: it is the prior an observed count shrinks toward
      fillAvg(node);
      let W = 0, cur = 0;
      for (let i = 0; i < node.N; i++) {
        const w = reach[i]; if (w <= 0) continue;
        let g = 0; for (const a of G) g += node.sBuf[i * node.A + a];
        W += w; cur += w * g;
      }
      if (W <= 0) return; // unreachable under the locks so far: leave it unlocked
      const eq = cur / W;
      const target = sp.rate != null ? sp.rate : (sp.hits + K * eq) / (sp.opps + K);
      const r = lockGroup(node, G, target, reach, pool);
      if (!r) return;
      const a = acc[stat] || (acc[stat] = { nodes: 0, eq: 0, target: 0, achieved: 0, weight: 0 });
      a.nodes++; a.weight += r.weight;
      a.eq += r.eq * r.weight; a.target += r.target * r.weight; a.achieved += r.achieved * r.weight;
    }

    const locks = {};
    for (const stat of ['bet', 'fold', 'raise']) {
      const a = acc[stat];
      locks[stat] = a && a.weight > 0
        ? { nodes: a.nodes, eq: a.eq / a.weight, target: a.target / a.weight, achieved: a.achieved / a.weight, ...(specs[stat].rate != null ? { rate: specs[stat].rate } : { hits: specs[stat].hits, opps: specs[stat].opps }) }
        : null;
    }

    // hero: GTO line vs the model, then the best response, recorded per node
    const gtoVsModel = rootValue(H, -1);
    evalValue(tree.root, H, rootReach[H], rootReach[V], H, rootOut[H], true);
    let sum = 0; for (let i = 0; i < rootOut[H].length; i++) sum += rootOut[H][i];
    const exploit = sum / Z;

    // freeze the hero on that line and unlock the villain: what a GTO or adapting villain does to it
    forEachNode((n) => { if (n.player === H) n.fixed = n.brStrat; });
    const held = [];
    forEachNode((n) => { if (n.player === V && n.fixed) { held.push([n, n.fixed]); n.fixed = null; } });
    const exploitVsGto = rootValue(H, -1);
    const exploitVsBr = spot.pot - rootValue(V, V);
    for (const [n, f] of held) n.fixed = f;

    const weightOf = (node, i, a) => (node.fixed ? node.fixed[i * node.A + a] : avgStrat(node, i, a));
    const exNodeSolves = {}, locked = {};
    for (const n of nodes) {
      exNodeSolves[n.id] = buildNodeSolve(n.id, n.actor === 'OOP' ? opts.oopRestrict : opts.ipRestrict, weightOf);
      const dn = tree.display[n.id];
      locked[n.id] = dn.player === V && !!dn.fixed;
    }
    forEachNode((n) => { n.fixed = null; n.brStrat = null; n.lockCfv = null; });

    return {
      villain: V === 0 ? 'OOP' : 'IP', hero: H === 0 ? 'OOP' : 'IP',
      priorWeight: K, locks,
      ev: { eq: evEq, gtoVsModel, exploit, exploitVsGto, exploitVsBr },
      nodeSolves: exNodeSolves, locked,
    };
  }
  const ex = opts.exploit;
  const exploitOut = ex && (ex.villain === 0 || ex.villain === 1) ? runExploit(ex) : null;

  return {
    nodes,
    nodeSolves,
    exploit: exploitOut,
    meta: {
      potBb: spot.pot, evOOP: fin.evOOP, evIP: fin.evIP,
      exploitPctPot: fin.exploit, iterations: iters, sizeCount, repBetPct: tree.repPct,
    },
    trace,
    oopCount: nO, ipCount: nI,
  };
}

function onSizesCount(spot) { return spot.betSizes.filter((b) => b.on).length + (spot.allIn ? 1 : 0); }

function actionMeta(a) {
  if (a.kind === 'check') return { id: 'check', kind: 'check', label: 'Check' };
  if (a.kind === 'fold') return { id: 'fold', kind: 'fold', label: 'Fold' };
  if (a.kind === 'call') return { id: 'call', kind: 'call', label: 'Call' };
  if (a.kind === 'raise') return { id: a.id, kind: 'raise', label: a.id === 'allin' ? 'All-in' : 'Raise' };
  // bet
  if (a.pct >= 999) return { id: 'allin', kind: 'bet', sizePct: 999, label: 'All-in' };
  return { id: a.id, kind: 'bet', sizePct: a.pct, label: `Bet ${a.pct}%` };
}

// Action color convention (matches the handoff).
export function actionColor(a) {
  if (a.kind === 'check') return '#57b98c';
  if (a.kind === 'call') return '#3f9e96';
  if (a.kind === 'fold') return '#6b9cdf';
  if (a.kind === 'raise') return '#b3322b';
  const p = a.sizePct;
  if (p >= 999) return '#7c1d18';
  if (p <= 40) return '#e69a8f';
  if (p <= 80) return '#d8463e';
  if (p <= 150) return '#bb352c';
  return '#9a2922';
}

// ── side helpers + pre-solve equity (runs live on the main thread) ──
const VAL = { A: 14, K: 13, Q: 12, J: 11, T: 10, '9': 9, '8': 8, '7': 7, '6': 6, '5': 5, '4': 4, '3': 3, '2': 2 };
export function cardsToKey(c1, c2) {
  if (!c1 || !c2) return null;
  if (c1.v === c2.v) return c1.v + c2.v;
  const hi = VAL[c1.v] >= VAL[c2.v] ? c1 : c2, lo = VAL[c1.v] >= VAL[c2.v] ? c2 : c1;
  return hi.v + lo.v + (c1.s === c2.s ? 's' : 'o');
}
export function sideToRangeKeys(side) {
  if (!side) return [];
  if (side.kind === 'hand') { const k = side.cards && side.cards.length === 2 ? cardsToKey(side.cards[0], side.cards[1]) : null; return k ? [k] : []; }
  return side.keys || [];
}
export function comboCount(key) { return key.length === 2 ? 6 : (key.endsWith('s') ? 4 : 12); }
export function combosFromKeys(keys) { let n = 0; for (const k of keys || []) n += comboCount(k); return n; }

function sideCombos(side, blockIds) {
  if (!side) return [];
  if (side.kind === 'hand') {
    const cs = (side.cards || []).filter(Boolean);
    if (cs.length !== 2) return [];
    if (blockIds.has(cs[0].v + cs[0].s) || blockIds.has(cs[1].v + cs[1].s)) return [];
    return [cs];
  }
  const out = [];
  for (const k of side.keys || []) for (const cc of comboCardsFor(k)) {
    if (blockIds.has(cc[0].v + cc[0].s) || blockIds.has(cc[1].v + cc[1].s)) continue;
    out.push(cc);
  }
  return out;
}
function mulberry32(a) { return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const ALL_VALS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const cid = (c) => c.v + c.s;

// hero vs villain (hand or range), blocker-aware: exact on a full board, else MC.
export function equityMatchup(heroSide, villainSide, board) {
  const live = (board || []).filter(Boolean);
  const boardIds = new Set(live.map(cid));
  const bIds = live.map(cardToId);
  const hero = sideCombos(heroSide, boardIds), vill = sideCombos(villainSide, boardIds);
  const hc = hero.length, vc = vill.length;
  if (!hc || !vc) return { hero: null, villain: null, heroCount: hc, villCount: vc, method: 'exact', samples: 0 };
  let win = 0, tie = 0, loss = 0, total = 0;
  if (live.length === 5) {
    const pairs = hc * vc, cap = 200000, sample = pairs > cap, rng = mulberry32(0x5e7);
    const hs = hero.map((h) => evaluate7(cardToId(h[0]), cardToId(h[1]), bIds[0], bIds[1], bIds[2], bIds[3], bIds[4]));
    const trials = sample ? cap : pairs;
    for (let n = 0; n < trials; n++) {
      let hi, vi; if (sample) { hi = (rng() * hc) | 0; vi = (rng() * vc) | 0; } else { hi = (n / vc) | 0; vi = n % vc; }
      const h = hero[hi], v = vill[vi];
      if (cid(v[0]) === cid(h[0]) || cid(v[0]) === cid(h[1]) || cid(v[1]) === cid(h[0]) || cid(v[1]) === cid(h[1])) continue;
      const vs = evaluate7(cardToId(v[0]), cardToId(v[1]), bIds[0], bIds[1], bIds[2], bIds[3], bIds[4]);
      if (hs[hi] > vs) win++; else if (hs[hi] === vs) tie++; else loss++; total++;
    }
    return finalizeEq(win, tie, loss, total, hc, vc, 'exact', total);
  }
  const rng = mulberry32(0x1234 + live.length), need = 5 - live.length, deck = [], MC = 20000;
  for (const v of ALL_VALS) for (const s of SUITS) deck.push({ v, s });
  for (let n = 0; n < MC; n++) {
    const h = hero[(rng() * hc) | 0], v = vill[(rng() * vc) | 0];
    const used = new Set([...boardIds, cid(h[0]), cid(h[1])]);
    if (used.has(cid(v[0])) || used.has(cid(v[1]))) continue;
    used.add(cid(v[0])); used.add(cid(v[1]));
    const run = []; let g = 0;
    while (run.length < need && g < 400) { const c = deck[(rng() * 52) | 0]; if (!used.has(cid(c))) { used.add(cid(c)); run.push(c); } g++; }
    if (run.length < need) continue;
    const full = [...live, ...run].map(cardToId);
    const hs = evaluate7(cardToId(h[0]), cardToId(h[1]), full[0], full[1], full[2], full[3], full[4]);
    const vs = evaluate7(cardToId(v[0]), cardToId(v[1]), full[0], full[1], full[2], full[3], full[4]);
    if (hs > vs) win++; else if (hs === vs) tie++; else loss++; total++;
  }
  return finalizeEq(win, tie, loss, total, hc, vc, 'simulated', total);
}
function finalizeEq(win, tie, loss, total, hc, vc, method, samples) {
  if (!total) return { hero: null, villain: null, heroCount: hc, villCount: vc, method, samples: 0 };
  return {
    hero: { win: win / total * 100, tie: tie / total * 100, equity: (win + tie / 2) / total * 100 },
    villain: { win: loss / total * 100, tie: tie / total * 100, equity: (loss + tie / 2) / total * 100 },
    heroCount: hc, villCount: vc, method, samples,
  };
}
