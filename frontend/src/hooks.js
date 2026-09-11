import { useState, useRef, useEffect, useCallback } from 'react';

// state that resets itself after `ms`. a new flash restarts the clock and
// unmount cancels it, so nothing fires into a tree that's gone
export function useFlash(ms, initial = null) {
  const [value, setValue] = useState(initial);
  const timer = useRef();
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = useCallback((v) => {
    clearTimeout(timer.current);
    setValue(v);
    timer.current = setTimeout(() => setValue(initial), ms);
  }, [ms, initial]);
  return [value, flash, setValue];
}
