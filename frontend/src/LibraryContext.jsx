import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext.jsx';
import * as api from './library.js';

// without a provider (unit tests) everything reads as signed out
const STUB = {
  available: false, plan: 'free', limits: null, userKey: '',
  ranges: [], rangesLoaded: false, refreshRanges: async () => {},
  saveRange: async () => ({ ok: false, error: 'Sign in to save ranges' }),
  updateRange: async () => ({ ok: false }), deleteRange: async () => ({ ok: false }),
  solves: [], solvesLoaded: false, refreshSolves: async () => {},
  saveSolve: async () => ({ ok: false, error: 'Sign in to save solves' }),
  renameSolve: async () => ({ ok: false }), deleteSolve: async () => ({ ok: false }),
  openPlans: () => {},
};

const LibraryContext = createContext(STUB);

export function LibraryProvider({ children }) {
  const { user, plan, openPlans } = useAuth();
  const [ranges, setRanges] = useState([]);
  const [rangesLoaded, setRangesLoaded] = useState(false);
  const [solves, setSolves] = useState([]);
  const [solvesLoaded, setSolvesLoaded] = useState(false);
  const userKey = user ? (user.id || user.email || 'user') : '';

  useEffect(() => {
    setRanges([]); setRangesLoaded(false);
    setSolves([]); setSolvesLoaded(false);
  }, [userKey]);

  // one in-flight list request at a time; callers during a fetch share it
  const inflight = useRef({ ranges: null, solves: null });
  const refreshRanges = useCallback(async () => {
    if (!userKey) return;
    if (!inflight.current.ranges) {
      inflight.current.ranges = api.listRanges()
        .then((res) => { if (res.ok) setRanges(res.ranges || []); setRangesLoaded(true); })
        .finally(() => { inflight.current.ranges = null; });
    }
    return inflight.current.ranges;
  }, [userKey]);

  const refreshSolves = useCallback(async () => {
    if (!userKey) return;
    if (!inflight.current.solves) {
      inflight.current.solves = api.listSolves()
        .then((res) => { if (res.ok) setSolves(res.solves || []); setSolvesLoaded(true); })
        .finally(() => { inflight.current.solves = null; });
    }
    return inflight.current.solves;
  }, [userKey]);

  const saveRange = useCallback(async (name, keys) => {
    const res = await api.createRange({ name, keys });
    if (res.ok) setRanges(prev => [res.range, ...prev]);
    return res;
  }, []);

  const updateRange = useCallback(async (id, fields) => {
    setRanges(prev => prev.map(r => (r.id === id ? { ...r, ...fields } : r)));
    const res = await api.updateRange(id, fields);
    if (!res.ok) refreshRanges();
    return res;
  }, [refreshRanges]);

  const deleteRange = useCallback(async (id) => {
    setRanges(prev => prev.filter(r => r.id !== id));
    const res = await api.deleteRange(id);
    if (!res.ok) refreshRanges();
    return res;
  }, [refreshRanges]);

  const saveSolve = useCallback(async (name, config, summary) => {
    const res = await api.createSolve({ name, config, summary });
    if (res.ok) setSolves(prev => [res.solve, ...prev]);
    return res;
  }, []);

  const renameSolve = useCallback(async (id, name) => {
    setSolves(prev => prev.map(s => (s.id === id ? { ...s, name } : s)));
    const res = await api.renameSolve(id, name);
    if (!res.ok) refreshSolves();
    return res;
  }, [refreshSolves]);

  const deleteSolve = useCallback(async (id) => {
    setSolves(prev => prev.filter(s => s.id !== id));
    const res = await api.deleteSolve(id);
    if (!res.ok) refreshSolves();
    return res;
  }, [refreshSolves]);

  const value = useMemo(() => ({
    available: !!user,
    userKey,
    plan: plan.plan,
    limits: plan.limits ? plan.limits[plan.plan] : null,
    ranges, rangesLoaded, refreshRanges, saveRange, updateRange, deleteRange,
    solves, solvesLoaded, refreshSolves, saveSolve, renameSolve, deleteSolve,
    openPlans,
  }), [user, userKey, plan, ranges, rangesLoaded, refreshRanges, saveRange, updateRange, deleteRange,
    solves, solvesLoaded, refreshSolves, saveSolve, renameSolve, deleteSolve, openPlans]);

  return <LibraryContext.Provider value={value}>{children}</LibraryContext.Provider>;
}

export function useLibrary() {
  return useContext(LibraryContext);
}
