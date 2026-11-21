"use client";

import { useEffect, useState } from "react";

/** Trả giá trị sau khi người dùng ngừng gõ `delay` ms (tránh gọi API mỗi phím) */
export function useDebounced<T>(value: T, delay = 400): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return v;
}
